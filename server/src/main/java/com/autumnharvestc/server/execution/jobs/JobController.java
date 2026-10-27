package com.autumnharvestc.server.execution.jobs;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import java.util.*;
import static com.autumnharvestc.server.execution.ExecutionDtos.decode;

@RestController
@RequestMapping("/api/v1")
public class JobController {
    private final JobService jobs;
    private final CoreInputValidator inputValidator;
    public JobController(JobService jobs,CoreInputValidator inputValidator){this.jobs=jobs;this.inputValidator=inputValidator;}
    @PostMapping("/workspaces/{ws}/projects/{project}/jobs") @ResponseStatus(HttpStatus.CREATED)
    public Map<String,Object> submit(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode body){
        inputValidator.requireValid(body.get("target"),body.get("runConfig"));
        return jobs.submit(caller,ws,project,decode(body,JobDtos.Submit.class));
    }
    @GetMapping("/workspaces/{ws}/projects/{project}/jobs")
    public List<Map<String,Object>> list(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
        @PathVariable String ws,@PathVariable String project,
        @RequestParam(required=false) Integer limit,@RequestParam(required=false) String beforeJobId){
        return jobs.list(caller,ws,project,limit,beforeJobId);
    }
    @GetMapping("/jobs/{job}") public Map<String,Object> detail(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String job){return jobs.detail(caller,job);}
    @PostMapping("/jobs/{job}/cancel") public Map<String,Object> cancel(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String job){return jobs.cancel(caller,job);}
    @GetMapping("/jobs/{job}/report") public ResponseEntity<byte[]> report(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String job){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_JSON).body(jobs.report(caller,job));}
}
