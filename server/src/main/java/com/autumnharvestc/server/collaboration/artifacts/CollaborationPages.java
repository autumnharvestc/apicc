package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.collaboration.policy.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.*;
import java.sql.*;
import java.time.Instant;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import static com.autumnharvestc.server.collaboration.artifacts.RemainingViews.*;
import static com.autumnharvestc.server.collaboration.artifacts.ArtifactService.error;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.Code.*;
import static org.springframework.http.HttpStatus.BAD_REQUEST;

/** Bounded keysets. All public timestamp comparisons use the same canonical millisecond SQL expression. */
@Repository
public class CollaborationPages {
    private static final String MILLIS="CAST(FLOOR(EXTRACT(EPOCH FROM created_at)*1000) AS BIGINT)";
    private final JdbcTemplate jdbc;private final ObjectMapper json;
    public CollaborationPages(JdbcTemplate jdbc,ObjectMapper json){this.jdbc=jdbc;this.json=json;}
    private record Cursor(String type,long workspace,long project,String source,String conclusion,String kind,int limit,long highJob,long highUpload,long highPublication,long lastMs,int lastRank,long lastId) {}
    private record HistoryRow(long id,int rank,long ms,HistoryMetadata metadata) {}
    private record PublicationRow(long id,long ms,PublicationMetadata metadata) {}
    private record Options(int limit,String source,String conclusion,String kind,Cursor cursor) {}
    private Options options(String type,long ws,long project,PolicyReadView policy,Map<String,String> query){
        int limit=(int)CollaborationStorage.number(policy,DEFAULT_PAGE_SIZE);
        try{
            if(query.containsKey("limit"))limit=Integer.parseInt(query.get("limit"));
        }catch(NumberFormatException ex){
            throw invalid();
        }
        if(limit<1||limit>CollaborationStorage.number(policy,MAX_PAGE_SIZE))throw invalid();
        String source=query.get("source"),conclusion=query.get("conclusion"),kind=query.get("kind");
        if(source!=null&&!Set.of("server-report","member-history").contains(source))throw invalid();
        if(conclusion!=null&&!Set.of("passed","failed","interrupted","cancelled","timed-out","rejected","unknown").contains(conclusion))throw invalid();
        if(kind!=null&&!Set.of("document","report","debug-history","mock").contains(kind))throw invalid();
        Cursor cursor=null;
        if(query.containsKey("cursor")){
            cursor=decodeCursor(query.get("cursor"));
            if(!cursor.type().equals(type)||cursor.workspace()!=ws||cursor.project()!=project
                    ||!Objects.equals(cursor.source(),source)||!Objects.equals(cursor.conclusion(),conclusion)
                    ||!Objects.equals(cursor.kind(),kind)||cursor.limit()!=limit)throw cursorInvalid();
        }
        return new Options(limit,source,conclusion,kind,cursor);
    }
    private Cursor decodeCursor(String encoded){
        com.fasterxml.jackson.databind.JsonNode value;
        try{
            value=json.readTree(Base64.getUrlDecoder().decode(encoded));
        }catch(java.io.IOException|IllegalArgumentException ex){
            throw cursorInvalid();
        }
        if(value==null||!value.isObject())throw cursorInvalid();
        for(String field:Set.of("type","workspace","project","source","conclusion","kind","limit","highJob","highUpload","highPublication","lastMs","lastRank","lastId")){
            if(!value.has(field))throw cursorInvalid();
        }
        var type=value.get("type");
        if(!type.isTextual()||!Set.of("history","publications").contains(type.textValue()))throw cursorInvalid();
        String source=cursorChoice(value,"source",Set.of("server-report","member-history"));
        String conclusion=cursorChoice(value,"conclusion",Set.of("passed","failed","interrupted","cancelled","timed-out","rejected","unknown"));
        String kind=cursorChoice(value,"kind",Set.of("document","report","debug-history","mock"));
        long workspace=cursorNumber(value,"workspace"),project=cursorNumber(value,"project"),limit=cursorNumber(value,"limit");
        long highJob=cursorNumber(value,"highJob"),highUpload=cursorNumber(value,"highUpload"),highPublication=cursorNumber(value,"highPublication");
        long lastMs=cursorNumber(value,"lastMs"),lastRank=cursorNumber(value,"lastRank"),lastId=cursorNumber(value,"lastId");
        if(workspace<=0||project<=0||limit<1||limit>200||highJob<0||highUpload<0||highPublication<0
                ||lastRank<0||lastRank>1||lastId<=0||type.textValue().equals("publications")&&lastRank!=0)throw cursorInvalid();
        return new Cursor(type.textValue(),workspace,project,source,conclusion,kind,(int)limit,highJob,highUpload,highPublication,lastMs,(int)lastRank,lastId);
    }
    private String cursorChoice(com.fasterxml.jackson.databind.JsonNode value,String field,Set<String> allowed){
        var item=value.get(field);
        if(item.isNull())return null;
        if(!item.isTextual()||!allowed.contains(item.textValue()))throw cursorInvalid();
        return item.textValue();
    }
    private long cursorNumber(com.fasterxml.jackson.databind.JsonNode value,String field){
        var item=value.get(field);
        if(!item.isIntegralNumber()||!item.canConvertToLong())throw cursorInvalid();
        return item.longValue();
    }
    public HistoryPage history(long ws,long project,PolicyReadView policy,Map<String,String> query){var o=options("history",ws,project,policy,query);var c=o.cursor();long highJob=c==null?maximum("execution_jobs",ws,project):c.highJob(),highUpload=c==null?maximum("collaboration_member_uploads",ws,project):c.highUpload();
        String union="SELECT id,0 AS rank,"+MILLIS+" AS ms,execution_id,agent_id,submitted_by AS actor_id,snapshot_id,report_kind AS kind,COALESCE(terminal_conclusion,'unknown') AS conclusion,report_state AS state,state AS job_state,terminal_conclusion IS NOT NULL AS indexed FROM execution_jobs WHERE workspace_id=? AND project_id=? AND id<=? UNION ALL SELECT id,1 AS rank,created_at_epoch_ms AS ms,NULL AS execution_id,NULL AS agent_id,actor_id,NULL AS snapshot_id,kind,COALESCE(conclusion,'unknown') AS conclusion,'accepted' AS state,'ended' AS job_state,TRUE AS indexed FROM collaboration_member_uploads WHERE workspace_id=? AND project_id=? AND id<=?";
        var args=new ArrayList<Object>(List.of(ws,project,highJob,ws,project,highUpload));String where=" WHERE 1=1";if(o.source()!=null){where+=" AND rank=?";args.add(o.source().equals("server-report")?0:1);}if(o.conclusion()!=null){where+=" AND conclusion=?";args.add(o.conclusion());}if(c!=null){where+=" AND (ms<? OR (ms=? AND (rank<? OR (rank=? AND id<?))))";args.addAll(List.of(c.lastMs(),c.lastMs(),c.lastRank(),c.lastRank(),c.lastId()));}
        var rows=jdbc.query("SELECT * FROM ("+union+") history"+where+" ORDER BY ms DESC,rank DESC,id DESC FETCH FIRST "+(o.limit()+1)+" ROWS ONLY",(row,index)->{long id=row.getLong("id"),ms=row.getLong("ms");int rank=row.getInt("rank");String actor=String.valueOf(row.getLong("actor_id"));boolean report=rank==0;return new HistoryRow(id,rank,ms,new HistoryMetadata(String.valueOf(id),report?"server-report":"member-history",row.getString("kind"),report?"server-archive":"member-claim",actor,Instant.ofEpochMilli(ms).toString(),row.getString("conclusion"),row.getString("state"),report?"unavailable":"member-claim",report?String.valueOf(id):null,report?String.valueOf(row.getLong("execution_id")):null,report?String.valueOf(row.getLong("agent_id")):null,report?actor:null,report?String.valueOf(row.getLong("snapshot_id")):null,unavailable(),conclusionInfo(report,row)));},args.toArray());
        boolean more=rows.size()>o.limit();var page=rows.subList(0,Math.min(rows.size(),o.limit()));var result=new ArrayList<HistoryMetadata>();for(var row:page){var m=row.metadata();result.add(row.rank()==0?new HistoryMetadata(m.id(),m.source(),m.kind(),m.trust(),m.createdBy(),m.createdAt(),m.conclusion(),m.state(),m.integrity(),m.jobId(),m.executionId(),m.agentId(),m.creatorId(),m.snapshotId(),runtime(row.id()),m.conclusionInfo()):m);}String next="";if(more){var last=page.getLast();next=encode(new Cursor("history",ws,project,o.source(),o.conclusion(),o.kind(),o.limit(),highJob,highUpload,0,last.ms(),last.rank(),last.id()));}return new HistoryPage(result,next);
    }
    public PublicationPage publications(long ws,long project,PolicyReadView policy,boolean historyReadable,Map<String,String> query){var o=options("publications",ws,project,policy,query);var c=o.cursor();long high=c==null?maximum("collaboration_publications",ws,project):c.highPublication();var args=new ArrayList<Object>(List.of(ws,project,high));String where="workspace_id=? AND project_id=? AND id<=?";if(!historyReadable)where+=" AND kind IN ('document','mock')";if(o.kind()!=null){where+=" AND kind=?";args.add(o.kind());}if(c!=null){where+=" AND ("+MILLIS+"<? OR ("+MILLIS+"=? AND id<?))";args.addAll(List.of(c.lastMs(),c.lastMs(),c.lastId()));}
        var rows=jdbc.query("SELECT id,version,digest,kind,trust,actor_id,revision,enabled,source_kind,source_revision,source_digest,source_upload_id,source_uploaded_by,source_job_id,policy_epoch,"+MILLIS+" AS ms FROM collaboration_publications WHERE "+where+" ORDER BY ms DESC,id DESC FETCH FIRST "+(o.limit()+1)+" ROWS ONLY",(row,index)->new PublicationRow(row.getLong("id"),row.getLong("ms"),new PublicationMetadata(String.valueOf(row.getLong("id")),row.getLong("version"),row.getString("digest"),row.getString("kind"),row.getString("trust"),String.valueOf(row.getLong("actor_id")),Instant.ofEpochMilli(row.getLong("ms")).toString(),row.getLong("revision"),row.getBoolean("enabled"),new Source(row.getString("source_kind"),row.getString("source_revision"),row.getString("source_digest"),row.getString("source_upload_id"),row.getString("source_job_id"),row.getString("source_uploaded_by")),row.getLong("policy_epoch"))),args.toArray());
        boolean more=rows.size()>o.limit();var page=rows.subList(0,Math.min(rows.size(),o.limit()));String next="";if(more){var last=page.getLast();next=encode(new Cursor("publications",ws,project,o.source(),o.conclusion(),o.kind(),o.limit(),0,0,high,last.ms(),0,last.id()));}return new PublicationPage(page.stream().map(PublicationRow::metadata).toList(),next);
    }
    private ConclusionProof conclusionInfo(boolean report,ResultSet row)throws SQLException {
        if(!report)return new ConclusionProof(ConclusionOrigin.MEMBER_CLAIM,null,null);
        if(row.getBoolean("indexed"))return new ConclusionProof(ConclusionOrigin.TERMINAL_INDEX,null,null);
        var reason=row.getString("job_state").equals("ended")?ConclusionReason.LEGACY_UNINDEXED:ConclusionReason.NOT_ENDED;
        return new ConclusionProof(reason==ConclusionReason.LEGACY_UNINDEXED?ConclusionOrigin.LEGACY_UNINDEXED:ConclusionOrigin.NOT_ENDED,reason,reason.description());
    }
    private long maximum(String table,long ws,long project){return jdbc.queryForObject("SELECT COALESCE(MAX(id),0) FROM "+table+" WHERE workspace_id=? AND project_id=?",Long.class,ws,project);}
    /** Only fixed permit and stress-admission fields are read. Never today's agent, task/progress/summary or report body. */
    private RuntimeProof runtime(long id){return jdbc.query("SELECT permit_json,stress_metadata_json FROM execution_jobs WHERE id=?",(row,index)->{var permit=fields(row.getCharacterStream(1),Set.of("runtimeCompatibilityId","executionProfile","policyVersion"),false);var stress=fields(row.getCharacterStream(2),Set.of("runtimeCompatibilityId","coreBuildId","scriptApiId","nodeVersion","v8Version"),true);if(!stress.isEmpty())return new RuntimeProof("stress-admission",stress.get("runtimeCompatibilityId"),permit.get("executionProfile"),permit.get("policyVersion"),stress.get("coreBuildId"),stress.get("scriptApiId"),stress.get("nodeVersion"),stress.get("v8Version"));if(permit.isEmpty())return unavailable();return new RuntimeProof("start-permit",permit.get("runtimeCompatibilityId"),permit.get("executionProfile"),permit.get("policyVersion"),null,null,null,null);},id).stream().findFirst().orElse(unavailable());}
    private Map<String,String> fields(java.io.Reader reader,Set<String> allowed,boolean nested){if(reader==null)return Map.of();try(reader;var parser=json.getFactory().createParser(reader)){if(parser.nextToken()!=JsonToken.START_OBJECT)return Map.of();var result=new HashMap<String,String>();while(parser.nextToken()!=JsonToken.END_OBJECT){String name=parser.currentName();var token=parser.nextToken();if(nested&&name.equals("runtime")&&token==JsonToken.START_OBJECT){while(parser.nextToken()!=JsonToken.END_OBJECT){String key=parser.currentName();var value=parser.nextToken();if(allowed.contains(key)&&value==JsonToken.VALUE_STRING)result.put(key,parser.getText());else parser.skipChildren();}}else if(!nested&&allowed.contains(name)&&token==JsonToken.VALUE_STRING)result.put(name,parser.getText());else parser.skipChildren();}return result;}catch(java.io.IOException ex){return Map.of();}}
    private static RuntimeProof unavailable(){return new RuntimeProof("unavailable",null,null,null,null,null,null,null);}
    private String encode(Cursor value){try{return Base64.getUrlEncoder().withoutPadding().encodeToString(json.writeValueAsBytes(value));}catch(java.io.IOException ex){throw new IllegalStateException(ex);}}
    private static com.autumnharvestc.server.core.ApiException invalid(){return error(BAD_REQUEST,"invalid_request");}
    private static com.autumnharvestc.server.core.ApiException cursorInvalid(){return error(BAD_REQUEST,"collaboration_cursor_invalid");}
}
