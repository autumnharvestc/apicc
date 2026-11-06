package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.access.*;
import com.autumnharvestc.server.execution.agent.*;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.EntityIds;
import com.autumnharvestc.server.collaboration.runtime.RuntimeProperties;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import java.util.*;

@Service
@Transactional
public class SyncPolicyService {
    /** Deployment limits are trusted configuration, never caller-provided policy metadata. */
    @org.springframework.stereotype.Component
    @org.springframework.boot.context.properties.ConfigurationProperties(prefix="apicc.sync")
    public static class Deployment {
        private long envelopeReserveBytes=1048576;
        private Map<String,Long> ceilings=new LinkedHashMap<>();
        public long getEnvelopeReserveBytes(){return envelopeReserveBytes;}
        public void setEnvelopeReserveBytes(long value){envelopeReserveBytes=value;}
        public Map<String,Long> getCeilings(){return ceilings;}
        public void setCeilings(Map<String,Long> value){ceilings=value;}
    }
    private final SyncStorage accounting;private final SyncRepo repo;
    private final ObjectMapper json;
    private final RuntimeProperties runtime;
    private final Deployment deployment;
    private final SyncDtos dtos;
    private final SyncSourceService sources;
    private final WorkspaceGuard guard;
    private final AccessManagementService management;
    private final ProjectAccessService access;
    private final AgentService agents;
    private final AgentRepo audit;
    public SyncPolicyService(SyncRepo repo,ObjectMapper json,RuntimeProperties runtime,Deployment deployment,SyncDtos dtos,SyncSourceService sources,WorkspaceGuard guard,AccessManagementService management,ProjectAccessService access,AgentService agents,AgentRepo audit,SyncStorage accounting){this.accounting=accounting;
        this.repo=repo;this.json=json;this.runtime=runtime;this.deployment=deployment;this.dtos=dtos;this.sources=sources;this.guard=guard;this.management=management;this.access=access;this.agents=agents;this.audit=audit;
    }
    public JsonNode read(UserAccount actor,String ws,String project){
        long w=EntityIds.parse(ws);Long p=project==null?null:EntityIds.parse(project);
        if(project==null){guard.requireMember(w,actor);if(access.resolve(actor.id(),w,null).effectiveRole().isEmpty())throw SyncDtos.denied();}
        else sources.requireRead(actor,ws,project);
        return view(w,p);
    }
    public JsonNode save(UserAccount actor,String ws,String project,JsonNode input){
        accounting.lock(EntityIds.parse(ws),project==null?0:EntityIds.parse(project));
        long w=EntityIds.parse(ws);Long p=project==null?null:EntityIds.parse(project);
        guard.requireMember(w,actor);repo.lockWorkspace(w);
        // Workspace and project writes share the existing workspace lock; discard pre-wait authority.
        if(project==null){management.requirePolicyManagement(actor,w,null);if(!access.resolve(actor.id(),w,null).capabilities().contains(Capability.SYNC_MANAGE))throw SyncDtos.denied();}
        else agents.requireCapability(actor,ws,project,Capability.SYNC_MANAGE);
        dtos.require("policySave",input);var saved=input.get("policy");
        if(!saved.path("scope").asText().equals(project==null?"workspace":"project"))throw SyncDtos.invalid();
        long scope=p==null?0:p;String intent=input.path("intentId").asText(),kind=project==null?"workspace-policy":"project-policy";
        String digest=dtos.digest(kind,project,input);var replay=repo.replay(w,scope,intent,actor.id(),kind,digest);if(replay.isPresent())return replay.get();
        String expected=input.path("expectedRevision").asText();
        if(!repo.policy(w,p).path("revision").asText().equals(expected)||!saved.path("revision").asText().equals(SyncDtos.next(expected)))throw SyncDtos.conflict("SYNC_POLICY_REVISION_CHANGED");
        try{resolve(saved,p==null?null:resolve(repo.policy(w,null),null));}
        catch(InvalidPolicy ignored){throw new ApiException(HttpStatus.BAD_REQUEST,"SYNC_POLICY_INVALID","同步策略超出当前上级或部署限制，或预算组合无效");}
        repo.savePolicy(w,p,saved);var response=view(w,p);
        repo.operation(w,scope,intent,actor.id(),kind,digest,response);audit.audit(actor.id(),"sync.policy.save",p==null?"workspace":"project",p==null?w:p,null);
        return response;
    }
    /** Trusted internal admission seam: caller already owns current project/source authorization. */
    public JsonNode requireEffective(long ws,long project){
        try{return resolve(repo.policy(ws,project),resolve(repo.policy(ws,null),null));}
        catch(InvalidPolicy ignored){throw new ApiException(HttpStatus.CONFLICT,"SYNC_POLICY_INVALID","当前同步策略与上级或部署限制不兼容，请先修正配置");}
    }
    /** Maintenance may preserve sync state when a saved override no longer satisfies its parent. No exception crosses the transaction proxy for this known state. */
    public Optional<JsonNode> maintenanceEffective(long ws,long project){
        try{return Optional.of(resolve(repo.policy(ws,project),resolve(repo.policy(ws,null),null)));}
        catch(InvalidPolicy ignored){return Optional.empty();}
    }
    public JsonNode view(long ws,Long project){
        var workspace=repo.policy(ws,null);var saved=project==null?workspace:repo.policy(ws,project);
        var view=json.createObjectNode();view.set("saved",saved);view.set("units",json.valueToTree(SyncDtos.units()));view.put("workspaceRevision",workspace.path("revision").asText());
        view.set("inherited",project==null?json.nullNode():workspace);view.set("deploymentLimits",limits());view.set("deploymentCeilings",json.valueToTree(ceilings()));
        try{var effective=project==null?resolve(workspace,null):resolve(saved,resolve(workspace,null));view.set("effective",effective);view.put("status","valid");view.putNull("reasonCode");}
        catch(InvalidPolicy ignored){view.putNull("effective");view.put("status","invalid");view.put("reasonCode","SYNC_POLICY_INVALID");}
        return view;
    }
    private ObjectNode resolve(JsonNode saved,JsonNode inherited){
        if(!dtos.valid("policy",saved))throw new InvalidPolicy();
        var policy=json.createObjectNode();var provenance=json.createObjectNode();var ceilings=ceilings();
        for(var entry:SyncDtos.DEFAULTS.entrySet()){
            String key=entry.getKey();long value=inherited==null?entry.getValue():inherited.path("policy").path(key).longValue();
            String source=inherited==null?"default":inherited.path("sources").path(key).asText();
            Long ceiling=ceilings.get(key);
            if(ceiling!=null&&value>ceiling){value=ceiling;source="deployment";}
            if(saved.has(key)){
                long explicit=saved.path(key).longValue();
                if((ceiling!=null&&explicit>ceiling)||(inherited!=null&&explicit>inherited.path("policy").path(key).longValue()))throw new InvalidPolicy();
                value=explicit;source=saved.path("scope").asText();
            }
            policy.put(key,value);provenance.put(key,source);
        }
        var effective=json.createObjectNode().put("savedRevision",saved.path("revision").asText()).put("appliesTo","next-check");
        effective.set("policy",policy);effective.set("sources",provenance);effective.set("deploymentLimits",limits());
        if(!dtos.valid("effectivePolicy",effective))throw new InvalidPolicy();
        long wire=effective.path("deploymentLimits").path("maxWireBytes").longValue(),reserve=effective.path("deploymentLimits").path("envelopeReserveBytes").longValue();
        if(reserve>=wire||policy.path("maxCompareInputBytes").longValue()>wire-reserve||policy.path("maxCompareOutputBytes").longValue()>wire-reserve
                ||policy.path("maxSourceBytes").longValue()>policy.path("maxCompareInputBytes").longValue()
                ||policy.path("connectTimeoutMs").longValue()>policy.path("urlDeadlineMs").longValue()||policy.path("connectTimeoutMs").longValue()>policy.path("gitDeadlineMs").longValue()
                ||policy.path("projectConcurrency").longValue()>policy.path("hostConcurrency").longValue())throw new InvalidPolicy();
        return effective;
    }
    private ObjectNode limits(){return json.createObjectNode().put("maxWireBytes",runtime.getMaxWireBytes()).put("envelopeReserveBytes",deployment.getEnvelopeReserveBytes());}
    private Map<String,Long> ceilings(){
        var ceilings=new LinkedHashMap<>(deployment.getCeilings());
        for(String key:List.of("urlDeadlineMs","gitDeadlineMs"))ceilings.merge(key,(long)runtime.getSourceReadTimeoutMaxMs(),Math::min);
        return ceilings;
    }
    private static final class InvalidPolicy extends RuntimeException {}
}
