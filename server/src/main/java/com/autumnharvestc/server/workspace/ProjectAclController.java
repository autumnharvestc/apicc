package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 项目 ACL 端点（规格 m3 §3.3）：GET/PUT 同路径 + DELETE 行（「DELETE 行=恢复继承」的载体，
 * ?userId= 定位行——契约未明示方法面，取 RESTful 语义，联调轨对齐口径）。
 * ADMIN+（按工作区角色判，裁定口径见 ProjectAclService）；projectId 不做内容校验（裁定 A）。
 */
@RestController
public class ProjectAclController {

    private final ProjectAclService acl;

    public ProjectAclController(ProjectAclService acl) {
        this.acl = acl;
    }

    /** 200 [{userId, role}]（role ∈ NONE/VIEWER/EDITOR/ADMIN）；403 非 ADMIN+。 */
    @GetMapping("/api/v1/workspaces/{id}/projects/{projectId}/acl")
    public List<AclEntryView> list(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                   @PathVariable String id,
                                   @PathVariable String projectId) {
        return acl.list(caller, id, projectId);
    }

    /** 200 行视图；NONE=拒之门外；403 非 ADMIN+；404 user_not_found。 */
    @PutMapping("/api/v1/workspaces/{id}/projects/{projectId}/acl")
    public AclEntryView put(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                            @PathVariable String id,
                            @PathVariable String projectId,
                            @Valid @RequestBody SetAclRequest request) {
        return acl.put(caller, id, projectId, request);
    }

    /** 204 删行=恢复继承（幂等）；403 非 ADMIN+。 */
    @DeleteMapping("/api/v1/workspaces/{id}/projects/{projectId}/acl")
    public ResponseEntity<Void> delete(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                       @PathVariable String id,
                                       @PathVariable String projectId,
                                       @RequestParam String userId) {
        acl.delete(caller, id, projectId, userId);
        return ResponseEntity.noContent().build();
    }
}
