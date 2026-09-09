package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * tokens 表行映像（规格 m3 §2 D4；2026-09-09 BIGINT 化：userId 为 Long）。
 * tokenHash 为 SHA-256 hex——服务端不存明文 token，明文只在签发响应中出现一次。
 */
public record TokenRecord(
        String tokenHash,
        Long userId,
        Instant expiresAt,
        boolean revoked,
        Instant createdAt) {
}
