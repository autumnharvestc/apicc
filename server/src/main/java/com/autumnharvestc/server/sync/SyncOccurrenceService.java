package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.access.AccessRepo;
import com.autumnharvestc.server.execution.scheduling.*;
import com.autumnharvestc.server.execution.assets.ProjectAssetsService;
import com.autumnharvestc.server.store.UserRepo;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import java.time.Instant;
import java.util.UUID;
import java.nio.charset.StandardCharsets;
import com.autumnharvestc.server.collaboration.runtime.RuntimeProtocol;
import com.autumnharvestc.server.access.ProjectAccessService;
import com.autumnharvestc.server.access.Capability;
/** Durable source occurrence orchestration; never submits a test Job. */
@Service
public class SyncOccurrenceService {
    record Scope(long workspace,long project,String source) {}
    private final SyncScheduleService schedules;private final SyncCheckService checks;private final SyncStorage storage;private final SyncRepo repo;
    private final JdbcTemplate jdbc;private final UserRepo users;private final ObjectMapper json;private final ScheduleTimeSource time;
    private final ScheduleRuleCalculator calculator;private final SyncScheduleProperties properties;private final ProjectAssetsService assets;private final AccessRepo authority;private final TransactionTemplate tx;
    private final SyncPolicyService policies;private final ProjectAccessService access;
    private Scope cursor=new Scope(0,0,"");
    @org.springframework.beans.factory.annotation.Autowired private SchedulerProperties scheduler;
    @org.springframework.beans.factory.annotation.Autowired private ScheduleControlService control;
    private static final org.slf4j.Logger log=org.slf4j.LoggerFactory.getLogger(SyncOccurrenceService.class);
    public SyncOccurrenceService(SyncScheduleService schedules,SyncCheckService checks,SyncStorage storage,SyncRepo repo,JdbcTemplate jdbc,UserRepo users,ObjectMapper json,ScheduleTimeSource time,ScheduleRuleCalculator calculator,SyncScheduleProperties properties,ProjectAssetsService assets,AccessRepo authority,PlatformTransactionManager manager,SyncPolicyService policies,ProjectAccessService access){this.schedules=schedules;this.checks=checks;this.storage=storage;this.repo=repo;this.jdbc=jdbc;this.users=users;this.json=json;this.time=time;this.calculator=calculator;this.properties=properties;this.assets=assets;this.authority=authority;this.tx=new TransactionTemplate(manager);this.policies=policies;this.access=access;}
    private java.util.List<Scope> scan(){return jdbc.query("SELECT workspace_id,project_id,id FROM sync_sources WHERE deleted=FALSE AND schedule_json IS NOT NULL AND (workspace_id>? OR (workspace_id=? AND project_id>?) OR (workspace_id=? AND project_id=? AND id>?)) ORDER BY workspace_id,project_id,id FETCH FIRST ? ROWS ONLY",(r,n)->new Scope(r.getLong(1),r.getLong(2),r.getString(3)),cursor.workspace(),cursor.workspace(),cursor.project(),cursor.workspace(),cursor.project(),cursor.source(),properties.getScanBatchSize());}
    public synchronized void tick(){
        if(!"embedded".equals(scheduler.getMode())||!"embedded".equals(control.read().mode()))return;
        var scopes=scan();if(scopes.isEmpty()){cursor=new Scope(0,0,"");scopes=scan();}int claims=0;
        for(var scope:scopes){cursor=scope;var observed=new java.util.concurrent.atomic.AtomicReference<String>();
            try{if(Boolean.TRUE.equals(tx.execute(status->trigger(scope,observed)))&&++claims>=properties.getClaimBatchSize())break;}
            catch(RuntimeException error){
                String code=error instanceof com.autumnharvestc.server.core.ApiException api?api.getCode():error.getClass().getSimpleName();
                String reason=switch(code){case "collaboration_storage_limit"->"storage-limit";case "SYNC_POLICY_INVALID"->"policy-changed";case "schedule-evaluation-limit","schedule-interval-too-short"->"rule-invalid";default->null;};
                if(reason!=null&&observed.get()!=null)try{tx.executeWithoutResult(status->{storage.globalGate();authority.lockGate();if(repo.source(scope.workspace(),scope.project(),scope.source()).isEmpty())return;storage.lock(scope.workspace(),scope.project());schedules.pause(scope.workspace(),scope.project(),scope.source(),observed.get(),reason);});}catch(RuntimeException settling){log.warn("Synchronization schedule pause failed for {}/{}/{}: {}",scope.workspace(),scope.project(),scope.source(),settling.getClass().getSimpleName());}
                log.warn("Synchronization schedule scan failed for {}/{}/{}: {}",scope.workspace(),scope.project(),scope.source(),code);
            }
        }
    }
    private boolean trigger(Scope scope,java.util.concurrent.atomic.AtomicReference<String> observed){
        long w=scope.workspace(),p=scope.project();storage.globalGate();authority.lockGate();if(jdbc.queryForObject("SELECT COUNT(*) FROM projects WHERE workspace_id=? AND id=?",Integer.class,w,p)==0||repo.source(w,p,scope.source()).isEmpty())return false;storage.lock(w,p);repo.lockWorkspace(w);
        var grant=schedules.grant(w,p,scope.source());if(!grant.path("enabled").asBoolean())return false;
        observed.set(grant.path("generation").asText());
        var invalid=schedules.invalidReason(w,p,repo.sourceState(w,p,scope.source()).source(),grant);if(invalid!=null){schedules.pause(w,p,scope.source(),grant.path("generation").asText(),invalid);return false;}
        var state=repo.sourceState(w,p,scope.source());var source=state.source();var now=time.now();var previous=Instant.parse(grant.path("evaluatedThroughUtc").asText());if(!now.isAfter(previous))return false;
        var floor=now.minusMillis(properties.getEvaluationWindowMs());var after=previous.isBefore(floor)?floor:previous;
        var due=calculator.boundedDue(json.convertValue(source.path("schedule").path("rule"),ScheduleDtos.Rule.class),after,now,properties.getMinIntervalMs(),properties.getEvaluationMaxCandidates());if(due.candidates().isEmpty()){grant.put("evaluatedThroughUtc",now.toString());schedules.write(w,p,scope.source(),grant);return false;}
        var at=due.candidates().getLast().plannedAtUtc();String key=RuntimeProtocol.digestJson(json.createArrayNode().add("apicc-sync-occurrence-v1").add(scope.source()).add(grant.path("generation").asText()).add(at));String id=UUID.nameUUIDFromBytes(key.getBytes(StandardCharsets.UTF_8)).toString();
        if(jdbc.queryForObject("SELECT COUNT(*) FROM sync_occurrences WHERE workspace_id=? AND project_id=? AND trigger_key=?",Integer.class,w,p,key)>0)return false;
        int count=jdbc.queryForObject("SELECT COUNT(*) FROM sync_occurrences WHERE workspace_id=? AND project_id=?",Integer.class,w,p);if(count>=properties.getMaxOccurrencesPerProject()){
            var removable=jdbc.queryForList("SELECT o.id FROM sync_occurrences o JOIN sync_checks c ON c.workspace_id=o.workspace_id AND c.project_id=o.project_id AND c.id=o.check_id WHERE o.workspace_id=? AND o.project_id=? AND c.state IN ('succeeded','failed','cancelled','lost') ORDER BY o.created_at,o.id FETCH FIRST ? ROWS ONLY",String.class,w,p,count-properties.getMaxOccurrencesPerProject()+1);
            for(String remove:removable){storage.changed(w,p);jdbc.update("DELETE FROM sync_occurrences WHERE workspace_id=? AND project_id=? AND id=?",w,p,remove);count--;}
            if(count>=properties.getMaxOccurrencesPerProject()){schedules.pause(w,p,scope.source(),grant.path("generation").asText(),"occurrence-capacity");return false;}
        }
        if(grant.hasNonNull("lastPlannedAtUtc"))calculator.requireInterval(Instant.parse(grant.path("lastPlannedAtUtc").asText()),Instant.parse(at),properties.getMinIntervalMs());
        var occurrence=json.createObjectNode().put("evaluatedAfterUtc",after.toString()).put("evaluatedThroughUtc",now.toString()).put("coalescedDueCount",due.candidates().size()).put("missedBeforeWindow",previous.isBefore(floor)).put("requestedSubjectUserId",grant.path("subjectUserId").asText());
        storage.changed(w,p);jdbc.update("INSERT INTO sync_occurrences(workspace_id,project_id,id,source_id,generation,planned_at_utc,trigger_key,state,details_json) VALUES(?,?,?,?,?,?,?,'claimed',?)",w,p,id,scope.source(),grant.path("generation").asText(),at,key,occurrence.toString());
        var actor=users.findById(Long.parseLong(grant.path("subjectUserId").asText())).orElseThrow(SyncDtos::denied);var current=assets.get(actor,String.valueOf(w),String.valueOf(p));
        var active=repo.recentChecks(w,p,scope.source(),"active");
        if(!active.isEmpty()&&compatible(active.getFirst(),scope,state,grant,current)){
            var linked=active.getFirst();occurrence.put("executedSubjectUserId",String.valueOf(linked.actor()));jdbc.update("UPDATE sync_occurrences SET state='coalesced',check_id=?,details_json=? WHERE workspace_id=? AND project_id=? AND id=?",linked.id(),occurrence.toString(),w,p,id);
            grant.put("evaluatedThroughUtc",now.toString()).put("lastPlannedAtUtc",at);schedules.write(w,p,scope.source(),grant);return true;
        }
        var request=json.createObjectNode().put("formatVersion",1).put("intentId",id).put("expectedSourceRevision",source.path("revision").asText()).put("expectedAssetVersion",current.version());
        var accepted=checks.start(actor,String.valueOf(w),String.valueOf(p),scope.source(),request);var check=repo.check(w,p,accepted.path("checkId").asText()).orElseThrow();var details=(ObjectNode)check.details().deepCopy();details.put("scheduleGeneration",grant.path("generation").asText()).put("schedulerGeneration",control.read().generation()).put("occurrenceId",id);repo.updateCheck(w,p,check.id(),check.state(),details);
        occurrence.put("executedSubjectUserId",String.valueOf(actor.id()));jdbc.update("UPDATE sync_occurrences SET state='submitted',check_id=?,details_json=? WHERE workspace_id=? AND project_id=? AND id=?",check.id(),occurrence.toString(),w,p,id);
        grant.put("evaluatedThroughUtc",now.toString()).put("lastPlannedAtUtc",at);schedules.write(w,p,scope.source(),grant);
        return true;
    }
    private boolean compatible(SyncRepo.Check check,Scope scope,SyncRepo.SourceState state,ObjectNode grant,com.autumnharvestc.server.execution.ExecutionDtos.ProjectAssets current){
        if(!check.details().has("snapshot"))return false;
        var fixed=json.convertValue(check.details().path("snapshot"),SyncCheckService.Snapshot.class);var stamp=fixed.planPayload().path("stamp");
        if(fixed.deadlineAtMs()<=System.currentTimeMillis()||!access.resolve(check.actor(),scope.workspace(),scope.project()).capabilities().contains(Capability.SYNC_CHECK))return false;
        if(check.details().has("scheduleGeneration")&&!check.details().path("scheduleGeneration").equals(grant.path("generation")))return false;
        if(check.details().has("scheduleGeneration")&&!check.details().path("schedulerGeneration").asText().equals(control.read().generation()))return false;
        return grant.path("sourceRevision").equals(state.source().path("revision"))&&fixed.source().equals(state.source())
            &&stamp.path("mappingRevision").asText().equals(state.mappingRevision())&&stamp.path("baselineRevision").asText().equals(state.baselineRevision())
            &&stamp.path("authorizationGeneration").asText().equals(String.valueOf(authority.projectRevision(scope.workspace(),scope.project())))
            &&stamp.path("assetVersion").asText().equals(current.version())&&fixed.manifestHash().equals(current.manifestHash())
            &&RuntimeProtocol.digestJson(json.valueToTree(fixed.materials())).equals(RuntimeProtocol.digestJson(grant.path("materials")))
            &&RuntimeProtocol.digestJson(fixed.effective()).equals(RuntimeProtocol.digestJson(policies.requireEffective(scope.workspace(),scope.project())));
    }
}
