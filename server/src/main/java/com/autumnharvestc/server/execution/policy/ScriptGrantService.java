package com.autumnharvestc.server.execution.policy;

import org.springframework.stereotype.Service;
import java.util.List;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.agent.*;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;

/** Admission boundary. T6 must call this with trusted prepared snapshot dependencies. */
@Service
@Transactional
public class ScriptGrantService {
    public record ScriptRequirement(String scriptId, String contentHash) {}
    public record ScriptSource(String filePath,String fileHash) {}
    public record PreparedScriptRequirement(String scriptId,String contentHash,ScriptSource source,String kind) {}
    /** Internal trusted-host API, never an HTTP request DTO. T6 loads the persisted authorized snapshot first. */
    public String authorizePrepared(UserAccount caller,String agentId,com.autumnharvestc.server.execution.ExecutionDtos.ExecutionSnapshot snapshot,List<PreparedScriptRequirement> actualRequirements,String scriptPlanDigest){
        if(snapshot==null||snapshot.assets()==null||actualRequirements==null||scriptPlanDigest==null||!scriptPlanDigest.matches("[a-f0-9]{64}"))throw error(HttpStatus.BAD_REQUEST,"validation_failed","需要可信准备结果及固定快照");
        agents.requireExecution(caller,snapshot.assets().workspaceId(),snapshot.assets().projectId());
        var files=new HashMap<String,com.autumnharvestc.server.execution.ExecutionDtos.AssetFile>();for(var file:snapshot.assets().files())files.put(file.path(),file);
        for(var script:actualRequirements){
            if(script==null||script.source()==null||script.kind()==null||!Set.of("pre","post","condition").contains(script.kind()))throw error(HttpStatus.BAD_REQUEST,"validation_failed","实际脚本来源或种类无效");
            var file=files.get(script.source().filePath());
            if(file==null||!Objects.equals(file.hash(),script.source().fileHash())||!Objects.equals(file.hash(),com.autumnharvestc.server.core.Hashes.sha256HexUtf8(file.content())))throw error(HttpStatus.CONFLICT,"script_source_mismatch","实际脚本来源与固定快照文件摘要不符");
        }
        // Wire framing is the ordered mapper emitted by execution/host prepareProjectFiles.
        // Record declaration order differs, so never hash Jackson's record serialization here.
        var wire=new ArrayList<Map<String,Object>>();
        for(var requirement:actualRequirements){var entry=new LinkedHashMap<String,Object>();entry.put("scriptId",requirement.scriptId());entry.put("contentHash",requirement.contentHash());entry.put("kind",requirement.kind());var source=new LinkedHashMap<String,String>();source.put("filePath",requirement.source().filePath());source.put("fileHash",requirement.source().fileHash());entry.put("source",source);wire.add(entry);}
        if(!com.autumnharvestc.server.core.Hashes.sha256HexUtf8(metadata.encode(wire)).equals(scriptPlanDigest))throw error(HttpStatus.CONFLICT,"script_plan_mismatch","实际脚本依赖清单摘要不符");
        return authorize(agentId,snapshot.assets().workspaceId(),snapshot.assets().projectId(),actualRequirements.stream().map(s->new ScriptRequirement(s.scriptId(),s.contentHash())).toList());
    }
    private final AgentService agents;
    private final AgentRepo metadata;
    private final ScriptGrantRepo grants;
    private final ExecutionConfigService configs;
    public ScriptGrantService(AgentService agents,AgentRepo metadata,ScriptGrantRepo grants,ExecutionConfigService configs){this.agents=agents;this.metadata=metadata;this.grants=grants;this.configs=configs;}
    /** Internal host-only seam. Requirements must be the trusted prepare result, never a client approval/no-script flag. */
    public String authorize(String agentId,String workspaceId,String projectId,List<ScriptRequirement> requirements) {
        agents.requireUsable(agentId,workspaceId,projectId);validate(requirements);
        if(requirements.isEmpty())return null;
        if(!"trusted-core".equals(configs.agentValues(id(agentId)).get("scriptMode")))throw error(HttpStatus.FORBIDDEN,"script_mode_denied","代理禁止受信 Core 脚本");
        var grant=grants.find(id(agentId),id(projectId));
        if(grant.version()==0 || (!grant.scope().equals("project")&&!new HashSet<>(grant.scripts()).containsAll(requirements)))throw error(HttpStatus.FORBIDDEN,"script_grant_missing","实际脚本版本未获本代理及项目批准");
        return String.valueOf(grant.version());
    }
    public String replace(UserAccount caller,String workspaceId,String projectId,String agentId,String expectedVersion,String scope,List<ScriptRequirement> requirements,boolean riskConfirmed) {
        var project=agents.requireProject(caller,workspaceId,projectId,true);long agent=id(agentId);metadata.require(agent,true);validate(requirements);
        if(scope==null||!Set.of("script-version","project").contains(scope))throw error(HttpStatus.BAD_REQUEST,"validation_failed","批准范围仅支持 script-version/project");
        if(scope.equals("project")&&(!riskConfirmed||!requirements.isEmpty()))throw error(HttpStatus.BAD_REQUEST,"risk_confirmation_required","信任整个项目会覆盖未来脚本修改，脚本可能接触授权认证材料；必须显式确认风险");
        if(scope.equals("project")||!requirements.isEmpty()) {
            if(!metadata.granted(agent,project.workspaceId())||!metadata.allocated(agent,project.workspaceId(),project.id())||!metadata.associated(agent,project.id())||metadata.require(agent,false).revoked())throw error(HttpStatus.FORBIDDEN,"agent_not_associated","批准仅适用于本项目已关联且身份有效的代理");
        }
        agents.requireProject(caller,workspaceId,projectId,true);long expected=version(expectedVersion);grants.replace(agent,project.workspaceId(),project.id(),expected,scope,requirements,caller.id());metadata.auditScriptGrant(caller.id(),requirements.isEmpty()&&scope.equals("script-version")?"script-grant.revoke":"script-grant.replace",project.id(),agent,expected+1);return String.valueOf(expected+1);
    }
    public Map<String,Object> get(UserAccount caller,String ws,String project,String agentId){agents.requireProject(caller,ws,project,true);long agent=id(agentId);metadata.require(agent,false);var grant=grants.find(agent,id(project));return Map.of("agentId",agentId,"scope",grant.scope(),"version",String.valueOf(grant.version()),"scripts",grant.scripts(),"grantedByUserId",String.valueOf(grant.grantedBy()));}
    private static void validate(List<ScriptRequirement> requirements) {
        if(requirements==null)throw error(HttpStatus.BAD_REQUEST,"validation_failed","实际脚本依赖清单必填");var ids=new HashSet<String>();
        for(var script:requirements)if(script==null||script.scriptId()==null||script.scriptId().isBlank()||script.scriptId().length()>512||script.contentHash()==null||!script.contentHash().matches("[a-f0-9]{64}")||!ids.add(script.scriptId()))throw error(HttpStatus.BAD_REQUEST,"validation_failed","脚本 ID 及内容摘要必须有效且唯一");
    }
}
