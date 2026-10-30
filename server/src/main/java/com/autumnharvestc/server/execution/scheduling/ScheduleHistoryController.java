package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/workspaces/{ws}/projects/{project}/schedules/{id}/history")
public class ScheduleHistoryController {
    private final ScheduleHistoryService service;
    public ScheduleHistoryController(ScheduleHistoryService service){this.service=service;}
    @GetMapping public ScheduleHistoryDtos.Page history(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@PathVariable String id,@RequestParam(required=false)Integer limit,@RequestParam(required=false)String beforeId,@RequestParam(required=false)String missedBeforeId){return service.history(caller,ws,project,id,limit,beforeId,missedBeforeId);}
}
