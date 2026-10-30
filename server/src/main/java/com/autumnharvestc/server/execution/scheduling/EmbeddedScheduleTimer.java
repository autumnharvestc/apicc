package com.autumnharvestc.server.execution.scheduling;

import org.springframework.stereotype.Component;

@Component
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(prefix="apicc.scheduler",name="mode",havingValue="embedded",matchIfMissing=true)
public class EmbeddedScheduleTimer {
    private final EmbeddedScheduleDriver driver;
    public EmbeddedScheduleTimer(ScheduleOccurrenceService occurrences,ScheduledJobSubmission submission){this.driver=new EmbeddedScheduleDriver(occurrences,submission,java.util.UUID.randomUUID().toString());}
    @org.springframework.scheduling.annotation.Scheduled(fixedDelayString="${apicc.scheduler.scan-interval-ms:1000}",initialDelayString="${apicc.scheduler.scan-interval-ms:1000}")
    public void wake(){driver.tick();}
}
