package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.Role;

import java.time.Instant;

/**
 * 「我参与的工作区」行（GET /workspaces 用）：workspaces ⋈ memberships 的投影。
 * myRole 即调用者在该工作区的成员角色。
 */
public record WorkspaceWithRole(
        String id,
        String name,
        Instant createdAt,
        Role myRole) {
}
