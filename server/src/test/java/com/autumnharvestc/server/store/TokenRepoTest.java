package com.autumnharvestc.server.store;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 任务 2 仓储层单测：tokens 表（H2 内存 + 真实 SQL）。
 * 契约（规格 m3 §2 D4）：服务端只存 SHA-256 哈希；认证查找只接受「未吊销且未过期」的令牌；logout 吊销。
 * 2026-09-09 BIGINT 化：userId 夹具用小整数（1L/2L）。
 */
@JdbcTest
@Import(TokenRepo.class)
@Transactional
class TokenRepoTest {

    @Autowired
    private TokenRepo repo;

    private static TokenRecord newToken(String hash, Instant expiresAt) {
        return newToken(hash, 1L, expiresAt);
    }

    private static TokenRecord newToken(String hash, Long userId, Instant expiresAt) {
        return new TokenRecord(hash, userId, expiresAt, false,
                Instant.now().truncatedTo(ChronoUnit.MICROS));
    }

    /** 有效令牌：findActiveByHash 按 SHA-256 哈希命中，字段往返一致。 */
    @Test
    void activeTokenFoundByHash() {
        Instant expires = Instant.now().plusSeconds(3600).truncatedTo(ChronoUnit.MICROS);
        TokenRecord in = newToken("a".repeat(64), expires);
        repo.insert(in);

        TokenRecord out = repo.findActiveByHash("a".repeat(64)).orElseThrow();
        assertThat(out.tokenHash()).isEqualTo("a".repeat(64));
        assertThat(out.userId()).isEqualTo(in.userId());
        assertThat(out.expiresAt()).isEqualTo(expires);
        assertThat(out.revoked()).isFalse();
        assertThat(out.createdAt()).isEqualTo(in.createdAt());
    }

    /** 过期令牌不可用于认证（固定 30 天有效期的过期分支）。 */
    @Test
    void expiredTokenNotReturned() {
        repo.insert(newToken("b".repeat(64), Instant.now().minusSeconds(1).truncatedTo(ChronoUnit.MICROS)));
        assertThat(repo.findActiveByHash("b".repeat(64))).isEmpty();
    }

    /** 已吊销令牌不可用于认证（logout 后立即失效）。 */
    @Test
    void revokedTokenNotReturned() {
        Instant expires = Instant.now().plusSeconds(3600).truncatedTo(ChronoUnit.MICROS);
        repo.insert(newToken("c".repeat(64), expires));
        assertThat(repo.findActiveByHash("c".repeat(64))).isPresent();

        repo.revokeByHash("c".repeat(64));
        assertThat(repo.findActiveByHash("c".repeat(64))).isEmpty();
    }

    /** 未知哈希 → empty（不透明 token 校验失败的存储面基础）。 */
    @Test
    void unknownHashReturnsEmpty() {
        assertThat(repo.findActiveByHash("d".repeat(64))).isEmpty();
    }

    /** 停用账号面：revokeAllByUser 只吊销目标用户的活动令牌（BIGINT userId）。 */
    @Test
    void revokeAllByUserRevokesOnlyThatUsersTokens() {
        Instant expires = Instant.now().plusSeconds(3600).truncatedTo(ChronoUnit.MICROS);
        repo.insert(newToken("e".repeat(64), 1L, expires));
        repo.insert(newToken("f".repeat(64), 2L, expires));

        repo.revokeAllByUser(1L);

        assertThat(repo.findActiveByHash("e".repeat(64))).isEmpty();
        assertThat(repo.findActiveByHash("f".repeat(64))).isPresent();
    }
}
