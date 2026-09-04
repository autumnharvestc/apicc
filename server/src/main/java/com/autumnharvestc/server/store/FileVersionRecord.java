package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * file_versions 表行映像（规格 m3 §2 D6）：每 (workspaceId, path) 一行的当前版本元数据。
 * version 从 1 起，只保留当前版本（乐观并发比对用，不追溯历史）。
 */
public record FileVersionRecord(
        String workspaceId,
        String path,
        String contentHash,
        long version,
        String updatedBy,
        Instant updatedAt) {
}
