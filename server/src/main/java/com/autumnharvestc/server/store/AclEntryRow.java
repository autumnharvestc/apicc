package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.AclRole;

/**
 * 项目 ACL 清单行（GET /workspaces/{id}/projects/{projectId}/acl 用）：project_acl 的投影。
 * 2026-09-09 BIGINT 化：userId 为 Long（对外字符串化在 View 层）。
 */
public record AclEntryRow(
        Long userId,
        AclRole role) {
}
