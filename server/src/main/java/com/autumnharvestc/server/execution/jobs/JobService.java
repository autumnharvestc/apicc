package com.autumnharvestc.server.execution.jobs;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import com.autumnharvestc.server.store.*;
import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.execution.agent.*;
import com.autumnharvestc.server.execution.assets.ExecutionSnapshotService;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import com.autumnharvestc.server.execution.policy.ScriptGrantService;
import com.autumnharvestc.server.execution.materials.*;
import com.autumnharvestc.server.core.Hashes;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;
import static org.springframework.http.HttpStatus.*;

/** Member intent and data paths share the same durable assignment authority. */
@Service
@Transactional
public class JobService implements AssignedMaterialAuthorizer {
    private final JobRepo repo;private final AgentRepo nodes;private final AgentService agents;
    private final ExecutionSnapshotService snapshots;private final ExecutionConfigService configs;
    private final ScriptGrantService grants;private final UserRepo users;private final ProjectCredentialService credentials;
    private final AttachmentService attachments;private final JdbcTemplate jdbc;private final ObjectProvider<RunnerPollWaiters> waiters;
    private final Clock clock;
    private final com.autumnharvestc.server.execution.ExecutionProperties properties;
    private final CoreInputValidator inputValidator;
    public JobService(JobRepo repo, AgentRepo nodes, AgentService agents, ExecutionSnapshotService snapshots,
        ExecutionConfigService configs, ScriptGrantService grants, UserRepo users,
        ProjectCredentialService credentials, AttachmentService attachments, JdbcTemplate jdbc,
        ObjectProvider<RunnerPollWaiters> waiters, ObjectProvider<Clock> clocks,
        com.autumnharvestc.server.execution.ExecutionProperties properties, CoreInputValidator inputValidator) {
        this.repo=repo; this.nodes=nodes; this.agents=agents; this.snapshots=snapshots;
        this.configs=configs; this.grants=grants; this.users=users; this.credentials=credentials;
        this.attachments=attachments; this.jdbc=jdbc; this.waiters=waiters;
        this.clock=clocks.getIfAvailable(Clock::systemUTC); this.properties=properties;
        this.inputValidator=inputValidator;
    }
    public OffsetDateTime now() { return OffsetDateTime.ofInstant(clock.instant(), ZoneOffset.UTC); }
    public Map<String,Object> submit(UserAccount caller,String ws,String project,JobDtos.Submit request){
        agents.requireExecution(caller,ws,project);validate(request);
        long w=id(ws),p=id(project),agent=id(request.agentId());
        String intentHash=repo.digest(request);var prior=repo.intent(caller.id(),p,request.intentId());
        if(prior.isPresent()){if(!prior.get().intentHash().equals(intentHash))throw error(CONFLICT,"intent_conflict","同一提交意图的固定内容已变化");return view(prior.get(),caller);}
        var snapshot=snapshots.loadAuthorized(caller,id(request.snapshotId()));var assets=snapshot.assets();
        var declared=request.preparation();
        if(!assets.workspaceId().equals(ws)||!assets.projectId().equals(project)||!declared.scope().equals(new JobDtos.Scope(ws,assets.groupId(),project)))throw error(FORBIDDEN,"snapshot_scope_mismatch","准备声明必须对应受权固定项目快照");
        if(!assets.manifestHash().equals(declared.manifestHash()))throw error(CONFLICT,"snapshot_manifest_mismatch","准备声明与固定快照清单不符");
        agents.requireUsable(request.agentId(),ws,project);configs.lockPolicyVersion();
        var effective=configs.effective(agent,w,p,timeouts(request.runConfig()));
        String grant=grants.authorizePrepared(caller,request.agentId(),snapshot,declared.scriptRequirements(),declared.scriptPlanDigest());
        if(!Objects.equals(grant,declared.scriptGrantVersion()))throw error(CONFLICT,"script_grant_changed","准备声明批准版本已变化");
        long inputBytes=materialBytes(snapshot,request.materials(),policy(effective),request.network());
        if(inputBytes>number(configs.agentValues(agent),"inputCacheBytes"))throw error(CONFLICT,"input_capacity","固定输入超过代理缓存容量");
        checkQueue(agent,p,effective);
        long job=repo.nextId(),execution=repo.nextId();var task=new LinkedHashMap<String,Object>();
        task.put("protocolVersion",1);task.put("jobId",String.valueOf(job));task.put("executionId",String.valueOf(execution));task.put("scope",declared.scope());task.put("submittedByUserId",String.valueOf(caller.id()));task.put("contractProjectId",assets.contractProjectId());task.put("snapshotId",snapshot.snapshotId());task.put("manifestHash",assets.manifestHash());task.put("target",request.target());
        if(request.environmentId()!=null)task.put("environmentId",request.environmentId());
        if(request.target().path("kind").asText().equals("debug"))task.put("debugSessionId",debugSession(caller,w,p,agent,request.debugSessionId(),effective));
        task.put("policyVersion",effective.get("policyVersion"));task.put("requiredCoreBuildId",declared.requiredCoreBuildId());task.put("executionProfile",declared.executionProfile());task.put("dispatchKind",declared.dispatchKind());task.put("scriptPlanDigest",declared.scriptPlanDigest());if(grant!=null)task.put("scriptGrantVersion",grant);task.put("requiredCapabilities",declared.requiredCapabilities());task.put("runtimeCompatibilityId",declared.runtimeCompatibilityId());
        var inputs=new LinkedHashMap<String,Object>();inputs.put("executionId",String.valueOf(execution));inputs.put("snapshot",snapshot);inputs.put("runConfig",runValues(request.runConfig()));inputs.put("materials",request.materials());inputs.put("policy",policy(effective));if(request.network()!=null)inputs.put("network",request.network());String digest=repo.digest(inputs);inputs.put("inputsDigest",digest);
        var policy=policy(effective);var queueTimeout=policy.get("queueTimeoutMs");OffsetDateTime expires=queueTimeout==null?null:now().plusNanos((((Number)queueTimeout).longValue()%1000)*1000000).plusSeconds(((Number)queueTimeout).longValue()/1000);
        repo.insert(job,execution,w,p,caller.id(),agent,id(snapshot.snapshotId()),request.intentId(),intentHash,request,task,inputs,digest,expires);wake(agent);return view(repo.require(job,false),caller);
    }
    private void validate(JobDtos.Submit s){
        if(s==null||s.preparation()==null||s.preparation().scope()==null||s.runConfig()==null||s.materials()==null||s.target()==null||!s.target().isObject())bad("固定目标、准备声明、运行设置和材料清单必填");
        opaque(s.intentId());id(s.agentId());id(s.snapshotId());var p=s.preparation();id(p.scope().workspaceId());id(p.scope().groupId());id(p.scope().projectId());hash(p.manifestHash());hash(p.scriptPlanDigest());hash(p.requiredCoreBuildId());opaque(p.runtimeCompatibilityId());
        if(!Set.of("no-script","trusted-core-script").contains(p.executionProfile()==null?"":p.executionProfile())||!Set.of("shared-debug","dedicated-task").contains(p.dispatchKind()==null?"":p.dispatchKind())||p.scriptRequirements()==null||p.requiredCapabilities()==null)bad("执行档位和依赖声明无效");
        if(new HashSet<>(p.requiredCapabilities()).size()!=p.requiredCapabilities().size())bad("能力声明不能重复");p.requiredCapabilities().forEach(JobService::opaque);
        if(p.executionProfile().equals("trusted-core-script")){version(p.scriptGrantVersion());if(p.scriptRequirements().isEmpty())bad("受信脚本档位需要实际脚本声明");}else if(!p.scriptRequirements().isEmpty()||p.scriptGrantVersion()!=null)bad("无脚本档位不能声明脚本或批准");
        String kind=s.target().path("kind").asText();
        inputValidator.requireValid(s.target(), repo.parse(repo.encode(runValues(s.runConfig()))));
        if(p.dispatchKind().equals("shared-debug")&&(!kind.equals("debug")||!p.executionProfile().equals("no-script")))bad("共享调用只支持无脚本调试");
        if(s.debugSessionId()!=null&&!kind.equals("debug"))bad("仅调试支持会话句柄");if(s.environmentId()!=null)uuid(s.environmentId());
    }
    public Map<String,Object> detail(UserAccount caller, String job) {
        var status = repo.status(id(job));
        agents.requireProject(caller, String.valueOf(status.workspace()), String.valueOf(status.project()), false);
        return view(status,caller);
    }
    public List<Map<String,Object>> list(UserAccount caller, String ws, String project, Integer requestedLimit, String beforeJobId) {
        agents.requireProject(caller, ws, project, false);
        var paging = properties.getJobs();
        int limit = requestedLimit == null ? Math.min(paging.getDefaultPageSize(), paging.getMaxPageSize()) : requestedLimit;
        if (limit < 1 || limit > paging.getMaxPageSize()) bad("任务分页大小必须在 1 至配置上限之间");
        Long before = beforeJobId == null ? null : id(beforeJobId);
        return repo.statuses(id(project), limit, before).stream().map(status->view(status,caller)).toList();
    }
    public Map<String,Object> cancel(UserAccount caller,String job){var j=repo.require(id(job),false);agents.requireExecution(caller,String.valueOf(j.workspace()),String.valueOf(j.project()));nodes.require(j.agent(),true);j=repo.require(j.id(),true);
        if(!agents.canCancel(caller,String.valueOf(j.workspace()),String.valueOf(j.project()),j.user()))throw error(FORBIDDEN,"forbidden","仅提交者本人或有效项目 OWNER/ADMIN 可取消任务");
        if(j.state().equals("queued")){end(j,Map.of("verdict","cancelled","executionReleased",true,"evidenceComplete",true,"reasonCode","cancelled-before-assignment"),null,null,true);}else if(!j.state().equals("ended")){repo.requestCancel(j);var command=identity(j,"cancel-"+j.execution(),"cancel");command.put("reason","用户已申请取消");repo.outbox(j.agent(),j.id(),j.execution(),"cancel",(String)command.get("messageId"),command);}wake(j.agent());return view(repo.require(j.id(),false),caller);}
    /** Data authority for snapshots/materials. Stopping intake does not revoke an existing assignment. */
    public JobRepo.Job lockAssignment(long agent,long job,long execution,boolean currentExecutionRights){
        return lockAssignment(agent,job,execution,currentExecutionRights,false);
    }
    public JobRepo.Job lockStartAssignment(long agent,long job,long execution){return lockAssignment(agent,job,execution,false,true);}
    private JobRepo.Job lockAssignment(long agent,long job,long execution,boolean currentExecutionRights,boolean policyLock){
        var j=repo.require(job,false);if(j.agent()!=agent||j.execution()!=execution||j.state().equals("queued"))throw error(FORBIDDEN,"assignment_required","任务未分配给当前代理及执行批次");
        if(currentExecutionRights){var caller=currentUser(j);agents.requireExecution(caller,String.valueOf(j.workspace()),String.valueOf(j.project()));}
        else jdbc.queryForList("SELECT id FROM projects WHERE id=? FOR UPDATE",j.project());
        if(nodes.require(agent,true).revoked())throw error(UNAUTHORIZED,"unauthorized","代理身份已撤销");
        if(policyLock)configs.lockPolicyVersion();
        j=repo.require(job,true);if(j.agent()!=agent||j.execution()!=execution||j.state().equals("queued"))throw error(FORBIDDEN,"assignment_required","当前分配已变化");return j;
    }
    public UserAccount currentUser(JobRepo.Job j){return users.findById(j.user()).filter(u->!u.disabled()).orElseThrow(()->error(FORBIDDEN,"submitter_unavailable","提交者已停用或不存在"));}
    @Override public AuthorizedMaterials requireAssigned(long agent,long job,long execution){
        if(repo.find(job).isEmpty())throw error(FORBIDDEN,"assignment_required","任务未分配给当前代理");
        var j=lockAssignment(agent,job,execution,true);if(j.state().equals("ended"))throw error(FORBIDDEN,"assignment_required","已结束执行不能重新取得运行材料");
        if(!nodes.granted(agent,j.workspace())||!nodes.allocated(agent,j.workspace(),j.project())||!nodes.associated(agent,j.project()))throw error(FORBIDDEN,"assignment_required","项目代理授权已撤销");
        var snapshot=snapshots.loadAuthorized(currentUser(j),j.snapshot());return new AuthorizedMaterials(snapshot,submission(j).materials());
    }
    public Map<String,Object> inputs(long agent,String job,String execution){var j=lockAssignment(agent,id(job),id(execution),true);requireAssigned(agent,j.id(),j.execution());return repo.map(repo.inputs(j.id()));}
    public Map<String,Object> upload(long agent,String job,String execution,String hash,byte[] bytes){
        var j=lockAssignment(agent,id(job),id(execution),false);hash(hash);if(bytes==null||!Hashes.sha256Hex(bytes).equals(hash))throw error(CONFLICT,"report_digest_mismatch","报告内容与摘要不符");
        if((j.reportHash()!=null&&!j.reportHash().equals(hash))||(j.reportBytes()!=null&&j.reportBytes()!=bytes.length))throw error(CONFLICT,"report_conflict","报告摘要或长度与完成摘要不符");
        if(j.reportState().equals("expired"))return Map.of("archived",true,"reportHash",hash,"reportBytes",bytes.length);
        var fixed=j.permit()==null?configs.effective(j.agent(),j.workspace(),j.project(),timeouts(submission(j).runConfig())):null;
        long limit=j.permit()==null?number(policy(fixed),"reportBytes"):j.permit().path("effectivePolicy").path("reportBytes").asLong();
        if(bytes.length>limit)throw error(BAD_REQUEST,"report_size_limit","报告超过本次固定预算");
        // Both actual bytes and immutable stored hash/length were checked above; no BLOB read on retry.
        if(!j.reportState().equals("archived")) repo.archive(j,hash,bytes,now());
        return Map.of("archived",true,"reportHash",hash,"reportBytes",bytes.length);
    }
    public byte[] report(UserAccount caller,String job){
        var status=repo.status(id(job));
        agents.requireProject(caller,String.valueOf(status.workspace()),String.valueOf(status.project()),false);
        if(status.reportState().equals("expired"))throw error(GONE,"report_expired","报告保留期已结束；执行身份与归档确认仍保留");
        if(!status.reportState().equals("archived"))throw error(CONFLICT,"report_pending","结果仍待归档");
        return repo.reportContent(status.id());
    }
    public JobDtos.Submit submission(JobRepo.Job j){return repo.decode(j.submission(),JobDtos.Submit.class);}
    public long materialBytes(ExecutionSnapshot fixed,MaterialSelection selection,Map<String,Object> policy){
        return materialBytes(fixed,selection,policy,null);
    }
    public long materialBytes(ExecutionSnapshot fixed,MaterialSelection selection,Map<String,Object> policy,JsonNode network){
        if(selection==null||!Objects.equals(selection.projectId(),fixed.assets().projectId())||selection.credentials()==null||selection.attachments()==null)throw error(FORBIDDEN,"materials_scope_mismatch","材料选择必须来自固定项目");
        long ws=id(fixed.assets().workspaceId()),project=id(fixed.assets().projectId()),total=0,limit=number(policy,"totalInputBytes");var refs=new HashSet<String>();
        for(var file:fixed.assets().files())total=add(total,file.size(),limit);
        for(var ref:selection.credentials()){if(ref==null||!refs.add(ref.refId()))bad("凭据声明重复或为空");id(ref.version());var value=credentials.resolveAuthorized(ws,project,ref);total=add(total,value.value().getBytes(StandardCharsets.UTF_8).length,limit);}
        var mapping=selection.attachmentPaths()==null?Map.<String,AttachmentSelection>of():selection.attachmentPaths();
        for(var entry:mapping.entrySet()){
            String path=entry.getKey();if(path==null||path.isEmpty()||path.startsWith("/")||path.contains("\\")||path.contains(":")||path.chars().anyMatch(c->c<32)||Arrays.stream(path.split("/",-1)).anyMatch(segment->segment.isEmpty()||segment.equals(".")||segment.equals("..")))bad("附件映射需要规范项目相对路径");
            if(entry.getValue()==null||!selection.attachments().contains(entry.getValue()))bad("附件路径映射必须引用完全一致的固定附件");
        }
        refs.clear();for(var ref:selection.attachments()){if(ref==null||!refs.add(ref.refId()))bad("附件声明重复或为空");var value=attachments.resolveAuthorized(ws,project,ref);if(value.size()>number(policy,"singleAttachmentBytes"))bad("附件超过当前有效额度");long copies=Math.max(1,mapping.values().stream().filter(ref::equals).count());for(long copy=0;copy<copies;copy++)total=add(total,value.size(),limit);}
        if(network!=null){if(!network.isObject())bad("网络固定输入必须为对象");fields(network,Set.of("revision","configuration","selection"));if(!network.path("revision").isTextual()||!network.path("configuration").isObject()||network.has("selection")&&!network.path("selection").isObject())bad("网络固定输入边界无效");opaque(network.path("revision").asText());total=add(total,repo.encode(network).getBytes(StandardCharsets.UTF_8).length,limit);}
        return total;
    }
    /** Only a first claim may add host authorization metadata; data GET never mutates fixed input. */
    public void fixClaimInputs(JobRepo.Job j,String hostSessionId,String serverId,Map<String,Object> policy){
        var inputs=repo.map(repo.inputs(j.id()));inputs.remove("inputsDigest");
        if(!repo.parse(repo.encode(policy)).equals(repo.parse(repo.encode(inputs.get("policy")))))throw error(CONFLICT,"policy_changed","排队任务准备策略已变化，请重新准备");
        if(j.task().has("debugSessionId")){
            assertDebugSession(j);String handle=j.task().get("debugSessionId").asText();
            var bindings=jdbc.queryForMap("SELECT host_session_id,server_id FROM execution_debug_sessions WHERE handle=? FOR UPDATE",handle);
            String bound=(String)bindings.get("host_session_id"),boundServer=(String)bindings.get("server_id");
            if(bound!=null&&(!bound.equals(hostSessionId)||!serverId.equals(boundServer)))throw error(CONFLICT,"debug_session_expired","调试会话属于旧宿主或服务身份，请显式开始新会话");
            if(bound==null)jdbc.update("UPDATE execution_debug_sessions SET host_session_id=?,server_id=? WHERE handle=? AND host_session_id IS NULL",hostSessionId,serverId,handle);
            // A claimed job is an authoritative active reference. The old idle deadline is not
            // an expiry for this invocation; the handle covers its bounded active lifetime.
            var node=configs.agentValues(j.agent());
            var expires=now().plus(Duration.ofMillis(number(policy,"maxJobTimeoutMs"))).plus(Duration.ofMillis(number(node,"debugSessionIdleMs")));
            var authorized=new LinkedHashMap<String,Object>();authorized.put("debugSessionId",handle);authorized.put("serverId",serverId);authorized.put("scope",j.task().get("scope"));authorized.put("submittedByUserId",String.valueOf(j.user()));authorized.put("agentId",String.valueOf(j.agent()));authorized.put("expiresAt",expires.toInstant().toString());authorized.put("hostSessionId",hostSessionId);inputs.put("debugSession",authorized);
        }
        String digest=repo.digest(inputs);inputs.put("inputsDigest",digest);jdbc.update("UPDATE execution_jobs SET inputs_json=?,inputs_digest=? WHERE id=? AND state='queued'",repo.encode(inputs),digest,j.id());
    }
    public Map<String,String> credentialVersions(JobRepo.Job j){var versions=new LinkedHashMap<String,String>();for(var selected:submission(j).materials().credentials())versions.put(selected.refId(),selected.version());return versions;}
    private long add(long total,long bytes,long limit){if(bytes<0||bytes>limit-total)throw error(BAD_REQUEST,"total_input_size_limit","固定快照和材料超过合计输入额度");return total+bytes;}
    private void checkQueue(long agent,long project,Map<String,Object> effective){var q=cast(effective.get("queueLimits"));if(repo.queuedCount(null,null)>=number(q,"global")||repo.queuedCount(agent,null)>=number(q,"agent")||repo.queuedCount(null,project)>=number(q,"project"))throw error(CONFLICT,"queue_capacity","排队任务已达到当前有效额度");}
    private String debugSession(UserAccount caller,long ws,long project,long agent,String handle,Map<String,Object> effective){
        var config=cast(effective.get("agent"));
        var now=now();
        var active=repo.activeDebugSessions(agent);
        if(handle!=null){
            opaque(handle);
            requireDebugSession(ws,project,caller.id(),agent,handle,active,now);
            return handle;
        }
        var live=new HashSet<>(active);
        live.addAll(jdbc.query("SELECT handle FROM execution_debug_sessions WHERE agent_id=? AND expires_at>?",
            (r,n)->r.getString(1),agent,now));
        if(live.size()>=number(config,"maxDebugSessions"))throw error(CONFLICT,"debug_session_capacity","调试会话已达容量");
        String fresh=UUID.randomUUID().toString();
        jdbc.update("INSERT INTO execution_debug_sessions(handle,workspace_id,project_id,owner_id,agent_id,expires_at) VALUES(?,?,?,?,?,?)",
            fresh,ws,project,caller.id(),agent,now.plus(Duration.ofMillis(number(config,"debugSessionIdleMs"))));
        return fresh;
    }
    private void requireDebugSession(long ws,long project,long owner,long agent,String handle,Set<String> active,OffsetDateTime now){
        var deadlines=jdbc.query("SELECT expires_at FROM execution_debug_sessions WHERE handle=? AND workspace_id=? AND project_id=? AND owner_id=? AND agent_id=?",
            (r,n)->r.getObject(1,OffsetDateTime.class),handle,ws,project,owner,agent);
        if(deadlines.isEmpty()||(!active.contains(handle)&&!deadlines.getFirst().isAfter(now)))
            throw error(CONFLICT,"debug_session_expired","调试会话不存在、过期或绑定不符，请显式开始新会话");
    }
    public void assertDebugSession(JobRepo.Job j){
        if(j.task().has("debugSessionId"))requireDebugSession(j.workspace(),j.project(),j.user(),j.agent(),
            j.task().get("debugSessionId").asText(),repo.activeDebugSessions(j.agent()),now());
    }
    /** The conditional end is the single release point; receipt retries cannot renew the idle deadline. */
    public void end(JobRepo.Job j,Object summary,String hash,Long bytes,boolean cancelled){
        repo.end(j,summary,hash,bytes,cancelled);
        if(!j.task().has("debugSessionId"))return;
        String handle=j.task().get("debugSessionId").asText();
        if(repo.activeDebugSessions(j.agent()).contains(handle))return;
        long idle=number(configs.agentValues(j.agent()),"debugSessionIdleMs");
        jdbc.update("UPDATE execution_debug_sessions SET expires_at=? WHERE handle=? AND agent_id=?",
            now().plus(Duration.ofMillis(idle)),handle,j.agent());
    }
    private Map<String,Object> view(JobRepo.Job j,UserAccount caller){
        return view(new JobRepo.Status(j.id(),j.execution(),j.workspace(),j.project(),j.agent(),j.user(),j.state(),
            j.cancelState(),j.released(),j.reportState(),j.task(),j.progress(),j.summary(),j.permit()),caller);
    }
    private Map<String,Object> view(JobRepo.Status status,UserAccount caller){
        var result=new LinkedHashMap<String,Object>();
        result.put("jobId",String.valueOf(status.id()));result.put("executionId",String.valueOf(status.execution()));
        result.put("agentId",String.valueOf(status.agent()));result.put("state",status.state());
        result.put("cancelState",status.cancelState());result.put("executionReleased",status.released());
        result.put("reportState",status.reportState());result.put("task",status.task());
        result.put("canCancel",!status.state().equals("ended")&&status.cancelState().equals("none")
            &&agents.canCancel(caller,String.valueOf(status.workspace()),String.valueOf(status.project()),status.user()));
        if(status.permit()!=null&&status.permit().path("effectivePolicy").path("scriptTimeoutMs").isIntegralNumber())
            result.put("scriptTimeoutMs",status.permit().path("effectivePolicy").path("scriptTimeoutMs").longValue());
        if(status.summary()!=null)result.put("summary",status.summary());
        if(status.progress()!=null)result.put("progress",status.progress());
        return result;
    }
    public void wake(long agent){if(TransactionSynchronizationManager.isSynchronizationActive())TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization(){@Override public void afterCommit(){waiters.getObject().wake(agent);}});else waiters.getObject().wake(agent);}
    public static Map<String,Object> identity(JobRepo.Job j,String message,String kind){var result=new LinkedHashMap<String,Object>();result.put("messageId",message);result.put("jobId",String.valueOf(j.id()));result.put("executionId",String.valueOf(j.execution()));result.put("kind",kind);return result;}
    public static Map<String,Object> timeouts(JobDtos.RunConfig run){var result=new LinkedHashMap<String,Object>();if(run!=null){if(run.jobTimeoutMs()!=null)result.put("jobTimeoutMs",run.jobTimeoutMs());if(run.scriptTimeoutMs()!=null)result.put("scriptTimeoutMs",run.scriptTimeoutMs());}return result;}
    private static Map<String,Object> runValues(JobDtos.RunConfig run){var result=timeouts(run);if(run.requestSettings()!=null)result.put("requestSettings",run.requestSettings());return result;}
    @SuppressWarnings("unchecked") public static Map<String,Object> cast(Object value){return (Map<String,Object>)value;}
    public static Map<String,Object> policy(Map<String,Object> effective){return cast(effective.get("policy"));}
    public static long number(Map<String,Object> values,String key){return ((Number)values.get(key)).longValue();}
    public static void fields(JsonNode node,Set<String> allowed){node.fieldNames().forEachRemaining(k->{if(!allowed.contains(k))bad("控制字段包含未知字段: "+k);});}
    public static void hash(String value){if(value==null||!value.matches("[a-f0-9]{64}"))bad("摘要必须为 SHA-256");}
    public static void opaque(String value){if(value==null||value.isBlank()||value.length()>512)bad("消息或意图身份无效");}
    private static void uuid(String value){try{if(!UUID.fromString(value).toString().equalsIgnoreCase(value))bad("目标 ID 必须为 UUID");}catch(Exception e){bad("目标 ID 必须为 UUID");}}
    public static void bad(String reason){throw error(BAD_REQUEST,"validation_failed",reason);}
}
