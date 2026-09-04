package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.Role;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

/**
 * memberships 表仓储（用例化方法——裁定 C）：加入/改角色/查角色。
 * 权限矩阵（谁能改谁）在服务层校验；本仓储只保证角色列与 CHECK 约束的正确存取。
 */
@Repository
public class MembershipRepo {

    private final JdbcTemplate jdbc;

    public MembershipRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 加入成员（创建工作区时创建者自动 OWNER 也走此方法）。复合主键冲突以 DuplicateKeyException 上抛。 */
    public void insert(String workspaceId, String userId, Role role) {
        jdbc.update("""
                INSERT INTO memberships (workspace_id, user_id, role, created_at)
                VALUES (?, ?, ?, ?)
                """, workspaceId, userId, role.toDb(), OffsetDateTime.now(ZoneOffset.UTC));
    }

    /** 权限判定用：查成员在指定工作区的角色。 */
    public Optional<Role> findRole(String workspaceId, String userId) {
        List<String> roles = jdbc.queryForList(
                "SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?",
                String.class, workspaceId, userId);
        return roles.isEmpty() ? Optional.empty() : Optional.of(Role.fromDb(roles.get(0)));
    }

    /** 变更成员角色（PUT members 变更分支）。返回 false = 无此成员关系（服务层转 404）。 */
    public boolean updateRole(String workspaceId, String userId, Role role) {
        return jdbc.update(
                "UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?",
                role.toDb(), workspaceId, userId) > 0;
    }

    /** 成员清单（GET members，任务 4）：memberships ⋈ users，只投影安全字段，按加入时间稳定排序。 */
    public List<MemberRow> listMembers(String workspaceId) {
        return jdbc.query("""
                SELECT m.user_id, u.username, u.display_name, m.role
                FROM memberships m
                JOIN users u ON u.id = m.user_id
                WHERE m.workspace_id = ?
                ORDER BY m.created_at, m.user_id
                """, (rs, rowNum) -> new MemberRow(
                        rs.getString("user_id"),
                        rs.getString("username"),
                        rs.getString("display_name"),
                        Role.fromDb(rs.getString("role"))), workspaceId);
    }

    /** 成员计数（GET /workspaces/{id} 的 memberCount，任务 4）。 */
    public long countByWorkspace(String workspaceId) {
        Long count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM memberships WHERE workspace_id = ?",
                Long.class, workspaceId);
        return count == null ? 0 : count;
    }

    /** 移除单个成员（DELETE members，任务 4）。 */
    public void delete(String workspaceId, String userId) {
        jdbc.update(
                "DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?",
                workspaceId, userId);
    }

    /** 删除工作区时清空其全部成员行（裁定 D：DELETE 工作区的第一个 DB 清理步骤）。 */
    public void deleteByWorkspace(String workspaceId) {
        jdbc.update("DELETE FROM memberships WHERE workspace_id = ?", workspaceId);
    }
}
