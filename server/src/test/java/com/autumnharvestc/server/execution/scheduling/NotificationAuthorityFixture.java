package com.autumnharvestc.server.execution.scheduling;

/** Test-only access to the existing package-private, fully fenced rejection authority. */
public final class NotificationAuthorityFixture {
    private NotificationAuthorityFixture(){}
    public static void reject(ScheduleOccurrenceService service,ScheduleOccurrenceService.Claim claim,String reason){service.recordSubmissionFailure(claim,reason);}
}
