package com.autumnharvestc.server.admin;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.EntityIds;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.PlatformRole;
import com.autumnharvestc.server.store.TokenRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import com.autumnharvestc.server.store.WorkspaceRepo;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;

/** 账号生命周期用例（规格§2）：超管守卫 + 创建/重置密码/停用启用/入区定角色。 */
@Service
public class AdminService {

    /** bcrypt 强度与 AuthService/注册同一约定（≥10）。 */
    private static final int BCRYPT_STRENGTH = 10;

    private final UserRepo users;
    private final TokenRepo tokens;
    private final MembershipRepo memberships;
    private final WorkspaceRepo workspaces;
    private final PasswordEncoder encoder = new BCryptPasswordEncoder(BCRYPT_STRENGTH);

    public AdminService(UserRepo users, TokenRepo tokens, MembershipRepo memberships, WorkspaceRepo workspaces) {
        this.users = users;
        this.tokens = tokens;
        this.memberships = memberships;
        this.workspaces = workspaces;
    }

    private void requireSuperadmin(UserAccount caller) {
        if (caller.role() != PlatformRole.SUPERADMIN) {
            throw new ApiException(HttpStatus.FORBIDDEN, "superadmin_required", "需要平台超级管理员权限");
        }
    }

    public List<UserAccount> list(UserAccount caller) {
        requireSuperadmin(caller);
        return users.findAll();
    }

    /** 创建账号（校验同注册）：重名 → 409 username_taken（含唯一约束竞态兜底，与 AuthService.register 对齐）。
     * id 待生成（null = insert 后由仓储回填，规格 2026-09-09 BIGINT 化全局不变量 6），返回带生成 id 的记录。 */
    public UserAccount create(UserAccount caller, AdminRequests.CreateUserRequest request) {
        requireSuperadmin(caller);
        users.findByUsername(request.username()).ifPresent(existing -> {
            throw new ApiException(HttpStatus.CONFLICT, "username_taken", "用户名已存在");
        });
        UserAccount account = new UserAccount(null, request.username(),
                encoder.encode(request.password()), request.displayName().trim(),
                PlatformRole.USER, false, Instant.now());
        try {
            return users.insert(account);
        } catch (DuplicateKeyException ex) {
            // 并发同名创建兜底：users.username 唯一约束
            throw new ApiException(HttpStatus.CONFLICT, "username_taken", "用户名已存在");
        }
    }

    public void resetPassword(UserAccount caller, String userId, String newPassword) {
        requireSuperadmin(caller);
        long targetId = EntityIds.parse(userId);
        users.findById(targetId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "未找到账号"));
        users.updatePassword(targetId, encoder.encode(newPassword));
        tokens.revokeAllByUser(targetId); // 重置即踢下线
    }

    public void setDisabled(UserAccount caller, String userId, boolean disabled) {
        requireSuperadmin(caller);
        long targetId = EntityIds.parse(userId);
        if (caller.id() != null && caller.id() == targetId && disabled) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "cannot_disable_self", "不能停用自己的账号");
        }
        users.findById(targetId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "未找到账号"));
        users.setDisabled(targetId, disabled);
        if (disabled) tokens.revokeAllByUser(targetId);
    }

    /**
     * 入区定角色（规格§2「分配使用」）：直接写 memberships（超管意志，无需目标区管理员同意）。
     * 载荷角色域限 ADMIN/EDITOR/VIEWER（AdminRequests 校验层拦 OWNER——OWNER 不可经此端点变更，
     * 否则现职 OWNER 被改离 → 区内永久无 OWNER；授 OWNER 又绕过转让的先升后降，会永久双 OWNER）。
     * workspace 不存在 → 404 workspace_not_found（对齐 user 侧与工作区面 404 口径）。
     */
    public void setWorkspaceRole(UserAccount caller, String userId, String workspaceId, String role) {
        requireSuperadmin(caller);
        long targetId = EntityIds.parse(userId);
        users.findById(targetId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "未找到账号"));
        workspaces.findById(workspaceId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "workspace_not_found", "工作区不存在"));
        memberships.upsert(workspaceId, targetId, role);
    }
}
