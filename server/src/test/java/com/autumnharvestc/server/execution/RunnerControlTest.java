package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.core.Hashes;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class RunnerControlTest extends JobsFixture {
    void assertStartRejected(F f,String job,Map<String,Object> message,String reason)throws Exception{
        send(f,message).andExpect(status().isOk()).andExpect(jsonPath("$.acknowledged[0]").value(message.get("messageId")));
        var saved=jobRepo.require(Long.parseLong(job),false);assertThat(saved.permitId()).isNull();assertThat(saved.released()).isFalse();assertThat(saved.state()).isEqualTo("preparing");
        assertThat(jobRepo.pending(Long.parseLong(f.agent()),"command")).anySatisfy(command->{assertThat(command.get("kind")).isEqualTo("start-rejected");assertThat(command.get("jobId")).isEqualTo(job);assertThat(command.get("reasonCode")).isEqualTo(reason);});
    }
    @Test void stageFinalDefiniteStartRejectionIsDurableUntilAgentReleaseAndDoesNotBlockTheNextTask()throws Exception{
        var f=fixture();var scripted=scripted(f);String job=seed(f,"queued",scripted);
        var claimed=body(agent(f,post("/api/v1/runner/heartbeat"),new com.autumnharvestc.server.execution.jobs.JobDtos.Exchange("session-one","1",1L,0L,List.of())).andExpect(status().isOk()));
        assertThat(claimed.path("deliveries")).hasSize(1);assertThat(state(job)).isEqualTo("preparing");
        send(f,message(job,"accepted","accepted-rejected-start")).andExpect(status().isOk());
        member(f,put(f.url()+"/script-grants"),Map.of("agentId",f.agent(),"expectedVersion","1","scope","script-version","scripts",List.of(),"riskConfirmed",false)).andExpect(status().isOk());
        var start=scriptStart(job,scripted);
        send(f,start).andExpect(status().isOk()).andExpect(jsonPath("$.acknowledged[0]").value("start-"+job));
        var exchange=new com.autumnharvestc.server.execution.jobs.JobDtos.Exchange("session-one","1",0L,0L,List.of());
        var batch=body(agent(f,post("/api/v1/runner/heartbeat"),exchange).andExpect(status().isOk()));
        var rejection=java.util.stream.StreamSupport.stream(batch.path("commands").spliterator(),false).filter(command->command.path("kind").asText().equals("start-rejected")).findFirst().orElseThrow();
        assertThat(rejection.path("reasonCode").asText()).isEqualTo("script_grant_missing");
        assertThat(rejection.path("jobId").asText()).isEqualTo(job);assertThat(rejection.path("executionId").asText()).isEqualTo(execution(job));
        assertThat(jobRepo.require(Long.parseLong(job),false).permitId()).isNull();assertThat(jobRepo.require(Long.parseLong(job),false).released()).isFalse();
        send(f,start).andExpect(status().isOk());assertThat(body(agent(f,post("/api/v1/runner/heartbeat"),exchange).andExpect(status().isOk())).path("commands")).contains(rejection);
        wire("stage-final-start-rejected",rejection);
        var released=message(job,"completed","rejected-release");released.putAll(Map.of("verdict","rejected","reasonCode",rejection.path("reasonCode").asText(),"finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",true));
        send(f,released).andExpect(status().isOk());assertThat(state(job)).isEqualTo("ended");assertThat(jobRepo.occupied(Long.parseLong(f.agent()))).isZero();
        String next=seed(f,"queued");var nextBatch=body(agent(f,post("/api/v1/runner/heartbeat"),new com.autumnharvestc.server.execution.jobs.JobDtos.Exchange("session-one","1",1L,0L,List.of(rejection.path("messageId").asText()))).andExpect(status().isOk()));
        assertThat(nextBatch.path("deliveries").toString()).contains("\"jobId\":\""+next+"\"");
        var malformed=new LinkedHashMap<>(start);malformed.put("inputsDigest","b".repeat(64));malformed.put("messageId","changed-prepared-identity");
        send(f,malformed).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("prepared_inputs_mismatch"));
    }
    @Test void taskSevenRuntimeRegistrationIsDurableAndRejectsMismatchingClaims()throws Exception{
        var f=fixture();var registration=new LinkedHashMap<String,Object>();
        registration.put("protocolVersion",1);registration.put("sessionId","session-runtime");registration.put("coreBuildId",HASH);registration.put("scriptApiId",SCRIPT_API);
        registration.put("nodeVersion","22.19.0");registration.put("v8Version","12.4.254.21-node.29");registration.put("runtimeCompatibilityId",RUNTIME);registration.put("capabilities",List.of("task:suite","protocol:http"));
        registration.put("configuration",Map.of("configVersion","0","appliedConfigVersion","0","pendingFields",List.of(),"restartRequiredFields",List.of(),"status","applied"));
        agent(f,post("/api/v1/runner/runtime"),registration).andExpect(status().isOk()).andExpect(jsonPath("$.registered").value(true));
        var submit=submission(f,"runtime-mismatch");preparation(submit).put("requiredCoreBuildId","f".repeat(64));String job=seed(f,"queued",submit);
        agent(f,post("/api/v1/runner/heartbeat"),new com.autumnharvestc.server.execution.jobs.JobDtos.Exchange("session-runtime","0",1L,0L,List.of())).andExpect(status().isOk());assertThat(state(job)).isEqualTo("ended");
        registerRuntime(f,"session-one","0");
        var debug=body(member(f,post(f.url()+"/jobs"),debugSubmission(f,"bound-session")).andExpect(status().isCreated()));String debugJob=debug.path("jobId").asText(),handle=debug.path("task").path("debugSessionId").asText();beat(f,1,0);
        assertThat(state(debugJob)).as("claim summary: %s",jobRepo.require(Long.parseLong(debugJob),false).summary()).isEqualTo("preparing");
        var input=body(mvc.perform(get("/api/v1/runner/jobs/"+debugJob+"/inputs").param("executionId",execution(debugJob)).header("Authorization","Bearer "+f.agentToken())).andExpect(status().isOk()));
        assertThat(input.path("debugSession").path("hostSessionId").asText()).isEqualTo("session-one");assertThat(input.path("debugSession").path("serverId").asText()).isEqualTo("https://control.test/api/v1");
        String frozen=jdbc.queryForObject("SELECT inputs_json FROM execution_jobs WHERE id=?",String.class,Long.valueOf(debugJob));
        jdbc.update("UPDATE execution_debug_sessions SET expires_at=TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00' WHERE handle=?",handle);
        send(f,message(debugJob,"accepted","debug-accept")).andExpect(status().isOk());send(f,start(debugJob)).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT inputs_json FROM execution_jobs WHERE id=?",String.class,Long.valueOf(debugJob))).isEqualTo(frozen);
        member(f,post("/api/v1/jobs/"+debugJob+"/cancel"),Map.of()).andExpect(status().isOk());var cancelled=message(debugJob,"cancel-confirmed","debug-release");cancelled.putAll(Map.of("finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",true));send(f,cancelled).andExpect(status().isOk());
        var reuse=debugSubmission(f,"old-host-session");reuse.put("debugSessionId",handle);String old=body(member(f,post(f.url()+"/jobs"),reuse).andExpect(status().isCreated())).path("jobId").asText();registerRuntime(f,"host-restarted","0");
        agent(f,post("/api/v1/runner/heartbeat"),new com.autumnharvestc.server.execution.jobs.JobDtos.Exchange("host-restarted","0",1L,0L,List.of())).andExpect(status().isOk());assertThat(state(old)).isEqualTo("ended");assertThat(jdbc.queryForObject("SELECT summary_json FROM execution_jobs WHERE id=?",String.class,Long.valueOf(old))).contains("debug_session_expired");
    }
    Map<String,Object> scripted(F f)throws Exception{
        member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","0","config",Map.of("scriptMode","trusted-core"))).andExpect(status().isOk());
        registerRuntime(f,"session-one","1");
        member(f,put(f.url()+"/script-grants"),Map.of("agentId",f.agent(),"expectedVersion","0","scope","script-version","scripts",List.of(Map.of("scriptId","core/pre","contentHash",HASH)),"riskConfirmed",false)).andExpect(status().isOk());
        var s=submission(f,"scripts");var p=preparation(s);String fileHash=f.assets().get("files").get(0).get("hash").asText();
        // This literal is the property order emitted by the real TS prepareProjectFiles mapper.
        String wire="[{\"scriptId\":\"core/pre\",\"contentHash\":\""+HASH+"\",\"kind\":\"pre\",\"source\":{\"filePath\":\"project.yaml\",\"fileHash\":\""+fileHash+"\"}}]";
        p.put("scriptRequirements",json.readTree(wire));p.put("scriptPlanDigest",Hashes.sha256HexUtf8(wire));p.put("scriptGrantVersion","1");p.put("executionProfile","trusted-core-script");return s;
    }
    Map<String,Object> scriptStart(String job,Map<String,Object> s){var m=start(job);var p=preparation(s);for(String key:List.of("scriptRequirements","scriptPlanDigest","scriptGrantVersion","executionProfile"))m.put(key,p.get(key));return m;}
    @Test void startRequestAckIsSeparateFromPersistentPermitAndRetryReturnsSamePermit()throws Exception{
        var f=fixture();String job=seed(f,"preparing");var m=start(job);send(f,m).andExpect(status().isOk()).andExpect(jsonPath("$.acknowledged[0]").value("start-"+job));
        assertThat(jdbc.queryForObject("SELECT permit_id FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job))).isNotNull();assertThat(state(job)).isEqualTo("preparing");
        var first=beat(f,0,0);wire("control-batch",first);send(f,m).andExpect(status().isOk());var retry=beat(f,0,0);assertThat(retry.get("commands")).isEqualTo(first.get("commands"));assertThat(first.get("commands").toString()).contains("start-permit");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_job_messages WHERE job_id=?",Long.class,Long.valueOf(job))).isEqualTo(1);
        var started=message(job,"started","started-"+job);started.put("permitId",first.get("commands").get(0).get("permitId").asText());started.put("startedAt","2026-10-26T01:00:00Z");send(f,started).andExpect(status().isOk());send(f,started).andExpect(status().isOk());assertThat(state(job)).isEqualTo("running");
    }
    @Test void sameMessageIdWithChangedPayloadConflicts()throws Exception{
        var f=fixture();String job=seed(f,"preparing");var m=message(job,"accepted","same-id");send(f,m).andExpect(status().isOk());m.put("kind","start-request");m.putAll(start(job));m.put("messageId","same-id");send(f,m).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("message_conflict"));
    }
    @Test void startRechecksCurrentUserAuthorization()throws Exception{
        var f=fixture();String job=seed(f,"preparing");jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) SELECT ?,?,id,'VIEWER',CURRENT_TIMESTAMP FROM users WHERE username='admin'",Long.valueOf(f.ws()),Long.valueOf(f.project()));assertStartRejected(f,job,start(job),"forbidden");
    }
    @Test void startRechecksReducedTotalQuota()throws Exception{
        var f=fixture();String running=seed(f,"running"),candidate=seed(f,"preparing");assertStartRejected(f,candidate,start(candidate),"agent_capacity");assertThat(state(running)).isEqualTo("running");
    }
    @Test void startRejectsChangedInputsAndUnknownControlFields()throws Exception{
        var f=fixture();String job=seed(f,"preparing");var m=start(job);m.put("inputsDigest","b".repeat(64));send(f,m).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("prepared_inputs_mismatch"));m=start(job);m.put("approved",true);send(f,m).andExpect(status().isBadRequest());
    }
    @Test void finalizingKeepsCapacityUntilExplicitReleasedCompletionAndArchiveRemainsPending()throws Exception{
        var f=fixture();String job=seed(f,"running"),queued=seed(f,"queued");var m=message(job,"progress","progress-"+job);m.putAll(Map.of("sequence",1,"phase","finalizing","observedAt","2026-10-26T01:00:00Z","completedRequests",1,"failedRequests",0));send(f,m).andExpect(status().isOk());assertThat(beat(f,1,1).get("deliveries")).isEmpty();
        m=message(job,"completed","done-"+job);m.putAll(Map.of("verdict","interrupted","finishedAt","2026-10-26T01:00:01Z","executionReleased",true,"evidenceComplete",false,"reportHash",HASH,"reportBytes",20));send(f,m).andExpect(status().isOk());assertThat(state(job)).isEqualTo("ended");assertThat(beat(f,1,1).get("deliveries")).hasSize(1);
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.reportState").value("pending"));assertThat(state(queued)).isEqualTo("preparing");
    }
    @Test void emptyPollIsAsynchronousAndControlledWakeClaimsOnce()throws Exception{
        var f=fixture();var pending=waiters.poll(Long.parseLong(f.agent()),exchange(1,0));assertThat(pending.hasResult()).isFalse();String job=seed(f,"queued");waiters.wake(Long.parseLong(f.agent()));assertThat(pending.hasResult()).isTrue();assertThat(state(job)).isEqualTo("preparing");assertThat(beat(f,1,0).get("deliveries")).hasSize(1); // same unacknowledged delivery, no second execution
    }
    @Test void fullSharedWorkerStillAllowsDedicatedTaskWithinGlobalBudget()throws Exception{
        var f=fixture();String job=seed(f,"queued");assertThat(beat(f,1,0).get("deliveries")).hasSize(1);assertThat(state(job)).isEqualTo("preparing");
    }
    @Test void stoppedIntakeKeepsExistingControlAndMaterialsButRevokedIdentityIsRejected()throws Exception{
        var f=fixture();String job=seed(f,"preparing");member(f,patch("/api/v1/agents/"+f.agent()),Map.of("acceptingJobs",false)).andExpect(status().isOk());send(f,message(job,"accepted","still-control")).andExpect(status().isOk());agent(f,post("/api/v1/runner/jobs/"+job+"/materials"),Map.of("executionId",execution(job))).andExpect(status().isOk());member(f,post("/api/v1/agents/"+f.agent()+"/revoke"),Map.of()).andExpect(status().isOk());send(f,message(job,"accepted","revoked")).andExpect(status().isUnauthorized());
    }
    @Test void startAcceptsTheRealCoreScriptManifestDigestFraming()throws Exception{
        var f=fixture();var s=scripted(f);String job=seed(f,"preparing",s);send(f,scriptStart(job,s)).andExpect(status().isOk());assertThat(jdbc.queryForObject("SELECT permit_id FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job))).isNotNull();
    }
    @Test void startRejectsRevokedScriptGrantBeforePermit()throws Exception{
        var f=fixture();var s=scripted(f);String job=seed(f,"preparing",s);member(f,put(f.url()+"/script-grants"),Map.of("agentId",f.agent(),"expectedVersion","1","scope","script-version","scripts",List.of(),"riskConfirmed",false)).andExpect(status().isOk());assertStartRejected(f,job,scriptStart(job,s),"script_grant_missing");
    }
    @Test void startRejectsChangedCredentialVersion()throws Exception{
        var f=fixture();member(f,put(f.url()+"/credentials/network-key"),Map.of("expectedVersion","0","value","synthetic-one")).andExpect(status().isOk());var s=submission(f,"materials");s.put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","network-key","version","1")),"attachments",List.of()));String job=seed(f,"preparing",s);
        member(f,put(f.url()+"/credentials/network-key"),Map.of("expectedVersion","1","value","synthetic-two")).andExpect(status().isOk());var m=start(job);m.put("credentialVersions",Map.of("network-key","1"));assertStartRejected(f,job,m,"credential_version_conflict");
    }
    @Test void startRejectsRuntimeMismatchAndControlSchemaRejectsUnknownFields()throws Exception{
        var f=fixture();String job=seed(f,"preparing");var m=start(job);m.put("runtimeCompatibilityId","unknown-runtime");send(f,m).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("prepared_inputs_mismatch"));
    }
    @Test void controlMessagesRejectUnknownFieldsIndependentlyOfPreparation()throws Exception{
        var f=fixture();String job=seed(f,"preparing");var m=message(job,"accepted","bad-shape");m.put("approved",true);send(f,m).andExpect(status().isBadRequest());
    }
    @Test void pollAcknowledgementRemovesOnlyDeliveredCommandAndUpdatesAppliedConfig()throws Exception{
        var f=fixture();member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","0","config",Map.of("maxConcurrentJobs",2))).andExpect(status().isOk());var batch=beat(f,0,0);assertThat(batch.get("commands")).hasSize(1);String id=batch.get("commands").get(0).get("messageId").asText();
        registerRuntime(f,"session-two","1");var e=new com.autumnharvestc.server.execution.jobs.JobDtos.Exchange("session-two","1",0L,0L,List.of(id));agent(f,post("/api/v1/runner/heartbeat"),e).andExpect(status().isOk()).andExpect(jsonPath("$.commands").isEmpty());member(f,get("/api/v1/agents/"+f.agent()),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.appliedConfigVersion").value("1"));registerRuntime(f,"session-restarted","0");assertThat(body(agent(f,post("/api/v1/runner/heartbeat"),new com.autumnharvestc.server.execution.jobs.JobDtos.Exchange("session-restarted","0",0L,0L,List.of())).andExpect(status().isOk())).get("commands")).hasSize(1); // A restarted host reporting an older applied version must recover configuration.
    }
    @Test void queuedPermissionRevocationEndsOnlyThatJobAndKeepsControlExchangeUsable()throws Exception{
        var f=fixture();String job=seed(f,"queued");jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) SELECT ?,?,id,'VIEWER',CURRENT_TIMESTAMP FROM users WHERE username='admin'",Long.valueOf(f.ws()),Long.valueOf(f.project()));beat(f,1,0);assertThat(state(job)).isEqualTo("ended");assertThat(jdbc.queryForObject("SELECT summary_json FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job))).contains("rejected","forbidden");
    }
    @Test void cancellationReleaseReconcilesWithReportAlreadyUploadedOnIndependentDataPath()throws Exception{
        var f=fixture();String job=seed(f,"preparing");member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isOk());byte[] report="{}".getBytes();mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",Hashes.sha256Hex(report)).contentType("application/octet-stream").content(report)).andExpect(status().isOk());var m=message(job,"cancel-confirmed","release-with-report");m.putAll(Map.of("finishedAt","2026-10-26T01:00:00Z","executionReleased",true,"evidenceComplete",true));send(f,m).andExpect(status().isOk());assertThat(state(job)).isEqualTo("ended");member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.reportState").value("archived"));
    }
    @Test void servletPollTimeoutRenewsWithoutConsumingTheNextQueuedJob()throws Exception{
        var f=fixture();var pending=agent(f,post("/api/v1/runner/poll"),exchange(1,0)).andExpect(request().asyncStarted()).andReturn();var context=(org.springframework.mock.web.MockAsyncContext)pending.getRequest().getAsyncContext();for(var listener:context.getListeners())listener.onTimeout(new jakarta.servlet.AsyncEvent(context));mvc.perform(asyncDispatch(pending)).andExpect(status().isOk()).andExpect(jsonPath("$.deliveries").isEmpty());String job=seed(f,"queued");assertThat(beat(f,1,0).get("deliveries")).hasSize(1);assertThat(state(job)).isEqualTo("preparing");
    }
    @Test void concurrentPollsCompeteForOneDurableAgentBudget()throws Exception{
        var f=fixture();seed(f,"queued");seed(f,"queued");var gate=new java.util.concurrent.CountDownLatch(1);try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)){
            var one=pool.submit(()->{gate.await();return control.exchange(Long.parseLong(f.agent()),exchange(1,0));});var two=pool.submit(()->{gate.await();return control.exchange(Long.parseLong(f.agent()),exchange(1,0));});gate.countDown();var first=one.get(10,java.util.concurrent.TimeUnit.SECONDS);var second=two.get(10,java.util.concurrent.TimeUnit.SECONDS);assertThat(first.deliveries()).hasSize(1);assertThat(second.deliveries()).hasSize(1);assertThat(first.deliveries().get(0).get("messageId")).isEqualTo(second.deliveries().get(0).get("messageId"));
        }assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE agent_id=? AND state='preparing'",Long.class,Long.valueOf(f.agent()))).isEqualTo(1);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE agent_id=? AND state='queued'",Long.class,Long.valueOf(f.agent()))).isEqualTo(1);
    }
    @Test void cancelConfirmationBeforeArchiveRetainsIndependentPendingBudget()throws Exception{
        var f=fixture();String job=seed(f,"preparing");member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isOk());var m=message(job,"cancel-confirmed","cancel-before-report");m.putAll(Map.of("finishedAt","2026-10-26T01:00:00Z","executionReleased",true,"evidenceComplete",true));send(f,m).andExpect(status().isOk());send(f,m).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT reserved_result_bytes FROM execution_jobs WHERE id=?",Long.class,Long.valueOf(job))).isEqualTo(100);
        member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.reportState").value("pending"));byte[] report="{}".getBytes();var upload=put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",Hashes.sha256Hex(report)).contentType("application/octet-stream").content(report);mvc.perform(upload).andExpect(status().isOk());mvc.perform(upload).andExpect(status().isOk());assertThat(jdbc.queryForObject("SELECT reserved_result_bytes FROM execution_jobs WHERE id=?",Long.class,Long.valueOf(job))).isZero();member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.reportState").value("archived"));
    }
    @Test void expiredQueueSettlesWithoutGlobalOrSharedSlots()throws Exception{
        var f=fixture();String dedicated=seed(f,"queued");var s=debugSubmission(f,"expired-shared");preparation(s).put("dispatchKind","shared-debug");String shared=seed(f,"queued",s);jdbc.update("UPDATE execution_jobs SET queue_expires_at=TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00' WHERE id IN (?,?)",Long.valueOf(dedicated),Long.valueOf(shared));beat(f,0,0);assertThat(state(dedicated)).isEqualTo("ended");assertThat(state(shared)).isEqualTo("ended");assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE agent_id=? AND state='queued'",Long.class,Long.valueOf(f.agent()))).isZero();
    }
}
