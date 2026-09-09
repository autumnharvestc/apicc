package com.autumnharvestc.server.store;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 任务 2 仓储层单测：users 表（H2 内存 + 真实 SQL，走 schema.sql DDL）。
 * 契约：username 唯一约束（注册冲突 409 username_taken 的存储面基础）；按 username / id 精确查找。
 * 2026-09-09 BIGINT 化口径（全局不变量 6/7）：直构实体 id 用 null（待生成）；insert 返回补全
 * 生成 id 的新记录（IDENTITY 自增，id 非空且递增）；幽灵 id 探查用不存在的大数字（999999）。
 */
@JdbcTest
@Import({UserRepo.class, DatabaseIdGeneration.class})
@Transactional
class UserRepoTest {

    @Autowired
    private UserRepo repo;

    private static UserAccount newUser(String username) {
        return new UserAccount(null, username, "$2a$10$hash",
                "显示名-" + username, PlatformRole.USER, false,
                Instant.now().truncatedTo(ChronoUnit.MICROS));
    }

    /** insert（不带 id）→ 生成键回填：返回值 id 非空；findByUsername 全字段往返一致（createdAt 微秒精度不漂移）。 */
    @Test
    void insertThenFindByUsernameRoundTrips() {
        UserAccount in = newUser("alice");
        UserAccount saved = repo.insert(in);
        assertThat(saved.id()).isNotNull();

        UserAccount out = repo.findByUsername("alice").orElseThrow();
        assertThat(out.id()).isEqualTo(saved.id());
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

    /** 认证过滤器经 token → userId 取用户：findById 命中与未命中（幽灵 id 用不存在的大数字）。 */
    @Test
    void findByIdRoundTripsAndUnknownReturnsEmpty() {
        UserAccount saved = repo.insert(newUser("bob"));
        assertThat(saved.id()).isNotNull();

        assertThat(repo.findById(saved.id())).hasValueSatisfying(u -> assertThat(u.username()).isEqualTo("bob"));
        assertThat(repo.findById(999999L)).isEmpty();
    }

    /** IDENTITY 自增：连续插入返回的生成 id 严格递增（identity 主键口径钉死）。 */
    @Test
    void insertGeneratesIncreasingIds() {
        long first = repo.insert(newUser("carol-a")).id();
        long second = repo.insert(newUser("carol-b")).id();
        assertThat(second).isGreaterThan(first);
    }

    /** DDL 契约：username 唯一约束——重复注册抛 DuplicateKeyException（服务层转 409 username_taken）。 */
    @Test
    void duplicateUsernameRejectedByUniqueConstraint() {
        repo.insert(newUser("dave"));
        assertThatThrownBy(() -> repo.insert(newUser("dave")))
                .isInstanceOf(DuplicateKeyException.class);
        // 首条记录不受影响
        assertThat(repo.findByUsername("dave")).isPresent();
    }
}
