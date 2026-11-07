package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.core.Hashes;
import com.autumnharvestc.server.access.Capability;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.execution.jobs.ExecutionRetentionCleanup;
import com.autumnharvestc.server.execution.jobs.JobDtos;
import com.autumnharvestc.server.execution.jobs.JobRepo;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.support.ScheduledMethodRunnable;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.util.ReflectionTestUtils;
import java.time.*;
import java.util.*;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@Import(ExecutionRetentionTest.SchedulingConfiguration.class)
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-final-retention;DB_CLOSE_DELAY=-1","apicc.execution.deployment.cleanup-interval-ms=1234","apicc.execution.deployment.cleanup-batch-size=2","apicc.execution.deployment.audit-retention-days=1"})
class ExecutionRetentionTest extends JobsFixture {
    record Scheduled(Runnable action, Duration delay) {}
    static class CapturedSchedule {
        final List<Scheduled> tasks=new ArrayList<>();
        void tick(){for(var task:List.copyOf(tasks))task.action().run();}
    }
    @org.springframework.boot.test.context.TestConfiguration
    @EnableScheduling
    static class SchedulingConfiguration {
        @Bean CapturedSchedule capturedSchedule(){return new CapturedSchedule();}
        @Bean TaskScheduler taskScheduler(CapturedSchedule captured){
            return org.mockito.Mockito.mock(TaskScheduler.class,call->{
                if(call.getMethod().getName().equals("getClock"))return Clock.systemUTC();
                if(call.getMethod().getName().startsWith("schedule")){
                    Duration delay=Arrays.stream(call.getArguments()).filter(Duration.class::isInstance).map(Duration.class::cast).reduce((a,b)->b).orElse(Duration.ZERO);
                    captured.tasks.add(new Scheduled(call.getArgument(0),delay));
                    return org.mockito.Mockito.mock(ScheduledFuture.class);
                }
                return org.mockito.Answers.RETURNS_DEFAULTS.answer(call);
            });
        }
    }
    @Autowired CapturedSchedule scheduled;
    @MockitoSpyBean AgentService observedAgents;
    @MockitoSpyBean JobRepo observedJobs;
    byte[] content="{\"executionId\":\"retained\",\"verdict\":\"rejected\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    String archive(F f, boolean complete)throws Exception{
        var submit=submission(f,java.util.UUID.randomUUID().toString());String job=seed(f,"preparing",submit);
        jdbc.update("UPDATE execution_jobs SET intent_hash=? WHERE id=?",jobRepo.digest(jobRepo.decode(json.valueToTree(submit),JobDtos.Submit.class)),Long.valueOf(job));
        if(complete){var ended=message(job,"completed","ended-"+job);ended.putAll(Map.of("verdict","rejected","finishedAt",clock.instant().toString(),"executionReleased",true,"evidenceComplete",true,"reportHash",Hashes.sha256Hex(content),"reportBytes",content.length));send(f,ended).andExpect(status().isOk());}
        mvc.perform(put("/api/v1/runner/jobs/"+job+"/report?executionId="+execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",Hashes.sha256Hex(content)).contentType("application/octet-stream").content(content)).andExpect(status().isOk());
        return job;
    }
    @Test void reportDownloadReturnsGoneWhenCleanupCommitsAfterAuthorization()throws Exception{
        var f=fixture();String job=archive(f,true);long jobId=Long.parseLong(job);
        var original=jobRepo.require(jobId,false);String receipt=jobRepo.receipt(Long.parseLong(f.agent()),"ended-"+job);
        member(f,get("/api/v1/jobs/"+job+"/report"),Map.of()).andExpect(status().isOk())
            .andExpect(header().string("Cache-Control","no-store")).andExpect(content().bytes(content));
        member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","1","agentIds",List.of(f.agent()),"defaultAgentId",f.agent(),"policy",Map.of("resultRetentionDays",1))).andExpect(status().isOk());
        clock.set(clock.instant().plus(Duration.ofDays(2)));
        var authorized=new CountDownLatch(1);var cleanupCommitted=new CountDownLatch(1);var readerThread=new AtomicReference<Thread>();
        org.mockito.Mockito.doAnswer(invocation->{
            var actual=invocation.callRealMethod();
            if(Thread.currentThread()==readerThread.get()){
                authorized.countDown();
                if(!cleanupCommitted.await(10,TimeUnit.SECONDS))throw new AssertionError("retention cleanup did not commit");
            }
            return actual;
        }).when(observedAgents).requireCapability(org.mockito.ArgumentMatchers.any(),org.mockito.ArgumentMatchers.eq(f.ws()),org.mockito.ArgumentMatchers.eq(f.project()),org.mockito.ArgumentMatchers.eq(Capability.HISTORY_READ));
        try(var pool=Executors.newSingleThreadExecutor()){
            var read=pool.submit(()->{readerThread.set(Thread.currentThread());return member(f,get("/api/v1/jobs/"+job+"/report"),Map.of()).andReturn().getResponse();});
            try{
                assertThat(authorized.await(10,TimeUnit.SECONDS)).as("real project authorization completed before cleanup").isTrue();
                scheduled.tick();
                assertThat(jobRepo.require(jobId,false).reportState()).isEqualTo("expired");
                assertThat(jobRepo.reportContent(jobId)).isNull();
            }finally{cleanupCommitted.countDown();}
            var response=read.get(10,TimeUnit.SECONDS);
            assertThat(response.getStatus()).as("cleanup committed before the download payload read (HTTP %s, %s body bytes)",response.getStatus(),response.getContentAsByteArray().length).isEqualTo(410);
            assertThat(json.readTree(response.getContentAsByteArray()).path("code").asText()).isEqualTo("report_expired");
        }finally{
            cleanupCommitted.countDown();
            org.mockito.Mockito.doCallRealMethod().when(observedAgents).requireCapability(org.mockito.ArgumentMatchers.any(),org.mockito.ArgumentMatchers.eq(f.ws()),org.mockito.ArgumentMatchers.eq(f.project()),org.mockito.ArgumentMatchers.eq(Capability.HISTORY_READ));
        }
        var expired=jobRepo.require(jobId,false);
        assertThat(expired.reportHash()).isEqualTo(original.reportHash());assertThat(expired.reportBytes()).isEqualTo(original.reportBytes());
        assertThat(expired.intent()).isEqualTo(original.intent());assertThat(expired.intentHash()).isEqualTo(original.intentHash());
        assertThat(jobRepo.receipt(Long.parseLong(f.agent()),"ended-"+job)).isEqualTo(receipt);
        member(f,get("/api/v1/jobs/"+job+"/report"),Map.of()).andExpect(status().isGone()).andExpect(jsonPath("$.code").value("report_expired"));
    }
    @Test void reportDownloadKeepsOriginalBytesWhenCleanupCommitsAfterPayloadRead()throws Exception{
        var f=fixture();String job=archive(f,true);long jobId=Long.parseLong(job);var original=jobRepo.require(jobId,false);
        member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","1","agentIds",List.of(f.agent()),"defaultAgentId",f.agent(),"policy",Map.of("resultRetentionDays",1))).andExpect(status().isOk());
        clock.set(clock.instant().plus(Duration.ofDays(2)));
        var payloadRead=new CountDownLatch(1);var cleanupCommitted=new CountDownLatch(1);var readerThread=new AtomicReference<Thread>();
        org.mockito.Mockito.doAnswer(invocation->{
            var actual=invocation.callRealMethod();
            if(Thread.currentThread()==readerThread.get()){
                payloadRead.countDown();
                if(!cleanupCommitted.await(10,TimeUnit.SECONDS))throw new AssertionError("retention cleanup did not commit");
            }
            return actual;
        }).when(observedJobs).reportPayload(jobId);
        try(var pool=Executors.newSingleThreadExecutor()){
            var read=pool.submit(()->{readerThread.set(Thread.currentThread());return member(f,get("/api/v1/jobs/"+job+"/report"),Map.of()).andReturn().getResponse();});
            try{
                assertThat(payloadRead.await(10,TimeUnit.SECONDS)).as("real report row image read before cleanup").isTrue();
                scheduled.tick();
                assertThat(jobRepo.require(jobId,false).reportState()).isEqualTo("expired");assertThat(jobRepo.reportContent(jobId)).isNull();
            }finally{cleanupCommitted.countDown();}
            var response=read.get(10,TimeUnit.SECONDS);
            assertThat(response.getStatus()).isEqualTo(200);assertThat(response.getContentAsByteArray()).isEqualTo(content);
            assertThat(Hashes.sha256Hex(response.getContentAsByteArray())).isEqualTo(original.reportHash());
            assertThat((long)response.getContentAsByteArray().length).isEqualTo(original.reportBytes());
            assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");assertThat(response.getContentType()).isEqualTo("application/json");
        }finally{
            cleanupCommitted.countDown();org.mockito.Mockito.doCallRealMethod().when(observedJobs).reportPayload(jobId);
        }
        member(f,get("/api/v1/jobs/"+job+"/report"),Map.of()).andExpect(status().isGone()).andExpect(jsonPath("$.code").value("report_expired"));
        var expired=jobRepo.require(jobId,false);assertThat(expired.reportHash()).isEqualTo(original.reportHash());assertThat(expired.reportBytes()).isEqualTo(original.reportBytes());
        assertThat(jobRepo.receipt(Long.parseLong(f.agent()),"ended-"+job)).isNotNull();
    }
    @Test void reportDownloadsRetainCurrentAuthorizationAndPendingOrMissingResponses()throws Exception{
        var f=fixture();String archived=archive(f,true),pending=seed(f,"ended");
        member(f,get("/api/v1/jobs/"+pending+"/report"),Map.of()).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("report_pending"));
        member(f,get("/api/v1/jobs/999999999/report"),Map.of()).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("job_not_found"));
        mvc.perform(get("/api/v1/jobs/"+archived+"/report")).andExpect(status().isUnauthorized());
        jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) SELECT ?,?,id,'NONE',CURRENT_TIMESTAMP FROM users WHERE username='admin'",Long.parseLong(f.ws()),Long.parseLong(f.project()));
        org.mockito.Mockito.clearInvocations(observedJobs);
        member(f,get("/api/v1/jobs/"+archived+"/report"),Map.of()).andExpect(status().isForbidden());
        member(f,get("/api/v1/jobs/"+pending+"/report"),Map.of()).andExpect(status().isForbidden());
        org.mockito.Mockito.verify(observedJobs,org.mockito.Mockito.never()).reportPayload(org.mockito.ArgumentMatchers.anyLong());
        assertThat(jobRepo.reportContent(Long.parseLong(archived))).isEqualTo(content);
    }
    @Test void scheduledCleanupUsesCurrentRetentionAndBoundedBatchesWithoutRemovingIntentOrAcknowledgementIdentity()throws Exception{
        var f=fixture();var old=List.of(archive(f,true),archive(f,true),archive(f,true));
        var originalSubmissions=new HashMap<String,com.fasterxml.jackson.databind.JsonNode>();for(String job:old)originalSubmissions.put(job,jobRepo.require(Long.parseLong(job),false).submission());
        String active=archive(f,false),pending=seed(f,"ended"),referenced=archive(f,true);
        jobRepo.outbox(Long.parseLong(f.agent()),Long.parseLong(referenced),Long.parseLong(execution(referenced)),"cancel","held-reference",Map.of("synthetic","unacknowledged"));
        jdbc.update("INSERT INTO execution_management_audit(actor_id,action,scope_type,scope_id,created_at) VALUES(1,'retention-old','project',?,?)",Long.parseLong(f.project()),OffsetDateTime.ofInstant(clock.instant().minus(Duration.ofDays(2)),ZoneOffset.UTC));
        clock.set(clock.instant().plus(Duration.ofDays(2)));
        jdbc.update("UPDATE execution_management_audit SET created_at=? WHERE action<>'retention-old'",OffsetDateTime.ofInstant(clock.instant(),ZoneOffset.UTC));
        scheduled.tick(); // No new bean/method lookup: absent production scheduling simply has no effect.
        assertThat(old).allSatisfy(job->assertThat(jobRepo.reportContent(Long.parseLong(job))).isEqualTo(content));
        member(f,put(f.url()+"/execution-settings"),Map.of("expectedVersion","1","agentIds",List.of(f.agent()),"defaultAgentId",f.agent(),"policy",Map.of("resultRetentionDays",1))).andExpect(status().isOk());
        scheduled.tick();
        org.assertj.core.api.SoftAssertions softly=new org.assertj.core.api.SoftAssertions();
        softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=? AND report_state='expired'",Long.class,Long.parseLong(f.project()))).isEqualTo(2);
        softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_management_audit WHERE action='retention-old' AND scope_id=?",Long.class,Long.parseLong(f.project()))).isZero();
        softly.assertAll();
        var cleanupMethod=ExecutionRetentionCleanup.class.getMethod("cleanup");
        // Spring 6.2 Task supplies an OutcomeTrackingRunnable; inspect its real method delegate.
        assertThat(scheduled.tasks).filteredOn(task->org.springframework.util.ReflectionUtils.findField(task.action().getClass(),"runnable")!=null && ReflectionTestUtils.getField(task.action(),"runnable") instanceof ScheduledMethodRunnable action
            && action.getTarget() instanceof ExecutionRetentionCleanup && action.getMethod().equals(cleanupMethod))
            .singleElement().satisfies(task->assertThat(task.delay()).isEqualTo(Duration.ofMillis(1234)));
        scheduled.tick();
        for(String job:old){
            assertThat(jobRepo.reportContent(Long.parseLong(job))).isNull();
            var saved=jobRepo.require(Long.parseLong(job),false);assertThat(saved.reportHash()).isEqualTo(Hashes.sha256Hex(content));assertThat(saved.reportBytes()).isEqualTo((long)content.length);
            assertThat(jobRepo.receipt(Long.parseLong(f.agent()),"ended-"+job)).isNotNull();
            member(f,get("/api/v1/jobs/"+job+"/report"),Map.of()).andExpect(status().isGone()).andExpect(jsonPath("$.code").value("report_expired"));
            // The same historical intent returns the same identity, never a new queued execution.
            member(f,post(f.url()+"/jobs"),originalSubmissions.get(job)).andExpect(status().isCreated()).andExpect(jsonPath("$.jobId").value(job));
            mvc.perform(put("/api/v1/runner/jobs/"+job+"/report?executionId="+execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",Hashes.sha256Hex(content)).contentType("application/octet-stream").content(content)).andExpect(status().isOk());
            assertThat(jobRepo.reportContent(Long.parseLong(job))).isNull();
            assertThat(jobRepo.require(Long.parseLong(job),false).reportState()).isEqualTo("expired");
        }
        assertThat(jobRepo.reportContent(Long.parseLong(active))).isEqualTo(content);assertThat(jobRepo.require(Long.parseLong(pending),false).reportState()).isNotEqualTo("expired");assertThat(jobRepo.reportContent(Long.parseLong(referenced))).isEqualTo(content);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_snapshots WHERE id=?",Long.class,Long.parseLong(f.snapshot()))).isEqualTo(1);
        String unknown=archive(f,true);
        jdbc.update("UPDATE execution_jobs SET report_retained_at=NULL WHERE id=?",Long.parseLong(unknown));
        clock.set(clock.instant().plus(Duration.ofDays(91)));scheduled.tick();
        var anchor=jdbc.queryForObject("SELECT report_retained_at FROM execution_jobs WHERE id=?",OffsetDateTime.class,Long.parseLong(unknown));
        assertThat(anchor.toInstant()).isEqualTo(clock.instant());assertThat(jobRepo.reportContent(Long.parseLong(unknown))).isEqualTo(content);
        // Reapplying the real idempotent schema is the restart migration seam; it must retain the anchor.
        new org.springframework.jdbc.datasource.init.ResourceDatabasePopulator(new org.springframework.core.io.ClassPathResource("schema.sql")).execute(Objects.requireNonNull(jdbc.getDataSource()));
        assertThat(jdbc.queryForObject("SELECT report_retained_at FROM execution_jobs WHERE id=?",OffsetDateTime.class,Long.parseLong(unknown))).isEqualTo(anchor);
        clock.set(clock.instant().plus(Duration.ofHours(23)));scheduled.tick();assertThat(jobRepo.reportContent(Long.parseLong(unknown))).isEqualTo(content);
    }
}
