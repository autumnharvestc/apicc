package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.auth.AuthFilter;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/v1/workspaces/{ws}/projects/{project}/sync/candidates")
public class SyncCandidateController {
    private final SyncCandidateService service;
    public SyncCandidateController(SyncCandidateService service){this.service=service;}
    @GetMapping("/{candidate}/changes/{change}/details") public JsonNode detail(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String candidate,@PathVariable String change,@RequestParam String side){return service.detail(actor,ws,project,candidate,change,side);}
    @GetMapping("/{candidate}") public JsonNode read(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String candidate){return service.read(actor,ws,project,candidate);}
}
