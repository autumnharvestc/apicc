package com.autumnharvestc.server.access;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AccessPolicyApiTest extends AccessHttpFixture {
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.store.UserRepo users;
    @org.springframework.beans.factory.annotation.Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    private org.springframework.test.web.servlet.ResultActions policy(Scope f, boolean project, long revision, Map<String,String> defaults) throws Exception {
        return mvc.perform(put((project ? f.projectUrl() : f.workspaceUrl()) + "/access-policy")
                .header("Authorization", "Bearer " + f.owner().token()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("expectedRevision", revision, "defaults", defaults))));
    }
    private org.springframework.test.web.servlet.ResultActions caps(Scope f, boolean project, long revision, Map<String,String> caps) throws Exception {
        return mvc.perform(put((project ? f.projectUrl() : f.workspaceUrl()) + "/access-members/" + f.target().id())
                .header("Authorization", "Bearer " + f.owner().token()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("expectedRevision", revision, "capabilities", caps))));
    }
    private ProjectAccessView decision(Scope f) {
        return access.resolve(Long.valueOf(f.target().id()), Long.valueOf(f.workspace()), Long.valueOf(f.project()));
    }

    @ParameterizedTest @org.junit.jupiter.params.provider.CsvSource({"project,pending","project,NONE","project,disabled","project,removed","workspace,disabled","workspace,removed"})
    void unavailableMemberViewPreservesSavedLocalCapabilityModes(String scope,String state) throws Exception {
        Scope f=scope();member(f,"EDITOR",0).andExpect(status().isOk());
        boolean project=scope.equals("project");
        String url=(project?f.projectUrl():f.workspaceUrl())+"/access-members/"+f.target().id();
        caps(f,project,project?0:1,Map.of("publication.manage","allow","script.edit","deny")).andExpect(status().isOk());
        if(state.equals("NONE"))acl(f,"NONE",1).andExpect(status().isOk());
        if(state.equals("pending"))acl(f,"ADMIN",1).andExpect(status().isOk());
        if(state.equals("pending")||state.equals("removed")) {
            mvc.perform(delete(f.workspaceUrl()+"/members/"+f.target().id()).param("expectedRevision",project?"1":"2").header("Authorization","Bearer "+f.owner().token()))
                    .andExpect(status().isNoContent());
            if(state.equals("pending")) {
                member(f,"EDITOR",2).andExpect(status().isOk());
                long current=body(mvc.perform(get(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).get("revision").longValue();
                caps(f,true,current,Map.of("publication.manage","allow")).andExpect(status().isOk());
            }
        }
        if(state.equals("disabled")) {
            jdbc.update("UPDATE users SET role='SUPERADMIN' WHERE id=?",Long.valueOf(f.owner().id()));
            mvc.perform(post("/api/v1/admin/users/"+f.target().id()+"/disable").header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                    .content("{\"expectedRevision\":1}")).andExpect(status().isNoContent());
        }
        var view=body(mvc.perform(get(url).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        var rows=new java.util.HashMap<String,com.fasterxml.jackson.databind.JsonNode>();
        view.get("capabilities").forEach(row->rows.put(row.get("code").asText(),row));
        assertAll(
                ()->assertThat(rows.get("publication.manage").get("mode").asText()).isEqualTo(state.equals("removed")?"inherit":"allow"),
                ()->assertThat(rows.get("script.edit").get("mode").asText()).isEqualTo("deny"),
                ()->assertThat(rows.values()).allSatisfy(row->{assertThat(row.get("effective").booleanValue()).isFalse();assertThat(row.get("source").asText()).isEqualTo("unavailable");}),
                ()->assertThat(decision(f).capabilities()).isEmpty(),
                ()->assets(f).andExpect(state.equals("disabled")?status().isUnauthorized():status().isForbidden()));
    }

    // Catches saving a default map without changing the real authority, and incorrect default precedence.
    @Test void projectDefaultOverridesWorkspaceAndInheritPreservesOmittedKeys() throws Exception {
        Scope f = scope(); member(f, "EDITOR", 0).andExpect(status().isOk());
        policy(f, false, 0, Map.of("task.execute", "deny", "script.edit", "deny")).andExpect(status().isOk());
        assertThat(decision(f).capabilities()).doesNotContain(Capability.TASK_EXECUTE, Capability.SCRIPT_EDIT);
        policy(f, true, 0, Map.of("task.execute", "allow")).andExpect(status().isOk());
        assertThat(decision(f).capabilities()).contains(Capability.TASK_EXECUTE).doesNotContain(Capability.SCRIPT_EDIT);
        policy(f, true, 1, Map.of("task.execute", "inherit")).andExpect(status().isOk());
        assertThat(decision(f).capabilities()).doesNotContain(Capability.TASK_EXECUTE, Capability.SCRIPT_EDIT);
    }

    // Catches lower project allows overriding an explicit workspace member deny.
    @Test void memberDenyWinsOverLowerAllowAndCanOnlyBeClearedAtItsOwnScope() throws Exception {
        Scope f = scope(); member(f, "EDITOR", 0).andExpect(status().isOk());
        caps(f, false, 1, Map.of("task.execute", "deny")).andExpect(status().isOk());
        caps(f, true, 0, Map.of("task.execute", "allow")).andExpect(status().isOk());
        assertThat(decision(f).capabilities()).doesNotContain(Capability.TASK_EXECUTE);
        caps(f, false, 2, Map.of("task.execute", "inherit")).andExpect(status().isOk());
        assertThat(decision(f).capabilities()).contains(Capability.TASK_EXECUTE);
    }

    // Catches allowing an editor only via role defaults, or allowing a viewer past the role floor.
    @Test void explicitAllowSubjectToEffectiveProjectFloor() throws Exception {
        Scope f = scope(); member(f, "EDITOR", 0).andExpect(status().isOk());
        caps(f, true, 0, Map.of("publication.manage", "allow", "audit.read", "allow")).andExpect(status().isOk());
        assertThat(decision(f).capabilities()).contains(Capability.PUBLICATION_MANAGE, Capability.AUDIT_READ);
        acl(f, "VIEWER", 1).andExpect(status().isOk());
        assertThat(decision(f).capabilities()).contains(Capability.AUDIT_READ).doesNotContain(Capability.PUBLICATION_MANAGE);
    }

    @Test void policyHasIndependentCas() throws Exception {
        Scope f = scope(); policy(f, true, 0, Map.of("task.execute", "deny")).andExpect(status().isOk());
        policy(f, true, 0, Map.of("task.execute", "allow")).andExpect(status().isConflict());
    }

    @Test void memberAndLegacyAclShareOneRevision() throws Exception {
        Scope f = scope(); member(f, "EDITOR", 0).andExpect(status().isOk());
        caps(f, true, 0, Map.of("task.execute", "deny")).andExpect(status().isOk());
        acl(f, "ADMIN", 0).andExpect(status().isConflict());
        acl(f, "VIEWER", 1).andExpect(status().isOk());
    }

    @ParameterizedTest @ValueSource(strings = {"workspace", "project"})
    void inactiveTargetCannotAcquireCapabilities(String scope) throws Exception {
        Scope f = scope();
        caps(f, scope.equals("project"), 0, Map.of("task.execute", "allow"))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("target_not_active_member"));
    }

    @ParameterizedTest @ValueSource(strings = {"workspace", "project"})
    void safeMutationDtoRejectsInvalidFieldsAtEachNewEndpoint(String scope) throws Exception {
        Scope f = scope(); member(f, "EDITOR", 0).andExpect(status().isOk());
        String prefix = scope.equals("project") ? f.projectUrl() : f.workspaceUrl();
        assertAll(
                () -> mvc.perform(put(prefix + "/access-policy").header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":\"0\",\"defaults\":{\"task.execute\":\"deny\"}}"))
                        .andExpect(status().isBadRequest()),
                () -> mvc.perform(put(prefix + "/access-policy").header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":0,\"defaults\":{\"unknown.power\":\"allow\"}}"))
                        .andExpect(status().isBadRequest()),
                () -> mvc.perform(put(prefix + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":1,\"force\":true,\"capabilities\":{\"task.execute\":\"allow\"}}"))
                        .andExpect(status().isBadRequest()),
                () -> mvc.perform(put(prefix + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":1,\"capabilities\":{\"task.execute\":\"yes\"}}"))
                        .andExpect(status().isBadRequest()),
                () -> mvc.perform(put(prefix + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":1,\"action\":\"invent\",\"role\":\"EDITOR\"}"))
                        .andExpect(status().isBadRequest()),
                () -> mvc.perform(put(prefix + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":1,\"capabilities\":{}}"))
                        .andExpect(status().isBadRequest()));
    }

    @Test void pendingCapabilitiesCannotConfirmRoleButExplicitNewRoleCan() throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk()); acl(f, "ADMIN", 0).andExpect(status().isOk());
        mvc.perform(delete(f.workspaceUrl() + "/members/" + f.target().id()).param("expectedRevision", "1")
                .header("Authorization", "Bearer " + f.owner().token())).andExpect(status().isNoContent());
        member(f, "VIEWER", 2).andExpect(status().isOk());
        caps(f, true, 2, Map.of("task.execute", "allow")).andExpect(status().isOk());
        assertThat(decision(f).overrideState()).isEqualTo("pending-confirmation");
        mvc.perform(put(f.projectUrl() + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                .contentType("application/json").content("{\"expectedRevision\":3,\"action\":\"confirm-override\",\"role\":\"EDITOR\"}"))
                .andExpect(status().isOk());
        assertThat(decision(f).effectiveRole()).contains(com.autumnharvestc.server.core.Role.EDITOR);
        assets(f).andExpect(status().isOk());
    }

    @Test void confirmInheritanceRestoresNewRoleAndRejectsIncompatibleActions() throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk()); acl(f, "NONE", 0).andExpect(status().isOk());
        mvc.perform(put(f.projectUrl() + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                .contentType("application/json").content("{\"expectedRevision\":1,\"action\":\"confirm-inheritance\"}"))
                .andExpect(status().isOk());
        assets(f).andExpect(status().isOk());
        assertAll(
                () -> mvc.perform(put(f.projectUrl() + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":2,\"action\":\"confirm-inheritance\",\"role\":\"ADMIN\"}"))
                        .andExpect(status().isBadRequest()),
                () -> mvc.perform(put(f.workspaceUrl() + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":1,\"action\":\"confirm-override\",\"role\":\"ADMIN\"}"))
                        .andExpect(status().isBadRequest()));
    }

    @Test void managementDirectoryDoesNotGrantContentAndCurrentViewUsesBusinessCodes() throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk());
        mvc.perform(get(f.workspaceUrl() + "/access-projects").header("Authorization", "Bearer " + f.target().token()))
                .andExpect(status().isForbidden());
        acl(f, "NONE", 0).andExpect(status().isOk());
        // Existing owner self-NONE preserves its distinct workspace management authority.
        mvc.perform(put(f.projectUrl() + "/acl").header("Authorization", "Bearer " + f.owner().token()).contentType("application/json")
                .content("{\"userId\":\"" + f.owner().id() + "\",\"role\":\"NONE\",\"expectedRevision\":0}"))
                .andExpect(status().isOk());
        mvc.perform(get(f.workspaceUrl() + "/access-projects").header("Authorization", "Bearer " + f.owner().token()))
                .andExpect(status().isOk()).andExpect(jsonPath("$[0].contentReadable").value(false));
    }

    @Test void currentViewUsesLowercaseCapabilityCodesAndNoOtherPolicies() throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk());
        mvc.perform(get(f.projectUrl() + "/access").header("Authorization", "Bearer " + f.target().token()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.capabilities[0]").value("history.read"))
                .andExpect(jsonPath("$.passwordHash").doesNotExist()).andExpect(jsonPath("$.policies").doesNotExist());
    }

    @ParameterizedTest @ValueSource(strings = {"workspace", "project"})
    void policyAndMemberManagementRequireTheirScopeAuthority(String scope) throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk());
        String prefix = scope.equals("project") ? f.projectUrl() : f.workspaceUrl();
        assertAll(
                () -> mvc.perform(get(prefix + "/access-policy").header("Authorization", "Bearer " + f.target().token())).andExpect(status().isForbidden()),
                () -> mvc.perform(get(prefix + "/access-members/" + f.owner().id()).header("Authorization", "Bearer " + f.target().token())).andExpect(status().isForbidden()),
                () -> mvc.perform(put(prefix + "/access-policy").header("Authorization", "Bearer " + f.target().token()).contentType("application/json")
                        .content("{\"expectedRevision\":0,\"defaults\":{\"task.execute\":\"allow\"}}" )).andExpect(status().isForbidden()),
                () -> mvc.perform(put(prefix + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.target().token()).contentType("application/json")
                        .content("{\"expectedRevision\":1,\"capabilities\":{\"task.execute\":\"allow\"}}" )).andExpect(status().isForbidden()));
    }

    @Test void effectiveProjectAdminCanManageCapabilitiesButCannotEscalateRolesOrWorkspaceMembers() throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk()); acl(f, "ADMIN", 0).andExpect(status().isOk());
        Actor peer = newActor();
        mvc.perform(put(f.workspaceUrl() + "/members/" + peer.id()).header("Authorization", "Bearer " + f.owner().token())
                .contentType("application/json").content("{\"expectedRevision\":0,\"role\":\"EDITOR\"}" )).andExpect(status().isOk());
        assertAll(
                () -> mvc.perform(put(f.projectUrl() + "/access-members/" + peer.id()).header("Authorization", "Bearer " + f.target().token())
                        .contentType("application/json").content("{\"expectedRevision\":0,\"role\":\"ADMIN\"}" )).andExpect(status().isForbidden()),
                () -> mvc.perform(put(f.workspaceUrl() + "/access-members/" + peer.id()).header("Authorization", "Bearer " + f.target().token())
                        .contentType("application/json").content("{\"expectedRevision\":1,\"role\":\"ADMIN\"}" )).andExpect(status().isForbidden()));
        mvc.perform(put(f.projectUrl() + "/access-members/" + peer.id()).header("Authorization", "Bearer " + f.target().token())
                .contentType("application/json").content("{\"expectedRevision\":0,\"capabilities\":{\"task.execute\":\"deny\"}}" ))
                .andExpect(status().isOk()).andExpect(jsonPath("$.revision").value(1));
    }

    @ParameterizedTest @ValueSource(strings = {"workspace", "project"})
    void defaultsCanExplicitlyAllowAnEditorPublication(String scope) throws Exception {
        Scope f = scope(); member(f, "EDITOR", 0).andExpect(status().isOk());
        policy(f, scope.equals("project"), 0, Map.of("publication.manage", "allow")).andExpect(status().isOk());
        assertThat(decision(f).capabilities()).contains(Capability.PUBLICATION_MANAGE);
    }

    @Test void managementViewIncludesCurrentRoleAndReadableCapabilityRows() throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk());
        mvc.perform(get(f.projectUrl() + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.workspaceRole").value("VIEWER"))
                .andExpect(jsonPath("$.capabilities.length()").value(9)).andExpect(jsonPath("$.membershipEpoch").isNumber());
    }

    @Test void directoryIncludesNoneWithoutGrantingContent() throws Exception {
        Scope f = scope();
        mvc.perform(put(f.projectUrl() + "/acl").header("Authorization", "Bearer " + f.owner().token()).contentType("application/json")
                .content("{\"userId\":\"" + f.owner().id() + "\",\"role\":\"NONE\",\"expectedRevision\":0}"))
                .andExpect(status().isOk());
        // Positive preservation control: an existing decision already separates manage from read.
        mvc.perform(get(f.workspaceUrl() + "/access-projects").header("Authorization", "Bearer " + f.owner().token()))
                .andExpect(status().isOk()).andExpect(jsonPath("$[0].id").value(f.project()))
                .andExpect(jsonPath("$[0].contentReadable").value(false));
    }

    @ParameterizedTest @ValueSource(strings = {"workspace", "project"})
    void enabledMembershipRequiredEvenForAnExistingTarget(String scope) throws Exception {
        Scope f = scope(); member(f, "EDITOR", 0).andExpect(status().isOk());
        users.setDisabled(Long.valueOf(f.target().id()), true);
        caps(f, scope.equals("project"), scope.equals("project") ? 0 : 1, Map.of("task.execute", "allow"))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("target_not_active_member"));
    }

    @Test void workspaceAccessMemberRoleChangeKeepsOwnerGuard() throws Exception {
        Scope f = scope();
        mvc.perform(put(f.workspaceUrl() + "/access-members/" + f.owner().id()).header("Authorization", "Bearer " + f.owner().token())
                .contentType("application/json").content("{\"expectedRevision\":1,\"role\":\"VIEWER\"}"))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("owner_immutable"));
    }

    @Test void projectAdminCapabilityWriteIsPersistedWithoutWorkspacePower() throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk()); acl(f, "ADMIN", 0).andExpect(status().isOk());
        mvc.perform(put(f.projectUrl() + "/access-policy").header("Authorization", "Bearer " + f.target().token())
                .contentType("application/json").content("{\"expectedRevision\":0,\"defaults\":{\"script.edit\":\"deny\"}}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.revision").value(1));
        assertThat(decision(f).capabilities()).doesNotContain(Capability.SCRIPT_EDIT);
    }

    @Test void confirmationActionFieldRulesAreEnforcedIndependently() throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk());
        assertAll(
                () -> mvc.perform(put(f.projectUrl() + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":0,\"action\":\"confirm-override\"}"))
                        .andExpect(status().isBadRequest()),
                () -> mvc.perform(put(f.projectUrl() + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":0,\"action\":\"confirm-inheritance\",\"role\":\"ADMIN\"}"))
                        .andExpect(status().isBadRequest()),
                () -> mvc.perform(put(f.workspaceUrl() + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":1,\"action\":\"confirm-override\",\"role\":\"ADMIN\"}"))
                        .andExpect(status().isBadRequest()),
                () -> mvc.perform(put(f.workspaceUrl() + "/access-members/" + f.target().id()).header("Authorization", "Bearer " + f.owner().token())
                        .contentType("application/json").content("{\"expectedRevision\":1,\"action\":\"confirm-inheritance\"}"))
                        .andExpect(status().isBadRequest()));
    }

    @ParameterizedTest @org.junit.jupiter.params.provider.CsvSource({"workspace,policy", "project,policy", "workspace,member", "project,member"})
    void eachNewMutationEndpointHasStrictControlFields(String scope, String kind) throws Exception {
        Scope f = scope(); member(f, "EDITOR", 0).andExpect(status().isOk());
        String prefix = scope.equals("project") ? f.projectUrl() : f.workspaceUrl();
        String url = prefix + (kind.equals("policy") ? "/access-policy" : "/access-members/" + f.target().id());
        String map = kind.equals("policy") ? "defaults" : "capabilities";
        java.util.List<String> invalid = new java.util.ArrayList<>(java.util.List.of(
                "{\"" + map + "\":{\"task.execute\":\"deny\"}}",
                "{\"expectedRevision\":-1,\"" + map + "\":{\"task.execute\":\"deny\"}}",
                "{\"expectedRevision\":0.5,\"" + map + "\":{\"task.execute\":\"deny\"}}",
                "{\"expectedRevision\":\"0\",\"" + map + "\":{\"task.execute\":\"deny\"}}",
                "{\"expectedRevision\":9007199254740992,\"" + map + "\":{\"task.execute\":\"deny\"}}",
                "{\"expectedRevision\":0,\"force\":true,\"" + map + "\":{\"task.execute\":\"deny\"}}",
                "{\"expectedRevision\":0,\"" + map + "\":{\"invent.power\":\"allow\"}}",
                "{\"expectedRevision\":0,\"" + map + "\":{\"task.execute\":\"yes\"}}",
                "{\"expectedRevision\":0,\"" + map + "\":{}}"));
        if (kind.equals("member")) invalid.add("{\"expectedRevision\":0,\"action\":null,\"role\":\"EDITOR\"}");
        assertAll(invalid.stream().map(payload -> (org.junit.jupiter.api.function.Executable) () ->
                mvc.perform(put(url).header("Authorization", "Bearer " + f.owner().token()).contentType("application/json").content(payload))
                        .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"))));
    }

    @ParameterizedTest @ValueSource(strings = {"workspace", "project"})
    void explicitDefaultInheritanceRemovesOnlyThatLocalKey(String scope) throws Exception {
        Scope f = scope(); member(f, "EDITOR", 0).andExpect(status().isOk());
        boolean project = scope.equals("project");
        policy(f, project, 0, Map.of("task.execute", "deny", "script.edit", "deny")).andExpect(status().isOk());
        policy(f, project, 1, Map.of("task.execute", "inherit")).andExpect(status().isOk())
                .andExpect(jsonPath("$.defaults['task.execute']").doesNotExist())
                .andExpect(jsonPath("$.defaults['script.edit']").value("deny"));
    }
}
