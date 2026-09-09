package com.autumnharvestc.server.store;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 仓储层单测：groups 表（H2 内存 + 真实 SQL）——2026-09-09 BIGINT 化配套：
 * insert（null id）双分支返回补全生成 id 的记录（全局不变量 6/7），id 非空且递增；
 * 按工作区清单/按名取组的作用域正确。
 */
@JdbcTest
@Import({GroupRepo.class, DatabaseIdGeneration.class})
@Transactional
class GroupRepoTest {

    @Autowired
    private GroupRepo repo;

    /** insert（null id）→ 回填生成 id 非空；find 往返一致。 */
    @Test
    void insertBackfillsGeneratedIdAndRoundTrips() {
        GroupRecord saved = repo.insert(new GroupRecord(null, 1L, "研发", false, Instant.now()));
        assertThat(saved.id()).as("insert 应回填生成主键").isNotNull();

        GroupRecord out = repo.find(saved.id()).orElseThrow();
        assertThat(out.workspaceId()).isEqualTo(1L);
        assertThat(out.name()).isEqualTo("研发");
        assertThat(out.isDefault()).isFalse();
    }

    /** 连续插入生成 id 严格递增（IDENTITY 主键的契约钉子）。 */
    @Test
    void insertAssignsIncreasingIds() {
        GroupRecord first = repo.insert(new GroupRecord(null, 1L, "甲组", false, Instant.now()));
        GroupRecord second = repo.insert(new GroupRecord(null, 1L, "乙组", false, Instant.now()));
        assertThat(second.id()).isGreaterThan(first.id());
    }

    /** 清单与按名取组均限同工作区（workspace_id 作用域）。 */
    @Test
    void listingAndFindByNameAreScopedToWorkspace() {
        GroupRecord inA = repo.insert(new GroupRecord(null, 1L, "共用名", false, Instant.now()));
        repo.insert(new GroupRecord(null, 2L, "他区组", false, Instant.now()));

        assertThat(repo.listByWorkspace(1L)).extracting(GroupRecord::id).containsExactly(inA.id());
        assertThat(repo.findByName(1L, "共用名")).hasValueSatisfying(g -> assertThat(g.id()).isEqualTo(inA.id()));
        assertThat(repo.findByName(1L, "他区组")).isEmpty();
    }
}
