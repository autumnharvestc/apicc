package com.autumnharvestc.server.store;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 仓储层单测：projects 表（H2 内存 + 真实 SQL）——2026-09-09 BIGINT 化配套：
 * insert（null id）双分支返回补全生成 id 的记录（全局不变量 6/7），id 非空且递增；
 * 工作区/分组两级清单作用域正确；分组内计数供删除空分组守卫。
 */
@JdbcTest
@Import({ProjectRepo.class, GroupRepo.class, DatabaseIdGeneration.class})
@Transactional
class ProjectRepoTest {

    @Autowired
    private ProjectRepo repo;

    @Autowired
    private GroupRepo groups;

    /** 外键夹具：真实分组行（fk_projects_group）。 */
    private GroupRecord group(long workspaceId, String name) {
        return groups.insert(new GroupRecord(null, workspaceId, name, false, Instant.now()));
    }

    /** insert（null id）→ 回填生成 id 非空；find 往返一致。 */
    @Test
    void insertBackfillsGeneratedIdAndRoundTrips() {
        GroupRecord g = group(1L, "g");
        ProjectRecord saved = repo.insert(new ProjectRecord(null, 1L, g.id(), "项目甲", Instant.now()));
        assertThat(saved.id()).as("insert 应回填生成主键").isNotNull();

        ProjectRecord out = repo.find(saved.id()).orElseThrow();
        assertThat(out.workspaceId()).isEqualTo(1L);
        assertThat(out.groupId()).isEqualTo(g.id());
        assertThat(out.name()).isEqualTo("项目甲");
    }

    /** 连续插入生成 id 严格递增（IDENTITY 主键的契约钉子）。 */
    @Test
    void insertAssignsIncreasingIds() {
        GroupRecord g = group(1L, "g");
        ProjectRecord first = repo.insert(new ProjectRecord(null, 1L, g.id(), "一", Instant.now()));
        ProjectRecord second = repo.insert(new ProjectRecord(null, 1L, g.id(), "二", Instant.now()));
        assertThat(second.id()).isGreaterThan(first.id());
    }

    /** 清单按工作区/分组作用域隔离；countByGroup 供删除空分组守卫。 */
    @Test
    void listingAndCountAreScoped() {
        GroupRecord g1 = group(1L, "g1");
        GroupRecord g2 = group(1L, "g2");
        GroupRecord otherWs = group(2L, "他区组");
        ProjectRecord inG1 = repo.insert(new ProjectRecord(null, 1L, g1.id(), "甲", Instant.now()));
        repo.insert(new ProjectRecord(null, 1L, g2.id(), "乙", Instant.now()));
        repo.insert(new ProjectRecord(null, 2L, otherWs.id(), "丙", Instant.now()));

        assertThat(repo.listByWorkspace(1L)).extracting(ProjectRecord::id)
                .containsExactlyInAnyOrder(inG1.id(), repo.listByGroup(g2.id()).get(0).id());
        assertThat(repo.listByGroup(g1.id())).hasSize(1);
        assertThat(repo.countByGroup(g1.id())).isEqualTo(1);
        assertThat(repo.countByGroup(g2.id())).isEqualTo(1);
        assertThat(repo.countByGroup(otherWs.id())).isEqualTo(1);
    }
}
