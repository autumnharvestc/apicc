package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.ExecutionDtos;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;

@RestController
@RequestMapping("/api/v1/workspaces/{ws}/projects/{project}")
public class SchedulePlanController {
    private final ScheduleService service;private final ScheduleGrantService grants;
    public SchedulePlanController(ScheduleService service,ScheduleGrantService grants){this.service=service;this.grants=grants;}
    @GetMapping("/schedule-grants") public java.util.Map<String,Object> grants(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project){return grants.get(caller,ws,project);}
    @GetMapping("/schedule-grants/options") public java.util.Map<String,Object> grantOptions(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project){return grants.options(caller,ws,project);}
    @PutMapping("/schedule-grants") public java.util.Map<String,Object> grants(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode input){return grants.save(caller,ws,project,ExecutionDtos.decode(input,ScheduleDtos.GrantUpdate.class));}
    @PostMapping("/schedules") @ResponseStatus(HttpStatus.CREATED)
    public ScheduleDtos.View create(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode input){return service.create(caller,ws,project,ExecutionDtos.decode(input,ScheduleDtos.Save.class));}
    @GetMapping("/schedules") public java.util.Map<String,Object> list(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@RequestParam(required=false)Integer limit,@RequestParam(required=false)String beforeId){return service.list(caller,ws,project,limit,beforeId);}
    @GetMapping("/schedules/options") public java.util.Map<String,Object> options(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project){return service.options(caller,ws,project);}
    @GetMapping("/schedules/material-options") public java.util.Map<String,Object> materials(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project){return service.materialOptions(caller,ws,project);}
    @GetMapping("/schedules/{id}") public ScheduleDtos.View detail(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@PathVariable String id){return service.detail(caller,ws,project,id);}
    @PutMapping("/schedules/{id}") public ScheduleDtos.View update(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@PathVariable String id,@RequestBody JsonNode input){input.forEach(value->{if(value.isNull())throw com.autumnharvestc.server.execution.agent.AgentRepo.error(HttpStatus.BAD_REQUEST,"validation_failed","更新字段不可为 null；省略字段保持原值");});return service.update(caller,ws,project,id,ExecutionDtos.decode(input,ScheduleDtos.Update.class));}
    @DeleteMapping("/schedules/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void delete(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@PathVariable String id,@RequestParam String expectedVersion){service.delete(caller,ws,project,id,expectedVersion);}
}
