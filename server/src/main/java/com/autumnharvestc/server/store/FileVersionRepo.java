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
 * 内容与版本推进同一条 UPDATE（规格 §5 内容入库）——同事务天然无撕裂，返回 false 即 baseVersion
 * 过期（服务层转 409 version_conflict）。
 * 查询两套口径：find（读面，含 content 正文）与 listByWorkspace（树清单，仅 OCTET_LENGTH 字节长、
 * 不拉正文），避免 tree 全量承载内容。
 */
@Repository
public class FileVersionRepo {

    private final JdbcTemplate jdbc;

    public FileVersionRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 读面映射（find）：content 与 content_size（OCTET_LENGTH 字节）都取。 */
    private static final RowMapper<FileVersionRecord> FULL_MAPPER = FileVersionRepo::mapFullRow;

    /** 树清单映射（listByWorkspace）：content 不取（null），仅 content_size。 */
    private static final RowMapper<FileVersionRecord> LIST_MAPPER = FileVersionRepo::mapListRow;

    /**
     * 新文件首写落版本（契约：新文件 baseVersion=0 → 服务端写入 version=1），内容随行同条 INSERT。
     * (workspace_id, path) 唯一——并发首写时落败方收 DuplicateKeyException，由服务层转冲突语义。
     */
    public void insertNew(Long workspaceId, String path, String content,
                          String contentHash, Long updatedBy) {
        jdbc.update("""
                INSERT INTO file_versions (workspace_id, path, content, content_hash, version, updated_by, updated_at)
                VALUES (?, ?, ?, ?, 1, ?, ?)
                """, workspaceId, path, content, contentHash, updatedBy,
                OffsetDateTime.now(ZoneOffset.UTC));
    }

    /**
     * 内容变更：版本原子递增并刷新 content/hash/by/at——版本推进与内容写入同一条 UPDATE，
     * 天然同事务（规格 §5），不存在「版本已进、内容未进」的中间态。
     * 单条 SQL 带 version 条件——两个并发写者至多一个成功，其余返回 false。
     */
    public boolean bumpVersion(Long workspaceId, String path, long baseVersion,
                               String newContent, String newContentHash, Long updatedBy) {
        return jdbc.update("""
                UPDATE file_versions
                SET version = version + 1, content = ?, content_hash = ?, updated_by = ?, updated_at = ?
                WHERE workspace_id = ? AND path = ? AND version = ?
                """, newContent, newContentHash, updatedBy, OffsetDateTime.now(ZoneOffset.UTC),
                workspaceId, path, baseVersion) > 0;
    }

    /** 读当前版本行（baseVersion 比对/读面内容取用，含 content 正文）。 */
    public Optional<FileVersionRecord> find(Long workspaceId, String path) {
        try {
            return Optional.ofNullable(jdbc.queryForObject("""
                    SELECT workspace_id, path, content_hash, version, updated_by, updated_at,
                           content, OCTET_LENGTH(content) AS content_size
                    FROM file_versions WHERE workspace_id = ? AND path = ?
                    """, FULL_MAPPER, workspaceId, path));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    /** 删除工作区时清空其全部版本行（裁定 D：DELETE 工作区的 DB 清理步骤）。 */
    public void deleteByWorkspace(Long workspaceId) {
        jdbc.update("DELETE FROM file_versions WHERE workspace_id = ?", workspaceId);
    }

    /**
     * 删除项目时级联清空其内容版本行（任务 2，规格 2026-09-08 §4）：按 {@code <projectId>/%} 前缀删。
     * projectId 为 BIGINT 数字（2026-09-09 BIGINT 化）——十进制文本不含 % / _ 通配字符，
     * 拼接 LIKE 安全；尾随 / 使前缀精确，不会误伤同前缀开头的其他项目 id（如 11/ 不命中 110/）。
     */
    public void deleteByProjectPrefix(Long workspaceId, Long projectId) {
        jdbc.update("DELETE FROM file_versions WHERE workspace_id = ? AND path LIKE ?",
                workspaceId, projectId + "/%");
    }

    /**
     * 树清单：工作区全部版本行，按路径字典序稳定输出（GET tree 的数据源）。
     * 不拉 content 正文（tree 面不需要）；size 口径取 OCTET_LENGTH(content) 的 UTF-8 字节长。
     */
    public List<FileVersionRecord> listByWorkspace(Long workspaceId) {
        return jdbc.query("""
                SELECT workspace_id, path, content_hash, version, updated_by, updated_at,
                       OCTET_LENGTH(content) AS content_size
                FROM file_versions WHERE workspace_id = ?
                ORDER BY path
                """, LIST_MAPPER, workspaceId);
    }

    /**
     * rootVersion 口径（裁定 A 配套）：全部版本行 version 之和（空工作区 0）。
     * 任一写入使之和单调不减（删除文件减去该行），客户端可作廉价变更探测。
     */
    public long sumVersions(Long workspaceId) {
        Long sum = jdbc.queryForObject(
                "SELECT COALESCE(SUM(version), 0) FROM file_versions WHERE workspace_id = ?",
                Long.class, workspaceId);
        return sum == null ? 0L : sum;
    }

    /**
     * 条件删除（DELETE 端点并发语义核心）：仅当行仍处于 expectedVersion 时删——
     * 与 bumpVersion 的条件 UPDATE 同构，同版本并发双 DELETE / DELETE×PUT 交错至多一方得手。
     * 返回 false = 有并发写者/删者抢先，服务层 re-read 转 409（有行）或 404（行已删）。
     * 行内 content 随行同删——版本与内容的生灭同表同语句，无独立撤销面。
     */
    public boolean deleteIfVersion(Long workspaceId, String path, long expectedVersion) {
        return jdbc.update("""
                DELETE FROM file_versions
                WHERE workspace_id = ? AND path = ? AND version = ?
                """, workspaceId, path, expectedVersion) > 0;
    }

    /** 读面行映射：content 正文与字节长都取。 */
    private static FileVersionRecord mapFullRow(ResultSet rs, int rowNum) throws SQLException {
        return new FileVersionRecord(
                rs.getLong("workspace_id"),
                rs.getString("path"),
                rs.getString("content_hash"),
                rs.getLong("version"),
                rs.getLong("updated_by"),
                rs.getObject("updated_at", OffsetDateTime.class).toInstant(),
                rs.getLong("content_size"),
                rs.getString("content"));
    }

    /** 树清单行映射：content 不取（null），仅 content_size（OCTET_LENGTH，NULL 内容按 0）。 */
    private static FileVersionRecord mapListRow(ResultSet rs, int rowNum) throws SQLException {
        return new FileVersionRecord(
                rs.getLong("workspace_id"),
                rs.getString("path"),
                rs.getString("content_hash"),
                rs.getLong("version"),
                rs.getLong("updated_by"),
                rs.getObject("updated_at", OffsetDateTime.class).toInstant(),
                rs.getLong("content_size"),
                null);
    }
}
