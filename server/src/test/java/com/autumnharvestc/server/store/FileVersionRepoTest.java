package com.autumnharvestc.server.store;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 任务 2 仓储层单测：file_versions 表（H2 内存 + 真实 SQL）。
 * 契约（规格 m3 §2 D6/§3.4）：(workspace_id, path) 唯一——每路径一份版本元数据；
 * 新文件首写 version=1；乐观并发递增以单条 UPDATE ... WHERE version = ? 原子完成（裁定 C）。
 */
@JdbcTest
@Import(FileVersionRepo.class)
@Transactional
class FileVersionRepoTest {

    @Autowired
    private FileVersionRepo repo;

    /** 首写落版本：version=1，hash/by 记录正确。 */
    @Test
    void insertNewStartsAtVersionOne() {
        String ws = UUID.randomUUID().toString();
        repo.insertNew(ws, "groups/auth/projects/login/api.yaml", "hash-1", "user-1");

        FileVersionRecord out = repo.find(ws, "groups/auth/projects/login/api.yaml").orElseThrow();
        assertThat(out.workspaceId()).isEqualTo(ws);
        assertThat(out.path()).isEqualTo("groups/auth/projects/login/api.yaml");
        assertThat(out.contentHash()).isEqualTo("hash-1");
        assertThat(out.version()).isEqualTo(1L);
        assertThat(out.updatedBy()).isEqualTo("user-1");
        assertThat(out.updatedAt()).isNotNull();
    }

    /** baseVersion 匹配 → 原子递增并更新 hash/by（PUT 内容变更的存储面）。 */
    @Test
    void bumpVersionIncrementsWhenBaseMatches() {
        String ws = UUID.randomUUID().toString();
        String path = "groups/auth/api.yaml";
        repo.insertNew(ws, path, "hash-1", "user-1");

        boolean bumped = repo.bumpVersion(ws, path, 1L, "hash-2", "user-2");
        assertThat(bumped).isTrue();

        FileVersionRecord out = repo.find(ws, path).orElseThrow();
        assertThat(out.version()).isEqualTo(2L);
        assertThat(out.contentHash()).isEqualTo("hash-2");
        assertThat(out.updatedBy()).isEqualTo("user-2");
    }

    /** baseVersion 不匹配 → 返回 false 且现状不动（409 version_conflict 的存储面基础）。 */
    @Test
    void bumpVersionWithStaleBaseIsRejectedAndKeepsCurrentState() {
        String ws = UUID.randomUUID().toString();
        String path = "groups/auth/api.yaml";
        repo.insertNew(ws, path, "hash-1", "user-1");
        repo.bumpVersion(ws, path, 1L, "hash-2", "user-1");

        assertThat(repo.bumpVersion(ws, path, 99L, "hash-3", "user-1")).isFalse();
        FileVersionRecord out = repo.find(ws, path).orElseThrow();
        assertThat(out.version()).isEqualTo(2L);
        assertThat(out.contentHash()).isEqualTo("hash-2");
    }

    /** (workspace_id, path) 唯一：同路径重复首写被拦（并发首写由服务层转冲突语义）。 */
    @Test
    void duplicatePathInsertRejectedByUniqueConstraint() {
        String ws = UUID.randomUUID().toString();
        repo.insertNew(ws, "apicc.workspace.yaml", "hash-1", "user-1");
        assertThatThrownBy(() -> repo.insertNew(ws, "apicc.workspace.yaml", "hash-2", "user-2"))
                .isInstanceOf(DuplicateKeyException.class);
        assertThat(repo.find(ws, "apicc.workspace.yaml")).hasValueSatisfying(v -> {
            assertThat(v.version()).isEqualTo(1L);
            assertThat(v.contentHash()).isEqualTo("hash-1");
        });
    }

    /** 同工作区不同路径版本独立递增；同路径跨工作区隔离。 */
    @Test
    void versionsAreIndependentPerPathAndWorkspace() {
        String wsA = UUID.randomUUID().toString();
        String wsB = UUID.randomUUID().toString();
        repo.insertNew(wsA, "a.yaml", "hash-a1", "user-1");
        repo.insertNew(wsA, "b.yaml", "hash-b1", "user-1");
        repo.insertNew(wsB, "a.yaml", "hash-a1", "user-1");

        assertThat(repo.bumpVersion(wsA, "a.yaml", 1L, "hash-a2", "user-1")).isTrue();
        assertThat(repo.find(wsA, "a.yaml")).hasValueSatisfying(v -> assertThat(v.version()).isEqualTo(2L));
        assertThat(repo.find(wsA, "b.yaml")).hasValueSatisfying(v -> assertThat(v.version()).isEqualTo(1L));
        assertThat(repo.find(wsB, "a.yaml")).hasValueSatisfying(v -> assertThat(v.version()).isEqualTo(1L));
    }

    // ---- 以下为任务 5 内容同步新增的用例方法 ----

    /** 树清单数据源：只取本工作区行，按路径字典序稳定输出。 */
    @Test
    void listByWorkspaceReturnsOwnRowsSortedByPath() {
        String ws = UUID.randomUUID().toString();
        String other = UUID.randomUUID().toString();
        repo.insertNew(ws, "b.yaml", "h-b", "user-1");
        repo.insertNew(ws, "groups/g/projects/p/a.yaml", "h-a", "user-1");
        repo.insertNew(ws, "apicc.workspace.yaml", "h-root", "user-1");
        repo.insertNew(other, "a.yaml", "h-other", "user-1");

        List<FileVersionRecord> rows = repo.listByWorkspace(ws);
        assertThat(rows).extracting(FileVersionRecord::path)
                .containsExactly("apicc.workspace.yaml", "b.yaml", "groups/g/projects/p/a.yaml");
    }

    /** rootVersion 口径（裁定 A 配套）：全部行 version 之和；空工作区 0；bump 后随之增长。 */
    @Test
    void sumVersionsAddsAllRowsAndStartsAtZero() {
        String ws = UUID.randomUUID().toString();
        assertThat(repo.sumVersions(ws)).isZero();

        repo.insertNew(ws, "a.yaml", "h1", "user-1");
        repo.insertNew(ws, "b.yaml", "h1", "user-1");
        assertThat(repo.sumVersions(ws)).isEqualTo(2L);

        repo.bumpVersion(ws, "a.yaml", 1L, "h2", "user-1");
        assertThat(repo.sumVersions(ws)).isEqualTo(3L);

        repo.delete(ws, "b.yaml");
        assertThat(repo.sumVersions(ws)).isEqualTo(2L);
    }

    /** 单路径删除与精确恢复（落盘失败回滚的存储面）：restore 拨回原 hash/version/by/at。 */
    @Test
    void deleteRemovesRowAndRestorePutsItBack() {
        String ws = UUID.randomUUID().toString();
        repo.insertNew(ws, "a.yaml", "h1", "user-1");
        FileVersionRecord original = repo.find(ws, "a.yaml").orElseThrow();

        assertThat(repo.delete(ws, "a.yaml")).isTrue();
        assertThat(repo.delete(ws, "a.yaml")).isFalse(); // 幂等：再删无行
        assertThat(repo.find(ws, "a.yaml")).isEmpty();

        assertThat(repo.restore(ws, original)).isTrue();
        assertThat(repo.find(ws, "a.yaml")).hasValueSatisfying(restored -> {
            assertThat(restored.version()).isEqualTo(original.version());
            assertThat(restored.contentHash()).isEqualTo(original.contentHash());
            assertThat(restored.updatedBy()).isEqualTo(original.updatedBy());
            assertThat(restored.updatedAt()).isEqualTo(original.updatedAt());
        });
    }
}
