package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.store.IdGeneration;
import com.autumnharvestc.server.execution.ExecutionDtos;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;
import static org.springframework.http.HttpStatus.*;

@Repository
public class ScheduleRepo {
    private final JdbcTemplate jdbc;private final IdGeneration ids;private final ObjectMapper json;
    public ScheduleRepo(JdbcTemplate jdbc,IdGeneration ids,ObjectMapper json){this.jdbc=jdbc;this.ids=ids;this.json=json;}
    public String encode(Object value){try{return json.writeValueAsString(value);}catch(Exception e){throw new IllegalStateException("Cannot encode schedule",e);}}
    public <T>T decode(String value,Class<T> type){try{return ExecutionDtos.decode(json.readTree(value),type);}catch(java.io.IOException e){throw new IllegalStateException("Invalid persisted schedule",e);}}
    /** Global admission row is separate from driver control; acquire before any project lock. */
    public void lockCapacity(){jdbc.queryForObject("SELECT id FROM execution_schedule_capacity_lock WHERE id=1 FOR UPDATE",Long.class);}
    public long count(Long ws,Long project){
        if(ws==null)return jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedules WHERE deleted=FALSE",Long.class);
        if(project==null)return jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedules WHERE workspace_id=? AND deleted=FALSE",Long.class,ws);
        return jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedules WHERE workspace_id=? AND project_id=? AND deleted=FALSE",Long.class,ws,project);
    }
    public long create(long ws,long project,long subject,ScheduleDtos.Save save,String snapshotVersion,String manifestHash){
        long schedule;
        if(ids.appAssigned()){schedule=ids.nextId();jdbc.update("INSERT INTO execution_schedules(id,workspace_id,project_id,subject_user_id,name,notifications_json,notification_pause_source_version) VALUES(?,?,?,?,?,?,1)",schedule,ws,project,subject,save.name(),encode(save.notifications()));}
        else{var key=new GeneratedKeyHolder();jdbc.update(c->{var s=c.prepareStatement("INSERT INTO execution_schedules(workspace_id,project_id,subject_user_id,name,notifications_json,notification_pause_source_version) VALUES(?,?,?,?,?,1)",new String[]{"id"});s.setLong(1,ws);s.setLong(2,project);s.setLong(3,subject);s.setString(4,save.name());s.setString(5,encode(save.notifications()));return s;},key);schedule=Objects.requireNonNull(key.getKey()).longValue();}
        jdbc.update("INSERT INTO execution_schedule_revisions(workspace_id,project_id,schedule_id,revision,subject_user_id,rule_json,policies_json,execution_json,snapshot_version,manifest_hash) VALUES(?,?,?,1,?,?,?,?,?,?)",ws,project,schedule,subject,encode(save.rule()),encode(save.policies()),encode(save.execution()),snapshotVersion,manifestHash);
        return schedule;
    }
    public ScheduleDtos.View require(long ws,long project,long schedule,boolean lock){
        if(lock)jdbc.queryForList("SELECT id FROM execution_schedules WHERE workspace_id=? AND project_id=? AND id=? FOR UPDATE",ws,project,schedule);
        return jdbc.query("SELECT s.*,r.rule_json,r.policies_json,r.execution_json,r.snapshot_version,r.manifest_hash FROM execution_schedules s JOIN execution_schedule_revisions r ON r.workspace_id=s.workspace_id AND r.project_id=s.project_id AND r.schedule_id=s.id AND r.revision=s.revision WHERE s.workspace_id=? AND s.project_id=? AND s.id=? AND s.deleted=FALSE",(r,n)->new ScheduleDtos.View(r.getString("id"),r.getString("workspace_id"),r.getString("project_id"),r.getString("name"),r.getString("version"),r.getString("revision"),r.getBoolean("enabled"),r.getString("subject_user_id"),decode(r.getString("rule_json"),ScheduleDtos.Rule.class),decode(r.getString("policies_json"),ScheduleDtos.Policies.class),decode(r.getString("execution_json"),ScheduleDtos.Execution.class),r.getString("snapshot_version"),r.getString("manifest_hash"),decode(r.getString("notifications_json"),ScheduleDtos.Notifications.class),r.getString("paused_reason_code"),instant(r,"next_planned_at_utc"),r.getString("cancellation_version"),instant(r,"evaluated_through_utc"),instant(r,"last_admitted_planned_at_utc")),ws,project,schedule).stream().findFirst().orElseThrow(()->error(NOT_FOUND,"schedule_not_found","定时任务不存在"));
    }
    private static String instant(java.sql.ResultSet row,String column)throws java.sql.SQLException{var value=row.getObject(column,java.time.OffsetDateTime.class);return value==null?null:value.toInstant().toString();}
    public List<ScheduleDtos.View> list(long ws,long project,int limit,Long before){
        var ids=before==null?jdbc.query("SELECT id FROM execution_schedules WHERE workspace_id=? AND project_id=? AND deleted=FALSE ORDER BY id DESC LIMIT ?",(r,n)->r.getLong(1),ws,project,limit):jdbc.query("SELECT id FROM execution_schedules WHERE workspace_id=? AND project_id=? AND deleted=FALSE AND id<? ORDER BY id DESC LIMIT ?",(r,n)->r.getLong(1),ws,project,before,limit);
        return ids.stream().map(value->require(ws,project,value,false)).toList();
    }
    public void update(ScheduleDtos.View old,ScheduleDtos.Save save,long subject,boolean revised,boolean enabled,long cancellation,String next,String snapshotVersion,String manifestHash){
        long ws=id(old.workspaceId()),project=id(old.projectId()),schedule=id(old.id()),revision=version(old.revision())+(revised?1:0);
        if(revised)jdbc.update("INSERT INTO execution_schedule_revisions(workspace_id,project_id,schedule_id,revision,subject_user_id,rule_json,policies_json,execution_json,snapshot_version,manifest_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",ws,project,schedule,revision,subject,encode(save.rule()),encode(save.policies()),encode(save.execution()),snapshotVersion,manifestHash);
        if(jdbc.update("UPDATE execution_schedules SET name=?,notifications_json=?,subject_user_id=?,revision=?,notification_pause_source_version=CASE WHEN ? THEN version+1 ELSE notification_pause_source_version END,version=version+1,enabled=?,cancellation_version=?,paused_reason_code=?,next_planned_at_utc=? WHERE workspace_id=? AND project_id=? AND id=? AND version=?",save.name(),encode(save.notifications()),subject,revision,old.enabled()&&!enabled,enabled,cancellation,enabled?null:old.enabled()?"schedule-paused":old.pausedReasonCode(),next==null?null:java.time.OffsetDateTime.parse(next),ws,project,schedule,version(old.version()))!=1)throw error(CONFLICT,"version_conflict","计划版本已变化");
    }
    public void delete(ScheduleDtos.View old){jdbc.update("UPDATE execution_schedules SET deleted=TRUE,enabled=FALSE,next_planned_at_utc=NULL,paused_reason_code='schedule-deleted',notification_pause_source_version=version+1,version=version+1,cancellation_version=cancellation_version+1 WHERE workspace_id=? AND project_id=? AND id=? AND version=?",id(old.workspaceId()),id(old.projectId()),id(old.id()),version(old.version()));}
    public void cancelInvalidated(long schedule,java.time.Instant now){
        jdbc.update("UPDATE execution_schedule_occurrences SET state='skipped',reason_code='schedule-cancelled',terminal_at_utc=?,owner_id=NULL,lease_until_utc=NULL WHERE schedule_id=? AND state IN ('pending','waiting-overlap') AND EXISTS(SELECT 1 FROM execution_schedules s WHERE s.id=schedule_id AND (s.enabled=FALSE OR s.deleted=TRUE OR s.revision<>execution_schedule_occurrences.revision OR s.cancellation_version<>execution_schedule_occurrences.cancellation_version))",now.atOffset(java.time.ZoneOffset.UTC),schedule);
    }
    public void startEvaluationAt(long schedule,java.time.Instant after){jdbc.update("UPDATE execution_schedules SET evaluation_anchor_utc=? WHERE id=?",after.atOffset(java.time.ZoneOffset.UTC),schedule);}
}
