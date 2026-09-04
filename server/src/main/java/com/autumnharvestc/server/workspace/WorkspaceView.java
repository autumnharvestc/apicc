package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.WorkspaceWithRole;

import java.time.Instant;

/**
 * 工作区视图（规格 m3 §3.2：POST 201 响应与 GET /workspaces 列表行 {id, name, myRole, createdAt}）。
 */
public record WorkspaceView(
        String id,
        String name,
        Role myRole,
        Instant createdAt) {

    public static WorkspaceView of(WorkspaceWithRole row) {
        return new WorkspaceView(row.id(), row.name(), row.myRole(), row.createdAt());
    }
}
