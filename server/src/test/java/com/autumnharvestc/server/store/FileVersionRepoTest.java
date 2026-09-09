package com.autumnharvestc.server.store;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.List;


import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 仓储层单测：file_versions 表（H2 内存 + 真实 SQL）。
 * 契约（规格 m3 §2 D6/§3.4 + §5 内容入库）：(workspace_id, path) 唯一——每路径一份版本行（元数据+正文）；
 * 新文件首写 version=1；乐观并发递增与内容写入同一条 UPDATE ... WHERE version = ? 原子完成（裁定 C）。
 * 读面 find 携 content 正文；树清单 listByWorkspace 仅携 OCTET_LENGTH 字节长、不拉正文。
 * 2026-09-09 BIGINT 化口径（全局不变量 7）：updatedBy/workspaceId 夹具均用小整数 Long（任务 3 收口）。
 */
@JdbcTest
@Import(FileVersionRepo.class)
@Transactional
class FileVersionRepoTest {

    @Autowired
    private FileVersionRepo repo;

    /** 首写落版本：version=1，content/hash/by 记录正确。 */
    @Test
    void insertNewStartsAtVersionOne() {
        long ws = 11L;
        repo.insertNew(ws, "groups/auth/projects/login/api.yaml", "首写正文", "hash-1", 1L);

        FileVersionRecord out = repo.find(ws, "groups/auth/projects/login/api.yaml").orElseThrow();
        assertThat(out.workspaceId()).isEqualTo(ws);
        assertThat(out.path()).isEqualTo("groups/auth/projects/login/api.yaml");
        assertThat(out.content()).isEqualTo("首写正文");
        assertThat(out.contentHash()).isEqualTo("hash-1");
        assertThat(out.version()).isEqualTo(1L);
        assertThat(out.updatedBy()).isEqualTo(1L);
        assertThat(out.updatedAt()).isNotNull();
    }

    /** baseVersion 匹配 → 版本递增与内容写入同一条 UPDATE：hash/by/content 一并刷新。 */
    @Test
    void bumpVersionIncrementsWhenBaseMatches() {
        long ws = 11L;
        String path = "groups/auth/api.yaml";
        repo.insertNew(ws, path, "v1", "hash-1", 1L);

        boolean bumped = repo.bumpVersion(ws, path, 1L, "v2 正文", "hash-2", 2L);
        assertThat(bumped).isTrue();

        FileVersionRecord out = repo.find(ws, path).orElseThrow();
        assertThat(out.version()).isEqualTo(2L);
        assertThat(out.content()).isEqualTo("v2 正文");
        assertThat(out.contentHash()).isEqualTo("hash-2");
        assertThat(out.updatedBy()).isEqualTo(2L);
    }

    /** baseVersion 不匹配 → 返回 false 且现状（版本与内容）不动（409 version_conflict 的存储面基础）。 */
    @Test
    void bumpVersionWithStaleBaseIsRejectedAndKeepsCurrentState() {
        long ws = 11L;
        String path = "groups/auth/api.yaml";
        repo.insertNew(ws, path, "v1", "hash-1", 1L);
        repo.bumpVersion(ws, path, 1L, "v2", "hash-2", 1L);

        assertThat(repo.bumpVersion(ws, path, 99L, "v3", "hash-3", 1L)).isFalse();
        FileVersionRecord out = repo.find(ws, path).orElseThrow();
        assertThat(out.version()).isEqualTo(2L);
        assertThat(out.content()).isEqualTo("v2");
        assertThat(out.contentHash()).isEqualTo("hash-2");
    }

    /** (workspace_id, path) 唯一：同路径重复首写被拦（并发首写由服务层转冲突语义）。 */
    @Test
    void duplicatePathInsertRejectedByUniqueConstraint() {
        long ws = 11L;
        repo.insertNew(ws, "apicc.workspace.yaml", "a", "hash-1", 1L);
        assertThatThrownBy(() -> repo.insertNew(ws, "apicc.workspace.yaml", "b", "hash-2", 2L))
                .isInstanceOf(DuplicateKeyException.class);
        assertThat(repo.find(ws, "apicc.workspace.yaml")).hasValueSatisfying(v -> {
            assertThat(v.version()).isEqualTo(1L);
            assertThat(v.content()).isEqualTo("a");
            assertThat(v.contentHash()).isEqualTo("hash-1");
        });
    }

    /** 同工作区不同路径版本独立递增；同路径跨工作区隔离。 */
    @Test
    void versionsAreIndependentPerPathAndWorkspace() {
        long wsA = 21L;
        long wsB = 22L;
        repo.insertNew(wsA, "a.yaml", "a1", "hash-a1", 1L);
        repo.insertNew(wsA, "b.yaml", "b1", "hash-b1", 1L);
        repo.insertNew(wsB, "a.yaml", "other", "hash-a1", 1L);

        assertThat(repo.bumpVersion(wsA, "a.yaml", 1L, "a2", "hash-a2", 1L)).isTrue();
        assertThat(repo.find(wsA, "a.yaml")).hasValueSatisfying(v -> assertThat(v.version()).isEqualTo(2L));
        assertThat(repo.find(wsA, "b.yaml")).hasValueSatisfying(v -> assertThat(v.version()).isEqualTo(1L));
        assertThat(repo.find(wsB, "a.yaml")).hasValueSatisfying(v -> assertThat(v.version()).isEqualTo(1L));
    }

    // ---- 内容入库口径（规格 §5）----

    /** 读面：find 携 content 正文与 contentSize（UTF-8 字节长，多字节内容按字节计）。 */
    @Test
    void findCarriesContentAndUtf8ByteSize() {
        long ws = 11L;
        repo.insertNew(ws, "p/unicode.yaml", "你好", "hash-1", 1L);

        FileVersionRecord out = repo.find(ws, "p/unicode.yaml").orElseThrow();
        assertThat(out.content()).isEqualTo("你好");
        assertThat(out.contentSize())
                .isEqualTo("你好".getBytes(StandardCharsets.UTF_8).length)
                .isEqualTo(6);
    }

    /** 树清单：按路径字典序输出、不拉 content（null）、contentSize 为 OCTET_LENGTH 字节长。 */
    @Test
    void listByWorkspaceCarriesByteSizeWithoutContentSortedByPath() {
        long ws = 11L;
        long other = 22L;
        repo.insertNew(ws, "b.yaml", "正文b", "h-b", 1L);
        repo.insertNew(ws, "groups/g/projects/p/a.yaml", "正文a", "h-a", 1L);
        repo.insertNew(ws, "apicc.workspace.yaml", "root: 1", "h-root", 1L);
        repo.insertNew(other, "a.yaml", "其他区", "h-other", 1L);

        List<FileVersionRecord> rows = repo.listByWorkspace(ws);
        assertThat(rows).extracting(FileVersionRecord::path)
                .containsExactly("apicc.workspace.yaml", "b.yaml", "groups/g/projects/p/a.yaml");
        assertThat(rows).allSatisfy(r -> {
            assertThat(r.content()).isNull(); // tree 面不拉正文
            assertThat(r.contentSize()).isPositive();
        });
        assertThat(rows.get(0).contentSize())
                .isEqualTo("root: 1".getBytes(StandardCharsets.UTF_8).length);
        assertThat(rows.get(1).contentSize())
                .isEqualTo("正文b".getBytes(StandardCharsets.UTF_8).length);
    }

    /** rootVersion 口径（裁定 A 配套）：全部行 version 之和；空工作区 0；bump 后随之增长。 */
    @Test
    void sumVersionsAddsAllRowsAndStartsAtZero() {
        long ws = 11L;
        assertThat(repo.sumVersions(ws)).isZero();

        repo.insertNew(ws, "a.yaml", "a", "h1", 1L);
        repo.insertNew(ws, "b.yaml", "b", "h1", 1L);
        assertThat(repo.sumVersions(ws)).isEqualTo(2L);

        repo.bumpVersion(ws, "a.yaml", 1L, "a2", "h2", 1L);
        assertThat(repo.sumVersions(ws)).isEqualTo(3L);

        assertThat(repo.deleteIfVersion(ws, "b.yaml", 1L)).isTrue();
        assertThat(repo.sumVersions(ws)).isEqualTo(2L);
    }

    // ---- 并发竞态原语（审查修复：DELETE 条件化；磁盘回滚面随内容入库退役）----

    /** 条件删除（DELETE 竞态封口）：仅当行仍处于期望版本时删；版本不符/行已删 → false 且行原样。 */
    @Test
    void deleteIfVersionOnlyDeletesWhenVersionMatches() {
        long ws = 11L;
        repo.insertNew(ws, "a.yaml", "a1", "h1", 1L);

        // DELETE×PUT 交错：PUT 先赢（v1→v2），携 baseVersion=1 的 DELETE 条件删除落空，行保持他人新值
        assertThat(repo.bumpVersion(ws, "a.yaml", 1L, "a2", "h2", 2L)).isTrue();
        assertThat(repo.deleteIfVersion(ws, "a.yaml", 1L)).isFalse();
        assertThat(repo.find(ws, "a.yaml")).hasValueSatisfying(r -> {
            assertThat(r.version()).isEqualTo(2L);
            assertThat(r.content()).isEqualTo("a2");
            assertThat(r.contentHash()).isEqualTo("h2");
        });

        // 正确版本删除成功
        assertThat(repo.deleteIfVersion(ws, "a.yaml", 2L)).isTrue();
        assertThat(repo.find(ws, "a.yaml")).isEmpty();

        // 同版本并发双 DELETE：先删者赢（上一步），败者条件删除 0 行 → 服务层 re-read 转 409/404
        assertThat(repo.deleteIfVersion(ws, "a.yaml", 2L)).isFalse();
    }
}
