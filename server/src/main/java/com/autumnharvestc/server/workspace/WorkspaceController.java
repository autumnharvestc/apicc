package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 工作区端点（规格 m3 §3.2）：列表/创建/详情/删除。
 * 全部要求认证（AuthFilter 注入身份）；权限列由 WorkspaceGuard 前置校验。
 */
@RestController
public class WorkspaceController {

    private final WorkspaceService workspaces;

    public WorkspaceController(WorkspaceService workspaces) {
        this.workspaces = workspaces;
    }

    /** 200 我参与的工作区列表 [{id, name, myRole, createdAt}]（登录即可）。 */
    @GetMapping("/api/v1/workspaces")
    public List<WorkspaceView> list(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller) {
        return workspaces.list(caller);
    }

    /** 201 {id, name, myRole:"OWNER"}（创建者自动 OWNER）；400 校验。 */
    @PostMapping("/api/v1/workspaces")
    public ResponseEntity<WorkspaceView> create(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                                @Valid @RequestBody CreateWorkspaceRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(workspaces.create(caller, request));
    }

    /** 200 {id, name, myRole, memberCount}；403 非成员；404 workspace_not_found。 */
    @GetMapping("/api/v1/workspaces/{id}")
    public WorkspaceDetailView detail(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                      @PathVariable String id) {
        return workspaces.detail(caller, id);
    }

    /** 204 删除（含内容目录，裁定 D）；403 仅 OWNER；404 workspace_not_found。 */
    @DeleteMapping("/api/v1/workspaces/{id}")
    public ResponseEntity<Void> delete(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                       @PathVariable String id) {
        workspaces.delete(caller, id);
        return ResponseEntity.noContent().build();
    }
}
