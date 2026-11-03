package com.autumnharvestc.server.execution;

import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import static org.assertj.core.api.Assertions.*;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@org.springframework.test.context.TestPropertySource(properties="spring.datasource.url=jdbc:h2:mem:apicc-access-entry-t5;DB_CLOSE_DELAY=-1")
class AccessEntryPointsTest extends ScheduleFixture {
    @Autowired com.autumnharvestc.server.access.AccessFixtureRevisions versions;
    @Autowired com.autumnharvestc.server.execution.materials.ProjectCredentialStore credentialStore;
    @Autowired com.autumnharvestc.server.store.FileVersionRepo entryFiles;
    record Editor(F owner,F member,String user) {}
    Editor editor() throws Exception {
        var owner=fixture();String name="entry-"+java.util.UUID.randomUUID().toString().substring(0,16);
        String user=body(mvc.perform(post("/api/v1/auth/register").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123","displayName","Entry editor")))).andExpect(status().isCreated())).path("id").asText();
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123")))).andExpect(status().isOk())).path("token").asText();
        member(owner,put("/api/v1/workspaces/"+owner.ws()+"/members/"+user),versions.memberFields(owner.ws(),user,"EDITOR")).andExpect(status().isOk());
        return new Editor(owner,new F(token,owner.ws(),owner.group(),owner.project(),owner.snapshot(),owner.agent(),owner.agentToken(),owner.assets()),user);
    }
    void capabilities(Editor e,Map<String,String> changes) throws Exception {
        String url=e.owner().url()+"/access-members/"+e.user();
        long revision=body(member(e.owner(),get(url),Map.of()).andExpect(status().isOk())).path("revision").asLong();
        member(e.owner(),put(url),Map.of("expectedRevision",revision,"capabilities",changes)).andExpect(status().isOk());
    }
    String accepted(F f,String intent) throws Exception {return body(member(f,post(f.url()+"/jobs"),submission(f,intent)).andExpect(status().isCreated())).path("jobId").asText();}
    long count(String table,String project) {return jdbc.queryForObject("SELECT COUNT(*) FROM "+table+" WHERE project_id=?",Long.class,Long.valueOf(project));}

    // Catches a role-only prepare gate; both initial creation and fixed-snapshot material reuse are real routes.
    @ParameterizedTest @ValueSource(strings={"snapshot","snapshot-reuse","local-materials"})
    void taskExecuteDenialCoversPrepare(String route) throws Exception {
        var e=editor();var f=e.member();
        var selection=Map.of("projectId",f.project(),"credentials",List.of(),"attachments",List.of());
        member(f,post(f.url()+"/execution-snapshots"),Map.of("expectedVersion","1")).andExpect(status().isCreated());
        member(f,get(f.url()+"/execution-snapshots/"+f.snapshot()),Map.of()).andExpect(status().isOk());
        member(f,post("/api/v1/execution-snapshots/"+f.snapshot()+"/local-materials"),selection).andExpect(status().isOk());
        long before=count("execution_snapshots",f.project());
        capabilities(e,Map.of("task.execute","deny"));
        var response=switch(route) {case "snapshot"->member(f,post(f.url()+"/execution-snapshots"),Map.of("expectedVersion","1"));case "snapshot-reuse"->member(f,get(f.url()+"/execution-snapshots/"+f.snapshot()),Map.of());default->member(f,post("/api/v1/execution-snapshots/"+f.snapshot()+"/local-materials"),selection);};
        assertAll(()->response.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden")),()->assertThat(count("execution_snapshots",f.project())).isEqualTo(before));
    }

    // Catches wiring task.execute only at submit, or checking supplied identity instead of the stored original submitter.
    @ParameterizedTest @ValueSource(strings={"submit","cancel","inputs","materials","start"})
    void taskExecuteDenialCoversEveryAdmission(String route) throws Exception {
        var e=editor();var f=e.member();String job=accepted(f,"accepted-"+route);
        if(Set.of("inputs","materials","start").contains(route)) {
            assertThat(beat(f,1,0).path("deliveries")).hasSize(1);
            mvc.perform(get("/api/v1/runner/jobs/"+job+"/inputs").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken())).andExpect(status().isOk());
            agent(f,post("/api/v1/runner/jobs/"+job+"/materials"),Map.of("executionId",execution(job))).andExpect(status().isOk());
        }
        if(route.equals("start")) {
            send(f,message(job,"accepted","positive-accepted")).andExpect(status().isOk());
            send(f,start(job)).andExpect(status().isOk());assertThat(jobRepo.require(Long.valueOf(job),false).permitId()).isNotNull();
            e=editor();f=e.member();job=accepted(f,"second-start");assertThat(beat(f,1,0).path("deliveries")).hasSize(1);
            send(f,message(job,"accepted","denial-accepted")).andExpect(status().isOk());
        }
        String fixedJob=job;String beforeState=state(job);long before=count("execution_jobs",f.project());
        capabilities(e,Map.of("task.execute","deny"));
        switch(route) {
            case "submit" -> member(f,post(f.url()+"/jobs"),submission(f,"denied-submit")).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
            case "cancel" -> member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
            case "inputs" -> mvc.perform(get("/api/v1/runner/jobs/"+job+"/inputs").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken())).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
            case "materials" -> agent(f,post("/api/v1/runner/jobs/"+job+"/materials"),Map.of("executionId",execution(job))).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
            case "start" -> {send(f,start(job)).andExpect(status().isOk());assertAll(()->assertThat(state(fixedJob)).isEqualTo("preparing"),()->assertThat(jdbc.queryForList("SELECT payload_json FROM execution_job_outbox WHERE job_id=? AND kind='start-rejected'",String.class,Long.valueOf(fixedJob))).singleElement().satisfies(value->assertThat(jobRepo.parse(value).path("reasonCode").asText()).isEqualTo("forbidden")),()->assertThat(jobRepo.require(Long.valueOf(fixedJob),false).permitId()).isNull());}
        }
        assertThat(count("execution_jobs",f.project())).isEqualTo(before);
        if(!route.equals("start"))assertThat(state(job)).isEqualTo(beforeState);
    }

    // Catches task.execute being treated as permission to manage credentials.
    @ParameterizedTest @ValueSource(strings={"put","remove"})
    void credentialManageDenialPreservesStoredEnvelope(String route) throws Exception {
        var e=editor();var f=e.member();String url=f.url()+"/credentials/auth";
        member(f,put(url),Map.of("expectedVersion","0","value","synthetic-value")).andExpect(status().isOk());
        var before=credentialStore.find(Long.parseLong(f.ws()),Long.parseLong(f.project()),"auth").orElseThrow();
        capabilities(e,Map.of("credential.manage","deny"));
        var response=route.equals("put")?member(f,put(url),Map.of("expectedVersion","1","value","replacement")):member(f,delete(url).param("expectedVersion","1"),Map.of());
        var after=credentialStore.find(Long.parseLong(f.ws()),Long.parseLong(f.project()),"auth").orElseThrow();
        assertAll(()->response.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden")),()->assertThat(after.version()).isEqualTo(before.version()),()->assertThat(after.ciphertext()).isEqualTo(before.ciphertext()),()->assertThat(after.nonce()).isEqualTo(before.nonce()));
    }
    @Test void credentialManageDoesNotRequireTaskExecution() throws Exception {
        var e=editor();var f=e.member();capabilities(e,Map.of("task.execute","deny"));
        member(f,put(f.url()+"/credentials/auth"),Map.of("expectedVersion","0","value","synthetic-value")).andExpect(status().isOk());
        member(f,delete(f.url()+"/credentials/auth").param("expectedVersion","1"),Map.of()).andExpect(status().isNoContent());
    }

    // Catches the old full view leaking tasks/results after withdrawal; each independently parameterized request is reached.
    @ParameterizedTest @ValueSource(strings={"detail","intent","verify","list","report","other-active","own-active","own-active-no-execute","own-active-intent","own-active-verify"})
    void historyDenialRestrictsActualJobSurfaces(String route) throws Exception {
        var e=editor();var f=e.member();var request=submission(f,"history-intent");
        String job=body(member(f,post(f.url()+"/jobs"),request).andExpect(status().isCreated())).path("jobId").asText();
        if(!route.startsWith("own-active")&&!route.equals("other-active")) jdbc.update("UPDATE execution_jobs SET state='ended',summary_json=?,report_state='archived',report_content=? WHERE id=?","{\"verdict\":\"passed\",\"private\":\"fixture-result\"}","{\"private\":\"fixture-report\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8),Long.valueOf(job));
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.task").exists());
        if(route.equals("report"))member(f,get("/api/v1/jobs/"+job+"/report"),Map.of()).andExpect(status().isOk());
        if(route.equals("other-active"))jdbc.update("UPDATE execution_jobs SET submitted_by=(SELECT id FROM users WHERE username='admin') WHERE id=?",Long.valueOf(job));
        capabilities(e,route.equals("own-active-no-execute")?Map.of("history.read","deny","task.execute","deny"):Map.of("history.read","deny"));
        var response=switch(route) {
            case "intent","own-active-intent" -> member(f,get(f.url()+"/jobs/by-intent").param("intentId","history-intent"),Map.of());
            case "verify","own-active-verify" -> member(f,post(f.url()+"/jobs/by-intent/verify"),request);
            case "list" -> member(f,get(f.url()+"/jobs"),Map.of());
            case "report" -> member(f,get("/api/v1/jobs/"+job+"/report"),Map.of());
            default -> member(f,get("/api/v1/jobs/"+job),Map.of());
        };
        if(route.startsWith("own-active")&&!route.equals("own-active-no-execute")) {
            var view=body(response.andExpect(status().isOk()));
            minimalView(view,f);
            assertThat(view.path("view").asText()).isEqualTo("active-status");
            member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isOk());
        } else response.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
    }

    @ParameterizedTest @ValueSource(strings={"put","remove"})
    void credentialAuditFailureRollsBackActualMutation(String route) throws Exception {
        var e=editor();var f=e.member();String url=f.url()+"/credentials/auth";
        member(f,put(url),Map.of("expectedVersion","0","value","synthetic-value")).andExpect(status().isOk());
        var before=credentialStore.find(Long.parseLong(f.ws()),Long.parseLong(f.project()),"auth").orElseThrow();
        jdbc.execute("ALTER TABLE execution_management_audit ADD CONSTRAINT task5_credential_audit_failure CHECK (actor_id<>"+e.user()+" OR version<>2 OR action NOT IN ('credential.put','credential.remove'))");
        try {
            var response=route.equals("put")?member(f,put(url),Map.of("expectedVersion","1","value","replacement")):member(f,delete(url).param("expectedVersion","1"),Map.of());
            var after=credentialStore.find(Long.parseLong(f.ws()),Long.parseLong(f.project()),"auth").orElseThrow();
            assertAll(()->response.andExpect(status().isInternalServerError()),()->assertThat(after.version()).isEqualTo(before.version()),()->assertThat(after.ciphertext()).isEqualTo(before.ciphertext()),()->assertThat(after.nonce()).isEqualTo(before.nonce()));
        } finally {jdbc.execute("ALTER TABLE execution_management_audit DROP CONSTRAINT task5_credential_audit_failure");}
    }

    @Test void successfulCredentialAuditIsSafeAndDurable() throws Exception {
        var e=editor();var f=e.member();
        member(f,put(f.url()+"/credentials/auth"),Map.of("expectedVersion","0","value","synthetic-value")).andExpect(status().isOk());
        member(f,delete(f.url()+"/credentials/auth").param("expectedVersion","1"),Map.of()).andExpect(status().isNoContent());
        var rows=jdbc.queryForList("SELECT action,scope_type,scope_id,version FROM execution_management_audit WHERE actor_id=? AND action IN ('credential.put','credential.remove') ORDER BY id",Long.valueOf(e.user()));
        assertThat(rows).hasSize(2);
        assertThat(rows).extracting(r->r.get("action")).containsExactly("credential.put","credential.remove");
        assertThat(rows).extracting(r->((Number)r.get("version")).longValue()).containsExactly(1L,2L);
        assertThat(rows.toString()).doesNotContain("synthetic-value","ciphertext","nonce");
    }

    @ParameterizedTest @ValueSource(strings={"options","projection","manage","subject"})
    void scheduleGrantAlsoRequiresCurrentTaskExecution(String route) throws Exception {
        var e=editor();var f=e.member();
        member(e.owner(),put(f.url()+"/schedule-grants"),Map.of("expectedVersion","0","userIds",List.of(e.user()))).andExpect(status().isOk());
        member(f,get(f.url()+"/schedules/options"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.canManageSchedules").value(true));
        capabilities(e,Map.of("task.execute","deny"));
        switch(route) {
            case "options" -> {var rows=body(member(e.owner(),get(f.url()+"/schedule-grants/options"),Map.of()).andExpect(status().isOk())).path("items");com.fasterxml.jackson.databind.JsonNode target=null;for(var row:rows)if(row.path("userId").asText().equals(e.user()))target=row;assertThat(target).isNotNull();assertThat(target.path("eligible").asBoolean()).isFalse();}
            case "projection" -> member(e.owner(),get(f.url()+"/schedule-grants"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.userIds").isEmpty());
            case "manage" -> member(f,get(f.url()+"/schedules/options"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.canManageSchedules").value(false));
            case "subject" -> assertThatThrownBy(()->scheduleGrants.requireSubject(Long.parseLong(e.user()),Long.parseLong(f.ws()),Long.parseLong(f.project()))).isInstanceOf(com.autumnharvestc.server.core.ApiException.class).extracting("code").isEqualTo("schedule-subject-unauthorized");
        }
    }
    @Autowired com.autumnharvestc.server.execution.scheduling.ScheduleGrantService scheduleGrants;

    @ParameterizedTest @ValueSource(strings={"submit","cancel"})
    void executionReceiptWithoutHistoryIsMinimal(String route) throws Exception {
        var e=editor();var f=e.member();String job=accepted(f,"before-history-withdrawal");
        capabilities(e,Map.of("history.read","deny"));
        var response=route.equals("submit")?member(f,post(f.url()+"/jobs"),submission(f,"after-history-withdrawal")):member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of());
        var view=body(response.andExpect(route.equals("submit")?status().isCreated():status().isOk()));
        minimalView(view,f);
        assertThat(view.path("view").asText()).isEqualTo("active-status");
        if(route.equals("cancel"))assertThat(state(job)).isEqualTo("ended");
    }

    void minimalView(com.fasterxml.jackson.databind.JsonNode view,F f) {
        org.junit.jupiter.api.Assertions.assertAll(
            ()->assertThat(view.properties()).extracting(Map.Entry::getKey).containsExactlyInAnyOrder("jobId","executionId","agentId","state","cancelState","executionReleased","canCancel","view","scope"),
            ()->assertThat((Object)view.path("scope")).isEqualTo(json.valueToTree(Map.of("workspaceId",f.ws(),"groupId",f.group(),"projectId",f.project())))
        );
    }
    Editor legacyEditor() throws Exception {
        var e=editor();var owner=e.owner();String project=body(member(owner,post("/api/v1/workspaces/"+owner.ws()+"/projects"),Map.of("groupId",owner.group(),"name","legacy mutation" )).andExpect(status().isCreated())).path("id").asText();
        var f=new F(e.member().token(),owner.ws(),owner.group(),project,owner.snapshot(),owner.agent(),owner.agentToken(),owner.assets());
        return new Editor(new F(owner.token(),owner.ws(),owner.group(),project,owner.snapshot(),owner.agent(),owner.agentToken(),owner.assets()),f,e.user());
    }
    @ParameterizedTest @ValueSource(strings={"atomic","put","batch","delete"})
    void disabledClassificationRejectsRestrictedRealRoutes(String route) throws Exception {
        var e=route.equals("atomic")?editor():legacyEditor();var f=e.member();String url="/api/v1/workspaces/"+f.ws()+"/files/"+f.project()+"/old.yaml";
        if(!route.equals("atomic"))member(e.owner(),put(url),Map.of("baseVersion",0,"content","opaque legacy bytes")).andExpect(status().isCreated());
        var saved=entryFiles.listByProject(Long.valueOf(f.ws()),Long.valueOf(f.project()));long revision=jdbc.queryForObject("SELECT asset_version FROM projects WHERE id=?",Long.class,Long.valueOf(f.project()));
        capabilities(e,Map.of("script.edit","deny"));
        var response=switch(route) {
            case "atomic" -> member(f,put(f.url()+"/assets"),Map.of("format","contract-files-v1","contractProjectId",UUID,"expectedVersion","1","changes",List.of(Map.of("path","project.yaml","content","name: changed")),"deletes",List.of()));
            case "put" -> member(f,put(url),Map.of("baseVersion",1,"content","changed"));
            case "delete" -> member(f,delete(url).param("baseVersion","1"),Map.of());
            default -> member(f,post("/api/v1/workspaces/"+f.ws()+"/files/batch"),Map.of("files",List.of(Map.of("path",f.project()+"/old.yaml","baseVersion",1,"content","changed"))));
        };
        assertAll(()->{if(route.equals("batch"))response.andExpect(status().isOk()).andExpect(jsonPath("$.results[0].status").value("forbidden"));else response.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));},()->assertThat(entryFiles.listByProject(Long.valueOf(f.ws()),Long.valueOf(f.project()))).isEqualTo(saved),()->assertThat(jdbc.queryForObject("SELECT asset_version FROM projects WHERE id=?",Long.class,Long.valueOf(f.project()))).isEqualTo(revision));
    }
    @ParameterizedTest @ValueSource(strings={"atomic","legacy"})
    void disabledClassificationFullWriterHasHonestAssetAudit(String route) throws Exception {
        var e=route.equals("atomic")?editor():legacyEditor();var f=e.member();
        if(route.equals("atomic")) member(f,put(f.url()+"/assets"),Map.of("format","contract-files-v1","contractProjectId",UUID,"expectedVersion","1","changes",List.of(Map.of("path","project.yaml","content","name: changed")),"deletes",List.of())).andExpect(status().isOk());
        else member(f,put("/api/v1/workspaces/"+f.ws()+"/files/"+f.project()+"/ordinary.yaml"),Map.of("baseVersion",0,"content","ordinary legacy bytes")).andExpect(status().isCreated());
        var rows=jdbc.query("SELECT asset_summary,asset_locations_json,asset_before_revision,asset_after_revision FROM execution_management_audit WHERE actor_id=? AND scope_id=? AND action='asset.change'",(r,n)->List.of(r.getString(1),r.getString(2),r.getString(3),r.getString(4)),Long.valueOf(e.user()),Long.valueOf(f.project()));
        assertThat(rows).singleElement().satisfies(row->{assertThat(row.get(0)).isEqualTo("classification-disabled");assertThat(jobRepo.parse(row.get(1))).isEqualTo(json.valueToTree(List.of(route.equals("atomic")?"project.yaml":"ordinary.yaml")));assertThat(row.get(2)).matches("[a-f0-9]{64}");assertThat(row.get(3)).matches("[a-f0-9]{64}").isNotEqualTo(row.get(2));});
    }
}
