package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.execution.scheduling.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import java.util.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class ScheduledJobsTest extends OccurrenceFixture {
    @org.springframework.beans.factory.annotation.Autowired ScheduledJobSubmission scheduledSubmission;
    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean com.autumnharvestc.server.execution.jobs.JobRepo insertedJobs;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.execution.jobs.JobService originalJobs;
    com.autumnharvestc.server.execution.jobs.JobDtos.Submit fixedRequest(String schedule,ScheduleOccurrenceService.Claim claim){
        var e=jobRepo.decode(jobRepo.parse(jdbc.queryForObject("SELECT execution_json FROM execution_schedule_revisions WHERE schedule_id=? AND revision=?",String.class,Long.valueOf(schedule),Long.valueOf(claim.revision()))),ScheduleDtos.Execution.class);
        var materials=jobRepo.decode(jobRepo.parse(jdbc.queryForObject("SELECT materials_json FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))),ExecutionDtos.MaterialSelection.class);
        return new com.autumnharvestc.server.execution.jobs.JobDtos.Submit("scheduled-occurrence-"+claim.id(),e.agentId(),e.snapshotId(),e.target(),e.environmentId(),null,e.runConfig(),materials,e.preparation(),e.network());
    }
    @Test void embeddedTickSubmitsTheClaimThroughTheOriginalJobAuthority()throws Exception {
        var f=fixture();String schedule=once(f);now(origin.plusSeconds(60));
        new EmbeddedScheduleDriver(occurrences,scheduledSubmission,"scheduled-job-driver").tick();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project())))
            .as("a due claim must produce one original job").isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE schedule_id=?",String.class,Long.valueOf(schedule))).isEqualTo("submitted");
    }
    @Test void manualIntentCannotAcquireScheduledOrigin()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("collision").getFirst();var request=fixedRequest(id,claim);
        var manual=originalJobs.submit(scheduleUsers.findByUsername("admin").orElseThrow(),f.ws(),f.project(),request);
        assertThat(scheduledSubmission.submit(claim)).isEmpty();assertThat(jdbc.queryForObject("SELECT reason_code FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("intent_source_conflict");
        assertThat(jdbc.queryForObject("SELECT job_id FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isEqualTo(1);
        assertThat(originalJobs.submit(scheduleUsers.findByUsername("admin").orElseThrow(),f.ws(),f.project(),request).get("jobId")).isEqualTo(manual.get("jobId"));
    }
    @Test void scheduledIntentCannotBeReturnedAsAManualSubmission()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("scheduled-first").getFirst();scheduledSubmission.submit(claim).orElseThrow();
        assertThatThrownBy(()->originalJobs.submit(scheduleUsers.findByUsername("admin").orElseThrow(),f.ws(),f.project(),fixedRequest(id,claim))).isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getCode()).isEqualTo("intent_source_conflict"));
    }
    @Test void scheduleAbsoluteDeadlineCapsTheExistingJobQueue()throws Exception {
        var f=fixture();String id=once(f);
        member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","policies",Map.of("lateToleranceMs",10000,"misfire","skip","catchupWindowMs",300000,"overlap","skip","queueTimeoutMs",1000))).andExpect(status().isOk());
        now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));var claim=occurrences.scan("deadline").getFirst();var link=scheduledSubmission.submit(claim).orElseThrow();
        assertThat(jobRepo.require(Long.valueOf(link.jobId()),false).queueExpiresAt()).isNotNull().isEqualTo(origin.plusSeconds(61).atOffset(java.time.ZoneOffset.UTC));
    }
    @Test void failureAfterTheActualInsertRollsBackTheJobAndOccurrenceAssociation()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("rollback").getFirst();var inserted=new java.util.concurrent.atomic.AtomicBoolean();
        org.mockito.Mockito.doAnswer(call->{call.callRealMethod();inserted.set(true);throw new IllegalStateException("before-commit-checkpoint");}).when(insertedJobs).insert(org.mockito.ArgumentMatchers.anyLong(),org.mockito.ArgumentMatchers.anyLong(),org.mockito.ArgumentMatchers.anyLong(),org.mockito.ArgumentMatchers.anyLong(),org.mockito.ArgumentMatchers.anyLong(),org.mockito.ArgumentMatchers.anyLong(),org.mockito.ArgumentMatchers.anyLong(),org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.any(),org.mockito.ArgumentMatchers.any(),org.mockito.ArgumentMatchers.any(),org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.any());
        assertThatThrownBy(()->scheduledSubmission.submit(claim)).isInstanceOf(IllegalStateException.class).hasMessage("before-commit-checkpoint");
        assertThat(inserted.get()).as("checkpoint follows the real authoritative insert").isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
        assertThat(jdbc.queryForObject("SELECT job_id FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isNull();
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("pending");
    }
    record Subject(F owner,F member,String userId){}
    Subject editor()throws Exception {
        var f=fixture();String name="scheduled-"+java.util.UUID.randomUUID().toString().substring(0,10);
        mvc.perform(post("/api/v1/auth/register").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123","displayName",name)))).andExpect(status().isCreated());
        String user=jdbc.queryForObject("SELECT id FROM users WHERE username=?",String.class,name);jdbc.update("INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,'EDITOR',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(user));
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123")))).andExpect(status().isOk())).path("token").asText();
        member(f,put(f.url()+"/schedule-grants"),Map.of("expectedVersion","0","userIds",List.of(user))).andExpect(status().isOk());
        return new Subject(f,new F(token,f.ws(),f.group(),f.project(),f.snapshot(),f.agent(),f.agentToken(),f.assets()),user);
    }
    String queued(Subject subject)throws Exception {
        once(subject.member());now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));return scheduledSubmission.submit(occurrences.scan("queued-editor").getFirst()).orElseThrow().jobId();
    }
    void preparing(F f,String job)throws Exception {
        var batch=beat(f,1,1);assertThat(batch.path("deliveries")).hasSize(1);wire("t4-scheduled-control-batch",batch);send(f,message(job,"accepted","accepted-"+job)).andExpect(status().isOk());
        assertThat(state(job)).isEqualTo("preparing");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"grant","account","membership"})
    void originalSubmittedSubjectMustStillBeAuthorizedAtANewPermit(String revocation)throws Exception {
        var subject=editor();var f=subject.owner();String job=queued(subject);preparing(f,job);
        switch(revocation){
            case "grant"->{var source=jobRepo.scheduleOrigin(Long.valueOf(job)).orElseThrow();member(f,put(f.url()+"/schedules/"+source.scheduleId()),Map.of("expectedVersion","2","reauthorize",true)).andExpect(status().isOk());member(f,put(f.url()+"/schedule-grants"),Map.of("expectedVersion","1","userIds",List.of())).andExpect(status().isOk());}
            case "account"->jdbc.update("UPDATE users SET disabled=TRUE WHERE id=?",Long.valueOf(subject.userId()));
            case "membership"->jdbc.update("DELETE FROM memberships WHERE workspace_id=? AND user_id=?",Long.valueOf(f.ws()),Long.valueOf(subject.userId()));
        }
        send(f,start(job)).andExpect(status().isOk());
        var command=beat(f,0,0).path("commands");String reason=revocation.equals("account")?"schedule-subject-unavailable":"schedule-subject-unauthorized";
        assertThat(command.findValuesAsText("kind")).contains("start-rejected").doesNotContain("start-permit");assertThat(command.findValuesAsText("reasonCode")).contains(reason);
        assertThat(jobRepo.require(Long.valueOf(job),false).permitId()).isNull();assertThat(state(job)).isEqualTo("preparing");
    }
    @Test void preparingPastTheScheduleQueueDeadlineCannotReceiveANewPermit()throws Exception {
        var subject=editor();var f=subject.owner();String job=queued(subject);preparing(f,job);clock.set(origin.plusSeconds(360));now(origin.plusSeconds(360));
        send(f,start(job)).andExpect(status().isOk());
        var commands=beat(f,0,0).path("commands");assertThat(commands.findValuesAsText("kind")).contains("start-rejected").doesNotContain("start-permit");assertThat(commands.findValuesAsText("reasonCode")).contains("schedule-queue-expired");
        assertThat(jobRepo.require(Long.valueOf(job),false).permitId()).isNull();
    }
    @Test void fullOriginalQueueWaitsOnTheSamePendingOccurrenceUntilItsFixedDeadline()throws Exception {
        var f=fixture();member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","1","policy",Map.of("maxQueuedJobs",1))).andExpect(status().isOk());seed(f,"queued");String id=once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("queue-full").getFirst();
        assertThatCode(()->assertThat(scheduledSubmission.submit(claim)).isEmpty()).doesNotThrowAnyException();
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("pending");
        now(origin.plusSeconds(360));assertThat(occurrences.scan("expired-full-queue")).isEmpty();
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("expired");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isEqualTo(1);
    }
    @Test void sealedCurrentCredentialConflictRejectsOnlyThisOccurrenceWithoutRefreshingOrPausingFutureOnes()throws Exception {
        var f=fixture();member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","0","value","sealed-secret-one")).andExpect(status().isOk());
        now(origin);var input=save(f);input.put("rule",Map.of("kind","cron","expression","0 * * * * *","timeZone","Asia/Shanghai","dstOverlap","first"));execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","api","mode","current-at-trigger")),"attachments",List.of()));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());
        now(origin.plusSeconds(60));var claim=occurrences.scan("sealed-before-rotate").getFirst();member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","1","value","rotated-secret-two")).andExpect(status().isOk());
        assertThatCode(()->assertThat(scheduledSubmission.submit(claim)).isEmpty()).doesNotThrowAnyException();
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("rejected");
        assertThat(jdbc.queryForObject("SELECT reason_code FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("credential_version_conflict");
        assertThat(jdbc.queryForObject("SELECT enabled FROM execution_schedules WHERE id=?",Boolean.class,Long.valueOf(id))).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
        now(origin.plusSeconds(120));var next=occurrences.scan("next-trigger-real-version").getFirst();assertThat(scheduledSubmission.submit(next)).isPresent();
        assertThat(jdbc.queryForObject("SELECT materials_json FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).contains("\"version\":\"1\"").doesNotContain("sealed-secret-one","rotated-secret-two");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"name","revision","disabled","reauthorized"})
    void laterPlanChangesDoNotCancelOrRewriteTheAlreadySubmittedJob(String edit)throws Exception {
        var subject=editor();var f=subject.owner();String job=queued(subject);var source=jobRepo.scheduleOrigin(Long.valueOf(job)).orElseThrow();
        Map<String,Object> patch=switch(edit){
            case "name"->Map.of("expectedVersion","2","name","Changed plan name");
            case "revision"->Map.of("expectedVersion","2","rule",Map.of("kind","once","atUtc","2035-01-01T00:02:00Z","timeZone","Asia/Shanghai"));
            case "disabled"->Map.of("expectedVersion","2","enabled",false);
            default->Map.of("expectedVersion","2","reauthorize",true);
        };
        member(f,put(f.url()+"/schedules/"+source.scheduleId()),patch).andExpect(status().isOk());preparing(f,job);send(f,start(job)).andExpect(status().isOk());
        assertThat(jobRepo.require(Long.valueOf(job),false).permitId()).isNotNull();assertThat(jobRepo.require(Long.valueOf(job),false).user()).isEqualTo(Long.valueOf(subject.userId()));assertThat(jobRepo.scheduleOrigin(Long.valueOf(job))).contains(source);
    }
    @Test void anAlreadyDurablePermitRecoversAfterGrantLossAndPlanDisableWithoutANewInvocation()throws Exception {
        var subject=editor();var f=subject.owner();String job=queued(subject);preparing(f,job);send(f,start(job)).andExpect(status().isOk());String permit=jobRepo.require(Long.valueOf(job),false).permitId();
        member(f,put(f.url()+"/schedule-grants"),Map.of("expectedVersion","1","userIds",List.of())).andExpect(status().isOk());var source=jobRepo.scheduleOrigin(Long.valueOf(job)).orElseThrow();member(f,put(f.url()+"/schedules/"+source.scheduleId()),Map.of("expectedVersion","2","enabled",false)).andExpect(status().isOk());clock.set(origin.plusSeconds(600));now(origin.plusSeconds(600));
        var retry=start(job);retry.put("messageId","lost-permit-ack-"+job);send(f,retry).andExpect(status().isOk());
        assertThat(jobRepo.require(Long.valueOf(job),false).permitId()).isEqualTo(permit);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_job_outbox WHERE job_id=? AND kind='start-permit'",Long.class,Long.valueOf(job))).isEqualTo(1);
        var started=message(job,"started","original-started-"+job);started.putAll(Map.of("permitId",permit,"startedAt","2035-01-01T00:01:01Z"));send(f,started).andExpect(status().isOk());assertThat(state(job)).isEqualTo("running");
    }
    @Test void internalScheduledSubmitCannotCreateAJobOutsideTheOccurrenceTransaction()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("internal-boundary").getFirst();var source=new com.autumnharvestc.server.execution.jobs.JobRepo.ScheduleOrigin(Long.valueOf(claim.id()),Long.valueOf(id),1);
        assertThatThrownBy(()->originalJobs.submitScheduled(scheduleUsers.findByUsername("admin").orElseThrow(),f.ws(),f.project(),fixedRequest(id,claim),origin.plusSeconds(360),source)).isInstanceOf(org.springframework.transaction.IllegalTransactionStateException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
    }
    @Test void databaseCannotPersistAPartialScheduledSource()throws Exception {
        var f=fixture();String job=seed(f,"queued");
        assertThatThrownBy(()->jdbc.update("UPDATE execution_jobs SET schedule_occurrence_id=9223372036854775807 WHERE id=?",Long.valueOf(job))).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThat(jobRepo.scheduleOrigin(Long.valueOf(job))).isEmpty();
    }
    @Test void adapterRejectsAnAmbientTransactionBeforeTakingAnyAuthorityLocksOrWriting()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("outside-ambient").getFirst();
        gatedTransactions.executeWithoutResult(status->{assertThatThrownBy(()->scheduledSubmission.submit(claim)).isInstanceOf(IllegalStateException.class).hasMessageContaining("outside an existing transaction");});
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(booleans={false,true})
    void originalQueueRecoversTheSameJobBeforeDeadlineAndExpiresItAtDeadline(boolean expired)throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));var claim=occurrences.scan("before-disconnect").getFirst();String job=scheduledSubmission.submit(claim).orElseThrow().jobId();
        clock.set(origin.plusSeconds(expired?360:359));now(origin.plusSeconds(expired?360:359));var batch=beat(f,1,1);
        if(expired){assertThat(batch.path("deliveries")).isEmpty();assertThat(state(job)).isEqualTo("ended");assertThat(jobRepo.require(Long.valueOf(job),false).summary().path("reasonCode").asText()).isEqualTo("queue_timeout");assertThat(jobRepo.require(Long.valueOf(job),false).permitId()).isNull();}
        else {assertThat(batch.path("deliveries")).hasSize(1);assertThat(batch.path("deliveries").get(0).path("task").path("jobId").asText()).isEqualTo(job);send(f,message(job,"accepted","reconnected-accept")).andExpect(status().isOk());send(f,start(job)).andExpect(status().isOk());assertThat(jobRepo.require(Long.valueOf(job),false).permitId()).isNotNull();}
        now(origin.plusSeconds(400));new EmbeddedScheduleDriver(occurrences,scheduledSubmission,"after-reconnect").tick();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isEqualTo(1);
    }
    @Test void anEarlierOriginalProjectQueueLimitStillWinsOverTheScheduleDeadline()throws Exception {
        var f=fixture();member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","1","policy",Map.of("queueTimeoutMs",1000))).andExpect(status().isOk());once(f);now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));String job=scheduledSubmission.submit(occurrences.scan("original-limit").getFirst()).orElseThrow().jobId();
        assertThat(jobRepo.require(Long.valueOf(job),false).queueExpiresAt()).isEqualTo(origin.plusSeconds(61).atOffset(java.time.ZoneOffset.UTC));
    }
    @Test void nanosecondDeadlineNeverRoundsLaterWhenStoredInTheOriginalJobPrecision()throws Exception {
        var f=fixture();now(origin);var input=save(f);input.put("rule",Map.of("kind","once","atUtc","2035-01-01T00:01:00.123456789Z","timeZone","Asia/Shanghai"));input.put("policies",Map.of("lateToleranceMs",10000,"misfire","skip","catchupWindowMs",300000,"overlap","skip","queueTimeoutMs",1000));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());var due=java.time.Instant.parse("2035-01-01T00:01:00.123456789Z");now(due);clock.set(due);String job=scheduledSubmission.submit(occurrences.scan("fractional-deadline").getFirst()).orElseThrow().jobId();
        assertThat(jobRepo.require(Long.valueOf(job),false).queueExpiresAt()).isEqualTo(java.time.OffsetDateTime.parse("2035-01-01T00:01:01.123456Z"));
    }
    @Test void credentialRotationAfterPreparationStillProducesTheOriginalDurableStartRefusal()throws Exception {
        var f=fixture();member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","0","value","before-start-secret")).andExpect(status().isOk());now(origin);var input=save(f);input.put("rule",Map.of("kind","once","atUtc","2035-01-01T00:01:00Z","timeZone","Asia/Shanghai"));execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","api","mode","current-at-trigger")),"attachments",List.of()));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));String job=scheduledSubmission.submit(occurrences.scan("credential-start").getFirst()).orElseThrow().jobId();preparing(f,job);
        member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","1","value","after-start-secret")).andExpect(status().isOk());var message=start(job);message.put("credentialVersions",Map.of("api","1"));send(f,message).andExpect(status().isOk());var commands=beat(f,0,0).path("commands");assertThat(commands.findValuesAsText("kind")).contains("start-rejected").doesNotContain("start-permit");assertThat(commands.findValuesAsText("reasonCode")).contains("credential_version_conflict");assertThat(jobRepo.require(Long.valueOf(job),false).permitId()).isNull();
    }
    @Test void scriptGrantRevocationAfterPreparationStillUsesTheOriginalScriptAuthority()throws Exception {
        var f=fixture();member(f,patch("/api/v1/agents/"+f.agent()),Map.of("expectedVersion","0","config",Map.of("scriptMode","trusted-core"))).andExpect(status().isOk());registerRuntime(f,"session-one","1");
        member(f,put(f.url()+"/script-grants"),Map.of("agentId",f.agent(),"expectedVersion","0","scope","script-version","scripts",List.of(Map.of("scriptId","core/pre","contentHash",HASH)),"riskConfirmed",false)).andExpect(status().isOk());
        now(origin);var input=save(f);input.put("rule",Map.of("kind","once","atUtc","2035-01-01T00:01:00Z","timeZone","Asia/Shanghai"));var prepared=preparation(execution(input));String fileHash=f.assets().path("files").get(0).path("hash").asText();
        String wire="[{\"scriptId\":\"core/pre\",\"contentHash\":\""+HASH+"\",\"kind\":\"pre\",\"source\":{\"filePath\":\"project.yaml\",\"fileHash\":\""+fileHash+"\"}}]";prepared.put("scriptRequirements",json.readTree(wire));prepared.put("scriptPlanDigest",com.autumnharvestc.server.core.Hashes.sha256HexUtf8(wire));prepared.put("scriptGrantVersion","1");prepared.put("executionProfile","trusted-core-script");
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));String job=scheduledSubmission.submit(occurrences.scan("script-start").getFirst()).orElseThrow().jobId();
        var batch=body(agent(f,post("/api/v1/runner/heartbeat"),new com.autumnharvestc.server.execution.jobs.JobDtos.Exchange("session-one","1",1L,0L,List.of())).andExpect(status().isOk()));assertThat(batch.path("deliveries")).hasSize(1);send(f,message(job,"accepted","accepted-script")).andExpect(status().isOk());
        member(f,put(f.url()+"/script-grants"),Map.of("agentId",f.agent(),"expectedVersion","1","scope","script-version","scripts",List.of(),"riskConfirmed",false)).andExpect(status().isOk());var message=start(job);for(String key:List.of("scriptRequirements","scriptPlanDigest","scriptGrantVersion","executionProfile"))message.put(key,prepared.get(key));send(f,message).andExpect(status().isOk());
        assertThat(jobRepo.pending(Long.valueOf(f.agent()),"command")).anySatisfy(command->{assertThat(command.get("kind")).isEqualTo("start-rejected");assertThat(command.get("reasonCode")).isEqualTo("script_grant_missing");});assertThat(jobRepo.require(Long.valueOf(job),false).permitId()).isNull();
    }
    @Test void databaseDeadlineRejectsANewPermitEvenWhenTheApplicationClockIsBehind()throws Exception {
        var subject=editor();var f=subject.owner();String job=queued(subject);preparing(f,job);
        // The server process still thinks it is submission time; the shared database is past the cap.
        now(origin.plusSeconds(361));assertThat(clock.instant()).isEqualTo(origin.plusSeconds(60));send(f,start(job)).andExpect(status().isOk());
        var commands=beat(f,0,0).path("commands");assertThat(commands.findValuesAsText("kind")).contains("start-rejected").doesNotContain("start-permit");assertThat(commands.findValuesAsText("reasonCode")).contains("schedule-queue-expired");
        var saved=jobRepo.require(Long.valueOf(job),false);assertThat(saved.permitId()).isNull();assertThat(saved.state()).isEqualTo("preparing");assertThat(saved.released()).isFalse();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_job_messages WHERE job_id=? AND message_id=?",Long.class,Long.valueOf(job),"start-"+job)).isEqualTo(1);
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(longs={-30000,30000})
    void scheduledRelativeQueueCapUsesTheSharedDatabaseClockRatherThanProcessClock(long applicationOffsetMs)throws Exception {
        var f=fixture();member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","1","policy",Map.of("queueTimeoutMs",1000))).andExpect(status().isOk());once(f);now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60).plusMillis(applicationOffsetMs));
        String job=scheduledSubmission.submit(occurrences.scan("shared-relative-cap").getFirst()).orElseThrow().jobId();
        assertThat(jobRepo.require(Long.valueOf(job),false).queueExpiresAt()).as("1s project cap is relative to DB submission time regardless of host drift").isEqualTo(origin.plusSeconds(61).atOffset(java.time.ZoneOffset.UTC));
    }
    @Test void manualRelativeQueueCapKeepsItsOriginalApplicationClockSemantics()throws Exception {
        var f=fixture();member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","1","policy",Map.of("queueTimeoutMs",1000))).andExpect(status().isOk());now(origin.plusSeconds(60));clock.set(origin.plusSeconds(90));
        String job=body(member(f,post(f.url()+"/jobs"),submission(f,"manual-clock-authority")).andExpect(status().isCreated())).path("jobId").asText();
        assertThat(jobRepo.require(Long.valueOf(job),false).queueExpiresAt()).isEqualTo(origin.plusSeconds(91).atOffset(java.time.ZoneOffset.UTC));assertThat(jobRepo.scheduleOrigin(Long.valueOf(job))).isEmpty();
        clock.set(origin.plusSeconds(91));beat(f,0,0);assertThat(state(job)).isEqualTo("ended");assertThat(jobRepo.require(Long.valueOf(job),false).summary().path("reasonCode").asText()).isEqualTo("queue_timeout");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.CsvSource({"false,0","false,1","true,0","true,1"})
    void queuedScheduledExpiryUsesDatabaseTimeWithOrWithoutAvailableSlots(boolean databaseExpired,long slots)throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));String job=scheduledSubmission.submit(occurrences.scan("queue-time-authority").getFirst()).orElseThrow().jobId();
        now(origin.plusSeconds(databaseExpired?361:359));clock.set(origin.plusSeconds(databaseExpired?359:361));var batch=beat(f,slots,slots);
        assertThat(state(job)).as("DB is the scheduled queue deadline authority even when process time is on the opposite side").isEqualTo(databaseExpired?"ended":slots==0?"queued":"preparing");
        var saved=jobRepo.require(Long.valueOf(job),false);assertThat(saved.permitId()).isNull();assertThat(saved.released()).isEqualTo(databaseExpired);
        if(databaseExpired){assertThat(batch.path("deliveries")).isEmpty();assertThat(saved.summary().path("reasonCode").asText()).isEqualTo("queue_timeout");}
        else {assertThat(batch.path("deliveries")).hasSize((int)slots);if(slots>0)assertThat(batch.path("deliveries").get(0).path("task").path("jobId").asText()).isEqualTo(job);}
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isEqualTo(1);
    }
}
