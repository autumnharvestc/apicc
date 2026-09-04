package com.autumnharvestc.server.core;

import com.autumnharvestc.server.store.AclRepo;
import com.autumnharvestc.server.store.MembershipRepo;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * 权限判定（规格 m3 §2 D5，裁定 D）。
 * 两层模型：工作区成员角色 OWNER &gt; ADMIN &gt; EDITOR &gt; VIEWER；项目级 ACL（NONE/VIEWER/EDITOR/ADMIN）覆盖。
 * effectiveRole 语义：
 *   1. projectId 为 null → 工作区级操作，取工作区角色；
 *   2. project_acl 行存在 → 该值生效（NONE 即拒读，映射为 empty）；
 *   3. 无 ACL 行 → 继承工作区角色；
 *   4. 无成员关系且无 ACL 行 → empty（未授权）。
 * empty 表示无任何有效角色——内容 API 三面（tree/files/写）全部挡下。
 */
@Service
public class PermissionService {

    private final MembershipRepo memberships;
    private final AclRepo acl;

    public PermissionService(MembershipRepo memberships, AclRepo acl) {
        this.memberships = memberships;
        this.acl = acl;
    }

    /** 工作区级有效角色（projectId 为 null 的便捷重载）。 */
    public Optional<Role> effectiveRole(String workspaceId, String userId) {
        return effectiveRole(workspaceId, userId, null);
    }

    /** 项目级有效角色（projectId 可为 null → 工作区角色）。 */
    public Optional<Role> effectiveRole(String workspaceId, String userId, String projectId) {
        Optional<Role> workspaceRole = memberships.findRole(workspaceId, userId);
        if (projectId == null) {
            return workspaceRole;
        }
        // D5：ACL 行存在即生效；NONE 显式拒读 → empty（不回退到工作区角色）
        Optional<AclRole> override = acl.findRole(workspaceId, projectId, userId);
        return override.isPresent() ? toWorkspaceRole(override.get()) : workspaceRole;
    }

    /** canRead：有效角色 ∈ {OWNER, ADMIN, EDITOR, VIEWER}（D5 阶梯最低档即 VIEWER；null = 无角色 = 拒读）。 */
    public boolean canRead(Role role) {
        return role == Role.OWNER || role == Role.ADMIN || role == Role.EDITOR || role == Role.VIEWER;
    }

    /** canWrite：有效角色 ∈ {OWNER, ADMIN, EDITOR}（VIEWER 只读）。 */
    public boolean canWrite(Role role) {
        return role == Role.OWNER || role == Role.ADMIN || role == Role.EDITOR;
    }

    /** isAdmin（契约「ADMIN+」语义，含 OWNER）：管理成员与项目 ACL。 */
    public boolean isAdmin(Role role) {
        return role == Role.OWNER || role == Role.ADMIN;
    }

    /** isOwner：仅 OWNER——删除/转让工作区。 */
    public boolean isOwner(Role role) {
        return role == Role.OWNER;
    }

    /** AclRole → Role 映射；NONE → empty（拒读在类型层面无法用 Role 表达，交由调用方以 empty 理解）。 */
    private Optional<Role> toWorkspaceRole(AclRole aclRole) {
        return switch (aclRole) {
            case NONE -> Optional.empty();
            case VIEWER -> Optional.of(Role.VIEWER);
            case EDITOR -> Optional.of(Role.EDITOR);
            case ADMIN -> Optional.of(Role.ADMIN);
        };
    }
}
