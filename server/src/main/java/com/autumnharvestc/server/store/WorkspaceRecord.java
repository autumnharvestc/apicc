package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * workspaces 表行映像（规格 m3 §3.2）。created_by 为创建者 userId（创建者自动 OWNER）；
 * 系统种子（DefaultWorkspaceSeeder）无创建者，以 0 作哨兵。id 为 Long，null = 待生成
 * （insert 前由仓储回填，规格 2026-09-09 BIGINT 化全局不变量 6）。
 */
public record WorkspaceRecord(
        Long id,
        String name,
        Long createdBy,
        Instant createdAt) {

    /** 返回携带指定 id 的副本（repo insert 后回填生成键，规格 2026-09-09 BIGINT 化）。 */
    public WorkspaceRecord withId(long newId) {
        return new WorkspaceRecord(newId, name, createdBy, createdAt);
    }
}
