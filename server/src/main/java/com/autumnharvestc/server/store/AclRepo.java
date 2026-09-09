package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.AclRole;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

/**
 * project_acl 表仓储（用例化方法——裁定 C）：覆盖行的置值/查值/删除。
 * 删除行 = 恢复工作区角色继承（规格 m3 §3.3）；NONE 行 = 显式拒之门外（D5）。
 */
@Repository
public class AclRepo {

    private final JdbcTemplate jdbc;

    public AclRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * PUT ACL：置/覆盖 (workspace, project, user) 的角色。
     * 可移植 upsert（不用 H2 MERGE / Postgres ON CONFLICT）：先插后改；并发双插由主键约束兜底，
     * 落败方转 UPDATE，终态一致。updated_at 由本方法打点（UTC）。
     * Postgres 注意（任务 2 审查留痕 + 任务 4 裁定 B 强化）：PG 中任一语句失败即 abort 当前事务，
     * 本方法的 catch-DuplicateKey-then-UPDATE 若运行在显式事务（@Transactional）内会以
     * 「current transaction is aborted」失败——因此本工程成员/ACL 写路径约定不使用 @Transactional，
     * 各写操作以单条语句自持原子；未来迁移 PG 时应改写为 INSERT ... ON CONFLICT DO UPDATE。
     */
    public void upsert(Long workspaceId, Long projectId, Long userId, AclRole role) {
        try {
            jdbc.update("""
                    INSERT INTO project_acl (workspace_id, project_id, user_id, role, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """, workspaceId, projectId, userId, role.toDb(), OffsetDateTime.now(ZoneOffset.UTC));
        } catch (DuplicateKeyException ex) {
            jdbc.update("""
                    UPDATE project_acl SET role = ?, updated_at = ?
                    WHERE workspace_id = ? AND project_id = ? AND user_id = ?
                    """, role.toDb(), OffsetDateTime.now(ZoneOffset.UTC), workspaceId, projectId, userId);
        }
    }

    /** 权限判定用：查覆盖行；无行返回 empty（继承工作区角色的信号）。 */
    public Optional<AclRole> findRole(Long workspaceId, Long projectId, Long userId) {
        List<String> roles = jdbc.queryForList(
                "SELECT role FROM project_acl WHERE workspace_id = ? AND project_id = ? AND user_id = ?",
                String.class, workspaceId, projectId, userId);
        return roles.isEmpty() ? Optional.empty() : Optional.of(AclRole.fromDb(roles.get(0)));
    }

    /** 删除覆盖行（恢复继承）；幂等。 */
    public void delete(Long workspaceId, Long projectId, Long userId) {
        jdbc.update(
                "DELETE FROM project_acl WHERE workspace_id = ? AND project_id = ? AND user_id = ?",
                workspaceId, projectId, userId);
    }

    /** 项目 ACL 清单（GET acl，任务 4），按 user_id 稳定排序。 */
    public List<AclEntryRow> listByProject(Long workspaceId, Long projectId) {
        return jdbc.query("""
                SELECT user_id, role
                FROM project_acl
                WHERE workspace_id = ? AND project_id = ?
                ORDER BY user_id
                """, (rs, rowNum) -> new AclEntryRow(
                        rs.getLong("user_id"),
                        AclRole.fromDb(rs.getString("role"))), workspaceId, projectId);
    }

    /** 删除工作区时清空其全部 ACL 行（裁定 D：DELETE 工作区的 DB 清理步骤）。 */
    public void deleteByWorkspace(Long workspaceId) {
        jdbc.update("DELETE FROM project_acl WHERE workspace_id = ?", workspaceId);
    }

    /** 删除项目时级联清空其全部 ACL 行（任务 2，规格 2026-09-08 §4）；幂等。 */
    public void deleteByProject(Long workspaceId, Long projectId) {
        jdbc.update("DELETE FROM project_acl WHERE workspace_id = ? AND project_id = ?",
                workspaceId, projectId);
    }
}
