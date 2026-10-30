package com.autumnharvestc.server.execution.scheduling;

/** Disabled deployments still observe original Jobs; they never scan new triggers. */
@org.springframework.stereotype.Component
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(prefix="apicc.scheduler",name="mode",havingValue="disabled")
public class DisabledScheduleReleaseTimer {
    private final ScheduleOccurrenceService occurrences;
    public DisabledScheduleReleaseTimer(ScheduleOccurrenceService occurrences){this.occurrences=occurrences;}
    @org.springframework.scheduling.annotation.Scheduled(fixedDelayString="${apicc.scheduler.scan-interval-ms:1000}",initialDelayString="${apicc.scheduler.scan-interval-ms:1000}")
    public void wake(){occurrences.observeReleased();}
}
