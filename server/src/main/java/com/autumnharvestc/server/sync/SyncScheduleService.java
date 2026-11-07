package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.access.AccessRepo;
import com.autumnharvestc.server.access.Capability;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.execution.scheduling.*;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.jdbc.core.JdbcTemplate;
import com.autumnharvestc.server.access.ProjectAccessService;
import com.autumnharvestc.server.execution.ExecutionDtos.CredentialSelection;
import java.util.*;

/** A fixed, explicitly authorized source schedule. The public source contains no grant or secret. */
@Service
@Transactional
public class SyncScheduleService {
    private final SyncStorage storage;private final SyncRepo repo;private final SyncSourceService sources;
    private final AccessRepo authority;private final SyncCheckMaterials materials;private final SyncPolicyService policies;
    private final ObjectMapper json;private final JdbcTemplate jdbc;private final ScheduleRuleCalculator calculator;private final ScheduleTimeSource time;
    private final AgentService agents;private final SyncDtos dtos;private final SyncScheduleProperties properties;
    @org.springframework.beans.factory.annotation.Autowired private ProjectAccessService access;
    @org.springframework.beans.factory.annotation.Autowired private org.springframework.beans.factory.ObjectProvider<SyncCheckWorker> workers;
    @org.springframework.beans.factory.annotation.Autowired private SchedulerProperties scheduler;
    @org.springframework.beans.factory.annotation.Autowired private ScheduleControlService control;
    public SyncScheduleService(SyncStorage storage,SyncRepo repo,SyncSourceService sources,AccessRepo authority,SyncCheckMaterials materials,SyncPolicyService policies,ObjectMapper json,JdbcTemplate jdbc,ScheduleRuleCalculator calculator,ScheduleTimeSource time,AgentService agents,SyncDtos dtos,SyncScheduleProperties properties){this.storage=storage;this.repo=repo;this.sources=sources;this.authority=authority;this.materials=materials;this.policies=policies;this.json=json;this.jdbc=jdbc;this.calculator=calculator;this.time=time;this.agents=agents;this.dtos=dtos;this.properties=properties;}
    ObjectNode grant(long ws,long project,String source){return jdbc.query("SELECT schedule_json FROM sync_sources WHERE workspace_id=? AND project_id=? AND id=? AND deleted=FALSE",(r,n)->{try{return r.getString(1)==null?json.createObjectNode().put("generation","0").put("enabled",false):(ObjectNode)json.readTree(r.getString(1));}catch(Exception error){throw new IllegalStateException("Invalid synchronization schedule metadata",error);}},ws,project,source).stream().findFirst().orElseThrow(()->SyncRepo.missing("sync_source_not_found"));}
    void write(long ws,long project,String source,ObjectNode value){storage.changed(ws,project);jdbc.update("UPDATE sync_sources SET schedule_json=? WHERE workspace_id=? AND project_id=? AND id=? AND deleted=FALSE",value.toString(),ws,project,source);}
    public JsonNode read(UserAccount actor,String ws,String project,String source){var current=sources.read(actor,ws,project,source);return view(Long.parseLong(ws),Long.parseLong(project),current,grant(Long.parseLong(ws),Long.parseLong(project),source));}
    private ObjectNode view(long ws,long project,JsonNode source,ObjectNode grant){var result=json.createObjectNode().put("formatVersion",1).put("sourceId",source.path("id").asText()).put("sourceRevision",source.path("revision").asText()).put("generation",grant.path("generation").asText()).put("enabled",grant.path("enabled").asBoolean()).put("subjectUserId",grant.path("subjectUserId").isTextual()?grant.path("subjectUserId").asText():null).put("pausedReasonCode",grant.path("pausedReasonCode").isTextual()?grant.path("pausedReasonCode").asText():null).putNull("nextPlannedAtUtc").put("nextPlannedState","not-calculated");result.set("rule",source.path("schedule").path("rule"));result.set("lastOccurrence",lastOccurrence(ws,project,source.path("id").asText(),grant.path("generation").asText()));return result;}
    private JsonNode lastOccurrence(long ws,long project,String source,String generation){
        return jdbc.query("SELECT id,planned_at_utc,state,check_id,details_json FROM sync_occurrences WHERE workspace_id=? AND project_id=? AND source_id=? AND generation=? ORDER BY planned_at_utc DESC,id DESC FETCH FIRST 1 ROW ONLY",(row,index)->{
            JsonNode details;try{details=json.readTree(row.getString(5));}catch(Exception error){throw new IllegalStateException("Invalid synchronization occurrence metadata",error);}
            String association=row.getString(3),checkId=row.getString(4);var check=checkId==null?Optional.<SyncRepo.Check>empty():repo.check(ws,project,checkId);
            var summary=json.createObjectNode().put("occurrenceId",row.getString(1)).put("plannedAtUtc",row.getString(2)).put("state",association.equals("detached")?association:check.map(SyncRepo.Check::state).orElse(association)).put("associationState",association).put("checkId",checkId).put("checkState",check.map(SyncRepo.Check::state).orElse(null)).put("coalesced",Set.of("coalesced","detached").contains(association));
            for(String field:List.of("coalescedDueCount","missedBeforeWindow","evaluatedAfterUtc","evaluatedThroughUtc","requestedSubjectUserId","executedSubjectUserId"))summary.set(field,details.has(field)?details.get(field):json.nullNode());return summary;
        },ws,project,source,generation).stream().findFirst().map(value->(JsonNode)value).orElseGet(json::nullNode);
    }
    public JsonNode save(UserAccount actor,String ws,String project,String source,JsonNode request){
        long w=Long.parseLong(ws),p=Long.parseLong(project);storage.lock(w,p);authority.lockGate();agents.requireCapability(actor,ws,project,Capability.SYNC_MANAGE);agents.requireCapability(actor,ws,project,Capability.SYNC_CHECK);var current=(ObjectNode)sources.read(actor,ws,project,source).deepCopy();var old=grant(w,p,source);
        fields(request,"formatVersion","expectedSourceRevision","expectedGeneration","enabled","rule");
        if(!request.path("enabled").isBoolean()||!revision(request.path("expectedSourceRevision"))||!revision(request.path("expectedGeneration")))throw SyncDtos.invalid();
        if(!request.path("expectedSourceRevision").equals(current.path("revision")))throw SyncDtos.conflict("SYNC_SOURCE_REVISION_CHANGED");
        if(!request.path("expectedGeneration").equals(old.path("generation")))throw SyncDtos.conflict("SYNC_SCHEDULE_GENERATION_CHANGED");
        rule(current,request.path("rule"),time.now());
        cancelOwned(w,p,source,old.path("generation").asText());
        current.put("revision",SyncDtos.next(current.path("revision").asText()));current.set("schedule",json.createObjectNode().put("enabled",request.path("enabled").asBoolean()).set("rule",request.path("rule")));repo.saveSource(w,p,current);
        var next=json.createObjectNode().put("generation",SyncDtos.next(old.path("generation").asText())).put("sourceRevision",current.path("revision").asText()).put("enabled",request.path("enabled").asBoolean()).put("subjectUserId",String.valueOf(actor.id())).put("syncCheckEpoch",String.valueOf(authority.syncCheckEpoch(w,p,actor.id()))).put("evaluatedThroughUtc",time.now().toString());
        if(request.path("enabled").asBoolean()){var effective=policies.requireEffective(w,p);next.set("materials",json.valueToTree(materials.capture(w,p,current,effective.path("deploymentLimits").path("maxWireBytes").asLong()-effective.path("deploymentLimits").path("envelopeReserveBytes").asLong())));}else next.set("materials",json.createObjectNode());write(w,p,source,next);return view(w,p,current,next);
    }
    public JsonNode preview(UserAccount actor,String ws,String project,String source,JsonNode input){var current=sources.read(actor,ws,project,source);fields(input,"formatVersion","rule","afterUtc");if(!input.path("afterUtc").isTextual())throw SyncDtos.invalid();return json.valueToTree(rule(current,input.path("rule"),ScheduleRuleCalculator.instant(input.path("afterUtc").asText())));}
    private ScheduleDtos.Preview rule(JsonNode source,JsonNode rule,java.time.Instant after){var copy=(ObjectNode)source.deepCopy();copy.set("schedule",json.createObjectNode().put("enabled",true).set("rule",rule));dtos.require("source",copy);return calculator.preview(json.convertValue(rule,ScheduleDtos.Rule.class),after,properties.getMinIntervalMs(),properties.getEvaluationMaxCandidates());}
    static boolean revision(JsonNode value){return value.isTextual()&&value.asText().matches("(?:0|[1-9][0-9]*)");}
    static void fields(JsonNode input,String... names){if(input==null||!input.isObject()||input.size()!=names.length||!input.path("formatVersion").isIntegralNumber()||!input.path("formatVersion").asText().equals("1"))throw SyncDtos.invalid();for(String name:names)if(!input.has(name))throw SyncDtos.invalid();}
    String invalidReason(long ws,long project,JsonNode source,ObjectNode grant){
        if(!grant.path("enabled").asBoolean())return "cancelled";
        if(!source.path("schedule").path("enabled").asBoolean()||!source.path("revision").equals(grant.path("sourceRevision")))return "source-revision-changed";
        long subject=Long.parseLong(grant.path("subjectUserId").asText());
        if(!access.resolve(subject,ws,project).capabilities().contains(Capability.SYNC_CHECK)||!String.valueOf(authority.syncCheckEpoch(ws,project,subject)).equals(grant.path("syncCheckEpoch").asText()))return "authorization-changed";
        Map<String,CredentialSelection> selected=json.convertValue(grant.path("materials"),new com.fasterxml.jackson.core.type.TypeReference<Map<String,CredentialSelection>>(){});
        return materials.current(ws,project,selected)?null:"material-changed";
    }
    void pause(long ws,long project,String source,String generation,String reason){var current=grant(ws,project,source);if(!current.path("generation").asText().equals(generation)||!current.path("enabled").asBoolean())return;current.put("enabled",false).put("pausedReasonCode",reason);write(ws,project,source,current);cancelOwned(ws,project,source,generation);}
    void requireCheckCurrent(long ws,long project,SyncRepo.Check check){requireCheckCurrent(ws,project,check,null);}
    void requireCheckCurrent(long ws,long project,SyncRepo.Check check,JsonNode source){if(!check.details().has("scheduleGeneration"))return;if(!"embedded".equals(scheduler.getMode())||!"embedded".equals(control.read().mode())||!check.details().path("schedulerGeneration").asText().equals(control.read().generation()))throw new SyncCheckService.Invalidated("cancelled");var grant=grant(ws,project,check.source());if(!check.details().path("scheduleGeneration").equals(grant.path("generation")))throw new SyncCheckService.Invalidated("authorization-changed");String reason=invalidReason(ws,project,source==null?repo.sourceState(ws,project,check.source()).source():source,grant);if(reason!=null)throw new SyncCheckService.Invalidated(reason);}
    void pauseAfterFailure(long ws,long project,SyncRepo.Check check,String terminalReason){if(!check.details().has("scheduleGeneration")||repo.source(ws,project,check.source()).isEmpty())return;var grant=grant(ws,project,check.source());if(!check.details().path("scheduleGeneration").equals(grant.path("generation")))return;String reason=invalidReason(ws,project,repo.sourceState(ws,project,check.source()).source(),grant);if(reason==null&&"storage-limit".equals(terminalReason))reason=terminalReason;if(reason!=null)pause(ws,project,check.source(),grant.path("generation").asText(),reason);}
    private void cancelOwned(long ws,long project,String source,String generation){
        var ids=new ArrayList<String>();for(var id:jdbc.queryForList("SELECT c.id FROM sync_checks c JOIN sync_occurrences o ON o.workspace_id=c.workspace_id AND o.project_id=c.project_id AND o.check_id=c.id WHERE o.workspace_id=? AND o.project_id=? AND o.source_id=? AND o.generation=? AND o.state='submitted' AND c.state IN ('queued','running','waiting','cancelling')",String.class,ws,project,source,generation)){var check=repo.check(ws,project,id).orElseThrow();if(!check.details().path("scheduleGeneration").asText().equals(generation))continue;var details=(ObjectNode)check.details().deepCopy();boolean queued=Set.of("queued","waiting").contains(check.state());details.remove("snapshot");details.put("reasonCode",queued?"cancelled":"cancel-requested");if(queued)details.put("completedAtMs",System.currentTimeMillis());repo.updateCheck(ws,project,id,queued?"cancelled":"cancelling",details);if(!queued)ids.add(id);}
        storage.changed(ws,project);jdbc.update("UPDATE sync_occurrences SET state='detached' WHERE workspace_id=? AND project_id=? AND source_id=? AND generation=? AND state='coalesced'",ws,project,source,generation);
        if(!ids.isEmpty())org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(new org.springframework.transaction.support.TransactionSynchronization(){@Override public void afterCommit(){for(String id:ids)workers.getObject().cancel(String.valueOf(ws),String.valueOf(project),id);}});
    }
}
