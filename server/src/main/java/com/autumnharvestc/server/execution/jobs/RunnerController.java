package com.autumnharvestc.server.execution.jobs;

import com.autumnharvestc.server.execution.agent.AgentPrincipal;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import org.springframework.web.context.request.async.DeferredResult;
import java.util.*;
import static com.autumnharvestc.server.execution.ExecutionDtos.decode;

@RestController
@RequestMapping("/api/v1/runner")
public class RunnerController {
    private final RunnerControlService control;private final RunnerPollWaiters waiters;private final JobService jobs;
    public RunnerController(RunnerControlService control,RunnerPollWaiters waiters,JobService jobs){this.control=control;this.waiters=waiters;this.jobs=jobs;}
    @PostMapping("/runtime") public Map<String,Object> runtime(@RequestAttribute(AgentPrincipal.ATTRIBUTE) AgentPrincipal agent,@RequestBody JsonNode body){return control.runtime(agent.agentId(),decode(body,JobDtos.RuntimeRegistration.class));}
    @PostMapping("/poll") public DeferredResult<JobDtos.Batch> poll(@RequestAttribute(AgentPrincipal.ATTRIBUTE) AgentPrincipal agent,@RequestBody JsonNode body){return waiters.poll(agent.agentId(),decode(body,JobDtos.Exchange.class));}
    @PostMapping("/heartbeat") public JobDtos.Batch heartbeat(@RequestAttribute(AgentPrincipal.ATTRIBUTE) AgentPrincipal agent,@RequestBody JsonNode body){return control.exchange(agent.agentId(),decode(body,JobDtos.Exchange.class));}
    @PostMapping("/messages") public Map<String,Object> messages(@RequestAttribute(AgentPrincipal.ATTRIBUTE) AgentPrincipal agent,@RequestBody JsonNode body){return control.messages(agent.agentId(),body);}
    @GetMapping("/jobs/{job}/inputs") public ResponseEntity<Map<String,Object>> inputs(@RequestAttribute(AgentPrincipal.ATTRIBUTE) AgentPrincipal agent,@PathVariable String job,@RequestParam String executionId){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(jobs.inputs(agent.agentId(),job,executionId));}
    @PutMapping(value="/jobs/{job}/report",consumes=MediaType.APPLICATION_OCTET_STREAM_VALUE) public Map<String,Object> upload(@RequestAttribute(AgentPrincipal.ATTRIBUTE) AgentPrincipal agent,@PathVariable String job,@RequestParam String executionId,@RequestHeader("X-Report-Hash") String hash,@RequestBody byte[] bytes){return jobs.upload(agent.agentId(),job,executionId,hash,bytes);}
}
