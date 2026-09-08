package com.autumnharvestc.server.store;

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
 * groups 表仓储（用例化方法——裁定 C）。
 * 「同工作区内名称唯一」由 uk_groups_ws_name 兜底（并发建同名分组时落败方收 DuplicateKeyException）；
 * 默认分组的改名/删除守卫（is_default=TRUE 拒改拒删）在服务层（任务 2 Org 面），仓储不做业务判断。
 */
@Repository
public class GroupRepo {

    private final JdbcTemplate jdbc;

    public GroupRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final RowMapper<GroupRecord> MAPPER = GroupRepo::mapRow;

    /** 创建分组（默认分组行由 WorkspaceService.create 与 DefaultWorkspaceSeeder 落 is_default=TRUE）。 */
    public void insert(GroupRecord group) {
        jdbc.update("""
                INSERT INTO groups (id, workspace_id, name, is_default, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                group.id(), group.workspaceId(), group.name(), group.isDefault(),
                OffsetDateTime.ofInstant(group.createdAt(), ZoneOffset.UTC));
    }

    /** 分组详情/改名删除前的存在性校验。 */
    public Optional<GroupRecord> find(String id) {
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
    public List<GroupRecord> listByWorkspace(String workspaceId) {
        return jdbc.query("""
                SELECT id, workspace_id, name, is_default, created_at
                FROM groups WHERE workspace_id = ?
                ORDER BY created_at, id
                """, MAPPER, workspaceId);
    }

    /** 按名取组（客户端同名归并到同一服务端分组——规格 §4；默认分组存在性断言亦走此路径）。 */
    public Optional<GroupRecord> findByName(String workspaceId, String name) {
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
    public void updateName(String id, String newName) {
        jdbc.update("UPDATE groups SET name = ? WHERE id = ?", newName, id);
    }

    /** 删除分组（空分组校验在服务层，任务 2）。 */
    public void delete(String id) {
        jdbc.update("DELETE FROM groups WHERE id = ?", id);
    }

    /** 删除工作区时清空其全部分组行（裁定 D：DELETE 工作区的 DB 清理步骤；调用方须先清 projects 引用行）。 */
    public void deleteByWorkspace(String workspaceId) {
        jdbc.update("DELETE FROM groups WHERE workspace_id = ?", workspaceId);
    }

    private static GroupRecord mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new GroupRecord(
                rs.getString("id"),
                rs.getString("workspace_id"),
                rs.getString("name"),
                rs.getBoolean("is_default"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant());
    }
}
