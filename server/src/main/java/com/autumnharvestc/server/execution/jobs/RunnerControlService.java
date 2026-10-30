package com.autumnharvestc.server.execution.jobs;

import com.fasterxml.jackson.databind.JsonNode;
import com.autumnharvestc.server.execution.agent.*;
import com.autumnharvestc.server.execution.assets.ExecutionSnapshotService;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import com.autumnharvestc.server.execution.policy.ScriptGrantService;
import com.autumnharvestc.server.execution.materials.ProjectCredentialService;
import com.autumnharvestc.server.core.ApiException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import java.time.*;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;
import static com.autumnharvestc.server.execution.jobs.JobService.*;
import static org.springframework.http.HttpStatus.*;

/** Idempotent business messages; acknowledgement is never permission to invoke Core. */
@Service
@Transactional
public class RunnerControlService {
    private static final Set<String> START_REJECTIONS=Set.of("submitter_unavailable","forbidden","project_forbidden","agent_unavailable","agent_not_associated","script_mode_denied","script_grant_missing","script_grant_changed","credential_version_conflict","credential_missing","policy_changed","agent_capacity","shared_capacity","resource_capacity","debug_session_expired","schedule-subject-unavailable","schedule-subject-unauthorized","schedule-queue-expired");
    private final JobRepo repo;private final JobService jobs;private final AgentRepo nodes;private final AgentService agents;
    private final ExecutionConfigService configs;private final ExecutionSnapshotService snapshots;private final ScriptGrantService grants;
    private final ProjectCredentialService credentials;private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final StressResourceReservations stressResources;
    private final com.autumnharvestc.server.execution.ExecutionProperties properties;
    public RunnerControlService(JobRepo repo,JobService jobs,AgentRepo nodes,AgentService agents,ExecutionConfigService configs,ExecutionSnapshotService snapshots,ScriptGrantService grants,ProjectCredentialService credentials,JdbcTemplate jdbc,PlatformTransactionManager manager,com.autumnharvestc.server.execution.ExecutionProperties properties,StressResourceReservations stressResources){this.repo=repo;this.jobs=jobs;this.nodes=nodes;this.agents=agents;this.configs=configs;this.snapshots=snapshots;this.grants=grants;this.credentials=credentials;this.jdbc=jdbc;this.transactions=new TransactionTemplate(manager);this.properties=properties;this.stressResources=stressResources;}
    public Map<String,Object> runtime(long agent,JobDtos.RuntimeRegistration value){
        String serverId=properties.requireControlBaseUrl();
        if(nodes.require(agent,true).revoked())throw error(UNAUTHORIZED,"unauthorized","代理身份已撤销");
        if(value==null||!Objects.equals(value.protocolVersion(),1L))bad("运行协议版本无效");
        opaque(value.sessionId());hash(value.coreBuildId());hash(value.scriptApiId());opaque(value.nodeVersion());opaque(value.v8Version());opaque(value.runtimeCompatibilityId());
        String script="afaf628a48532cff1e1e9264f328830ea1678b877853e324bab040039d0721d0";
        if(!value.nodeVersion().equals("22.19.0")||!value.v8Version().equals("12.4.254.21-node.29")||!value.scriptApiId().equals(script)||!value.runtimeCompatibilityId().equals("node-"+value.nodeVersion()+"-v8-"+value.v8Version()+"-script-"+script))throw error(CONFLICT,"runtime_unsupported","运行时组合未经兼容验证");
        var allowed=Set.of("task:debug","task:suite","task:workflow","task:stress","stress:local-workers-v1","protocol:http","protocol:soap","protocol:websocket","script:trusted-core");
        if(value.capabilities()==null||value.capabilities().isEmpty()||!allowed.containsAll(value.capabilities())||new HashSet<>(value.capabilities()).size()!=value.capabilities().size())bad("运行能力声明无效");
        var state=value.configuration();if(state==null)bad("配置应用状态必填");version(state.configVersion());version(state.appliedConfigVersion());
        if(state.pendingFields()==null||state.restartRequiredFields()==null||!Set.of("applied","pending","restart-required").contains(state.status())||version(state.appliedConfigVersion())>version(state.configVersion())||!com.autumnharvestc.server.execution.ExecutionProperties.defaultAgent().keySet().containsAll(state.pendingFields())||!state.pendingFields().containsAll(state.restartRequiredFields())||new HashSet<>(state.pendingFields()).size()!=state.pendingFields().size()||new HashSet<>(state.restartRequiredFields()).size()!=state.restartRequiredFields().size())bad("配置应用状态无效");
        if(state.status().equals("applied")&&(!state.configVersion().equals(state.appliedConfigVersion())||!state.pendingFields().isEmpty()||!state.restartRequiredFields().isEmpty())||state.status().equals("restart-required")&&state.restartRequiredFields().isEmpty())bad("配置应用状态与字段不一致");
        var current=jdbc.query("SELECT description_json FROM execution_agent_runtime WHERE agent_id=?",(r,n)->repo.parse(r.getString(1)),agent);
        if(!current.isEmpty()&&current.getFirst().path("sessionId").asText().equals(value.sessionId())){
            var before=repo.map(current.getFirst());var after=repo.map(repo.parse(repo.encode(value)));before.remove("configuration");after.remove("configuration");if(!before.equals(after))throw error(CONFLICT,"runtime_session_conflict","同一宿主会话的运行身份不可改变");
        }
        if(jdbc.update("UPDATE execution_agent_runtime SET session_id=?,description_json=? WHERE agent_id=?",value.sessionId(),repo.encode(value),agent)==0)jdbc.update("INSERT INTO execution_agent_runtime(agent_id,session_id,description_json) VALUES(?,?,?)",agent,value.sessionId(),repo.encode(value));
        if(Objects.equals(configs.configurationForDelivery(agent).get("configVersion"),state.configVersion()))configs.acknowledge(agent,state.configVersion(),state.appliedConfigVersion(),state.pendingFields(),state.restartRequiredFields());
        return Map.of("registered",true,"sessionId",value.sessionId(),"serverId",serverId,"configuration",configs.configurationForDelivery(agent));
    }
    private JsonNode runtimeDescription(long agent){return jdbc.query("SELECT description_json FROM execution_agent_runtime WHERE agent_id=?",(r,n)->repo.parse(r.getString(1)),agent).stream().findFirst().orElseThrow(()->error(CONFLICT,"runtime_required","代理尚未登记实际运行身份"));}
    private JsonNode assertRuntime(JobRepo.Job job){
        var actual=runtimeDescription(job.agent());var task=job.task();var capabilities=new HashSet<String>();actual.path("capabilities").forEach(value->capabilities.add(value.asText()));
        if(!task.path("requiredCoreBuildId").asText().equals(actual.path("coreBuildId").asText())||!task.path("runtimeCompatibilityId").asText().equals(actual.path("runtimeCompatibilityId").asText()))throw error(CONFLICT,"runtime_mismatch","任务需要的运行身份与实际代理不符");
        for(var capability:task.path("requiredCapabilities"))if(!capabilities.contains(capability.asText()))throw error(CONFLICT,"runtime_capability_missing","代理缺少任务需要的能力");
        return actual;
    }
    public long pollWaitMs(long agent){return number(configs.agentValues(agent),"longPollWaitMs");}
    @Transactional(propagation=Propagation.NOT_SUPPORTED)
    public JobDtos.Batch exchange(long agent,JobDtos.Exchange request){
        validateExchange(request);
        var runtime=runtimeDescription(agent);if(!runtime.path("sessionId").asText().equals(request.sessionId()))throw error(CONFLICT,"runtime_session_mismatch","控制会话与登记运行身份不符");
        // The short control transaction ends before any project claim. A nested business denial
        // must not mark the whole exchange rollback-only or retain an agent lock across projects.
        transactions.executeWithoutResult(status->{
            if(nodes.require(agent,true).revoked())throw error(UNAUTHORIZED,"unauthorized","代理身份已撤销");
            repo.ack(agent,request.acknowledgements());var delivery=configs.configurationForDelivery(agent);String configVersion=(String)delivery.get("configVersion");String configMessage="config-"+agent+"-"+configVersion;
            if(!configVersion.equals(request.appliedConfigVersion())){var command=new LinkedHashMap<String,Object>();command.put("messageId",configMessage);command.put("kind","apply-config");command.putAll(delivery);repo.outbox(agent,null,null,"apply-config",configMessage,command);repo.redeliverConfig(agent,configMessage);}
            else if(!configVersion.equals("0")&&runtime.path("configuration").path("status").asText().equals("applied")&&runtime.path("configuration").path("appliedConfigVersion").asText().equals(configVersion)){repo.ack(agent,List.of(configMessage));}
            if(jdbc.update("UPDATE execution_agent_control_state SET session_id=?,last_seen=CURRENT_TIMESTAMP,applied_config_version=? WHERE agent_id=?",request.sessionId(),request.appliedConfigVersion(),agent)==0)jdbc.update("INSERT INTO execution_agent_control_state(agent_id,session_id,applied_config_version) VALUES(?,?,?)",agent,request.sessionId(),request.appliedConfigVersion());
        });
        boolean applied=runtime.path("configuration").path("status").asText().equals("applied")&&Objects.equals(configs.configurationForDelivery(agent).get("configVersion"),runtime.path("configuration").path("appliedConfigVersion").asText());
        long remaining=applied?request.availableSlots():0,shared=applied?request.availableSharedDebugSlots():0;
        for(var candidate:repo.queued(agent)){
            // Expiry consumes no business slot, even when all workers are busy or intake stopped.
            if(jobs.queueExpired(candidate)){
                transactions.executeWithoutResult(status->expireQueued(candidate));
                continue;
            }
            if(remaining<=0)continue;
            boolean sharedTask=candidate.task().path("dispatchKind").asText().equals("shared-debug");
            if(sharedTask&&shared<=0)continue;
            try{
                int claimed=Objects.requireNonNull(transactions.execute(status->claim(candidate,sharedTask)));
                if(claimed<0){remaining=0;continue;}
                if(claimed>0){remaining--;if(sharedTask)shared--;}
            }catch(ApiException e){
                // Intake stopped is a pause; scope/permission revocation is an explicit durable rejection.
                if(e.getCode().equals("agent_unavailable"))continue;
                transactions.executeWithoutResult(status->{jdbc.queryForList("SELECT id FROM projects WHERE id=? FOR UPDATE",candidate.project());nodes.require(agent,true);configs.lockPolicyVersion();var current=repo.require(candidate.id(),true);if(current.state().equals("queued")&&current.agent()==agent&&current.execution()==candidate.execution())rejectQueued(current,e.getCode(),e.getMessage());});
            }
        }
        return new JobDtos.Batch(repo.pending(agent,"delivery"),repo.pending(agent,"command"));
    }
    private void expireQueued(JobRepo.Job candidate){
        jdbc.queryForList("SELECT id FROM projects WHERE id=? FOR UPDATE",candidate.project());
        nodes.require(candidate.agent(),true);
        configs.lockPolicyVersion();
        var current=repo.require(candidate.id(),true);
        if(current.state().equals("queued")&&current.agent()==candidate.agent()
            &&current.execution()==candidate.execution()&&jobs.queueExpired(current)){
            rejectQueued(current,"queue_timeout","排队等待已达到固定期限");
        }
    }
    private int claim(JobRepo.Job candidate,boolean sharedTask){
        var caller=jobs.currentUser(candidate);long agent=candidate.agent();
        agents.requireExecution(caller,String.valueOf(candidate.workspace()),String.valueOf(candidate.project()));agents.requireUsable(String.valueOf(agent),String.valueOf(candidate.workspace()),String.valueOf(candidate.project()));configs.lockPolicyVersion();var j=repo.require(candidate.id(),true);if(!j.state().equals("queued"))return 0;
        if(jobs.queueExpired(j)){rejectQueued(j,"queue_timeout","排队等待已达到固定期限");return 0;}
        var effective=configs.effective(agent,j.workspace(),j.project(),timeouts(jobs.submission(j).runConfig()));var node=cast(effective.get("agent"));
        var actual=assertRuntime(j);
        if(!j.task().path("policyVersion").asText().equals(effective.get("policyVersion")))throw error(CONFLICT,"policy_changed","排队任务的固定策略版本已变化，请重新准备");
        if(repo.occupied(agent)>=number(node,"maxConcurrentJobs"))return -1;
        if(sharedTask&&repo.sharedOccupied(agent)>=number(node,"sharedDebugMaxInFlight"))return 0;
        var submission=jobs.submission(j);
        if(StressResourceReservations.isStress(submission)){
            stressResources.validate(submission,effective,agent);
            String reason=stressResources.blockingReason(agent,submission.preparation().stressBinding().path("reservation"),node);
            if(reason!=null){stressResources.waitReason(j,reason);return 0;}
        }
        stressResources.waitReason(j,null);
        var fixed=snapshots.loadAuthorized(caller,j.snapshot());long input=jobs.materialBytes(fixed,jobs.submission(j).materials(),policy(effective),jobs.submission(j).network());long result=number(policy(effective),"reportBytes");
        if(input>number(node,"inputCacheBytes")-repo.reserved(agent,"input")){stressResources.waitReason(j,"cache.input");return 0;}
        if(result>number(node,"pendingResultBytes")-number(node,"faultReserveBytes")-repo.reserved(agent,"result")){stressResources.waitReason(j,"cache.result");return 0;}
        jobs.fixClaimInputs(j,actual.path("sessionId").asText(),properties.requireControlBaseUrl(),policy(effective));
        if(!repo.claim(j,input,result))return 0;
        if(StressResourceReservations.isStress(submission)){stressResources.reserve(j,submission.preparation().stressBinding().path("reservation"));stressResources.fixMetadata(j,actual);}
        jdbc.update("UPDATE execution_jobs SET runtime_session_id=?,capacity_wait_reason=NULL WHERE id=?",actual.path("sessionId").asText(),j.id());var payload=Map.<String,Object>of("messageId",JobRepo.deliveryId(j),"task",j.task());repo.outbox(agent,j.id(),j.execution(),"delivery",JobRepo.deliveryId(j),payload);return 1;
    }
    private void rejectQueued(JobRepo.Job j,String reason,String description){jobs.end(j,Map.of("verdict","rejected","reasonCode",reason,"reason",description,"executionReleased",true,"evidenceComplete",true),null,null,false);}
    @Transactional(propagation=Propagation.NOT_SUPPORTED)
    public Map<String,Object> messages(long agent,JsonNode messages){
        if(messages==null||!messages.isArray()||messages.size()>1000)bad("控制消息必须是有界数组");
        for(var message:messages)validateMessage(message);
        // Each receipt and its state transition commit together. A later denial can fail the
        // HTTP batch; retrying already committed items is safe via their durable receipts.
        var acknowledged=new ArrayList<String>();for(var message:messages){
            try{transactions.executeWithoutResult(status->{process(agent,message);jobs.wake(agent);});}
            catch(ApiException denied){
                if(!message.path("kind").asText().equals("start-request")||!START_REJECTIONS.contains(denied.getCode()))throw denied;
                // The failed authorization transaction has fully rolled back before recording a refusal.
                transactions.executeWithoutResult(status->recordStartRejection(agent,message,denied));
            }
            acknowledged.add(message.get("messageId").asText());
        }return Map.of("acknowledged",acknowledged);
    }
    private void recordStartRejection(long agent,JsonNode message,ApiException denied){
        var j=jobs.lockStartAssignment(agent,id(message.path("jobId").asText()),id(message.path("executionId").asText()));
        String messageId=message.path("messageId").asText(),hash=repo.digest(message),prior=repo.receipt(agent,messageId);
        if(prior!=null){if(!prior.equals(hash))throw error(CONFLICT,"message_conflict","相同消息身份对应不同内容");return;}
        validatePreparedStart(j,message);
        if(j.permitId()!=null||!j.state().equals("preparing")||!j.accepted()||!j.cancelState().equals("none"))throw error(CONFLICT,"state_conflict","启动决定已变化，不能覆盖已发许可或收束事实");
        String id="start-rejected-"+j.execution();var command=identity(j,id,"start-rejected");command.put("reasonCode",denied.getCode());
        repo.outbox(agent,j.id(),j.execution(),"start-rejected",id,command);repo.receipt(j,messageId,hash);jobs.wake(agent);
    }
    private void process(long agent,JsonNode m){
        long job=id(m.get("jobId").asText()),execution=id(m.get("executionId").asText());String message=m.get("messageId").asText();String hash=repo.digest(m);
        var j=m.get("kind").asText().equals("start-request")?jobs.lockStartAssignment(agent,job,execution):jobs.lockAssignment(agent,job,execution,false);String prior=repo.receipt(agent,message);
        if(prior!=null){if(!prior.equals(hash))throw error(CONFLICT,"message_conflict","相同消息身份对应不同内容");return;}
        switch(m.get("kind").asText()){
            case "accepted"->{if(j.state().equals("ended"))throw error(CONFLICT,"state_conflict","已结束任务不能重新接单");repo.accepted(j);}
            case "start-request"->start(j,m);
            case "started"->{if(!Objects.equals(j.permitId(),m.get("permitId").asText()))throw error(CONFLICT,"permit_mismatch","开始确认未绑定当前许可");if(!j.state().equals("running"))repo.started(j);}
            case "progress"->{if(j.task().path("target").path("kind").asText().equals("stress"))throw error(CONFLICT,"progress_conflict","压测任务仅接受累计压测进度");if(j.state().equals("ended"))throw error(CONFLICT,"state_conflict","已结束任务不能推进进度");repo.progress(j,m.get("sequence").longValue(),m);}
            case "stress-progress"->{
                if(j.state().equals("ended")||!j.task().path("target").path("kind").asText().equals("stress"))throw error(CONFLICT,"state_conflict","当前任务不接受压测进度");
                if(m.path("activeVus").longValue()>j.task().path("target").path("plan").path("maxVus").asLong(1))bad("活跃 VU 超出固定预留");
                if(j.progress()!=null){
                    var previous=j.progress();
                    boolean invalid=m.path("sequence").longValue()<=j.sequence()||!m.path("runId").equals(previous.path("runId"))||m.path("atMs").doubleValue()<previous.path("atMs").doubleValue();
                    for(String field:List.of("startedIterations","completedIterations","droppedIterations"))invalid|=m.path(field).longValue()<previous.path(field).longValue();
                    for(String field:List.of("started","completed","eligibleCompleted","failed"))invalid|=m.path("requests").path(field).longValue()<previous.path("requests").path(field).longValue();
                    if(invalid)throw error(CONFLICT,"progress_conflict","压测累计进度身份、序列或计数倒退");
                }
                repo.progress(j,m.get("sequence").longValue(),m);
            }
            case "completed"->completed(j,m,false);
            case "cancel-confirmed"->{if(!j.cancelState().equals("requested"))throw error(CONFLICT,"cancel_not_requested","任务没有待确认取消申请");completed(j,m,true);}
            default->bad("未知控制消息");
        }
        if(m.path("kind").asText().equals("start-request"))stressResources.status(j,"ready",null,null);
        if(m.path("kind").asText().equals("started"))stressResources.status(j,"ready","running",null);
        if(m.has("processObservation"))stressResources.observation(j,m.get("processObservation"));
        repo.receipt(j,message,hash);
    }
    private void validatePreparedStart(JobRepo.Job j,JsonNode message){
        var actual=assertRuntime(j);String assignedSession=jdbc.queryForObject("SELECT runtime_session_id FROM execution_jobs WHERE id=?",String.class,j.id());if(!actual.path("sessionId").asText().equals(assignedSession))throw error(CONFLICT,"runtime_session_mismatch","任务已绑定其他宿主会话");
        var s=jobs.submission(j);var p=s.preparation();var requirements=message.get("scriptRequirements");
        if(!Objects.equals(p.stressBinding(),message.get("stressBinding")))throw error(CONFLICT,"prepared_inputs_mismatch","代理压测重算声明与固定输入不符");
        if(!j.inputsDigest().equals(message.get("inputsDigest").asText())||!p.scriptPlanDigest().equals(message.get("scriptPlanDigest").asText())||!p.executionProfile().equals(message.get("executionProfile").asText())||!p.runtimeCompatibilityId().equals(message.get("runtimeCompatibilityId").asText())||!Objects.equals(p.scriptGrantVersion(),text(message,"scriptGrantVersion"))||!repo.parse(repo.encode(p.scriptRequirements())).equals(requirements)||!repo.parse(repo.encode(jobs.credentialVersions(j))).equals(message.get("credentialVersions"))||!j.task().path("policyVersion").asText().equals(message.get("policyVersion").asText()))throw error(CONFLICT,"prepared_inputs_mismatch","代理重算声明与持久固定输入或执行档位不符");
    }
    private void start(JobRepo.Job j,JsonNode message){
        validatePreparedStart(j,message);var s=jobs.submission(j);var p=s.preparation();
        if(j.permitId()!=null)return; // Retry recovers the one durable permit; no new business invocation.
        if(!j.state().equals("preparing")||!j.accepted()||!j.cancelState().equals("none"))throw error(CONFLICT,"state_conflict","任务尚未接单、已申请取消或已结束");
        jobs.requireScheduledStart(j);
        var caller=jobs.currentUser(j);agents.requireExecution(caller,String.valueOf(j.workspace()),String.valueOf(j.project()));agents.requireUsable(String.valueOf(j.agent()),String.valueOf(j.workspace()),String.valueOf(j.project()));
        String revision=configs.lockPolicyVersion();var effective=configs.effective(j.agent(),j.workspace(),j.project(),timeouts(s.runConfig()));var node=cast(effective.get("agent"));
        if(repo.occupied(j.agent())>number(node,"maxConcurrentJobs"))throw error(CONFLICT,"agent_capacity","任务准备后代理总准入额度已下降");
        if(j.task().path("dispatchKind").asText().equals("shared-debug")&&repo.sharedOccupied(j.agent())>number(node,"sharedDebugMaxInFlight"))throw error(CONFLICT,"shared_capacity","共享调试准入额度已下降");
        if(StressResourceReservations.isStress(s)&&stressResources.blockingReason(j.agent(),null,node)!=null)throw error(CONFLICT,"resource_capacity","压测资源准入额度已下降");
        if(!revision.equals(message.get("policyVersion").asText()))throw error(CONFLICT,"policy_changed","策略版本已变化，请重新准备");
        jobs.assertDebugSession(j);var snapshot=snapshots.loadAuthorized(caller,j.snapshot());
        String grant=grants.authorizePrepared(caller,String.valueOf(j.agent()),snapshot,p.scriptRequirements(),p.scriptPlanDigest());if(!Objects.equals(grant,p.scriptGrantVersion()))throw error(CONFLICT,"script_grant_changed","脚本批准已变化，请重新准备");
        if(!repo.parse(repo.encode(policy(effective))).equals(repo.inputs(j.id()).path("policy")))throw error(CONFLICT,"policy_changed","固定准备策略与当前许可策略不符");
        credentials.assertVersionsAuthorized(j.workspace(),j.project(),jobs.credentialVersions(j));long input=jobs.materialBytes(snapshot,s.materials(),policy(effective),s.network());
        if(input>number(node,"inputCacheBytes")-(repo.reserved(j.agent(),"input")-j.inputBytes())||number(policy(effective),"reportBytes")>number(node,"pendingResultBytes")-number(node,"faultReserveBytes")-(repo.reserved(j.agent(),"result")-j.resultBytes()))throw error(CONFLICT,"resource_capacity","输入或待传结果额度已下降");
        long permit=repo.nextId();String id="permit-"+permit;var command=identity(j,id,"start-permit");command.put("permitId",String.valueOf(permit));command.put("policyVersion",revision);command.put("effectivePolicy",policy(effective));command.put("scriptPlanDigest",p.scriptPlanDigest());if(grant!=null)command.put("scriptGrantVersion",grant);command.put("executionProfile",p.executionProfile());command.put("runtimeCompatibilityId",p.runtimeCompatibilityId());command.put("credentialVersions",jobs.credentialVersions(j));repo.permit(j,permit,command);repo.outbox(j.agent(),j.id(),j.execution(),"start-permit",id,command);
    }
    private void completed(JobRepo.Job j,JsonNode message,boolean cancelled){
        if(j.state().equals("ended"))throw error(CONFLICT,"state_conflict","不能使用新消息覆盖已结束摘要");
        String verdict=cancelled?"cancelled":message.get("verdict").asText();
        var reportStatus=repo.status(j.id());
        if(!cancelled&&reportStatus.reportVerdict()!=null&&!reportStatus.reportVerdict().equals(verdict))throw error(CONFLICT,"report_type_mismatch","完成声明与已上传报告结论不符");
        if(verdict.equals("passed")&&Objects.equals(reportStatus.reportKind(),"stress-failure"))throw error(CONFLICT,"report_type_mismatch","压测异常报告不能声明通过");
        if((verdict.equals("passed")||verdict.equals("failed"))&&j.permitId()==null)throw error(CONFLICT,"permit_required","未获许可的任务不能报告通过或失败");
        String hash=text(message,"reportHash");Long bytes=message.has("reportBytes")?message.get("reportBytes").longValue():null;
        if(j.reportState().equals("archived")){
            if(cancelled){hash=j.reportHash();bytes=j.reportBytes();}
            else if(hash==null||!hash.equals(j.reportHash())||!Objects.equals(bytes,j.reportBytes()))
                throw error(CONFLICT,"report_conflict","完成摘要与已上传报告不符");
        }
        if(bytes!=null){long limit=j.permit()!=null?j.permit().path("effectivePolicy").path("reportBytes").asLong():number(policy(configs.effective(j.agent(),j.workspace(),j.project(),timeouts(jobs.submission(j).runConfig()))),"reportBytes");if(bytes>limit)throw error(BAD_REQUEST,"report_size_limit","完成摘要超出报告预算");}
        if(!cancelled)jobs.validateArchivedStressCompletion(j,message);
        var summary=repo.map(message);
        summary.put("verdict",verdict);
        jobs.end(j,summary,hash,bytes,cancelled||verdict.equals("cancelled"));
    }
    private void validateExchange(JobDtos.Exchange e){if(e==null)bad("轮询输入必填");opaque(e.sessionId());version(e.appliedConfigVersion());if(e.availableSlots()==null||e.availableSharedDebugSlots()==null||e.availableSlots()<0||e.availableSlots()>9007199254740991L||e.availableSharedDebugSlots()<0||e.availableSharedDebugSlots()>e.availableSlots()||e.acknowledgements()==null)bad("共享槽必须是代理总剩余额度的子集");e.acknowledgements().forEach(JobService::opaque);}
    private void validateMessage(JsonNode m){
        if(!m.isObject())bad("控制消息必须为对象");for(String key:List.of("messageId","jobId","executionId","kind"))string(m,key);opaque(m.get("messageId").asText());id(m.get("jobId").asText());id(m.get("executionId").asText());
        var allowed=new HashSet<>(Set.of("messageId","jobId","executionId","kind"));
        if(Set.of("stress-progress","completed").contains(m.path("kind").asText())){allowed.add("processObservation");if(m.has("processObservation"))StressResourceReservations.validateObservationShape(m.get("processObservation"));}
        if(m.path("kind").asText().equals("start-request"))allowed.add("stressBinding");
        switch(m.get("kind").asText()){
            case "accepted"->{}
            case "stress-progress"->{
                allowed.addAll(Set.of("sequence","observedAt","runId","state","phase","stageId","atMs","activeVus","startedIterations","completedIterations","droppedIterations","requests","completeness"));
                validateStressProgress(m);
            }
            case "start-request"->{allowed.addAll(Set.of("inputsDigest","policyVersion","scriptPlanDigest","scriptGrantVersion","scriptRequirements","executionProfile","runtimeCompatibilityId","credentialVersions"));for(String key:List.of("inputsDigest","policyVersion","scriptPlanDigest","executionProfile","runtimeCompatibilityId"))string(m,key);hash(m.get("inputsDigest").asText());hash(m.get("scriptPlanDigest").asText());version(m.get("policyVersion").asText());opaque(m.get("runtimeCompatibilityId").asText());String profile=m.get("executionProfile").asText();if(!Set.of("no-script","trusted-core-script").contains(profile)||!m.path("scriptRequirements").isArray()||!m.path("credentialVersions").isObject())bad("准备清单字段无效");if(profile.equals("trusted-core-script")){string(m,"scriptGrantVersion");version(m.get("scriptGrantVersion").asText());}if(m.has("scriptGrantVersion")){string(m,"scriptGrantVersion");version(m.get("scriptGrantVersion").asText());}if(profile.equals("no-script")&&!m.get("scriptRequirements").isEmpty())bad("无脚本档位不能携带脚本");for(var requirement:m.get("scriptRequirements"))repo.decode(requirement,ScriptGrantService.PreparedScriptRequirement.class);m.get("credentialVersions").fields().forEachRemaining(e->{opaque(e.getKey());if(!e.getValue().isTextual())bad("凭据版本必须是字符串");opaque(e.getValue().asText());});}
            case "started"->{allowed.addAll(Set.of("permitId","startedAt"));string(m,"permitId");id(m.get("permitId").asText());timestamp(m,"startedAt");}
            case "progress"->{allowed.addAll(Set.of("sequence","phase","observedAt","completedRequests","failedRequests"));integer(m,"sequence",1);integer(m,"completedRequests",0);integer(m,"failedRequests",0);string(m,"phase");timestamp(m,"observedAt");if(!Set.of("preparing","running","finalizing","uploading").contains(m.get("phase").asText())||m.get("failedRequests").longValue()>m.get("completedRequests").longValue())bad("进度阶段或请求计数无效");}
            case "completed","cancel-confirmed"->{allowed.addAll(Set.of("finishedAt","executionReleased","evidenceComplete"));timestamp(m,"finishedAt");if(!m.path("executionReleased").isBoolean()||!m.get("executionReleased").booleanValue()||!m.path("evidenceComplete").isBoolean())bad("只有实际收束才允许确认释放");if(m.get("kind").asText().equals("completed")){allowed.addAll(Set.of("verdict","reportHash","reportBytes","reasonCode"));string(m,"verdict");if(!Set.of("passed","failed","cancelled","timed-out","interrupted","rejected").contains(m.get("verdict").asText()))bad("终态结论无效");if(m.has("reportHash")!=m.has("reportBytes"))bad("报告摘要和长度必须同时存在");if(m.has("reportHash")){string(m,"reportHash");hash(m.get("reportHash").asText());integer(m,"reportBytes",0);}if(m.has("reasonCode")){string(m,"reasonCode");opaque(m.get("reasonCode").asText());}}}
            default->bad("未知消息种类");
        }
        if(m.path("kind").asText().equals("stress-progress"))stressFields(m,allowed);else fields(m,allowed);
    }
    private static void string(JsonNode m,String key){if(!m.path(key).isTextual())bad(key+" 必须为字符串");}
    private void validateStressProgress(JsonNode m){
        if(repo.encode(m).getBytes(java.nio.charset.StandardCharsets.UTF_8).length>65536)bad("压测进度超过消息预算");
        for(String field:List.of("sequence","activeVus","startedIterations","completedIterations","droppedIterations"))integer(m,field,field.equals("sequence")?1:0);
        timestamp(m,"observedAt");string(m,"runId");opaque(m.path("runId").asText());
        if(!Set.of("preparing","ready","running","stopping","finished").contains(m.path("state").asText())||!m.path("atMs").isNumber()||!Double.isFinite(m.path("atMs").doubleValue())||m.path("atMs").doubleValue()<0)bad("压测状态或时间无效");
        if(!m.has("phase")||!m.path("phase").isNull()&&!Set.of("setup","vu-setup","warmup","measurement","drain","vu-teardown","teardown").contains(m.path("phase").asText()))bad("压测阶段无效");
        if(!m.has("stageId")||!m.path("stageId").isNull()&&(!m.path("stageId").isTextual()||m.path("stageId").asText().isBlank()||m.path("stageId").asText().length()>512))bad("压测阶段身份无效");
        var r=m.path("requests");if(!r.isObject())bad("压测请求计数必填");stressFields(r,Set.of("started","completed","eligibleCompleted","failed"));
        for(String key:List.of("started","completed","eligibleCompleted","failed"))integer(r,key,0);
        if(m.path("completedIterations").longValue()>m.path("startedIterations").longValue()||r.path("completed").longValue()>r.path("started").longValue()||r.path("eligibleCompleted").longValue()>r.path("completed").longValue()||r.path("failed").longValue()>r.path("eligibleCompleted").longValue())bad("压测累计计数不守恒");
        var complete=m.path("completeness");if(!complete.isObject())bad("压测完整性必填");stressFields(complete,Set.of("execution","metrics","load"));
        var reasons=Set.of("cancelled","drain-timeout","warmup-drain-timeout","setup-failed","vu-setup-failed","teardown-failed","vu-teardown-failed","worker-missing","worker-failed","worker-incompatible","snapshot-missing","snapshot-duplicate","snapshot-invalid","metrics-budget-exhausted","histogram-overflow","timeline-unaligned","phase-window-missing","dropped","no-data","policy-limited","resource-saturated","execution-failed");
        for(String key:List.of("execution","metrics","load")){
            var part=complete.path(key);if(!part.isObject())bad("压测完整性分量必填");stressFields(part,Set.of("complete","reasons"));
            if(!part.path("complete").isBoolean()||!part.path("reasons").isArray()||part.path("reasons").size()>32||part.path("complete").booleanValue()==!part.path("reasons").isEmpty())bad("压测完整性状态无效");
            for(var reason:part.path("reasons"))if(!reason.isTextual()||!reasons.contains(reason.asText()))bad("压测完整性原因无效");
        }
    }
    private static void stressFields(JsonNode value,Set<String> allowed){value.fieldNames().forEachRemaining(key->{if(!allowed.contains(key))bad("压测进度包含未知字段");});}
    private static void integer(JsonNode m,String key,long minimum){var v=m.path(key);if(!v.isIntegralNumber()||!v.canConvertToLong()||v.longValue()<minimum||v.longValue()>9007199254740991L)bad(key+" 必须为有效安全整数");}
    private static void timestamp(JsonNode m,String key){string(m,key);try{String value=m.get(key).asText();if(!value.endsWith("Z"))bad("时间必须为UTC ISO格式");Instant.parse(value);}catch(Exception e){bad("时间必须为UTC ISO格式");}}
    private static String text(JsonNode m,String key){return m.has(key)?m.get(key).asText():null;}
}
