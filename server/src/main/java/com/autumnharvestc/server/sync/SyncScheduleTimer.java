package com.autumnharvestc.server.sync;
import org.springframework.stereotype.Component;
@Component
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(prefix="apicc.scheduler",name="mode",havingValue="embedded",matchIfMissing=true)
public class SyncScheduleTimer {
    private final SyncScheduleDriver driver;
    public SyncScheduleTimer(SyncScheduleDriver driver){this.driver=driver;}
    @org.springframework.scheduling.annotation.Scheduled(fixedDelayString="${apicc.scheduler.scan-interval-ms:1000}",initialDelayString="${apicc.scheduler.scan-interval-ms:1000}")
    public void scanSynchronizationSources(){driver.tick();}
}
