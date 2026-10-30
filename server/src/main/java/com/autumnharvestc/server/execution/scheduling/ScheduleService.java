package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.execution.assets.ExecutionSnapshotService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;

@Service
@Transactional
public class ScheduleService {
    @org.springframework.beans.factory.annotation.Autowired private ScheduleControlService control;
    @org.springframework.beans.factory.annotation.Autowired private com.autumnharvestc.server.execution.notifications.NotificationChannelService notificationChannels;
    private final ScheduleRepo repo;private final AgentService agents;private final ExecutionSnapshotService snapshots;private final ScheduleGrantService grants;
    private final SchedulePreparationService preparation;private final SchedulePolicyService policies;private final SchedulerProperties properties;private final ScheduleRuleCalculator calculator;private final ScheduleTimeSource time;private final com.autumnharvestc.server.execution.agent.AgentRepo audit;private final ScheduleMaterialService materials;
    public ScheduleService(ScheduleRepo repo,AgentService agents,ExecutionSnapshotService snapshots,ScheduleGrantService grants,SchedulePreparationService preparation,SchedulePolicyService policies,SchedulerProperties properties,ScheduleRuleCalculator calculator,ScheduleTimeSource time,com.autumnharvestc.server.execution.agent.AgentRepo audit,ScheduleMaterialService materials){this.repo=repo;this.agents=agents;this.snapshots=snapshots;this.grants=grants;this.preparation=preparation;this.policies=policies;this.properties=properties;this.calculator=calculator;this.time=time;this.audit=audit;this.materials=materials;}
    public ScheduleDtos.View create(UserAccount caller,String ws,String project,ScheduleDtos.Save save){
        repo.lockCapacity();
        grants.requireManage(caller,ws,project);
        var projectPolicy=(java.util.Map<?,?>)policies.effective(id(ws),id(project)).get("effective");
        long workspaceCap=((Number)((java.util.Map<?,?>)policies.effectiveWorkspace(id(ws)).get("effective")).get("maxSchedules")).longValue();
        if(repo.count(null,null)>=properties.getMaxSchedules()||repo.count(id(ws),null)>=workspaceCap||repo.count(id(ws),id(project))>=((Number)projectPolicy.get("maxSchedules")).longValue())throw error(org.springframework.http.HttpStatus.CONFLICT,"schedule-capacity","未删除计划数量已达到全局、工作区或项目额度（含暂停计划）");
        validate(save,ws,project);
        var snapshot=preparation.validate(caller,ws,project,save.execution());
        validateMaterials(save.execution(),ws,project);
        materials.seal(caller,id(ws),id(project),save.execution());
        long schedule=repo.create(id(ws),id(project),caller.id(),save,snapshot.assets().version(),snapshot.assets().manifestHash());
        audit.audit(caller.id(),"schedule.create","schedule",schedule,1L);
        return repo.require(id(ws),id(project),schedule,false);
    }
    public com.autumnharvestc.server.execution.ExecutionDtos.MaterialSelection sealMaterials(UserAccount subject,long ws,long project,ScheduleDtos.Execution execution){validateMaterials(execution,String.valueOf(ws),String.valueOf(project));return materials.seal(subject,ws,project,execution);}
    public java.util.Map<String,Object> materialOptions(UserAccount caller,String ws,String project){return materials.options(caller,ws,project);}
    public ScheduleDtos.View detail(UserAccount caller,String ws,String project,String schedule){grants.requireRead(caller,ws,project);return repo.require(id(ws),id(project),id(schedule),false);}
    public java.util.Map<String,Object> list(UserAccount caller,String ws,String project,Integer requested,String before){
        grants.requireRead(caller,ws,project);int limit=requested==null?25:requested;if(limit<1||limit>100)throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","计划分页大小必须为1至100");
        var items=repo.list(id(ws),id(project),limit+1,before==null?null:id(before));boolean more=items.size()>limit;items=items.subList(0,Math.min(limit,items.size()));
        var result=new java.util.LinkedHashMap<String,Object>();result.put("items",items);result.put("nextBeforeId",more?items.getLast().id():null);return result;
    }
    public java.util.Map<String,Object> options(UserAccount caller,String ws,String project){
        grants.requireRead(caller,ws,project);var p=policies.effective(id(ws),id(project));return java.util.Map.of("canManageSchedules",grants.canManage(caller,ws,project),"schedulerAvailable","embedded".equals(control.read().mode()),"policy",p.get("effective"),"sources",p.get("source"),"policyVersion",p.get("versions"),"channels",notificationChannels.selectable(id(ws)));
    }
    public ScheduleDtos.View update(UserAccount caller,String ws,String project,String schedule,ScheduleDtos.Update input){
        grants.requireManage(caller,ws,project);var old=repo.require(id(ws),id(project),id(schedule),true);expected(old,input.expectedVersion());
        boolean refreshed=Boolean.TRUE.equals(input.refreshExecution()),reauthorized=Boolean.TRUE.equals(input.reauthorize());
        if((input.execution()!=null)!=refreshed)throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","刷新执行准备必须同时提供 execution 与 refreshExecution=true");
        if(reauthorized)agents.requireProject(caller,ws,project,true);
        var save=new ScheduleDtos.Save(input.name()==null?old.name():input.name(),input.rule()==null?old.rule():input.rule(),input.policies()==null?old.policies():input.policies(),input.execution()==null?old.execution():input.execution(),input.notifications()==null?old.notifications():input.notifications());
        boolean revised=reauthorized||refreshed||!save.rule().equals(old.rule())||!save.policies().equals(old.policies());
        boolean enabled=input.enabled()==null?old.enabled():input.enabled();long subject=reauthorized?caller.id():id(old.subjectUserId());
        // Revocation keeps old choices; it must not require restoring an unavailable
        // channel, subject or a now-lowered execution policy. New choices stay strict.
        boolean purePause=Boolean.FALSE.equals(input.enabled())&&!refreshed&&!reauthorized&&input.name()==null&&input.rule()==null&&input.policies()==null&&(input.notifications()==null||input.notifications().equals(old.notifications()));
        validateBasic(save,ws,!purePause);
        String snapshotVersion=old.snapshotVersion(),manifestHash=old.manifestHash();
        if(revised||Boolean.TRUE.equals(input.enabled())){
            var actor=grants.requireSubject(subject,id(ws),id(project));validate(save,ws,project);var fixed=preparation.validate(actor,ws,project,save.execution());validateMaterials(save.execution(),ws,project);materials.seal(actor,id(ws),id(project),save.execution());snapshotVersion=fixed.assets().version();manifestHash=fixed.assets().manifestHash();
        }
        long cancellation=version(old.cancellationVersion());if(revised||Boolean.FALSE.equals(input.enabled()))cancellation=increment(cancellation);
        if(revised)increment(version(old.revision()));increment(version(old.version()));
        String next=old.nextPlannedAtUtc();
        if(!enabled)next=null;else if(revised||Boolean.TRUE.equals(input.enabled())){
            var after=time.now();if(old.evaluatedThroughUtc()!=null&&java.time.Instant.parse(old.evaluatedThroughUtc()).isAfter(after))after=java.time.Instant.parse(old.evaluatedThroughUtc());if(old.lastAdmittedPlannedAtUtc()!=null&&java.time.Instant.parse(old.lastAdmittedPlannedAtUtc()).isAfter(after))after=java.time.Instant.parse(old.lastAdmittedPlannedAtUtc());
            repo.startEvaluationAt(id(schedule),after);
            var effective=(java.util.Map<?,?>)policies.effective(id(ws),id(project)).get("effective");var candidates=calculator.preview(save.rule(),after,((Number)effective.get("minIntervalMs")).longValue(),properties.getEvaluationMaxCandidates()).candidates();next=candidates.isEmpty()?null:candidates.getFirst().plannedAtUtc();
        }
        repo.update(old,save,subject,revised,enabled,cancellation,next,snapshotVersion,manifestHash);repo.cancelInvalidated(id(schedule),time.now());audit.audit(caller.id(),reauthorized?"schedule.reauthorize":"schedule.update","schedule",id(schedule),version(old.version())+1);return repo.require(id(ws),id(project),id(schedule),false);
    }
    public void delete(UserAccount caller,String ws,String project,String schedule,String expectedVersion){grants.requireManage(caller,ws,project);var old=repo.require(id(ws),id(project),id(schedule),true);expected(old,expectedVersion);increment(version(old.version()));increment(version(old.cancellationVersion()));repo.delete(old);repo.cancelInvalidated(id(schedule),time.now());audit.audit(caller.id(),"schedule.delete","schedule",id(schedule),version(old.version())+1);}
    private static void expected(ScheduleDtos.View old,String expected){if(version(expected)!=version(old.version()))throw error(org.springframework.http.HttpStatus.CONFLICT,"version_conflict","计划版本已变化");}
    private static long increment(long value){if(value==Long.MAX_VALUE)throw error(org.springframework.http.HttpStatus.CONFLICT,"version_exhausted","计划版本已达到上限");return value+1;}
    private void validate(ScheduleDtos.Save save,String ws,String project){
        validateBasic(save,ws,true);
        var policy=(java.util.Map<?,?>)policies.effective(id(ws),id(project)).get("effective");
        if(save.policies().lateToleranceMs()<properties.getScanIntervalMs()*2||save.policies().queueTimeoutMs()>((Number)policy.get("maxQueueTimeoutMs")).longValue())throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"schedule-policy-conflict","计划容差或排队时限超出当前有效策略");
        calculator.preview(save.rule(),time.now(),((Number)policy.get("minIntervalMs")).longValue(),properties.getEvaluationMaxCandidates());
    }
    private void validateBasic(ScheduleDtos.Save save,String ws,boolean checkAvailableChannels){
        if(save==null||save.name()==null||save.name().isBlank()||save.name().length()>128||save.rule()==null||save.policies()==null||save.notifications()==null)throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","计划名称、规则、策略及通知选择必填，名称至多128字符");
        var n=save.notifications();if(n.inApp()==null||n.eventKinds()==null||n.channelIds()==null||n.eventKinds().stream().anyMatch(java.util.Objects::isNull)||new java.util.HashSet<>(n.eventKinds()).size()!=n.eventKinds().size()||!java.util.Set.of("failed","abnormal","expired","paused","succeeded","skipped").containsAll(n.eventKinds())||new java.util.HashSet<>(n.channelIds()).size()!=n.channelIds().size())throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","通知事件或渠道选择无效");
        if(checkAvailableChannels){var available=notificationChannels.selectable(id(ws)).stream().map(c->c.get("id")).collect(java.util.stream.Collectors.toSet());if(!available.containsAll(n.channelIds()))throw error(org.springframework.http.HttpStatus.CONFLICT,"notification-channel-unavailable","所选通知渠道不存在或当前不可用");}
    }
    private void validateMaterials(ScheduleDtos.Execution execution,String ws,String project){
        var m=execution.materials();if(m==null||!project.equals(m.projectId())||m.credentials()==null||m.attachments()==null)throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"materials_scope_mismatch","材料必须来自固定项目");
        if(m.attachmentPaths()!=null)for(var entry:m.attachmentPaths().entrySet()){
            String path=entry.getKey();if(path==null||path.isEmpty()||path.startsWith("/")||path.contains("\\")||path.contains(":")||path.chars().anyMatch(c->c<32)||java.util.Arrays.stream(path.split("/",-1)).anyMatch(s->s.isEmpty()||s.equals(".")||s.equals(".."))||!m.attachments().contains(entry.getValue()))throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","附件必须显式映射规范项目相对路径和固定上传版本");
        }
    }
}
