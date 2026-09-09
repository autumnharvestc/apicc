package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * file_versions 表行映像（规格 m3 §2 D6 + §5 内容入库）：每 (workspaceId, path) 一行的当前版本与内容。
 * version 从 1 起，只保留当前版本（乐观并发比对用，不追溯历史）。
 * 2026-09-09 BIGINT 化：updatedBy 为 Long（users.id）。
 *
 * <p>content 为入库文本正文（PUT 原文逐字一致）；contentSize 为其 UTF-8 字节长（OCTET_LENGTH，
 * tree 的 size 口径）。两个列按查询用例分别填充：读面 {@code find} 携 content；树清单
 * {@code listByWorkspace} 不拉 content、仅携 contentSize——tree 全量行不承载正文。</p>
 */
public record FileVersionRecord(
        String workspaceId,
        String path,
        String contentHash,
        long version,
        Long updatedBy,
        Instant updatedAt,
        long contentSize,
        String content) {
}
