package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.execution.jobs.JobDtos;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

abstract class StressJobsFixture extends JobsFixture {
    void stressRuntime(F f,String session,String version)throws Exception {
        var registration=new LinkedHashMap<String,Object>();
        registration.put("protocolVersion",1);registration.put("sessionId",session);registration.put("coreBuildId",HASH);registration.put("scriptApiId",SCRIPT_API);
        registration.put("nodeVersion","22.19.0");registration.put("v8Version","12.4.254.21-node.29");registration.put("runtimeCompatibilityId",RUNTIME);
        registration.put("capabilities",List.of("task:debug","task:suite","task:stress","stress:local-workers-v1","protocol:http"));
        registration.put("configuration",Map.of("configVersion",version,"appliedConfigVersion",version,"pendingFields",List.of(),"restartRequiredFields",List.of(),"status","applied"));
        agent(f,post("/api/v1/runner/runtime"),registration).andExpect(status().isOk());
    }
    Map<String,Object> stress(F f,String intent){
        var s=submission(f,intent);
        s.put("target",Map.of("kind","stress","plan",Map.of("formatVersion",1,"target",Map.of("kind","case","collectionId","http","apiId","get","caseId","ok"),
            "load",Map.of("kind","constant-vus","vus",2),"maxVus",2,"termination",Map.of("maxIterations",2),"maxRequestConcurrency",2,"maxRps",1.5)));
        s.put("runConfig",Map.of("jobTimeoutMs",60000,"stress",Map.of("workerCount",2,"confirmedTargetOrigins",List.of("https://example.test"))));
        preparation(s).put("requiredCapabilities",List.of("task:stress","stress:local-workers-v1","protocol:http"));
        preparation(s).put("stressBinding",Map.of("stage","compiled-limits","admissionLimits",Map.of("maxVus",executionConfigs.agentValues(Long.valueOf(f.agent())).get("maxStressVus"),"maxRequestConcurrency",2,"maxRps",1.5),
            "requested",Map.of("maxRequestConcurrency",2,"maxRps",1.5),"sources",Map.of("maxRequestConcurrency","plan","maxRps","plan"),
            "evidenceMaxSamples",20,"numericMemoryBytes",1048576,"reservation",Map.of("jobs",1,"processes",3,"vus",2,"requestConcurrency",2,"maxRps",1.5,"metricMemoryBytes",3145728)));
        return s;
    }
    F configured()throws Exception {return configured(Map.of());}
    F configured(Map<String,Object> overrides)throws Exception {
        var f=fixture();
        var config=new LinkedHashMap<String,Object>(Map.of("maxConcurrentJobs",2,"maxConcurrentStressJobs",2,"maxStressProcesses",6));config.putAll(overrides);
        member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","0","config",config)).andExpect(status().isOk());
        member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","1","policy",Map.of("stressMetricMemoryBytes",1048576))).andExpect(status().isOk());
        return f;
    }
    String claimStress(F f,String intent)throws Exception {
        String job=body(member(f,post(f.url()+"/jobs"),stress(f,intent)).andExpect(status().isCreated())).path("jobId").asText();
        stressRuntime(f,"stress-session","1");
        var batch=body(agent(f,post("/api/v1/runner/heartbeat"),new JobDtos.Exchange("stress-session","1",2L,0L,List.of())).andExpect(status().isOk()));
        assertThat(batch.path("deliveries").toString()).contains("\"jobId\":\""+job+"\"");return job;
    }
    Map<String,Object> stressStart(String job){var m=start(job);m.put("policyVersion",jobRepo.require(Long.parseLong(job),false).task().path("policyVersion").asText());m.put("stressBinding",jobRepo.inputs(Long.parseLong(job)).get("stressBinding"));return m;}
    Map<String,Object> stressProgress(String job,long sequence,long requests){
        var m=message(job,"stress-progress","stress-progress-"+sequence);m.putAll(Map.of("sequence",sequence,"observedAt","2030-01-01T00:00:00Z","runId","core-run","state","running","atMs",1.5,"activeVus",2,"startedIterations",3,"completedIterations",1,"droppedIterations",0));
        m.put("phase","measurement");m.put("stageId",null);m.put("requests",Map.of("started",requests,"completed",requests,"eligibleCompleted",requests,"failed",0));
        var complete=Map.of("complete",true,"reasons",List.of());m.put("completeness",Map.of("execution",complete,"metrics",complete,"load",complete));return m;
    }
}

class StressResourceReservationsTest extends StressJobsFixture {
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"budget","exited-regression","peak-regression","false-complete"})
    void finalI2RejectsImpossibleOwnershipWithoutOverwritingLastAcceptedFacts(String mutation)throws Exception{
        var f=configured();String job=claimStress(f,"final-observation-guard-"+mutation);
        var good=mutation.equals("false-complete")?Map.of("completeness","partial","started",1,"exited",0,"peak",1):Map.of("completeness","complete","started",3,"exited",1,"peak",3);
        var first=stressProgress(job,1,0);first.put("processObservation",good);send(f,first).andExpect(status().isOk());
        var invalid=switch(mutation){case "budget"->Map.of("completeness","complete","started",4,"exited",1,"peak",4);case "exited-regression"->Map.of("completeness","complete","started",3,"exited",0,"peak",3);case "peak-regression"->Map.of("completeness","complete","started",3,"exited",1,"peak",2);default->Map.of("completeness","complete","started",1,"exited",0,"peak",1);};
        var bad=stressProgress(job,2,0);bad.put("processObservation",invalid);int code=send(f,bad).andReturn().getResponse().getStatus();
        var saved=body(member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk())).path("stressMetadata").path("processObservation");
        org.junit.jupiter.api.Assertions.assertAll(()->assertThat(code).isEqualTo(400),()->assertThat(saved).isEqualTo(json.valueToTree(good)));
    }
    @Test void finalI2PersistsBoundedMonotoneOwnershipProgressAndTerminalFacts()throws Exception {
        var f=configured();String job=claimStress(f,"final-observed-control");send(f,message(job,"accepted","final-observation-accepted")).andExpect(status().isOk());send(f,stressStart(job)).andExpect(status().isOk());
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.stressMetadata.processObservation").doesNotExist());
        var first=stressProgress(job,1,0);first.put("processObservation",Map.of("completeness","partial","started",1,"exited",0,"peak",1));
        send(f,first).andExpect(status().isOk());
        var complete=stressProgress(job,2,0);complete.put("processObservation",Map.of("completeness","complete","started",3,"exited",0,"peak",3));send(f,complete).andExpect(status().isOk());
        var end=message(job,"completed","final-observation-end");end.putAll(Map.of("verdict","failed","finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",false,"processObservation",Map.of("completeness","complete","started",3,"exited",3,"peak",3)));
        send(f,end).andExpect(status().isOk());send(f,end).andExpect(status().isOk());
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.stressMetadata.processObservation.started").value(3)).andExpect(jsonPath("$.stressMetadata.processObservation.exited").value(3)).andExpect(jsonPath("$.stressMetadata.processObservation.peak").value(3));
    }
    @Test void finalI3ProjectsZeroUsedAndExplicitlyPausedIntakeWithoutInventingAReservation()throws Exception {
        var f=configured(Map.of("maxConcurrentStressJobs",0));
        var capacity=body(member(f,get("/api/v1/agents/"+f.agent()),Map.of()).andExpect(status().isOk())).path("stressCapacity");
        for(String dimension:List.of("jobs","processes","vus","requestConcurrency","maxRps","metricMemoryBytes"))assertThat(capacity.path("used").path(dimension).asDouble(-1)).isZero();
        assertThat(capacity.path("limits").path("jobs").asInt(-1)).isZero();assertThat(capacity.path("drainingDimensions")).isEmpty();
    }
    @Test void finalM1ReplacesAnUnblockedStressReasonWithTheActualResultCacheWaitUntilArchive()throws Exception {
        var f=configured(Map.of("maxStressProcesses",3,"pendingResultBytes",20000000));String first=claimStress(f,"final-cache-first");
        String second=body(member(f,post(f.url()+"/jobs"),stress(f,"final-cache-second")).andExpect(status().isCreated())).path("jobId").asText();
        var heartbeat=new JobDtos.Exchange("stress-session","1",2L,0L,List.of());agent(f,post("/api/v1/runner/heartbeat"),heartbeat).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT capacity_wait_reason FROM execution_jobs WHERE id=?",String.class,Long.valueOf(second))).isEqualTo("stress.processes");
        var end=message(first,"completed","final-cache-released");end.putAll(Map.of("verdict","interrupted","finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",false));send(f,end).andExpect(status().isOk());
        agent(f,post("/api/v1/runner/heartbeat"),heartbeat).andExpect(status().isOk());
        assertThat(state(second)).isEqualTo("queued");assertThat(jdbc.queryForObject("SELECT reserved_result_bytes FROM execution_jobs WHERE id=?",Long.class,Long.valueOf(first))).isEqualTo(16777216);
        var waiting=body(member(f,get("/api/v1/jobs/"+second),Map.of()).andExpect(status().isOk()));
        org.assertj.core.api.SoftAssertions softly=new org.assertj.core.api.SoftAssertions();softly.assertThat(waiting.path("capacityWaitReason").asText()).isEqualTo("cache.result");softly.assertThat(waiting.has("capacityWait")).isFalse();
        byte[] report="{\"kind\":\"stress-failure\",\"started\":false,\"requests\":{\"started\":0,\"completed\":0},\"error\":\"not-started\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        mvc.perform(put("/api/v1/runner/jobs/"+first+"/report").param("executionId",execution(first)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",com.autumnharvestc.server.core.Hashes.sha256Hex(report)).contentType("application/octet-stream").content(report)).andExpect(status().isOk());
        agent(f,post("/api/v1/runner/heartbeat"),heartbeat).andExpect(status().isOk());assertThat(state(second)).isEqualTo("preparing");
        softly.assertThat(body(member(f,get("/api/v1/jobs/"+second),Map.of()).andExpect(status().isOk())).has("capacityWaitReason")).isFalse();softly.assertAll();
    }
    @Test void finalI3ProjectsTheAuthoritativeWaitAndDrainingNumbersWithoutScopeData()throws Exception {
        var f=configured(Map.of("maxStressProcesses",3));String first=claimStress(f,"final-capacity-first");
        String second=body(member(f,post(f.url()+"/jobs"),stress(f,"final-capacity-second")).andExpect(status().isCreated())).path("jobId").asText();
        agent(f,post("/api/v1/runner/heartbeat"),new JobDtos.Exchange("stress-session","1",2L,0L,List.of())).andExpect(status().isOk());
        assertThat(state(second)).isEqualTo("queued");
        var waiting=body(member(f,get("/api/v1/jobs/"+second),Map.of()).andExpect(status().isOk()));
        member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","1","config",Map.of("maxStressProcesses",2))).andExpect(status().isOk());
        var detail=body(member(f,get("/api/v1/agents/"+f.agent()),Map.of()).andExpect(status().isOk()));
        var project=body(member(f,get(f.url()+"/execution-agents"),Map.of()).andExpect(status().isOk())).path("agents").get(0);
        org.junit.jupiter.api.Assertions.assertAll(
            ()->assertThat(waiting.path("capacityWait")).isEqualTo(json.valueToTree(Map.of("dimension","processes","used",3,"requested",3,"limit",3,"draining",false))),
            ()->assertThat(detail.path("stressCapacity").path("used").path("processes").asInt(-1)).isEqualTo(3),
            ()->assertThat(detail.path("stressCapacity").path("used").path("maxRps").asDouble(-1)).isEqualTo(1.5),
            ()->assertThat(detail.path("stressCapacity").path("limits").path("processes").asInt(-1)).isEqualTo(2),
            ()->assertThat(detail.path("stressCapacity").path("drainingDimensions")).isEqualTo(json.valueToTree(List.of("processes"))),
            ()->assertThat(project.path("stressCapacity")).isEqualTo(detail.path("stressCapacity")));
        var end=message(first,"completed","final-capacity-release");end.putAll(Map.of("verdict","interrupted","finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",true));send(f,end).andExpect(status().isOk());
        var after=body(member(f,get("/api/v1/agents/"+f.agent()),Map.of()).andExpect(status().isOk())).path("stressCapacity");
        assertThat(after.path("used").path("processes").asInt(-1)).isZero();assertThat(after.path("drainingDimensions")).isEmpty();
    }
    @Test void finalI4PersistsPossibleContentionFromTheRealClaimConfiguration()throws Exception {
        var f=configured();String job=claimStress(f,"final-contention");
        var metadata=body(member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk())).path("stressMetadata");
        assertThat(metadata.path("contentionHints")).isEqualTo(json.valueToTree(List.of(Map.of("code","shared-agent-capacity","jobLimit",2,"stressJobLimit",2,"activeOtherJobs",0))));
        assertThat(metadata.path("contentionHints").toString()).doesNotContain("workspaceId","projectId","jobId","scope");
    }
    @Test void reservesCompiledValuesBelowAdmissionCeilingsWithAuthoritativeDefaultSources()throws Exception {
        var f=configured();member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","2","policy",Map.of("maxStressRps",1.5))).andExpect(status().isOk());
        var s=stress(f,"default-binding");var target=(com.fasterxml.jackson.databind.node.ObjectNode)json.valueToTree(s.get("target"));var plan=(com.fasterxml.jackson.databind.node.ObjectNode)target.get("plan");plan.remove(List.of("maxRequestConcurrency","maxRps"));s.put("target",target);
        var binding=(com.fasterxml.jackson.databind.node.ObjectNode)json.valueToTree(preparation(s).get("stressBinding"));
        ((com.fasterxml.jackson.databind.node.ObjectNode)binding.get("requested")).putNull("maxRequestConcurrency").putNull("maxRps");
        ((com.fasterxml.jackson.databind.node.ObjectNode)binding.get("admissionLimits")).put("maxRequestConcurrency",100);
        ((com.fasterxml.jackson.databind.node.ObjectNode)binding.get("sources")).put("maxRequestConcurrency","agent.maxStressRequestConcurrency:default").put("maxRps","policy.maxStressRps:project");preparation(s).put("stressBinding",binding);
        String job=body(member(f,post(f.url()+"/jobs"),s).andExpect(status().isCreated())).path("jobId").asText();stressRuntime(f,"stress-session","1");
        agent(f,post("/api/v1/runner/heartbeat"),new JobDtos.Exchange("stress-session","1",2L,0L,List.of())).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT request_concurrency FROM execution_stress_reservations WHERE job_id=?",Long.class,Long.valueOf(job))).isEqualTo(2);
        assertThat(jobRepo.inputs(Long.valueOf(job)).path("stressBinding").path("admissionLimits").path("maxRequestConcurrency").asLong()).isEqualTo(100);
        assertThat(jobRepo.inputs(Long.valueOf(job)).path("stressBinding").path("sources").path("maxRps").asText()).isEqualTo("policy.maxStressRps:project");
        var fixed=jobRepo.map(jobRepo.inputs(Long.valueOf(job)));String digest=(String)fixed.remove("inputsDigest");assertThat(jobRepo.executionInputDigest(fixed)).isEqualTo(digest);
        ((com.fasterxml.jackson.databind.node.ObjectNode)binding.get("sources")).put("maxRps","policy.maxStressRps:workspace");s.put("intentId","false-source");
        member(f,post(f.url()+"/jobs"),s).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("stress_binding_mismatch"));
    }
    @Test void projectDeletionDoesNotClearActiveReservationsOrIntroduceForeignKeyFailures()throws Exception {
        var f=configured();String job=claimStress(f,"project-delete");
        member(f,delete(f.url()),Map.of()).andExpect(status().isNoContent());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_stress_reservations WHERE job_id=?",Long.class,Long.valueOf(job))).isEqualTo(1);
        var end=message(job,"completed","deleted-project-exit");end.putAll(Map.of("verdict","interrupted","finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",true));send(f,end).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_stress_reservations WHERE job_id=?",Long.class,Long.valueOf(job))).isZero();
    }
    @Test void ordinaryTargetsCannotCarryStressRunSettingsWithoutABinding()throws Exception {
        var f=configured();var s=submission(f,"ordinary-run-bypass");s.put("runConfig",Map.of("stress",Map.of("workerCount",1)));
        member(f,post(f.url()+"/jobs"),s).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("stress_binding_mismatch"));
    }
    @Test void cancellationKeepsReservationsUntilExitConfirmationAndKeepsResultBudgetUntilArchive()throws Exception {
        var f=configured(Map.of("maxStressProcesses",3));String first=claimStress(f,"cancel-first");
        String second=body(member(f,post(f.url()+"/jobs"),stress(f,"cancel-second")).andExpect(status().isCreated())).path("jobId").asText();
        member(f,post("/api/v1/jobs/"+first+"/cancel"),Map.of()).andExpect(status().isOk());
        var exchange=new JobDtos.Exchange("stress-session","1",2L,0L,List.of());
        var batch=body(agent(f,post("/api/v1/runner/heartbeat"),exchange).andExpect(status().isOk()));
        assertThat(batch.path("deliveries")).hasSize(1);assertThat(state(second)).isEqualTo("queued");
        assertThat(jdbc.queryForObject("SELECT processes FROM execution_stress_reservations WHERE job_id=?",Long.class,Long.valueOf(first))).isEqualTo(3);
        var released=message(first,"cancel-confirmed","cancel-exit-confirmed");released.putAll(Map.of("finishedAt","2030-01-01T00:00:00Z","executionReleased",false,"evidenceComplete",true));send(f,released).andExpect(status().isBadRequest());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_stress_reservations WHERE job_id=?",Long.class,Long.valueOf(first))).isEqualTo(1);
        released.put("executionReleased",true);send(f,released).andExpect(status().isOk());send(f,released).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_stress_reservations WHERE job_id=?",Long.class,Long.valueOf(first))).isZero();
        assertThat(jdbc.queryForObject("SELECT reserved_result_bytes FROM execution_jobs WHERE id=?",Long.class,Long.valueOf(first))).isEqualTo(16777216);
        batch=body(agent(f,post("/api/v1/runner/heartbeat"),exchange).andExpect(status().isOk()));assertThat(batch.path("deliveries")).hasSize(1);assertThat(batch.path("deliveries").get(0).path("task").path("jobId").asText()).isEqualTo(second);
        byte[] report="{\"kind\":\"stress-failure\",\"started\":false,\"requests\":{\"started\":0,\"completed\":0},\"error\":\"Cancelled\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        mvc.perform(put("/api/v1/runner/jobs/"+first+"/report").param("executionId",execution(first)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",com.autumnharvestc.server.core.Hashes.sha256Hex(report)).contentType("application/octet-stream").content(report)).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT reserved_result_bytes FROM execution_jobs WHERE id=?",Long.class,Long.valueOf(first))).isZero();
    }
    @Test void concurrentHeartbeatsCannotReserveTheSameCapacityTwice()throws Exception {
        var f=configured(Map.of("maxStressProcesses",3));stressRuntime(f,"stress-session","1");
        for(String intent:List.of("race-one","race-two"))member(f,post(f.url()+"/jobs"),stress(f,intent)).andExpect(status().isCreated());
        var ready=new java.util.concurrent.CountDownLatch(2);var go=new java.util.concurrent.CountDownLatch(1);
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)){
            var actions=new ArrayList<java.util.concurrent.Future<com.fasterxml.jackson.databind.JsonNode>>();
            for(int i=0;i<2;i++)actions.add(pool.submit(()->{ready.countDown();assertThat(go.await(10,java.util.concurrent.TimeUnit.SECONDS)).isTrue();return body(agent(f,post("/api/v1/runner/heartbeat"),new JobDtos.Exchange("stress-session","1",2L,0L,List.of())).andExpect(status().isOk()));}));
            assertThat(ready.await(10,java.util.concurrent.TimeUnit.SECONDS)).isTrue();go.countDown();
            for(var action:actions)assertThat(action.get(10,java.util.concurrent.TimeUnit.SECONDS).path("deliveries")).hasSize(1);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_stress_reservations WHERE agent_id=?",Long.class,Long.valueOf(f.agent()))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT SUM(processes) FROM execution_stress_reservations WHERE agent_id=?",Long.class,Long.valueOf(f.agent()))).isEqualTo(3);
    }
    @Test void restartingServiceContextsRetainsReservationsAndOnlyRedeliversTheExistingAssignment()throws Exception {
        var f=configured(Map.of("maxStressProcesses",3));String first=claimStress(f,"restart-first");
        String second=body(member(f,post(f.url()+"/jobs"),stress(f,"restart-second")).andExpect(status().isCreated())).path("jobId").asText();
        for(int restart=0;restart<2;restart++){
            try(var context=new org.springframework.boot.builder.SpringApplicationBuilder(com.autumnharvestc.server.ApiccServerApplication.class).web(org.springframework.boot.WebApplicationType.NONE).run(
                "--spring.datasource.url=jdbc:h2:mem:apicc-jobs-t6;DB_CLOSE_DELAY=-1","--apicc.execution.materials.master-key-file="+KEY,
                "--apicc.server.admin-username=admin","--apicc.server.admin-password=admin-pass-2026","--apicc.execution.control-base-url=https://control.test/api/v1","--logging.level.root=WARN","--spring.main.banner-mode=off")){
                var durable=context.getBean(org.springframework.jdbc.core.JdbcTemplate.class);
                assertThat(durable.queryForObject("SELECT processes FROM execution_stress_reservations WHERE job_id=?",Long.class,Long.valueOf(first))).isEqualTo(3);
                var batch=context.getBean(com.autumnharvestc.server.execution.jobs.RunnerControlService.class).exchange(Long.parseLong(f.agent()),new JobDtos.Exchange("stress-session","1",2L,0L,List.of()));
                assertThat(batch.deliveries()).hasSize(1);assertThat(((Map<?,?>)batch.deliveries().getFirst().get("task")).get("jobId")).isEqualTo(first);
                assertThat(durable.queryForObject("SELECT state FROM execution_jobs WHERE id=?",String.class,Long.valueOf(second))).isEqualTo("queued");
                assertThat(durable.queryForObject("SELECT permit_id FROM execution_jobs WHERE id=?",String.class,Long.valueOf(first))).isNull();
            }
        }
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource({"maxStressProcesses,3,processes","maxStressVus,3,vus","maxStressRequestConcurrency,3,requestConcurrency","maxStressRps,2,maxRps","maxStressMetricMemoryBytes,5242880,metricMemoryBytes","maxConcurrentStressJobs,1,jobs"})
    void independentlyReservesEachStressDimension(String field,int capacity,String reason)throws Exception {
        var f=configured(Map.of(field,capacity));stressRuntime(f,"stress-session","1");
        String first=body(member(f,post(f.url()+"/jobs"),stress(f,"first")).andExpect(status().isCreated())).path("jobId").asText();
        String second=body(member(f,post(f.url()+"/jobs"),stress(f,"second")).andExpect(status().isCreated())).path("jobId").asText();
        var batch=body(agent(f,post("/api/v1/runner/heartbeat"),new JobDtos.Exchange("stress-session","1",2L,0L,List.of())).andExpect(status().isOk()));
        assertThat(batch.path("deliveries")).as(field+" must be the only binding resource").hasSize(1);
        assertThat(batch.path("deliveries").get(0).path("task").path("jobId").asText()).isEqualTo(first);
        assertThat(state(first)).isEqualTo("preparing");assertThat(state(second)).isEqualTo("queued");
        assertThat(jdbc.queryForObject("SELECT capacity_wait_reason FROM execution_jobs WHERE id=?",String.class,Long.valueOf(second))).isEqualTo("stress."+reason);
        var vector=jdbc.queryForMap("SELECT jobs,processes,vus,request_concurrency,max_rps,metric_memory_bytes FROM execution_stress_reservations WHERE job_id=?",Long.valueOf(first));
        assertThat(((Number)vector.get("processes")).longValue()).isEqualTo(3);assertThat(((Number)vector.get("request_concurrency")).longValue()).isEqualTo(2);
        assertThat(((Number)vector.get("max_rps")).doubleValue()).isEqualTo(1.5);assertThat(((Number)vector.get("metric_memory_bytes")).longValue()).isEqualTo(3145728);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_stress_reservations WHERE agent_id=?",Long.class,Long.valueOf(f.agent()))).isEqualTo(1);
    }
    @Test void registersExplicitStressRuntimeCapabilities()throws Exception {
        var f=fixture();stressRuntime(f,"stress-session","0");
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"source","admission","requested","processes","vus","memory","budget","workers","environment","ordinary-binding","missing-capability"})
    void rejectsBindingsThatDisagreeWithAuthoritativeInputs(String mutation)throws Exception {
        var f=configured();var s=stress(f,"invalid-"+mutation);
        var b=(com.fasterxml.jackson.databind.node.ObjectNode)json.valueToTree(preparation(s).get("stressBinding"));
        switch(mutation){
            case "source"->((com.fasterxml.jackson.databind.node.ObjectNode)b.get("sources")).put("maxRps","policy.maxStressRps:project");
            case "admission"->((com.fasterxml.jackson.databind.node.ObjectNode)b.get("admissionLimits")).put("maxVus",99);
            case "requested"->((com.fasterxml.jackson.databind.node.ObjectNode)b.get("requested")).put("maxRps",1.4);
            case "processes"->((com.fasterxml.jackson.databind.node.ObjectNode)b.get("reservation")).put("processes",2);
            case "vus"->((com.fasterxml.jackson.databind.node.ObjectNode)b.get("reservation")).put("vus",1);
            case "memory"->((com.fasterxml.jackson.databind.node.ObjectNode)b.get("reservation")).put("metricMemoryBytes",1048576);
            case "budget"->b.put("numericMemoryBytes",2097152);
            case "workers"->s.put("runConfig",Map.of("stress",Map.of("workerCount",5)));
            case "environment"->s.put("environmentId",UUID);
            case "ordinary-binding"->s.put("target",submission(f,"ordinary").get("target"));
            case "missing-capability"->preparation(s).put("requiredCapabilities",List.of("task:suite","protocol:http"));
        }
        if(mutation.equals("environment")){
            var target=(com.fasterxml.jackson.databind.node.ObjectNode)json.valueToTree(s.get("target"));((com.fasterxml.jackson.databind.node.ObjectNode)target.get("plan")).put("environmentId","20000000-0000-4000-8000-000000000002");s.put("target",target);
        }
        preparation(s).put("stressBinding",b);
        member(f,post(f.url()+"/jobs"),s).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("stress_binding_mismatch"));
    }
    @Test void acceptsAndClaimsAValidStressJobAlongsideOrdinaryDebug()throws Exception {
        var f=configured();
        String ordinary=body(member(f,post(f.url()+"/jobs"),debugSubmission(f,"ordinary-proof")).andExpect(status().isCreated())).path("jobId").asText();
        registerRuntime(f,"session-one","1");
        assertThat(body(agent(f,post("/api/v1/runner/heartbeat"),new JobDtos.Exchange("session-one","1",1L,0L,List.of())).andExpect(status().isOk())).path("deliveries")).hasSize(1);
        var done=message(ordinary,"completed","ordinary-release");done.putAll(Map.of("verdict","interrupted","finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",true));send(f,done).andExpect(status().isOk());
        String job=body(member(f,post(f.url()+"/jobs"),stress(f,"stress-proof")).andExpect(status().isCreated())).path("jobId").asText();
        // A capability-bearing session is required before the actual stress delivery assertion.
        stressRuntime(f,"stress-session","1");
        var claimed=body(agent(f,post("/api/v1/runner/heartbeat"),new JobDtos.Exchange("stress-session","1",2L,0L,List.of())).andExpect(status().isOk()));
        assertThat(claimed.path("deliveries")).hasSize(1);assertThat(claimed.path("deliveries").get(0).path("task").path("jobId").asText()).isEqualTo(job);
        assertThat(state(job)).isEqualTo("preparing");
    }
}
