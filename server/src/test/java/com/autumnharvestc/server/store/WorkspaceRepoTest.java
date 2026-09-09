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
 * 仓储层单测：workspaces 表（H2 内存 + 真实 SQL）。
 * 契约：创建（创建者自动 OWNER 的服务面在工作区面）与按 id 查取（工作区详情/删除前的存在性校验）。
 * 2026-09-09 BIGINT 化口径（全局不变量 6/7）：直构用 null id，insert 返回补全生成 id 的记录。
 */
@JdbcTest
@Import({WorkspaceRepo.class, DatabaseIdGeneration.class})
@Transactional
class WorkspaceRepoTest {

    @Autowired
    private WorkspaceRepo repo;

    /** insert（null id）→ 生成 id 回填非空；findById 全字段往返一致。 */
    @Test
    void insertThenFindByIdRoundTrips() {
        WorkspaceRecord in = new WorkspaceRecord(null, "团队空间", 7L,
                Instant.now().truncatedTo(ChronoUnit.MICROS));
        WorkspaceRecord saved = repo.insert(in);
        assertThat(saved.id()).as("insert 应回填生成主键").isNotNull();

        WorkspaceRecord out = repo.findById(saved.id()).orElseThrow();
        assertThat(out.id()).isEqualTo(saved.id());
        assertThat(out.name()).isEqualTo("团队空间");
        assertThat(out.createdBy()).isEqualTo(7L);
        assertThat(out.createdAt()).isEqualTo(in.createdAt());
    }

    /** 连续插入生成 id 严格递增（IDENTITY 主键的契约钉子）。 */
    @Test
    void insertAssignsIncreasingIds() {
        WorkspaceRecord first = repo.insert(new WorkspaceRecord(null, "一区", 1L, Instant.now()));
        WorkspaceRecord second = repo.insert(new WorkspaceRecord(null, "二区", 1L, Instant.now()));
        assertThat(second.id()).isGreaterThan(first.id());
    }

    /** 不存在的工作区 → empty（404 not_found 的存储面基础；幽灵 id 用不存在的大数字）。 */
    @Test
    void findByIdUnknownReturnsEmpty() {
        assertThat(repo.findById(999999L)).isEmpty();
    }
}
