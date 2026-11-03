package com.autumnharvestc.server.collaboration.audit;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import java.util.*;
import org.springframework.web.bind.annotation.*;

/** Finite member-only audit query entrance. */
@RestController
@RequestMapping("/api/v1/workspaces/{ws}/projects/{project}/collaboration")
public class CollaborationAuditController {
    private final MockLogs logs;private final CollaborationAuditQuery audit;private final com.autumnharvestc.server.access.ProjectAccessService access;
    public CollaborationAuditController(MockLogs logs,CollaborationAuditQuery audit,com.autumnharvestc.server.access.ProjectAccessService access){this.logs=logs;this.audit=audit;this.access=access;}
    private void require(UserAccount actor,long ws,long project,com.autumnharvestc.server.access.Capability capability){if(!access.resolve(actor.id(),ws,project).capabilities().contains(capability))throw new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.FORBIDDEN,"forbidden","缺少对应的日志或审计读取权限");}
    @GetMapping("/publications/{id}/mock-logs") public Object logs(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount actor,@PathVariable String ws,@PathVariable String project,@PathVariable String id,@RequestParam Map<String,String> query){long workspace=com.autumnharvestc.server.core.EntityIds.parse(ws),pid=com.autumnharvestc.server.core.EntityIds.parse(project);require(actor,workspace,pid,com.autumnharvestc.server.access.Capability.MOCK_LOGS_READ);return logs.read(workspace,pid,com.autumnharvestc.server.core.EntityIds.parse(id),query);}
    @GetMapping("/audit") public Object audit(@RequestAttribute(AuthFilter.ATTR_USER)UserAccount actor,@PathVariable String ws,@PathVariable String project,@RequestParam Map<String,String> query){long workspace=com.autumnharvestc.server.core.EntityIds.parse(ws),pid=com.autumnharvestc.server.core.EntityIds.parse(project);require(actor,workspace,pid,com.autumnharvestc.server.access.Capability.AUDIT_READ);return audit.read(workspace,pid,query);}
}
