package com.autumnharvestc.server.access;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AccessEpochLifecycleTest extends AccessHttpFixture {
    @Autowired JdbcTemplate jdbc;
    @Autowired com.autumnharvestc.server.store.AclRepo oldAcl;
    private ProjectAccessView decision(Scope f){return access.resolve(Long.valueOf(f.target().id()),Long.valueOf(f.workspace()),Long.valueOf(f.project()));}

    @ParameterizedTest @ValueSource(strings={"inherited","NONE","ADMIN","pending"})
    void removalInvalidatesProjectCapabilityRevisionExactlyOnce(String role) throws Exception {
        Scope f=scope();member(f,"EDITOR",0).andExpect(status().isOk());
        if(!role.equals("inherited"))acl(f,role.equals("pending")?"ADMIN":role,0).andExpect(status().isOk());
        if(role.equals("pending")) {
            mvc.perform(delete(f.workspaceUrl()+"/members/"+f.target().id()).param("expectedRevision","1").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
            member(f,"EDITOR",2).andExpect(status().isOk());
        }
        long initial=role.equals("inherited")?0:role.equals("pending")?2:1;
        mvc.perform(put(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("expectedRevision",initial,"capabilities",Map.of("publication.manage","allow","script.edit","deny")))))
                .andExpect(status().isOk());
        long oldRevision=initial+1;
        mvc.perform(delete(f.workspaceUrl()+"/members/"+f.target().id()).param("expectedRevision",role.equals("pending")?"3":"1").header("Authorization","Bearer "+f.owner().token()))
                .andExpect(status().isNoContent());
        member(f,"EDITOR",role.equals("pending")?4:2).andExpect(status().isOk());
        var view=body(mvc.perform(get(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        assertAll(
                ()->assertThat(view.get("revision").longValue()).isEqualTo(oldRevision+1),
                ()->assertThat(view.get("overrideState").asText()).isEqualTo(role.equals("ADMIN")||role.equals("pending")?"pending-confirmation":role.equals("NONE")?"active":"inherited"),
                ()->assertThat(jdbc.queryForObject("SELECT mode FROM access_member_capabilities WHERE workspace_id=? AND project_id=? AND user_id=? AND code='script.edit'",String.class,
                        Long.valueOf(f.workspace()),Long.valueOf(f.project()),Long.valueOf(f.target().id()))).isEqualTo("deny"),
                ()->mvc.perform(put(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                        .content(json.writeValueAsString(Map.of("expectedRevision",oldRevision,"capabilities",Map.of("publication.manage","allow")))))
                        .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("access_revision_conflict")));
        mvc.perform(put(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("expectedRevision",view.get("revision").longValue(),"capabilities",Map.of("publication.manage","allow")))))
                .andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT mode FROM access_member_capabilities WHERE workspace_id=? AND project_id=? AND user_id=? AND code='publication.manage'",String.class,
                Long.valueOf(f.workspace()),Long.valueOf(f.project()),Long.valueOf(f.target().id()))).isEqualTo("allow");
        if(!role.equals("inherited"))assertThat(decision(f).effectiveRole()).isEmpty();
    }

    @Test void removalAndRejoinKeepMonotonicEpochsAndNeverRestoreMemberAllow() throws Exception {
        Scope f=scope();member(f,"EDITOR",0).andExpect(status().isOk());
        mvc.perform(put(f.workspaceUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content("{\"expectedRevision\":1,\"capabilities\":{\"publication.manage\":\"allow\",\"script.edit\":\"deny\"}}"))
                .andExpect(status().isOk());
        mvc.perform(put(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content("{\"expectedRevision\":0,\"capabilities\":{\"mock.manage\":\"allow\",\"audit.read\":\"deny\"}}"))
                .andExpect(status().isOk());
        var before=decision(f);
        mvc.perform(delete(f.workspaceUrl()+"/members/"+f.target().id()).param("expectedRevision","2").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
        var removed=decision(f);
        member(f,"EDITOR",3).andExpect(status().isOk());
        var rejoined=decision(f);
        assertAll(
                ()->assertThat(removed.membershipEpoch()).isGreaterThan(before.membershipEpoch()),
                ()->assertThat(removed.responsibilityEpoch()).isGreaterThan(before.responsibilityEpoch()),
                ()->assertThat(rejoined.membershipEpoch()).isGreaterThanOrEqualTo(removed.membershipEpoch()),
                ()->assertThat(rejoined.responsibilityEpoch()).isGreaterThanOrEqualTo(removed.responsibilityEpoch()),
                ()->assertThat(rejoined.capabilities()).doesNotContain(Capability.PUBLICATION_MANAGE,Capability.MOCK_MANAGE,Capability.SCRIPT_EDIT,Capability.AUDIT_READ));
    }

    @ParameterizedTest @ValueSource(strings={"member-role","acl-role","member-capability","default-policy"})
    void losingAndRegainingPublishingQualificationCannotRestoreResponsibilityEpoch(String kind) throws Exception {
        Scope f=scope();member(f,"ADMIN",0).andExpect(status().isOk());
        var before=decision(f);
        switch(kind){
            case "member-role"->member(f,"VIEWER",1).andExpect(status().isOk());
            case "acl-role"->acl(f,"VIEWER",0).andExpect(status().isOk());
            case "member-capability"->mvc.perform(put(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                    .content("{\"expectedRevision\":0,\"capabilities\":{\"publication.manage\":\"deny\"}}" )).andExpect(status().isOk());
            default->mvc.perform(put(f.projectUrl()+"/access-policy").header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                    .content("{\"expectedRevision\":0,\"defaults\":{\"publication.manage\":\"deny\"}}" )).andExpect(status().isOk());
        }
        var lost=decision(f);
        assertThat(lost.responsibilityEpoch()).as("loss must be recorded at mutation, before any external read").isGreaterThan(before.responsibilityEpoch());
        switch(kind){
            case "member-role"->member(f,"ADMIN",2).andExpect(status().isOk());
            case "acl-role"->acl(f,"ADMIN",1).andExpect(status().isOk());
            case "member-capability"->mvc.perform(put(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                    .content("{\"expectedRevision\":1,\"capabilities\":{\"publication.manage\":\"inherit\"}}" )).andExpect(status().isOk());
            default->mvc.perform(put(f.projectUrl()+"/access-policy").header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                    .content("{\"expectedRevision\":1,\"defaults\":{\"publication.manage\":\"inherit\"}}" )).andExpect(status().isOk());
        }
        assertThat(decision(f).responsibilityEpoch()).isGreaterThanOrEqualTo(lost.responsibilityEpoch());
    }

    @Test void oldNonmemberPresetDoesNotBecomeActiveOnFirstJoin() throws Exception {
        Scope f=scope();oldAcl.upsert(Long.valueOf(f.workspace()),Long.valueOf(f.project()),Long.valueOf(f.target().id()),com.autumnharvestc.server.core.AclRole.ADMIN);
        member(f,"VIEWER",0).andExpect(status().isOk());
        assertAll(()->assets(f).andExpect(status().isForbidden()),
                ()->assertThat(decision(f).overrideState()).isEqualTo("pending-confirmation"),
                ()->assertThat(decision(f).effectiveRole()).isEmpty());
    }

    @Test void accountDisableAndEnableNeverRestoreOldEpoch() throws Exception {
        Scope f=scope();member(f,"ADMIN",0).andExpect(status().isOk());
        jdbc.update("UPDATE users SET role='SUPERADMIN' WHERE id=?",Long.valueOf(f.owner().id()));
        var before=decision(f);
        mvc.perform(post("/api/v1/admin/users/"+f.target().id()+"/disable").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":1}"))
                .andExpect(status().isNoContent());
        var stopped=decision(f);
        assertThat(stopped.responsibilityEpoch()).isGreaterThan(before.responsibilityEpoch());
        mvc.perform(post("/api/v1/admin/users/"+f.target().id()+"/enable").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":2}"))
                .andExpect(status().isNoContent());
        assertThat(decision(f).responsibilityEpoch()).isGreaterThanOrEqualTo(stopped.responsibilityEpoch());
    }

    @ParameterizedTest @ValueSource(strings={"project","workspace"})
    void actualScopeDeletionCleansNewActiveAuthority(String kind) throws Exception {
        Scope f=scope();member(f,"EDITOR",0).andExpect(status().isOk());
        mvc.perform(put(f.projectUrl()+"/access-policy").header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content("{\"expectedRevision\":0,\"defaults\":{\"task.execute\":\"deny\"}}" )).andExpect(status().isOk());
        mvc.perform(put(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content("{\"expectedRevision\":0,\"capabilities\":{\"script.edit\":\"deny\"}}" )).andExpect(status().isOk());
        jdbc.update("MERGE INTO access_project_generations(workspace_id,project_id,revision) KEY(workspace_id,project_id) VALUES(?,?,3)",Long.valueOf(f.workspace()),Long.valueOf(f.project()));
        mvc.perform(delete(kind.equals("project")?f.projectUrl():f.workspaceUrl()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
        assertAll(java.util.List.of("access_policy_scopes","access_capability_defaults","access_member_capabilities","access_project_generations").stream().map(table->
                (org.junit.jupiter.api.function.Executable)()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM "+table+" WHERE workspace_id=?"+(kind.equals("project")?" AND project_id=?":""),Integer.class,
                    kind.equals("project")?new Object[]{Long.valueOf(f.workspace()),Long.valueOf(f.project())}:new Object[]{Long.valueOf(f.workspace())}))
                    .as(table+" must not retain orphan authority").isZero()));
        if(kind.equals("workspace")) assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM access_members WHERE workspace_id=?",Integer.class,Long.valueOf(f.workspace()))).isZero();
    }

    @Test void workspaceDeletionAlsoCleansPersistentMemberIdentity() throws Exception {
        Scope f=scope();member(f,"EDITOR",0).andExpect(status().isOk());
        mvc.perform(delete(f.workspaceUrl()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM access_members WHERE workspace_id=?",Integer.class,Long.valueOf(f.workspace()))).isZero();
    }

    @Test void accountStopPreservesMembershipAclAndMemberAllowButInvalidatesResponsibility() throws Exception {
        Scope f=scope();member(f,"EDITOR",0).andExpect(status().isOk());acl(f,"ADMIN",0).andExpect(status().isOk());
        jdbc.update("UPDATE users SET role='SUPERADMIN' WHERE id=?",Long.valueOf(f.owner().id()));
        mvc.perform(put(f.workspaceUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content("{\"expectedRevision\":1,\"capabilities\":{\"publication.manage\":\"allow\"}}" )).andExpect(status().isOk());
        var before=decision(f);
        mvc.perform(post("/api/v1/admin/users/"+f.target().id()+"/disable").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":1}"))
                .andExpect(status().isNoContent());
        var stopped=decision(f);
        assertAll(
                ()->assertThat(stopped.responsibilityEpoch()).isGreaterThan(before.responsibilityEpoch()),
                ()->assertThat(stopped.membershipEpoch()).isEqualTo(before.membershipEpoch()),
                ()->assertThat(stopped.workspaceRole()).contains(com.autumnharvestc.server.core.Role.EDITOR),
                ()->assertThat(stopped.projectOverride()).contains(com.autumnharvestc.server.core.AclRole.ADMIN),
                ()->assertThat(stopped.overrideState()).isEqualTo("active"),
                ()->assertThat(jdbc.queryForObject("SELECT mode FROM access_member_capabilities WHERE workspace_id=? AND project_id=0 AND user_id=? AND code='publication.manage'",String.class,
                        Long.valueOf(f.workspace()),Long.valueOf(f.target().id()))).isEqualTo("allow"));
    }

    @ParameterizedTest @ValueSource(strings={"workspace","project"})
    void qualificationLossAndRegainBetweenReadsStillAdvancesEpoch(String scope) throws Exception {
        Scope f=scope();member(f,"ADMIN",0).andExpect(status().isOk());var before=decision(f);
        String prefix=scope.equals("workspace")?f.workspaceUrl():f.projectUrl();
        mvc.perform(put(prefix+"/access-policy").header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content("{\"expectedRevision\":0,\"defaults\":{\"history.read\":\"deny\"}}" )).andExpect(status().isOk());
        mvc.perform(put(prefix+"/access-policy").header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content("{\"expectedRevision\":1,\"defaults\":{\"history.read\":\"inherit\"}}" )).andExpect(status().isOk());
        assertThat(decision(f).responsibilityEpoch()).isGreaterThan(before.responsibilityEpoch());
    }

    @ParameterizedTest @ValueSource(strings={"script.edit","credential.manage","task.execute","audit.read","mock.logs.read"})
    void independentCapabilityLossDoesNotChangePublishingEpoch(String code) throws Exception {
        Scope f=scope();member(f,"ADMIN",0).andExpect(status().isOk());var before=decision(f);
        mvc.perform(put(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("expectedRevision",0,"capabilities",Map.of(code,"deny"))))).andExpect(status().isOk());
        assertThat(decision(f).responsibilityEpoch()).isEqualTo(before.responsibilityEpoch());
    }
}
