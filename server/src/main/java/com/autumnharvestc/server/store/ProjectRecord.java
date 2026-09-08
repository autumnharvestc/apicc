package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * projects 表行映像（规格 2026-09-08 §4）。name 允许同名（身份=id，内容按项目 id 目录隔离）；
 * groupId 为挂载分组（fk_projects_group）。
 */
public record ProjectRecord(
        String id,
        String workspaceId,
        String groupId,
        String name,
        Instant createdAt) {
}
