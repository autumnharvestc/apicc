package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.Role;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * workspaces 表仓储（用例化方法——裁定 C）。
 * 创建工作区时建内容目录、创建者自动 OWNER 等组合语义在服务层（任务 4）；
 * 成员列表/删除等用例的查询方法随对应任务补入，不在本任务抢跑。
 * insert 双分支（规格 2026-09-09 BIGINT 化，全局不变量 4/6）：identity = 不带 id 插入 +
 * GeneratedKeyHolder 取回生成键回填；appAssigned = nextId() 显式带 id 插入（外部策略预留）。
 */
@Repository
public class WorkspaceRepo {

    private static final String INSERT_SQL = """
            INSERT INTO workspaces (name, created_by, created_at)
            VALUES (?, ?, ?)
            """;

    private static final String INSERT_WITH_ID_SQL = """
            INSERT INTO workspaces (id, name, created_by, created_at)
            VALUES (?, ?, ?, ?)
            """;

    private final JdbcTemplate jdbc;
    private final IdGeneration ids;

    public WorkspaceRepo(JdbcTemplate jdbc, IdGeneration ids) {
        this.jdbc = jdbc;
        this.ids = ids;
    }

    private static final RowMapper<WorkspaceRecord> MAPPER = WorkspaceRepo::mapRow;

    /** workspaces 表行数（规格 2026-09-08 §1：默认工作区启动种子判空专用，禁他处泛用）。 */
    public long count() {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM workspaces", Long.class);
        return n == null ? 0L : n;
    }

    /** 创建工作区，返回补全 id 的新记录（全局不变量 6）。 */
    public WorkspaceRecord insert(WorkspaceRecord workspace) {
        OffsetDateTime createdAt = OffsetDateTime.ofInstant(workspace.createdAt(), ZoneOffset.UTC);
        if (ids.appAssigned()) {
            long assigned = ids.nextId();
            jdbc.update(INSERT_WITH_ID_SQL, assigned, workspace.name(), workspace.createdBy(), createdAt);
            return workspace.withId(assigned);
        }
        KeyHolder keyHolder = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(INSERT_SQL, new String[]{"id"});
            ps.setString(1, workspace.name());
            ps.setLong(2, workspace.createdBy());
            ps.setObject(3, createdAt);
            return ps;
        }, keyHolder);
        // 生成键形态随驱动可能是 BigInteger/Long，统一 .longValue()
        Number key = Objects.requireNonNull(keyHolder.getKey(), "workspaces INSERT 未返回生成主键");
        return workspace.withId(key.longValue());
    }

    /**
     * 区内第一个工作区（握手 GET /connect 专用，规格 2026-09-08 §6「本期恒返默认工作区」）：
     * 默认工作区为首个种子行（created_at 最早）；空库返回 empty（服务层转 404 workspace_not_found）。
     */
    public Optional<WorkspaceRecord> findFirst() {
        try {
            return Optional.ofNullable(jdbc.queryForObject("""
                    SELECT id, name, created_by, created_at
                    FROM workspaces ORDER BY created_at, id LIMIT 1
                    """, MAPPER));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    /** 工作区详情/删除前的存在性校验。 */
    public Optional<WorkspaceRecord> findById(Long id) {
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
                rs.getLong("id"),
                rs.getString("name"),
                rs.getLong("created_by"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant());
    }

    /**
     * 「我参与的工作区」列表（GET /workspaces，任务 4）：workspaces ⋈ memberships，按创建时间稳定排序。
     * userId/workspaceId 均为 BIGINT（2026-09-09 BIGINT 化，任务 2/3 收口）。
     */
    public List<WorkspaceWithRole> findByMember(Long userId) {
        return jdbc.query("""
                SELECT w.id, w.name, w.created_at, m.role AS my_role
                FROM workspaces w
                JOIN memberships m ON m.workspace_id = w.id
                WHERE m.user_id = ?
                ORDER BY w.created_at, w.id
                """, (rs, rowNum) -> new WorkspaceWithRole(
                        rs.getLong("id"),
                        rs.getString("name"),
                        rs.getObject("created_at", OffsetDateTime.class).toInstant(),
                        Role.fromDb(rs.getString("my_role"))), userId);
    }

    /** 删除工作区行（DELETE /workspaces/{id} 的收尾 DB 步骤——裁定 D：此前应已清空 memberships/project_acl/file_versions）。 */
    public void delete(Long id) {
        jdbc.update("DELETE FROM workspaces WHERE id = ?", id);
    }
}
