package com.autumnharvestc.server.admin;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.PlatformRole;
import com.autumnharvestc.server.store.TokenRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import com.autumnharvestc.server.store.WorkspaceRepo;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * AdminService 纯单测（不起 Spring 上下文）：钉住 check-then-insert 的唯一约束竞态兜底——
 * findByUsername 查空后 insert 撞 users.username 唯一约束（DuplicateKeyException）须译为
 * 409 username_taken，而非 500 internal_error（与 AuthService.register 的契约对齐）。
 * 该窗口无法经 HTTP 端到端模拟（要抢在服务层 check 与 insert 之间），故在仓储边界打桩。
 */
class AdminServiceTest {

    private final UserRepo users = mock(UserRepo.class);
    private final TokenRepo tokens = mock(TokenRepo.class);
    private final MembershipRepo memberships = mock(MembershipRepo.class);
    private final WorkspaceRepo workspaces = mock(WorkspaceRepo.class);
    private final AdminService service = new AdminService(users, tokens, memberships, workspaces);

    private UserAccount caller(PlatformRole role) {
        return new UserAccount("caller-id", "admin", "hash", "管理员", role, false, Instant.now());
    }

    private AdminRequests.CreateUserRequest createBob() {
        return new AdminRequests.CreateUserRequest("bob", "password123", "Bob");
    }

    /** 竞态兜底：check 时空、insert 时撞唯一约束 → 409 username_taken（不得 500）。 */
    @Test
    void createTranslatesUniqueConstraintRaceTo409UsernameTaken() {
        when(users.findByUsername("bob")).thenReturn(java.util.Optional.empty());
        org.mockito.Mockito.doThrow(new DuplicateKeyException("uk_users_username"))
                .when(users).insert(any());

        assertThatThrownBy(() -> service.create(caller(PlatformRole.SUPERADMIN), createBob()))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(ex.getCode()).isEqualTo("username_taken");
                });
    }

    /** 顺带钉守卫：非超管调用直接 403 superadmin_required，且完全不触仓储。 */
    @Test
    void createRequiresSuperadminBeforeAnyStoreAccess() {
        assertThatThrownBy(() -> service.create(caller(PlatformRole.USER), createBob()))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.getStatus()).isEqualTo(HttpStatus.FORBIDDEN);
                    assertThat(ex.getCode()).isEqualTo("superadmin_required");
                });
        verifyNoInteractions(users, tokens, memberships);
    }

    /** 顺带钉成功路径：超管创建落库为 USER + 未停用， displayName trim。 */
    @Test
    void createBySuperadminInsertsUserAccount() {
        when(users.findByUsername("bob")).thenReturn(java.util.Optional.empty());

        UserAccount created = service.create(caller(PlatformRole.SUPERADMIN),
                new AdminRequests.CreateUserRequest("bob", "password123", "  Bob  "));

        ArgumentCaptor<UserAccount> captor = ArgumentCaptor.forClass(UserAccount.class);
        verify(users).insert(captor.capture());
        assertThat(captor.getValue().username()).isEqualTo("bob");
        assertThat(captor.getValue().role()).isEqualTo(PlatformRole.USER);
        assertThat(captor.getValue().disabled()).isFalse();
        assertThat(captor.getValue().displayName()).isEqualTo("Bob");
        assertThat(created.id()).isNotEmpty();
        verify(tokens, never()).revokeAllByUser(any());
    }
}
