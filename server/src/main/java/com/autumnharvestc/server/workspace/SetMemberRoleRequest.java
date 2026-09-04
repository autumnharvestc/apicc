package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.Role;
import jakarta.validation.constraints.NotNull;

/**
 * 变更/添加成员角色载荷（规格 m3 §3.2：PUT members/{userId} {role}）。
 * role 以 Role 枚举绑定，非法值由 Jackson 转 400 bad_request（GlobalExceptionHandler 兜底）。
 */
public record SetMemberRoleRequest(
        @NotNull(message = "不能为空")
        Role role) {
}
