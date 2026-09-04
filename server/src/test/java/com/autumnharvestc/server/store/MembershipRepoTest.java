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
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 任务 2 仓储层单测：memberships 表（H2 内存 + 真实 SQL）。
 * 契约（规格 m3 §2 D5）：成员角色 OWNER/ADMIN/EDITOR/VIEWER 的存取与变更；复合主键 (workspace_id, user_id)；
 * DDL 的角色 CHECK 约束（裁定 A：可移植写法）拦住枚举外的脏值。
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
        String ws = UUID.randomUUID().toString();
        for (Role role : Role.values()) {
            String user = "u-" + role.name().toLowerCase();
            repo.insert(ws, user, role);
            assertThat(repo.findRole(ws, user)).contains(role);
        }
    }

    /** 同一 (workspace, user) 重复加入被复合主键拦下。 */
    @Test
    void duplicateMembershipRejected() {
        String ws = UUID.randomUUID().toString();
        repo.insert(ws, "user-1", Role.VIEWER);
        assertThatThrownBy(() -> repo.insert(ws, "user-1", Role.EDITOR))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(repo.findRole(ws, "user-1")).contains(Role.VIEWER);
    }

    /** 变更角色：命中返回 true 并生效（PUT members 的变更分支）。 */
    @Test
    void updateRoleChangesStoredRole() {
        String ws = UUID.randomUUID().toString();
        repo.insert(ws, "user-2", Role.VIEWER);

        boolean changed = repo.updateRole(ws, "user-2", Role.ADMIN);
        assertThat(changed).isTrue();
        assertThat(repo.findRole(ws, "user-2")).contains(Role.ADMIN);
    }

    /** 变更不存在的成员关系返回 false（服务层据此转 404）。 */
    @Test
    void updateRoleWithoutRowReturnsFalse() {
        String ws = UUID.randomUUID().toString();
        assertThat(repo.updateRole(ws, "ghost", Role.EDITOR)).isFalse();
        assertThat(repo.findRole(ws, "ghost")).isEmpty();
    }

    /** 角色按工作区隔离：同一 user 在不同 workspace 角色互不影响。 */
    @Test
    void rolesAreIsolatedPerWorkspace() {
        String wsA = UUID.randomUUID().toString();
        String wsB = UUID.randomUUID().toString();
        repo.insert(wsA, "user-3", Role.VIEWER);
        repo.insert(wsB, "user-3", Role.OWNER);

        assertThat(repo.findRole(wsA, "user-3")).contains(Role.VIEWER);
        assertThat(repo.findRole(wsB, "user-3")).contains(Role.OWNER);
    }

    /** DDL 契约（裁定 A）：角色 CHECK 约束拦住枚举外脏值——即使绕过仓储直接写 SQL。 */
    @Test
    void rawInsertWithIllegalRoleRejectedByCheckConstraint() {
        assertThatThrownBy(() -> jdbc.update(
                "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)",
                UUID.randomUUID().toString(), "user-4", "MASTER", OffsetDateTime.now()))
                .isInstanceOf(DataIntegrityViolationException.class);
    }
}
