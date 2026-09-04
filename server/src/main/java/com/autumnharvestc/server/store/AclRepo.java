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
     */
    public void upsert(String workspaceId, String projectId, String userId, AclRole role) {
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
    public Optional<AclRole> findRole(String workspaceId, String projectId, String userId) {
        List<String> roles = jdbc.queryForList(
                "SELECT role FROM project_acl WHERE workspace_id = ? AND project_id = ? AND user_id = ?",
                String.class, workspaceId, projectId, userId);
        return roles.isEmpty() ? Optional.empty() : Optional.of(AclRole.fromDb(roles.get(0)));
    }

    /** 删除覆盖行（恢复继承）；幂等。 */
    public void delete(String workspaceId, String projectId, String userId) {
        jdbc.update(
                "DELETE FROM project_acl WHERE workspace_id = ? AND project_id = ? AND user_id = ?",
                workspaceId, projectId, userId);
    }
}
