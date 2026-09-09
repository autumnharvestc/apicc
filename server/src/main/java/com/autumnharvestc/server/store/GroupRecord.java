package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * groups 表行映像（规格 2026-09-08 §4）。is_default=TRUE 即「默认分组」（每工作区一行，
 * name='默认分组'，改名/删除守卫判据，守卫在任务 2 的 Org 面）；created_at 为建组时刻。
 * id/workspaceId 为 Long，id null = 待生成（insert 后由仓储回填，规格 2026-09-09 BIGINT 化全局不变量 6）。
 */
public record GroupRecord(
        Long id,
        Long workspaceId,
        String name,
        boolean isDefault,
        Instant createdAt) {

    /** 返回携带指定 id 的副本（repo insert 后回填生成键，规格 2026-09-09 BIGINT 化）。 */
    public GroupRecord withId(long newId) {
        return new GroupRecord(newId, workspaceId, name, isDefault, createdAt);
    }
}
