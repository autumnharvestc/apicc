package com.autumnharvestc.server.store;

import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Optional;

/**
 * file_versions 表仓储（用例化方法——裁定 C）。
 * 乐观并发核心：bumpVersion 以单条 UPDATE ... WHERE version = ? 保证原子（规格 m3 §2 D6 写路径），
 * 返回 false 即 baseVersion 过期（服务层转 409 version_conflict）。
 * 树清单/删除文件等用例的查询方法随任务 5 补入。
 */
@Repository
public class FileVersionRepo {

    private final JdbcTemplate jdbc;

    public FileVersionRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final RowMapper<FileVersionRecord> MAPPER = FileVersionRepo::mapRow;

    /**
     * 新文件首写落版本（契约：新文件 baseVersion=0 → 服务端写入 version=1）。
     * (workspace_id, path) 唯一——并发首写时落败方收 DuplicateKeyException，由服务层转冲突语义。
     */
    public void insertNew(String workspaceId, String path, String contentHash, String updatedBy) {
        jdbc.update("""
                INSERT INTO file_versions (workspace_id, path, content_hash, version, updated_by, updated_at)
                VALUES (?, ?, ?, 1, ?, ?)
                """, workspaceId, path, contentHash, updatedBy, OffsetDateTime.now(ZoneOffset.UTC));
    }

    /**
     * 内容变更：版本原子递增并刷新 hash/by/at。
     * 单条 SQL 带 version 条件——两个并发写者至多一个成功，其余返回 false。
     */
    public boolean bumpVersion(String workspaceId, String path, long baseVersion,
                               String newContentHash, String updatedBy) {
        return jdbc.update("""
                UPDATE file_versions
                SET version = version + 1, content_hash = ?, updated_by = ?, updated_at = ?
                WHERE workspace_id = ? AND path = ? AND version = ?
                """, newContentHash, updatedBy, OffsetDateTime.now(ZoneOffset.UTC),
                workspaceId, path, baseVersion) > 0;
    }

    /** 读当前版本元数据（baseVersion 比对/清单复核用）。 */
    public Optional<FileVersionRecord> find(String workspaceId, String path) {
        try {
            return Optional.ofNullable(jdbc.queryForObject("""
                    SELECT workspace_id, path, content_hash, version, updated_by, updated_at
                    FROM file_versions WHERE workspace_id = ? AND path = ?
                    """, MAPPER, workspaceId, path));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    /** 删除工作区时清空其全部版本行（裁定 D：DELETE 工作区的 DB 清理步骤）。 */
    public void deleteByWorkspace(String workspaceId) {
        jdbc.update("DELETE FROM file_versions WHERE workspace_id = ?", workspaceId);
    }

    private static FileVersionRecord mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new FileVersionRecord(
                rs.getString("workspace_id"),
                rs.getString("path"),
                rs.getString("content_hash"),
                rs.getLong("version"),
                rs.getString("updated_by"),
                rs.getObject("updated_at", OffsetDateTime.class).toInstant());
    }
}
