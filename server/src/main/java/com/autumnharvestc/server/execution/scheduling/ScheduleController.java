package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.execution.ExecutionDtos;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/workspaces/{ws}")
public class ScheduleController {
    private final AgentService agents;
    private final ScheduleRuleCalculator calculator;
    private final SchedulePolicyService policies;
    private final SchedulerProperties properties;
    public ScheduleController(AgentService agents,ScheduleRuleCalculator calculator,SchedulePolicyService policies,SchedulerProperties properties){this.agents=agents;this.calculator=calculator;this.policies=policies;this.properties=properties;}
    @GetMapping("/schedule-policy") public java.util.Map<String,Object> workspace(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws){return policies.workspace(caller,ws);}
    @GetMapping("/projects/{project}/schedule-policy") public java.util.Map<String,Object> project(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project){return policies.project(caller,ws,project);}
    @PutMapping("/schedule-policy") public java.util.Map<String,Object> workspace(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@RequestBody JsonNode body){var update=policyUpdate(body);return policies.save(caller,ws,null,update.expectedVersion(),update.policy(),update.resetKeys());}
    @PutMapping("/projects/{project}/schedule-policy") public java.util.Map<String,Object> project(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount caller,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode body){var update=policyUpdate(body);return policies.save(caller,ws,project,update.expectedVersion(),update.policy(),update.resetKeys());}
    private ScheduleDtos.PolicyUpdate policyUpdate(JsonNode body){if(body.has("resetKeys")&&body.get("resetKeys").isNull())throw com.autumnharvestc.server.execution.agent.AgentRepo.error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","恢复继承字段不能为null");return ExecutionDtos.decode(body,ScheduleDtos.PolicyUpdate.class);}
    @PostMapping("/projects/{project}/schedules/preview")
    public ScheduleDtos.Preview preview(HttpServletRequest request,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode body) {
        var entity=agents.requireProject((UserAccount)request.getAttribute(AuthFilter.ATTR_USER),ws,project,false);
        var input=ExecutionDtos.decode(body,ScheduleDtos.PreviewRequest.class);
        var effective=(java.util.Map<?,?>)policies.effective(entity.workspaceId(),entity.id()).get("effective");
        return calculator.preview(input.rule(),ScheduleRuleCalculator.instant(input.afterUtc()),((Number)effective.get("minIntervalMs")).longValue(),properties.getEvaluationMaxCandidates());
    }
}
