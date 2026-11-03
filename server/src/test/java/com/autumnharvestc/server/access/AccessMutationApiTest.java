package com.autumnharvestc.server.access;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AccessMutationApiTest extends AccessHttpFixture {
    // Catches existing member writers silently accepting a missing concurrency precondition.
    @Test void memberMissingRevisionRejected() throws Exception {
        Scope f = scope();
        mvc.perform(put(f.workspaceUrl() + "/members/" + f.target().id())
                .header("Authorization", "Bearer " + f.owner().token()).contentType("application/json")
                .content("{\"role\":\"VIEWER\"}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
        mvc.perform(get(f.workspaceUrl() + "/members").header("Authorization", "Bearer " + f.owner().token()))
                .andExpect(jsonPath("$.length()").value(1));
    }

    // Catches existing ACL writers silently accepting a missing concurrency precondition.
    @Test void aclMissingRevisionRejected() throws Exception {
        Scope f = scope();
        member(f, "VIEWER", 0).andExpect(status().isOk());
        mvc.perform(put(f.projectUrl() + "/acl").header("Authorization", "Bearer " + f.owner().token())
                .contentType("application/json").content("{\"userId\":\"" + f.target().id() + "\",\"role\":\"ADMIN\"}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
        mvc.perform(get(f.projectUrl() + "/acl").header("Authorization", "Bearer " + f.owner().token()))
                .andExpect(jsonPath("$").isEmpty());
    }

    // Two requests deliberately carry the same revision; unconditional overwrite must lose.
    @Test void sameAclRevisionHasOnlyOneWinner() throws Exception {
        Scope f = scope();
        member(f, "VIEWER", 0).andExpect(status().isOk());
        acl(f, "EDITOR", 0).andExpect(status().isOk());
        acl(f, "ADMIN", 0).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("access_revision_conflict"));
        mvc.perform(get(f.projectUrl() + "/acl").header("Authorization", "Bearer " + f.owner().token()))
                .andExpect(jsonPath("$[0].role").value("EDITOR"));
    }

    // Catches DTO numeric coercion, negative revisions and integers beyond JavaScript precision.
    @ParameterizedTest
    @ValueSource(strings = {"-1", "0.5", "\"0\"", "9007199254740992", "9223372036854775807"})
    void rejectsInvalidAclRevision(String literalRevision) throws Exception {
        Scope f = scope();
        member(f, "VIEWER", 0).andExpect(status().isOk());
        mvc.perform(put(f.projectUrl() + "/acl").header("Authorization", "Bearer " + f.owner().token())
                .contentType("application/json").content("{\"userId\":\"" + f.target().id()
                        + "\",\"role\":\"EDITOR\",\"expectedRevision\":" + literalRevision + "}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
        mvc.perform(get(f.projectUrl() + "/acl").header("Authorization", "Bearer " + f.owner().token()))
                .andExpect(jsonPath("$").isEmpty());
    }

    // The largest safe integer is a valid input that reaches CAS, not an invalid field.
    @Test void acceptsSafeIntegerBoundaryForCas() throws Exception {
        Scope f = scope();
        member(f, "VIEWER", 0).andExpect(status().isOk());
        acl(f, "EDITOR", 9007199254740991L).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("access_revision_conflict"));
    }

    // Catches member role changes ignoring their revision even though missing versions are rejected.
    @Test void sameMemberRevisionHasOnlyOneWinner() throws Exception {
        Scope f = scope();
        member(f, "EDITOR", 0).andExpect(status().isOk());
        member(f, "ADMIN", 0).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("access_revision_conflict"));
    }

    // Catches unknown control fields being silently dropped and interpreted as permission to write.
    @Test void rejectsUnknownAclMutationControl() throws Exception {
        Scope f = scope();
        member(f, "VIEWER", 0).andExpect(status().isOk());
        mvc.perform(put(f.projectUrl() + "/acl").header("Authorization", "Bearer " + f.owner().token())
                .contentType("application/json").content("{\"userId\":\"" + f.target().id()
                        + "\",\"role\":\"EDITOR\",\"expectedRevision\":0,\"force\":true}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
    }

    // The member binding must not keep a coercion bypass beside the protected ACL binding.
    @ParameterizedTest
    @ValueSource(strings = {"-1", "0.5", "\"0\"", "9007199254740992", "9223372036854775807"})
    void rejectsInvalidMemberRevision(String literalRevision) throws Exception {
        Scope f = scope();
        mvc.perform(put(f.workspaceUrl() + "/members/" + f.target().id())
                .header("Authorization", "Bearer " + f.owner().token()).contentType("application/json")
                .content("{\"role\":\"EDITOR\",\"expectedRevision\":" + literalRevision + "}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
    }

    @Test void rejectsUnknownMemberMutationControl() throws Exception {
        Scope f = scope();
        mvc.perform(put(f.workspaceUrl() + "/members/" + f.target().id())
                .header("Authorization", "Bearer " + f.owner().token()).contentType("application/json")
                .content("{\"role\":\"EDITOR\",\"expectedRevision\":0,\"force\":true}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
    }

    // Catches losing the subject's CAS identity when its membership row is deleted.
    @Test void removedMembershipCannotBeRecreatedAtRevisionZero() throws Exception {
        Scope f = scope();
        member(f, "VIEWER", 0).andExpect(status().isOk());
        mvc.perform(delete(f.workspaceUrl() + "/members/" + f.target().id()).param("expectedRevision", "1")
                .header("Authorization", "Bearer " + f.owner().token())).andExpect(status().isNoContent());
        member(f, "ADMIN", 0).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("access_revision_conflict"));
        member(f, "VIEWER", 2).andExpect(status().isOk());
    }

    // Catches delete/recreate resetting an ACL revision to the never-existing value zero.
    @Test void deletedAclCannotBeRecreatedAtRevisionZero() throws Exception {
        Scope f = scope();
        member(f, "VIEWER", 0).andExpect(status().isOk());
        acl(f, "NONE", 0).andExpect(status().isOk());
        mvc.perform(delete(f.projectUrl() + "/acl").param("userId", f.target().id()).param("expectedRevision", "1")
                .header("Authorization", "Bearer " + f.owner().token())).andExpect(status().isNoContent());
        acl(f, "ADMIN", 0).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("access_revision_conflict"));
        acl(f, "VIEWER", 2).andExpect(status().isOk());
    }

    @ParameterizedTest
    @ValueSource(strings = {"member", "acl"})
    void deleteRequiresRevision(String kind) throws Exception {
        Scope f = scope();
        member(f, "VIEWER", 0).andExpect(status().isOk());
        acl(f, "NONE", 0).andExpect(status().isOk());
        String url = kind.equals("member") ? f.workspaceUrl() + "/members/" + f.target().id() : f.projectUrl() + "/acl";
        mvc.perform(delete(url).param("userId", f.target().id()).header("Authorization", "Bearer " + f.owner().token()))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"member", "acl"})
    void staleRevisionCannotDelete(String kind) throws Exception {
        Scope f = scope();
        member(f, "VIEWER", 0).andExpect(status().isOk());
        acl(f, "NONE", 0).andExpect(status().isOk());
        String url = kind.equals("member") ? f.workspaceUrl() + "/members/" + f.target().id() : f.projectUrl() + "/acl";
        mvc.perform(delete(url).param("userId", f.target().id()).param("expectedRevision", "0")
                .header("Authorization", "Bearer " + f.owner().token()))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("access_revision_conflict"));
    }

    // POST-HOC verification of the reported DELETE numeric-domain ordering deviation, not historical RED.
    @ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource({"member,-1", "member,0.5", "member,'\"1\"'", "member,9007199254740992",
            "acl,-1", "acl,0.5", "acl,'\"1\"'", "acl,9007199254740992"})
    void postHocDeleteRejectsInvalidNumericQueries(String kind, String literalRevision) throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk()); acl(f, "NONE", 0).andExpect(status().isOk());
        String url = kind.equals("member") ? f.workspaceUrl() + "/members/" + f.target().id() : f.projectUrl() + "/acl";
        mvc.perform(delete(url).param("userId", f.target().id()).param("expectedRevision", literalRevision)
                .header("Authorization", "Bearer " + f.owner().token()))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
    }
}
