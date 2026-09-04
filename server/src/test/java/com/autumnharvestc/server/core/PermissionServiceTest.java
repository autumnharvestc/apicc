package com.autumnharvestc.server.core;

import com.autumnharvestc.server.store.AclRepo;
import com.autumnharvestc.server.store.MembershipRepo;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Transactional;

import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 任务 2 权限判定单测（规格 m3 §2 D5，裁定 D）：
 * effectiveRole——project_acl 行存在 → 该值生效（NONE 即拒读）；无行 → 继承工作区角色；projectId 为 null → 工作区角色。
 * 谓词——canRead ∈ {OWNER,ADMIN,EDITOR,VIEWER}；canWrite ∈ {OWNER,ADMIN,EDITOR}；isAdmin/isOwner 显式。
 */
@JdbcTest
@Import({PermissionService.class, MembershipRepo.class, AclRepo.class})
@Transactional
class PermissionServiceTest {

    @Autowired
    private PermissionService service;

    @Autowired
    private MembershipRepo memberships;

    @Autowired
    private AclRepo acl;

    /** projectId 为 null（工作区级操作）→ 直接取工作区角色。 */
    @Test
    void nullProjectIdYieldsWorkspaceRole() {
        String ws = UUID.randomUUID().toString();
        memberships.insert(ws, "u-editor", Role.EDITOR);

        assertThat(service.effectiveRole(ws, "u-editor", null)).contains(Role.EDITOR);
        assertThat(service.effectiveRole(ws, "u-editor")).contains(Role.EDITOR);
    }

    /** 无 ACL 行 → 继承工作区角色（D5：无行 = 按工作区角色继承）。 */
    @Test
    void noAclRowInheritsWorkspaceRole() {
        String ws = UUID.randomUUID().toString();
        memberships.insert(ws, "u-viewer", Role.VIEWER);

        assertThat(service.effectiveRole(ws, "u-viewer", "proj-1")).contains(Role.VIEWER);
    }

    /** ACL 行存在 → 覆盖生效，即使相对工作区角色是降级（ADMIN → VIEWER）。 */
    @Test
    void aclRowOverridesEvenToLowerRole() {
        String ws = UUID.randomUUID().toString();
        memberships.insert(ws, "u-admin", Role.ADMIN);
        acl.upsert(ws, "proj-1", "u-admin", AclRole.VIEWER);

        assertThat(service.effectiveRole(ws, "u-admin", "proj-1")).contains(Role.VIEWER);
    }

    /** ACL 行存在 → 覆盖生效，也可以是提权（VIEWER → EDITOR）。 */
    @Test
    void aclRowOverridesEvenToHigherRole() {
        String ws = UUID.randomUUID().toString();
        memberships.insert(ws, "u-viewer", Role.VIEWER);
        acl.upsert(ws, "proj-1", "u-viewer", AclRole.EDITOR);

        assertThat(service.effectiveRole(ws, "u-viewer", "proj-1")).contains(Role.EDITOR);
    }

    /** ACL 行为 NONE → 拒读（empty 表示无任何有效角色，三面全挡）。 */
    @Test
    void aclNoneYieldsNoEffectiveRole() {
        String ws = UUID.randomUUID().toString();
        memberships.insert(ws, "u-editor", Role.EDITOR);
        acl.upsert(ws, "proj-1", "u-editor", AclRole.NONE);

        assertThat(service.effectiveRole(ws, "u-editor", "proj-1")).isEmpty();
    }

    /** 非成员但有 ACL 行 → 该行生效（覆盖优先于成员关系判断）。 */
    @Test
    void aclRowGrantsNonMember() {
        String ws = UUID.randomUUID().toString();
        acl.upsert(ws, "proj-1", "u-outsider", AclRole.ADMIN);

        assertThat(service.effectiveRole(ws, "u-outsider", "proj-1")).contains(Role.ADMIN);
    }

    /** 非成员且无 ACL 行 → empty（未授权访问的判定基础）。 */
    @Test
    void nonMemberWithoutAclRowHasNoEffectiveRole() {
        String ws = UUID.randomUUID().toString();
        assertThat(service.effectiveRole(ws, "u-outsider", "proj-1")).isEmpty();
        assertThat(service.effectiveRole(ws, "u-outsider", null)).isEmpty();
    }

    /** canRead：全部四种工作区角色均可读（D5 阶梯最低档即 VIEWER）。 */
    @Test
    void canReadCoversAllRoles() {
        for (Role role : Role.values()) {
            assertThat(service.canRead(role)).as(role.name()).isTrue();
        }
        assertThat(service.canRead(null)).isFalse();
    }

    /** canWrite：OWNER/ADMIN/EDITOR 可写，VIEWER 只读。 */
    @Test
    void canWriteExcludesViewer() {
        assertThat(service.canWrite(Role.OWNER)).isTrue();
        assertThat(service.canWrite(Role.ADMIN)).isTrue();
        assertThat(service.canWrite(Role.EDITOR)).isTrue();
        assertThat(service.canWrite(Role.VIEWER)).isFalse();
        assertThat(service.canWrite(null)).isFalse();
    }

    /** isAdmin（ADMIN+ 含 OWNER）：管理成员与项目 ACL 的判定。 */
    @Test
    void isAdminIncludesOwnerAndAdmin() {
        assertThat(service.isAdmin(Role.OWNER)).isTrue();
        assertThat(service.isAdmin(Role.ADMIN)).isTrue();
        assertThat(service.isAdmin(Role.EDITOR)).isFalse();
        assertThat(service.isAdmin(Role.VIEWER)).isFalse();
        assertThat(service.isAdmin(null)).isFalse();
    }

    /** isOwner：仅 OWNER（删除/转让工作区的判定）。 */
    @Test
    void isOwnerIsOwnerOnly() {
        assertThat(service.isOwner(Role.OWNER)).isTrue();
        assertThat(service.isOwner(Role.ADMIN)).isFalse();
        assertThat(service.isOwner(Role.EDITOR)).isFalse();
        assertThat(service.isOwner(Role.VIEWER)).isFalse();
        assertThat(service.isOwner(null)).isFalse();
    }
}
