package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * projects 表行映像（规格 2026-09-08 §4）。name 允许同名（身份=id，内容按项目 id 目录隔离）；
 * groupId 为挂载分组（fk_projects_group）。id/workspaceId/groupId 为 Long，id null = 待生成
 * （insert 后由仓储回填，规格 2026-09-09 BIGINT 化全局不变量 6）。
 */
public record ProjectRecord(
        Long id,
        Long workspaceId,
        Long groupId,
        String name,
        Instant createdAt) {

    /** 返回携带指定 id 的副本（repo insert 后回填生成键，规格 2026-09-09 BIGINT 化）。 */
    public ProjectRecord withId(long newId) {
        return new ProjectRecord(newId, workspaceId, groupId, name, createdAt);
    }
}
