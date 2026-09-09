package com.autumnharvestc.server.content;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.PermissionService;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.core.VersionConflictException;
import com.autumnharvestc.server.store.AclRepo;
import com.autumnharvestc.server.store.FileVersionRecord;
import com.autumnharvestc.server.store.FileVersionRepo;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.PlatformRole;
import com.autumnharvestc.server.store.ProjectRecord;
import com.autumnharvestc.server.store.ProjectRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.WorkspaceRecord;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * DELETE 竞态对称性（审查修复）：DELETE 与 PUT 的条件更新路径同构——
 * ①同版本并发双 DELETE：败者条件删除 0 行 → re-read 有行转 409 带现状 / 行已删转 404。
 * 内容入库（规格 §5）后版本行含 content 随条件语句同生灭，磁盘回滚补偿面（restoreAfterBump/
 * restoreIfAbsent）退役；条件化并发语义由 deleteIfVersion 与本类/仓储单测承担。
 * 以 Mockito 在 find 与条件删除之间确定性注入并发交错，不依赖真多线程。
 */
class ContentServiceDeleteRaceTest {

    /** 工作区主键夹具（2026-09-09 BIGINT 化：小整数 Long）。 */
    private static final long WS = 5L;
    /** 项目实体主键夹具（内容 path 首段实体化 + BIGINT 化）。 */
    private static final long PROJECT_ID = 77L;
    private static final String PATH = PROJECT_ID + "/a.yaml";

    private final UserAccount caller =
            new UserAccount(1L, "owner", "bcrypt-hash", "owner",
                    PlatformRole.USER, false, Instant.EPOCH);

    private WorkspaceGuard guard;
    private MembershipRepo memberships;
    private FileVersionRepo fileVersions;
    private ContentService service;

    @BeforeEach
    void setUp() {
        guard = mock(WorkspaceGuard.class);
        when(guard.requireMember(eq(WS), any(UserAccount.class))).thenReturn(new WorkspaceGuard.Access(
                new WorkspaceRecord(WS, "ws", caller.id(), Instant.EPOCH), Role.OWNER));
        memberships = mock(MembershipRepo.class);
        when(memberships.findRole(WS, caller.id())).thenReturn(Optional.of(Role.OWNER));
        fileVersions = mock(FileVersionRepo.class);
        // path 实体化写面校验：首段项目 id 须指向本工作区实体（DELETE 前置校验用）
        ProjectRepo projects = mock(ProjectRepo.class);
        when(projects.find(PROJECT_ID)).thenReturn(Optional.of(
                new ProjectRecord(PROJECT_ID, WS, 1L, "p", Instant.EPOCH)));
        service = new ContentService(guard, permissions(), projects, fileVersions);
    }

    private PermissionService permissions() {
        return new PermissionService(memberships, mock(AclRepo.class));
    }

    private static FileVersionRecord record(long version, String hash) {
        return new FileVersionRecord(WS, PATH, hash, version, 1L,
                Instant.parse("2026-09-04T00:00:0" + version + "Z"), 0L, "body-" + version);
    }

    /** 败者路径①：条件删除前并发 PUT 已把行推进（v1→v2）→ 409 version_conflict 携服务端现状。 */
    @Test
    void deleteLoserAfterConcurrentBumpConflictsWithCurrentState() {
        when(fileVersions.find(WS, PATH))
                .thenReturn(Optional.of(record(1L, "h1")))
                .thenReturn(Optional.of(record(2L, "h2")));
        when(fileVersions.deleteIfVersion(WS, PATH, 1L)).thenReturn(false);

        assertThatThrownBy(() -> service.deleteFile(caller, String.valueOf(WS), PATH, 1L))
                .isInstanceOfSatisfying(VersionConflictException.class, ex -> {
                    assertThat(ex.getCurrentVersion()).isEqualTo(2L);
                    assertThat(ex.getCurrentHash()).isEqualTo("h2");
                });
    }

    /** 败者路径②：条件删除前行已被并发 DELETE 删掉 → 404 file_not_found（与顺序双 DELETE 同口径）。 */
    @Test
    void deleteLoserAfterConcurrentDeleteReturnsNotFound() {
        when(fileVersions.find(WS, PATH))
                .thenReturn(Optional.of(record(1L, "h1")))
                .thenReturn(Optional.empty());
        when(fileVersions.deleteIfVersion(WS, PATH, 1L)).thenReturn(false);

        assertThatThrownBy(() -> service.deleteFile(caller, String.valueOf(WS), PATH, 1L))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.getCode()).isEqualTo("file_not_found");
                    assertThat(ex.getStatus().value()).isEqualTo(404);
                });
    }

    /** 赢家路径：条件删除成功即完成（版本行含 content 随语句同删），无任何补偿分支。 */
    @Test
    void deleteWinnerPerformsConditionalDeleteWithoutRollback() {
        when(fileVersions.find(WS, PATH)).thenReturn(Optional.of(record(1L, "h1")));
        when(fileVersions.deleteIfVersion(WS, PATH, 1L)).thenReturn(true);

        assertThatCode(() -> service.deleteFile(caller, String.valueOf(WS), PATH, 1L)).doesNotThrowAnyException();
    }
}
