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
 * groups 表仓储（用例化方法——裁定 C）。
 * 「同工作区内名称唯一」由 uk_groups_ws_name 兜底（并发建同名分组时落败方收 DuplicateKeyException）；
 * 默认分组的改名/删除守卫（is_default=TRUE 拒改拒删）在服务层（任务 2 Org 面），仓储不做业务判断。
 * insert 双分支（规格 2026-09-09 BIGINT 化，全局不变量 4/6）：identity = 不带 id 插入 +
 * GeneratedKeyHolder 取回生成键回填；appAssigned = nextId() 显式带 id 插入（外部策略预留）。
 */
@Repository
public class GroupRepo {

    private static final String INSERT_SQL = """
            INSERT INTO groups (workspace_id, name, is_default, created_at)
            VALUES (?, ?, ?, ?)
            """;

    private static final String INSERT_WITH_ID_SQL = """
            INSERT INTO groups (id, workspace_id, name, is_default, created_at)
            VALUES (?, ?, ?, ?, ?)
            """;

    private final JdbcTemplate jdbc;
    private final IdGeneration ids;

    public GroupRepo(JdbcTemplate jdbc, IdGeneration ids) {
        this.jdbc = jdbc;
        this.ids = ids;
    }

    private static final RowMapper<GroupRecord> MAPPER = GroupRepo::mapRow;

    /** 创建分组（默认分组行由 WorkspaceService.create 与 DefaultWorkspaceSeeder 落 is_default=TRUE），
     * 返回补全 id 的新记录（全局不变量 6）。 */
    public GroupRecord insert(GroupRecord group) {
        OffsetDateTime createdAt = OffsetDateTime.ofInstant(group.createdAt(), ZoneOffset.UTC);
        if (ids.appAssigned()) {
            long assigned = ids.nextId();
            jdbc.update(INSERT_WITH_ID_SQL, assigned, group.workspaceId(), group.name(), group.isDefault(), createdAt);
            return group.withId(assigned);
        }
        KeyHolder keyHolder = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(INSERT_SQL, new String[]{"id"});
            ps.setLong(1, group.workspaceId());
            ps.setString(2, group.name());
            ps.setBoolean(3, group.isDefault());
            ps.setObject(4, createdAt);
            return ps;
        }, keyHolder);
        // 生成键形态随驱动可能是 BigInteger/Long，统一 .longValue()
        Number key = Objects.requireNonNull(keyHolder.getKey(), "groups INSERT 未返回生成主键");
        return group.withId(key.longValue());
    }

    /** 分组详情/改名删除前的存在性校验。 */
    public Optional<GroupRecord> find(Long id) {
        try {
            return Optional.ofNullable(jdbc.queryForObject("""
                    SELECT id, workspace_id, name, is_default, created_at
                    FROM groups WHERE id = ?
                    """, MAPPER, id));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    /** 工作区分组清单（清单端点/建项目时校验挂载，按创建时间稳定排序）。 */
    public List<GroupRecord> listByWorkspace(Long workspaceId) {
        return jdbc.query("""
                SELECT id, workspace_id, name, is_default, created_at
                FROM groups WHERE workspace_id = ?
                ORDER BY created_at, id
                """, MAPPER, workspaceId);
    }

    /** 按名取组（客户端同名归并到同一服务端分组——规格 §4；默认分组存在性断言亦走此路径）。 */
    public Optional<GroupRecord> findByName(Long workspaceId, String name) {
        try {
            return Optional.ofNullable(jdbc.queryForObject("""
                    SELECT id, workspace_id, name, is_default, created_at
                    FROM groups WHERE workspace_id = ? AND name = ?
                    """, MAPPER, workspaceId, name));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    /** 分组改名（uk_groups_ws_name 冲突时 DuplicateKeyException 上抛，服务层转语义化错误）。 */
    public void updateName(Long id, String newName) {
        jdbc.update("UPDATE groups SET name = ? WHERE id = ?", newName, id);
    }

    /** 删除分组（空分组校验在服务层，任务 2）。 */
    public void delete(Long id) {
        jdbc.update("DELETE FROM groups WHERE id = ?", id);
    }

    /** 删除工作区时清空其全部分组行（裁定 D：DELETE 工作区的 DB 清理步骤；调用方须先清 projects 引用行）。 */
    public void deleteByWorkspace(Long workspaceId) {
        jdbc.update("DELETE FROM groups WHERE workspace_id = ?", workspaceId);
    }

    private static GroupRecord mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new GroupRecord(
                rs.getLong("id"),
                rs.getLong("workspace_id"),
                rs.getString("name"),
                rs.getBoolean("is_default"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant());
    }
}
