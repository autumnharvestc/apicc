package com.autumnharvestc.server.execution.scheduling;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/scheduler/control")
public class ScheduleControlController {
    private final ScheduleControlService service;
    public ScheduleControlController(ScheduleControlService service){this.service=service;}
    @GetMapping public ScheduleControlService.View read(@RequestAttribute(com.autumnharvestc.server.auth.AuthFilter.ATTR_USER)com.autumnharvestc.server.store.UserAccount caller){com.autumnharvestc.server.execution.agent.AgentService.requirePlatform(caller);return service.read();}
    @PutMapping public ScheduleControlService.View change(@RequestAttribute(com.autumnharvestc.server.auth.AuthFilter.ATTR_USER)com.autumnharvestc.server.store.UserAccount caller,@RequestBody com.fasterxml.jackson.databind.JsonNode input){com.autumnharvestc.server.execution.agent.AgentService.requirePlatform(caller);return service.change(com.autumnharvestc.server.execution.ExecutionDtos.decode(input,ScheduleControlService.Update.class));}
}
