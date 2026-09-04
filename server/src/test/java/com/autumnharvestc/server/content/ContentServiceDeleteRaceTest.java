package com.autumnharvestc.server.content;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.PermissionService;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.core.VersionConflictException;
import com.autumnharvestc.server.store.AclRepo;
import com.autumnharvestc.server.store.FileVersionRecord;
import com.autumnharvestc.server.store.FileVersionRepo;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.WorkspaceRecord;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * DELETE 竞态对称性（审查修复）：DELETE 与 PUT 的条件更新路径同构——
 * ①同版本并发双 DELETE：败者条件删除 0 行 → re-read 有行转 409 带现状 / 行已删转 404；
 * ②删盘失败回滚只做「缺席补回」（restoreIfAbsent），不覆盖并发后写者重建的行。
 * 以 Mockito 在 find 与条件删除之间确定性注入并发交错，不依赖真多线程。
 */
class ContentServiceDeleteRaceTest {

    private static final String WS = "ws-1";
    private static final String PATH = "a.yaml";

    private final UserAccount caller =
            new UserAccount("user-1", "owner", "bcrypt-hash", "owner", Instant.EPOCH);

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
        service = new ContentService(guard, permissions(), fileVersions,
                new WorkspaceContentStore("target/delete-race-test-data"));
    }

    private PermissionService permissions() {
        return new PermissionService(memberships, mock(AclRepo.class));
    }

    private static FileVersionRecord record(long version, String hash) {
        return new FileVersionRecord(WS, PATH, hash, version, "user-" + version,
                Instant.parse("2026-09-04T00:00:0" + version + "Z"));
    }

    /** 败者路径①：条件删除前并发 PUT 已把行推进（v1→v2）→ 409 version_conflict 携服务端现状。 */
    @Test
    void deleteLoserAfterConcurrentBumpConflictsWithCurrentState() {
        when(fileVersions.find(WS, PATH))
                .thenReturn(Optional.of(record(1L, "h1")))
                .thenReturn(Optional.of(record(2L, "h2")));
        when(fileVersions.deleteIfVersion(WS, PATH, 1L)).thenReturn(false);

        assertThatThrownBy(() -> service.deleteFile(caller, WS, PATH, 1L))
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

        assertThatThrownBy(() -> service.deleteFile(caller, WS, PATH, 1L))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.getCode()).isEqualTo("file_not_found");
                    assertThat(ex.getStatus().value()).isEqualTo(404);
                });
    }

    /** 赢家路径：条件删除成功、正常删盘、不触发任何回滚。 */
    @Test
    void deleteWinnerPerformsConditionalDeleteWithoutRollback() {
        when(fileVersions.find(WS, PATH)).thenReturn(Optional.of(record(1L, "h1")));
        when(fileVersions.deleteIfVersion(WS, PATH, 1L)).thenReturn(true);

        assertThatCode(() -> service.deleteFile(caller, WS, PATH, 1L)).doesNotThrowAnyException();
        verify(fileVersions, never()).restoreIfAbsent(any(), any());
    }

    /** 删盘失败：io_error 且回滚只走「缺席补回」原行（不覆盖并发重建行）。 */
    @Test
    void deleteDiskFailureRollsBackViaRestoreIfAbsentOnly() throws IOException {
        WorkspaceContentStore store = mock(WorkspaceContentStore.class);
        when(store.workspaceRoot(WS)).thenReturn(Path.of("target/delete-race-test-data/workspaces/" + WS));
        doThrow(new IOException("盘故障")).when(store).deleteFile(any(), eq(PATH));
        ContentService failingStoreService = new ContentService(guard, permissions(), fileVersions, store);
        when(fileVersions.find(WS, PATH)).thenReturn(Optional.of(record(1L, "h1")));
        when(fileVersions.deleteIfVersion(WS, PATH, 1L)).thenReturn(true);

        assertThatThrownBy(() -> failingStoreService.deleteFile(caller, WS, PATH, 1L))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.getCode()).isEqualTo("io_error");
                    assertThat(ex.getStatus().value()).isEqualTo(500);
                });
        verify(fileVersions).restoreIfAbsent(WS, record(1L, "h1"));
    }
}
