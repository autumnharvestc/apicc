package com.autumnharvestc.server.execution.notifications;

import java.time.*;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import com.autumnharvestc.server.execution.scheduling.*;

/** References are called under T3's control/project/schedule/occurrence locks: no notification locks here. */
@Service
public class NotificationRetentionService implements ScheduleRetentionService.References {
    private final JdbcTemplate jdbc;private final ScheduleOccurrenceRepo occurrences;private final ScheduleRetentionService retention;private final SchedulerProperties properties;private final ScheduleTimeSource time;private final SchedulePolicyService policies;private final NotificationEventRepo events;private final NotificationChannelRepo channels;private final NotificationOutboxRepo outbox;private final TransactionTemplate transaction;
    private long occurrenceCursor,deliveryCursor,eventCursor;
    public NotificationRetentionService(JdbcTemplate jdbc,ScheduleOccurrenceRepo occurrences,ScheduleRetentionService retention,SchedulerProperties properties,ScheduleTimeSource time,SchedulePolicyService policies,NotificationEventRepo events,NotificationChannelRepo channels,NotificationOutboxRepo outbox,TransactionTemplate transaction){this.jdbc=jdbc;this.occurrences=occurrences;this.retention=retention;this.properties=properties;this.time=time;this.policies=policies;this.events=events;this.channels=channels;this.outbox=outbox;this.transaction=transaction;}
    public ScheduleRetentionService.Proof inspect(ScheduleOccurrenceRepo.Row row){
        boolean noJob=row.jobId()==null&&!row.state().equals("submitted")||row.state().equals("submitted")&&occurrences.hasReleasedJob(row);
        boolean consumed=jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE id=? AND notification_processed_version=1",Long.class,row.id())==1;
        boolean pending=jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_outbox d JOIN execution_notification_events e ON e.id=d.event_id WHERE e.workspace_id=? AND e.project_id=? AND e.source_id=? AND d.state IN ('pending','sending')",Long.class,row.scope().workspace(),row.scope().project(),"occurrence/"+row.id())>0;
        return new ScheduleRetentionService.Proof(noJob,consumed&&!pending);
    }
    private Instant cutoff(long ws,long project){long days=((Number)((Map<?,?>)policies.effective(ws,project).get("effective")).get("notificationRetentionDays")).longValue();return time.now().minus(Duration.ofDays(days));}
    /** Each scan advances a finite keyset page. Proofs and cleanup never acquire locks in reverse order. */
    public synchronized int clean(){
        int batch=properties.getBatchSize();var minimum=time.now().minus(Duration.ofDays(1)).atOffset(ZoneOffset.UTC);
        var ids=jdbc.query("SELECT id FROM execution_schedule_occurrences WHERE id>? AND terminal_at_utc<=? ORDER BY id LIMIT ?",(r,n)->r.getLong(1),occurrenceCursor,minimum,batch);occurrenceCursor=ids.size()<batch?0:ids.getLast();
        int removed=retention.prune(ids.stream().map(String::valueOf).toList(),this);
        var deliveries=jdbc.query("SELECT id FROM execution_notification_outbox WHERE id>? AND body_json IS NOT NULL AND state NOT IN ('pending','sending') AND updated_at<=? ORDER BY id LIMIT ?",(r,n)->r.getLong(1),deliveryCursor,minimum,batch);deliveryCursor=deliveries.size()<batch?0:deliveries.getLast();
        transaction.executeWithoutResult(status->{events.gate();for(long id:deliveries){var candidate=outbox.find(id,false);if(candidate.isEmpty())continue;var d=candidate.orElseThrow();channels.find(d.workspace(),d.channel(),true);var current=outbox.find(id,true).orElseThrow();if(!Set.of("pending","sending").contains(current.state()))jdbc.update("UPDATE execution_notification_outbox SET body_json=NULL,limits_json=NULL WHERE id=? AND updated_at<=?",id,cutoff(d.workspace(),d.project()).atOffset(ZoneOffset.UTC));}});
        var heads=jdbc.query("SELECT id FROM execution_notification_events WHERE id>? AND body_json IS NOT NULL AND created_at<=? ORDER BY id LIMIT ?",(r,n)->r.getLong(1),eventCursor,minimum,batch);eventCursor=heads.size()<batch?0:heads.getLast();
        transaction.executeWithoutResult(status->{events.gate();for(long id:heads){var scope=jdbc.queryForMap("SELECT workspace_id,project_id FROM execution_notification_events WHERE id=?",id);jdbc.update("UPDATE execution_notification_events SET body_json=NULL WHERE id=? AND created_at<=? AND NOT EXISTS(SELECT 1 FROM execution_notification_outbox d WHERE d.event_id=execution_notification_events.id AND (d.state IN ('pending','sending') OR d.body_json IS NOT NULL))",id,cutoff(((Number)scope.get("workspace_id")).longValue(),((Number)scope.get("project_id")).longValue()).atOffset(ZoneOffset.UTC));}});
        return removed;
    }
}
