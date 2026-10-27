package com.autumnharvestc.server.execution.config;

import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.ExecutionProperties;
import com.autumnharvestc.server.execution.agent.*;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;

@Service
@Transactional
public class ExecutionConfigService {
    private static final long SAFE=9007199254740991L;
    private static final long MIN_FAULT_REPORT_BYTES=1024;
    private static final Set<String> TIMERS=Set.of("workerStartupTimeoutMs","workerHeartbeatIntervalMs","workerUnresponsiveAfterMs","longPollWaitMs","controlRequestTimeoutMs","pollTimeoutMarginMs","heartbeatIntervalMs","reconnectMinMs","reconnectMaxMs","transferTimeoutMs","transferRetryMinMs","transferRetryMaxMs","cancelGraceMs","scriptTimeoutMs","maxScriptTimeoutMs");
    private static final Set<String> CEILINGS=Set.of("maxQueuedJobs","maxJobTimeoutMs","maxScriptTimeoutMs","snapshotBytes","singleAttachmentBytes","totalInputBytes","maxAssetChangeFiles","bodyPreviewBytes","valuePreviewBytes","caseEvidenceBytes","reportBytes","workflowMetadataBytes");
    private final ExecutionProperties properties;
    private final AgentRepo repo;
    private final AgentService agents;
    private final WorkspaceGuard guard;
    private final JdbcTemplate jdbc;
    public ExecutionConfigService(ExecutionProperties properties,AgentRepo repo,AgentService agents,WorkspaceGuard guard,JdbcTemplate jdbc){this.properties=properties;this.repo=repo;this.agents=agents;this.guard=guard;this.jdbc=jdbc;}
    /** ConfigurationProperties are deployment inputs; changed inherited values need fresh durable versions. */
    public void reconcileDeploymentDefaults() {
        var defaults = properties.agentDefaults();
        var policy = properties.getPolicy().asMap();
        validateAgent(defaults, policy);
        validatePolicy(policy);
        var previous = jdbc.query("SELECT agent_json,policy_json,deployment_json FROM execution_deployment_defaults WHERE id=1 FOR UPDATE",
            (row, index) -> Map.of("agent", row.getString(1), "policy", row.getString(2), "deployment", row.getString(3)));
        Map<String,Object> oldDefaults = previous.isEmpty() ? Map.of() : repo.decode(previous.getFirst().get("agent"), new com.fasterxml.jackson.core.type.TypeReference<Map<String,Object>>() {});
        long oldConcurrencyCeiling = previous.isEmpty() ? SAFE : number(repo.decode(previous.getFirst().get("deployment"), new com.fasterxml.jackson.core.type.TypeReference<Map<String,Object>>() {}), "maxAgentConcurrentJobs");
        boolean policyChanged = !previous.isEmpty() && (!jsonSame(previous.getFirst().get("policy"), policy) || !jsonSame(previous.getFirst().get("deployment"), properties.getDeployment().asMap()));
        boolean agentChanged = false;
        for (var node : repo.list()) {
            repo.require(node.id(), true);
            var saved = repo.config("agent", node.id());
            var next = agentValues(saved);
            var oldValues = new LinkedHashMap<>(oldDefaults); oldValues.putAll(saved.explicit());
            applyConcurrencyCeiling(oldValues, oldConcurrencyCeiling);
            var changed = new ArrayList<String>();
            for (String key : defaults.keySet()) {
                if (!sameNumberOrValue(next.get(key), oldValues.get(key))) changed.add(key);
            }
            if (!changed.isEmpty()) {
                repo.saveConfig("agent", node.id(), saved.version(), saved.explicit(), changed);
                agentChanged = true;
            }
        }
        if (agentChanged || policyChanged) bumpPolicy();
        if (previous.isEmpty()) jdbc.update("INSERT INTO execution_deployment_defaults(id,agent_json,policy_json,deployment_json) VALUES (1,?,?,?)", repo.encode(defaults), repo.encode(policy), repo.encode(properties.getDeployment().asMap()));
        else jdbc.update("UPDATE execution_deployment_defaults SET agent_json=?,policy_json=?,deployment_json=? WHERE id=1", repo.encode(defaults), repo.encode(policy), repo.encode(properties.getDeployment().asMap()));
    }
    private boolean jsonSame(Object stored, Map<String,Object> next) {
        Map<String,Object> old = repo.decode(stored.toString(), new com.fasterxml.jackson.core.type.TypeReference<Map<String,Object>>() {});
        return old.keySet().equals(next.keySet()) && next.entrySet().stream().allMatch(entry -> sameNumberOrValue(entry.getValue(), old.get(entry.getKey())));
    }
    private static boolean sameNumberOrValue(Object left, Object right) {
        if (left instanceof Number && right instanceof Number) return new java.math.BigDecimal(left.toString()).compareTo(new java.math.BigDecimal(right.toString())) == 0;
        return Objects.equals(left, right);
    }
    public Map<String,Object> agent(UserAccount caller,String agentId) { AgentService.requirePlatform(caller);return agentState(id(agentId)); }
    public void saveAgentPolicy(UserAccount caller,String agentId,String expectedVersion,Map<String,Object> patch) {
        AgentService.requirePlatform(caller);long agent=id(agentId);repo.require(agent,true);strict(patch,Set.of("maxQueuedJobs"));
        var explicit=new LinkedHashMap<>(repo.config("agent-policy",agent).explicit());explicit.putAll(patch);
        if(explicit.containsKey("maxQueuedJobs")&&positive(explicit.get("maxQueuedJobs"),"maxQueuedJobs")>properties.getPolicy().getMaxQueuedJobs())bad("代理排队额度超过全局额度");
        long expected=version(expectedVersion);repo.saveConfig("agent-policy",agent,expected,explicit,List.of());bumpPolicy();repo.audit(caller.id(),"config.queue-save","agent",agent,expected+1);
    }
    /** T6 calls only for the authenticated AgentPrincipal. No member-facing acknowledgement endpoint. */
    public void acknowledge(long agent,String configVersion,String appliedConfigVersion,List<String> pendingFields,List<String> restartRequiredFields) {
        var node=repo.require(agent,true);if(node.revoked())throw error(HttpStatus.UNAUTHORIZED,"unauthorized","代理身份已撤销");
        var saved=repo.config("agent",agent);long reported=version(configVersion),applied=version(appliedConfigVersion);
        if(reported!=saved.version()||applied>reported||applied<saved.appliedVersion())throw error(HttpStatus.CONFLICT,"version_conflict","代理应用确认版本与保存版本不符");
        var keys=ExecutionProperties.defaultAgent().keySet();
        if(pendingFields==null||restartRequiredFields==null||!keys.containsAll(pendingFields)||!keys.containsAll(restartRequiredFields)
            ||new HashSet<>(pendingFields).size()!=pendingFields.size()||new HashSet<>(restartRequiredFields).size()!=restartRequiredFields.size()
            ||!pendingFields.containsAll(restartRequiredFields)||(pendingFields.isEmpty()&&applied!=reported)||(!pendingFields.isEmpty()&&applied==reported))bad("配置应用字段与版本不一致");
        jdbc.update("UPDATE execution_configs SET applied_version=?,pending_fields_json=?,restart_fields_json=? WHERE scope_type='agent' AND scope_id=? AND version=?",applied,repo.encode(pendingFields),repo.encode(restartRequiredFields),agent,reported);
    }
    public Map<String,Object> agentState(long agent) {
        repo.require(agent,false);var saved=repo.config("agent",agent);var values=agentValues(saved);var result=new LinkedHashMap<String,Object>();
        result.put("configVersion",String.valueOf(saved.version()));result.put("appliedConfigVersion",String.valueOf(saved.appliedVersion()));result.put("explicit",saved.explicit());result.put("config",values);
        result.put("pendingFields",saved.pendingFields());result.put("restartRequiredFields",saved.restartRequiredFields());result.put("status",!saved.restartRequiredFields().isEmpty()?"restart-required":saved.version()==saved.appliedVersion()&&saved.pendingFields().isEmpty()?"applied":"pending");
        var sources=new LinkedHashMap<String,String>();for(String key:values.keySet())sources.put(key,saved.explicit().containsKey(key)?"agent":properties.getAgent().keySet().stream().anyMatch(k->k.replace("-","").equalsIgnoreCase(key))?"deployment":"default");result.put("sources",sources);
        var restrictions = new ArrayList<Map<String,Object>>();
        if (number(values,"sharedDebugMaxInFlight") > number(values,"maxConcurrentJobs")) restrictions.add(Map.of("field","agent.sharedDebugMaxInFlight","reason","agent.maxConcurrentJobs","effectiveValue",number(values,"maxConcurrentJobs")));
        var requested = properties.agentDefaults(); requested.putAll(saved.explicit());
        if (number(requested,"maxConcurrentJobs") > properties.getDeployment().getMaxAgentConcurrentJobs()) restrictions.add(Map.of("field","agent.maxConcurrentJobs","reason","deployment.maxAgentConcurrentJobs","effectiveValue",number(values,"maxConcurrentJobs")));
        result.put("restrictions", restrictions);
        result.put("deployment",properties.getDeployment().asMap());var queue=repo.config("agent-policy",agent);result.put("agentPolicy",Map.of("version",String.valueOf(queue.version()),"explicit",queue.explicit(),"maxQueuedJobs",queue.explicit().getOrDefault("maxQueuedJobs",Math.min(100,properties.getPolicy().getMaxQueuedJobs()))));return result;
    }
    public Map<String,Object> agentValues(long agent) { return agentValues(repo.config("agent",agent)); }
    private Map<String,Object> agentValues(AgentRepo.Config saved) {
        var values = properties.agentDefaults(); values.putAll(saved.explicit());
        applyConcurrencyCeiling(values, properties.getDeployment().getMaxAgentConcurrentJobs());
        validateAgent(values, properties.getPolicy().asMap());
        return values;
    }
    /** Persisted intent remains intact; a restarted deployment ceiling limits only effective intake. */
    private static void applyConcurrencyCeiling(Map<String,Object> values, long ceiling) {
        if (values.containsKey("maxConcurrentJobs") && number(values,"maxConcurrentJobs") > ceiling) values.put("maxConcurrentJobs", ceiling);
    }
    public Map<String,Object> saveAgent(UserAccount caller,String agentId,String expectedVersion,Map<String,Object> patch) {
        AgentService.requirePlatform(caller);long agent=id(agentId);repo.require(agent,true);long expected=version(expectedVersion);
        strict(patch,ExecutionProperties.defaultAgent().keySet());var explicit=new LinkedHashMap<>(repo.config("agent",agent).explicit());explicit.putAll(patch);
        var values=properties.agentDefaults();values.putAll(explicit);validateAgent(values,properties.getPolicy().asMap());
        repo.saveConfig("agent",agent,expected,explicit,new ArrayList<>(patch.keySet()));bumpPolicy();repo.audit(caller.id(),"config.save","agent",agent,expected+1);return agentState(agent);
    }
    public Map<String,Object> saveProject(UserAccount caller,String ws,String project,String expectedVersion,Map<String,Object> patch) {
        var entity=agents.requireProject(caller,ws,project,true);long expected=version(expectedVersion);strict(patch,properties.getPolicy().asMap().keySet());
        var explicit=new LinkedHashMap<>(repo.config("project",entity.id()).explicit());explicit.putAll(patch);
        resolve(null,entity.workspaceId(),entity.id(),explicit,Map.of());for(String agent:repo.associated(entity.id()))resolve(id(agent),entity.workspaceId(),entity.id(),explicit,Map.of());repo.saveConfig("project",entity.id(),expected,explicit,List.of());bumpPolicy();repo.audit(caller.id(),"config.save","project",entity.id(),expected+1);return project(caller,ws,project,null);
    }
    public Map<String,Object> saveWorkspace(UserAccount caller,String ws,String expectedVersion,Map<String,Object> patch) {
        long workspace=id(ws);guard.requireAdmin(workspace,caller);jdbc.queryForList("SELECT id FROM workspaces WHERE id=? FOR UPDATE",workspace);guard.requireAdmin(workspace,caller);
        strict(patch,properties.getPolicy().asMap().keySet());var explicit=new LinkedHashMap<>(repo.config("workspace",workspace).explicit());explicit.putAll(patch);
        var merged=properties.getPolicy().asMap();mergePolicy(merged,explicit,"workspace",new LinkedHashMap<>(),new ArrayList<>());validatePolicy(merged);
        long expected=version(expectedVersion);repo.saveConfig("workspace",workspace,expected,explicit,List.of());bumpPolicy();repo.audit(caller.id(),"config.save","workspace",workspace,expected+1);return workspace(caller,ws);
    }
    public Map<String,Object> workspace(UserAccount caller,String ws) {
        long workspace=id(ws);guard.requireAdmin(workspace,caller);String revision=policyVersion();var saved=repo.config("workspace",workspace);var values=properties.getPolicy().asMap();var sources=policySources(values);var restrictions=new ArrayList<Map<String,Object>>();
        mergePolicy(values,saved.explicit(),"workspace",sources,restrictions);checkRevision(revision);
        return Map.of("configVersion",String.valueOf(saved.version()),"policyVersion",revision,"explicit",saved.explicit(),"policy",values,"sources",sources,"restrictions",restrictions);
    }
    public Map<String,Object> project(UserAccount caller,String ws,String project,String agentId) {var entity=agents.requireProject(caller,ws,project,false);return resolve(agentId==null?null:id(agentId),entity.workspaceId(),entity.id(),null,Map.of());}
    /** Internal T6 seam: caller must authorize execution and provide authoritative entity IDs first. */
    public Map<String,Object> effective(Long agent,long ws,long project,Map<String,Object> run) {return resolve(agent,ws,project,null,run);}
    private Map<String,Object> resolve(Long agent,long ws,long project,Map<String,Object> projectOverride,Map<String,Object> run) {
        String revision=policyVersion();var policy=properties.getPolicy().asMap();validatePolicy(policy);var sources=policySources(policy);var restrictions=new ArrayList<Map<String,Object>>();
        var wsSaved=repo.config("workspace",ws);mergePolicy(policy,wsSaved.explicit(),"workspace",sources,restrictions);
        var saved=repo.config("project",project);var explicit=projectOverride==null?saved.explicit():projectOverride;
        var projectPatch=new LinkedHashMap<>(explicit);
        boolean defaultQueue=!projectPatch.containsKey("maxQueuedJobs")&&number(policy,"maxQueuedJobs")>50;
        if(!projectPatch.containsKey("maxQueuedJobs")&&number(policy,"maxQueuedJobs")<50)restrictions.add(Map.of("field","policy.maxQueuedJobs","reason",sources.get("policy.maxQueuedJobs")+".maxQueuedJobs","effectiveValue",number(policy,"maxQueuedJobs")));
        if(defaultQueue)projectPatch.put("maxQueuedJobs",50);
        mergePolicy(policy,projectPatch,"project",sources,restrictions);
        if(defaultQueue)sources.put("policy.maxQueuedJobs","default");
        long global=properties.getPolicy().getMaxQueuedJobs();Long agentQueue=null;
        if(agent!=null) {
            var agentPolicy=repo.config("agent-policy",agent).explicit();agentQueue=agentPolicy.containsKey("maxQueuedJobs")?number(agentPolicy,"maxQueuedJobs"):Math.min(100,global);
            if(explicit.containsKey("maxQueuedJobs")&&number(explicit,"maxQueuedJobs")>agentQueue)bad("项目排队额度超过代理额度");
            if(number(policy,"maxQueuedJobs")>agentQueue){policy.put("maxQueuedJobs",agentQueue);sources.put("policy.maxQueuedJobs","agent");restrictions.add(Map.of("field","policy.maxQueuedJobs","reason","agent.maxQueuedJobs","effectiveValue",agentQueue));}
        }
        strict(run,Set.of("jobTimeoutMs","scriptTimeoutMs"));long timeout=run.containsKey("jobTimeoutMs")?positive(run.get("jobTimeoutMs"),"jobTimeoutMs"):number(policy,"defaultJobTimeoutMs");
        if(timeout>number(policy,"maxJobTimeoutMs")||number(policy,"cancelGraceMs")>timeout)bad("任务期限超过策略或不足取消收束预算");
        if(run.containsKey("scriptTimeoutMs")){long script=positive(run.get("scriptTimeoutMs"),"scriptTimeoutMs");if(script>number(policy,"maxScriptTimeoutMs")||script>Integer.MAX_VALUE)bad("脚本时限超过策略");policy.put("scriptTimeoutMs",script);sources.put("policy.scriptTimeoutMs","run");}
        sources.put("jobTimeoutMs",run.containsKey("jobTimeoutMs")?"run":sources.get("policy.defaultJobTimeoutMs"));
        var queueLimits=new LinkedHashMap<String,Object>();queueLimits.put("global",global);queueLimits.put("agent",agentQueue);queueLimits.put("project",number(policy,"maxQueuedJobs"));
        var result=new LinkedHashMap<String,Object>();result.put("policy",policy);result.put("jobTimeoutMs",timeout);result.put("configVersion",String.valueOf(saved.version()));result.put("policyVersion",revision);result.put("versions",Map.of("workspace",String.valueOf(wsSaved.version()),"project",String.valueOf(saved.version())));result.put("explicit",Map.of("workspace",wsSaved.explicit(),"project",explicit,"run",run));result.put("sources",sources);result.put("restrictions",restrictions);result.put("queueLimits",queueLimits);
        if(agent!=null){var agentValues=agentValues(agent);validateAgent(agentValues,policy);result.put("agent",agentValues);result.put("sharedDebugMaxInFlight",Math.min(number(agentValues,"sharedDebugMaxInFlight"),number(agentValues,"maxConcurrentJobs")));}
        checkRevision(revision);return result;
    }
    private void validateAgent(Map<String,Object> values,Map<String,Object> policy) {
        strict(values,ExecutionProperties.defaultAgent().keySet());
        for(var entry:values.entrySet()) {String key=entry.getKey();if(key.equals("scriptMode")){if(!Objects.equals(entry.getValue(),"deny")&&!Objects.equals(entry.getValue(),"trusted-core"))bad("scriptMode 仅支持 deny/trusted-core");}else if(key.equals("reconnectJitterRatio")){if(!(entry.getValue() instanceof Number n)||!Double.isFinite(n.doubleValue())||n.doubleValue()<0||n.doubleValue()>1)bad("重连抖动比例须在 0 至 1");}else {long n=positive(entry.getValue(),key);if(TIMERS.contains(key)&&n>Integer.MAX_VALUE)bad(key+" 超过宿主定时器范围");}}
        if(number(values,"maxConcurrentJobs")>properties.getDeployment().getMaxAgentConcurrentJobs())bad("代理并发超过部署能力上限");
        if(number(values,"longPollWaitMs")+number(values,"pollTimeoutMarginMs")>number(values,"controlRequestTimeoutMs"))bad("控制超时不足轮询等待和余量");
        if(number(values,"heartbeatIntervalMs")>=number(values,"offlineAfterMs"))bad("失联阈值须大于心跳间隔");
        if(number(values,"workerUnresponsiveAfterMs")<=number(policy,"maxScriptTimeoutMs")+number(values,"workerHeartbeatIntervalMs"))bad("worker 监督阈值须大于最大脚本时限与监督心跳之和");
        if(number(values,"reconnectMinMs")>number(values,"reconnectMaxMs")||number(values,"transferRetryMinMs")>number(values,"transferRetryMaxMs"))bad("重试最小值不得超过最大值");
        if(number(values,"inputCacheBytes")<number(policy,"totalInputBytes"))bad("输入缓存不能容纳单任务输入预算");
        if(number(values,"pendingResultBytes")<=number(values,"faultReserveBytes")+number(policy,"reportBytes"))bad("待传预算须大于故障预留与单份报告预算之和");
        if(number(values,"faultReserveBytes")/number(values,"maxConcurrentJobs")<MIN_FAULT_REPORT_BYTES)bad("故障预留须为每个并发任务保留至少1024 bytes完整故障报告预算");
    }
    public String policyVersion(){return String.valueOf(jdbc.queryForObject("SELECT version FROM execution_policy_revision WHERE id=1",Long.class));}
    /** T6 locks this after project/agent authorization, before writing a start permit in the same transaction. */
    public String lockPolicyVersion(){return String.valueOf(jdbc.queryForObject("SELECT version FROM execution_policy_revision WHERE id=1 FOR UPDATE",Long.class));}
    private void checkRevision(String expected){if(!expected.equals(policyVersion()))throw error(HttpStatus.CONFLICT,"policy_changed","策略读取期间已变化，请重新准备");}
    private static LinkedHashMap<String,String> policySources(Map<String,Object> values){var defaults=new ExecutionProperties.Policy().asMap();var sources=new LinkedHashMap<String,String>();values.forEach((key,value)->sources.put("policy."+key,Objects.equals(value,defaults.get(key))?"default":"deployment"));return sources;}
    private void bumpPolicy(){if(jdbc.update("UPDATE execution_policy_revision SET version=version+1 WHERE id=1 AND version<9223372036854775807")!=1)throw error(HttpStatus.CONFLICT,"version_exhausted","策略版本已达到上限");}
    @SuppressWarnings("unchecked") public Map<String,Object> policyForProject(long ws,long project){return (Map<String,Object>)resolve(null,ws,project,null,Map.of()).get("policy");}
    /** A delivery payload is not proof of application; T6 transports and later calls acknowledge. */
    public Map<String,Object> configurationForDelivery(long authenticatedAgent){var node=repo.require(authenticatedAgent,false);if(node.revoked())throw error(HttpStatus.UNAUTHORIZED,"unauthorized","代理身份已撤销");var saved=repo.config("agent",authenticatedAgent);return Map.of("configVersion",String.valueOf(saved.version()),"config",agentValues(saved));}
    private static void mergePolicy(Map<String,Object> policy,Map<String,Object> patch,String level,Map<String,String> sources,List<Map<String,Object>> restrictions) {
        strict(patch,policy.keySet());for(String key:patch.keySet()){if(CEILINGS.contains(key)&&positive(patch.get(key),key)>number(policy,key))bad(level+"."+key+" 超过继承上限");sources.put("policy."+key,level);}policy.putAll(patch);
        for(var pair:List.of(List.of("defaultJobTimeoutMs","maxJobTimeoutMs"),List.of("scriptTimeoutMs","maxScriptTimeoutMs")))if(number(policy,pair.get(0))>number(policy,pair.get(1))&&!patch.containsKey(pair.get(0))){policy.put(pair.get(0),policy.get(pair.get(1)));restrictions.add(Map.of("field","policy."+pair.get(0),"reason",pair.get(1),"effectiveValue",policy.get(pair.get(1))));}
        validatePolicy(policy);
    }
    private static void validatePolicy(Map<String,Object> values) {
        for(var e:values.entrySet()){if(e.getKey().equals("queueTimeoutMs")&&e.getValue()==null)continue;long n=positive(e.getValue(),e.getKey());if(TIMERS.contains(e.getKey())&&n>Integer.MAX_VALUE)bad("策略时限超过宿主定时器范围");}
        if(number(values,"reportBytes")<MIN_FAULT_REPORT_BYTES)bad("报告预算不得小于1024 bytes完整故障报告预算");
        for(var p:List.of(List.of("defaultJobTimeoutMs","maxJobTimeoutMs"),List.of("cancelGraceMs","defaultJobTimeoutMs"),List.of("scriptTimeoutMs","maxScriptTimeoutMs"),List.of("snapshotBytes","totalInputBytes"),List.of("singleAttachmentBytes","totalInputBytes"),List.of("bodyPreviewBytes","caseEvidenceBytes"),List.of("valuePreviewBytes","caseEvidenceBytes"),List.of("caseEvidenceBytes","reportBytes"),List.of("workflowMetadataBytes","reportBytes")))if(number(values,p.get(0))>number(values,p.get(1)))bad(p.get(0)+" 不得超过 "+p.get(1));
    }
    public static void strict(Map<String,?> input,Set<String> keys) {if(input==null||!keys.containsAll(input.keySet()))bad("控制配置包含未知字段或缺少配置");}
    private static long positive(Object value,String key) {if(!(value instanceof Number))bad(key+" 必须是正安全整数");var n=(Number)value;double d=n.doubleValue();if(!Double.isFinite(d)||d<=0||d!=Math.rint(d)||d>SAFE)bad(key+" 必须是正安全整数");return n.longValue();}
    private static long number(Map<String,Object> values,String key){return positive(values.get(key),key);}
    private static void bad(String message){throw error(HttpStatus.BAD_REQUEST,"validation_failed",message);}
}
