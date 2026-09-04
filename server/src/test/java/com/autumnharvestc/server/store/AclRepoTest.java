package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.AclRole;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 任务 2 仓储层单测：project_acl 表（H2 内存 + 真实 SQL）。
 * 契约（规格 m3 §2 D5/§3.3）：项目级 ACL 覆盖行（NONE/VIEWER/EDITOR/ADMIN）按 (workspace_id, project_id, user_id)
 * 唯一；PUT 覆盖已存在的行；DELETE 行 = 恢复工作区角色继承。
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
        assertThat(repo.findRole("ws", "proj-1", "user-1")).isEmpty();
    }

    /** upsert 覆盖行：VIEWER → NONE（NONE 即拒读的存储面）。 */
    @Test
    void upsertOverwritesExistingRole() {
        String ws = UUID.randomUUID().toString();
        repo.upsert(ws, "proj-1", "user-1", AclRole.VIEWER);
        assertThat(repo.findRole(ws, "proj-1", "user-1")).contains(AclRole.VIEWER);

        repo.upsert(ws, "proj-1", "user-1", AclRole.NONE);
        assertThat(repo.findRole(ws, "proj-1", "user-1")).contains(AclRole.NONE);
    }

    /** 覆盖按 (workspace, project, user) 三元组隔离。 */
    @Test
    void overridesAreIsolatedPerProjectAndUser() {
        String ws = UUID.randomUUID().toString();
        repo.upsert(ws, "proj-1", "user-1", AclRole.NONE);
        repo.upsert(ws, "proj-2", "user-1", AclRole.EDITOR);
        repo.upsert(ws, "proj-1", "user-2", AclRole.ADMIN);

        assertThat(repo.findRole(ws, "proj-1", "user-1")).contains(AclRole.NONE);
        assertThat(repo.findRole(ws, "proj-2", "user-1")).contains(AclRole.EDITOR);
        assertThat(repo.findRole(ws, "proj-1", "user-2")).contains(AclRole.ADMIN);
    }

    /** DELETE 行 → findRole empty（§3.3：删除行 = 恢复工作区角色继承）。 */
    @Test
    void deleteRemovesOverrideRow() {
        String ws = UUID.randomUUID().toString();
        repo.upsert(ws, "proj-1", "user-1", AclRole.VIEWER);
        repo.delete(ws, "proj-1", "user-1");

        assertThat(repo.findRole(ws, "proj-1", "user-1")).isEmpty();
    }
}
