package com.autumnharvestc.server.execution.scheduling;

import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.ApplicationArguments;
import org.springframework.stereotype.Component;

@Component
public class ScheduleControlStartup implements ApplicationRunner {
    private final ScheduleControlService service;private final SchedulerProperties properties;
    public ScheduleControlStartup(ScheduleControlService service,SchedulerProperties properties){this.service=service;this.properties=properties;}
    @Override public void run(ApplicationArguments args){service.initialize(properties.getMode());}
}
