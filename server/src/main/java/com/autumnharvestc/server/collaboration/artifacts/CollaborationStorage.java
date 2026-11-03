package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.collaboration.policy.*;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.store.IdGeneration;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import static com.autumnharvestc.server.collaboration.artifacts.StorageTypes.*;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.Code.*;

/** Canonical logical charges, not database-page/RSS estimates.
 * Mutations join the owning transaction: policy[/row], access, global/project quota,
 * project/source, stable object/ref, audit. Remote RPC never runs here. */
@Service
public class CollaborationStorage {
    private final JdbcTemplate jdbc;private final ObjectMapper json;private final CollaborationTime time;private final IdGeneration ids;
    private final TransactionTemplate transactions;private final CollaborationPolicyRepo policyLocks;private final ObjectProvider<CollaborationPolicyService> policies;
    private final ObjectProvider<com.autumnharvestc.server.collaboration.grants.GrantService> grants;
    public CollaborationStorage(JdbcTemplate jdbc,ObjectMapper json,CollaborationTime time,IdGeneration ids,PlatformTransactionManager transactions,
            CollaborationPolicyRepo policyLocks,ObjectProvider<CollaborationPolicyService> policies,ObjectProvider<com.autumnharvestc.server.collaboration.grants.GrantService> grants){this.jdbc=jdbc;this.json=json;this.time=time;this.ids=ids;this.transactions=new TransactionTemplate(transactions);this.policyLocks=policyLocks;this.policies=policies;this.grants=grants;}
    private record StoredMetadata(long workspace,long project,long objectId,Kind kind,long actorId,String state,String sourceJson,String accessJson,String policyJson,String digest,
            long createdAtEpochMs,Long expiresAtEpochMs,Long operationDeadline,Long previewId,Long version,String publicationIntentId,String trust,Integer formatVersion) {}
    private record Receipt(long workspace,long project,long objectId,long actorId,String digest,String kind,String state,long retireAtEpochMs) {}
    private record PolicyMetadata(long workspace,long project,long revision,long projectionRevision,String settingsJson) {}
    private record ReferenceMetadata(long targetId,Kind targetKind,OwnerKind ownerKind,long ownerId,Long expiresAt) {}
    private record UploadMetadata(long workspace,long project,long id,long actor,String kind,String digest,String conclusion,long createdAtEpochMs,long expiresAtEpochMs) {}
    private record VersionMetadata(long workspace,long project,long nextVersion) {}
    private record GateMetadata(String storedMetadata,long revision,boolean enabled) {}
    private record Charge(long body,long metadata,long reserved) {long actual(){return body+metadata;}}
    private record Ref(long id,long workspace,long project,Kind targetKind,long targetId,OwnerKind ownerKind,long ownerId,Long expiry) {}
    public Usage usage(long workspace,long project){
        String scope=workspace==0?"":" WHERE workspace_id=? AND project_id=?";Object[] args=workspace==0?new Object[0]:new Object[]{workspace,project};
        return jdbc.queryForObject("SELECT COALESCE(SUM(body_bytes+metadata_bytes),0),COALESCE(SUM(reserved_bytes),0),COALESCE(SUM(body_bytes),0),COALESCE(SUM(CASE WHEN kind='AUDIT' THEN metadata_bytes ELSE 0 END),0),COALESCE(SUM(CASE WHEN kind='PREVIEW' AND body_bytes>0 THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN kind='ARTIFACT' THEN 1 ELSE 0 END),0),COALESCE(SUM(pending),0) FROM collaboration_storage_objects"+scope,(row,index)->new Usage(row.getLong(1),row.getLong(2),row.getLong(3),row.getLong(4),row.getLong(5),row.getLong(6),row.getLong(7)),args);
    }
    public static long number(PolicyReadView policy,PolicyReadView.Code code){return ((PolicyReadView.IntegerSetting)policy.settings().stream().filter(setting->setting.code()==code).findFirst().orElseThrow()).effective();}
    public record CleanupScope(long workspace,long project) {}
    public List<CleanupScope> cleanupScopes(long workspace,long project,int limit){
        return jdbc.query("SELECT workspace_id,project_id FROM collaboration_storage_accounts WHERE workspace_id>? OR (workspace_id=? AND project_id>?) ORDER BY workspace_id,project_id FETCH FIRST "+limit+" ROWS ONLY",
            (row,index)->new CleanupScope(row.getLong(1),row.getLong(2)),workspace,workspace,project);
    }
    /** Last-run bookkeeping and cleanup commit together under the existing policy/scope gates. */
    public void cleanupIfDue(long workspace,long project){
        transactions.executeWithoutResult(tx->{
            var policy=policies.getObject().publicationSnapshot(workspace,project);
            lockScope(workspace,project);
            long now=time.now().toEpochMilli();
            long previous=jdbc.queryForObject("SELECT last_cleanup_epoch_ms FROM collaboration_storage_accounts WHERE workspace_id=? AND project_id=?",Long.class,workspace,project);
            if(previous!=0 && now-previous<number(policy,CLEANUP_INTERVAL_MS))return;
            cleanup(workspace,project);
            jdbc.update("UPDATE collaboration_storage_accounts SET last_cleanup_epoch_ms=? WHERE workspace_id=? AND project_id=?",now,workspace,project);
        });
    }
    /** No actor is inferred from an anonymous external key holder. No secret-bearing input is accepted. */
    public void publicAccess(long workspace,long project,long publication,boolean download){
        transactions.executeWithoutResult(tx->{
            var policy=policies.getObject().publicationSnapshot(workspace,project);
            if(number(policy,ACCESS_AUDIT_RETENTION_MS)==0)return;
            lockScope(workspace,project);
            long now=time.now().toEpochMilli();
            var event=new LinkedHashMap<String,Object>();
            event.put("action",download?"PUBLIC_DOWNLOAD":"PUBLIC_VIEW");event.put("reason","SUCCESS");
            event.put("actorId",null);event.put("workspaceId",workspace);event.put("projectId",project);
            event.put("objectKind","ARTIFACT");event.put("objectId",publication);event.put("revision",null);event.put("occurredAtEpochMs",now);
            String metadata=encode(event);
            long id=insert("collaboration_management_audit","workspace_id,project_id,event_json,created_at_epoch_ms,retention_class",new Object[]{workspace,project,metadata,now,"access"});
            put(workspace,project,Kind.AUDIT,id,0,metadata,0,0);
            // Includes every existing owner reservation. Failure rolls this best-effort fact back.
            capacity(workspace,project,policy);
        });
    }
    /** Caller holds policy/access gates. Account locks live until the owning transaction completes. */
    public void lockScope(long workspace,long project){account(0,0);if(workspace!=0||project!=0)account(workspace,project);}
    private void account(long ws,long project){
        if(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_accounts WHERE workspace_id=? AND project_id=?",Long.class,ws,project)==0)jdbc.update("INSERT INTO collaboration_storage_accounts(workspace_id,project_id,actual_bytes,reserved_bytes) VALUES(?,?,0,0)",ws,project);
        jdbc.queryForList("SELECT actual_bytes,reserved_bytes FROM collaboration_storage_accounts WHERE workspace_id=? AND project_id=? FOR UPDATE",ws,project);
    }
    private void capacity(long ws,long project,PolicyReadView policy){if(usage(0,0).occupiedBytes()>number(policy,DEPLOYMENT_MAX_STORAGE_BYTES)||(project>0&&usage(ws,project).occupiedBytes()>number(policy,MAX_PROJECT_STORAGE_BYTES)))throw failure("collaboration_storage_limit");}
    public void previewAdmission(long actor,long ws,long project,PolicyReadView policy){
        long now=time.now().toEpochMilli();
        if(pending("",new Object[]{},now)>=number(policy,MAX_PREVIEWS_GLOBAL)||pending(" AND workspace_id=? AND project_id=?",new Object[]{ws,project},now)>=number(policy,MAX_PREVIEWS_PER_PROJECT)||pending(" AND workspace_id=? AND project_id=? AND actor_id=?",new Object[]{ws,project,actor},now)>=number(policy,MAX_PREVIEWS_PER_PERSON))throw failure("collaboration_preview_limit");
    }
    private long pending(String scope,Object[] args,long now){var values=new ArrayList<Object>();values.add(new Timestamp(now));values.addAll(Arrays.asList(args));return jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_previews WHERE state='pending' AND expires_at>?"+scope,Long.class,values.toArray());}
    public void versionAdmission(long ws,long project,PolicyReadView policy){if(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_publications WHERE workspace_id=? AND project_id=?",Long.class,ws,project)>=number(policy,MAX_PROJECT_VERSIONS))throw failure("collaboration_version_limit");}
    public void createdPreview(long actor,long id,PolicyReadView policy){long[] s=observe(Kind.PREVIEW,id,2*frame(Kind.PREVIEW));audit(actor,s[0],s[1],Kind.PREVIEW,id,Action.PREVIEW_CREATED,Reason.USER_COMMAND,null);capacity(s[0],s[1],policy);}
    /** High-frequency Mock facts are a separate finite, charged provenance domain. Caller owns scope transaction. */
    public long mockLog(long ws,long project,long publication,com.autumnharvestc.server.collaboration.audit.MockLogEntry entry,PolicyReadView policy){
        String metadata=encode(entry);long now=time.now().toEpochMilli();
        long id=insert("collaboration_mock_logs","workspace_id,project_id,publication_id,metadata_json,created_at_epoch_ms",new Object[]{ws,project,publication,metadata,now});
        put(ws,project,Kind.LOG,id,0,metadata,0,0);capacity(ws,project,policy);return id;
    }
    public long limitMockLogs(long ws,long project,long publication,long maximum,PolicyReadView policy){
        var excess=jdbc.queryForList("SELECT id FROM collaboration_mock_logs WHERE workspace_id=? AND project_id=? AND publication_id=? ORDER BY id DESC OFFSET "+maximum+" ROWS FETCH FIRST "+number(policy,CLEANUP_BATCH_SIZE)+" ROWS ONLY",Long.class,ws,project,publication);
        return discardMockLogs(ws,project,publication,excess,policy);
    }
    public long expireMockLogs(long ws,long project,long publication,PolicyReadView policy){var expired=jdbc.queryForList("SELECT id FROM collaboration_mock_logs WHERE workspace_id=? AND project_id=? AND publication_id=? AND created_at_epoch_ms<=? ORDER BY id FETCH FIRST "+number(policy,CLEANUP_BATCH_SIZE)+" ROWS ONLY",Long.class,ws,project,publication,time.now().toEpochMilli()-number(policy,MOCK_LOG_RETENTION_MS));return discardMockLogs(ws,project,publication,expired,policy);}
    private long discardMockLogs(long ws,long project,long publication,List<Long> excess,PolicyReadView policy){
        for(long id:excess){jdbc.update("DELETE FROM collaboration_mock_logs WHERE id=?",id);drop(ws,project,Kind.LOG,id);}
        long discarded=jdbc.query("SELECT discarded FROM collaboration_mock_log_state WHERE publication_id=?",(row,index)->row.getLong(1),publication).stream().findFirst().orElse(0L)+excess.size();
        if(!excess.isEmpty()){
            jdbc.update("DELETE FROM collaboration_mock_log_state WHERE publication_id=?",publication);jdbc.update("INSERT INTO collaboration_mock_log_state(publication_id,workspace_id,project_id,discarded) VALUES(?,?,?,?)",publication,ws,project,discarded);
            put(ws,project,Kind.LOG,-publication,0,encode(new MockLogState(publication,discarded)),0,0);capacity(ws,project,policy);
        }
        return discarded;
    }
    private record MockLogState(long publicationId,long discarded) {}
    public void confirmed(long actor,long preview,long artifact,PolicyReadView policy){
        long[] s=observe(Kind.ARTIFACT,artifact,frame(Kind.ARTIFACT));observe(Kind.PREVIEW,preview,frame(Kind.PREVIEW));
        long next=jdbc.queryForObject("SELECT next_version FROM collaboration_publication_versions WHERE workspace_id=? AND project_id=?",Long.class,s[0],s[1]);put(s[0],s[1],Kind.VERSION_COUNTER,0,0,encode(new VersionMetadata(s[0],s[1],next)),0,0);
        jdbc.update("UPDATE collaboration_storage_objects SET inactive_since=? WHERE workspace_id=? AND project_id=? AND kind='ARTIFACT' AND object_id=?",time.now().toEpochMilli(),s[0],s[1],artifact);
        audit(actor,s[0],s[1],Kind.ARTIFACT,artifact,Action.ARTIFACT_CREATED,Reason.USER_COMMAND,null);capacity(s[0],s[1],policy);
    }
    public void cancelled(long actor,long id){long[] s=scope(Kind.PREVIEW,id);consume(s[0],s[1],Kind.PREVIEW,id);observe(Kind.PREVIEW,id,null);audit(actor,s[0],s[1],Kind.PREVIEW,id,Action.PREVIEW_CANCELLED,Reason.USER_COMMAND,null);}
    public void policySaved(long actor,long workspace,long project,long revision,PolicyReadView policy){
        var f=jdbc.queryForMap("SELECT revision,projection_revision,settings_json FROM collaboration_policy WHERE workspace_id=? AND project_id=?",workspace,project);
        put(workspace,project,Kind.POLICY,0,0,encode(new PolicyMetadata(workspace,project,((Number)f.get("revision")).longValue(),((Number)f.get("projection_revision")).longValue(),(String)f.get("settings_json"))),0,0);
        audit(actor,workspace,project,Kind.POLICY,0,Action.POLICY_UPDATED,Reason.USER_COMMAND,revision);capacity(workspace,project,policy);
    }
    public void grantCreated(long actor,long workspace,long project,long id,Object metadata,PolicyReadView policy){
        put(workspace,project,Kind.GRANT,id,0,encode(metadata),0,frame(Kind.GRANT)+256);
        audit(actor,workspace,project,Kind.GRANT,id,Action.GRANT_CREATED,Reason.USER_COMMAND,1L);
        capacity(workspace,project,policy);
    }
    private record GrantOperationMetadata(long workspace,long project,String intent,Object receipt){}
    public void grantOperation(long workspace,long project,long id,String intent,Object metadata,PolicyReadView policy){
        put(workspace,project,Kind.GRANT_OPERATION,id,0,encode(new GrantOperationMetadata(workspace,project,intent,metadata)),0,0);capacity(workspace,project,policy);
    }
    private record AppliedPolicyMetadata(String digest,long appliedAt){}
    public void deploymentPolicyApplied(String digest,long occurredAt,boolean changed,PolicyReadView policy){
        put(0,0,Kind.APPLIED_POLICY,1,0,encode(new AppliedPolicyMetadata(digest,occurredAt)),0,0);
        if(changed)audit(null,0,0,Kind.APPLIED_POLICY,1,Action.POLICY_UPDATED,Reason.USER_COMMAND,null);
        capacity(0,0,policy);
    }
    public void grantChanged(Long actor,long workspace,long project,long id,com.autumnharvestc.server.collaboration.grants.GrantRepo.Grant metadata,PolicyReadView policy,Action action,boolean terminal){
        if(terminal)consume(workspace,project,Kind.GRANT,id);
        long reserve=terminal?0:charge(workspace,project,Kind.GRANT,id).reserved();
        put(workspace,project,Kind.GRANT,id,0,encode(metadata),0,reserve);
        audit(actor,workspace,project,Kind.GRANT,id,action,Reason.USER_COMMAND,metadata.revision());
        if(!terminal)capacity(workspace,project,policy);
    }
    public void releaseGrant(Long actor,long workspace,long project,long grant,long ended){
        for(var ref:refs(" WHERE workspace_id=? AND project_id=? AND owner_kind='GRANT' AND owner_id=? ORDER BY target_id,id FOR UPDATE",workspace,project,grant))removeReference(actor,ref,ended);
    }
    public void beforeProjectDelete(){policyLocks.lockGate();}
    /** After old OWNER/exists/scope check, before quota and the old all-project locks. No entity/content authority is inferred. */
    public PolicyReadView workspaceDeletionPolicy(){return policies.getObject().publicationSnapshot(0,0);}
    public List<Long> lockWorkspaceAccounts(long workspace,List<Long> currentProjects){
        var scopes=new TreeSet<Long>(currentProjects);scopes.add(0L);scopes.addAll(jdbc.queryForList("SELECT project_id FROM collaboration_storage_objects WHERE workspace_id=? UNION SELECT project_id FROM collaboration_policy WHERE workspace_id=?",Long.class,workspace,workspace));
        account(0,0);for(long project:scopes)account(workspace,project);return List.copyOf(scopes);
    }
    /** Joins the caller's old workspace deletion transaction; audit tombstones stay charged in their original scope. */
    public void workspaceDeleted(long actor,long workspace,List<Long> scopes,PolicyReadView policy){for(long project:scopes)projectDeleted(actor,workspace,project);audit(actor,workspace,0,Kind.WORKSPACE,workspace,Action.WORKSPACE_DELETED,Reason.USER_COMMAND,null);capacity(workspace,0,policy);}
    /** Caller owns policy/access/quota/project/object locks and the encompassing mutation transaction. */
    public void publicationUpdated(long actor,long workspace,long project,long id,PolicyReadView policy){
        Long inactive=jdbc.queryForObject("SELECT inactive_since FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind='ARTIFACT' AND object_id=?",Long.class,workspace,project,id);
        observe(Kind.ARTIFACT,id,null);jdbc.update("UPDATE collaboration_storage_objects SET inactive_since=? WHERE workspace_id=? AND project_id=? AND kind='ARTIFACT' AND object_id=?",inactive,workspace,project,id);
        audit(actor,workspace,project,Kind.ARTIFACT,id,Action.ARTIFACT_UPDATED,Reason.USER_COMMAND,null);capacity(workspace,project,policy);
    }
    public void requireUnreferenced(long workspace,long project,Kind kind,long id){if(refs(" WHERE workspace_id=? AND project_id=? AND target_kind=? AND target_id=?",workspace,project,kind.name(),id).stream().anyMatch(ref->end(ref)>time.now().toEpochMilli()))throw failure("collaboration_object_referenced");}
    public void removed(long actor,long workspace,long project,Kind kind,long id){
        requireUnreferenced(workspace,project,kind,id);
        if(kind==Kind.ARTIFACT){
            var policy=policies.getObject().publicationSnapshot(workspace,project);
            while(grants.getObject().expireDue(actor,workspace,project,id,200,policy)==200){/* finite owner pages */}
        }
        consume(workspace,project,kind,id);
        String table=kind==Kind.UPLOAD?"collaboration_member_uploads":"collaboration_publications";
        jdbc.update("DELETE FROM "+table+" WHERE id=?",id);
        if(kind==Kind.ARTIFACT)removeMockLogs(workspace,project,id);
        drop(workspace,project,kind,id);
        audit(actor,workspace,project,kind,id,kind==Kind.UPLOAD?Action.UPLOAD_RECLAIMED:Action.ARTIFACT_RECLAIMED,Reason.USER_COMMAND,null);
    }
    public void uploadAdmission(long workspace,long project,PolicyReadView policy){if(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_member_uploads WHERE workspace_id=? AND project_id=?",Long.class,workspace,project)>=number(policy,MAX_MEMBER_UPLOAD_RECORDS))throw failure("collaboration_upload_limit");}
    public void uploaded(long actor,long id,PolicyReadView policy){var f=jdbc.queryForMap("SELECT id,workspace_id,project_id,actor_id,kind,digest,conclusion,created_at_epoch_ms,expires_at_epoch_ms,OCTET_LENGTH(body) AS body_bytes FROM collaboration_member_uploads WHERE id=?",id);long ws=((Number)f.get("workspace_id")).longValue(),project=((Number)f.get("project_id")).longValue();
        put(ws,project,Kind.UPLOAD,id,((Number)f.get("body_bytes")).longValue(),encode(new UploadMetadata(ws,project,id,actor,(String)f.get("kind"),(String)f.get("digest"),(String)f.get("conclusion"),((Number)f.get("created_at_epoch_ms")).longValue(),((Number)f.get("expires_at_epoch_ms")).longValue())),0,frame(Kind.UPLOAD));audit(actor,ws,project,Kind.UPLOAD,id,Action.UPLOAD_ACCEPTED,Reason.USER_COMMAND,null);capacity(ws,project,policy);
    }
    public void projectDeleted(long actor,long workspace,long project){
        // Unexpired audit stays charged at the original finite tombstone accounting scope.
        var owners=jdbc.queryForList("SELECT kind,object_id FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind<>'AUDIT' ORDER BY object_id,kind FOR UPDATE",workspace,project);
        for(var row:owners){Kind kind=Kind.valueOf((String)row.get("kind"));long id=((Number)row.get("object_id")).longValue();
            if(kind==Kind.PREVIEW||kind==Kind.ARTIFACT||kind==Kind.REFERENCE||kind==Kind.UPLOAD||kind==Kind.GRANT){if(charge(workspace,project,kind,id).reserved()>0){consume(workspace,project,kind,id);audit(actor,workspace,project,kind,id,Action.PROJECT_DELETED,Reason.PROJECT_REMOVED,null);}}
            drop(workspace,project,kind,id);
        }
        jdbc.update("DELETE FROM collaboration_storage_references WHERE workspace_id=? AND project_id=?",workspace,project);
        jdbc.update("DELETE FROM collaboration_grant_operations WHERE workspace_id=? AND project_id=?",workspace,project);
        jdbc.update("DELETE FROM collaboration_grants WHERE workspace_id=? AND project_id=?",workspace,project);
        jdbc.update("DELETE FROM collaboration_previews WHERE workspace_id=? AND project_id=?",workspace,project);
        jdbc.update("DELETE FROM collaboration_publications WHERE workspace_id=? AND project_id=?",workspace,project);
        jdbc.update("DELETE FROM collaboration_member_uploads WHERE workspace_id=? AND project_id=?",workspace,project);
        jdbc.update("DELETE FROM collaboration_mock_logs WHERE workspace_id=? AND project_id=?",workspace,project);
        jdbc.update("DELETE FROM collaboration_mock_log_state WHERE workspace_id=? AND project_id=?",workspace,project);
        jdbc.update("DELETE FROM collaboration_publication_versions WHERE workspace_id=? AND project_id=?",workspace,project);
        jdbc.update("DELETE FROM collaboration_policy WHERE workspace_id=? AND project_id=?",workspace,project);
    }
    private void removeMockLogs(long workspace,long project,long publication){
        var ids=jdbc.queryForList("SELECT id FROM collaboration_mock_logs WHERE workspace_id=? AND project_id=? AND publication_id=? ORDER BY id",Long.class,workspace,project,publication);
        for(long id:ids)drop(workspace,project,Kind.LOG,id);
        jdbc.update("DELETE FROM collaboration_mock_logs WHERE workspace_id=? AND project_id=? AND publication_id=?",workspace,project,publication);
        jdbc.update("DELETE FROM collaboration_mock_log_state WHERE workspace_id=? AND project_id=? AND publication_id=?",workspace,project,publication);drop(workspace,project,Kind.LOG,-publication);
    }
    public long retain(long actor,long workspace,long project,StoredKey target,Owner owner){return transactions.execute(tx->{
        var policy=policies.getObject().publicationSnapshot(workspace,project);lockScope(workspace,project);lockProject(workspace,project);
        Long expiry=owner.expiresAt()==null?null:owner.expiresAt().toEpochMilli();
        if(owner.kind()==OwnerKind.CANDIDATE){var rows=jdbc.query("SELECT expires_at FROM collaboration_previews WHERE id=? AND workspace_id=? AND project_id=? FOR UPDATE",(row,index)->row.getTimestamp(1).toInstant().toEpochMilli(),owner.id(),workspace,project);if(rows.isEmpty())throw failure("collaboration_reference_owner_invalid");expiry=rows.getFirst();}
        if(owner.kind()==OwnerKind.GRANT)expiry=grants.getObject().referenceExpiry(workspace,project,target,owner.id());
        charge(workspace,project,target.kind(),target.id());
        long id=insert("collaboration_storage_references","workspace_id,project_id,target_kind,target_id,owner_kind,owner_id,expires_at",new Object[]{workspace,project,target.kind().name(),target.id(),owner.kind().name(),owner.id(),expiry});
        put(workspace,project,Kind.REFERENCE,id,0,encode(new ReferenceMetadata(target.id(),target.kind(),owner.kind(),owner.id(),expiry)),0,owner.kind()==OwnerKind.ACTIVE_OPERATION?0:frame(Kind.REFERENCE));
        jdbc.update("UPDATE collaboration_storage_objects SET inactive_since=NULL WHERE workspace_id=? AND project_id=? AND kind=? AND object_id=?",workspace,project,target.kind().name(),target.id());
        if(owner.kind()!=OwnerKind.ACTIVE_OPERATION)audit(actor,workspace,project,Kind.REFERENCE,id,Action.REFERENCE_ACQUIRED,Reason.USER_COMMAND,null);capacity(workspace,project,policy);return id;
    });}
    public void release(long actor,long id){transactions.executeWithoutResult(tx->{
        var initial=refs(" WHERE id=?",id);if(initial.isEmpty())return;var ref=initial.getFirst();policies.getObject().publicationSnapshot(ref.workspace(),ref.project());lockScope(ref.workspace(),ref.project());lockProject(ref.workspace(),ref.project());
        var current=refs(" WHERE id=? FOR UPDATE",id);if(!current.isEmpty())removeReference(actor,current.getFirst(),time.now().toEpochMilli());
    });}
    private List<Ref> refs(String where,Object... args){return jdbc.query("SELECT * FROM collaboration_storage_references"+where,(row,index)->new Ref(row.getLong("id"),row.getLong("workspace_id"),row.getLong("project_id"),Kind.valueOf(row.getString("target_kind")),row.getLong("target_id"),OwnerKind.valueOf(row.getString("owner_kind")),row.getLong("owner_id"),row.getObject("expires_at",Long.class)),args);}
    private long end(Ref ref){
        long expiry=ref.expiry()==null?Long.MAX_VALUE:ref.expiry();
        if(ref.ownerKind()==OwnerKind.GRANT){
            var ends=jdbc.query("SELECT expires_at,ended_at FROM collaboration_grants WHERE id=? AND workspace_id=? AND project_id=?",(r,i)->Math.min(r.getLong(1),Optional.ofNullable(r.getObject(2,Long.class)).orElse(Long.MAX_VALUE)),ref.ownerId(),ref.workspace(),ref.project());
            return ends.isEmpty()?expiry:Math.min(expiry,ends.getFirst());
        }
        if(ref.ownerKind()!=OwnerKind.CANDIDATE)return expiry;
        var rows=jdbc.query("SELECT state,terminal_at_epoch_ms FROM collaboration_previews WHERE id=? AND workspace_id=? AND project_id=?",(row,index)->row.getString(1).equals("pending")?expiry:Math.min(expiry,Optional.ofNullable(row.getObject(2,Long.class)).orElse(expiry)),ref.ownerId(),ref.workspace(),ref.project());return rows.isEmpty()?expiry:rows.getFirst();
    }
    private void removeReference(Long actor,Ref ref,long ended){
        if(ref.ownerKind()!=OwnerKind.ACTIVE_OPERATION){
            consume(ref.workspace(),ref.project(),Kind.REFERENCE,ref.id());
            audit(actor,ref.workspace(),ref.project(),Kind.REFERENCE,ref.id(),Action.REFERENCE_RELEASED,Reason.USER_COMMAND,null);
        }
        jdbc.update("DELETE FROM collaboration_storage_references WHERE id=?",ref.id());
        drop(ref.workspace(),ref.project(),Kind.REFERENCE,ref.id());
        long now=time.now().toEpochMilli(),lastEnd=ended;
        boolean active=false;
        // The batch limits mutations, not the reference facts needed to anchor this object's retention.
        for(var other:refs(" WHERE workspace_id=? AND project_id=? AND target_kind=? AND target_id=?",ref.workspace(),ref.project(),ref.targetKind().name(),ref.targetId())){
            long actualEnd=end(other);
            if(actualEnd>now)active=true;
            else lastEnd=Math.max(lastEnd,actualEnd);
        }
        if(!active){
            jdbc.update("UPDATE collaboration_storage_objects SET inactive_since=CASE WHEN inactive_since IS NULL OR inactive_since<? THEN ? ELSE inactive_since END WHERE workspace_id=? AND project_id=? AND kind=? AND object_id=?",
                lastEnd,lastEnd,ref.workspace(),ref.project(),ref.targetKind().name(),ref.targetId());
        }
    }
    public int cleanup(long workspace,long project){
        return transactions.execute(tx->{
            var policy=policies.getObject().publicationSnapshot(workspace,project);
            lockScope(workspace,project);
            lockProject(workspace,project);
            long now=time.now().toEpochMilli();
            int remaining=Math.toIntExact(number(policy,CLEANUP_BATCH_SIZE));

            // Release expired owners before considering retained bodies.
            int count=grants.getObject().expireDue(null,workspace,project,null,remaining,policy);
            remaining-=count;
            if(remaining==0)return count;
            var references=refs(" WHERE workspace_id=? AND project_id=? ORDER BY target_id,id FETCH FIRST "+remaining+" ROWS ONLY FOR UPDATE",workspace,project);
            for(var ref:references){
                long ended=end(ref);
                if(ended<=now){removeReference(null,ref,ended);remaining--;count++;}
            }
            if(remaining==0)return count;

            // Mock hit observations keep their separate charged retention path.
            var dueLogs=jdbc.queryForList("SELECT id,publication_id FROM collaboration_mock_logs WHERE workspace_id=? AND project_id=? AND created_at_epoch_ms<=? ORDER BY id FETCH FIRST "+remaining+" ROWS ONLY",workspace,project,now-number(policy,MOCK_LOG_RETENTION_MS));
            var byPublication=new TreeMap<Long,List<Long>>();
            for(var row:dueLogs)byPublication.computeIfAbsent(((Number)row.get("publication_id")).longValue(),ignored->new ArrayList<>()).add(((Number)row.get("id")).longValue());
            for(var entry:byPublication.entrySet())discardMockLogs(workspace,project,entry.getKey(),entry.getValue(),policy);
            remaining-=dueLogs.size();
            count+=dueLogs.size();
            if(remaining==0)return count;

            // Management authority evidence never takes the access-detail retention.
            String dueObjects="SELECT kind,object_id FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND ("
                +"(kind='PREVIEW' AND object_id IN (SELECT id FROM collaboration_previews WHERE expires_at<=? AND (receipt_retire_at_epoch_ms IS NULL OR receipt_retire_at_epoch_ms<=?))) "
                +"OR (kind='ARTIFACT' AND inactive_since<=?) "
                +"OR (kind='UPLOAD' AND object_id IN (SELECT id FROM collaboration_member_uploads WHERE expires_at_epoch_ms<=?)) "
                +"OR (kind='AUDIT' AND object_id IN (SELECT id FROM collaboration_management_audit WHERE (retention_class='management' AND created_at_epoch_ms<=?) OR (retention_class='access' AND created_at_epoch_ms<=?)))) "
                +"ORDER BY object_id,kind FETCH FIRST "+remaining+" ROWS ONLY FOR UPDATE";
            var rows=jdbc.queryForList(dueObjects,workspace,project,new Timestamp(now),now,
                now-number(policy,INACTIVE_ARTIFACT_RETENTION_MS),now,
                now-number(policy,MANAGEMENT_AUDIT_RETENTION_MS),now-number(policy,ACCESS_AUDIT_RETENTION_MS));
            for(var row:rows){
                Kind kind=Kind.valueOf((String)row.get("kind"));
                long id=((Number)row.get("object_id")).longValue();
                if(kind==Kind.AUDIT){
                    jdbc.update("DELETE FROM collaboration_management_audit WHERE id=?",id);
                    drop(workspace,project,kind,id);
                }else if(kind==Kind.ARTIFACT||kind==Kind.UPLOAD){
                    if(refs(" WHERE workspace_id=? AND project_id=? AND target_kind=? AND target_id=?",workspace,project,kind.name(),id).stream().anyMatch(ref->end(ref)>now))continue;
                    consume(workspace,project,kind,id);
                    jdbc.update("DELETE FROM "+(kind==Kind.UPLOAD?"collaboration_member_uploads":"collaboration_publications")+" WHERE id=?",id);
                    if(kind==Kind.ARTIFACT)removeMockLogs(workspace,project,id);
                    drop(workspace,project,kind,id);
                    audit(null,workspace,project,kind,id,kind==Kind.UPLOAD?Action.UPLOAD_RECLAIMED:Action.ARTIFACT_RECLAIMED,kind==Kind.UPLOAD?Reason.EXPIRED:Reason.INACTIVE,null);
                }else{
                    var preview=jdbc.queryForMap("SELECT actor_id,candidate_digest,COALESCE(source_kind,purpose,'document') AS source_kind,expires_at,receipt_retire_at_epoch_ms FROM collaboration_previews WHERE id=? FOR UPDATE",id);
                    if(preview.get("receipt_retire_at_epoch_ms")!=null){
                        jdbc.update("DELETE FROM collaboration_previews WHERE id=?",id);
                        drop(workspace,project,kind,id);
                    }else{
                        consume(workspace,project,kind,id);
                        long retire=stamp(preview.get("expires_at"))+number(policy,INACTIVE_ARTIFACT_RETENTION_MS);
                        if(retire<=now){
                            jdbc.update("DELETE FROM collaboration_previews WHERE id=?",id);
                            drop(workspace,project,kind,id);
                        }else{
                            jdbc.update("UPDATE collaboration_previews SET state='expired',body=NULL,source_json=NULL,access_json=NULL,policy_json=NULL,receipt_retire_at_epoch_ms=? WHERE id=?",retire,id);
                            put(workspace,project,kind,id,0,encode(new Receipt(workspace,project,id,((Number)preview.get("actor_id")).longValue(),(String)preview.get("candidate_digest"),(String)preview.get("source_kind"),"expired",retire)),0,0);
                        }
                        audit(null,workspace,project,kind,id,Action.PREVIEW_RECLAIMED,Reason.EXPIRED,null);
                    }
                }
                count++;
            }
            return count;
        });
    }
    private void lockProject(long workspace,long project){jdbc.queryForList("SELECT id FROM projects WHERE workspace_id=? AND id=? FOR UPDATE",workspace,project);}
    private long[] scope(Kind kind,long id){String table=kind==Kind.PREVIEW?"collaboration_previews":"collaboration_publications";return jdbc.queryForObject("SELECT workspace_id,project_id FROM "+table+" WHERE id=?",(row,index)->new long[]{row.getLong(1),row.getLong(2)},id);}
    private long[] observe(Kind kind,long id,Long reservation){
        String table=kind==Kind.PREVIEW?"collaboration_previews":"collaboration_publications";
        String columns=kind==Kind.PREVIEW?"workspace_id,project_id,actor_id,state,source_json,access_json,policy_json,candidate_digest,created_at,expires_at,operation_deadline":"workspace_id,project_id,actor_id,preview_id,version,publication_intent_id,kind,trust,digest,source_json,policy_json,format_version,created_at,revision,enabled";
        var f=jdbc.queryForMap("SELECT "+columns+" FROM "+table+" WHERE id=?",id);long ws=((Number)f.get("workspace_id")).longValue(),project=((Number)f.get("project_id")).longValue();
        long length=jdbc.queryForObject("SELECT OCTET_LENGTH(body) FROM "+table+" WHERE id=?",Long.class,id);long pending=kind==Kind.PREVIEW&&"pending".equals(f.get("state"))?1:0;
        var metadata=new StoredMetadata(ws,project,id,kind,((Number)f.get("actor_id")).longValue(),(String)f.get("state"),(String)f.get("source_json"),(String)f.get("access_json"),(String)f.get("policy_json"),(String)f.get(kind==Kind.PREVIEW?"candidate_digest":"digest"),
            stamp(f.get("created_at")),kind==Kind.PREVIEW?stamp(f.get("expires_at")):null,kind==Kind.PREVIEW?((Number)f.get("operation_deadline")).longValue():null,kind==Kind.ARTIFACT?((Number)f.get("preview_id")).longValue():null,kind==Kind.ARTIFACT?((Number)f.get("version")).longValue():null,(String)f.get("publication_intent_id"),(String)f.get("trust"),kind==Kind.ARTIFACT?((Number)f.get("format_version")).intValue():null);
        String encoded=kind==Kind.ARTIFACT?encode(new GateMetadata(encode(metadata),((Number)f.get("revision")).longValue(),Boolean.TRUE.equals(f.get("enabled")))):encode(metadata);
        put(ws,project,kind,id,length,encoded,pending,reservation==null?charge(ws,project,kind,id).reserved():reservation);return new long[]{ws,project};
    }
    private long stamp(Object value){return value instanceof java.time.OffsetDateTime timestamp?timestamp.toInstant().toEpochMilli():((Timestamp)value).toInstant().toEpochMilli();}
    private Charge charge(long workspace,long project,Kind kind,long id){return jdbc.query("SELECT body_bytes,metadata_bytes,reserved_bytes FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind=? AND object_id=? FOR UPDATE",(row,index)->new Charge(row.getLong(1),row.getLong(2),row.getLong(3)),workspace,project,kind.name(),id).stream().findFirst().orElse(new Charge(0,0,0));}
    private void put(long workspace,long project,Kind kind,long id,long body,String metadata,long pending,long reserved){
        var old=charge(workspace,project,kind,id);long length=metadata.getBytes(StandardCharsets.UTF_8).length;
        jdbc.update("DELETE FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind=? AND object_id=?",workspace,project,kind.name(),id);
        jdbc.update("INSERT INTO collaboration_storage_objects(workspace_id,project_id,kind,object_id,body_bytes,metadata_json,metadata_bytes,reserved_bytes,pending) VALUES(?,?,?,?,?,?,?,?,?)",workspace,project,kind.name(),id,body,metadata,length,reserved,pending);
        delta(workspace,project,body+length-old.actual(),reserved-old.reserved());
    }
    private void drop(long workspace,long project,Kind kind,long id){var old=charge(workspace,project,kind,id);jdbc.update("DELETE FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind=? AND object_id=?",workspace,project,kind.name(),id);delta(workspace,project,-old.actual(),-old.reserved());}
    private void delta(long workspace,long project,long actual,long reserved){jdbc.update("UPDATE collaboration_storage_accounts SET actual_bytes=actual_bytes+?,reserved_bytes=reserved_bytes+? WHERE (workspace_id=0 AND project_id=0) OR (workspace_id=? AND project_id=?)",actual,reserved,workspace,project);}
    private long frame(Kind kind){long maximum=0;for(Action action:Action.values())for(Reason reason:Reason.values())maximum=Math.max(maximum,encode(new AuditEvent(action,reason,Long.MIN_VALUE,Long.MIN_VALUE,Long.MIN_VALUE,kind,Long.MIN_VALUE,Long.MIN_VALUE,Long.MIN_VALUE)).getBytes(StandardCharsets.UTF_8).length);return maximum;}
    private void consume(long ws,long project,Kind kind,long id){long frame=frame(kind);var old=charge(ws,project,kind,id);if(old.reserved()<frame)throw failure("collaboration_audit_reservation_exhausted");jdbc.update("UPDATE collaboration_storage_objects SET reserved_bytes=reserved_bytes-? WHERE workspace_id=? AND project_id=? AND kind=? AND object_id=?",frame,ws,project,kind.name(),id);delta(ws,project,0,-frame);}
    private void audit(Long actor,long workspace,long project,Kind kind,long object,Action action,Reason reason,Long revision){
        long now=time.now().toEpochMilli();String event=encode(new AuditEvent(action,reason,actor,workspace,project,kind,object,revision,now));long id=insert("collaboration_management_audit","workspace_id,project_id,event_json,created_at_epoch_ms",new Object[]{workspace,project,event,now});put(workspace,project,Kind.AUDIT,id,0,event,0,0);
    }
    private static ApiException failure(String code){return new ApiException(org.springframework.http.HttpStatus.CONFLICT,code,"协作存储额度、引用或审计预留不满足当前操作");}
    private String encode(Object value){try{return json.writeValueAsString(value);}catch(java.io.IOException problem){throw new IllegalStateException("Cannot encode finite collaboration storage metadata",problem);}}
    private long insert(String table,String columns,Object[] values){
        String marks=String.join(",",Collections.nCopies(values.length,"?"));if(ids.appAssigned()){long id=ids.nextId();var parameters=new ArrayList<Object>();parameters.add(id);parameters.addAll(Arrays.asList(values));jdbc.update("INSERT INTO "+table+"(id,"+columns+") VALUES(?,"+marks+")",parameters.toArray());return id;}
        var key=new GeneratedKeyHolder();jdbc.update(connection->{var statement=connection.prepareStatement("INSERT INTO "+table+"("+columns+") VALUES("+marks+")",new String[]{"id"});for(int index=0;index<values.length;index++)statement.setObject(index+1,values[index]);return statement;},key);return Objects.requireNonNull(key.getKey()).longValue();
    }
}
