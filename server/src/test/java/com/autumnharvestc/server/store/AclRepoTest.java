package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.AclRole;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Transactional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 仓储层单测：project_acl 表（H2 内存 + 真实 SQL）。
 * 契约（规格 m3 §2 D5/§3.3）：项目级 ACL 覆盖行（NONE/VIEWER/EDITOR/ADMIN）按 (workspace_id, project_id, user_id)
 * 唯一；PUT 覆盖已存在的行；DELETE 行 = 恢复工作区角色继承。
 * 2026-09-09 BIGINT 化口径（全局不变量 7）：workspaceId/projectId/userId 夹具均用小整数 Long（任务 3 收口）。
 */
@JdbcTest
@Import(AclRepo.class)
@Transactional
class AclRepoTest {

    @Autowired
    private AclRepo repo;

    /** 无行 → empty（继承工作区角色的前提）。 */
    @Test
    void findRoleWithoutRowReturnsEmpty() {
        assertThat(repo.findRole(1L, 201L, 1L)).isEmpty();
    }

    /** upsert 覆盖行：VIEWER → NONE（NONE 即拒读的存储面）。 */
    @Test
    void upsertOverwritesExistingRole() {
        repo.upsert(11L, 201L, 1L, AclRole.VIEWER);
        assertThat(repo.findRole(11L, 201L, 1L)).contains(AclRole.VIEWER);

        repo.upsert(11L, 201L, 1L, AclRole.NONE);
        assertThat(repo.findRole(11L, 201L, 1L)).contains(AclRole.NONE);
    }

    /** 覆盖按 (workspace, project, user) 三元组隔离。 */
    @Test
    void overridesAreIsolatedPerProjectAndUser() {
        repo.upsert(11L, 201L, 1L, AclRole.NONE);
        repo.upsert(11L, 202L, 1L, AclRole.EDITOR);
        repo.upsert(11L, 201L, 2L, AclRole.ADMIN);

        assertThat(repo.findRole(11L, 201L, 1L)).contains(AclRole.NONE);
        assertThat(repo.findRole(11L, 202L, 1L)).contains(AclRole.EDITOR);
        assertThat(repo.findRole(11L, 201L, 2L)).contains(AclRole.ADMIN);
    }

    /** DELETE 行 → findRole empty（§3.3：删除行 = 恢复工作区角色继承）。 */
    @Test
    void deleteRemovesOverrideRow() {
        repo.upsert(11L, 201L, 1L, AclRole.VIEWER);
        repo.delete(11L, 201L, 1L);

        assertThat(repo.findRole(11L, 201L, 1L)).isEmpty();
    }
}
