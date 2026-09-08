package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * groups 表行映像（规格 2026-09-08 §4）。is_default=TRUE 即「默认分组」（每工作区一行，
 * name='默认分组'，改名/删除守卫判据，守卫在任务 2 的 Org 面）；created_at 为建组时刻。
 */
public record GroupRecord(
        String id,
        String workspaceId,
        String name,
        boolean isDefault,
        Instant createdAt) {
}
