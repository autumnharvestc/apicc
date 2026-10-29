package com.autumnharvestc.server.execution.agent;

import com.autumnharvestc.server.core.PermissionService;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import com.autumnharvestc.server.execution.policy.ScriptGrantRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.core.type.TypeReference;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.*;
import java.util.*;

@Service
@Transactional
public class ProjectExecutionView {
    private final AgentService agents; private final AgentRepo repo; private final ExecutionConfigService configs;
    private final JdbcTemplate jdbc; private final PermissionService permissions; private final ScriptGrantRepo grants;
    private final com.autumnharvestc.server.execution.jobs.StressResourceReservations stressResources;
    public ProjectExecutionView(AgentService agents,AgentRepo repo,ExecutionConfigService configs,JdbcTemplate jdbc,PermissionService permissions,ScriptGrantRepo grants,com.autumnharvestc.server.execution.jobs.StressResourceReservations stressResources){this.agents=agents;this.repo=repo;this.configs=configs;this.jdbc=jdbc;this.permissions=permissions;this.grants=grants;this.stressResources=stressResources;}
    public Map<String,Object> read(UserAccount caller,String ws,String project){
        var entity=agents.requireProject(caller,ws,project,false);
        var effective=configs.project(caller,ws,project,null);var result=new LinkedHashMap<String,Object>();
        result.put("policy",effective.get("policy"));result.put("policyVersion",effective.get("policyVersion"));
        result.put("canManageScripts",permissions.isAdmin(permissions.effectiveRole(entity.workspaceId(),caller.id(),entity.id()).orElseThrow()));
        var visible=new ArrayList<Map<String,Object>>();
        for(String id:repo.associated(entity.id())){
            long agent=AgentRepo.id(id);
            if(!repo.granted(agent,entity.workspaceId())||!repo.allocated(agent,entity.workspaceId(),entity.id()))continue;
            var node=repo.require(agent,false);var row=new LinkedHashMap<String,Object>();
            row.put("id",id);row.put("name",node.name());row.put("acceptingJobs",node.acceptingJobs());
            var policy=configs.project(caller,ws,project,id);row.put("policy",policy.get("policy"));row.put("policyVersion",policy.get("policyVersion"));
            var values=configs.agentValues(agent);row.put("scriptsAllowed",Objects.equals(values.get("scriptMode"),"trusted-core"));
            var capacity=new LinkedHashMap<String,Object>();
            for(String key:List.of("maxConcurrentStressJobs","maxStressProcesses","maxStressVus","maxStressRequestConcurrency","maxStressRps","maxStressMetricMemoryBytes"))capacity.put(key,values.get(key));
            var source=new LinkedHashMap<String,Object>();var nodeSources=(Map<?,?>)configs.agentState(agent).get("sources");var policySources=(Map<?,?>)policy.get("sources");
            for(String key:List.of("maxStressRequestConcurrency","maxStressRps")){source.put("agent."+key,nodeSources.get(key));source.put("policy."+key,policySources.get("policy."+key));}
            row.put("stressConfiguration",Map.of("agent",capacity,"sources",source));
            var saved=repo.config("agent",agent);String status=!saved.restartRequiredFields().isEmpty()?"restart-required":saved.version()==saved.appliedVersion()&&saved.pendingFields().isEmpty()?"applied":"pending";
            row.put("configuration",Map.of("configVersion",String.valueOf(saved.version()),"appliedConfigVersion",String.valueOf(saved.appliedVersion()),"pendingFields",saved.pendingFields(),"restartRequiredFields",saved.restartRequiredFields(),"status",status));
            row.putAll(runtimeFacts(node));
            var grant=grants.find(agent,entity.id());row.put("scriptGrant",Map.of("version",String.valueOf(grant.version()),"scope",grant.scope(),"scripts",grant.scripts()));
            visible.add(row);
        }
        String selected=repo.defaultAgent(entity.id());result.put("defaultAgentId",visible.stream().anyMatch(row->Objects.equals(row.get("id"),selected))?selected:null);
        result.put("agents",visible);return result;
    }
    /** Shared projection only; entry points must authorize platform or project scope first. */
    public Map<String,Object> runtimeFacts(AgentRepo.Agent node){
        long agent=node.id();var result=new LinkedHashMap<String,Object>();
        result.put("stressCapacity",stressResources.capacity(agent,configs.agentValues(agent)));
        var runtime=jdbc.query("SELECT description_json FROM execution_agent_runtime WHERE agent_id=?",(r,n)->repo.decode(r.getString(1),new TypeReference<Map<String,Object>>(){}),agent);
        var control=jdbc.query("SELECT session_id,last_seen FROM execution_agent_control_state WHERE agent_id=?",(r,n)->Map.of("sessionId",r.getString(1),"seen",r.getObject(2,OffsetDateTime.class)),agent);
        OffsetDateTime seen=control.isEmpty()?null:(OffsetDateTime)control.getFirst().get("seen");result.put("lastSeenAt",seen==null?null:seen.toInstant().toString());
        String availability=runtime.isEmpty()?"runtime-missing":"disconnected";
        if(!runtime.isEmpty()){
            result.put("runtime",runtime.getFirst());
            var values=configs.agentValues(agent);
            if(seen!=null&&Objects.equals(control.getFirst().get("sessionId"),runtime.getFirst().get("sessionId")))availability=seen.toInstant().plusMillis(((Number)values.get("offlineAfterMs")).longValue()).isAfter(Instant.now())?"available":"stale";
        }
        if(node.revoked())availability="revoked";else if(!node.acceptingJobs())availability="not-accepting";
        result.put("availability",availability);return result;
    }
}
