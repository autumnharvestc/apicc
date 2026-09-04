package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.PermissionService;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.WorkspaceRecord;
import com.autumnharvestc.server.store.WorkspaceRepo;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 工作区访问守卫（规格 m3 §3.2/§3.3 权限列）：端点前置的「工作区存在 → 成员 → 角色」三级校验。
 * 错误约定：工作区不存在 → 404 workspace_not_found；非成员或角色不足 → 403 forbidden。
 * 空有效角色（无成员关系且无 ACL 行）一律 403——内容面的 NONE 项目过滤是任务 5 的按路径语义，此处为工作区面。
 */
@Component
public class WorkspaceGuard {

    /** 访问上下文：已确认存在的工作区 + 调用者的工作区角色。 */
    public record Access(WorkspaceRecord workspace, Role role) {
    }

    private final WorkspaceRepo workspaces;
    private final PermissionService permissions;

    public WorkspaceGuard(WorkspaceRepo workspaces, PermissionService permissions) {
        this.workspaces = workspaces;
        this.permissions = permissions;
    }

    /** 成员可访问（任意角色）；返回工作区与角色。 */
    public Access requireMember(String workspaceId, UserAccount caller) {
        WorkspaceRecord workspace = workspaces.findById(workspaceId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "workspace_not_found", "工作区不存在"));
        Role role = permissions.effectiveRole(workspaceId, caller.id())
                .orElseThrow(() -> new ApiException(HttpStatus.FORBIDDEN, "forbidden", "非工作区成员"));
        return new Access(workspace, role);
    }

    /** ADMIN+ 可访问（管理成员与项目 ACL，D5；isAdmin 含 OWNER）。 */
    public Access requireAdmin(String workspaceId, UserAccount caller) {
        Access access = requireMember(workspaceId, caller);
        if (!permissions.isAdmin(access.role())) {
            throw new ApiException(HttpStatus.FORBIDDEN, "forbidden", "需要 ADMIN 及以上角色");
        }
        return access;
    }

    /** 仅 OWNER（删除/转让工作区，D5）。 */
    public Access requireOwner(String workspaceId, UserAccount caller) {
        Access access = requireMember(workspaceId, caller);
        if (!permissions.isOwner(access.role())) {
            throw new ApiException(HttpStatus.FORBIDDEN, "forbidden", "仅工作区 OWNER 可执行");
        }
        return access;
    }
}
