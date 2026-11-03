package com.autumnharvestc.server.access;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

/** Safe current access and scoped access management routes. */
@RestController
public class AccessController {
    private final ProjectAccessService access;
    private final AccessManagementService management;
    public AccessController(ProjectAccessService access, AccessManagementService management) { this.access = access; this.management = management; }

    @GetMapping("/api/v1/workspaces/{ws}/projects/{project}/access")
    public ProjectAccessView current(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                     @PathVariable Long ws, @PathVariable Long project) {
        return access.resolve(caller.id(), ws, project);
    }

    @GetMapping("/api/v1/workspaces/{ws}/access-projects")
    public List<Map<String,Object>> directory(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable Long ws) {
        return management.directory(caller,ws);
    }

    @GetMapping({"/api/v1/workspaces/{ws}/access-policy", "/api/v1/workspaces/{ws}/projects/{project}/access-policy"})
    public Map<String,Object> policy(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable Long ws,
                                      @PathVariable(required = false) Long project) {
        return management.policy(caller,ws,project);
    }

    @PutMapping({"/api/v1/workspaces/{ws}/access-policy", "/api/v1/workspaces/{ws}/projects/{project}/access-policy"})
    public Map<String,Object> putPolicy(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable Long ws,
                                         @PathVariable(required = false) Long project, @RequestBody JsonNode request) {
        return management.putPolicy(caller,ws,project,request);
    }

    @GetMapping({"/api/v1/workspaces/{ws}/access-members/{user}", "/api/v1/workspaces/{ws}/projects/{project}/access-members/{user}"})
    public Map<String,Object> member(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable Long ws,
                                      @PathVariable(required = false) Long project, @PathVariable String user) {
        return management.member(caller,ws,project,user);
    }

    @PutMapping({"/api/v1/workspaces/{ws}/access-members/{user}", "/api/v1/workspaces/{ws}/projects/{project}/access-members/{user}"})
    public Map<String,Object> putMember(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable Long ws,
                                         @PathVariable(required = false) Long project, @PathVariable String user,
                                         @RequestBody JsonNode request) {
        return management.putMember(caller,ws,project,user,request);
    }
}
