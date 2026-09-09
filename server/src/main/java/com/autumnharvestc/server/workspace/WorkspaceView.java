package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.WorkspaceWithRole;

import java.time.Instant;

/**
 * 工作区视图（规格 m3 §3.2：POST 201 响应与 GET /workspaces 列表行 {id, name, myRole, createdAt}）。
 * id 保持 String：对外 JSON 字符串化数字（规格 2026-09-09 BIGINT 化，全局不变量 1）。
 */
public record WorkspaceView(
        String id,
        String name,
        Role myRole,
        Instant createdAt) {

    public static WorkspaceView of(WorkspaceWithRole row) {
        return new WorkspaceView(String.valueOf(row.id()), row.name(), row.myRole(), row.createdAt());
    }
}
