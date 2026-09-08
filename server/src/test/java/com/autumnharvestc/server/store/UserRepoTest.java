package com.autumnharvestc.server.store;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 任务 2 仓储层单测：users 表（H2 内存 + 真实 SQL，走 schema.sql DDL）。
 * 契约：username 唯一约束（注册冲突 409 username_taken 的存储面基础）；按 username / id 精确查找。
 */
@JdbcTest
@Import(UserRepo.class)
@Transactional
class UserRepoTest {

    @Autowired
    private UserRepo repo;

    private static UserAccount newUser(String username) {
        return new UserAccount(UUID.randomUUID().toString(), username, "$2a$10$hash",
                "显示名-" + username, PlatformRole.USER, false,
                Instant.now().truncatedTo(ChronoUnit.MICROS));
    }

    /** insert → findByUsername 全字段往返一致（createdAt 以微秒精度存取，UTC 瞬时值不漂移）。 */
    @Test
    void insertThenFindByUsernameRoundTrips() {
        UserAccount in = newUser("alice");
        repo.insert(in);

        UserAccount out = repo.findByUsername("alice").orElseThrow();
        assertThat(out.id()).isEqualTo(in.id());
        assertThat(out.username()).isEqualTo("alice");
        assertThat(out.passwordHash()).isEqualTo("$2a$10$hash");
        assertThat(out.displayName()).isEqualTo("显示名-alice");
        assertThat(out.role()).isEqualTo(PlatformRole.USER);
        assertThat(out.disabled()).isFalse();
        assertThat(out.createdAt()).isEqualTo(in.createdAt());
    }

    /** 用户名不存在 → empty（登录 401 invalid_credentials 的存储面基础）。 */
    @Test
    void findByUsernameUnknownReturnsEmpty() {
        assertThat(repo.findByUsername("no-such-user")).isEmpty();
    }

    /** 认证过滤器经 token → userId 取用户：findById 命中与未命中。 */
    @Test
    void findByIdRoundTripsAndUnknownReturnsEmpty() {
        UserAccount in = newUser("bob");
        repo.insert(in);

        assertThat(repo.findById(in.id())).hasValueSatisfying(u -> assertThat(u.username()).isEqualTo("bob"));
        assertThat(repo.findById(UUID.randomUUID().toString())).isEmpty();
    }

    /** DDL 契约：username 唯一约束——重复注册抛 DuplicateKeyException（服务层转 409 username_taken）。 */
    @Test
    void duplicateUsernameRejectedByUniqueConstraint() {
        repo.insert(newUser("carol"));
        assertThatThrownBy(() -> repo.insert(newUser("carol")))
                .isInstanceOf(DuplicateKeyException.class);
        // 首条记录不受影响
        assertThat(repo.findByUsername("carol")).isPresent();
    }
}
