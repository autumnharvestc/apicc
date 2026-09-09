package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.Role;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 仓储层单测：memberships 表（H2 内存 + 真实 SQL）。
 * 契约（规格 m3 §2 D5）：成员角色 OWNER/ADMIN/EDITOR/VIEWER 的存取与变更；复合主键 (workspace_id, user_id)；
 * DDL 的角色 CHECK 约束（裁定 A：可移植写法）拦住枚举外的脏值。
 * 2026-09-09 BIGINT 化口径（全局不变量 7）：workspaceId/userId 夹具均用小整数 Long（任务 3 收口）。
 */
@JdbcTest
@Import(MembershipRepo.class)
@Transactional
class MembershipRepoTest {

    @Autowired
    private MembershipRepo repo;

    @Autowired
    private JdbcTemplate jdbc;

    /** 四种角色逐一落库读回（角色以字符串列存储，与枚举互转见 RoleTest）。 */
    @Test
    void insertAndFindRoleForEveryRole() {
        long ws = 11L;
        for (Role role : Role.values()) {
            long user = 1L + role.ordinal();
            repo.insert(ws, user, role);
            assertThat(repo.findRole(ws, user)).contains(role);
        }
    }

    /** 同一 (workspace, user) 重复加入被复合主键拦下。 */
    @Test
    void duplicateMembershipRejected() {
        long ws = 12L;
        repo.insert(ws, 1L, Role.VIEWER);
        assertThatThrownBy(() -> repo.insert(ws, 1L, Role.EDITOR))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(repo.findRole(ws, 1L)).contains(Role.VIEWER);
    }

    /** 变更角色：命中返回 true 并生效（PUT members 的变更分支）。 */
    @Test
    void updateRoleChangesStoredRole() {
        long ws = 13L;
        repo.insert(ws, 2L, Role.VIEWER);

        boolean changed = repo.updateRole(ws, 2L, Role.ADMIN);
        assertThat(changed).isTrue();
        assertThat(repo.findRole(ws, 2L)).contains(Role.ADMIN);
    }

    /** 变更不存在的成员关系返回 false（服务层据此转 404）；幽灵 userId 用不存在的大数字。 */
    @Test
    void updateRoleWithoutRowReturnsFalse() {
        long ws = 14L;
        assertThat(repo.updateRole(ws, 999999L, Role.EDITOR)).isFalse();
        assertThat(repo.findRole(ws, 999999L)).isEmpty();
    }

    /** 角色按工作区隔离：同一 user 在不同 workspace 角色互不影响。 */
    @Test
    void rolesAreIsolatedPerWorkspace() {
        repo.insert(21L, 3L, Role.VIEWER);
        repo.insert(22L, 3L, Role.OWNER);

        assertThat(repo.findRole(21L, 3L)).contains(Role.VIEWER);
        assertThat(repo.findRole(22L, 3L)).contains(Role.OWNER);
    }

    /** DDL 契约（裁定 A）：角色 CHECK 约束拦住枚举外脏值——即使绕过仓储直接写 SQL。 */
    @Test
    void rawInsertWithIllegalRoleRejectedByCheckConstraint() {
        assertThatThrownBy(() -> jdbc.update(
                "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)",
                31L, 4L, "MASTER", OffsetDateTime.now()))
                .isInstanceOf(DataIntegrityViolationException.class);
    }
}
