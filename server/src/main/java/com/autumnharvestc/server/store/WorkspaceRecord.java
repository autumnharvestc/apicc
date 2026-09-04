package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * workspaces 表行映像（规格 m3 §3.2）。created_by 为创建者 userId（创建者自动 OWNER）。
 */
public record WorkspaceRecord(
        String id,
        String name,
        String createdBy,
        Instant createdAt) {
}
