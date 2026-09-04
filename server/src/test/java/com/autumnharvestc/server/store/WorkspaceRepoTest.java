package com.autumnharvestc.server.store;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 任务 2 仓储层单测：workspaces 表（H2 内存 + 真实 SQL）。
 * 契约：创建（创建者自动 OWNER 的服务面在任务 4）与按 id 查取（工作区详情/删除前的存在性校验）。
 */
@JdbcTest
@Import(WorkspaceRepo.class)
@Transactional
class WorkspaceRepoTest {

    @Autowired
    private WorkspaceRepo repo;

    /** insert → findById 全字段往返一致。 */
    @Test
    void insertThenFindByIdRoundTrips() {
        WorkspaceRecord in = new WorkspaceRecord(UUID.randomUUID().toString(), "团队空间",
                UUID.randomUUID().toString(), Instant.now().truncatedTo(ChronoUnit.MICROS));
        repo.insert(in);

        WorkspaceRecord out = repo.findById(in.id()).orElseThrow();
        assertThat(out.id()).isEqualTo(in.id());
        assertThat(out.name()).isEqualTo("团队空间");
        assertThat(out.createdBy()).isEqualTo(in.createdBy());
        assertThat(out.createdAt()).isEqualTo(in.createdAt());
    }

    /** 不存在的工作区 → empty（404 not_found 的存储面基础）。 */
    @Test
    void findByIdUnknownReturnsEmpty() {
        assertThat(repo.findById(UUID.randomUUID().toString())).isEmpty();
    }
}
