package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.Role;

import java.time.Instant;

/**
 * 「我参与的工作区」行（GET /workspaces 用）：workspaces ⋈ memberships 的投影。
 * myRole 即调用者在该工作区的角色。id 为 Long（对外字符串化在 View 层，
 * 规格 2026-09-09 BIGINT 化全局不变量 1）。
 */
public record WorkspaceWithRole(
        Long id,
        String name,
        Instant createdAt,
        Role myRole) {
}
