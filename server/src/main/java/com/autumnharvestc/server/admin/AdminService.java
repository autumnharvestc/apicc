package com.autumnharvestc.server.admin;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.PlatformRole;
import com.autumnharvestc.server.store.TokenRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** 账号生命周期用例（规格§2）：超管守卫 + 创建/重置密码/停用启用/入区定角色。 */
@Service
public class AdminService {

    /** bcrypt 强度与 AuthService/注册同一约定（≥10）。 */
    private static final int BCRYPT_STRENGTH = 10;

    private final UserRepo users;
    private final TokenRepo tokens;
    private final MembershipRepo memberships;
    private final PasswordEncoder encoder = new BCryptPasswordEncoder(BCRYPT_STRENGTH);

    public AdminService(UserRepo users, TokenRepo tokens, MembershipRepo memberships) {
        this.users = users;
        this.tokens = tokens;
        this.memberships = memberships;
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

    /** 创建账号（校验同注册）：重名 → 409 username_taken（含唯一约束竞态兜底，与 AuthService.register 对齐）。 */
    public UserAccount create(UserAccount caller, AdminRequests.CreateUserRequest request) {
        requireSuperadmin(caller);
        users.findByUsername(request.username()).ifPresent(existing -> {
            throw new ApiException(HttpStatus.CONFLICT, "username_taken", "用户名已存在");
        });
        UserAccount account = new UserAccount(UUID.randomUUID().toString(), request.username(),
                encoder.encode(request.password()), request.displayName().trim(),
                PlatformRole.USER, false, Instant.now());
        try {
            users.insert(account);
        } catch (DuplicateKeyException ex) {
            // 并发同名创建兜底：users.username 唯一约束
            throw new ApiException(HttpStatus.CONFLICT, "username_taken", "用户名已存在");
        }
        return account;
    }

    public void resetPassword(UserAccount caller, String userId, String newPassword) {
        requireSuperadmin(caller);
        users.findById(userId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "未找到账号"));
        users.updatePassword(userId, encoder.encode(newPassword));
        tokens.revokeAllByUser(userId); // 重置即踢下线
    }

    public void setDisabled(UserAccount caller, String userId, boolean disabled) {
        requireSuperadmin(caller);
        if (caller.id().equals(userId) && disabled) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "cannot_disable_self", "不能停用自己的账号");
        }
        users.findById(userId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "未找到账号"));
        users.setDisabled(userId, disabled);
        if (disabled) tokens.revokeAllByUser(userId);
    }

    /** 入区定角色（规格§2「分配使用」）：直接写 memberships（超管意志，无需目标区管理员同意）。 */
    public void setWorkspaceRole(UserAccount caller, String userId, String workspaceId, String role) {
        requireSuperadmin(caller);
        users.findById(userId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "未找到账号"));
        memberships.upsert(workspaceId, userId, role);
    }
}
