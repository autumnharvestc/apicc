package com.autumnharvestc.server.collaboration.policy;

import com.autumnharvestc.server.access.AccessRequests;
import com.autumnharvestc.server.core.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import org.springframework.http.HttpStatus;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.*;

/** Strict partial commands. Null is an explicit inherit command; missing is no command. */
public record PolicyPatch(long expectedRevision,Map<Code,Change> changes) {
    public sealed interface Change permits Inherit,BooleanValue,IntegerValue,StringListValue {Code code();}
    public record Inherit(Code code) implements Change {}
    public record BooleanValue(Code code,boolean value) implements Change {}
    public record IntegerValue(Code code,long value) implements Change {}
    public record StringListValue(Code code,List<String> value) implements Change {}
    private static final Set<Code> READ_ONLY=EnumSet.of(Code.DEPLOYMENT_MAX_STORAGE_BYTES,Code.DEPLOYMENT_PUBLIC_READ_RPS,Code.DEPLOYMENT_PUBLIC_READ_IN_FLIGHT,
        Code.DEPLOYMENT_MOCK_RPS,Code.DEPLOYMENT_MOCK_IN_FLIGHT,Code.DEPLOYMENT_MAX_ACTIVE_GRANTS,Code.MAX_PREVIEWS_GLOBAL,
        Code.RPC_CONNECT_TIMEOUT_MS,Code.RPC_CALL_TIMEOUT_MS,Code.RPC_MAX_MESSAGE_BYTES,Code.NODE_CACHE_BYTES);
    static PolicyPatch parse(JsonNode body) {
        if(body==null||!body.isObject()||body.size()!=2||!body.has("expectedRevision")||!body.has("settings"))throw invalid();
        long revision=AccessRequests.revision(body.get("expectedRevision"));
        var settings=body.get("settings");if(!settings.isObject()||settings.isEmpty())throw invalid();
        var declarations=new EnumMap<Code,Setting>(Code.class);PolicyDefaults.settings().forEach(item->declarations.put(item.code(),item));
        var changes=new EnumMap<Code,Change>(Code.class);
        settings.properties().forEach(entry->{
            var code=Arrays.stream(Code.values()).filter(item->item.code().equals(entry.getKey())).findFirst().orElseThrow(PolicyPatch::invalid);
            if(READ_ONLY.contains(code))throw new ApiException(HttpStatus.BAD_REQUEST,"collaboration_policy_read_only","此设置由部署管理员配置，当前范围不可修改："+code.code());
            var value=entry.getValue();var declaration=declarations.get(code);
            Change change;
            if(value.isNull())change=new Inherit(code);
            else if(declaration instanceof BooleanSetting){if(!value.isBoolean())throw invalid();change=new BooleanValue(code,value.booleanValue());}
            else if(declaration instanceof IntegerSetting){if(!value.isIntegralNumber()||!value.canConvertToLong())throw invalid();change=new IntegerValue(code,value.longValue());}
            else if(declaration instanceof StringListSetting){
                if(!value.isArray())throw invalid();var items=new ArrayList<String>();
                for(var item:value){if(!item.isTextual())throw invalid();items.add(item.textValue());}
                change=new StringListValue(code,List.copyOf(items));
            }else throw invalid();
            changes.put(code,change);
        });
        return new PolicyPatch(revision,Map.copyOf(changes));
    }
    private static ApiException invalid(){return AccessRequests.invalid("协作策略需要有效的期望版本和有限类型的局部设置，不能包含未知字段或类型转换");}
}
