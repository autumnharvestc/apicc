package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.EntityIds;
import com.autumnharvestc.server.core.PermissionService;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;

/**
 * 成员用例（规格 m3 §3.2 + 裁定 C 角色规则）：
 * PUT——目标已是 OWNER → 403 owner_immutable（任何调用者）；ADMIN 可设 ADMIN/EDITOR/VIEWER、
 * 不可设 OWNER（403 requires_owner）；OWNER 可设他人 OWNER（转让：对方升 OWNER、自身降 ADMIN，
 * 先升后降两写完成，中断最坏情形是短暂双 OWNER——不会无 OWNER，取舍见报告）。
 * DELETE——目标 OWNER → 403 owner_immutable；ADMIN 及以下可被 ADMIN+ 移除。
 * 非成员添加 = 直接创建 membership 行；移除/降权对「正在使用的 token」无即时失效（MVP 简化，
 * 工作区面下次访问即按新角色判定）。单写操作各自原子（裁定 B：不引 @Transactional）。
 */
@Service
public class MemberService {

    private final MembershipRepo memberships;
    private final UserRepo users;
    private final WorkspaceGuard guard;
    private final PermissionService permissions;

    public MemberService(MembershipRepo memberships,
                         UserRepo users,
                         WorkspaceGuard guard,
                         PermissionService permissions) {
        this.memberships = memberships;
        this.users = users;
        this.guard = guard;
        this.permissions = permissions;
    }

    /** 成员清单（规格 §3.2：[{userId, username, displayName, role}]，权限=成员）。 */
    public List<MemberView> list(UserAccount caller, String workspaceId) {
        guard.requireMember(workspaceId, caller);
        return memberships.listMembers(workspaceId).stream()
                .map(MemberView::of)
                .toList();
    }

    /** 添加/变更成员角色（规格 §3.2：ADMIN+；规则见类注）。返回成员视图（变更后的角色）。
     * 路径 userId 为字符串化数字——首行 parse（规格 2026-09-09 BIGINT 化，非数字 400 validation_failed）。 */
    public MemberView put(UserAccount caller, String workspaceId, String targetUserId, SetMemberRoleRequest request) {
        long targetId = EntityIds.parse(targetUserId);
        WorkspaceGuard.Access access = guard.requireAdmin(workspaceId, caller);
        UserAccount target = users.findById(targetId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "目标用户不存在"));

        Optional<Role> currentRole = memberships.findRole(workspaceId, targetId);
        if (currentRole.isPresent() && currentRole.get() == Role.OWNER) {
            // 裁定 C 平规则：OWNER 不可被变更（含 OWNER 自我降权——自我降权须走转让）
            throw new ApiException(HttpStatus.FORBIDDEN, "owner_immutable", "不能变更 OWNER 的角色");
        }
        if (request.role() == Role.OWNER) {
            if (!permissions.isOwner(access.role())) {
                throw new ApiException(HttpStatus.FORBIDDEN, "requires_owner", "提升为 OWNER 仅工作区 OWNER 可执行");
            }
            // 转让（裁定 C）：先确保新 OWNER 就位，再把原 OWNER 降为 ADMIN（单次 PUT 完成）
            if (currentRole.isPresent()) {
                memberships.updateRole(workspaceId, targetId, Role.OWNER);
            } else {
                memberships.insert(workspaceId, targetId, Role.OWNER);
            }
            memberships.updateRole(workspaceId, caller.id(), Role.ADMIN);
        } else if (currentRole.isPresent()) {
            memberships.updateRole(workspaceId, targetId, request.role());
        } else {
            // 裁定 C：非成员添加 = 直接创建 membership 行
            memberships.insert(workspaceId, targetId, request.role());
        }
        return new MemberView(String.valueOf(target.id()), target.username(), target.displayName(), request.role());
    }

    /** 移除成员（规格 §3.2：ADMIN+，不能移除 OWNER）。路径 userId 首行 parse（BIGINT 化口径 5）。 */
    public void delete(UserAccount caller, String workspaceId, String targetUserId) {
        long targetId = EntityIds.parse(targetUserId);
        guard.requireAdmin(workspaceId, caller);
        Role targetRole = memberships.findRole(workspaceId, targetId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "member_not_found", "目标不是工作区成员"));
        if (targetRole == Role.OWNER) {
            throw new ApiException(HttpStatus.FORBIDDEN, "owner_immutable", "不能移除 OWNER");
        }
        memberships.delete(workspaceId, targetId);
    }

    /** 成员候选搜索（规格 2026-09-09）：权限同添加成员（ADMIN+）；q 必填非空、trim 后 ≤32 字符，
     * limit 缺省 10、夹取 1..50。只回非成员候选（排除停用账号在 SQL 层）。 */
    public List<UserCandidateView> candidates(UserAccount caller, String workspaceId, String q, Integer limit) {
        guard.requireAdmin(workspaceId, caller);
        String keyword = q == null ? "" : q.trim();
        if (keyword.isEmpty() || keyword.length() > 32) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "validation_failed", "搜索关键字必填且不超过 32 字符");
        }
        int capped = limit == null ? 10 : Math.max(1, Math.min(50, limit));
        return users.searchCandidates(workspaceId, keyword, capped).stream()
                .map(UserCandidateView::of)
                .toList();
    }
}
