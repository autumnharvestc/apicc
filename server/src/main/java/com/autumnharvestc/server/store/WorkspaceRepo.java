package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.Role;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

/**
 * workspaces 表仓储（用例化方法——裁定 C）。
 * 创建工作区时建内容目录、创建者自动 OWNER 等组合语义在服务层（任务 4）；
 * 成员列表/删除等用例的查询方法随对应任务补入，不在本任务抢跑。
 */
@Repository
public class WorkspaceRepo {

    private final JdbcTemplate jdbc;

    public WorkspaceRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final RowMapper<WorkspaceRecord> MAPPER = WorkspaceRepo::mapRow;

    /** workspaces 表行数（规格 2026-09-08 §1：默认工作区启动种子判空专用，禁他处泛用）。 */
    public long count() {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM workspaces", Long.class);
        return n == null ? 0L : n;
    }

    /** 创建工作区。 */
    public void insert(WorkspaceRecord workspace) {
        jdbc.update("""
                INSERT INTO workspaces (id, name, created_by, created_at)
                VALUES (?, ?, ?, ?)
                """,
                workspace.id(), workspace.name(), workspace.createdBy(),
                OffsetDateTime.ofInstant(workspace.createdAt(), ZoneOffset.UTC));
    }

    /** 工作区详情/删除前的存在性校验。 */
    public Optional<WorkspaceRecord> findById(String id) {
        try {
            return Optional.ofNullable(jdbc.queryForObject("""
                    SELECT id, name, created_by, created_at
                    FROM workspaces WHERE id = ?
                    """, MAPPER, id));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    private static WorkspaceRecord mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new WorkspaceRecord(
                rs.getString("id"),
                rs.getString("name"),
                rs.getString("created_by"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant());
    }

    /** 「我参与的工作区」列表（GET /workspaces，任务 4）：workspaces ⋈ memberships，按创建时间稳定排序。 */
    public List<WorkspaceWithRole> findByMember(String userId) {
        return jdbc.query("""
                SELECT w.id, w.name, w.created_at, m.role AS my_role
                FROM workspaces w
                JOIN memberships m ON m.workspace_id = w.id
                WHERE m.user_id = ?
                ORDER BY w.created_at, w.id
                """, (rs, rowNum) -> new WorkspaceWithRole(
                        rs.getString("id"),
                        rs.getString("name"),
                        rs.getObject("created_at", OffsetDateTime.class).toInstant(),
                        Role.fromDb(rs.getString("my_role"))), userId);
    }

    /** 删除工作区行（DELETE /workspaces/{id} 的收尾 DB 步骤——裁定 D：此前应已清空 memberships/project_acl/file_versions）。 */
    public void delete(String id) {
        jdbc.update("DELETE FROM workspaces WHERE id = ?", id);
    }
}
