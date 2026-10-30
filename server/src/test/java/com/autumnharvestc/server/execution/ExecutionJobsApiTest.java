package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.core.Hashes;
import com.autumnharvestc.server.execution.jobs.*;
import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.*;
import org.springframework.test.web.servlet.*;
import java.nio.file.*;
import java.util.*;
import java.time.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc(print=org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-jobs-t6;DB_CLOSE_DELAY=-1","apicc.server.allow-registration=true","apicc.server.admin-username=admin","apicc.server.admin-password=admin-pass-2026","apicc.execution.jobs.default-page-size=2","apicc.execution.jobs.max-page-size=3","apicc.execution.control-base-url=https://control.test/api/v1"})
@org.springframework.context.annotation.Import(JobsFixture.ClockConfiguration.class)
abstract class JobsFixture {
    @org.springframework.test.context.bean.override.mockito.MockitoBean com.autumnharvestc.server.execution.scheduling.EmbeddedScheduleTimer scheduleTimer;
    static final String HASH="a".repeat(64), EMPTY="4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
    static final String UUID="10000000-0000-4000-8000-000000000001";
    static final String SCRIPT_API="afaf628a48532cff1e1e9264f328830ea1678b877853e324bab040039d0721d0", RUNTIME="node-22.19.0-v8-12.4.254.21-node.29-script-"+SCRIPT_API;
    static final Path KEY;
    static {try{KEY=Files.createTempFile("apicc-t6-key-",".bin");Files.write(KEY,new byte[32]);KEY.toFile().deleteOnExit();}catch(Exception e){throw new ExceptionInInitializerError(e);}}
    @DynamicPropertySource static void props(DynamicPropertyRegistry r){r.add("apicc.execution.materials.master-key-file",()->KEY.toString());}
    @Autowired MockMvc mvc; @Autowired ObjectMapper json; @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Autowired RunnerControlService control; @Autowired RunnerPollWaiters waiters;
    @Autowired JobRepo jobRepo;
    @Autowired TestClock clock;
    @Autowired com.autumnharvestc.server.execution.config.ExecutionConfigService executionConfigs;
    static class TestClock extends Clock {
        private Instant now=Instant.parse("2030-01-01T00:00:00Z");
        void set(Instant value){now=value;}
        @Override public ZoneId getZone(){return ZoneOffset.UTC;}
        @Override public Clock withZone(ZoneId zone){return this;}
        @Override public Instant instant(){return now;}
    }
    @org.springframework.boot.test.context.TestConfiguration
    static class ClockConfiguration {
        @org.springframework.context.annotation.Bean TestClock executionTestClock(){return new TestClock();}
    }
    record F(String token,String ws,String group,String project,String snapshot,String agent,String agentToken,JsonNode assets) {
        String url(){return "/api/v1/workspaces/"+ws+"/projects/"+project;}
    }
    JsonNode body(ResultActions result)throws Exception{return json.readTree(result.andReturn().getResponse().getContentAsString());}
    void wire(String name,Object value)throws Exception{Files.writeString(Path.of(System.getProperty("apicc.build.directory"),name+".json"),json.writeValueAsString(value));}
    ResultActions member(F f,org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder request,Object content)throws Exception{return mvc.perform(request.header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(content)));}
    ResultActions agent(F f,org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder request,Object content)throws Exception{return mvc.perform(request.header("Authorization","Bearer "+f.agentToken()).contentType("application/json").content(json.writeValueAsString(content)));}
    F fixture()throws Exception{
        clock.set(Instant.parse("2030-01-01T00:00:00Z"));
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content("{\"username\":\"admin\",\"password\":\"admin-pass-2026\"}")).andExpect(status().isOk())).get("token").asText();
        String ws=body(mvc.perform(get("/api/v1/connect").header("Authorization","Bearer "+token)).andExpect(status().isOk())).get("workspaceId").asText();
        String group=body(mvc.perform(get("/api/v1/workspaces/"+ws+"/groups").header("Authorization","Bearer "+token)).andExpect(status().isOk())).get(0).get("id").asText();
        String project=body(mvc.perform(post("/api/v1/workspaces/"+ws+"/projects").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsString(Map.of("groupId",group,"name","task six")))).andExpect(status().isCreated())).get("id").asText();
        String url="/api/v1/workspaces/"+ws+"/projects/"+project;
        var assets=body(mvc.perform(put(url+"/assets").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsString(Map.of("format","contract-files-v1","contractProjectId",UUID,"expectedVersion","0","changes",List.of(Map.of("path","project.yaml","content","name: task-six\n")),"deletes",List.of())))).andExpect(status().isOk()));
        String snapshot=body(mvc.perform(post(url+"/execution-snapshots").header("Authorization","Bearer "+token).contentType("application/json").content("{\"expectedVersion\":\"1\"}")).andExpect(status().isCreated())).get("snapshotId").asText();
        String a=body(mvc.perform(post("/api/v1/agents").header("Authorization","Bearer "+token).contentType("application/json").content("{\"name\":\"task-six\"}")).andExpect(status().isCreated())).get("id").asText();
        mvc.perform(put("/api/v1/agents/"+a+"/workspace-grants").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsString(Map.of("workspaceIds",List.of(ws))))).andExpect(status().isOk());
        mvc.perform(put("/api/v1/workspaces/"+ws+"/agent-project-allocations").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsString(Map.of("agentId",a,"projectIds",List.of(project))))).andExpect(status().isOk());
        mvc.perform(put(url+"/execution-settings").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsString(Map.of("expectedVersion","0","agentIds",List.of(a),"defaultAgentId",a,"policy",Map.of())))).andExpect(status().isOk());
        String enroll=body(mvc.perform(post("/api/v1/agents/"+a+"/enrollments").header("Authorization","Bearer "+token)).andExpect(status().isCreated())).get("enrollmentToken").asText();
        String at=body(mvc.perform(post("/api/v1/runner/enroll").contentType("application/json").content(json.writeValueAsString(Map.of("enrollmentToken",enroll)))).andExpect(status().isCreated())).get("agentToken").asText();
        var result=new F(token,ws,group,project,snapshot,a,at,assets);registerRuntime(result,"session-one","0");return result;
    }
    void registerRuntime(F f,String session,String configVersion)throws Exception{
        var registration=new LinkedHashMap<String,Object>();registration.put("protocolVersion",1);registration.put("sessionId",session);registration.put("coreBuildId",HASH);registration.put("scriptApiId",SCRIPT_API);registration.put("nodeVersion","22.19.0");registration.put("v8Version","12.4.254.21-node.29");registration.put("runtimeCompatibilityId",RUNTIME);registration.put("capabilities",List.of("task:debug","task:suite","task:workflow","protocol:http","protocol:soap","protocol:websocket","script:trusted-core"));registration.put("configuration",Map.of("configVersion",configVersion,"appliedConfigVersion",configVersion,"pendingFields",List.of(),"restartRequiredFields",List.of(),"status","applied"));
        agent(f,post("/api/v1/runner/runtime"),registration).andExpect(status().isOk()).andExpect(jsonPath("$.registered").value(true));
    }
    Map<String,Object> submission(F f,String intent){
        var p=new LinkedHashMap<String,Object>();p.put("scope",Map.of("workspaceId",f.ws(),"groupId",f.group(),"projectId",f.project()));p.put("manifestHash",f.assets().get("manifestHash").asText());p.put("scriptPlanDigest",EMPTY);p.put("scriptRequirements",List.of());p.put("executionProfile","no-script");p.put("dispatchKind","dedicated-task");p.put("requiredCoreBuildId",HASH);p.put("requiredCapabilities",List.of("task:suite","protocol:http"));p.put("runtimeCompatibilityId",RUNTIME);
        var s=new LinkedHashMap<String,Object>();s.put("intentId",intent);s.put("agentId",f.agent());s.put("snapshotId",f.snapshot());s.put("target",Map.of("kind","suite","suiteId",UUID,"allowDraft",false));s.put("runConfig",Map.of("jobTimeoutMs",60000,"requestSettings",Map.of("totalTimeoutMs",12345,"followRedirects",false)));s.put("materials",Map.of("projectId",f.project(),"credentials",List.of(),"attachments",List.of()));s.put("preparation",p);return s;
    }
    Map<String,Object> debugSubmission(F f,String intent){
        var s=submission(f,intent);
        var locator=Map.<String,Object>of("workspaceId",UUID,"groupId",UUID,"projectId",UUID,"collectionId",UUID,"folderIds",List.of(),"apiId",UUID);
        var testCase=new LinkedHashMap<String,Object>(locator);testCase.put("caseId",UUID);testCase.put("scope","published");
        s.put("target",Map.of("kind","debug","invocation",Map.of("mode","case","locator",locator,"case",testCase)));
        preparation(s).put("requiredCapabilities",List.of("task:debug","protocol:http"));return s;
    }
    @SuppressWarnings("unchecked")
    Map<String,Object> preparation(Map<String,Object> submission){return (Map<String,Object>)submission.get("preparation");}
    // Valid fixed queued/preparing rows isolate control behavior from the independent submission feature.
    String seed(F f,String state)throws Exception{return seed(f,state,submission(f,java.util.UUID.randomUUID().toString()));}
    String seed(F f,String state,Map<String,Object> submit)throws Exception{
        long identity=jobRepo.nextId();
        String user=jdbc.queryForObject("SELECT id FROM users WHERE username='admin'",String.class);
        var p=(Map<?,?>)submit.get("preparation");
        var task=new LinkedHashMap<String,Object>();task.put("protocolVersion",1);task.put("jobId",String.valueOf(identity));task.put("executionId",String.valueOf(identity+100000));task.put("scope",p.get("scope"));task.put("submittedByUserId",user);task.put("contractProjectId",UUID);task.put("snapshotId",f.snapshot());task.put("manifestHash",p.get("manifestHash"));task.put("target",submit.get("target"));task.put("policyVersion",jdbc.queryForObject("SELECT version FROM execution_policy_revision WHERE id=1",String.class));for(var key:List.of("scriptPlanDigest","executionProfile","dispatchKind","requiredCoreBuildId","requiredCapabilities","runtimeCompatibilityId","scriptGrantVersion"))if(p.containsKey(key))task.put(key,p.get(key));
        var snapshot=Map.of("snapshotId",f.snapshot(),"createdByUserId",user,"assets",f.assets());
        var inputs=new LinkedHashMap<String,Object>();inputs.put("executionId",task.get("executionId"));inputs.put("snapshot",snapshot);inputs.put("runConfig",submit.get("runConfig"));inputs.put("materials",submit.get("materials"));inputs.put("policy",executionConfigs.effective(Long.valueOf(f.agent()),Long.parseLong(f.ws()),Long.parseLong(f.project()),JobService.timeouts(jobRepo.decode(json.valueToTree(submit),JobDtos.Submit.class).runConfig())).get("policy"));inputs.put("inputsDigest",HASH);
        jdbc.update("INSERT INTO execution_jobs(id,execution_id,workspace_id,project_id,submitted_by,agent_id,snapshot_id,intent_id,intent_hash,submission_json,task_json,inputs_json,inputs_digest,state,accepted,reserved_input_bytes,reserved_result_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,TRUE,20,100)",identity,identity+100000,Long.valueOf(f.ws()),Long.valueOf(f.project()),Long.valueOf(user),Long.valueOf(f.agent()),Long.valueOf(f.snapshot()),submit.get("intentId"),HASH,json.writeValueAsString(submit),json.writeValueAsString(task),json.writeValueAsString(inputs),HASH,state);
        jdbc.update("UPDATE execution_jobs SET runtime_session_id='session-one' WHERE id=?",identity);return String.valueOf(identity);
    }
    String execution(String job){return jdbc.queryForObject("SELECT execution_id FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job));}
    Map<String,Object> message(String job,String kind,String messageId){return new LinkedHashMap<>(Map.of("jobId",job,"executionId",execution(job),"messageId",messageId,"kind",kind));}
    Map<String,Object> start(String job){var m=message(job,"start-request","start-"+job);m.put("inputsDigest",jdbc.queryForObject("SELECT inputs_digest FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job)));m.put("policyVersion",jdbc.queryForObject("SELECT version FROM execution_policy_revision WHERE id=1",String.class));m.put("scriptPlanDigest",EMPTY);m.put("scriptRequirements",List.of());m.put("executionProfile","no-script");m.put("runtimeCompatibilityId",RUNTIME);m.put("credentialVersions",Map.of());return m;}
    JobDtos.Exchange exchange(long total,long shared){return new JobDtos.Exchange("session-one","0",total,shared,List.of());}
    JsonNode beat(F f,long total,long shared)throws Exception{return body(agent(f,post("/api/v1/runner/heartbeat"),exchange(total,shared)).andExpect(status().isOk()));}
    ResultActions send(F f,Map<String,Object> m)throws Exception{return agent(f,post("/api/v1/runner/messages"),List.of(m));}
    String state(String job){return jdbc.queryForObject("SELECT state FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job));}
}

class ExecutionJobsApiTest extends StressJobsFixture {
    @Test void retriesAnOrdinaryIntentUsingItsPreStressUpgradeHashWithoutCreatingAnotherExecution()throws Exception {
        var f=fixture();var request=submission(f,"pre-stress-upgrade-intent");
        var first=body(member(f,post(f.url()+"/jobs"),request).andExpect(status().isCreated()));String job=first.path("jobId").asText();
        // Old RunConfig had exactly three fields; old Preparation had exactly ten.
        // Preserve their old null fields, omitting only the two properties that did not exist.
        var legacy=(com.fasterxml.jackson.databind.node.ObjectNode)json.valueToTree(request);
        ((com.fasterxml.jackson.databind.node.ObjectNode)legacy.get("runConfig")).putNull("scriptTimeoutMs");
        ((com.fasterxml.jackson.databind.node.ObjectNode)legacy.get("preparation")).putNull("scriptGrantVersion");
        assertThat(legacy.path("runConfig")).hasSize(3);assertThat(legacy.path("preparation")).hasSize(10);
        var current=(com.fasterxml.jackson.databind.node.ObjectNode)json.valueToTree(jobRepo.decode(json.valueToTree(request),JobDtos.Submit.class));
        ((com.fasterxml.jackson.databind.node.ObjectNode)current.get("runConfig")).remove("stress");
        ((com.fasterxml.jackson.databind.node.ObjectNode)current.get("preparation")).remove("stressBinding");
        assertThat(json.readTree(json.writeValueAsString(current))).as("legacy JSON differs only by the two new optional fields").isEqualTo(legacy);
        String oldHash=jobRepo.digest(legacy);jdbc.update("UPDATE execution_jobs SET intent_hash=? WHERE id=?",oldHash,Long.valueOf(job));
        var retried=body(member(f,post(f.url()+"/jobs"),request).andExpect(status().isCreated()));
        assertThat(retried.path("jobId")).isEqualTo(first.path("jobId"));assertThat(retried.path("executionId")).isEqualTo(first.path("executionId"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT intent_hash FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job))).isEqualTo(oldHash);
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"[]","\"private-stress-value\"","1.5"})
    void rejectsNonObjectStressSettingsAtTheHttpBoundary(String invalid)throws Exception {
        var f=configured();var request=stress(f,"non-object-stress");request.put("runConfig",Map.of("stress",json.readTree(invalid)));
        var response=body(member(f,post(f.url()+"/jobs"),request).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed")));
        assertThat(response.path("message").asText()).doesNotContain("private-stress-value");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
    }
    @Test void ordinarySubmittedOptionalStressNodesStayAbsentAfterDurableDecode()throws Exception {
        var f=fixture();String job=body(member(f,post(f.url()+"/jobs"),submission(f,"ordinary-null-stress")).andExpect(status().isCreated())).path("jobId").asText();
        var decoded=jobRepo.decode(jobRepo.require(Long.valueOf(job),false).submission(),JobDtos.Submit.class);
        org.junit.jupiter.api.Assertions.assertAll(
            ()->assertThat(decoded.preparation().stressBinding()).as("optional binding must remain absent after persistence").isNull(),
            ()->assertThat(decoded.runConfig().stress()).as("optional stress run must remain absent after persistence").isNull());
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource({"1000,1000","1.5,1.5","1e-7,1e-7","1e21,1e+21","4.9e-324,5e-324"})
    void executionInputDigestMatchesHostVerifiedFiniteRpsFixtures(double rps,String ecmaText) {
        assertThat(jobRepo.executionInputDigest(Map.of("rps",rps))).isEqualTo(Hashes.sha256HexUtf8("{\"rps\":"+ecmaText+"}"));
    }
    @Test void ordinaryFixedInputsUseTheSeparatelyVerifiedHostDigestBoundary()throws Exception {
        var f=configured();String job=body(member(f,post(f.url()+"/jobs"),submission(f,"ordinary-digest")).andExpect(status().isCreated())).path("jobId").asText();
        var inputs=jobRepo.inputs(Long.valueOf(job));wire("t4-ordinary-digest-inputs",inputs);var unsigned=jobRepo.map(inputs);String stored=(String)unsigned.remove("inputsDigest");
        assertThat(stored).isEqualTo(jobRepo.executionInputDigest(unsigned)).isNotEqualTo(jobRepo.digest(unsigned));
    }
    @Test void fixedStressRunDefaultsAndDigestUseTheHostCompatibleBoundary()throws Exception {
        var f=configured();var s=stress(f,"default-run-digest");s.put("runConfig",Map.of("stress",Map.of()));
        var b=(com.fasterxml.jackson.databind.node.ObjectNode)json.valueToTree(preparation(s).get("stressBinding"));((com.fasterxml.jackson.databind.node.ObjectNode)b.get("reservation")).put("processes",1).put("metricMemoryBytes",1048576);preparation(s).put("stressBinding",b);
        String job=body(member(f,post(f.url()+"/jobs"),s).andExpect(status().isCreated())).path("jobId").asText();var inputs=jobRepo.inputs(Long.valueOf(job));
        wire("t4-stress-default-digest-inputs",inputs);
        assertThat(inputs.path("runConfig").path("stress").path("workerCount").asInt()).isEqualTo(1);
        assertThat(inputs.path("runConfig").path("stress").path("confirmedTargetOrigins")).isEmpty();
        var unsigned=jobRepo.map(inputs);String stored=(String)unsigned.remove("inputsDigest");assertThat(stored).isEqualTo(jobRepo.executionInputDigest(unsigned));
    }
    @Test void executionInputNumbersMatchTheRfcEcmaScriptSamples() {
        var samples=List.of(new String[]{"0000000000000000","0"},new String[]{"8000000000000000","0"},new String[]{"0000000000000001","5e-324"},new String[]{"8000000000000001","-5e-324"},
            new String[]{"7fefffffffffffff","1.7976931348623157e+308"},new String[]{"ffefffffffffffff","-1.7976931348623157e+308"},new String[]{"4340000000000000","9007199254740992"},new String[]{"c340000000000000","-9007199254740992"},
            new String[]{"4430000000000000","295147905179352830000"},new String[]{"44b52d02c7e14af5","9.999999999999997e+22"},new String[]{"44b52d02c7e14af6","1e+23"},new String[]{"44b52d02c7e14af7","1.0000000000000001e+23"},
            new String[]{"444b1ae4d6e2ef4e","999999999999999700000"},new String[]{"444b1ae4d6e2ef4f","999999999999999900000"},new String[]{"444b1ae4d6e2ef50","1e+21"},new String[]{"3eb0c6f7a0b5ed8c","9.999999999999997e-7"},new String[]{"3eb0c6f7a0b5ed8d","0.000001"},
            new String[]{"41b3de4355555553","333333333.3333332"},new String[]{"41b3de4355555554","333333333.33333325"},new String[]{"41b3de4355555555","333333333.3333333"},new String[]{"41b3de4355555556","333333333.3333334"},new String[]{"41b3de4355555557","333333333.33333343"},
            new String[]{"becbf647612f3696","-0.0000033333333333333333"},new String[]{"43143ff3c1cb0959","1424953923781206.2"});
        org.assertj.core.api.SoftAssertions.assertSoftly(soft->{for(var sample:samples){double value=Double.longBitsToDouble(Long.parseUnsignedLong(sample[0],16));soft.assertThat(jobRepo.executionInputDigest(Map.of("rps",value))).as(sample[0]+" -> "+sample[1]).isEqualTo(Hashes.sha256HexUtf8("{\"rps\":"+sample[1]+"}"));}});
    }
    @Test void fixedInputDigestFollowsHostEnumerationForNumericBusinessKeys()throws Exception {
        var f=configured();member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","2","policy",Map.of("maxStressRps",1.5))).andExpect(status().isOk());
        var attachment=body(member(f,post(f.url()+"/attachments"),Map.of("refId","input","expectedVersion","0","kind","file","contentBase64","b2s=")).andExpect(status().isCreated()));
        var ref=Map.of("refId","input","version",attachment.path("version").asText(),"hash",attachment.path("hash").asText());var s=submission(f,"numeric-input-keys");
        s.put("materials",Map.of("projectId",f.project(),"credentials",List.of(),"attachments",List.of(ref),"attachmentPaths",Map.of("10",ref,"2",ref)));
        String job=body(member(f,post(f.url()+"/jobs"),s).andExpect(status().isCreated())).path("jobId").asText();var inputs=jobRepo.inputs(Long.valueOf(job));wire("t4-numeric-key-digest-inputs",inputs);
        assertThat(jobRepo.executionInputDigest(Map.of("10","ten","2","two","a","letters"))).isEqualTo(Hashes.sha256HexUtf8("{\"2\":\"two\",\"10\":\"ten\",\"a\":\"letters\"}"));
        var unsigned=jobRepo.map(inputs);String stored=(String)unsigned.remove("inputsDigest");assertThat(stored).isEqualTo(jobRepo.executionInputDigest(unsigned));
    }
    @Test void projectViewExposesOnlyStressCapacityAndItsAuthoritativeSources()throws Exception {
        var f=configured();
        member(f,get(f.url()+"/execution-agents"),Map.of()).andExpect(status().isOk())
            .andExpect(jsonPath("$.agents[0].stressConfiguration.agent.maxStressProcesses").value(6))
            .andExpect(jsonPath("$.agents[0].stressConfiguration.agent.inputCacheBytes").doesNotExist())
            .andExpect(jsonPath("$.agents[0].stressConfiguration.sources['agent.maxStressRps']").value("default"))
            .andExpect(jsonPath("$.agents[0].stressConfiguration.sources['policy.maxStressRps']").value("default"));
    }
    @Test void fixesExecutorAndClaimRuntimeInIndependentStressMetadata()throws Exception {
        var f=configured();String job=claimStress(f,"fixed-executor");
        var inputs=jobRepo.inputs(Long.valueOf(job));assertThat(inputs.path("stressExecutor").path("id").asText()).isEqualTo(f.agent());assertThat(inputs.path("stressExecutor").path("name").asText()).isEqualTo("task-six");
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk())
            .andExpect(jsonPath("$.stressMetadata.executor.id").value(f.agent()))
            .andExpect(jsonPath("$.stressMetadata.executor.name").value("task-six"))
            .andExpect(jsonPath("$.stressMetadata.runtime.coreBuildId").value(HASH))
            .andExpect(jsonPath("$.stressMetadata.processes").value(3))
            .andExpect(jsonPath("$.stressMetadata.status.preparation").value("preparing"));
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"ready","running","completed","upload"})
    void stressMetadataTracksExecutionAndUploadIndependently(String transition)throws Exception {
        var f=configured();String job=claimStress(f,"metadata-"+transition);
        send(f,message(job,"accepted","accepted-metadata")).andExpect(status().isOk());send(f,stressStart(job)).andExpect(status().isOk());
        if(transition.equals("ready")){member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.stressMetadata.status.preparation").value("ready"));return;}
        var started=message(job,"started","started-metadata");started.put("permitId",jobRepo.require(Long.valueOf(job),false).permitId());started.put("startedAt","2030-01-01T00:00:00Z");send(f,started).andExpect(status().isOk());
        if(transition.equals("running")){member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.stressMetadata.status.execution").value("running"));return;}
        var ended=message(job,"completed","completed-metadata");ended.putAll(Map.of("verdict","failed","finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",true));send(f,ended).andExpect(status().isOk());
        if(transition.equals("completed")){member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.stressMetadata.status.execution").value("failed")).andExpect(jsonPath("$.stressMetadata.status.upload").value("pending"));return;}
        byte[] bytes="{\"kind\":\"stress-failure\",\"started\":true,\"requests\":{\"started\":1,\"completed\":0},\"error\":\"safe failure\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",Hashes.sha256Hex(bytes)).contentType("application/octet-stream").content(bytes)).andExpect(status().isOk());
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.stressMetadata.status.execution").value("failed")).andExpect(jsonPath("$.stressMetadata.status.upload").value("complete"));
        assertThat(jobRepo.reportContent(Long.valueOf(job))).isEqualTo(bytes);
    }
    @Test void rejectsAnOrdinaryReportForAStressAssignment()throws Exception {
        var f=configured();String job=claimStress(f,"wrong-report-kind");byte[] bytes="{\"kind\":\"suite\",\"result\":{\"totals\":{\"failed\":0}}}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",Hashes.sha256Hex(bytes)).contentType("application/octet-stream").content(bytes)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("report_type_mismatch"));
        assertThat(jobRepo.require(Long.valueOf(job),false).reportState()).isEqualTo("pending");
    }
    @Test void archivesTheAgentStressEnvelopeWithoutRewritingItsBytes()throws Exception {
        var f=configured();String job=claimStress(f,"agent-stress-envelope");
        byte[] bytes=json.writeValueAsBytes(Map.of("executionId",execution(job),"verdict","failed","executionFact","not-started","output",Map.of("kind","stress-failure","started",false,"requests",Map.of("started",0,"completed",0),"error","Safe preparation failure")));
        String hash=Hashes.sha256Hex(bytes);
        for(int n=0;n<2;n++)mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",hash).contentType("application/octet-stream").content(bytes)).andExpect(status().isOk()).andExpect(jsonPath("$.reportHash").value(hash)).andExpect(jsonPath("$.reportBytes").value(bytes.length));
        assertThat(jobRepo.reportContent(Long.valueOf(job))).isEqualTo(bytes);
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.reportKind").value("stress-failure"));
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"ordinary","wrong-execution","passed-failure","unknown-fact"})
    void refusesAgentStressEnvelopesThatContradictTheAssignment(String invalid)throws Exception {
        var f=configured();String job=claimStress(f,"invalid-agent-envelope-"+invalid);
        var body=new LinkedHashMap<String,Object>();body.putAll(Map.of("executionId",execution(job),"verdict","failed","executionFact","not-started","output",Map.of("kind","stress-failure","started",false,"requests",Map.of("started",0,"completed",0),"error","Safe failure")));
        if(invalid.equals("ordinary"))body.put("output",Map.of("kind","suite","result",Map.of("total",0)));
        if(invalid.equals("wrong-execution"))body.put("executionId","999999");
        if(invalid.equals("passed-failure"))body.put("verdict","passed");
        if(invalid.equals("unknown-fact"))body.put("executionFact","untrusted");
        byte[] bytes=json.writeValueAsBytes(body);
        mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",Hashes.sha256Hex(bytes)).contentType("application/octet-stream").content(bytes)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("report_type_mismatch"));
        assertThat(jobRepo.require(Long.valueOf(job),false).reportState()).isEqualTo("pending");
    }
    @Test void archivesTheTypedFailureBytesIdempotentlyWithoutRewritingTheReport()throws Exception {
        var f=configured();String job=claimStress(f,"typed-report");byte[] bytes="{\"kind\":\"stress-failure\", \"started\":false,\"requests\":{\"started\":0,\"completed\":0},\"error\":\"safe failure\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);String hash=Hashes.sha256Hex(bytes);
        for(int n=0;n<2;n++)mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",hash).contentType("application/octet-stream").content(bytes)).andExpect(status().isOk()).andExpect(jsonPath("$.reportHash").value(hash));
        assertThat(jobRepo.reportContent(Long.valueOf(job))).isEqualTo(bytes);
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.reportKind").value("stress-failure"));
        assertThat(jdbc.queryForObject("SELECT processes FROM execution_stress_reservations WHERE job_id=?",Long.class,Long.valueOf(job))).isEqualTo(3);
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource({"upload-first,passed,result-capacity-exceeded","completed-first,passed,result-persistence-failed","upload-first,failed,worker-exited","completed-first,failed,worker-exited"})
    void archivesMinimalStressFaultEnvelopesInEitherMessageOrder(String order,String verdict,String reason)throws Exception {
        var f=configured();String job=claimStress(f,"stress-fault-"+order+"-"+verdict);
        send(f,message(job,"accepted","fault-accepted")).andExpect(status().isOk());send(f,stressStart(job)).andExpect(status().isOk());
        byte[] bytes=json.writeValueAsBytes(Map.of("executionId",execution(job),"verdict",verdict,"executionFact","started","reasonCode",reason));String hash=Hashes.sha256Hex(bytes);
        var completed=message(job,"completed","fault-completed");completed.putAll(Map.of("verdict",verdict,"finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",false,"reportHash",hash,"reportBytes",bytes.length));
        if(order.equals("completed-first"))send(f,completed).andExpect(status().isOk());
        mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",hash).contentType("application/octet-stream").content(bytes)).andExpect(status().isOk());
        if(order.equals("upload-first"))send(f,completed).andExpect(status().isOk());
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.reportKind").value("stress-fault")).andExpect(jsonPath("$.summary.verdict").value(verdict));
        assertThat(jobRepo.reportContent(Long.valueOf(job))).isEqualTo(bytes);
    }
    @Test void rejectsACompletedVerdictThatDisagreesWithTheUploadedAgentEnvelope()throws Exception {
        var f=configured();String job=claimStress(f,"agent-envelope-verdict-conflict");
        send(f,message(job,"accepted","envelope-accepted")).andExpect(status().isOk());send(f,stressStart(job)).andExpect(status().isOk());
        byte[] bytes=json.writeValueAsBytes(Map.of("executionId",execution(job),"verdict","failed","executionFact","started","output",Map.of("kind","stress-failure","started",true,"requests",Map.of("started",1,"completed",0),"error","Safe failure")));String hash=Hashes.sha256Hex(bytes);
        mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",hash).contentType("application/octet-stream").content(bytes)).andExpect(status().isOk());
        var ended=message(job,"completed","contradicting-envelope-verdict");ended.putAll(Map.of("verdict","interrupted","finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",false,"reportHash",hash,"reportBytes",bytes.length));
        send(f,ended).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("report_type_mismatch"));
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"upload-first","cancel-first"})
    void preservesCancelConfirmationWhenTheAgentEnvelopeHasAnEarlierVerdict(String order)throws Exception {
        var f=configured();String job=claimStress(f,"agent-envelope-cancel-"+order);
        send(f,message(job,"accepted","cancel-envelope-accepted")).andExpect(status().isOk());send(f,stressStart(job)).andExpect(status().isOk());
        byte[] bytes=json.writeValueAsBytes(Map.of("executionId",execution(job),"verdict","failed","executionFact","started","output",Map.of("kind","stress-failure","started",true,"requests",Map.of("started",1,"completed",0),"error","Safe failure")));String hash=Hashes.sha256Hex(bytes);
        member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isOk());
        var ended=message(job,"cancel-confirmed","cancel-envelope-confirmed");ended.putAll(Map.of("finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",false));
        if(order.equals("cancel-first"))send(f,ended).andExpect(status().isOk());
        mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",hash).contentType("application/octet-stream").content(bytes)).andExpect(status().isOk());
        if(order.equals("upload-first"))send(f,ended).andExpect(status().isOk());
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.summary.verdict").value("cancelled"));
    }
    @Test void savesStressCapacitySeparatelyFromOrdinaryTaskCapacity() throws Exception {
        var f=fixture();
        member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","0","config",Map.of(
            "maxConcurrentJobs",2,"maxConcurrentStressJobs",1,"maxStressProcesses",3,"maxStressRps",1.5)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.config.maxConcurrentJobs").value(2))
            .andExpect(jsonPath("$.config.maxStressProcesses").value(3)).andExpect(jsonPath("$.config.maxStressRps").value(1.5));
    }
    @Test void stressCapacityPatchPreservesVersionAndRejectsInvalidRelations() throws Exception {
        var f=fixture();
        member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","0","config",Map.of("maxConcurrentJobs",2,"maxConcurrentStressJobs",2))).andExpect(status().isOk());
        member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","0","config",Map.of("maxStressProcesses",4))).andExpect(status().isConflict());
        for(var patch:List.of(Map.of("maxConcurrentStressJobs",3),Map.of("maxStressVus",1001),Map.of("stressProgressIntervalMs",249),Map.of("maxStressProcesses",1.5),Map.of("maxStressRps",0)))
            member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","1","config",patch)).andExpect(status().isBadRequest());
        member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","1","config",Map.of("maxConcurrentStressJobs",0))).andExpect(status().isOk());
    }
    @Test void stageFinalCancelRequiresTheSubmitterOrCurrentProjectAdministrator()throws Exception{
        var f=fixture();String job=seed(f,"preparing");
        String username="cancel-editor-"+f.project();
        var registered=body(mvc.perform(post("/api/v1/auth/register").contentType("application/json").content(json.writeValueAsString(Map.of("username",username,"password","password8","displayName","Other editor")))).andExpect(status().isCreated()));
        String user=registered.path("id").asText();
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",username,"password","password8")))).andExpect(status().isOk())).path("token").asText();
        member(f,put("/api/v1/workspaces/"+f.ws()+"/members/"+user),Map.of("role","EDITOR")).andExpect(status().isOk());
        var editor=new F(token,f.ws(),f.group(),f.project(),f.snapshot(),f.agent(),f.agentToken(),f.assets());
        member(editor,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isForbidden());
        assertThat(jdbc.queryForObject("SELECT cancel_state FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job))).isEqualTo("none");
        member(editor,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.canCancel").value(false));
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.canCancel").value(true));
        String own=body(member(editor,post(f.url()+"/jobs"),submission(f,"editor-own-job")).andExpect(status().isCreated())).path("jobId").asText();
        member(editor,post("/api/v1/jobs/"+own+"/cancel"),Map.of()).andExpect(status().isOk());
        member(f,put("/api/v1/workspaces/"+f.ws()+"/members/"+user),Map.of("role","ADMIN")).andExpect(status().isOk());
        member(editor,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isOk());
        member(f,delete("/api/v1/workspaces/"+f.ws()+"/members/"+user),Map.of()).andExpect(status().isNoContent());
        jdbc.update("UPDATE users SET role='SUPERADMIN' WHERE id=?",Long.valueOf(user));
        jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) VALUES(?,?,?,'ADMIN',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),Long.valueOf(user));
        member(editor,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isForbidden());
    }
    @Test void stageFinalHistoryUsesEachPersistedPermitScriptTimeoutRatherThanCurrentPolicy()throws Exception{
        var f=fixture();String first=seed(f,"preparing");send(f,start(first)).andExpect(status().isOk());
        var ended=message(first,"completed","historical-first-end");ended.putAll(Map.of("verdict","passed","finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",true));send(f,ended).andExpect(status().isOk());
        member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","1","policy",Map.of("scriptTimeoutMs",1250))).andExpect(status().isOk());
        String second=seed(f,"preparing");send(f,start(second)).andExpect(status().isOk());
        member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","2","policy",Map.of("scriptTimeoutMs",750))).andExpect(status().isOk());
        assertThat(jobRepo.require(Long.parseLong(first),false).permit().path("effectivePolicy").path("scriptTimeoutMs").asLong()).isEqualTo(3000);
        assertThat(jobRepo.require(Long.parseLong(second),false).permit().path("effectivePolicy").path("scriptTimeoutMs").asLong()).isEqualTo(1250);
        org.junit.jupiter.api.Assertions.assertAll(
            ()->member(f,get("/api/v1/jobs/"+first),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.scriptTimeoutMs").value(3000)),
            ()->member(f,get("/api/v1/jobs/"+second),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.scriptTimeoutMs").value(1250)));
    }
    @Test void taskSevenDeclaredAttachmentCopiesAreBudgetedAndNetworkInputIsFixed()throws Exception{
        var f=fixture();String content=java.util.Base64.getEncoder().encodeToString("upload-copy".getBytes());
        var attachment=body(member(f,post(f.url()+"/attachments"),Map.of("refId","upload","expectedVersion","0","kind","file","contentBase64",content)).andExpect(status().isCreated()));
        var ref=Map.of("refId","upload","version",attachment.get("version").asText(),"hash",attachment.get("hash").asText());
        var s=submission(f,"mapped-input");s.put("materials",Map.of("projectId",f.project(),"credentials",List.of(),"attachments",List.of(ref),"attachmentPaths",Map.of("one.bin",ref,"two.bin",ref)));
        s.put("network",Map.of("revision","net-1","configuration",Map.of("formatVersion",1,"profiles",List.of(),"environmentSelections",List.of())));
        String job=body(member(f,post(f.url()+"/jobs"),s).andExpect(status().isCreated())).get("jobId").asText();beat(f,1,0);
        long actual=jdbc.queryForObject("SELECT reserved_input_bytes FROM execution_jobs WHERE id=?",Long.class,Long.valueOf(job));
        long snapshot=f.assets().get("files").get(0).get("size").asLong();assertThat(actual).isEqualTo(snapshot+22+json.writeValueAsBytes(s.get("network")).length);
        var inputs=body(mvc.perform(get("/api/v1/runner/jobs/"+job+"/inputs").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken())).andExpect(status().isOk()));
        assertThat(inputs.path("network").path("revision").asText()).isEqualTo("net-1");assertThat(inputs.path("materials").path("attachmentPaths").size()).isEqualTo(2);
    }
    // Missing intent persistence duplicates side effects; distinct human submissions must remain distinct.
    @Test void submissionIntentPersistsExactlyOneExecutionWhileNewIntentRemainsIndependent()throws Exception{
        var f=fixture();var s=submission(f,"click-one");var first=body(member(f,post(f.url()+"/jobs"),s).andExpect(status().isCreated()));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isEqualTo(1);
        wire("submit-job",s);var again=body(member(f,post(f.url()+"/jobs"),s).andExpect(status().isCreated()));assertThat(again.get("jobId")).isEqualTo(first.get("jobId"));
        var other=body(member(f,post(f.url()+"/jobs"),submission(f,"click-two")).andExpect(status().isCreated()));assertThat(other.get("executionId")).isNotEqualTo(first.get("executionId"));
        var batch=beat(f,1,0);assertThat(batch.get("deliveries")).as("claim summary: %s",jobRepo.require(Long.parseLong(first.get("jobId").asText()),false).summary()).hasSize(1);wire("delivery-batch",batch);String assigned=batch.get("deliveries").get(0).get("task").get("jobId").asText();wire("execution-inputs-real",body(mvc.perform(get("/api/v1/runner/jobs/"+assigned+"/inputs").param("executionId",execution(assigned)).header("Authorization","Bearer "+f.agentToken())).andExpect(status().isOk())));
    }
    @Test void reusedIntentWithDifferentPayloadConflicts()throws Exception{
        var f=fixture();var s=submission(f,"collision");member(f,post(f.url()+"/jobs"),s).andExpect(status().isCreated());s.put("runConfig",Map.of("jobTimeoutMs",70000));member(f,post(f.url()+"/jobs"),s).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("intent_conflict"));
    }
    @Test void cancelApplicationRemainsDistinctFromAgentRelease()throws Exception{
        var f=fixture();String job=seed(f,"preparing");member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.cancelState").value("requested"));
        assertThat(state(job)).isEqualTo("preparing");assertThat(beat(f,0,0).get("commands").toString()).contains("cancel");
        var m=message(job,"cancel-confirmed","cancelled-"+job);m.put("finishedAt","2026-10-26T01:00:00Z");m.put("executionReleased",true);m.put("evidenceComplete",true);send(f,m).andExpect(status().isOk());
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.state").value("ended")).andExpect(jsonPath("$.cancelState").value("confirmed"));
    }
    @Test void fixedInputsKeepRequestSettingsAndRequireCurrentAssignment()throws Exception{
        var f=fixture();String job=seed(f,"preparing");var response=mvc.perform(get("/api/v1/runner/jobs/"+job+"/inputs").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken())).andExpect(status().isOk()).andExpect(jsonPath("$.runConfig.requestSettings.totalTimeoutMs").value(12345)).andExpect(jsonPath("$.snapshot.assets.files[0].content").value("name: task-six\n"));wire("execution-inputs",body(response));
        mvc.perform(get("/api/v1/runner/jobs/"+job+"/inputs").param("executionId","999").header("Authorization","Bearer "+f.agentToken())).andExpect(status().isForbidden());
        agent(f,post("/api/v1/runner/jobs/"+job+"/materials"),Map.of("executionId",execution(job))).andExpect(status().isOk()).andExpect(jsonPath("$.snapshotId").value(f.snapshot()));
    }
    @Test void resultArchiveChecksSummaryHashAndLengthAndIsIdempotent()throws Exception{
        var f=fixture();String job=seed(f,"ended");byte[] report="{\"verdict\":\"passed\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);String hash=Hashes.sha256Hex(report);
        jdbc.update("UPDATE execution_jobs SET execution_released=TRUE,summary_json=?,report_hash=?,report_bytes=? WHERE id=?","{\"verdict\":\"passed\"}",hash,report.length,Long.valueOf(job));
        var request=put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",hash).contentType("application/octet-stream").content(report);
        mvc.perform(request).andExpect(status().isOk()).andExpect(jsonPath("$.archived").value(true));mvc.perform(request).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT report_content FROM execution_jobs WHERE id=?",byte[].class,Long.valueOf(job))).isEqualTo(report);
        mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",HASH).contentType("application/octet-stream").content(report)).andExpect(status().isConflict());
    }
    @Test void jobQueriesReauthorizeCurrentProjectRights()throws Exception{
        var f=fixture();String job=seed(f,"preparing");jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) SELECT ?,?,id,'NONE',CURRENT_TIMESTAMP FROM users WHERE username='admin'",Long.valueOf(f.ws()),Long.valueOf(f.project()));member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isForbidden());
    }
    @Test void submitEnforcesQueueBudgetAndDoesNotTrustAnotherSnapshotScope()throws Exception{
        var f=fixture();seed(f,"queued");member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","1","policy",Map.of("maxQueuedJobs",1))).andExpect(status().isOk());member(f,post(f.url()+"/jobs"),submission(f,"over-queue")).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("queue_capacity"));
        var s=submission(f,"wrong-scope");preparation(s).put("scope",Map.of("workspaceId",f.ws(),"groupId",f.group(),"projectId","999"));member(f,post(f.url()+"/jobs"),s).andExpect(status().isForbidden());
    }
    @Test void debugSessionIdleStartsAfterLastAuthoritativeRelease()throws Exception{
        var f=fixture();member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","0","config",Map.of("debugSessionIdleMs",60000,"maxDebugSessions",1))).andExpect(status().isOk());
        registerRuntime(f,"session-one","1");
        var first=body(member(f,post(f.url()+"/jobs"),debugSubmission(f,"debug-one")).andExpect(status().isCreated()));String handle=first.path("task").path("debugSessionId").asText();
        jdbc.update("UPDATE execution_debug_sessions SET expires_at=TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00' WHERE handle=?",handle);
        var secondSubmit=debugSubmission(f,"debug-two");secondSubmit.put("debugSessionId",handle);
        var second=body(member(f,post(f.url()+"/jobs"),secondSubmit).andExpect(status().isCreated()));
        String firstJob=first.get("jobId").asText();beat(f,1,0);
        send(f,message(firstJob,"accepted","active-session-accepted")).andExpect(status().isOk());
        var prepared=start(firstJob);prepared.put("inputsDigest",jdbc.queryForObject("SELECT inputs_digest FROM execution_jobs WHERE id=?",String.class,Long.valueOf(firstJob)));send(f,prepared).andExpect(status().isOk());
        member(f,post("/api/v1/jobs/"+first.get("jobId").asText()+"/cancel"),Map.of()).andExpect(status().isOk());
        var release=message(firstJob,"cancel-confirmed","active-session-released");release.putAll(Map.of("finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",true));send(f,release).andExpect(status().isOk());send(f,release).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT expires_at FROM execution_debug_sessions WHERE handle=?",OffsetDateTime.class,handle).toInstant()).isEqualTo(Instant.parse("2000-01-01T00:00:00Z"));
        member(f,post("/api/v1/jobs/"+second.get("jobId").asText()+"/cancel"),Map.of()).andExpect(status().isOk());
        var idle=jdbc.queryForObject("SELECT expires_at FROM execution_debug_sessions WHERE handle=?",OffsetDateTime.class,handle);assertThat(idle.toInstant()).isEqualTo(Instant.parse("2030-01-01T00:01:00Z"));
        clock.set(Instant.parse("2030-01-01T00:00:30Z"));member(f,post("/api/v1/jobs/"+second.get("jobId").asText()+"/cancel"),Map.of()).andExpect(status().isOk());assertThat(jdbc.queryForObject("SELECT expires_at FROM execution_debug_sessions WHERE handle=?",OffsetDateTime.class,handle)).isEqualTo(idle);
        var reuse=debugSubmission(f,"debug-three");reuse.put("debugSessionId",handle);var third=body(member(f,post(f.url()+"/jobs"),reuse).andExpect(status().isCreated()));member(f,post("/api/v1/jobs/"+third.get("jobId").asText()+"/cancel"),Map.of()).andExpect(status().isOk());clock.set(Instant.parse("2030-01-01T00:02:00Z"));var expired=debugSubmission(f,"debug-expired");expired.put("debugSessionId",handle);member(f,post(f.url()+"/jobs"),expired).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("debug_session_expired"));
    }
    @Test void activeDebugSessionStillCountsAgainstCapacityAfterIdleTimestampPasses()throws Exception{
        var f=fixture();member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","0","config",Map.of("maxDebugSessions",1))).andExpect(status().isOk());var first=body(member(f,post(f.url()+"/jobs"),debugSubmission(f,"active-debug")).andExpect(status().isCreated()));jdbc.update("UPDATE execution_debug_sessions SET expires_at=TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00' WHERE handle=?",first.path("task").path("debugSessionId").asText());member(f,post(f.url()+"/jobs"),debugSubmission(f,"new-debug")).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("debug_session_capacity"));
    }
    @Test void statusAndListDoNotLoadSnapshotOrReportData()throws Exception{
        var f=fixture();String job=seed(f,"ended");jdbc.update("UPDATE execution_jobs SET inputs_json='not-json',submission_json='not-json',report_content=? WHERE id=?",new byte[1024],Long.valueOf(job));
        org.junit.jupiter.api.Assertions.assertAll(
            ()->member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.jobId").value(job)),
            ()->member(f,get(f.url()+"/jobs"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$[0].jobId").value(job)));
    }
    @Test void historyListUsesConfiguredBoundAndCursor()throws Exception{
        var f=fixture();for(int i=0;i<4;i++)seed(f,"ended");var page=body(member(f,get(f.url()+"/jobs"),Map.of()).andExpect(status().isOk()));assertThat(page).hasSize(2);
        var next=body(member(f,get(f.url()+"/jobs").param("beforeJobId",page.get(1).get("jobId").asText()).param("limit","3"),Map.of()).andExpect(status().isOk()));assertThat(next).hasSize(2);assertThat(next.get(0).get("jobId")).isNotEqualTo(page.get(0).get("jobId"));member(f,get(f.url()+"/jobs").param("limit","4"),Map.of()).andExpect(status().isBadRequest());
    }
    @Test void submitRejectsInvalidPublicCoreInputStructuresBeforePersistence()throws Exception{
        var f=fixture();var debug=debugSubmission(f,"invalid-debug");debug.put("target",Map.of("kind","debug","invocation",Map.of()));var run=submission(f,"invalid-run");run.put("runConfig",Map.of("requestSettings",Map.of("totalTimeoutMs",-1)));
        org.junit.jupiter.api.Assertions.assertAll(
            ()->member(f,post(f.url()+"/jobs"),debug).andExpect(status().isBadRequest()),
            ()->member(f,post(f.url()+"/jobs"),run).andExpect(status().isBadRequest()));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
        var legal=debugSubmission(f,"nested-core-boundary");var target=json.valueToTree(legal.get("target"));
        var invocation=(com.fasterxml.jackson.databind.node.ObjectNode)target.get("invocation");invocation.put("mode","request");invocation.remove("case");
        invocation.set("request",json.readTree("""
            {"protocol":"http","method":"GET","baseUrl":"https://example.invalid","path":"/",
             "pathParams":[],"headers":[],"cookies":[],"query":[{"kind":"inline",
             "id":"10000000-0000-4000-8000-000000000001","name":"nested","required":false,"enabled":true,"description":"",
             "schema":{"kind":"object","properties":{"child":{"kind":"modelRef","modelId":"10000000-0000-4000-8000-000000000001"},
             "value":{"kind":"scalar","type":"string","default":{"a":[1,true,null]}}},"required":[],"additionalProperties":false}}]}
            """));
        invocation.set("parameters",json.createObjectNode());invocation.set("fields",json.createArrayNode());legal.put("target",target);
        member(f,post(f.url()+"/jobs"),legal).andExpect(status().isCreated());wire("nested-core-submit",legal);
        var malformed=target.deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)malformed.at("/invocation/request/query/0/schema/properties/child")).put("modelId","not-a-uuid");legal.put("intentId","invalid-nested-core");legal.put("target",malformed);member(f,post(f.url()+"/jobs"),legal).andExpect(status().isBadRequest());wire("invalid-nested-core-submit",legal);
    }
}
