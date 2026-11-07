package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
@Service @Transactional
public class SyncCandidateService {
    private final SyncSourceService sources;private final SyncRepo repo;private final ObjectMapper json;private final com.autumnharvestc.server.access.AccessRepo authority;private final com.autumnharvestc.server.execution.assets.ProjectAssetsService assets;private final com.autumnharvestc.server.collaboration.runtime.RuntimeProtocol protocol;
    private final SyncDtos dtos; private final SyncPolicyService policies; private final com.autumnharvestc.server.collaboration.runtime.CollaborationRuntimeClient core; private final com.autumnharvestc.server.collaboration.runtime.RuntimeProperties runtime; private final org.springframework.transaction.support.TransactionTemplate tx;
    public SyncCandidateService(SyncSourceService sources,SyncRepo repo,ObjectMapper json,com.autumnharvestc.server.access.AccessRepo authority,com.autumnharvestc.server.execution.assets.ProjectAssetsService assets,com.autumnharvestc.server.collaboration.runtime.RuntimeProtocol protocol,SyncDtos dtos,SyncPolicyService policies,com.autumnharvestc.server.collaboration.runtime.CollaborationRuntimeClient core,com.autumnharvestc.server.collaboration.runtime.RuntimeProperties runtime,org.springframework.transaction.PlatformTransactionManager transactions){this.sources=sources;this.repo=repo;this.json=json;this.authority=authority;this.assets=assets;this.protocol=protocol;this.dtos=dtos;this.policies=policies;this.core=core;this.runtime=runtime;this.tx=new org.springframework.transaction.support.TransactionTemplate(transactions);}
    @Transactional(propagation=org.springframework.transaction.annotation.Propagation.NOT_SUPPORTED)
    public JsonNode detail(UserAccount actor,String ws,String project,String id,String change,String side){
        long w=Long.parseLong(ws),p=Long.parseLong(project);
        var payload=tx.execute(status->{
            read(actor,ws,project,id); // Existing current-project read authority, including stale candidate reads.
            var fixed=repo.candidate(w,p,id).orElseThrow(()->SyncRepo.missing("sync_candidate_not_found")).fixed();
            var candidate=fixed.path("candidate");
            var request=json.createObjectNode().put("formatVersion",1).put("candidateId",id).put("candidateDigest",candidate.path("candidateDigest").asText()).put("changeId",change).put("side",side);
            dtos.require("fixedDetailRequest",request);
            String field=switch(side){case "baseline"->"baselineFiles";case "current"->"localFiles";case "source"->"remoteFiles";default->throw SyncDtos.invalid();};
            var result=json.createObjectNode().put("kind","fixed-detail");result.set("candidate",candidate);result.set("request",request);result.set("files",fixed.path("planInput").path(field));
            var effective=policies.requireEffective(w,p).path("policy");var budget=result.putObject("budget");budget.set("maxCompareInputBytes",effective.path("maxCompareInputBytes"));budget.set("maxCompareOutputBytes",effective.path("maxCompareOutputBytes"));return result;
        });
        // No database/gate lock is held during the private, bounded Core projection.
        JsonNode detail;try{detail=core.call("sync-plan",payload,System.currentTimeMillis()+runtime.getCallTimeoutMs(),payload.path("budget").path("maxCompareOutputBytes").asInt());}
        catch(com.autumnharvestc.server.collaboration.runtime.CollaborationRuntimeClient.Failure failure){throw SyncDtos.conflict(failure.code());}
        return tx.execute(status->{
            read(actor,ws,project,id);dtos.require("fixedDetail",detail);
            if(!detail.path("candidateId").asText().equals(id)||!detail.path("candidateDigest").equals(payload.path("candidate").path("candidateDigest"))||!detail.path("changeId").asText().equals(change)||!detail.path("side").asText().equals(side))throw SyncDtos.conflict("SYNC_CANDIDATE_MISMATCH");
            var current=policies.requireEffective(w,p).path("policy");for(String field:java.util.List.of("maxCompareInputBytes","maxCompareOutputBytes"))if(!current.path(field).equals(payload.path("budget").path(field)))throw SyncDtos.conflict("sync_policy_changed");
            return detail;
        });
    }
    public JsonNode read(UserAccount actor,String ws,String project,String id){authority.lockGate();sources.requireRead(actor,ws,project);long w=Long.parseLong(ws),p=Long.parseLong(project);var stored=repo.candidate(w,p,id).orElseThrow(()->SyncRepo.missing("sync_candidate_not_found"));var candidate=stored.fixed().path("candidate");var stamp=candidate.path("stamp");var state=repo.sourceState(w,p,candidate.path("sourceId").asText());String reason=null;
        if(!state.source().path("revision").equals(stamp.path("sourceRevision")))reason="source-revision-changed";
        else if(!assets.get(actor,ws,project).version().equals(stamp.path("assetVersion").asText()))reason="project-assets-changed";
        else if(!state.mappingRevision().equals(stamp.path("mappingRevision").asText()))reason="mapping-revision-changed";
        else if(!state.baselineRevision().equals(stamp.path("baselineRevision").asText()))reason="baseline-revision-changed";
        else if(!String.valueOf(authority.projectRevision(w,p)).equals(stamp.path("authorizationGeneration").asText()))reason="authorization-changed";
        else if(!protocol.coreBuildIdentity().equals(stamp.path("coreBuildId").asText()))reason="core-identity-changed";
        else if(System.currentTimeMillis()>=stored.expiresAt())reason="candidate-expired";
        var result=json.createObjectNode().put("applicable",reason==null).put("reasonCode",reason);result.set("candidate",candidate);return result;
    }
}
