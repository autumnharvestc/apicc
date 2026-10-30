package com.autumnharvestc.server.execution.notifications;
import java.util.*;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import com.autumnharvestc.server.execution.scheduling.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;
@Service
@Transactional
public class NotificationEventService {
    private final NotificationEventRepo repo;private final WorkspaceGuard guard;private final ScheduleTimeSource time;private final ObjectMapper json;private final com.autumnharvestc.server.core.PermissionService permissions;
    @org.springframework.beans.factory.annotation.Autowired private NotificationOutboxService outbox;
    @org.springframework.beans.factory.annotation.Autowired private ScheduleGrantService grants;
    public NotificationEventService(NotificationEventRepo repo,WorkspaceGuard guard,ScheduleTimeSource time,ObjectMapper json,com.autumnharvestc.server.core.PermissionService permissions){this.repo=repo;this.guard=guard;this.time=time;this.json=json;this.permissions=permissions;}
    public void observe(long ws){
        repo.gate();
        for(long id:repo.occurrenceCandidates(ws,50))repo.occurrence(id).ifPresent(s->{
            var summary=s.summary()==null?json.createObjectNode():tree(s.summary());String verdict=summary.path("verdict").asText();String kind=switch(s.state()){case "expired"->"expired";case "skipped"->"skipped";case "rejected"->"failed";default->switch(verdict){case "passed"->"succeeded";case "failed"->"failed";default->"abnormal";};};
            String reason=s.state().equals("rejected")?safeRejection(s.reason()):kind.equals("skipped")?s.reason()!=null&&Set.of("schedule-overlap-skipped","schedule-cancelled").contains(s.reason())?s.reason():"schedule-skipped":kind.equals("expired")?"schedule-queue-expired":switch(kind){case "succeeded"->"execution-passed";case "failed"->"execution-failed";default->"execution-abnormal";};
            var b=base(ws,s.project(),s.schedule(),s.scheduleName(),s.projectName(),"occurrence/"+s.id(),1,kind,reason);
            b.put("plannedAtUtc",s.plannedAt());b.put("revision",s.revision());b.put("snapshotVersion",s.snapshot());b.put("jobId",s.job());b.put("executionId",s.execution());b.put("verdict",Set.of("passed","failed","cancelled","timed-out","interrupted","rejected").contains(verdict)?verdict:null);b.put("evidenceState",s.job()==null?"not-applicable":summary.path("evidenceComplete").asBoolean(false)?"complete":"incomplete");b.put("reportState",s.report()==null?"none":s.report());
            b.put("snapshotId",s.originalSnapshot()==null?tree(s.executionDefinition()).path("snapshotId").asText():s.originalSnapshot());b.put("observedAtUtc",s.observedAt());b.put("finishedAtUtc",safeTime(summary.path("finishedAt").asText(null)));
            emit(ws,s.project(),b,s.notifications());repo.consumeOccurrence(s.id());
        });
        for(long id:repo.pausedCandidates(ws,50))repo.pause(id).ifPresent(s->{
            var b=base(ws,s.project(),s.id(),s.name(),s.projectName(),"schedule/"+s.id(),s.version(),"paused",safePause(s.reason()));
            b.put("plannedAtUtc",null);b.put("revision",null);b.put("snapshotVersion",null);b.put("jobId",null);b.put("executionId",null);b.put("verdict",null);b.put("evidenceState","not-applicable");b.put("reportState","none");emit(ws,s.project(),b,s.notifications());repo.consumePause(s);
        });
    }
    private LinkedHashMap<String,Object> base(long ws,long project,long schedule,String name,String projectName,String source,long version,String kind,String reason){
        var b=new LinkedHashMap<String,Object>();b.put("workspaceId",String.valueOf(ws));b.put("projectId",String.valueOf(project));b.put("scheduleId",String.valueOf(schedule));b.put("scheduleName",safeName(name));b.put("projectName",safeName(projectName));b.put("sourceId",source);b.put("sourceVersion",String.valueOf(version));b.put("eventKind",kind);b.put("reasonCode",reason);b.put("link","/workspaces/"+ws+"/projects/"+project+"/schedules/"+schedule);b.put("snapshotId",null);b.put("observedAtUtc",time.now().toString());b.put("startedAtUtc",null);b.put("finishedAtUtc",null);return b;
    }
    private static String safeName(String value){var result=new StringBuilder();if(value!=null)value.codePoints().filter(c->!Character.isISOControl(c)&&Character.getType(c)!=Character.FORMAT&&Character.getType(c)!=Character.LINE_SEPARATOR&&Character.getType(c)!=Character.PARAGRAPH_SEPARATOR).forEach(c->{if(result.length()+Character.charCount(c)<=128)result.appendCodePoint(c);});return result.toString().isBlank()?"未命名":result.toString();}
    private static String safeTime(String value){try{return java.time.OffsetDateTime.parse(value).toInstant().toString();}catch(Exception ignored){return null;}}
    private static String safeRejection(String reason){return Set.of("intent_source_conflict","credential_version_conflict","credential_missing","credential_unavailable","schedule-subject-unavailable","schedule-subject-unauthorized","schedule-interval-too-short","schedule-material-unavailable","snapshot_version_conflict","script_grant_changed","project_forbidden","agent_not_associated").contains(reason)?reason:"schedule-rejected";}
    private static String safePause(String code){return Set.of("schedule-paused","schedule-deleted","schedule-evaluation-limit","schedule-interval-too-short","schedule-subject-unavailable","schedule-subject-unauthorized","schedule-material-unavailable").contains(code)?code:"schedule-paused";}
    private com.fasterxml.jackson.databind.JsonNode tree(String s){try{return json.readTree(s);}catch(Exception e){throw new IllegalStateException("Invalid notification source");}}
    private void emit(long ws,long project,LinkedHashMap<String,Object> body,String config){
        var n=tree(config);boolean selected=false;for(var kind:n.path("eventKinds"))if(kind.asText().equals(body.get("eventKind")))selected=true;if(!selected)return;
        var now=time.now();long event=repo.create(ws,project,Long.parseLong((String)body.get("scheduleId")),(String)body.get("sourceId"),Long.parseLong((String)body.get("sourceVersion")),(String)body.get("eventKind"),(String)body.get("reasonCode"),n.path("inApp").asBoolean(),now);
        body.put("id",String.valueOf(event));body.put("createdAtUtc",now.toString());body.put("notificationState",n.path("channelIds").isEmpty()?"in-app":"pending");try{String encoded=json.writeValueAsString(body);repo.body(event,encoded);var selectedChannels=new ArrayList<String>();n.path("channelIds").forEach(c->selectedChannels.add(c.asText()));outbox.enqueue(event,ws,project,encoded,selectedChannels,now);}catch(com.fasterxml.jackson.core.JsonProcessingException e){throw new IllegalStateException("Cannot encode safe event");}
    }
    public NotificationDtos.Page list(UserAccount caller,String ws,Integer requested,String before){
        long workspace=id(ws);guard.requireMember(workspace,caller);observe(workspace);
        int limit=limit(requested);var rows=repo.memberPage(workspace,caller.id(),limit+1,before==null?null:id(before));boolean more=rows.size()>limit;rows=rows.subList(0,Math.min(limit,rows.size()));var items=rows.stream().map(row->project(row,caller.id())).toList();return new NotificationDtos.Page(items,more?items.getLast().id():null);
    }
    private NotificationDtos.Event project(Map<String,Object> row,long user){try{long event=id((String)row.get("id"));var value=json.readValue((String)row.get("body"),new com.fasterxml.jackson.core.type.TypeReference<LinkedHashMap<String,Object>>(){});value.put("read",repo.read(event,user));value.put("notificationState",outbox.state(event));value.put("deliveries",outbox.views(event));return json.convertValue(value,NotificationDtos.Event.class);}catch(Exception e){throw new IllegalStateException("Cannot decode safe event");}}
    private static int limit(Integer requested){int limit=requested==null?25:requested;if(limit<1||limit>100)throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","通知分页大小必须为1至100");return limit;}
    public NotificationDtos.HistoryPage history(UserAccount caller,String ws,String project,String schedule,Integer requested,String before,String sourceBefore){grants.requireRead(caller,ws,project);long w=id(ws),p=id(project),s=id(schedule);if(!repo.scheduleExists(w,p,s))throw error(org.springframework.http.HttpStatus.NOT_FOUND,"schedule_not_found","定时任务不存在");int limit=limit(requested);var heads=repo.history(w,p,s,limit+1,before==null?null:id(before));boolean more=heads.size()>limit;heads=heads.subList(0,Math.min(limit,heads.size()));var items=heads.stream().map(h->{var deliveries=outbox.views(h.id());var reasons=deliveries.stream().map(NotificationOutboxRepo.DeliveryView::reasonCode).filter(Objects::nonNull).distinct().toList();return new NotificationDtos.HistoryEvent(String.valueOf(h.id()),h.source(),h.version(),h.kind(),h.created(),h.detailState(),h.inApp(),deliveries.isEmpty()&&!h.inApp()?"not-requested":outbox.state(h.id()),reasons.isEmpty()?List.of(h.reason()):reasons,deliveries);}).toList();var observed=repo.observations(w,p,s,limit+1,sourceBefore==null?null:id(sourceBefore));boolean moreSources=observed.size()>limit;observed=observed.subList(0,Math.min(limit,observed.size()));return new NotificationDtos.HistoryPage(ws,project,schedule,items,more?items.getLast().eventId():null,observed.stream().map(NotificationEventRepo.ObservationRow::view).toList(),moreSources?String.valueOf(observed.getLast().id()):null,repo.pauseObservation(w,p,s));}
    public Map<String,Object> read(UserAccount caller,String ws,String event){
        long workspace=id(ws);guard.requireMember(workspace,caller);var row=repo.readable(workspace,id(event)).orElseThrow(()->error(org.springframework.http.HttpStatus.NOT_FOUND,"notification_not_found","通知不存在"));
        if(permissions.effectiveRole(workspace,caller.id(),(Long)row.get("project")).isEmpty())throw error(org.springframework.http.HttpStatus.FORBIDDEN,"project_forbidden","该项目不可见");repo.markRead(id(event),caller.id());return Map.of("id",event,"read",true);
    }
}
