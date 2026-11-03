package com.autumnharvestc.server.collaboration.policy;

import com.autumnharvestc.server.core.ApiException;
import org.springframework.http.HttpStatus;
import java.util.*;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.*;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.Code.*;

/** Pure finite layer calculation. It never rewrites a stored local override. */
final class PolicyLayers {
    private PolicyLayers() {}
    static List<Setting> inherited(List<Setting> settings) {
        return settings.stream().map(item->{
            if(item instanceof BooleanSetting value)return (Setting)new BooleanSetting(value.code(),value.builtin(),null,value.effective(),value.source(),value.unit(),value.effect());
            if(item instanceof IntegerSetting value)return (Setting)new IntegerSetting(value.code(),value.builtin(),null,value.effective(),value.source(),value.unit(),value.effect(),value.minimum(),value.maximum());
            if(item instanceof StringListSetting value)return (Setting)new StringListSetting(value.code(),value.builtin(),null,value.effective(),value.source(),value.unit(),value.effect(),value.maxItems(),value.maxItemCodePoints());
            var value=(DecimalSetting)item;return (Setting)new DecimalSetting(value.code(),value.builtin(),null,value.effective(),value.source(),value.unit(),value.effect(),value.minimum(),value.maximum());
        }).toList();
    }
    static List<Setting> deploymentTotals(List<Setting> settings) {
        var limits=index(settings);
        return settings.stream().map(item->{
            Code total=switch(item.code()){
                case MAX_PROJECT_STORAGE_BYTES->DEPLOYMENT_MAX_STORAGE_BYTES;case MAX_PROJECT_ACTIVE_GRANTS->DEPLOYMENT_MAX_ACTIVE_GRANTS;
                case PUBLIC_READ_RPS->DEPLOYMENT_PUBLIC_READ_RPS;case PUBLIC_READ_IN_FLIGHT->DEPLOYMENT_PUBLIC_READ_IN_FLIGHT;
                case MOCK_RPS->DEPLOYMENT_MOCK_RPS;case MOCK_IN_FLIGHT->DEPLOYMENT_MOCK_IN_FLIGHT;default->null;
            };
            if(total==null)return item;var value=(IntegerSetting)item;long maximum=((IntegerSetting)limits.get(total)).effective();
            return value.effective()<=maximum?item:new IntegerSetting(value.code(),value.builtin(),value.local(),maximum,Source.DEPLOYMENT,value.unit(),value.effect(),value.minimum(),value.maximum());
        }).toList();
    }
    static List<Setting> apply(List<Setting> upper,PolicyOverrides overrides,Source source) {
        var base=inherited(upper);var values=index(base);var local=overrides==null?base:overrides.view(base,source);
        var result=local.stream().map(item->{
            var parent=values.get(item.code());
            if(item instanceof BooleanSetting value){
                var ceiling=(BooleanSetting)parent;boolean effective=value.local()==null?ceiling.effective():value.local();Source origin=value.local()==null?ceiling.source():source;
                if(value.code()==EXTERNAL_SHARING_ALLOWED&&(source==Source.WORKSPACE||source==Source.PROJECT)&&value.local()==null){effective=false;if(ceiling.effective())origin=source;}
                if(effective&&!ceiling.effective()){effective=false;origin=ceiling.source();}
                return (Setting)new BooleanSetting(value.code(),value.builtin(),value.local(),effective,origin,value.unit(),value.effect());
            }
            if(item instanceof IntegerSetting value){
                var ceiling=(IntegerSetting)parent;long effective=value.local()==null?ceiling.effective():value.local();Source origin=value.local()==null?ceiling.source():source;
                if(!choice(value.code())&&effective>ceiling.effective()){effective=ceiling.effective();origin=ceiling.source();}
                return (Setting)new IntegerSetting(value.code(),value.builtin(),value.local(),effective,origin,value.unit(),value.effect(),value.minimum(),value.maximum());
            }
            if(item instanceof StringListSetting value){
                var ceiling=(StringListSetting)parent;
                if(value.local()==null)return parent;
                List<String> effective;Source origin=source;
                if(value.code()==CORS_ALLOWED_ORIGINS){
                    effective=value.local().stream().filter(ceiling.effective()::contains).toList();
                    if(!effective.equals(value.local()))origin=ceiling.source();
                }else{
                    var combined=new LinkedHashMap<String,String>();
                    for(String name:ceiling.effective())combined.putIfAbsent(ruleKey(value.code(),name),name);
                    for(String name:value.local())combined.putIfAbsent(ruleKey(value.code(),name),name);
                    effective=List.copyOf(combined.values());if(!ceiling.effective().isEmpty())origin=Source.UNION;
                }
                return (Setting)new StringListSetting(value.code(),value.builtin(),value.local(),effective,origin,value.unit(),value.effect(),value.maxItems(),value.maxItemCodePoints());
            }
            return item;
        }).toList();
        return constrainChoices(result);
    }
    private static List<Setting> constrainChoices(List<Setting> settings) {
        var values=index(settings);
        return settings.stream().map(item->{
            if(!choice(item.code()))return item;var value=(IntegerSetting)item;
            var maximum=(IntegerSetting)values.get(item.code()==DEFAULT_SHARE_DURATION_MS?MAX_SHARE_DURATION_MS:MAX_PAGE_SIZE);
            return value.effective()<=maximum.effective()?item:new IntegerSetting(value.code(),value.builtin(),value.local(),maximum.effective(),maximum.source(),value.unit(),value.effect(),value.minimum(),value.maximum());
        }).toList();
    }
    static void requireCommand(List<Setting> upper,List<Setting> effective,PolicyPatch patch,Source source) {
        // Validate actual changed values before ceilings can restrict the read view. Unchanged old locals use their current effective values.
        var raw=effective.stream().map(item->{
            var change=patch.changes().get(item.code());
            if(change instanceof PolicyPatch.BooleanValue value){var row=(BooleanSetting)item;return (Setting)new BooleanSetting(row.code(),row.builtin(),row.local(),value.value(),source,row.unit(),row.effect());}
            if(change instanceof PolicyPatch.IntegerValue value){var row=(IntegerSetting)item;return (Setting)new IntegerSetting(row.code(),row.builtin(),row.local(),value.value(),source,row.unit(),row.effect(),row.minimum(),row.maximum());}
            if(change instanceof PolicyPatch.StringListValue value){var row=(StringListSetting)item;return (Setting)new StringListSetting(row.code(),row.builtin(),row.local(),value.value(),source,row.unit(),row.effect(),row.maxItems(),row.maxItemCodePoints());}
            return item;
        }).toList();
        PolicyValidation.requireValid(raw,source);
        var ceilings=index(upper);
        for(var change:patch.changes().values()){
            var ceiling=ceilings.get(change.code());boolean exceeds=false;Source origin=null;
            if(change instanceof PolicyPatch.BooleanValue value){var row=(BooleanSetting)ceiling;exceeds=value.value()&&!row.effective();origin=row.source();}
            if(change instanceof PolicyPatch.IntegerValue value&&!choice(value.code())){var row=(IntegerSetting)ceiling;exceeds=value.value()>row.effective();origin=row.source();}
            if(change instanceof PolicyPatch.StringListValue value&&value.code()==CORS_ALLOWED_ORIGINS){var row=(StringListSetting)ceiling;exceeds=!row.effective().containsAll(value.value());origin=row.source();}
            if(exceeds)throw new ApiException(HttpStatus.BAD_REQUEST,"collaboration_policy_upper_ceiling","协作策略超过当前上级允许范围："+change.code().code()+"（来源："+origin.code()+"）");
        }
        int sensitive=effective.stream().filter(item->item instanceof StringListSetting&&item.code()!=CORS_ALLOWED_ORIGINS).mapToInt(item->((StringListSetting)item).effective().size()).sum();
        if(sensitive>200)throw new PolicyValidation.Invalid("collaboration_policy_combination_invalid",EXTRA_SENSITIVE_FIELDS,Source.UNION);
        PolicyValidation.requireValid(effective,source);
    }
    private static boolean choice(Code code){return code==DEFAULT_SHARE_DURATION_MS||code==DEFAULT_PAGE_SIZE;}
    private static String ruleKey(Code code,String value){return code==EXTRA_SENSITIVE_POINTERS?value:value.toLowerCase(Locale.ROOT);}
    private static Map<Code,Setting> index(List<Setting> settings){var values=new EnumMap<Code,Setting>(Code.class);settings.forEach(item->values.put(item.code(),item));return values;}

    sealed interface EffectiveValue permits BooleanValue,IntegerValue,DecimalValue,StringListValue {}
    record BooleanValue(Code code,boolean value) implements EffectiveValue {}
    record IntegerValue(Code code,long value) implements EffectiveValue {}
    record DecimalValue(Code code,java.math.BigDecimal value) implements EffectiveValue {}
    record StringListValue(Code code,List<String> value) implements EffectiveValue {StringListValue{value=List.copyOf(value);}}
    static List<EffectiveValue> effectiveValues(List<Setting> settings) {
        return settings.stream().map(item->{
            if(item instanceof BooleanSetting value)return (EffectiveValue)new BooleanValue(value.code(),value.effective());
            if(item instanceof IntegerSetting value)return (EffectiveValue)new IntegerValue(value.code(),value.effective());
            if(item instanceof StringListSetting value)return (EffectiveValue)new StringListValue(value.code(),value.effective());
            var value=(DecimalSetting)item;return (EffectiveValue)new DecimalValue(value.code(),value.effective());
        }).toList();
    }
}
