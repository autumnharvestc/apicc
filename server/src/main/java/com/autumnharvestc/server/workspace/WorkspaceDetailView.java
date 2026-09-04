package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.Role;

/**
 * 工作区详情视图（规格 m3 §3.2：GET /workspaces/{id} → {id, name, myRole, memberCount}）。
 */
public record WorkspaceDetailView(
        String id,
        String name,
        Role myRole,
        long memberCount) {
}
