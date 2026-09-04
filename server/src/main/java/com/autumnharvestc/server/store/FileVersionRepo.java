package com.autumnharvestc.server.store;

import org.springframework.dao.DuplicateKeyException;
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

    // ---- 以下为任务 5 内容同步新增（树清单/文件删除/落盘失败回滚）----

    /** 树清单：工作区全部版本行，按路径字典序稳定输出（GET tree 的数据源）。 */
    public List<FileVersionRecord> listByWorkspace(String workspaceId) {
        return jdbc.query("""
                SELECT workspace_id, path, content_hash, version, updated_by, updated_at
                FROM file_versions WHERE workspace_id = ?
                ORDER BY path
                """, MAPPER, workspaceId);
    }

    /**
     * rootVersion 口径（裁定 A 配套）：全部版本行 version 之和（空工作区 0）。
     * 任一写入使之和单调不减（删除文件减去该行），客户端可作廉价变更探测。
     */
    public long sumVersions(String workspaceId) {
        Long sum = jdbc.queryForObject(
                "SELECT COALESCE(SUM(version), 0) FROM file_versions WHERE workspace_id = ?",
                Long.class, workspaceId);
        return sum == null ? 0L : sum;
    }

    /** 删除单路径版本行（DELETE 文件 / 新文件落盘失败回滚）。返回是否确有行被删。 */
    public boolean delete(String workspaceId, String path) {
        return jdbc.update(
                "DELETE FROM file_versions WHERE workspace_id = ? AND path = ?",
                workspaceId, path) > 0;
    }

    /**
     * 精确恢复一行（落盘失败/删盘失败时把版本表拨回写入前状态——规格 m3 §2 D6 回滚口径）。
     * UPDATE 无行（理论不可达的竞态）则重插原值兜底；主键再撞则放弃（终态仍是某次真实写入）。
     */
    public boolean restore(String workspaceId, FileVersionRecord record) {
        OffsetDateTime updatedAt = OffsetDateTime.ofInstant(record.updatedAt(), ZoneOffset.UTC);
        int updated = jdbc.update("""
                UPDATE file_versions
                SET content_hash = ?, version = ?, updated_by = ?, updated_at = ?
                WHERE workspace_id = ? AND path = ?
                """, record.contentHash(), record.version(), record.updatedBy(), updatedAt,
                workspaceId, record.path());
        if (updated > 0) {
            return true;
        }
        try {
            jdbc.update("""
                    INSERT INTO file_versions (workspace_id, path, content_hash, version, updated_by, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """, workspaceId, record.path(), record.contentHash(), record.version(),
                    record.updatedBy(), updatedAt);
            return true;
        } catch (DuplicateKeyException ex) {
            return false;
        }
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
