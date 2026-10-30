package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.execution.policy.ScriptGrantService;
import com.autumnharvestc.server.store.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AgentManagementApiTest extends ExecutionManagementFixture {
    @Autowired AgentService agents;
    @Autowired ScriptGrantService scripts;
    @Autowired com.autumnharvestc.server.execution.config.ExecutionConfigService configs;
    @Autowired com.autumnharvestc.server.execution.agent.AgentAuthFilter agentFilter;
    @Autowired com.autumnharvestc.server.auth.TokenService tokens;

    @Test void platformWorkspaceDirectoryIncludesNonMemberWorkspaceWithoutChangingMembership() throws Exception {
        var f=fixture();var member=member(f,"ADMIN");
        String memberToken=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",member.username(),"password","password123")))).andExpect(status().isOk())).get("token").asText();
        String name="directory-"+UUID.randomUUID();
        String other=body(mvc.perform(post("/api/v1/workspaces").header("Authorization","Bearer "+memberToken).contentType("application/json").content(json.writeValueAsString(Map.of("name",name)))).andExpect(status().isCreated())).get("id").asText();
        var directory=body(mvc.perform(get("/api/v1/agents/workspace-directory").header("Authorization","Bearer "+f.token())).andExpect(status().isOk()));
        assertThat(directory.findValuesAsText("id")).contains(other);
        assertThat(directory.findValuesAsText("name")).contains(name);
        for(var row:directory)assertThat(row.size()).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM memberships WHERE workspace_id=? AND user_id=?",Integer.class,Long.valueOf(other),f.admin().id())).isZero();
        mvc.perform(get("/api/v1/agents/workspace-directory").header("Authorization","Bearer "+memberToken)).andExpect(status().isForbidden());
        var participating=body(mvc.perform(get("/api/v1/workspaces").header("Authorization","Bearer "+f.token())).andExpect(status().isOk()));
        assertThat(participating.findValuesAsText("id")).doesNotContain(other);
    }

    @Test void platformNodeShowsActualRuntimeAndConfigurationApplicationSeparately() throws Exception {
        var f=fixture();
        mvc.perform(get("/api/v1/agents/"+f.agent()).header("Authorization","Bearer "+f.token()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.availability").value("runtime-missing"))
            .andExpect(jsonPath("$.runtime").doesNotExist()).andExpect(jsonPath("$.appliedConfigVersion").value("0"));
    }

    // Project administration may read its allocated pool, but never a workspace/global pool.
    @Test void projectAdminReadsOnlyAllocatedCandidatesAndWorkspaceAdminReadsAllocation() throws Exception {
        var f=fixture();var manager=member(f,"EDITOR");
        jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,?,'ADMIN',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),manager.id());
        agents.grantWorkspaces(f.admin(),f.agent(),List.of(f.ws()));agents.allocate(f.admin(),f.ws(),f.agent(),List.of(f.project()));
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",manager.username(),"password","password123")))).andExpect(status().isOk())).get("token").asText();
        mvc.perform(get(f.url()+"/agent-candidates").header("Authorization","Bearer "+token)).andExpect(status().isOk()).andExpect(jsonPath("$[0].id").value(f.agent())).andExpect(jsonPath("$.length()").value(1));
        mvc.perform(get("/api/v1/workspaces/"+f.ws()+"/agent-project-allocations").param("agentId",f.agent()).header("Authorization","Bearer "+f.token())).andExpect(status().isOk()).andExpect(jsonPath("$.projectIds[0]").value(f.project()));
        mvc.perform(get("/api/v1/workspaces/"+f.ws()+"/agent-project-allocations").param("agentId",f.agent()).header("Authorization","Bearer "+token)).andExpect(status().isForbidden());
        mvc.perform(get("/api/v1/workspaces/"+f.ws()+"/available-agents").header("Authorization","Bearer "+token)).andExpect(status().isForbidden());
        mvc.perform(patch("/api/v1/agents/"+f.agent()).header("Authorization","Bearer "+token).contentType("application/json").content("{\"expectedVersion\":\"0\",\"config\":{\"maxConcurrentJobs\":2}}" )).andExpect(status().isForbidden());
        jdbc.update("DELETE FROM execution_agent_workspace_grants WHERE agent_id=? AND workspace_id=?",Long.valueOf(f.agent()),Long.valueOf(f.ws()));
        mvc.perform(get(f.url()+"/agent-candidates").header("Authorization","Bearer "+token)).andExpect(status().isOk()).andExpect(jsonPath("$").isEmpty());
        jdbc.update("UPDATE project_acl SET role='VIEWER' WHERE project_id=? AND user_id=?",Long.valueOf(f.project()),manager.id());
        mvc.perform(get(f.url()+"/agent-candidates").header("Authorization","Bearer "+token)).andExpect(status().isForbidden());
    }

    @Test void projectExecutorSeesOnlyAssignedRuntimeFactsWithoutPlatformAuthority() throws Exception {
        var f=fixture();var executor=member(f,"EDITOR");
        agents.grantWorkspaces(f.admin(),f.agent(),List.of(f.ws()));agents.allocate(f.admin(),f.ws(),f.agent(),List.of(f.project()));agents.associate(f.admin(),f.ws(),f.project(),List.of(f.agent()),f.agent());
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",executor.username(),"password","password123")))).andExpect(status().isOk())).get("token").asText();
        mvc.perform(get(f.url()+"/execution-agents").header("Authorization","Bearer "+token))
            .andExpect(status().isOk()).andExpect(jsonPath("$.agents[0].id").value(f.agent()))
            .andExpect(jsonPath("$.agents[0].availability").value("runtime-missing"))
            .andExpect(jsonPath("$.agents[0].runtime").doesNotExist()).andExpect(jsonPath("$.policy.scriptTimeoutMs").value(3000));
        mvc.perform(get("/api/v1/agents").header("Authorization","Bearer "+token)).andExpect(status().isForbidden());
        jdbc.update("DELETE FROM execution_agent_project_allocations WHERE agent_id=? AND project_id=?",Long.valueOf(f.agent()),Long.valueOf(f.project()));
        mvc.perform(get(f.url()+"/execution-agents").header("Authorization","Bearer "+token)).andExpect(status().isOk()).andExpect(jsonPath("$.agents").isEmpty());
        jdbc.update("DELETE FROM memberships WHERE workspace_id=? AND user_id=?",Long.valueOf(f.ws()),executor.id());
        mvc.perform(get(f.url()+"/execution-agents").header("Authorization","Bearer "+token)).andExpect(status().isForbidden());
    }

    // Missing pool enforcement would let a workspace administrator grant an unapproved node.
    @Test void workspaceAdminCannotAllocateAnAgentOutsideGrantedPool() throws Exception {
        var f=fixture(); var member=member(f,"ADMIN");
        assertThatThrownBy(() -> agents.allocate(member,f.ws(),f.agent(),List.of(f.project())))
            .isInstanceOf(ApiException.class).hasMessageContaining("授权");
    }
    // An old project ACL must not restore rights after workspace membership is removed.
    @Test void removedMemberCannotAllocateThroughStaleProjectAcl() throws Exception {
        var f=fixture(); var member=member(f,"ADMIN");
        jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,?,'ADMIN',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),member.id());
        jdbc.update("DELETE FROM memberships WHERE workspace_id=? AND user_id=?",Long.valueOf(f.ws()),member.id());
        assertThatThrownBy(() -> agents.allocate(member,f.ws(),f.agent(),List.of(f.project())))
            .isInstanceOf(ApiException.class).hasMessageContaining("成员");
    }
    // A nonempty dependency list must never receive admission from an unconfigured node.
    @Test void scriptsRequireNodeCapabilityAndProjectApproval() throws Exception {
        var f=fixture();
        assertThatThrownBy(() -> scripts.authorize(f.agent(),f.ws(),f.project(),List.of(new ScriptGrantService.ScriptRequirement("before-request","a".repeat(64)))))
            .isInstanceOf(ApiException.class);
    }
    @Test void approvalCoversOnlyExactContentAndRevocationBlocksNewAdmission() throws Exception {
        var f=fixture();
        agents.grantWorkspaces(f.admin(),f.agent(),List.of(f.ws()));
        agents.allocate(f.admin(),f.ws(),f.agent(),List.of(f.project()));
        agents.associate(f.admin(),f.ws(),f.project(),List.of(f.agent()),f.agent());
        configs.saveAgent(f.admin(),f.agent(),"0",Map.of("scriptMode","trusted-core"));
        var approved=new ScriptGrantService.ScriptRequirement("before-request","a".repeat(64));
        scripts.replace(f.admin(),f.ws(),f.project(),f.agent(),"0","script-version",List.of(approved),false);
        assertThatCode(() -> scripts.authorize(f.agent(),f.ws(),f.project(),List.of(approved))).doesNotThrowAnyException();
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            softly.assertThatThrownBy(() -> scripts.authorize(f.agent(),f.ws(),f.project(),List.of(new ScriptGrantService.ScriptRequirement("before-request","b".repeat(64))))).isInstanceOf(ApiException.class);
            scripts.replace(f.admin(),f.ws(),f.project(),f.agent(),"1","script-version",List.of(),false);
            softly.assertThatThrownBy(() -> scripts.authorize(f.agent(),f.ws(),f.project(),List.of(approved))).isInstanceOf(ApiException.class);
        });
        assertThat(scripts.authorize(f.agent(),f.ws(),f.project(),List.of())).isNull();
        scripts.replace(f.admin(),f.ws(),f.project(),f.agent(),"2","project",List.of(),true);
        assertThat(scripts.authorize(f.agent(),f.ws(),f.project(),List.of(new ScriptGrantService.ScriptRequirement("future-script","c".repeat(64))))).isEqualTo("3");
        configs.saveAgent(f.admin(),f.agent(),"1",Map.of("scriptMode","deny"));
        assertThatThrownBy(() -> scripts.authorize(f.agent(),f.ws(),f.project(),List.of(approved))).isInstanceOfSatisfying(ApiException.class,e->assertThat(e.getCode()).isEqualTo("script_mode_denied"));
        String second=String.valueOf(agents.create(f.admin(),"second approval target").id());
        agents.grantWorkspaces(f.admin(),second,List.of(f.ws()));
        agents.allocate(f.admin(),f.ws(),second,List.of(f.project()));
        agents.associate(f.admin(),f.ws(),f.project(),List.of(f.agent(),second),f.agent());
        scripts.replace(f.admin(),f.ws(),f.project(),second,"0","script-version",List.of(approved),false);
        scripts.replace(f.admin(),f.ws(),f.project(),second,"1","script-version",List.of(),false);
        var history=jdbc.queryForList("SELECT * FROM execution_management_audit WHERE scope_type='project' AND scope_id=? AND action LIKE 'script-grant.%' ORDER BY id",Long.valueOf(f.project()));
        assertThat(history).hasSize(5);
        assertThat(history.stream().map(row->row.get("agent_id")).toList()).containsExactly(Long.valueOf(f.agent()),Long.valueOf(f.agent()),Long.valueOf(f.agent()),Long.valueOf(second),Long.valueOf(second));
        assertThat(history.stream().map(row->((Number)row.get("scope_id")).longValue()).toList()).containsOnly(Long.valueOf(f.project()));
        assertThat(history.stream().map(row->((Number)row.get("actor_id")).longValue()).toList()).containsOnly(f.admin().id());
        assertThat(history.stream().map(row->((Number)row.get("version")).longValue()).toList()).containsExactly(1L,2L,3L,1L,2L);
        assertThat(history.stream().map(row->row.get("action")).toList()).containsExactly("script-grant.replace","script-grant.revoke","script-grant.replace","script-grant.replace","script-grant.revoke");
    }
    @Test void editorCannotApproveAndWholeProjectTrustRequiresExplicitRiskConfirmation() throws Exception {
        var f=fixture(); var editor=member(f,"EDITOR");
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            softly.assertThatThrownBy(() -> scripts.replace(editor,f.ws(),f.project(),f.agent(),"0","script-version",List.of(),false)).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> scripts.replace(f.admin(),f.ws(),f.project(),f.agent(),"0","project",List.of(),false)).isInstanceOf(ApiException.class);
        });
    }
    @Test void enrollmentIsSingleUseAndIssuedIdentityIsSeparateFromMembers() throws Exception {
        var f=fixture();String enrollment="valid-enrollment-"+f.agent();
        jdbc.update("INSERT INTO execution_agent_enrollments(token_hash,agent_id,created_by,expires_at) VALUES (?,?,?,DATEADD('HOUR',1,CURRENT_TIMESTAMP))",tokens.sha256Hex(enrollment),Long.valueOf(f.agent()),f.admin().id());
        var enrolled=body(mvc.perform(post("/api/v1/runner/enroll").contentType("application/json").content(json.writeValueAsString(Map.of("enrollmentToken",enrollment))))
            .andExpect(status().isCreated()).andExpect(jsonPath("$.agentId").value(f.agent())).andExpect(jsonPath("$.agentToken").isString()));
        mvc.perform(post("/api/v1/runner/enroll").contentType("application/json").content(json.writeValueAsString(Map.of("enrollmentToken",enrollment)))).andExpect(status().isUnauthorized());
        String identity=enrolled.get("agentToken").asText();
        assertThat(jdbc.queryForObject("SELECT identity_hash FROM execution_agents WHERE id=?",String.class,Long.valueOf(f.agent()))).isEqualTo(tokens.sha256Hex(identity)).isNotEqualTo(identity);
        mvc.perform(get("/api/v1/auth/me").header("Authorization","Bearer "+identity)).andExpect(status().isUnauthorized());
        agents.patch(f.admin(),f.agent(),null,false);
        var request=new org.springframework.mock.web.MockHttpServletRequest("POST","/api/v1/runner/poll");request.addHeader("Authorization","Bearer "+identity);
        var response=new org.springframework.mock.web.MockHttpServletResponse();var principal=new java.util.concurrent.atomic.AtomicReference<Object>();
        agentFilter.doFilter(request,response,(r,s)->principal.set(r.getAttribute(com.autumnharvestc.server.execution.agent.AgentPrincipal.ATTRIBUTE)));
        assertThat(principal.get()).isEqualTo(new com.autumnharvestc.server.execution.agent.AgentPrincipal(Long.parseLong(f.agent())));
        agents.revoke(f.admin(),f.agent());
        var rejected=new org.springframework.mock.web.MockHttpServletResponse();var called=new java.util.concurrent.atomic.AtomicBoolean();
        agentFilter.doFilter(request,rejected,(r,s)->called.set(true));assertThat(rejected.getStatus()).isEqualTo(401);assertThat(called.get()).isFalse();
    }
    @Test void platformEnrollmentIssuanceMustReturnOnlyOneTimeMaterial() throws Exception {
        var f=fixture();mvc.perform(post("/api/v1/agents/"+f.agent()+"/enrollments").header("Authorization","Bearer "+f.token()))
            .andExpect(status().isCreated()).andExpect(jsonPath("$.enrollmentToken").isString()).andExpect(jsonPath("$.expiresAt").isString());
    }
    @Test void runnerFilterRejectsMemberTokensAndUnknownPathsWithoutAgentIdentity() throws Exception {
        var f=fixture();
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            for(String path:List.of("/api/v1/runner/poll","/api/v1/runner/not-a-route")) {
                var request=new org.springframework.mock.web.MockHttpServletRequest("POST",path);request.addHeader("Authorization","Bearer "+f.token());
                var response=new org.springframework.mock.web.MockHttpServletResponse();var called=new java.util.concurrent.atomic.AtomicBoolean();
                try {agentFilter.doFilter(request,response,(r,s)->called.set(true));}catch(Exception ex){throw new RuntimeException(ex);}
                softly.assertThat(response.getStatus()).isEqualTo(401);softly.assertThat(called.get()).isFalse();
            }
        });
    }
    @Test void invalidEnrollmentCannotUseMemberAuthenticationAsRegistrationMaterial() throws Exception {
        var f=fixture();mvc.perform(post("/api/v1/runner/enroll").header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"enrollmentToken\":\"invalid\"}"))
            .andExpect(status().isUnauthorized());
    }
    @Test void consumedExpiredAndRevokedEnrollmentMaterialsCannotCreateIdentity() throws Exception {
        var f=fixture();String used="used-"+f.agent(),expired="expired-"+f.agent(),revoked="revoked-"+f.agent();
        jdbc.update("INSERT INTO execution_agent_enrollments(token_hash,agent_id,created_by,expires_at,used_at) VALUES (?,?,?,DATEADD('HOUR',1,CURRENT_TIMESTAMP),CURRENT_TIMESTAMP)",tokens.sha256Hex(used),Long.valueOf(f.agent()),f.admin().id());
        jdbc.update("INSERT INTO execution_agent_enrollments(token_hash,agent_id,created_by,expires_at) VALUES (?,?,?,DATEADD('HOUR',-1,CURRENT_TIMESTAMP))",tokens.sha256Hex(expired),Long.valueOf(f.agent()),f.admin().id());
        jdbc.update("INSERT INTO execution_agent_enrollments(token_hash,agent_id,created_by,expires_at) VALUES (?,?,?,DATEADD('HOUR',1,CURRENT_TIMESTAMP))",tokens.sha256Hex(revoked),Long.valueOf(f.agent()),f.admin().id());
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            softly.assertThatThrownBy(() -> agents.enroll(used)).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> agents.enroll(expired)).isInstanceOf(ApiException.class);
            jdbc.update("UPDATE execution_agents SET revoked=TRUE WHERE id=?",Long.valueOf(f.agent()));
            softly.assertThatThrownBy(() -> agents.enroll(revoked)).isInstanceOf(ApiException.class);
        });
    }
    @Test void secondExchangeOfSameValidEnrollmentMustBeRejected() throws Exception {
        var f=fixture();String enrollment="replay-"+f.agent();
        jdbc.update("INSERT INTO execution_agent_enrollments(token_hash,agent_id,created_by,expires_at) VALUES (?,?,?,DATEADD('HOUR',1,CURRENT_TIMESTAMP))",tokens.sha256Hex(enrollment),Long.valueOf(f.agent()),f.admin().id());
        agents.enroll(enrollment);
        assertThatThrownBy(() -> agents.enroll(enrollment)).isInstanceOf(ApiException.class);
    }
    @Test void admissionBindsTrustedPreparedScriptsToFixedSnapshotFilesAndDigest() throws Exception {
        var f=fixture();agents.grantWorkspaces(f.admin(),f.agent(),List.of(f.ws()));agents.allocate(f.admin(),f.ws(),f.agent(),List.of(f.project()));agents.associate(f.admin(),f.ws(),f.project(),List.of(f.agent()),f.agent());
        configs.saveAgent(f.admin(),f.agent(),"0",Map.of("scriptMode","trusted-core"));scripts.replace(f.admin(),f.ws(),f.project(),f.agent(),"0","script-version",List.of(new ScriptGrantService.ScriptRequirement("before-request","a".repeat(64))),false);
        var file=new ExecutionDtos.AssetFile("project.yaml","a","1","ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",1);
        var assets=new ExecutionDtos.ProjectAssets(f.ws(),"1",f.project(),"contract-files-v1","00000000-0000-4000-8000-000000000018","1","b".repeat(64),List.of(file));
        var fixed=new ExecutionDtos.ExecutionSnapshot("1",f.admin().id().toString(),assets);
        var actual=new ScriptGrantService.PreparedScriptRequirement("before-request","a".repeat(64),new ScriptGrantService.ScriptSource("project.yaml",file.hash()),"pre");
        assertThat(scripts.authorizePrepared(f.admin(),f.agent(),fixed,List.of(actual),"ba478aee3d256f46eda3409da42731ad770a7b207fda9e52b1a671a88d251370")).isEqualTo("1");
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            softly.assertThatThrownBy(() -> scripts.authorizePrepared(f.admin(),f.agent(),fixed,List.of(actual),"c".repeat(64))).isInstanceOf(ApiException.class);
            var changed=new ScriptGrantService.PreparedScriptRequirement("before-request","a".repeat(64),new ScriptGrantService.ScriptSource("project.yaml","c".repeat(64)),"pre");
            softly.assertThatThrownBy(() -> scripts.authorizePrepared(f.admin(),f.agent(),fixed,List.of(changed),"ba478aee3d256f46eda3409da42731ad770a7b207fda9e52b1a671a88d251370")).isInstanceOf(ApiException.class);
        });
    }
    @Test void managementApiPersistsScopedAssociationsConfigAndScriptVersions() throws Exception {
        var f=fixture();String node=body(mvc.perform(post("/api/v1/agents").header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"name\":\"API node\"}")).andExpect(status().isCreated()).andExpect(jsonPath("$.id").isString())).get("id").asText();
        mvc.perform(put("/api/v1/agents/"+node+"/workspace-grants").header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(Map.of("workspaceIds",List.of(f.ws()))))).andExpect(status().isOk());
        mvc.perform(put("/api/v1/workspaces/"+f.ws()+"/agent-project-allocations").header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(Map.of("agentId",node,"projectIds",List.of(f.project()))))).andExpect(status().isOk());
        mvc.perform(put(f.url()+"/execution-settings").header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(Map.of("expectedVersion","0","agentIds",List.of(node),"defaultAgentId",node,"policy",Map.of("queueTimeoutMs",1000)))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.defaultAgentId").value(node)).andExpect(jsonPath("$.configVersion").value("1")).andExpect(jsonPath("$.policy.queueTimeoutMs").value(1000));
        mvc.perform(patch("/api/v1/agents/"+node).header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"expectedVersion\":\"0\",\"config\":{\"maxConcurrentJobs\":2}}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.config.maxConcurrentJobs").value(2)).andExpect(jsonPath("$.appliedConfigVersion").value("0"));
        mvc.perform(put(f.url()+"/script-grants").header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(Map.of("agentId",node,"expectedVersion","0","scope","project","scripts",List.of(),"riskConfirmed",true))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.version").value("1")).andExpect(jsonPath("$.grantedByUserId").value(f.admin().id().toString()));
        mvc.perform(patch("/api/v1/agents/"+node).header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"expectedVersion\":1,\"config\":{\"maxConcurrentJobs\":3}}"))
            .andExpect(status().isBadRequest());
        mvc.perform(patch("/api/v1/agents/"+node).header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"expectedVersion\":\"1\",\"config\":{\"maxConcurrentJobs\":\"3\"}}"))
            .andExpect(status().isBadRequest());
    }
}

@SpringBootTest
@AutoConfigureMockMvc(print=org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-execution-management-test;DB_CLOSE_DELAY=-1","apicc.server.allow-registration=true","apicc.server.admin-username=admin","apicc.server.admin-password=admin-pass-2026"})
abstract class ExecutionManagementFixture {
    @org.springframework.test.context.bean.override.mockito.MockitoBean com.autumnharvestc.server.execution.scheduling.EmbeddedScheduleTimer scheduleTimer;
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepo users;
    record Fixture(String token,UserAccount admin,String ws,String project,String agent) { String url(){return "/api/v1/workspaces/"+ws+"/projects/"+project;} }
    JsonNode body(ResultActions r) throws Exception { return json.readTree(r.andReturn().getResponse().getContentAsString()); }
    Fixture fixture() throws Exception {
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content("{\"username\":\"admin\",\"password\":\"admin-pass-2026\"}")).andExpect(status().isOk())).get("token").asText();
        String ws=body(mvc.perform(get("/api/v1/connect").header("Authorization","Bearer "+token)).andExpect(status().isOk())).get("workspaceId").asText();
        String group=body(mvc.perform(get("/api/v1/workspaces/"+ws+"/groups").header("Authorization","Bearer "+token)).andExpect(status().isOk())).get(0).get("id").asText();
        String project=body(mvc.perform(post("/api/v1/workspaces/"+ws+"/projects").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsString(Map.of("groupId",group,"name","execution management")))).andExpect(status().isCreated())).get("id").asText();
        var keys=new org.springframework.jdbc.support.GeneratedKeyHolder();
        jdbc.update(con -> { var s=con.prepareStatement("INSERT INTO execution_agents(name) VALUES (?)",new String[]{"id"}); s.setString(1,"fixture node"); return s; },keys);
        return new Fixture(token,users.findByUsername("admin").orElseThrow(),ws,project,keys.getKey().toString());
    }
    UserAccount member(Fixture f,String role) throws Exception {
        String name="m-"+UUID.randomUUID().toString().substring(0,15);
        body(mvc.perform(post("/api/v1/auth/register").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123","displayName",name)))).andExpect(status().isCreated()));
        var user=users.findByUsername(name).orElseThrow();
        jdbc.update("INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),user.id(),role);
        return user;
    }
}
