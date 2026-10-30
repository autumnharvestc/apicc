package com.autumnharvestc.server.execution.scheduling;

import java.util.List;
import com.autumnharvestc.server.execution.ExecutionDtos;

/** Public business projection, never an occurrence row or lease projection. */
public final class ScheduleHistoryDtos {
    private ScheduleHistoryDtos(){}
    public record Materials(String status,String projectId,List<ExecutionDtos.CredentialSelection> credentials,List<ExecutionDtos.AttachmentSelection> attachments){}
    public record Execution(String availability,String state,Boolean released,String reportState,String verdict){}
    public record Occurrence(String id,String workspaceId,String projectId,String scheduleId,String revision,String cancellationVersion,String subjectUserId,
        String plannedAtUtc,String observedAtUtc,long delayMs,String queueDeadlineUtc,String state,String reasonCode,Materials materials,
        String jobId,String executionId,Execution execution){}
    public record MissedWindow(String id,String revision,String fromUtc,String throughUtc,String observedAtUtc,String reasonCode,String missedCount){}
    public record Page(String workspaceId,String projectId,String scheduleId,String evaluationStatus,String pausedReasonCode,
        String evaluatedThroughUtc,String lastAdmittedPlannedAtUtc,List<Occurrence> items,String nextBeforeId,
        List<MissedWindow> missedWindows,String nextMissedBeforeId){}
}
