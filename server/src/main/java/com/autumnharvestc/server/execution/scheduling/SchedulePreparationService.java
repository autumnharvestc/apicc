package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.execution.agent.*;
import com.autumnharvestc.server.execution.assets.ExecutionSnapshotService;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import com.autumnharvestc.server.execution.jobs.*;
import com.autumnharvestc.server.execution.policy.ScriptGrantService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;
import static org.springframework.http.HttpStatus.*;

/** Validates declarations without submitting a job, executing Core, or resolving secret values. */
@Service
public class SchedulePreparationService {
    private final AgentService agents;private final ExecutionSnapshotService snapshots;private final ScriptGrantService scripts;
    private final ExecutionConfigService configs;private final CoreInputValidator validator;private final JdbcTemplate jdbc;private final com.fasterxml.jackson.databind.ObjectMapper json;
    public SchedulePreparationService(AgentService agents,ExecutionSnapshotService snapshots,ScriptGrantService scripts,ExecutionConfigService configs,CoreInputValidator validator,JdbcTemplate jdbc,com.fasterxml.jackson.databind.ObjectMapper json){this.agents=agents;this.snapshots=snapshots;this.scripts=scripts;this.configs=configs;this.validator=validator;this.jdbc=jdbc;this.json=json;}
    public ExecutionSnapshot validate(UserAccount subject,String ws,String project,ScheduleDtos.Execution e){
        if(e==null||e.preparation()==null||e.preparation().scope()==null||e.runConfig()==null||e.target()==null||e.materials()==null)bad();
        id(e.agentId());id(e.snapshotId());var p=e.preparation();
        if(!Set.of("suite","workflow").contains(e.target().path("kind").asText())||!"dedicated-task".equals(p.dispatchKind())||e.runConfig().stress()!=null||p.stressBinding()!=null)bad();
        if(e.environmentId()!=null&&!e.environmentId().matches("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}"))bad();
        var run=new LinkedHashMap<String,Object>();if(e.runConfig().jobTimeoutMs()!=null)run.put("jobTimeoutMs",e.runConfig().jobTimeoutMs());if(e.runConfig().scriptTimeoutMs()!=null)run.put("scriptTimeoutMs",e.runConfig().scriptTimeoutMs());if(e.runConfig().requestSettings()!=null)run.put("requestSettings",e.runConfig().requestSettings());
        validator.requireValid(e.target(),json.valueToTree(run));
        var fixed=snapshots.loadAuthorized(subject,id(e.snapshotId()));var assets=fixed.assets();
        if(!assets.workspaceId().equals(ws)||!assets.projectId().equals(project)||!p.scope().equals(new JobDtos.Scope(ws,assets.groupId(),project)))throw error(FORBIDDEN,"snapshot_scope_mismatch","计划准备声明与固定项目快照作用域不符");
        if(!assets.manifestHash().equals(p.manifestHash()))throw error(CONFLICT,"snapshot_manifest_mismatch","计划准备声明与固定快照摘要不符");
        if(p.requiredCapabilities()==null||p.scriptRequirements()==null||p.requiredCoreBuildId()==null||!p.requiredCoreBuildId().matches("[a-f0-9]{64}")||p.runtimeCompatibilityId()==null||new HashSet<>(p.requiredCapabilities()).size()!=p.requiredCapabilities().size())bad();
        if(!Set.of("no-script","trusted-core-script").contains(p.executionProfile()==null?"":p.executionProfile())||p.executionProfile().equals("no-script")&&(!p.scriptRequirements().isEmpty()||p.scriptGrantVersion()!=null)||p.executionProfile().equals("trusted-core-script")&&p.scriptRequirements().isEmpty())bad();
        agents.requireUsable(e.agentId(),ws,project);
        String grant=scripts.authorizePrepared(subject,e.agentId(),fixed,p.scriptRequirements(),p.scriptPlanDigest());
        if(!Objects.equals(grant,p.scriptGrantVersion()))throw error(CONFLICT,"script_grant_changed","计划准备批准版本已变化");
        var encoded=jdbc.query("SELECT description_json FROM execution_agent_runtime WHERE agent_id=?",(r,n)->r.getString(1),id(e.agentId())).stream().findFirst().orElseThrow(()->error(CONFLICT,"runtime_required","指定代理尚未登记运行身份"));
        com.fasterxml.jackson.databind.JsonNode runtime;try{runtime=json.readTree(encoded);}catch(java.io.IOException ex){throw new IllegalStateException("Invalid registered runtime",ex);}
        var capabilities=new HashSet<String>();runtime.path("capabilities").forEach(c->capabilities.add(c.asText()));
        if(!p.requiredCoreBuildId().equals(runtime.path("coreBuildId").asText())||!p.runtimeCompatibilityId().equals(runtime.path("runtimeCompatibilityId").asText())||!capabilities.containsAll(p.requiredCapabilities())||!p.requiredCapabilities().contains("task:"+e.target().path("kind").asText()))throw error(CONFLICT,"runtime-mismatch","指定代理运行身份或能力与固定准备不兼容");
        var state=configs.agentState(id(e.agentId()));
        if(!"applied".equals(runtime.path("configuration").path("status").asText())||!Objects.equals(state.get("configVersion"),runtime.path("configuration").path("appliedConfigVersion").asText()))throw error(CONFLICT,"agent-configuration-pending","指定代理尚未应用当前配置");
        configs.effective(id(e.agentId()),id(ws),id(project),JobService.timeouts(e.runConfig()));
        return fixed;
    }
    private static void bad(){throw error(BAD_REQUEST,"validation_failed","计划只支持完整的套件或工作流固定准备与专用执行");}
}
