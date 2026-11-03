package com.autumnharvestc.server.access;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AccessAdminStateTest extends AccessHttpFixture {
    @Autowired JdbcTemplate jdbc;
    void promote(Scope f) { jdbc.update("UPDATE users SET role='SUPERADMIN' WHERE id=?",Long.valueOf(f.owner().id())); }

    @Test void adminMembershipUsesSharedCasAndSafeRevisionRead() throws Exception {
        Scope f=scope();promote(f);member(f,"EDITOR",0).andExpect(status().isOk());
        mvc.perform(put("/api/v1/admin/users/"+f.target().id()+"/workspace-role").header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content("{\"workspaceId\":\""+f.workspace()+"\",\"role\":\"ADMIN\",\"expectedRevision\":0}"))
                .andExpect(status().isConflict());
    }

    @Test void adminWorkspaceRoleReadReturnsSharedRevisionAndTombstone() throws Exception {
        Scope f=scope();promote(f);member(f,"EDITOR",0).andExpect(status().isOk());
        mvc.perform(get("/api/v1/admin/users/"+f.target().id()+"/workspace-role").param("workspaceId",f.workspace())
                .header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()).andExpect(jsonPath("$.revision").value(1));
        mvc.perform(delete(f.workspaceUrl()+"/members/"+f.target().id()).param("expectedRevision","1").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
        mvc.perform(get("/api/v1/admin/users/"+f.target().id()+"/workspace-role").param("workspaceId",f.workspace())
                .header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()).andExpect(jsonPath("$.role").isEmpty()).andExpect(jsonPath("$.revision").value(2));
    }

    @Test void adminWorkspaceRoleReadRequiresCurrentSuperadminBeforeTargetDetails() throws Exception {
        Scope f=scope();
        mvc.perform(get("/api/v1/admin/users/99999999/workspace-role").param("workspaceId",f.workspace())
                .header("Authorization","Bearer "+f.owner().token())).andExpect(status().isForbidden());
    }

    @ParameterizedTest @ValueSource(strings={"workspace-role","disable","enable"})
    void eachAdminMutationHasStrictVersionAndUnknownFieldProtection(String endpoint) throws Exception {
        Scope f=scope();promote(f);
        String url="/api/v1/admin/users/"+f.target().id()+"/"+endpoint;
        var invalid=new java.util.ArrayList<String>();
        String extra=endpoint.equals("workspace-role")?",\"workspaceId\":\""+f.workspace()+"\",\"role\":\"VIEWER\"":"";
        invalid.add("{"+(extra.isEmpty()?"":extra.substring(1))+"}");
        for(String literal:java.util.List.of("-1","0.5","\"0\"","9007199254740992")) invalid.add("{\"expectedRevision\":"+literal+extra+"}");
        invalid.add("{\"expectedRevision\":1,\"force\":true"+extra+"}");
        assertAll(invalid.stream().map(payload->(org.junit.jupiter.api.function.Executable)()-> {
            var request=endpoint.equals("workspace-role")?put(url):post(url);
            mvc.perform(request.header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(payload))
                    .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
        }));
    }

    @Test void accountStateRevisionStartsAtOneAndCannotBeReused() throws Exception {
        Scope f=scope();promote(f);
        mvc.perform(get("/api/v1/admin/users").header("Authorization","Bearer "+f.owner().token()))
                .andExpect(status().isOk()).andExpect(jsonPath("$[?(@.id=='"+f.target().id()+"')].revision",org.hamcrest.Matchers.hasItem(1)));
        mvc.perform(post("/api/v1/admin/users/"+f.target().id()+"/disable").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":1}"))
                .andExpect(status().isNoContent());
        mvc.perform(post("/api/v1/admin/users/"+f.target().id()+"/enable").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":1}"))
                .andExpect(status().isConflict());
    }

    @Test void staleAccountRevisionCannotReenableOrReviveToken() throws Exception {
        Scope f=scope();promote(f);
        mvc.perform(post("/api/v1/admin/users/"+f.target().id()+"/disable").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":1}"))
                .andExpect(status().isNoContent());
        mvc.perform(post("/api/v1/admin/users/"+f.target().id()+"/enable").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":1}"))
                .andExpect(status().isConflict());
        mvc.perform(get("/api/v1/me").header("Authorization","Bearer "+f.target().token())).andExpect(status().isUnauthorized());
    }

    @Test void adminWorkspaceRoleReadObservesRemovedSubjectRevisionIndependently() throws Exception {
        Scope f=scope();promote(f);member(f,"EDITOR",0).andExpect(status().isOk());
        mvc.perform(delete(f.workspaceUrl()+"/members/"+f.target().id()).param("expectedRevision","1").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
        mvc.perform(get("/api/v1/admin/users/"+f.target().id()+"/workspace-role").param("workspaceId",f.workspace())
                .header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()).andExpect(jsonPath("$.revision").value(2));
    }

    @Test void createdAdminUserExposesInitialAccountStateRevision() throws Exception {
        Scope f=scope();promote(f);
        mvc.perform(post("/api/v1/admin/users").header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content("{\"username\":\"revision-user-"+f.workspace()+"\",\"displayName\":\"revision user\",\"password\":\"password123\"}"))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.revision").value(1));
    }

    @ParameterizedTest @ValueSource(strings={"disable","enable"})
    void adminStateWriteRequiresBody(String operation) throws Exception {
        Scope f=scope();promote(f);
        mvc.perform(post("/api/v1/admin/users/"+f.target().id()+"/"+operation).header("Authorization","Bearer "+f.owner().token()))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
    }

    @Test void adminRoleReadChecksAuthorityBeforeMalformedTarget() throws Exception {
        Scope f=scope();
        mvc.perform(get("/api/v1/admin/users/not-an-id/workspace-role").param("workspaceId",f.workspace())
                .header("Authorization","Bearer "+f.owner().token())).andExpect(status().isForbidden());
    }

    @Autowired com.autumnharvestc.server.admin.AdminService admin;
    @Autowired com.autumnharvestc.server.store.UserRepo users;
    @Test void persistedPlatformDemotionInvalidatesPreviouslyLoadedAdminIdentity() throws Exception {
        Scope f=scope();promote(f);var stale=users.findById(Long.valueOf(f.owner().id())).orElseThrow();
        jdbc.update("UPDATE users SET role='USER' WHERE id=?",stale.id());
        org.assertj.core.api.Assertions.assertThatThrownBy(()->admin.setWorkspaceRole(stale,f.target().id(),f.workspace(),"VIEWER",0))
                .isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getStatus().value()).isEqualTo(403));
    }
}
