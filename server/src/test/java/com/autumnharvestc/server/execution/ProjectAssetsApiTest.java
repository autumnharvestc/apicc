package com.autumnharvestc.server.execution;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import java.util.Map;
import java.util.List;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc(print = org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
@TestPropertySource(properties = {
    "spring.datasource.url=jdbc:h2:mem:apicc-project-assets-test;DB_CLOSE_DELAY=-1",
    "apicc.server.allow-registration=true",
    "apicc.server.admin-username=admin", "apicc.server.admin-password=admin-pass-2026"
    ,"apicc.execution.policy.max-asset-change-files=3", "apicc.execution.policy.snapshot-bytes=128"
})
class ProjectAssetsApiTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired com.autumnharvestc.server.execution.assets.ExecutionSnapshotRepo snapshots;
    @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Autowired com.autumnharvestc.server.store.FileVersionRepo fileVersions;
    @Autowired com.autumnharvestc.server.store.ProjectRepo projects;
    @Autowired org.springframework.transaction.PlatformTransactionManager transactions;
    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean
    com.autumnharvestc.server.core.PermissionService observedPermissions;
    record Fixture(String token, String ws, String project, String second) {
        String url() { return "/api/v1/workspaces/"+ws+"/projects/"+project; }
    }
    JsonNode body(ResultActions result) throws Exception {
        return json.readTree(result.andReturn().getResponse().getContentAsString());
    }
    Fixture fixture() throws Exception {
        String token = body(mvc.perform(post("/api/v1/auth/login").contentType("application/json")
            .content("{\"username\":\"admin\",\"password\":\"admin-pass-2026\"}")).andExpect(status().isOk())).get("token").asText();
        String ws = body(mvc.perform(get("/api/v1/connect").header("Authorization", "Bearer "+token)).andExpect(status().isOk())).get("workspaceId").asText();
        String group = body(mvc.perform(get("/api/v1/workspaces/"+ws+"/groups").header("Authorization", "Bearer "+token)).andExpect(status().isOk())).get(0).get("id").asText();
        String project = create(token, ws, group); String second = create(token, ws, group);
        return new Fixture(token, ws, project, second);
    }
    String create(String token, String ws, String group) throws Exception {
        return body(mvc.perform(post("/api/v1/workspaces/"+ws+"/projects").header("Authorization", "Bearer "+token)
            .contentType("application/json").content(json.writeValueAsString(Map.of("groupId", group,"name","same display name"))))
            .andExpect(status().isCreated())).get("id").asText();
    }
    String delta(String version, List<Map<String,String>> changes, List<String> deletes) throws Exception {
        return json.writeValueAsString(Map.of("format","contract-files-v1","contractProjectId","00000000-0000-4000-8000-000000000018", "expectedVersion",version,"changes",changes,"deletes",deletes));
    }
    ResultActions save(Fixture f, String version, List<Map<String,String>> changes, List<String> deletes) throws Exception {
        return mvc.perform(put(f.url()+"/assets").header("Authorization","Bearer "+f.token()).contentType("application/json").content(delta(version, changes, deletes)));
    }
    @Test void atomicallySavesAndConflictsWithoutCrossingEqualProjectNames() throws Exception {
        Fixture f = fixture();
        save(f,"0",List.of(Map.of("path","project.yaml","content","id: contract-uuid\n"),Map.of("path","design.md","content","old")),List.of())
            .andExpect(status().isOk()).andExpect(jsonPath("$.version").value("1")).andExpect(jsonPath("$.files.length()").value(2));
        save(f,"0",List.of(Map.of("path","new.md","content","must not exist")),List.of("design.md"))
            .andExpect(status().isConflict());
        JsonNode current = body(mvc.perform(get(f.url()+"/assets").header("Authorization","Bearer "+f.token())).andExpect(status().isOk()));
        assertThat(current.get("files").toString()).contains("old").doesNotContain("must not exist");
        mvc.perform(get("/api/v1/workspaces/"+f.ws()+"/projects/"+f.second()+"/assets").header("Authorization","Bearer "+f.token()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.files.length()").value(0));
    }
    @Test void concurrentDeltasHaveOneWinnerAndNeverMixFiles() throws Exception {
        Fixture f = fixture();
        save(f,"0",List.of(Map.of("path","project.yaml","content","base")),List.of()).andExpect(status().isOk());
        try (var pool = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var gate = new java.util.concurrent.CountDownLatch(1);
            var left = pool.submit(() -> { gate.await(); return save(f,"1",List.of(Map.of("path","left-a","content","left"),Map.of("path","left-b","content","left")),List.of()).andReturn().getResponse().getStatus(); });
            var right = pool.submit(() -> { gate.await(); return save(f,"1",List.of(Map.of("path","right-a","content","right"),Map.of("path","right-b","content","right")),List.of()).andReturn().getResponse().getStatus(); });
            gate.countDown();
            int a = left.get(10, java.util.concurrent.TimeUnit.SECONDS); int b = right.get(10, java.util.concurrent.TimeUnit.SECONDS);
            assertThat(List.of(a,b)).containsExactlyInAnyOrder(200,409);
            JsonNode current = body(mvc.perform(get(f.url()+"/assets").header("Authorization","Bearer "+f.token())).andExpect(status().isOk()));
            assertThat(current.get("version").asText()).isEqualTo("2");
            assertThat(current.get("files").size()).isEqualTo(3);
            assertThat(current.get("files").toString()).contains(a == 200 ? "left-a" : "right-a").doesNotContain(a == 200 ? "right-a" : "left-a");
        }
    }
    @Test void snapshotPersistsExactBytesVersionsAndHashAfterSourceEdit() throws Exception {
        Fixture f = fixture();
        save(f,"0",List.of(Map.of("path","project.yaml","content","original 雪\n")),List.of()).andExpect(status().isOk());
        JsonNode snapshot = body(mvc.perform(post(f.url()+"/execution-snapshots").header("Authorization","Bearer "+f.token())
            .contentType("application/json").content("{\"expectedVersion\":\"1\"}")).andExpect(status().isCreated()));
        var fixed = snapshots.find(snapshot.get("snapshotId").asLong());
        assertThat(fixed).isPresent();
        save(f,"1",List.of(Map.of("path","project.yaml","content","later edit")),List.of()).andExpect(status().isOk());
        assertThat(snapshots.find(snapshot.get("snapshotId").asLong())).isEqualTo(fixed);
        assertThat(fixed.orElseThrow().assets().files().getFirst().content()).isEqualTo("original 雪\n");
        assertThat(fixed.orElseThrow().assets().files().getFirst().version()).isEqualTo("1");
        // Independently computed using Node crypto: cross-language UTF-8/framing fixture.
        assertThat(fixed.orElseThrow().assets().files().getFirst().hash()).isEqualTo("148ebbe27e0243a4acaf8951393cf4d2b1172d8a42a33af7f48eefd5e5303724");
        assertThat(fixed.orElseThrow().assets().manifestHash()).isEqualTo("09085bee07ea03e6489f6a09ef46319aea3335dcbfdb309a9f8f24bc70d739d5");
        assertThat(fixed.orElseThrow().assets().manifestHash()).isEqualTo(snapshot.get("assets").get("manifestHash").asText());
        mvc.perform(post(f.url()+"/execution-snapshots").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"1\"}")).andExpect(status().isConflict());
    }
    @Test void legacyWritesCannotBypassRevisionAndBatchKeepsPartialSuccess() throws Exception {
        Fixture f = fixture();
        save(f,"0",List.of(Map.of("path","project.yaml","content","original")),List.of()).andExpect(status().isOk());
        String prefix = "/api/v1/workspaces/"+f.ws()+"/files/";
        mvc.perform(put(prefix+f.project()+"/project.yaml").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"baseVersion\":1,\"content\":\"bypass\"}")).andExpect(status().isForbidden());
        mvc.perform(delete(prefix+f.project()+"/project.yaml").param("baseVersion","1").header("Authorization","Bearer "+f.token()))
            .andExpect(status().isForbidden());
        mvc.perform(post(prefix+"batch").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content(json.writeValueAsString(Map.of("files",List.of(
                Map.of("path",f.project()+"/project.yaml","content","bypass","baseVersion",1),
                Map.of("path",f.second()+"/old.yaml","content","legacy bytes","baseVersion",0))))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.results[0].status").value("forbidden"))
            .andExpect(jsonPath("$.results[1].status").value("pushed"));
        mvc.perform(get(f.url()+"/assets").header("Authorization","Bearer "+f.token())).andExpect(status().isOk())
            .andExpect(jsonPath("$.version").value("1")).andExpect(jsonPath("$.files[0].content").value("original"));
    }
    @Test void appliesConfiguredDeltaLimit() throws Exception {
        Fixture f = fixture();
        save(f,"0",List.of(Map.of("path","a","content","a"),Map.of("path","b","content","b"),Map.of("path","c","content","c"),Map.of("path","d","content","d")),List.of())
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("asset_change_limit"));
    }
    @Test void appliesConfiguredSnapshotLimit() throws Exception {
        Fixture f = fixture();
        save(f,"0",List.of(Map.of("path","project.yaml","content","x".repeat(129))),List.of()).andExpect(status().isOk());
        mvc.perform(post(f.url()+"/execution-snapshots").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"1\"}")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("snapshot_size_limit"));
    }
    @Test void rejectsNonStringRevisionAndUnknownControlFields() throws Exception {
        Fixture f = fixture();
        mvc.perform(put(f.url()+"/assets").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"format\":\"contract-files-v1\",\"contractProjectId\":\"00000000-0000-4000-8000-000000000018\",\"expectedVersion\":0,\"changes\":[],\"deletes\":[]}"))
            .andExpect(status().isBadRequest());
        mvc.perform(put(f.url()+"/assets").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"format\":\"contract-files-v1\",\"contractProjectId\":\"00000000-0000-4000-8000-000000000018\",\"expectedVersion\":\"0\",\"changes\":[],\"deletes\":[],\"unexpected\":true}"))
            .andExpect(status().isBadRequest());
    }
    @Test void checksLiveMembershipBeforeAclAndKeepsLegacyBytesUnmarked() throws Exception {
        Fixture f = fixture();
        String user = "asset-reader-"+f.project();
        String userId = body(mvc.perform(post("/api/v1/auth/register").contentType("application/json")
            .content(json.writeValueAsString(Map.of("username",user,"password","password123","displayName",user)))).andExpect(status().isCreated())).get("id").asText();
        String token = body(mvc.perform(post("/api/v1/auth/login").contentType("application/json")
            .content(json.writeValueAsString(Map.of("username",user,"password","password123")))).andExpect(status().isOk())).get("token").asText();
        jdbc.update("INSERT INTO project_acl (workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,?,'ADMIN',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),Long.valueOf(userId));
        mvc.perform(get(f.url()+"/assets").header("Authorization","Bearer "+token)).andExpect(status().isForbidden());
        jdbc.update("DELETE FROM project_acl WHERE workspace_id=? AND project_id=? AND user_id=?",Long.valueOf(f.ws()),Long.valueOf(f.project()),Long.valueOf(userId));
        jdbc.update("INSERT INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,'VIEWER',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(userId));
        mvc.perform(get(f.url()+"/assets").header("Authorization","Bearer "+token)).andExpect(status().isOk());
        mvc.perform(put(f.url()+"/assets").header("Authorization","Bearer "+token).contentType("application/json")
            .content(delta("0",List.of(),List.of()))).andExpect(status().isForbidden());
        mvc.perform(post(f.url()+"/execution-snapshots").header("Authorization","Bearer "+token).contentType("application/json")
            .content("{\"expectedVersion\":\"0\"}")).andExpect(status().isForbidden());
        mvc.perform(put("/api/v1/workspaces/"+f.ws()+"/files/"+f.project()+"/old.yaml").header("Authorization","Bearer "+f.token())
            .contentType("application/json").content("{\"baseVersion\":0,\"content\":\"legacy original\"}")).andExpect(status().isCreated());
        save(f,"0",List.of(Map.of("path","project.yaml","content","replacement")),List.of("old.yaml"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("legacy_project_layout"));
        mvc.perform(get(f.url()+"/assets").header("Authorization","Bearer "+f.token())).andExpect(status().isOk())
            .andExpect(jsonPath("$.format").isEmpty()).andExpect(jsonPath("$.files[0].content").value("legacy original"));
        mvc.perform(post(f.url()+"/execution-snapshots").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"0\"}")).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("project_format_unsupported"));
    }

    @Test void projectDeleteFailureRollsBackFilesAndAcl() throws Exception {
        Fixture f = fixture();
        save(f,"0",List.of(Map.of("path","project.yaml","content","retained")),List.of()).andExpect(status().isOk());
        jdbc.update("INSERT INTO project_acl (workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,1,'ADMIN',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()));
        blockProjectDeletion(Long.parseLong(f.project()));
        try {
            mvc.perform(delete(f.url()).header("Authorization","Bearer "+f.token())).andExpect(status().isInternalServerError());
            assertThat(fileVersions.listByProject(Long.valueOf(f.ws()),Long.valueOf(f.project()))).hasSize(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM project_acl WHERE workspace_id=? AND project_id=?",Integer.class,Long.valueOf(f.ws()),Long.valueOf(f.project()))).isEqualTo(1);
        } finally { jdbc.update("DELETE FROM task3_delete_blocker WHERE project_id=?",Long.valueOf(f.project())); }
    }

    @Test void workspaceDeleteFailureRollsBackMembersFilesAclAndProjects() throws Exception {
        Fixture existing = fixture();
        String ws = body(mvc.perform(post("/api/v1/workspaces").header("Authorization","Bearer "+existing.token()).contentType("application/json")
            .content(json.writeValueAsString(Map.of("name","delete-rollback-"+existing.project())))).andExpect(status().isCreated())).get("id").asText();
        String group = body(mvc.perform(get("/api/v1/workspaces/"+ws+"/groups").header("Authorization","Bearer "+existing.token())).andExpect(status().isOk())).get(0).get("id").asText();
        String first = create(existing.token(),ws,group); String second = create(existing.token(),ws,group);
        Fixture f = new Fixture(existing.token(),ws,first,second);
        save(f,"0",List.of(Map.of("path","project.yaml","content","retained workspace")),List.of()).andExpect(status().isOk());
        jdbc.update("INSERT INTO project_acl (workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,1,'ADMIN',CURRENT_TIMESTAMP)",Long.valueOf(ws),Long.valueOf(first));
        blockProjectDeletion(Long.parseLong(first));
        try {
            mvc.perform(delete("/api/v1/workspaces/"+ws).header("Authorization","Bearer "+f.token())).andExpect(status().isInternalServerError());
            assertThat(fileVersions.listByProject(Long.valueOf(ws),Long.valueOf(first))).hasSize(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM memberships WHERE workspace_id=?",Integer.class,Long.valueOf(ws))).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM project_acl WHERE workspace_id=?",Integer.class,Long.valueOf(ws))).isEqualTo(1);
            assertThat(projects.listByWorkspace(Long.valueOf(ws))).hasSize(2);
        } finally { jdbc.update("DELETE FROM task3_delete_blocker WHERE project_id=?",Long.valueOf(first)); }
    }

    private void blockProjectDeletion(long projectId) {
        // Real final DB step failure, after file/ACL/member cleanup. No repository mocks.
        jdbc.execute("CREATE TABLE IF NOT EXISTS task3_delete_blocker (project_id BIGINT PRIMARY KEY, CONSTRAINT task3_delete_project_fk FOREIGN KEY(project_id) REFERENCES projects(id))");
        jdbc.update("INSERT INTO task3_delete_blocker (project_id) VALUES (?)",projectId);
    }

    @Test void staleLegacyWriterWaitingBehindProjectDeleteCannotInsertOrphan() throws Exception {
        Fixture f = fixture(); long ws = Long.parseLong(f.ws()); long project = Long.parseLong(f.project());
        String path = f.project()+"/stale.yaml";
        // Model an already-authorized legacy request: its entity validation happened before deletion.
        com.autumnharvestc.server.core.ContentPaths.validate(path,id -> projects.find(id).isPresent());
        var writerStarted = new java.util.concurrent.CountDownLatch(1);
        try (var pool = java.util.concurrent.Executors.newFixedThreadPool(1)) {
            var writer = new java.util.concurrent.atomic.AtomicReference<java.util.concurrent.Future<Throwable>>();
            new org.springframework.transaction.support.TransactionTemplate(transactions).executeWithoutResult(status -> {
                jdbc.queryForList("SELECT id FROM projects WHERE workspace_id=? AND id=? FOR UPDATE",ws,project);
                writer.set(pool.submit(() -> {
                    writerStarted.countDown();
                    try { fileVersions.insertNew(ws,path,"stale",com.autumnharvestc.server.core.Hashes.sha256HexUtf8("stale"),1L); return null; }
                    catch (Throwable error) { return error; }
                }));
                try {
                    assertThat(writerStarted.await(5,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                    mvc.perform(delete(f.url()).header("Authorization","Bearer "+f.token())).andExpect(status().isNoContent());
                } catch (Exception error) { throw new IllegalStateException(error); }
            });
            Throwable failure = writer.get().get(5,java.util.concurrent.TimeUnit.SECONDS);
            assertThat(failure).isInstanceOf(com.autumnharvestc.server.core.ApiException.class);
            assertThat(((com.autumnharvestc.server.core.ApiException)failure).getCode()).isEqualTo("project_not_found");
            assertThat(fileVersions.find(ws,path)).isEmpty();
        } finally { jdbc.update("DELETE FROM file_versions WHERE workspace_id=? AND path=?",ws,path); }
    }

    @Test void snapshotWaitingForProjectLockRechecksCommittedMembershipRevocation() throws Exception {
        Fixture f = fixture(); long ws = Long.parseLong(f.ws()); long project = Long.parseLong(f.project());
        save(f,"0",List.of(Map.of("path","project.yaml","content","fixed original")),List.of()).andExpect(status().isOk());
        String username = "asset-revoked-"+f.project();
        String userId = body(mvc.perform(post("/api/v1/auth/register").contentType("application/json")
            .content(json.writeValueAsString(Map.of("username",username,"password","password123","displayName",username)))).andExpect(status().isCreated())).get("id").asText();
        String token = body(mvc.perform(post("/api/v1/auth/login").contentType("application/json")
            .content(json.writeValueAsString(Map.of("username",username,"password","password123")))).andExpect(status().isOk())).get("token").asText();
        mvc.perform(put("/api/v1/workspaces/"+ws+"/members/"+userId).header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"role\":\"EDITOR\"}")).andExpect(status().isOk());
        // Retained ACL deliberately cannot substitute for live workspace membership after revocation.
        mvc.perform(put(f.url()+"/acl").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content(json.writeValueAsString(Map.of("userId",userId,"role","ADMIN")))).andExpect(status().isOk());
        long before = jdbc.queryForObject("SELECT COUNT(*) FROM execution_snapshots WHERE workspace_id=? AND project_id=?",Long.class,ws,project);
        var prechecked = new java.util.concurrent.CountDownLatch(1);
        // Observe the real DB-backed role result; do not replace authorization with a mock answer.
        org.mockito.Mockito.doAnswer(invocation -> {
            Object role = invocation.callRealMethod(); prechecked.countDown(); return role;
        }).when(observedPermissions).effectiveRole(ws,Long.valueOf(userId),project);
        try (var pool = java.util.concurrent.Executors.newFixedThreadPool(1)) {
            var waiting = new java.util.concurrent.atomic.AtomicReference<java.util.concurrent.Future<Integer>>();
            new org.springframework.transaction.support.TransactionTemplate(transactions).executeWithoutResult(status -> {
                jdbc.queryForList("SELECT id FROM projects WHERE workspace_id=? AND id=? FOR UPDATE",ws,project);
                waiting.set(pool.submit(() -> mvc.perform(post(f.url()+"/execution-snapshots").header("Authorization","Bearer "+token)
                    .contentType("application/json").content("{\"expectedVersion\":\"1\"}")).andReturn().getResponse().getStatus()));
                try {
                    assertThat(prechecked.await(5,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                    var revoke = new org.springframework.transaction.support.TransactionTemplate(transactions);
                    revoke.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
                    revoke.executeWithoutResult(revoking -> {
                        try { mvc.perform(delete("/api/v1/workspaces/"+ws+"/members/"+userId).header("Authorization","Bearer "+f.token())).andExpect(status().isNoContent()); }
                        catch (Exception error) { throw new IllegalStateException(error); }
                    }); // Revocation commits while the outer transaction still holds the project lock.
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM memberships WHERE workspace_id=? AND user_id=?",Integer.class,ws,Long.valueOf(userId))).isZero();
                } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
            });
            assertThat(waiting.get().get(5,java.util.concurrent.TimeUnit.SECONDS)).isEqualTo(403);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_snapshots WHERE workspace_id=? AND project_id=?",Long.class,ws,project)).isEqualTo(before);
            mvc.perform(get(f.url()+"/assets").header("Authorization","Bearer "+f.token())).andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value("1")).andExpect(jsonPath("$.files[0].content").value("fixed original"));
        }
    }
}
