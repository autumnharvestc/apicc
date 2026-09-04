package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * users 表行映像（规格 m3 §3.1）。
 * password_hash 为 bcrypt 哈希，服务层不经此记录向客户端回传该字段（响应 DTO 不泄露）。
 */
public record UserAccount(
        String id,
        String username,
        String passwordHash,
        String displayName,
        Instant createdAt) {
}
