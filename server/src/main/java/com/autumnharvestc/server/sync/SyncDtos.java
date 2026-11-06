package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.Hashes;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.*;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import java.math.BigInteger;
import java.util.*;

/** Uses the checked-in T1 wire boundary; saved policies preserve omitted overrides. */
@Component
public final class SyncDtos {
    private final ObjectMapper json;
    private final Map<String,JsonSchema> schemas=new HashMap<>();
    public SyncDtos(ObjectMapper json){
        this.json=json;
        try(var input=SyncDtos.class.getResourceAsStream("/sync-input-boundary.json")){
            var document=json.readTree(input);
            var factory=JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
            var config=SchemaValidatorsConfig.builder().formatAssertionsEnabled(true).build();
            for(String name:List.of("sourceSave","policySave","source","policy","effectivePolicy","checkRequest","checkStatus","checkLookup","checkCancelRequest","headerCredential","networkCredential","application","rollback","receipt","history","fixedDetailRequest","fixedDetail"))
                schemas.put(name,factory.getSchema(SchemaLocation.of("urn:apicc:sync:"+name),document.get(name),config));
        }catch(Exception e){throw new IllegalStateException("Cannot load checked-in synchronization boundary",e);}
    }
    public void require(String name,JsonNode input){if(input==null||!schemas.get(name).validate(input).isEmpty())throw invalid();}
    public boolean valid(String name,JsonNode input){return input!=null&&schemas.get(name).validate(input).isEmpty();}
    public ObjectNode source(JsonNode input){
        var source=(ObjectNode)input.deepCopy();
        if(!source.has("schedule"))source.set("schedule",json.valueToTree(Map.of("enabled",false,"rule",Map.of("kind","cron","expression","0 0 * * * *","timeZone","UTC","dstOverlap","first"))));
        return source;
    }
    public static String next(String revision){return new BigInteger(revision).add(BigInteger.ONE).toString();}
    public static long assetVersion(String revision){try{return Long.parseLong(revision);}catch(NumberFormatException e){throw invalid();}}
    public String digest(String kind,String object,JsonNode input){
        var value=json.createArrayNode().add("apicc-sync-online-intent-v1").add(kind).add(object);value.add(canonical(input));
        return Hashes.sha256HexUtf8(value.toString());
    }
    private JsonNode canonical(JsonNode value){
        if(value.isObject()){var result=json.createObjectNode();var keys=new TreeSet<String>();value.fieldNames().forEachRemaining(keys::add);keys.forEach(key->result.set(key,canonical(value.get(key))));return result;}
        if(value.isArray()){var result=json.createArrayNode();value.forEach(item->result.add(canonical(item)));return result;}
        return value;
    }
    public static ApiException invalid(){return new ApiException(HttpStatus.BAD_REQUEST,"validation_failed","同步配置不符合公开结构或版本格式");}
    public static ApiException conflict(String code){return new ApiException(HttpStatus.CONFLICT,code,"同步配置或项目版本已变化，请重新读取");}
    public static ApiException denied(){return new ApiException(HttpStatus.FORBIDDEN,"forbidden","当前账号没有此同步业务权限");}
    public static final Map<String,Long> DEFAULTS;
    static {
        var values=new LinkedHashMap<String,Long>();
        values.put("connectTimeoutMs",10000L); values.put("urlDeadlineMs",60000L); values.put("gitDeadlineMs",120000L);
        values.put("maxAttempts",1L); values.put("maxSourceBytes",5242880L);
        values.put("maxCompareInputBytes",16777216L); values.put("maxCompareOutputBytes",8388608L);
        values.put("maxNormalizeDepth",128L); values.put("maxNormalizeNodes",100000L);
        values.put("gitDiskThresholdBytes",268435456L); values.put("projectConcurrency",1L); values.put("hostConcurrency",4L);
        values.put("candidateTtlMs",86400000L); values.put("historyRetentionDays",30L); values.put("historyMaxEntries",100L);
        DEFAULTS=Collections.unmodifiableMap(values);
    }
    public static ObjectNode emptyPolicy(ObjectMapper json,String scope){return json.createObjectNode().put("formatVersion",1).put("revision","0").put("scope",scope);}
    public static Map<String,String> units(){
        var units=new LinkedHashMap<String,String>();
        DEFAULTS.keySet().forEach(key->units.put(key,key.endsWith("Ms")?"milliseconds":key.endsWith("Bytes")?"bytes":key.equals("historyRetentionDays")?"days":"count"));
        return Map.copyOf(units);
    }
}
