package com.autumnharvestc.server.store;

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
 * projects 表仓储（用例化方法——裁定 C）。
 * 项目名允许同名（规格 §4，身份=id）；fk_projects_group 仅保证 group_id 指向全局存在的分组——
 * 「分组须落在同一工作区」属业务规则，校验职责在服务层（任务 2 落），仓储不判业务。
 * insert 双分支（规格 2026-09-09 BIGINT 化，全局不变量 4/6）：identity = 不带 id 插入 +
 * GeneratedKeyHolder 取回生成键回填；appAssigned = nextId() 显式带 id 插入（外部策略预留）。
 */
@Repository
public class ProjectRepo {

    private static final String INSERT_SQL = """
            INSERT INTO projects (workspace_id, group_id, name, created_at)
            VALUES (?, ?, ?, ?)
            """;

    private static final String INSERT_WITH_ID_SQL = """
            INSERT INTO projects (id, workspace_id, group_id, name, created_at)
            VALUES (?, ?, ?, ?, ?)
            """;

    private final JdbcTemplate jdbc;
    private final IdGeneration ids;

    public ProjectRepo(JdbcTemplate jdbc, IdGeneration ids) {
        this.jdbc = jdbc;
        this.ids = ids;
    }

    private static final RowMapper<ProjectRecord> MAPPER = ProjectRepo::mapRow;

    /** 创建项目（外键仅保证 group_id 全局存在；「须为同工作区分组」的校验在服务层，任务 2 落），
     * 返回补全 id 的新记录（全局不变量 6）。 */
    public ProjectRecord insert(ProjectRecord project) {
        OffsetDateTime createdAt = OffsetDateTime.ofInstant(project.createdAt(), ZoneOffset.UTC);
        if (ids.appAssigned()) {
            long assigned = ids.nextId();
            jdbc.update(INSERT_WITH_ID_SQL, assigned, project.workspaceId(), project.groupId(), project.name(), createdAt);
            return project.withId(assigned);
        }
        KeyHolder keyHolder = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(INSERT_SQL, new String[]{"id"});
            ps.setLong(1, project.workspaceId());
            ps.setLong(2, project.groupId());
            ps.setString(3, project.name());
            ps.setObject(4, createdAt);
            return ps;
        }, keyHolder);
        // 生成键形态随驱动可能是 BigInteger/Long，统一 .longValue()
        Number key = Objects.requireNonNull(keyHolder.getKey(), "projects INSERT 未返回生成主键");
        return project.withId(key.longValue());
    }

    /** 项目详情/改名移动删除前的存在性校验。 */
    public Optional<ProjectRecord> find(Long id) {
        try {
            return Optional.ofNullable(jdbc.queryForObject("""
                    SELECT id, workspace_id, group_id, name, created_at
                    FROM projects WHERE id = ?
                    """, MAPPER, id));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    /** 工作区项目清单（tree.projects 实体化的数据源，任务 4；按创建时间稳定排序）。 */
    public List<ProjectRecord> listByWorkspace(Long workspaceId) {
        return jdbc.query("""
                SELECT id, workspace_id, group_id, name, created_at
                FROM projects WHERE workspace_id = ?
                ORDER BY created_at, id
                """, MAPPER, workspaceId);
    }

    /** 分组内项目清单（分组详情/删除空分组校验用）。 */
    public List<ProjectRecord> listByGroup(Long groupId) {
        return jdbc.query("""
                SELECT id, workspace_id, group_id, name, created_at
                FROM projects WHERE group_id = ?
                ORDER BY created_at, id
                """, MAPPER, groupId);
    }

    /** 项目改名（同名允许——规格 §4，无唯一约束）。 */
    public void updateName(Long id, String newName) {
        jdbc.update("UPDATE projects SET name = ? WHERE id = ?", newName, id);
    }

    /** 移动分组（跨组拖拽；外键仅保证目标分组全局存在，「同工作区」校验在服务层，任务 2 落）。 */
    public void moveGroup(Long id, Long newGroupId) {
        jdbc.update("UPDATE projects SET group_id = ? WHERE id = ?", newGroupId, id);
    }

    /** 删除项目（实体行；内容清理在内容面，此处只删行）。 */
    public void delete(Long id) {
        jdbc.update("DELETE FROM projects WHERE id = ?", id);
    }

    /** 删除工作区时清空其全部项目行（裁定 D：DELETE 工作区的 DB 清理步骤，先于 groups 行删除）。 */
    public void deleteByWorkspace(Long workspaceId) {
        jdbc.update("DELETE FROM projects WHERE workspace_id = ?", workspaceId);
    }

    /** 分组内项目计数（删除空分组守卫的判据，任务 2）。 */
    public long countByGroup(Long groupId) {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM projects WHERE group_id = ?", Long.class, groupId);
        return n == null ? 0L : n;
    }

    private static ProjectRecord mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new ProjectRecord(
                rs.getLong("id"),
                rs.getLong("workspace_id"),
                rs.getLong("group_id"),
                rs.getString("name"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant());
    }
}
