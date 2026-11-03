package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.access.AccessMutationService;
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
 * 双方修订 CAS、角色更新、失效代次与审计在同一事务完成，失败全部回滚）。
 * DELETE——目标 OWNER → 403 owner_immutable；ADMIN 及以下可被 ADMIN+ 移除。
 * 非成员添加 = 直接创建 membership 行；移除/降权对「正在使用的 token」无即时失效（MVP 简化，
 * 工作区面下次访问即按新角色判定）。所有写入委托统一事务权威。
 */
@Service
public class MemberService {

    private final MembershipRepo memberships;
    private final UserRepo users;
    private final WorkspaceGuard guard;
    private final PermissionService permissions;
    private final AccessMutationService mutations;

    public MemberService(MembershipRepo memberships,
                         UserRepo users,
                         WorkspaceGuard guard,
                         PermissionService permissions, AccessMutationService mutations) {
        this.memberships = memberships;
        this.users = users;
        this.guard = guard;
        this.permissions = permissions;
        this.mutations = mutations;
    }

    /** 成员清单（规格 §3.2：[{userId, username, displayName, role}]，权限=成员）。 */
    public List<MemberView> list(UserAccount caller, String workspaceId) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireMember(wsId, caller);
        return memberships.listMembers(wsId).stream()
                .map(MemberView::of)
                .toList();
    }

    /** 添加/变更成员角色（规格 §3.2：ADMIN+；规则见类注）。返回成员视图（变更后的角色）。
     * 路径 userId 为字符串化数字；先鉴权后 parse（与 AdminService 口径一致：无权调用者 403，
     * 鉴权通过者传非数字才 400 validation_failed——BIGINT 化口径 5）。 */
    public MemberView put(UserAccount caller, String workspaceId, String targetUserId, com.fasterxml.jackson.databind.JsonNode body) {
        long wsId = EntityIds.parse(workspaceId);
        WorkspaceGuard.Access access = guard.requireAdmin(wsId, caller);
        SetMemberRoleRequest request = com.autumnharvestc.server.access.AccessRequests.member(body);
        long targetId = EntityIds.parse(targetUserId);
        UserAccount target = users.findById(targetId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "目标用户不存在"));

        Optional<Role> currentRole = memberships.findRole(wsId, targetId);
        if (currentRole.isPresent() && currentRole.get() == Role.OWNER) {
            // 裁定 C 平规则：OWNER 不可被变更（含 OWNER 自我降权——自我降权须走转让）
            throw new ApiException(HttpStatus.FORBIDDEN, "owner_immutable", "不能变更 OWNER 的角色");
        }
        mutations.putMember(caller,wsId,targetId,request.role(),request.expectedRevision(),request.expectedActorRevision());
        return new MemberView(String.valueOf(target.id()), target.username(), target.displayName(), request.role());
    }

    /** 移除成员（规格 §3.2：ADMIN+，不能移除 OWNER）。先鉴权后 parse 路径 userId（BIGINT 化口径 5）。 */
    public void delete(UserAccount caller, String workspaceId, String targetUserId, String expectedRevision) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireAdmin(wsId, caller);
        long revision = com.autumnharvestc.server.access.AccessRequests.queryRevision(expectedRevision);
        long targetId = EntityIds.parse(targetUserId);
        Role targetRole = memberships.findRole(wsId, targetId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "member_not_found", "目标不是工作区成员"));
        if (targetRole == Role.OWNER) {
            throw new ApiException(HttpStatus.FORBIDDEN, "owner_immutable", "不能移除 OWNER");
        }
        mutations.removeMember(caller,wsId, targetId, revision);
    }

    /** 成员候选搜索（规格 2026-09-09）：权限同添加成员（ADMIN+）；q 必填非空、trim 后 ≤32 字符，
     * limit 缺省 10、夹取 1..50。只回非成员候选（排除停用账号在 SQL 层）。 */
    public List<UserCandidateView> candidates(UserAccount caller, String workspaceId, String q, Integer limit) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireAdmin(wsId, caller);
        String keyword = q == null ? "" : q.trim();
        if (keyword.isEmpty() || keyword.length() > 32) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "validation_failed", "搜索关键字必填且不超过 32 字符");
        }
        int capped = limit == null ? 10 : Math.max(1, Math.min(50, limit));
        return users.searchCandidates(wsId, keyword, capped).stream()
                .map(UserCandidateView::of)
                .toList();
    }
}
