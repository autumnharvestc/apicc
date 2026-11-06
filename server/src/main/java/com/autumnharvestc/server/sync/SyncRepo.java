package com.autumnharvestc.server.sync;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import java.util.*;

/** One storage authority for synchronization side tables; assets remain in their existing authority. */
@Repository
public class SyncRepo {
    private final SyncStorage accounting;private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final org.springframework.beans.factory.ObjectProvider<SyncCheckWorker> workers;
    public SyncRepo(JdbcTemplate jdbc,ObjectMapper json,org.springframework.beans.factory.ObjectProvider<SyncCheckWorker> workers,SyncStorage accounting){this.accounting=accounting;this.jdbc=jdbc;this.json=json;this.workers=workers;}
    public List<JsonNode> sources(long ws,long project){return jdbc.query("SELECT source_json FROM sync_sources WHERE workspace_id=? AND project_id=? AND deleted=FALSE ORDER BY id",(row,index)->decode(row.getString(1)),ws,project);}
    public Optional<JsonNode> source(long ws,long project,String id){return jdbc.query("SELECT source_json FROM sync_sources WHERE workspace_id=? AND project_id=? AND id=? AND deleted=FALSE",(row,index)->decode(row.getString(1)),ws,project,id).stream().findFirst();}
    public void saveSource(long ws,long project,JsonNode source){
        accounting.changed(ws,project);String id=source.path("id").asText(),revision=source.path("revision").asText(),text=source.toString();
        if(jdbc.update("UPDATE sync_sources SET source_revision=?,source_json=? WHERE workspace_id=? AND project_id=? AND id=?",revision,text,ws,project,id)==0)
            jdbc.update("INSERT INTO sync_sources(workspace_id,project_id,id,source_revision,source_json) VALUES(?,?,?,?,?)",ws,project,id,revision,text);
    }
    public JsonNode policy(long ws,Long project){
        return jdbc.query("SELECT policy_json FROM sync_policies WHERE workspace_id=? AND project_id=?",(row,index)->decode(row.getString(1)),ws,project==null?0:project).stream().findFirst()
            .orElseGet(()->SyncDtos.emptyPolicy(json,project==null?"workspace":"project"));
    }
    public void savePolicy(long ws,Long project,JsonNode policy){
        long scope=project==null?0:project;accounting.changed(ws,scope);String revision=policy.path("revision").asText(),text=policy.toString();
        if(jdbc.update("UPDATE sync_policies SET revision=?,policy_json=? WHERE workspace_id=? AND project_id=?",revision,text,ws,scope)==0)
            jdbc.update("INSERT INTO sync_policies(workspace_id,project_id,revision,policy_json) VALUES(?,?,?,?)",ws,scope,revision,text);
    }
    public void lockWorkspace(long ws){jdbc.queryForList("SELECT id FROM workspaces WHERE id=? FOR UPDATE",ws);}
    public record SourceState(JsonNode source,String mappingRevision,String baselineRevision,JsonNode mapping,JsonNode baseline) {}
    public SourceState sourceState(long ws,long project,String id){return jdbc.query("SELECT source_json,mapping_revision,baseline_revision,mapping_json,baseline_json,baseline_ref_json FROM sync_sources WHERE workspace_id=? AND project_id=? AND id=? AND deleted=FALSE",(r,n)->new SourceState(decode(r.getString(1)),r.getString(2),r.getString(3),r.getString(4)==null?null:decode(r.getString(4)),baseline(r.getString(5),r.getString(6))),ws,project,id).stream().findFirst().orElseThrow(()->missing("sync_source_not_found"));}
    private JsonNode baseline(String text,String reference){if(text==null){if(reference!=null)throw SyncDtos.conflict("sync_baseline_integrity_mismatch");return null;}if(reference==null)throw SyncDtos.conflict("sync_baseline_integrity_mismatch");var ref=decode(reference);if(!ref.path("contentType").asText().equals("application/vnd.apicc.sync-files+json")||!com.autumnharvestc.server.core.Hashes.sha256HexUtf8(text).equals(ref.path("digest").asText())||text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length!=ref.path("bytes").asLong(-1))throw SyncDtos.conflict("sync_baseline_integrity_mismatch");return decode(text);}
    public record Check(String id,String source,long actor,String state,JsonNode details,long createdAt) {}
    public record Dispatch(String workspace,String project,String check) {}
    /** Called under the existing global authority gate; claim before any material/network work. */
    public Optional<Dispatch> claim(){
        var rows=jdbc.query("SELECT workspace_id,project_id,id FROM sync_checks WHERE state IN ('queued','waiting') AND admission_after<=CURRENT_TIMESTAMP ORDER BY admission_after,created_at,id FETCH FIRST 1 ROW ONLY",(r,n)->new Dispatch(String.valueOf(r.getLong(1)),String.valueOf(r.getLong(2)),r.getString(3)));
        if(rows.isEmpty())return Optional.empty();var selected=rows.getFirst();accounting.lock(Long.parseLong(selected.workspace()),Long.parseLong(selected.project()));accounting.changed(Long.parseLong(selected.workspace()),Long.parseLong(selected.project()));jdbc.update("UPDATE sync_checks SET state='running' WHERE workspace_id=? AND project_id=? AND id=? AND state IN ('queued','waiting')",Long.parseLong(selected.workspace()),Long.parseLong(selected.project()),selected.check());return Optional.of(selected);
    }
    public void defer(long ws,long project,String id){accounting.changed(ws,project);jdbc.update("UPDATE sync_checks SET admission_after=? WHERE workspace_id=? AND project_id=? AND id=?",new java.sql.Timestamp(System.currentTimeMillis()+100),ws,project,id);}
    public void recoverActive(){for(var row:jdbc.query("SELECT workspace_id,project_id,id FROM sync_checks WHERE state IN ('running','waiting','cancelling')",(r,n)->new Dispatch(String.valueOf(r.getLong(1)),String.valueOf(r.getLong(2)),r.getString(3)))){accounting.lock(Long.parseLong(row.workspace()),Long.parseLong(row.project()));var check=check(Long.parseLong(row.workspace()),Long.parseLong(row.project()),row.check()).orElseThrow();var details=(com.fasterxml.jackson.databind.node.ObjectNode)check.details().deepCopy();details.put("reasonCode","server-restarted");details.put("completedAtMs",System.currentTimeMillis());details.remove("snapshot");updateCheck(Long.parseLong(row.workspace()),Long.parseLong(row.project()),row.check(),"lost",details);}}
    public Optional<Check> check(long ws,long project,String id){return jdbc.query("SELECT id,source_id,subject_user_id,state,details_json,created_at FROM sync_checks WHERE workspace_id=? AND project_id=? AND id=?",(r,n)->new Check(r.getString(1),r.getString(2),r.getLong(3),r.getString(4),decode(r.getString(5)),r.getTimestamp(6).getTime()),ws,project,id).stream().findFirst();}
    public List<Check> recentChecks(long ws,long project,String source,String states){
        String predicate=switch(states){case "active"->" AND state IN ('queued','running','waiting','cancelling')";case "success"->" AND state='succeeded'";default->"";};
        return jdbc.query("SELECT id,source_id,subject_user_id,state,details_json,created_at FROM sync_checks WHERE workspace_id=? AND project_id=? AND source_id=?"+predicate+" ORDER BY created_at DESC,id DESC FETCH FIRST 1 ROW ONLY",(r,n)->new Check(r.getString(1),r.getString(2),r.getLong(3),r.getString(4),decode(r.getString(5)),r.getTimestamp(6).getTime()),ws,project,source);
    }
    public void createCheck(long ws,long project,String id,String source,long actor,String revision,JsonNode details){accounting.changed(ws,project);jdbc.update("INSERT INTO sync_checks(workspace_id,project_id,id,source_id,source_revision,subject_user_id,state,details_json) VALUES(?,?,?,?,?,?,'queued',?)",ws,project,id,source,revision,actor,details.toString());}
    public void updateCheck(long ws,long project,String id,String state,JsonNode details){accounting.changed(ws,project);jdbc.update("UPDATE sync_checks SET state=?,details_json=? WHERE workspace_id=? AND project_id=? AND id=?",state,details.toString(),ws,project,id);}
    public record Candidate(JsonNode fixed,long expiresAt) {}
    public Optional<Candidate> candidate(long ws,long project,String id){return jdbc.query("SELECT fixed_json,expires_at FROM sync_candidates WHERE workspace_id=? AND project_id=? AND id=?",(r,n)->new Candidate(decode(r.getString(1)),r.getTimestamp(2).getTime()),ws,project,id).stream().findFirst();}
    public void candidate(long ws,long project,String source,JsonNode fixed,long expiresAt){accounting.changed(ws,project);String text=fixed.toString();var existing=candidate(ws,project,fixed.path("candidate").path("id").asText());if(existing.isPresent()){if(!existing.get().fixed().equals(fixed))throw SyncDtos.conflict("SYNC_CANDIDATE_MISMATCH");jdbc.update("UPDATE sync_candidates SET expires_at=? WHERE workspace_id=? AND project_id=? AND id=?",new java.sql.Timestamp(Math.max(expiresAt,existing.get().expiresAt())),ws,project,fixed.path("candidate").path("id").asText());return;}jdbc.update("INSERT INTO sync_candidates(workspace_id,project_id,id,source_id,fixed_json,content_bytes,expires_at) VALUES(?,?,?,?,?,?,?)",ws,project,fixed.path("candidate").path("id").asText(),source,text,text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length,new java.sql.Timestamp(expiresAt));}
    static com.autumnharvestc.server.core.ApiException missing(String code){return new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.NOT_FOUND,code,"同步记录不存在于当前项目");}
    public record Operation(long actor,String kind,String digest,JsonNode response) {}
    public Optional<Operation> operation(long ws,long project,String intent){
        return jdbc.query("SELECT actor_id,kind,request_hash,response_json FROM sync_operations WHERE workspace_id=? AND project_id=? AND intent_id=?",(row,index)->new Operation(row.getLong(1),row.getString(2),row.getString(3),decode(row.getString(4))),ws,project,intent).stream().findFirst();
    }
    public Optional<JsonNode> replay(long ws,long project,String intent,long actor,String kind,String digest){
        return operation(ws,project,intent).map(operation->{
            if(operation.actor()!=actor)throw SyncDtos.denied();
            if(!operation.kind().equals(kind)||!operation.digest().equals(digest))throw SyncDtos.conflict("sync_intent_conflict");
            return operation.response();
        });
    }
    public void operation(long ws,long project,String intent,long actor,String kind,String digest,JsonNode response){
        accounting.changed(ws,project);jdbc.update("INSERT INTO sync_operations(workspace_id,project_id,intent_id,actor_id,kind,request_hash,response_json) VALUES(?,?,?,?,?,?,?)",ws,project,intent,actor,kind,digest,response.toString());
    }
    /** Joins the owning entity deletion transaction after its existing scope/project locks. */
    public void deleteByProject(long ws,long project){
        for(String table:List.of("sync_checks","sync_candidates","sync_history","sync_operations","sync_sources","sync_policies","sync_occurrences"))
            jdbc.update("DELETE FROM "+table+" WHERE workspace_id=? AND project_id=?",ws,project);
        cancelAfterCommit(ws,project);
    }
    /** Includes project_id=0 workspace policies and intents, plus every project scope in that workspace. */
    public void deleteByWorkspace(long ws){
        for(String table:List.of("sync_checks","sync_candidates","sync_history","sync_operations","sync_sources","sync_policies","sync_occurrences"))
            jdbc.update("DELETE FROM "+table+" WHERE workspace_id=?",ws);
        cancelAfterCommit(ws,null);
    }
    private void cancelAfterCommit(long ws,Long project){
        if(!org.springframework.transaction.support.TransactionSynchronizationManager.isSynchronizationActive())throw new IllegalStateException("Synchronization scope deletion requires its owning transaction");
        org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(new org.springframework.transaction.support.TransactionSynchronization(){@Override public void afterCommit(){workers.getObject().cancelScope(ws,project);}});
    }
    private JsonNode decode(String text){try{return json.readTree(text);}catch(Exception e){throw new IllegalStateException("Stored synchronization document is invalid",e);}}
}
