package com.autumnharvestc.server.collaboration.policy;

import com.autumnharvestc.server.access.AccessManagementService;
import com.autumnharvestc.server.access.AccessRepo;
import com.autumnharvestc.server.access.AccessRequests;
import com.autumnharvestc.server.admin.AdminService;
import com.autumnharvestc.server.collaboration.runtime.RuntimeProperties;
import com.autumnharvestc.server.collaboration.runtime.RuntimeProtocol;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.*;

/** Current authority and one consistent immutable policy snapshot; no runtime RPC in any transaction. */
@Service
public class CollaborationPolicyService {
    private final AccessManagementService authority;
    private final AdminService platformAuthority;
    private final CollaborationPolicyRepo policies;
    private final AccessRepo accessLocks;
    private final DeploymentPolicyProperties deployment;
    private final RuntimeProperties runtime;
    private final ObjectMapper json;
    private final com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage storage;
    private final org.springframework.beans.factory.ObjectProvider<com.autumnharvestc.server.collaboration.grants.GrantService> grants;
    public CollaborationPolicyService(AccessManagementService authority,AdminService platformAuthority,CollaborationPolicyRepo policies,
            AccessRepo accessLocks,DeploymentPolicyProperties deployment,RuntimeProperties runtime,ObjectMapper json,com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage storage,
            org.springframework.beans.factory.ObjectProvider<com.autumnharvestc.server.collaboration.grants.GrantService> grants){
        this.authority=authority;this.platformAuthority=platformAuthority;this.policies=policies;this.accessLocks=accessLocks;this.deployment=deployment;this.runtime=runtime;this.json=json;this.storage=storage;
        this.grants=grants;
    }
    @Transactional
    public PolicyReadView read(UserAccount actor,Long workspace,Long project) {return readScope(actor,workspace,project);}
    @Transactional
    public PolicyReadView readPlatform(UserAccount actor){return readScope(actor,0L,null);}
    /** Consistent finite snapshot under shared locks; publication callers independently enforce purpose/source authority. */
    @Transactional
    public PolicyReadView publicationSnapshot(long workspace,long project){policies.lockGate();accessLocks.lockGate();return view(chain(workspace,project));}
    private PolicyReadView readScope(UserAccount actor,long workspace,Long project){
        requireAuthority(actor,workspace,project);
        policies.lockGate();accessLocks.lockGate();requireAuthority(actor,workspace,project);
        return view(chain(workspace,project));
    }
    @Transactional
    public PolicyReadView writePlatform(UserAccount actor,JsonNode request){return write(actor,0L,null,request);}
    @Transactional
    public PolicyReadView write(UserAccount actor,Long workspace,Long project,JsonNode request) {
        requireAuthority(actor,workspace,project);
        var patch=PolicyPatch.parse(request);long scope=project==null?0:project;
        var stored=policies.lock(workspace,scope);accessLocks.lockGate();requireAuthority(actor,workspace,project);
        if(stored.revision()!=patch.expectedRevision())throw conflict("collaboration_policy_revision_conflict","协作策略已变化，请刷新后重试");
        if(stored.revision()>=AccessRequests.MAX_REVISION)throw conflict("collaboration_policy_revision_exhausted","协作策略修订已达到安全整数上限");
        if(stored.projectionRevision()>=AccessRequests.MAX_REVISION)throw conflict("collaboration_policy_projection_revision_exhausted","协作策略投影修订已达到安全整数上限");
        var current=chain(workspace,project);var merged=stored.settings().apply(patch);Source source=source(workspace,project);
        var effective=PolicyLayers.apply(current.upper(),merged,source);
        PolicyLayers.requireCommand(current.upper(),effective,patch,source);
        storage.lockScope(workspace,scope);
        policies.save(workspace,scope,patch.expectedRevision(),merged);
        var result=view(chain(workspace,project));grants.getObject().policyApplied(actor.id(),workspace,project);storage.policySaved(actor.id(),workspace,scope,stored.revision()+1,result);
        return result;
    }
    private void requireAuthority(UserAccount actor,long workspace,Long project){
        if(workspace==0)platformAuthority.requireCollaborationPolicyManagement(actor);else authority.requirePolicyManagement(actor,workspace,project);
    }
    private record Chain(DeploymentPolicyProperties.Snapshot deployment,List<Setting> upper,List<Setting> settings,
                         Optional<CollaborationPolicyRepo.Stored> local,List<Lineage> lineage) {}
    /** Caller holds the policy gate, so no ancestor write can split these scope reads. */
    private Chain chain(long workspace,Long project){
        var configuration=deployment.capture(runtime);var builtin=PolicyLayers.deploymentTotals(configuration.settings());
        var platform=policies.find(0,0);var platformSettings=PolicyLayers.apply(builtin,platform.map(CollaborationPolicyRepo.Stored::settings).orElse(null),Source.PLATFORM);
        var lineage=new ArrayList<Lineage>();lineage.add(lineage(Scope.PLATFORM,0,0,platform));
        if(workspace==0)return new Chain(configuration,builtin,platformSettings,platform,List.copyOf(lineage));
        var workspaceLocal=policies.find(workspace,0);var workspaceSettings=PolicyLayers.apply(platformSettings,workspaceLocal.map(CollaborationPolicyRepo.Stored::settings).orElse(null),Source.WORKSPACE);
        lineage.add(lineage(Scope.WORKSPACE,workspace,0,workspaceLocal));
        if(project==null)return new Chain(configuration,platformSettings,workspaceSettings,workspaceLocal,List.copyOf(lineage));
        var projectLocal=policies.find(workspace,project);var projectSettings=PolicyLayers.apply(workspaceSettings,projectLocal.map(CollaborationPolicyRepo.Stored::settings).orElse(null),Source.PROJECT);
        lineage.add(lineage(Scope.PROJECT,workspace,project,projectLocal));
        return new Chain(configuration,workspaceSettings,projectSettings,projectLocal,List.copyOf(lineage));
    }
    private PolicyReadView view(Chain value){
        var identity=new Identity(RuntimeProtocol.digestJson(json.valueToTree(value.deployment().configuration())),
            RuntimeProtocol.digestJson(json.valueToTree(PolicyLayers.effectiveValues(value.settings()))),value.lineage());
        return new PolicyReadView(value.local().map(CollaborationPolicyRepo.Stored::revision).orElse(0L),value.local().map(CollaborationPolicyRepo.Stored::projectionRevision).orElse(1L),value.settings(),value.deployment().resources(),identity);
    }
    private static Lineage lineage(Scope scope,long workspace,long project,Optional<CollaborationPolicyRepo.Stored> value){
        return new Lineage(scope,String.valueOf(workspace),String.valueOf(project),value.map(CollaborationPolicyRepo.Stored::revision).orElse(0L),value.map(CollaborationPolicyRepo.Stored::projectionRevision).orElse(1L));
    }
    private static Source source(long workspace,Long project){return workspace==0?Source.PLATFORM:project==null?Source.WORKSPACE:Source.PROJECT;}
    private static ApiException conflict(String code,String message){return new ApiException(HttpStatus.CONFLICT,code,message);}
}
