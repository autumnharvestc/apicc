package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.ExecutionDtos;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;

@Service
@Transactional
public class ScheduleHistoryService {
    private final JdbcTemplate jdbc;private final ScheduleGrantService grants;private final ScheduleRepo plans;
    @org.springframework.beans.factory.annotation.Autowired private com.autumnharvestc.server.execution.jobs.JobRepo jobs;
    public ScheduleHistoryService(JdbcTemplate jdbc,ScheduleGrantService grants,ScheduleRepo plans){this.jdbc=jdbc;this.grants=grants;this.plans=plans;}
    public ScheduleHistoryDtos.Page history(UserAccount caller,String ws,String project,String schedule,Integer requested,String before,String missedBefore){
        grants.requireRead(caller,ws,project);long w=id(ws),p=id(project),s=id(schedule);int limit=requested==null?25:requested;
        if(limit<1||limit>100)throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","历史分页大小必须为1至100");
        var summaries=jdbc.query("SELECT * FROM execution_schedules WHERE workspace_id=? AND project_id=? AND id=?",(r,n)->new Summary(r.getBoolean("deleted")?"deleted":!r.getBoolean("enabled")?"paused":r.getObject("next_planned_at_utc")==null?"finished":"active",r.getString("paused_reason_code"),instant(r,"evaluated_through_utc"),instant(r,"last_admitted_planned_at_utc")),w,p,s);
        var summary=summaries.stream().findFirst().orElseThrow(()->error(org.springframework.http.HttpStatus.NOT_FOUND,"schedule_not_found","定时任务不存在"));
        var items=jdbc.query("SELECT * FROM execution_schedule_occurrences WHERE workspace_id=? AND project_id=? AND schedule_id=?"+(before==null?"":" AND id<?")+" ORDER BY id DESC LIMIT ?",(r,n)->{
            String raw=r.getString("materials_json");var sealed=raw==null?null:plans.decode(raw,ExecutionDtos.MaterialSelection.class);
            var materials=sealed==null?new ScheduleHistoryDtos.Materials("unavailable",null,List.of(),List.of()):new ScheduleHistoryDtos.Materials("sealed",sealed.projectId(),sealed.credentials(),sealed.attachments());
            String planned=instant(r,"planned_at_utc"),observed=instant(r,"observed_at_utc"),job=r.getString("job_id");
            var execution=job==null?new ScheduleHistoryDtos.Execution("not-submitted",null,null,null,null):jobs.find(Long.parseLong(job)).filter(j->j.workspace()==w&&j.project()==p).map(j->new ScheduleHistoryDtos.Execution("available",j.state(),j.released(),j.reportState(),verdict(j.summary()))).orElseGet(()->new ScheduleHistoryDtos.Execution("not-integrated",null,null,null,null));
            return new ScheduleHistoryDtos.Occurrence(r.getString("id"),r.getString("workspace_id"),r.getString("project_id"),r.getString("schedule_id"),r.getString("revision"),r.getString("cancellation_version"),r.getString("subject_user_id"),planned,observed,Duration.between(Instant.parse(planned),Instant.parse(observed)).toMillis(),instant(r,"queue_deadline_utc"),r.getString("state"),r.getString("reason_code"),materials,job,r.getString("execution_id"),execution);
        },pageArguments(w,p,s,before,limit));
        var windows=jdbc.query("SELECT * FROM execution_schedule_missed_windows WHERE workspace_id=? AND project_id=? AND schedule_id=?"+(missedBefore==null?"":" AND id<?")+" ORDER BY id DESC LIMIT ?",(r,n)->new ScheduleHistoryDtos.MissedWindow(r.getString("id"),r.getString("revision"),instant(r,"from_utc"),instant(r,"through_utc"),instant(r,"observed_at_utc"),r.getString("reason_code"),r.getString("missed_count")),pageArguments(w,p,s,missedBefore,limit));
        boolean more=items.size()>limit,moreWindows=windows.size()>limit;items=items.subList(0,Math.min(limit,items.size()));windows=windows.subList(0,Math.min(limit,windows.size()));
        return new ScheduleHistoryDtos.Page(ws,project,schedule,summary.status(),summary.reason(),summary.evaluated(),summary.admitted(),items,more?items.getLast().id():null,windows,moreWindows?windows.getLast().id():null);
    }
    private record Summary(String status,String reason,String evaluated,String admitted){}
    private static String verdict(com.fasterxml.jackson.databind.JsonNode summary){
        if(summary==null||!summary.isObject()||!summary.path("verdict").isTextual())return null;
        String value=summary.path("verdict").textValue();
        return Set.of("passed","failed","cancelled","timed-out","interrupted","rejected").contains(value)?value:null;
    }
    private static Object[] pageArguments(long ws,long project,long schedule,String before,int limit){var args=new ArrayList<Object>(List.of(ws,project,schedule));if(before!=null)args.add(id(before));args.add(limit+1);return args.toArray();}
    private static String instant(java.sql.ResultSet row,String column)throws java.sql.SQLException{var value=row.getObject(column,OffsetDateTime.class);return value==null?null:value.toInstant().toString();}
}
