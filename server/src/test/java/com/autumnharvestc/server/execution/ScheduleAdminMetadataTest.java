package com.autumnharvestc.server.execution;

import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@TestPropertySource(properties="spring.datasource.url=jdbc:h2:mem:apicc-t7-admin;DB_CLOSE_DELAY=-1")
class ScheduleAdminMetadataTest extends ExecutionManagementFixture {
    @org.junit.jupiter.api.BeforeEach void resetPolicy(){jdbc.update("DELETE FROM execution_configs WHERE scope_type IN ('schedule-ws','schedule-project')");}
    @Test void capturesExistingControlAndWorkspaceReadAuthorities()throws Exception {
        var f=fixture();capture("t7-scheduler-control",body(mvc.perform(get("/api/v1/scheduler/control").header("Authorization","Bearer "+f.token())).andExpect(status().isOk())));
        var workspace=body(mvc.perform(get("/api/v1/workspaces/"+f.ws()+"/schedule-policy").header("Authorization","Bearer "+f.token())).andExpect(status().isOk()));
        assertThat(workspace.path("explicitByScope").path("project").isEmpty()).isTrue();capture("t7-workspace-policy",workspace);
    }
    String token(com.autumnharvestc.server.store.UserAccount user)throws Exception {
        return body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",user.username(),"password","password123")))).andExpect(status().isOk())).path("token").asText();
    }
    org.springframework.test.web.servlet.ResultActions putPolicy(String url,String token,String version,Map<String,Object> policy,List<String> reset)throws Exception {
        return mvc.perform(put(url).header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsString(Map.of("expectedVersion",version,"policy",policy,"resetKeys",reset))));
    }
    void capture(String name,com.fasterxml.jackson.databind.JsonNode value)throws Exception {
        if(!Boolean.getBoolean("apicc.captureSchedulingAdmin"))return;
        var dir=java.nio.file.Path.of("src/test/resources/scheduling");java.nio.file.Files.createDirectories(dir);
        java.nio.file.Files.writeString(dir.resolve(name+".json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(value)+"\n",java.nio.charset.StandardCharsets.UTF_8);
    }
    @Test void projectOnlyAdminReadsActualParentExplicitWithinAuthorizedProjectView()throws Exception {
        var f=fixture();var admin=member(f,"EDITOR");String token=token(admin);
        jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,?,'ADMIN',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),admin.id());
        mvc.perform(put("/api/v1/workspaces/"+f.ws()+"/schedule-policy").header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"expectedVersion\":\"0\",\"policy\":{\"minIntervalMs\":120000}}" )).andExpect(status().isOk());
        var view=body(mvc.perform(get(f.url()+"/schedule-policy").header("Authorization","Bearer "+token)).andExpect(status().isOk()));
        assertThat(view.path("explicitByScope").path("workspace").path("minIntervalMs").asLong()).isEqualTo(120000);
        assertThat(view.path("explicitByScope").path("project").isObject()).isTrue();capture("t7-project-policy",view);
        mvc.perform(get("/api/v1/workspaces/"+f.ws()+"/schedule-policy").header("Authorization","Bearer "+token)).andExpect(status().isForbidden());
    }
    @Test void explicitResetRestoresInheritanceAndKeepsOtherFieldsAndConflictAtomic()throws Exception {
        var f=fixture();String project=f.url()+"/schedule-policy",ws="/api/v1/workspaces/"+f.ws()+"/schedule-policy";
        putPolicy(project,f.token(),"0",Map.of("minIntervalMs",180000,"historyRetentionDays",10),List.of()).andExpect(status().isOk());
        putPolicy(project,f.token(),"0",Map.of("historyRetentionDays",5),List.of("minIntervalMs")).andExpect(status().isConflict());
        mvc.perform(get(project).header("Authorization","Bearer "+f.token())).andExpect(jsonPath("$.explicit.minIntervalMs").value(180000)).andExpect(jsonPath("$.explicit.historyRetentionDays").value(10));
        putPolicy(project,f.token(),"1",Map.of(),List.of("minIntervalMs","minIntervalMs")).andExpect(status().isOk()).andExpect(jsonPath("$.explicit.minIntervalMs").doesNotExist()).andExpect(jsonPath("$.explicit.historyRetentionDays").value(10));
        // Use the old request shape too: resetKeys remains optional.
        mvc.perform(put(ws).header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"expectedVersion\":\"0\",\"policy\":{\"minIntervalMs\":240000}}" )).andExpect(status().isOk());
        mvc.perform(get(project).header("Authorization","Bearer "+f.token())).andExpect(jsonPath("$.effective.minIntervalMs").value(240000)).andExpect(jsonPath("$.version").value("2"));
    }
    @Test void optionsUseEffectiveProjectRoleAndAccountStatusWithReadableMemberNames()throws Exception {
        var f=fixture();var admin=member(f,"EDITOR");var promoted=member(f,"VIEWER");var demoted=member(f,"EDITOR");var disabled=member(f,"EDITOR");var denied=member(f,"EDITOR");
        for(var item:List.of(Map.entry(admin,"ADMIN"),Map.entry(promoted,"EDITOR"),Map.entry(demoted,"VIEWER"),Map.entry(denied,"NONE")))jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),item.getKey().id(),item.getValue());
        users.setDisabled(disabled.id(),true);
        var page=body(mvc.perform(get(f.url()+"/schedule-grants/options").header("Authorization","Bearer "+token(admin))).andExpect(status().isOk()));
        var rows=new HashMap<String,com.fasterxml.jackson.databind.JsonNode>();page.path("items").forEach(row->rows.put(row.path("userId").asText(),row));
        assertThat(rows.get(promoted.id().toString()).path("eligible").asBoolean()).isTrue();
        assertThat(rows.get(promoted.id().toString()).path("displayName").asText()).isEqualTo(promoted.displayName());
        assertThat(rows.get(demoted.id().toString()).path("eligible").asBoolean()).isFalse();
        assertThat(rows.get(demoted.id().toString()).path("reasonCode").asText()).isEqualTo("editor-required");
        assertThat(rows.get(disabled.id().toString()).path("reasonCode").asText()).isEqualTo("account-disabled");
        assertThat(rows.get(denied.id().toString()).path("effectiveRole").isNull()).isTrue();assertThat(rows.get(denied.id().toString()).path("reasonCode").asText()).isEqualTo("project-access-denied");capture("t7-grant-options",page);
        capture("t7-project-grants",body(mvc.perform(get(f.url()+"/schedule-grants").header("Authorization","Bearer "+token(admin))).andExpect(status().isOk())));
    }
    com.fasterxml.jackson.databind.JsonNode option(Fixture f,String token,long userId)throws Exception {
        var page=body(mvc.perform(get(f.url()+"/schedule-grants/options").header("Authorization","Bearer "+token)).andExpect(status().isOk()));
        return java.util.stream.StreamSupport.stream(page.path("items").spliterator(),false).filter(row->row.path("userId").asText().equals(String.valueOf(userId))).findFirst().orElseThrow();
    }
    // Explicit human-accepted post-verification. These are not advertised as prior RED.
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource({"VIEWER,EDITOR,false,true,EDITOR,none","EDITOR,VIEWER,false,false,VIEWER,editor-required","EDITOR,NONE,false,false,none,project-access-denied","EDITOR,ADMIN,false,false,ADMIN,editor-required","ADMIN,inherit,false,false,ADMIN,editor-required","EDITOR,inherit,true,false,EDITOR,account-disabled","OWNER,inherit,true,false,OWNER,account-disabled","EDITOR,inherit,false,true,EDITOR,none"})
    void postVerifiesEffectiveAclAndAccountEligibility(String workspaceRole,String acl,boolean disabled,boolean eligible,String effective,String reason)throws Exception {
        var f=fixture();var target=member(f,workspaceRole);if(!acl.equals("inherit"))jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),target.id(),acl);users.setDisabled(target.id(),disabled);
        var row=option(f,f.token(),target.id());assertThat(row.path("eligible").asBoolean()).isEqualTo(eligible);assertThat(row.path("username").asText()).isEqualTo(target.username());assertThat(row.path("displayName").asText()).isEqualTo(target.displayName());
        if(effective.equals("none"))assertThat(row.path("effectiveRole").isNull()).isTrue();else assertThat(row.path("effectiveRole").asText()).isEqualTo(effective);
        if(reason.equals("none"))assertThat(row.path("reasonCode").isNull()).isTrue();else assertThat(row.path("reasonCode").asText()).isEqualTo(reason);
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"EDITOR","VIEWER","admin-demoted","platform-only","disabled"})
    void postVerifiesOptionsCallerAuthorityWithoutGlobalOrWorkspaceAclExpansion(String kind)throws Exception {
        var f=fixture();var caller=member(f,kind.equals("admin-demoted")?"ADMIN":"EDITOR");String token=token(caller);
        if(kind.equals("VIEWER"))jdbc.update("UPDATE memberships SET role='VIEWER' WHERE workspace_id=? AND user_id=?",Long.valueOf(f.ws()),caller.id());
        if(kind.equals("admin-demoted"))jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,?,'VIEWER',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),caller.id());
        if(kind.equals("platform-only")){jdbc.update("UPDATE users SET role='SUPERADMIN' WHERE id=?",caller.id());jdbc.update("DELETE FROM memberships WHERE workspace_id=? AND user_id=?",Long.valueOf(f.ws()),caller.id());}
        if(kind.equals("disabled"))users.setDisabled(caller.id(),true);
        mvc.perform(get(f.url()+"/schedule-grants/options").header("Authorization","Bearer "+token)).andExpect(kind.equals("disabled")?status().isUnauthorized():status().isForbidden());
    }
    @Test void postVerifiesProjectAndWorkspaceScopeAndExcludesNonmembers()throws Exception {
        var f=fixture();var target=member(f,"EDITOR");var outsider=member(f,"EDITOR");var otherProject=fixture();
        jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,?,'VIEWER',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),target.id());
        assertThat(option(f,f.token(),target.id()).path("eligible").asBoolean()).isFalse();assertThat(option(otherProject,f.token(),target.id()).path("eligible").asBoolean()).isTrue();
        jdbc.update("DELETE FROM memberships WHERE workspace_id=? AND user_id=?",Long.valueOf(f.ws()),outsider.id());
        var page=body(mvc.perform(get(f.url()+"/schedule-grants/options").header("Authorization","Bearer "+f.token())).andExpect(status().isOk()));assertThat(page.path("items").findValuesAsText("userId")).doesNotContain(outsider.id().toString());
        String otherWs=body(mvc.perform(post("/api/v1/workspaces").header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"name\":\"grant-other-workspace\"}")).andExpect(status().isCreated())).path("id").asText();
        mvc.perform(get("/api/v1/workspaces/"+otherWs+"/projects/"+f.project()+"/schedule-grants/options").header("Authorization","Bearer "+f.token())).andExpect(status().isNotFound());
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"[\"unknown\"]","[\"minIntervalMs\"]","null","[null]"})
    void rejectsUnknownMixedOrNullResetWithoutAdvancingVersion(String reset)throws Exception {
        var f=fixture();mvc.perform(put(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"expectedVersion\":\"0\",\"policy\":{\"minIntervalMs\":120000},\"resetKeys\":"+reset+"}"))
            .andExpect(status().isBadRequest());
        mvc.perform(get(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token())).andExpect(jsonPath("$.version").value("0")).andExpect(jsonPath("$.explicit").isEmpty());
    }
}
