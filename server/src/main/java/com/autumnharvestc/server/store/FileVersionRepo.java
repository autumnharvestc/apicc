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

    /**
     * 删除项目时级联清空其内容版本行（任务 2，规格 2026-09-08 §4）：按 {@code <projectId>/%} 前缀删。
     * projectId 为 UUID 文本（不含 % / _ 通配字符），直接拼接 LIKE 安全；尾随 / 使前缀精确，
     * 不会误伤同前缀开头的其他项目 id。
     */
    public void deleteByProjectPrefix(String workspaceId, String projectId) {
        jdbc.update("DELETE FROM file_versions WHERE workspace_id = ? AND path LIKE ?",
                workspaceId, projectId + "/%");
    }

    // ---- 以下为任务 5 内容同步新增（树清单/文件删除/落盘失败回滚）；审查修复后删除与回滚全部条件化 ----

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

    /**
     * 条件删除（DELETE 端点与新文件回滚共用，审查修复①）：仅当行仍处于 expectedVersion 时删——
     * 与 bumpVersion 的条件 UPDATE 同构，同版本并发双 DELETE / DELETE×PUT 交错至多一方得手。
     * 返回 false = 有并发写者/删者抢先，服务层 re-read 转 409（有行）或 404（行已删）。
     */
    public boolean deleteIfVersion(String workspaceId, String path, long expectedVersion) {
        return jdbc.update("""
                DELETE FROM file_versions
                WHERE workspace_id = ? AND path = ? AND version = ?
                """, workspaceId, path, expectedVersion) > 0;
    }

    /**
     * 落盘失败回滚（既有文件，审查修复③）：仅当行仍是我推进后的那一版（version = bumpedVersion）
     * 才拨回写入前原值——并发后写者若已把行推得更远，回滚静默放弃（返回 false），
     * 不把他人新行拨回旧值（防「库旧盘新」撕裂）。不设重插兜底：行消失即有人抢先，同样放弃。
     */
    public boolean restoreAfterBump(String workspaceId, String path,
                                    FileVersionRecord original, long bumpedVersion) {
        return jdbc.update("""
                UPDATE file_versions
                SET content_hash = ?, version = ?, updated_by = ?, updated_at = ?
                WHERE workspace_id = ? AND path = ? AND version = ?
                """, original.contentHash(), original.version(), original.updatedBy(),
                OffsetDateTime.ofInstant(original.updatedAt(), ZoneOffset.UTC),
                workspaceId, path, bumpedVersion) > 0;
    }

    /**
     * 删盘失败回滚（DELETE 文件，审查修复②配套）：仅当该路径当前无版本行（无人重建）时补回原行——
     * 并发 PUT 若已 insertNew 重建，其「行+盘内容」自洽，回滚放弃（返回 false）不覆盖。
     * INSERT ... SELECT ... WHERE NOT EXISTS 为可移植写法（H2/Postgres 皆支持）。
     */
    public boolean restoreIfAbsent(String workspaceId, FileVersionRecord record) {
        return jdbc.update("""
                INSERT INTO file_versions (workspace_id, path, content_hash, version, updated_by, updated_at)
                SELECT ?, ?, ?, ?, ?, ?
                WHERE NOT EXISTS (SELECT 1 FROM file_versions WHERE workspace_id = ? AND path = ?)
                """, workspaceId, record.path(), record.contentHash(), record.version(),
                record.updatedBy(), OffsetDateTime.ofInstant(record.updatedAt(), ZoneOffset.UTC),
                workspaceId, record.path()) > 0;
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
