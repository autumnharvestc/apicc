package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.AclRole;

/**
 * 项目 ACL 清单行（GET /workspaces/{id}/projects/{projectId}/acl 用）：project_acl 的投影。
 */
public record AclEntryRow(
        String userId,
        AclRole role) {
}
