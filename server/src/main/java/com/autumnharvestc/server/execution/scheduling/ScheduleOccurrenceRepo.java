package com.autumnharvestc.server.execution.scheduling;

import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import com.autumnharvestc.server.store.IdGeneration;

@Repository
public class ScheduleOccurrenceRepo {
    private final JdbcTemplate jdbc;
    private final IdGeneration ids;
    public ScheduleOccurrenceRepo(JdbcTemplate jdbc,IdGeneration ids){this.jdbc=jdbc;this.ids=ids;}
    public record Scope(long workspace,long project,long schedule){}
    public record Row(long id,Scope scope,long revision,long cancellationVersion,long subject,Instant plannedAt,Instant observedAt,Instant queueDeadline,String state,String reason,String materials,String owner,Long generation,Instant leaseUntil,String jobId,Instant terminalAt){}
    public Optional<Row> find(long occurrence,boolean lock){return jdbc.query("SELECT * FROM execution_schedule_occurrences WHERE id=?"+(lock?" FOR UPDATE":""),this::mapRow,occurrence).stream().findFirst();}
    public Row row(long occurrence,boolean lock){return find(occurrence,lock).orElseThrow();}
    private Row mapRow(java.sql.ResultSet r,int n)throws java.sql.SQLException{return new Row(r.getLong("id"),new Scope(r.getLong("workspace_id"),r.getLong("project_id"),r.getLong("schedule_id")),r.getLong("revision"),r.getLong("cancellation_version"),r.getLong("subject_user_id"),instant(r,"planned_at_utc"),instant(r,"observed_at_utc"),instant(r,"queue_deadline_utc"),r.getString("state"),r.getString("reason_code"),r.getString("materials_json"),r.getString("owner_id"),(Long)r.getObject("generation"),instant(r,"lease_until_utc"),r.getString("job_id"),instant(r,"terminal_at_utc"));}
    public Instant anchor(Scope scope){return jdbc.queryForObject("SELECT evaluation_anchor_utc FROM execution_schedules WHERE id=?",(r,n)->instant(r,"evaluation_anchor_utc"),scope.schedule());}
    public boolean currentBarrier(Row row){return jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedules WHERE id=? AND workspace_id=? AND project_id=? AND enabled=TRUE AND deleted=FALSE AND revision=? AND cancellation_version=? AND subject_user_id=?",Long.class,row.scope().schedule(),row.scope().workspace(),row.scope().project(),row.revision(),row.cancellationVersion(),row.subject())==1;}
    public int removeDetails(Row row,Instant cutoff,Instant now){return jdbc.update("DELETE FROM execution_schedule_occurrences WHERE id=? AND state IN ('skipped','rejected','expired','submitted') AND terminal_at_utc<=? AND (lease_until_utc IS NULL OR lease_until_utc<=?)",row.id(),utc(cutoff),utc(now));}
    private static Instant instant(java.sql.ResultSet row,String column)throws java.sql.SQLException{var value=row.getObject(column,OffsetDateTime.class);return value==null?null:value.toInstant();}
    public boolean take(Row row,String owner,long generation,Instant now,Instant until){return jdbc.update("UPDATE execution_schedule_occurrences SET owner_id=?,generation=?,lease_until_utc=? WHERE id=? AND state IN ('pending','waiting-overlap') AND revision=? AND cancellation_version=? AND (lease_until_utc IS NULL OR lease_until_utc<=?) AND EXISTS(SELECT 1 FROM execution_scheduler_control c WHERE c.id=1 AND c.mode='embedded' AND c.generation=?) AND EXISTS(SELECT 1 FROM execution_schedules s WHERE s.id=? AND s.enabled=TRUE AND s.deleted=FALSE AND s.revision=? AND s.cancellation_version=? AND s.subject_user_id=?)",owner,generation,utc(until),row.id(),row.revision(),row.cancellationVersion(),utc(now),generation,row.scope().schedule(),row.revision(),row.cancellationVersion(),row.subject())==1;}
    public void seal(long occurrence,String materials){jdbc.update("UPDATE execution_schedule_occurrences SET materials_json=? WHERE id=?",materials,occurrence);}
    public String execution(Row row){return jdbc.queryForObject("SELECT execution_json FROM execution_schedule_revisions WHERE schedule_id=? AND revision=?",String.class,row.scope().schedule(),row.revision());}
    public void link(Row row,ScheduleOccurrenceService.JobLink link,Instant now){
        int updated=jdbc.update("UPDATE execution_schedule_occurrences SET state='submitted',job_id=?,execution_id=?,owner_id=NULL,lease_until_utc=NULL WHERE id=? AND state IN ('pending','waiting-overlap') AND owner_id=? AND generation=? AND lease_until_utc=? AND lease_until_utc>? AND queue_deadline_utc>? AND revision=? AND cancellation_version=? AND EXISTS(SELECT 1 FROM execution_scheduler_control c WHERE c.id=1 AND c.mode='embedded' AND c.generation=?)",Long.parseLong(link.jobId()),Long.parseLong(link.executionId()),row.id(),row.owner(),row.generation(),utc(row.leaseUntil()),utc(now),utc(now),row.revision(),row.cancellationVersion(),row.generation());
        if(updated!=1)throw new IllegalStateException("Scheduled claim changed before job association");
    }
    public boolean matchingJob(Row row,ScheduleOccurrenceService.JobLink link,String intent){return jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE id=? AND execution_id=? AND workspace_id=? AND project_id=? AND submitted_by=? AND intent_id=?",Long.class,Long.parseLong(link.jobId()),Long.parseLong(link.executionId()),row.scope().workspace(),row.scope().project(),row.subject(),intent)==1;}
    /** Call under the plan's project/schedule locks; job callbacks never lock this table. */
    public boolean precedingActive(Row row){return jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences o LEFT JOIN execution_jobs j ON j.id=o.job_id WHERE o.schedule_id=? AND o.planned_at_utc<? AND (o.state IN ('pending','waiting-overlap') OR (o.state='submitted' AND (j.id IS NULL OR j.execution_released=FALSE)))",Long.class,row.scope().schedule(),utc(row.plannedAt()))>0;}
    public boolean hasWaiting(Scope scope){return jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=? AND state='waiting-overlap'",Long.class,scope.schedule())>0;}
    public void waitForOverlap(long occurrence){jdbc.update("UPDATE execution_schedule_occurrences SET state='waiting-overlap',reason_code='schedule-overlap-waiting',owner_id=NULL,lease_until_utc=NULL WHERE id=? AND state='pending'",occurrence);}
    private static final String RELEASED_JOB="j.id=o.job_id AND j.execution_id=o.execution_id AND j.workspace_id=o.workspace_id AND j.project_id=o.project_id AND j.submitted_by=o.subject_user_id AND j.schedule_occurrence_id=o.id AND j.schedule_id=o.schedule_id AND j.schedule_revision=o.revision AND j.state='ended' AND j.execution_released=TRUE";
    public List<String> releasedCandidates(int limit){return jdbc.query("SELECT o.id FROM execution_schedule_occurrences o JOIN execution_jobs j ON "+RELEASED_JOB+" WHERE o.state='submitted' AND o.terminal_at_utc IS NULL ORDER BY o.id LIMIT ?",(r,n)->r.getString(1),limit);}
    /** Positive, scope/source/execution-matching proof for T5 retention references; missing or uncertain Jobs fail closed. */
    public boolean hasReleasedJob(Row row){return jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences o JOIN execution_jobs j ON "+RELEASED_JOB+" WHERE o.id=?",Long.class,row.id())==1;}
    public void observeReleased(Row row,Instant observedAt){if(row.state().equals("submitted")&&hasReleasedJob(row))jdbc.update("UPDATE execution_schedule_occurrences SET terminal_at_utc=COALESCE(terminal_at_utc,?) WHERE id=? AND state='submitted'",utc(observedAt),row.id());}
    public void terminal(long occurrence,String state,String reason,Instant now){jdbc.update("UPDATE execution_schedule_occurrences SET state=?,reason_code=?,terminal_at_utc=?,owner_id=NULL,lease_until_utc=NULL WHERE id=?",state,reason,utc(now),occurrence);}
    public void pause(Scope scope,String reason){jdbc.update("UPDATE execution_schedules SET enabled=FALSE,paused_reason_code=?,next_planned_at_utc=NULL,notification_pause_source_version=version+1,version=version+1,cancellation_version=cancellation_version+1 WHERE id=?",reason,scope.schedule());}
    public List<Scope> scheduled(Instant now,int limit){return jdbc.query("SELECT workspace_id,project_id,id FROM execution_schedules WHERE next_planned_at_utc<=? ORDER BY next_planned_at_utc,id LIMIT ?",(r,n)->new Scope(r.getLong(1),r.getLong(2),r.getLong(3)),utc(now),limit);}
    public void lockProject(Scope scope){jdbc.queryForList("SELECT id FROM projects WHERE workspace_id=? AND id=? FOR UPDATE",scope.workspace(),scope.project());}
    public void lockSchedule(Scope scope){jdbc.queryForList("SELECT id FROM execution_schedules WHERE workspace_id=? AND project_id=? AND id=? FOR UPDATE",scope.workspace(),scope.project(),scope.schedule());}
    public boolean activePlan(Scope scope){return jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedules WHERE workspace_id=? AND project_id=? AND id=? AND deleted=FALSE",Long.class,scope.workspace(),scope.project(),scope.schedule())==1;}
    public List<String> recoverable(Instant now,int limit){return jdbc.query("SELECT id FROM execution_schedule_occurrences WHERE state IN ('pending','waiting-overlap') AND (lease_until_utc IS NULL OR lease_until_utc<=? OR queue_deadline_utc<=?) ORDER BY id LIMIT ?",(r,n)->r.getString(1),utc(now),utc(now),limit);}
    public long insert(ScheduleDtos.View plan,Instant at,Instant now,String owner,long generation,long leaseMs,long queueTimeoutMs){
        var key=new GeneratedKeyHolder();
        String sql="INSERT INTO execution_schedule_occurrences("+(ids.appAssigned()?"id,":"")+"workspace_id,project_id,schedule_id,revision,cancellation_version,subject_user_id,planned_at_utc,observed_at_utc,queue_deadline_utc,state,owner_id,generation,lease_until_utc) VALUES("+(ids.appAssigned()?"?,":"")+"?,?,?,?,?,?,?,?,?,'pending',?,?,?)";
        jdbc.update(c->{var s=c.prepareStatement(sql,new String[]{"id"});int i=1;if(ids.appAssigned())s.setLong(i++,ids.nextId());s.setLong(i++,Long.parseLong(plan.workspaceId()));s.setLong(i++,Long.parseLong(plan.projectId()));s.setLong(i++,Long.parseLong(plan.id()));s.setLong(i++,Long.parseLong(plan.revision()));s.setLong(i++,Long.parseLong(plan.cancellationVersion()));s.setLong(i++,Long.parseLong(plan.subjectUserId()));s.setObject(i++,utc(at));s.setObject(i++,utc(now));s.setObject(i++,utc(at.plusMillis(queueTimeoutMs)));s.setString(i++,owner);s.setLong(i++,generation);s.setObject(i,utc(now.plusMillis(leaseMs)));return s;},key);
        return Objects.requireNonNull(key.getKey()).longValue();
    }
    public void advance(Scope scope,Instant through,String next){jdbc.update("UPDATE execution_schedules SET evaluated_through_utc=?,last_admitted_planned_at_utc=?,next_planned_at_utc=? WHERE id=?",utc(through),utc(through),next==null?null:OffsetDateTime.parse(next),scope.schedule());}
    public void cursor(Scope scope,String next){jdbc.update("UPDATE execution_schedules SET next_planned_at_utc=? WHERE id=?",next==null?null:OffsetDateTime.parse(next),scope.schedule());}
    public void closeGap(Scope scope,Instant through,String next){jdbc.update("UPDATE execution_schedules SET evaluated_through_utc=?,next_planned_at_utc=? WHERE id=?",utc(through),next==null?null:OffsetDateTime.parse(next),scope.schedule());}
    public void missed(ScheduleDtos.View plan,Instant from,Instant through,Instant now,String reason){
        String prefix=ids.appAssigned()?"id,":"";var args=new ArrayList<Object>();if(ids.appAssigned())args.add(ids.nextId());args.addAll(List.of(Long.parseLong(plan.workspaceId()),Long.parseLong(plan.projectId()),Long.parseLong(plan.id()),Long.parseLong(plan.revision()),utc(from),utc(through),utc(now),reason));
        jdbc.update("INSERT INTO execution_schedule_missed_windows("+prefix+"workspace_id,project_id,schedule_id,revision,from_utc,through_utc,observed_at_utc,reason_code) VALUES("+(ids.appAssigned()?"?,":"")+"?,?,?,?,?,?,?,?)",args.toArray());
    }
    static OffsetDateTime utc(Instant instant){return instant.atOffset(ZoneOffset.UTC);}
}
