package com.autumnharvestc.server.admin;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/** 账号管理载荷（规格§2）：校验口径与注册一致（用户名 3-32 [a-zA-Z0-9_-]；密码 8-72）。 */
public final class AdminRequests {
    public record CreateUserRequest(
            @NotBlank @Size(min = 3, max = 32) @Pattern(regexp = "[a-zA-Z0-9_-]+", message = "仅允许字母、数字、下划线与连字符") String username,
            @NotBlank @Size(min = 8, max = 72) String password,
            @NotBlank @Size(max = 32) String displayName) {
    }

    public record ResetPasswordRequest(@NotBlank @Size(min = 8, max = 72) String newPassword) {
    }

    public record SetWorkspaceRoleRequest(@NotBlank String workspaceId,
                                          @NotBlank @Pattern(regexp = "OWNER|ADMIN|EDITOR|VIEWER") String role) {
    }
}
