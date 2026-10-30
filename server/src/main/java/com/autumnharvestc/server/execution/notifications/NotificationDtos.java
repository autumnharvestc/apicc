package com.autumnharvestc.server.execution.notifications;

import java.util.List;

/** Safe public projections. No channel secrets, bodies, leases, or internal rows. */
public final class NotificationDtos {
    private NotificationDtos(){}
    public record Event(String id,String workspaceId,String projectId,String scheduleId,String scheduleName,String projectName,
        String sourceId,String sourceVersion,String eventKind,String reasonCode,String link,String plannedAtUtc,String revision,
        String snapshotVersion,String jobId,String executionId,String verdict,String evidenceState,String reportState,
        String createdAtUtc,String notificationState,boolean read,List<NotificationOutboxRepo.DeliveryView> deliveries,
        String snapshotId,String observedAtUtc,String startedAtUtc,String finishedAtUtc){}
    public record Page(List<Event> items,String nextBeforeId){}
    public record HistoryEvent(String eventId,String sourceId,String sourceVersion,String eventKind,String createdAtUtc,
        String detailState,boolean inApp,String notificationState,List<String> reasonCodes,List<NotificationOutboxRepo.DeliveryView> deliveries){}
    /** Observed consumer facts, not a second durable lifecycle. Unknown legacy pause versions stay null. */
    public record SourceObservation(String sourceId,String sourceVersion,String observationState,String eventId,Boolean inApp){}
    public record HistoryPage(String workspaceId,String projectId,String scheduleId,List<HistoryEvent> items,String nextBeforeId,
        List<SourceObservation> sources,String nextSourceBeforeId,SourceObservation pauseSource){}
}
