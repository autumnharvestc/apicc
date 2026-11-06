package com.autumnharvestc.server.access;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ProjectAccessServiceTest extends AccessHttpFixture {
    // Catches reusing the legacy role parser as an admission authority without membership.
    @Test void nonMemberPresetCannotBecomeAuthority() throws Exception {
        Scope f = scope();
        // A stored old positive preset is intentional: new mutation APIs will require membership.
        // Use the real legacy repository, retaining its independent nonmember parser contract.
        oldAcl.upsert(Long.valueOf(f.workspace()), Long.valueOf(f.project()), Long.valueOf(f.target().id()),
                com.autumnharvestc.server.core.AclRole.ADMIN);
        assets(f).andExpect(status().isForbidden());
        var decision = access.resolve(Long.valueOf(f.target().id()), Long.valueOf(f.workspace()), Long.valueOf(f.project()));
        assertThat(decision.member()).isFalse();
        assertThat(decision.effectiveRole()).as("nonmember preset must not become content authority").isEmpty();
        assertThat(decision.capabilities()).isEmpty();
    }

    @org.springframework.beans.factory.annotation.Autowired
    com.autumnharvestc.server.store.AclRepo oldAcl;

    @org.springframework.beans.factory.annotation.Autowired
    com.autumnharvestc.server.store.UserRepo users;
    @org.springframework.beans.factory.annotation.Autowired
    com.autumnharvestc.server.store.MembershipRepo memberships;

    // Catches trusting the once-enabled identity after persisted disable.
    @Test void persistedDisabledAccountDenied() throws Exception {
        Scope f = scope();
        member(f, "EDITOR", 0).andExpect(status().isOk());
        users.setDisabled(Long.valueOf(f.target().id()), true);
        var decision = access.resolve(Long.valueOf(f.target().id()), Long.valueOf(f.workspace()), Long.valueOf(f.project()));
        assertAll(() -> assertThat(decision.accountEnabled()).isFalse(),
                () -> assertThat(decision.effectiveRole()).as("disabled account cannot retain a project role").isEmpty(),
                () -> assertThat(decision.capabilities()).isEmpty());
    }

    // Catches authorizing a membership row whose user no longer exists.
    @Test void missingAccountDenied() throws Exception {
        Scope f = scope();
        memberships.insert(Long.valueOf(f.workspace()), 9223372036854775806L, com.autumnharvestc.server.core.Role.ADMIN);
        var decision = access.resolve(9223372036854775806L, Long.valueOf(f.workspace()), Long.valueOf(f.project()));
        assertThat(decision.effectiveRole()).isEmpty();
        assertThat(decision.capabilities()).isEmpty();
    }

    // Catches role inheritance being applied before validating the requested project's owner scope.
    @Test void requiresProjectInWorkspace() throws Exception {
        Scope f = scope();
        Scope other = scope();
        member(f, "ADMIN", 0).andExpect(status().isOk());
        assertAll(
                () -> assertThat(access.resolve(Long.valueOf(f.target().id()), Long.valueOf(f.workspace()),
                        Long.valueOf(other.project())).effectiveRole()).as("cross-workspace project").isEmpty(),
                () -> assertThat(access.resolve(Long.valueOf(f.target().id()), Long.valueOf(f.workspace()),
                        9223372036854775806L).effectiveRole()).as("missing project").isEmpty());
    }

    // Literal role defaults from approved §6.1; empty capabilities and wrong effective-role floors fail.
    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
            "VIEWER|VIEWER|history.read",
            "EDITOR|EDITOR|history.read,history.publish,script.edit,credential.manage,task.execute,sync.check,sync.apply",
            "VIEWER|ADMIN|history.read,history.publish,script.edit,credential.manage,task.execute,publication.manage,mock.manage,mock.logs.read,audit.read,sync.manage,sync.check,sync.apply",
            "ADMIN|VIEWER|history.read"
    })
    void effectiveProjectRoleControlsDefaults(String workspaceRole, String projectRole, String expectedCodes) throws Exception {
        Scope f = scope();
        member(f, workspaceRole, 0).andExpect(status().isOk());
        acl(f, projectRole, 0).andExpect(status().isOk());
        var decision = access.resolve(Long.valueOf(f.target().id()), Long.valueOf(f.workspace()), Long.valueOf(f.project()));
        assertThat(decision.capabilities().stream().map(Capability::code))
                .containsExactlyInAnyOrder(expectedCodes.split(","));
    }
}
