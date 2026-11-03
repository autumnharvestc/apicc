package com.autumnharvestc.server.collaboration.audit;

import com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage;
import com.autumnharvestc.server.collaboration.policy.PolicyReadView;
import com.autumnharvestc.server.core.*;
import com.fasterxml.jackson.databind.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import org.springframework.jdbc.core.*;
import org.springframework.stereotype.Component;

/** Bounded, scope/filter-bound keysets across the real provenance domains. Filtering never changes the SQL scope.
 * A sparse filter may return an empty page with a continuation: at most MAX_PAGE_SIZE facts are inspected per read. */
@Component
public class MetadataQuery {
    public static final String TIMESTAMP_MS="CAST(FLOOR(EXTRACT(EPOCH FROM created_at)*1000) AS BIGINT)";
    public record Source(String domain,String table,String millis,String where,List<Object> arguments,RowMapper<Map<String,Object>> fields) {}
    private record Row(int rank,long id,long ms,Map<String,Object> fields) {}
    private record Cursor(String kind,long workspace,long project,String filter,List<Long> highs,long lastMs,int lastRank,long lastId) {}
    private final JdbcTemplate jdbc;private final ObjectMapper json;
    public MetadataQuery(JdbcTemplate jdbc,ObjectMapper json){this.jdbc=jdbc;this.json=json;}
    public Map<String,Object> page(String kind,long ws,long project,PolicyReadView policy,Map<String,String> query,List<Source> sources){
        if(!Set.of("cursor","limit","object","actor","time").containsAll(query.keySet()))throw invalid();
        int limit=(int)CollaborationStorage.number(policy,PolicyReadView.Code.DEFAULT_PAGE_SIZE);String object=query.get("object"),actor=query.get("actor"),time=query.get("time");boolean logs=kind.startsWith("mock-logs:");long from=0,to=Long.MAX_VALUE;
        try{
            if(query.containsKey("limit"))limit=Integer.parseInt(query.get("limit"));
            if(limit<1||limit>CollaborationStorage.number(policy,PolicyReadView.Code.MAX_PAGE_SIZE))throw invalid();
            if(actor!=null&&(logs?!actor.matches("[A-Za-z0-9_-]{22}"):Long.parseLong(actor)<=0))throw invalid();
            if(object!=null){if(logs){if(object.isEmpty()||object.length()>256)throw invalid();}else{String[] parts=object.split(":",-1);if(parts.length!=2||!parts[0].matches("[A-Z_]+")||Long.parseLong(parts[1])<=0)throw invalid();var kinds=new HashSet<String>(List.of("PROJECT","MEMBER"));for(var value:com.autumnharvestc.server.collaboration.artifacts.StorageTypes.Kind.values())kinds.add(value.name());if(!kinds.contains(parts[0])||parts[0].equals("PROJECT")&&Long.parseLong(parts[1])!=project)throw invalid();}}
            if(time!=null){String[] parts=time.split("/",-1);if(parts.length!=2)throw invalid();from=Instant.parse(parts[0]).toEpochMilli();to=Instant.parse(parts[1]).toEpochMilli();if(from<0||to<from)throw invalid();}
        }catch(IllegalArgumentException|java.time.DateTimeException|ArithmeticException malformed){throw invalid();}
        var identity=new TreeMap<String,String>();identity.put("limit",String.valueOf(limit));for(String key:List.of("object","actor","time"))if(query.containsKey(key))identity.put(key,query.get(key));
        String filter=Hashes.sha256Hex(encode(identity).getBytes(StandardCharsets.UTF_8));Cursor cursor;
        if(query.containsKey("cursor")){
            cursor=cursor(query.get("cursor"));
            if(!cursor.kind().equals(kind)||cursor.workspace()!=ws||cursor.project()!=project||!cursor.filter().equals(filter)||cursor.highs().size()!=sources.size())throw invalid();
        }else{var highs=new ArrayList<Long>();for(var source:sources)highs.add(jdbc.queryForObject("SELECT COALESCE(MAX(id),0) FROM "+source.table()+" WHERE "+source.where(),Long.class,source.arguments().toArray()));cursor=new Cursor(kind,ws,project,filter,highs,Long.MAX_VALUE,3,Long.MAX_VALUE);}
        int budget=(int)CollaborationStorage.number(policy,PolicyReadView.Code.MAX_PAGE_SIZE);var candidates=new ArrayList<Row>();
        for(int rank=0;rank<sources.size();rank++){
            var source=sources.get(rank);int sourceRank=rank;String tie=rank<cursor.lastRank()?"1=1":rank>cursor.lastRank()?"1=0":"id<?";
            var args=new ArrayList<Object>(source.arguments());args.add(cursor.highs().get(rank));args.add(cursor.lastMs());args.add(cursor.lastMs());if(rank==cursor.lastRank())args.add(cursor.lastId());
            candidates.addAll(jdbc.query("SELECT *,"+source.millis()+" AS f7f_ms FROM "+source.table()+" WHERE "+source.where()+" AND id<=? AND ("+source.millis()+"<? OR ("+source.millis()+"=? AND "+tie+")) ORDER BY f7f_ms DESC,id DESC FETCH FIRST "+(budget+1)+" ROWS ONLY",(row,index)->new Row(sourceRank,row.getLong("id"),row.getLong("f7f_ms"),source.fields().mapRow(row,index)),args.toArray()));
        }
        candidates.sort(Comparator.comparingLong(Row::ms).thenComparingInt(Row::rank).thenComparingLong(Row::id).reversed());
        var result=new LinkedHashMap<String,Object>();var groups=new ArrayList<List<Map<String,Object>>>();for(var source:sources){var items=new ArrayList<Map<String,Object>>();groups.add(items);result.put(source.domain(),items);}
        int scanned=0,accepted=0;Row last=null;
        for(var row:candidates){if(scanned>=budget||accepted>=limit)break;scanned++;last=row;
            if(row.ms()<from||row.ms()>to)continue;
            if(actor!=null&&!actor.equals(text(row.fields().get(logs?"grantPublicId":"actorId"))))continue;
            if(object!=null&&!object.equals(logs?text(row.fields().get("ruleId")):text(row.fields().get("objectKind"))+":"+text(row.fields().get("objectId"))))continue;
            groups.get(row.rank()).add(row.fields());accepted++;
        }
        String next=last!=null&&scanned<candidates.size()?Base64.getUrlEncoder().withoutPadding().encodeToString(encode(new Cursor(kind,ws,project,filter,cursor.highs(),last.ms(),last.rank(),last.id())).getBytes(StandardCharsets.UTF_8)):"";
        result.put("nextCursor",next);result.put("scannedCount",scanned);result.put("pageLimit",limit);return result;
    }
    private static String text(Object value){return value instanceof JsonNode node?node.asText():value==null?"":value.toString();}
    private Cursor cursor(String encoded){try{
        JsonNode value=json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(Base64.getUrlDecoder().decode(encoded));
        if(!value.isObject()||value.size()!=8)throw invalid();for(String field:List.of("kind","workspace","project","filter","highs","lastMs","lastRank","lastId"))if(!value.hasNonNull(field))throw invalid();
        if(!value.path("kind").isTextual()||!value.path("filter").isTextual()||!value.path("highs").isArray()||value.path("lastRank").asInt(-1)<0||value.path("lastRank").asInt()>2)throw invalid();
        for(String field:List.of("workspace","project","lastMs","lastRank","lastId"))if(!value.path(field).isIntegralNumber()||!value.path(field).canConvertToLong()||value.path(field).asLong()<0)throw invalid();
        for(var high:value.path("highs"))if(!high.isIntegralNumber()||!high.canConvertToLong()||high.asLong()<0)throw invalid();
        return json.treeToValue(value,Cursor.class);
    }catch(java.io.IOException|IllegalArgumentException malformed){throw invalid();}}
    private String encode(Object value){try{return json.writeValueAsString(value);}catch(java.io.IOException impossible){throw new IllegalStateException("Cannot encode finite metadata cursor",impossible);}}
    private static ApiException invalid(){return new ApiException(org.springframework.http.HttpStatus.BAD_REQUEST,"collaboration_query_invalid","分页或对象、操作者、时间过滤条件无效，不能更改游标绑定的范围和过滤条件");}
}
