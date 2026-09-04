package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.Role;

/**
 * 成员清单行（GET /workspaces/{id}/members 用）：memberships ⋈ users 的投影。
 * 只携带安全字段（不含 password_hash）——响应 DTO 不泄露凭据材料。
 */
public record MemberRow(
        String userId,
        String username,
        String displayName,
        Role role) {
}
