package com.autumnharvestc.server.collaboration.policy;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import org.springframework.web.bind.annotation.*;

@RestController
public class CollaborationPolicyController {
    private final CollaborationPolicyService policies;
    public CollaborationPolicyController(CollaborationPolicyService policies){this.policies=policies;}
    @GetMapping("/api/v1/admin/collaboration/policy")
    public PolicyReadView platformRead(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor){return policies.readPlatform(actor);}
    @PutMapping("/api/v1/admin/collaboration/policy")
    public PolicyReadView platformPut(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@RequestBody com.fasterxml.jackson.databind.JsonNode request){return policies.writePlatform(actor,request);}
    @GetMapping({"/api/v1/workspaces/{ws}/collaboration/policy","/api/v1/workspaces/{ws}/projects/{project}/collaboration/policy"})
    public PolicyReadView read(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable Long ws,
                               @PathVariable(required=false) Long project) {
        return policies.read(actor,ws,project);
    }
    @PutMapping({"/api/v1/workspaces/{ws}/collaboration/policy","/api/v1/workspaces/{ws}/projects/{project}/collaboration/policy"})
    public PolicyReadView put(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount actor,@PathVariable Long ws,
                              @PathVariable(required=false) Long project,@RequestBody com.fasterxml.jackson.databind.JsonNode request) {
        return policies.write(actor,ws,project,request);
    }
}
