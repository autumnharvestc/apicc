package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.access.*;
import com.autumnharvestc.server.collaboration.runtime.*;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.execution.assets.ProjectAssetsService;
import com.autumnharvestc.server.store.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import java.util.*;

/** Short DB snapshots and commits surround private lock-free source/Core work. */
@Service
public class SyncCheckService {
    private final SyncStorage accounting;private final SyncRepo repo;private final SyncSourceService sources;private final SyncPolicyService policies;
    private final AgentService agents;private final AccessRepo authority;private final ProjectAssetsService assets;
    private final UserRepo users;private final ObjectMapper json;private final RuntimeProtocol protocol;
    private final TransactionTemplate tx;private final SyncCheckWorker worker;private final SyncDtos dtos;private final SyncCheckMaterials materialService;
    private final com.autumnharvestc.server.store.DatabaseUtcClock time;
    private final SyncCheckProperties ownership;
    @org.springframework.beans.factory.annotation.Autowired private org.springframework.beans.factory.ObjectProvider<SyncScheduleService> schedules;
    public SyncCheckService(SyncRepo repo,SyncSourceService sources,SyncPolicyService policies,AgentService agents,AccessRepo authority,ProjectAssetsService assets,UserRepo users,ObjectMapper json,RuntimeProtocol protocol,PlatformTransactionManager transactions,SyncCheckWorker worker,SyncDtos dtos,SyncCheckMaterials materialService,SyncStorage accounting,com.autumnharvestc.server.store.DatabaseUtcClock time,SyncCheckProperties ownership){this.accounting=accounting;this.repo=repo;this.sources=sources;this.policies=policies;this.authority=authority;this.agents=agents;this.assets=assets;this.users=users;this.json=json;this.protocol=protocol;this.tx=new TransactionTemplate(transactions);this.worker=worker;this.dtos=dtos;this.materialService=materialService;this.time=time;this.ownership=ownership;}
    private record Started(JsonNode response,boolean execute) {}
    public JsonNode start(UserAccount actor,String ws,String project,String sourceId,JsonNode input){
        String id=UUID.randomUUID().toString();
        var started=tx.execute(status->{
            accounting.lock(Long.parseLong(ws),Long.parseLong(project));authority.lockGate();repo.lockWorkspace(Long.parseLong(ws));
            agents.requireCapability(actor,ws,project,Capability.SYNC_CHECK);var source=sources.read(actor,ws,project,sourceId);
            dtos.require("checkRequest",input);long w=Long.parseLong(ws),p=Long.parseLong(project);
            String digest=dtos.digest("check",sourceId,input),intent=input.path("intentId").asText();var replay=repo.replay(w,p,intent,actor.id(),"check",digest);if(replay.isPresent())return new Started(replay.get(),false);
            if(!source.path("revision").equals(input.path("expectedSourceRevision")))throw SyncDtos.conflict("SYNC_SOURCE_REVISION_CHANGED");
            if(!assets.get(actor,ws,project).version().equals(input.path("expectedAssetVersion").asText()))throw SyncDtos.conflict("SYNC_PROJECT_ASSETS_CHANGED");
            var details=json.createObjectNode();details.set("request",input);details.put("reasonCode",(String)null);details.put("candidateId",(String)null);
            var policy=policies.requireEffective(w,p).path("policy");details.put("deadlineAtMs",System.currentTimeMillis()+policy.path(source.path("kind").asText().equals("url")?"urlDeadlineMs":"gitDeadlineMs").asLong());details.put("authorizationGeneration",String.valueOf(authority.projectRevision(w,p)));
            repo.createCheck(Long.parseLong(ws),Long.parseLong(project),id,sourceId,actor.id(),source.path("revision").asText(),details);
            var response=json.createObjectNode().put("formatVersion",1).put("checkId",id);repo.operation(w,p,intent,actor.id(),"check",digest,response);return new Started(response,true);
        });
        if(started.execute())worker.wake();return started.response();
    }
    public JsonNode read(UserAccount actor,String ws,String project,String id){return tx.execute(status->{sources.requireRead(actor,ws,project);return view(repo.check(Long.parseLong(ws),Long.parseLong(project),id).orElseThrow(()->SyncRepo.missing("sync_check_not_found")));});}
    ObjectNode view(SyncRepo.Check check){var result=json.createObjectNode().put("formatVersion",1).put("checkId",check.id()).put("sourceId",check.source()).put("state",check.state()).put("createdAtMs",check.createdAt());result.set("candidateId",check.details().path("candidateId"));result.set("reasonCode",check.details().path("reasonCode"));result.set("completedAtMs",check.details().has("completedAtMs")?check.details().get("completedAtMs"):json.nullNode());result.put("detailCode",check.details().path("detailCode").isTextual()?check.details().path("detailCode").asText():null);return result;}
    public JsonNode lookup(UserAccount actor,String ws,String project,String sourceId){return tx.execute(status->{sources.read(actor,ws,project,sourceId);long w=Long.parseLong(ws),p=Long.parseLong(project);var result=json.createObjectNode().put("formatVersion",1).put("sourceId",sourceId);for(var entry:Map.of("current","active","latestAttempt","any","latestSuccess","success").entrySet()){var rows=repo.recentChecks(w,p,sourceId,entry.getValue());result.set(entry.getKey(),rows.isEmpty()?json.nullNode():view(rows.getFirst()));}return result;});}
    public JsonNode cancel(UserAccount actor,String ws,String project,String id,JsonNode input){
        var response=tx.execute(status->{accounting.lock(Long.parseLong(ws),Long.parseLong(project));authority.lockGate();agents.requireCapability(actor,ws,project,Capability.SYNC_CHECK);var check=repo.check(Long.parseLong(ws),Long.parseLong(project),id).orElseThrow(()->SyncRepo.missing("sync_check_not_found"));
            dtos.require("checkCancelRequest",input);
            if(check.actor()!=actor.id())agents.requireProject(actor,ws,project,true);
            if(!terminal(check.state())){var details=(ObjectNode)check.details().deepCopy();boolean notStarted=Set.of("queued","waiting").contains(check.state());String state=notStarted?"cancelled":"cancelling";details.put("reasonCode",notStarted?"cancelled":"cancel-requested");details.remove("snapshot");if(notStarted){details.remove("snapshot");details.put("completedAtMs",System.currentTimeMillis());}repo.updateCheck(Long.parseLong(ws),Long.parseLong(project),id,state,details);return view(new SyncRepo.Check(check.id(),check.source(),check.actor(),state,details,check.createdAt()));}return view(check);
        });
        if(response.path("state").asText().equals("cancelling"))worker.cancel(ws,project,id);return response;
    }
    public record Snapshot(long ws,long project,String checkId,long actor,JsonNode source,JsonNode effective,JsonNode readPayload,JsonNode planPayload,long deadlineAtMs,String manifestHash,Map<String,com.autumnharvestc.server.execution.ExecutionDtos.CredentialSelection> materials) {}
    static final class Invalidated extends RuntimeException {final String reason;Invalidated(String reason){super(reason);this.reason=reason;}}
    Snapshot prepare(SyncRepo.Dispatch claim){return tx.execute(status->{
        String ws=claim.workspace(),project=claim.project(),id=claim.check();long w=Long.parseLong(ws),p=Long.parseLong(project);accounting.globalGate();authority.lockGate();requireOwnership(claim,false);accounting.lock(w,p);repo.lockWorkspace(w);requireOwnership(claim,true);var check=repo.check(w,p,id).orElseThrow(()->SyncRepo.missing("sync_check_not_found"));
        if(check.state().equals("cancelling"))throw new Invalidated("cancelled");
        if(terminal(check.state()))throw new Invalidated("runtime-uncertain");
        schedules.getObject().requireCheckCurrent(w,p,check);
        if(check.details().has("snapshot")){var fixed=json.convertValue(check.details().path("snapshot"),Snapshot.class);requireCurrent(fixed,claim);return fixed;}
        var actor=users.findById(check.actor()).orElseThrow(SyncDtos::denied);agents.requireCapability(actor,ws,project,Capability.SYNC_CHECK);
        var state=repo.sourceState(w,p,check.source());var source=state.source();var effective=policies.requireEffective(w,p);var policy=effective.path("policy");var current=assets.get(actor,ws,project);
        var selected=materialService.capture(w,p,source,effective.path("deploymentLimits").path("maxWireBytes").asLong()-effective.path("deploymentLimits").path("envelopeReserveBytes").asLong());
        if(!source.path("revision").equals(check.details().path("request").path("expectedSourceRevision")))throw new Invalidated("source-revision-changed");
        if(!current.version().equals(check.details().path("request").path("expectedAssetVersion").asText()))throw new Invalidated("project-assets-changed");
        long deadline=check.details().path("deadlineAtMs").asLong();if(deadline<=System.currentTimeMillis())throw new Invalidated("deadline-exceeded");String generation=String.valueOf(authority.projectRevision(w,p));if(!generation.equals(check.details().path("authorizationGeneration").asText()))throw new Invalidated("authorization-changed");
        var read=json.createObjectNode();var readInput=json.createObjectNode().put("formatVersion",1).put("deadlineAtMs",deadline);readInput.set("source",source);var readBudget=json.createObjectNode();for(String field:List.of("connectTimeoutMs","maxAttempts","maxSourceBytes","gitDiskThresholdBytes"))readBudget.set(field,policy.path(field));readInput.set("budget",readBudget);read.set("input",readInput);
        read.set("context",json.createObjectNode().put("workspaceId",ws).put("projectId",project).put("sourceRevision",source.path("revision").asText()).put("authorizationGeneration",generation).put("invocationId",id).put("projectConcurrency",policy.path("projectConcurrency").asInt()).put("hostConcurrency",policy.path("hostConcurrency").asInt()));
        var identity=json.createObjectNode().put("workspaceId",ws).put("projectId",project);identity.set("source",source);identity.set("registrations",json.valueToTree(selected));read.set("material",json.createObjectNode().put("leaseId",id).put("identity",RuntimeProtocol.digestJson(identity)));
        read.set("network",json.createObjectNode().put("kind","direct").put("revision","0"));
        var plan=json.createObjectNode().put("kind","source-read-online").put("allocationSeed","apicc-sync-id-v1");plan.set("source",source);
        plan.set("stamp",json.createObjectNode().put("formatVersion",1).put("kind","online").put("projectId",current.contractProjectId()).put("assetVersion",current.version()).put("sourceRevision",source.path("revision").asText()).put("mappingRevision",state.mappingRevision()).put("baselineRevision",state.baselineRevision()).put("authorizationGeneration",generation).put("coreBuildId",protocol.coreBuildIdentity()));
        var mapping=state.mapping();if(mapping==null){var m=json.createObjectNode().put("formatVersion",1).put("sourceId",check.source()).put("namespace",check.source()).put("revision",state.mappingRevision()).put("algorithm","apicc-sync-id-v1");m.set("entries",json.createArrayNode());mapping=m;}plan.set("mapping",mapping);
        plan.set("baselineFiles",state.baseline()==null?json.createArrayNode():state.baseline());var files=json.createArrayNode();current.files().forEach(file->files.add(json.createObjectNode().put("path",file.path()).put("content",file.content())));plan.set("localFiles",files);var others=json.createArrayNode();for(var other:repo.sources(w,p)){if(!other.path("id").equals(source.path("id"))){var otherMapping=repo.sourceState(w,p,other.path("id").asText()).mapping();if(otherMapping!=null)others.add(otherMapping);}}plan.set("otherSourceMappings",others);
        var compareBudget=json.createObjectNode();for(String field:List.of("maxSourceBytes","maxCompareInputBytes","maxCompareOutputBytes","maxNormalizeDepth","maxNormalizeNodes"))compareBudget.set(field,policy.path(field));plan.set("budget",compareBudget);
        var snapshot=new Snapshot(w,p,id,check.actor(),source,effective,read,plan,deadline,current.manifestHash(),selected);var details=(ObjectNode)check.details().deepCopy();details.set("snapshot",json.valueToTree(snapshot));repo.updateCheck(w,p,id,"running",details);return snapshot;
    });}
    private SyncRepo.Check requireCurrent(Snapshot snapshot,SyncRepo.Dispatch claim){
        accounting.globalGate();authority.lockGate();requireOwnership(claim,false);accounting.lock(snapshot.ws(),snapshot.project());repo.lockWorkspace(snapshot.ws());requireOwnership(claim,true);String ws=String.valueOf(snapshot.ws()),project=String.valueOf(snapshot.project());
        var check=repo.check(snapshot.ws(),snapshot.project(),snapshot.checkId()).orElseThrow(()->SyncRepo.missing("sync_check_not_found"));
        if(check.state().equals("cancelling")||check.state().equals("cancelled"))throw new Invalidated("cancelled");
        if(terminal(check.state()))throw new Invalidated("runtime-uncertain");
        schedules.getObject().requireCheckCurrent(snapshot.ws(),snapshot.project(),check);
        if(snapshot.deadlineAtMs()<=System.currentTimeMillis())throw new Invalidated("deadline-exceeded");
        var actor=users.findById(snapshot.actor()).orElseThrow(()->new Invalidated("authorization-changed"));
        try{agents.requireCapability(actor,ws,project,Capability.SYNC_CHECK);}catch(com.autumnharvestc.server.core.ApiException error){throw new Invalidated("authorization-changed");}
        var state=repo.sourceState(snapshot.ws(),snapshot.project(),snapshot.source().path("id").asText());var stamp=snapshot.planPayload().path("stamp");
        if(!state.source().equals(snapshot.source())||!state.mappingRevision().equals(stamp.path("mappingRevision").asText())||!state.baselineRevision().equals(stamp.path("baselineRevision").asText()))throw new Invalidated("source-revision-changed");
        var current=assets.get(actor,ws,project);if(!current.version().equals(stamp.path("assetVersion").asText())||!current.manifestHash().equals(snapshot.manifestHash()))throw new Invalidated("project-assets-changed");
        try{materialService.recheck(snapshot.ws(),snapshot.project(),snapshot.materials());}catch(com.autumnharvestc.server.core.ApiException error){throw new Invalidated("material-changed");}
        if(!String.valueOf(authority.projectRevision(snapshot.ws(),snapshot.project())).equals(stamp.path("authorizationGeneration").asText()))throw new Invalidated("authorization-changed");
        // Stored JSON may reload safe integer policy values as IntNode instead of LongNode.
        if(!RuntimeProtocol.digestJson(policies.requireEffective(snapshot.ws(),snapshot.project())).equals(RuntimeProtocol.digestJson(snapshot.effective())))throw new Invalidated("policy-changed");
        return check;
    }
    void validate(Snapshot snapshot,SyncRepo.Dispatch claim){tx.executeWithoutResult(status->requireCurrent(snapshot,claim));}
    void waiting(Snapshot snapshot,SyncRepo.Dispatch claim){tx.executeWithoutResult(status->{var check=requireCurrent(snapshot,claim);var details=(ObjectNode)check.details().deepCopy();details.put("reasonCode","source-busy");details.remove("snapshot");repo.updateCheck(snapshot.ws(),snapshot.project(),snapshot.checkId(),"waiting",details);repo.defer(snapshot.ws(),snapshot.project(),snapshot.checkId());});}
    void complete(Snapshot snapshot,JsonNode output,SyncRepo.Dispatch claim){tx.executeWithoutResult(status->{
        var check=requireCurrent(snapshot,claim);
        repo.candidate(snapshot.ws(),snapshot.project(),check.source(),output,System.currentTimeMillis()+snapshot.effective().path("policy").path("candidateTtlMs").asLong());
        var details=(ObjectNode)check.details().deepCopy();details.remove("snapshot");details.put("candidateId",output.path("candidate").path("id").asText());details.putNull("reasonCode");details.put("completedAtMs",System.currentTimeMillis());repo.updateCheck(snapshot.ws(),snapshot.project(),snapshot.checkId(),"succeeded",details);
    });}
    static boolean terminal(String state){return Set.of("succeeded","failed","cancelled","lost").contains(state);}
    void finish(SyncRepo.Dispatch claim,String reason,boolean uncertain,String detail){tx.executeWithoutResult(status->{
        long w=Long.parseLong(claim.workspace()),p=Long.parseLong(claim.project());accounting.globalGate();authority.lockGate();var current=repo.ownership(w,p,claim.check());if(current.isEmpty()||!owns(current.get(),claim,time.now()))return;
        accounting.lock(w,p);repo.lockWorkspace(w);var locked=repo.ownership(w,p,claim.check(),true);if(locked.isEmpty()||!owns(locked.get(),claim,time.now()))return;repo.check(w,p,claim.check()).ifPresent(check->{if(terminal(check.state()))return;var details=(ObjectNode)check.details().deepCopy();details.remove("snapshot");boolean cancelled=check.state().equals("cancelling")||reason.equals("cancelled");String terminalReason=cancelled?"cancelled":reason;details.put("reasonCode",terminalReason);details.put("detailCode",detail);details.put("completedAtMs",time.now().toEpochMilli());repo.updateCheck(w,p,claim.check(),cancelled?"cancelled":uncertain?"lost":"failed",details);schedules.getObject().pauseAfterFailure(w,p,check,terminalReason);});
    });}
    Optional<SyncRepo.Dispatch> claim(){return tx.execute(status->{accounting.globalGate();authority.lockGate();return repo.claim(worker.ownerId(),ownership.getLeaseMs());});}
    enum Observation { RUNNING,CANCELLING,LOST }
    private boolean owns(SyncRepo.Ownership row,SyncRepo.Dispatch claim,java.time.Instant now){return claim.owner()!=null&&claim.token()!=null&&claim.owner().equals(row.owner())&&claim.token().equals(row.token())&&row.until()!=null&&now.isBefore(row.until());}
    private void requireOwnership(SyncRepo.Dispatch claim,boolean lock){var current=repo.ownership(Long.parseLong(claim.workspace()),Long.parseLong(claim.project()),claim.check(),lock);if(current.isEmpty()||!owns(current.get(),claim,time.now()))throw new Invalidated("runtime-uncertain");if(current.get().state().equals("cancelling"))throw new Invalidated("cancelled");if(!current.get().state().equals("running"))throw new Invalidated("runtime-uncertain");}
    private Observation observation(Optional<SyncRepo.Ownership> current,SyncRepo.Dispatch claim){if(current.isEmpty()||!owns(current.get(),claim,time.now()))return Observation.LOST;return current.get().state().equals("running")?Observation.RUNNING:current.get().state().equals("cancelling")?Observation.CANCELLING:Observation.LOST;}
    Observation refreshOwnership(SyncRepo.Dispatch claim){
        long w=Long.parseLong(claim.workspace()),p=Long.parseLong(claim.project());
        // Missing/deleted scope is an immediate cancellation observation, with no policy/workspace lookup.
        var seen=observation(repo.ownership(w,p,claim.check()),claim);if(seen!=Observation.RUNNING)return seen;
        return tx.execute(status->{accounting.globalGate();authority.lockGate();var current=observation(repo.ownership(w,p,claim.check()),claim);if(current!=Observation.RUNNING)return current;accounting.lock(w,p);repo.lockWorkspace(w);current=observation(repo.ownership(w,p,claim.check(),true),claim);if(current!=Observation.RUNNING)return current;var now=time.now();return repo.renew(claim,now,now.plusMillis(ownership.getLeaseMs()))?Observation.RUNNING:Observation.LOST;});
    }
    void recover(){
        for(var claim:repo.expiredOwnership(time.now(),ownership.getRecoveryBatchSize()))tx.executeWithoutResult(status->{
            long w=Long.parseLong(claim.workspace()),p=Long.parseLong(claim.project());accounting.globalGate();authority.lockGate();var current=repo.ownership(w,p,claim.check());var now=time.now();
            if(current.isEmpty()||!Set.of("running","cancelling").contains(current.get().state())||(current.get().until()!=null&&now.isBefore(current.get().until())))return;
            accounting.lock(w,p);repo.lockWorkspace(w);current=repo.ownership(w,p,claim.check(),true);now=time.now();if(current.isEmpty()||!Set.of("running","cancelling").contains(current.get().state())||(current.get().until()!=null&&now.isBefore(current.get().until())))return;var check=repo.check(w,p,claim.check()).orElseThrow();
            // A legacy row cannot prove that an older backend died. Preserve its original finite read horizon.
            long horizon=check.details().path("deadlineAtMs").asLong();if(current.get().owner()==null&&horizon>now.toEpochMilli()){repo.legacyHorizon(w,p,check.id(),java.time.Instant.ofEpochMilli(horizon));return;}
            var details=(ObjectNode)check.details().deepCopy();details.remove("snapshot");boolean cancelled=check.state().equals("cancelling");details.put("reasonCode",cancelled?"cancelled":"server-restarted");details.put("completedAtMs",now.toEpochMilli());repo.updateCheck(w,p,check.id(),cancelled?"cancelled":"lost",details);
        });
    }
    JsonNode resolveMaterials(Snapshot snapshot){return materialService.resolve(users.findById(snapshot.actor()).orElseThrow(SyncDtos::denied),snapshot);}
}
