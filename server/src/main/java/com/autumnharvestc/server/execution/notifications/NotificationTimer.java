package com.autumnharvestc.server.execution.notifications;

import org.springframework.stereotype.Component;

@Component
public class NotificationTimer {
    private final NotificationEventRepo repo;private final NotificationEventService events;
    private final NotificationOutboxService outbox;
    private final NotificationRetentionService retention;
    public NotificationTimer(NotificationEventRepo repo,NotificationEventService events,NotificationOutboxService outbox,NotificationRetentionService retention){this.repo=repo;this.events=events;this.outbox=outbox;this.retention=retention;}
    @org.springframework.scheduling.annotation.Scheduled(fixedDelayString="${apicc.notification.scan-interval-ms:1000}",initialDelayString="${apicc.notification.scan-interval-ms:1000}")
    public void wake(){for(long ws:repo.workspaces(50))try{events.observe(ws);}catch(RuntimeException ignored){/* Retry durable sources on the next bounded scan; never log source data. */}outbox.dispatch();try{retention.clean();}catch(RuntimeException ignored){/* Fail closed and retry bounded cleanup; no source data in logs. */}}
}
