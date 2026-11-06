package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.auth.AuthFilter;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;
@RestController
public class SyncPolicyController {
    private final SyncPolicyService service;
    public SyncPolicyController(SyncPolicyService service){this.service=service;}
    @GetMapping({"/api/v1/workspaces/{ws}/sync/policy","/api/v1/workspaces/{ws}/projects/{project}/sync/policy"})
    public JsonNode read(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable(required=false) String project){return service.read(actor,ws,project);}
    @PutMapping({"/api/v1/workspaces/{ws}/sync/policy","/api/v1/workspaces/{ws}/projects/{project}/sync/policy"})
    public JsonNode save(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable String ws,@PathVariable(required=false) String project,@RequestBody JsonNode input){return service.save(actor,ws,project,input);}
}
