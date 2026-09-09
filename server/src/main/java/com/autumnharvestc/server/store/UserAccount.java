package com.autumnharvestc.server.store;

import java.time.Instant;

/**
 * users 表行映像（规格 m3 §3.1 / 2026-09-08 §2；2026-09-09 BIGINT 化：id 为 Long，
 * null = 待生成（insert 前），落库后由仓储回填（全局不变量 6））。
 * password_hash 为 bcrypt 哈希，服务层不经此记录向客户端回传该字段（响应 DTO 不泄露）。
 * role 为平台角色（SUPERADMIN=账号管家，USER=普通账号）；disabled 为停用标记（后续任务：拒登+令牌吊销）。
 */
public record UserAccount(
        Long id,
        String username,
        String passwordHash,
        String displayName,
        PlatformRole role,
        boolean disabled,
        Instant createdAt) {

    /** 返回携带指定 id 的副本（repo insert 后回填生成键，规格 2026-09-09 BIGINT 化）。 */
    public UserAccount withId(long newId) {
        return new UserAccount(newId, username, passwordHash, displayName, role, disabled, createdAt);
    }
}
