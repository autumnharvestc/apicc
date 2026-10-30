package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.execution.scheduling.*;
import com.autumnharvestc.server.execution.jobs.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class ScheduledRecoveryTest extends OccurrenceFixture {
    @org.springframework.beans.factory.annotation.Autowired ScheduledJobSubmission scheduledSubmission;
    @org.springframework.beans.factory.annotation.Autowired ScheduleOccurrenceRepo occurrenceRows;
    @org.springframework.beans.factory.annotation.Autowired ScheduleRetentionService retention;
    String recurring(F f,String overlap)throws Exception {
        now(origin);var input=save(f);input.put("rule",Map.of("kind","cron","expression","0 * * * * *","timeZone","Asia/Shanghai","dstOverlap","first"));
        input.put("policies",Map.of("lateToleranceMs",10000,"misfire","skip","catchupWindowMs",300000,"overlap",overlap,"queueTimeoutMs",300000));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();
        member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());return id;
    }
    @Test void skipIncludesPendingPredecessor()throws Exception {
        var f=fixture();String id=recurring(f,"skip");now(origin.plusSeconds(60));occurrences.scan("first");now(origin.plusSeconds(120));occurrences.scan("second");
        assertThat(jdbc.queryForList("SELECT state FROM execution_schedule_occurrences WHERE schedule_id=? ORDER BY planned_at_utc",String.class,Long.valueOf(id))).containsExactly("pending","skipped");
        assertThat(jdbc.queryForObject("SELECT reason_code FROM execution_schedule_occurrences WHERE schedule_id=? AND state='skipped'",String.class,Long.valueOf(id))).isEqualTo("schedule-overlap-skipped");
    }
    @Test void queueOneKeepsOneFixedDeadline()throws Exception {
        var f=fixture();String id=recurring(f,"queue-one");now(origin.plusSeconds(60));occurrences.scan("first");now(origin.plusSeconds(120));occurrences.scan("second");now(origin.plusSeconds(180));occurrences.scan("third");
        assertThat(jdbc.queryForList("SELECT state FROM execution_schedule_occurrences WHERE schedule_id=? ORDER BY planned_at_utc",String.class,Long.valueOf(id))).containsExactly("pending","waiting-overlap","skipped");
        assertThat(jdbc.queryForObject("SELECT queue_deadline_utc FROM execution_schedule_occurrences WHERE schedule_id=? AND state='waiting-overlap'",java.time.OffsetDateTime.class,Long.valueOf(id)).toInstant()).isEqualTo(origin.plusSeconds(420));
    }
    @Test void historyProjectsTheRealJob()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("history").getFirst();
        var link=scheduledSubmission.submit(claim).orElseThrow();
        var response=member(f,get(f.url()+"/schedules/"+id+"/history"),Map.of()).andExpect(status().isOk())
            .andExpect(jsonPath("$.items[0].jobId").value(link.jobId())).andExpect(jsonPath("$.items[0].execution.availability").value("available"))
            .andExpect(jsonPath("$.items[0].execution.state").value("queued")).andExpect(jsonPath("$.items[0].execution.released").value(false)).andExpect(jsonPath("$.items[0].execution.reportState").value("none"));
        wire("t4-scheduled-history",body(response));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"queued","preparing","running","cancel-requested","archived-without-release"})
    void samePlanBlocksUntilPhysicalReleaseOfTheOriginalJob(String previous)throws Exception {
        var f=fixture();String id=recurring(f,"skip");now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));String job=scheduledSubmission.submit(occurrences.scan("first").getFirst()).orElseThrow().jobId();
        if(!previous.equals("queued")){
            beat(f,1,1);send(f,message(job,"accepted","accepted-"+job)).andExpect(status().isOk());
            if(!previous.equals("preparing")){send(f,start(job)).andExpect(status().isOk());var started=message(job,"started","started-"+job);started.putAll(Map.of("permitId",jobRepo.require(Long.valueOf(job),false).permitId(),"startedAt","2035-01-01T00:01:01Z"));send(f,started).andExpect(status().isOk());}
        }
        if(previous.equals("cancel-requested"))member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isOk());
        if(previous.equals("archived-without-release")){
            byte[] bytes="report while execution remains active".getBytes(java.nio.charset.StandardCharsets.UTF_8);String hash=com.autumnharvestc.server.core.Hashes.sha256Hex(bytes);
            mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",hash).contentType("application/octet-stream").content(bytes)).andExpect(status().isOk());
        }
        now(origin.plusSeconds(120));occurrences.scan("overlap");assertThat(jdbc.queryForList("SELECT state FROM execution_schedule_occurrences WHERE schedule_id=? ORDER BY planned_at_utc",String.class,Long.valueOf(id))).containsExactly("submitted","skipped");
        assertThat(jobRepo.require(Long.valueOf(job),false).released()).isFalse();
    }
    @Test void releasedExecutionUnblocksOneWaiterBeforeReportArchive()throws Exception {
        var f=fixture();String id=recurring(f,"queue-one");now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));String job=scheduledSubmission.submit(occurrences.scan("first").getFirst()).orElseThrow().jobId();beat(f,1,1);send(f,message(job,"accepted","accepted-"+job)).andExpect(status().isOk());send(f,start(job)).andExpect(status().isOk());
        now(origin.plusSeconds(120));occurrences.scan("waiting");var done=message(job,"completed","released-before-report");done.putAll(Map.of("verdict","passed","finishedAt","2035-01-01T00:02:00Z","executionReleased",true,"evidenceComplete",true,"reportHash",HASH,"reportBytes",1));send(f,done).andExpect(status().isOk());
        assertThat(jobRepo.require(Long.valueOf(job),false).released()).isTrue();assertThat(jobRepo.require(Long.valueOf(job),false).reportState()).isEqualTo("pending");
        now(origin.plusSeconds(121));var waiting=occurrences.scan("release-observer").getFirst();assertThat(scheduledSubmission.submit(waiting)).isPresent();
        assertThat(jdbc.queryForList("SELECT state FROM execution_schedule_occurrences WHERE schedule_id=? ORDER BY planned_at_utc",String.class,Long.valueOf(id))).containsExactly("submitted","submitted");
        assertThat(jdbc.queryForObject("SELECT queue_deadline_utc FROM execution_schedule_occurrences WHERE id=?",java.time.OffsetDateTime.class,Long.valueOf(waiting.id())).toInstant()).isEqualTo(origin.plusSeconds(420));
    }
    @Test void recreatedDriversRecoverOnlyTheOriginalClaimAndNeverRecreateASubmittedJob()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var stale=occurrences.scan("before-driver-restart").getFirst();
        now(origin.plusSeconds(91));new EmbeddedScheduleDriver(occurrences,scheduledSubmission,"after-driver-restart").tick();String job=jdbc.queryForObject("SELECT job_id FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(stale.id()));assertThat(job).isNotNull();
        now(origin.plusSeconds(122));new EmbeddedScheduleDriver(occurrences,scheduledSubmission,"after-commit-restart").tick();assertThat(scheduledSubmission.submit(stale)).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isEqualTo(1);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isEqualTo(1);
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"plan-disabled","control-disabled","report-pending"})
    void boundedScanObservesRealReleasedJobsEvenWhenNewSchedulingIsDisabled(String disabled)throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));var claim=occurrences.scan("submitted").getFirst();String job=scheduledSubmission.submit(claim).orElseThrow().jobId();
        if(disabled.equals("report-pending")){
            beat(f,1,1);send(f,message(job,"accepted","accepted-"+job)).andExpect(status().isOk());send(f,start(job)).andExpect(status().isOk());var done=message(job,"completed","done-with-pending-report");done.putAll(Map.of("verdict","passed","finishedAt","2035-01-01T00:01:01Z","executionReleased",true,"evidenceComplete",true,"reportHash",HASH,"reportBytes",1));send(f,done).andExpect(status().isOk());
        }else member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isOk());
        if(disabled.equals("control-disabled"))jdbc.update("UPDATE execution_scheduler_control SET mode='disabled',generation=generation+1,version=version+1 WHERE id=1");
        else member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","enabled",false)).andExpect(status().isOk());
        now(origin.plusSeconds(120));occurrences.scan("observe-release");
        assertThat(jdbc.queryForObject("SELECT terminal_at_utc FROM execution_schedule_occurrences WHERE id=?",java.time.OffsetDateTime.class,Long.valueOf(claim.id()))).as("release is observed through a bounded scan, not a reverse Job callback").isEqualTo(origin.plusSeconds(120).atOffset(java.time.ZoneOffset.UTC));
        now(origin.plusSeconds(121));occurrences.scan("observe-again");assertThat(jdbc.queryForObject("SELECT terminal_at_utc FROM execution_schedule_occurrences WHERE id=?",java.time.OffsetDateTime.class,Long.valueOf(claim.id()))).isEqualTo(origin.plusSeconds(120).atOffset(java.time.ZoneOffset.UTC));
        assertThat(jobRepo.require(Long.valueOf(job),false).reportState()).isEqualTo(disabled.equals("report-pending")?"pending":"none");
    }
    @Test void originalQueueDeadlineExpiresAnAbandonedClaimBeforeItsLongerLeaseEnds()throws Exception {
        var f=fixture();String id=once(f);member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","policies",Map.of("lateToleranceMs",10000,"misfire","skip","catchupWindowMs",300000,"overlap","skip","queueTimeoutMs",1000))).andExpect(status().isOk());
        now(origin.plusSeconds(60));var claim=occurrences.scan("abandoned-before-job").getFirst();
        now(origin.plusSeconds(61));assertThat(occurrences.scan("deadline-before-lease")).isEmpty();
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("expired");
        assertThat(scheduledSubmission.submit(claim)).isEmpty();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
    }
    @Test void retentionConsumesTheRealReleasedJobProofAndKeepsPermanentJobOrigin()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("retained-source").getFirst();String job=scheduledSubmission.submit(claim).orElseThrow().jobId();var source=jobRepo.scheduleOrigin(Long.valueOf(job)).orElseThrow();
        assertThat(occurrenceRows.hasReleasedJob(occurrenceRows.row(Long.valueOf(claim.id()),false))).isFalse();
        member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isOk());now(origin.plusSeconds(61));occurrences.scan("observe-cancelled-before-assignment");
        assertThat(occurrenceRows.hasReleasedJob(occurrenceRows.row(Long.valueOf(claim.id()),false))).isTrue();now(origin.plusSeconds(31L*86400));
        // No notification implementation is registered here; T5 owns the real second proof.
        assertThat(retention.prune(List.of(claim.id()),row->new ScheduleRetentionService.Proof(occurrenceRows.hasReleasedJob(row),true))).isEqualTo(1);
        assertThat(occurrenceRows.find(Long.valueOf(claim.id()),false)).isEmpty();assertThat(jobRepo.scheduleOrigin(Long.valueOf(job))).contains(source);assertThat(jobRepo.require(Long.valueOf(job),false).released()).isTrue();
    }
    @Test void releaseObservationIsBoundedByTheExistingBatchSize()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var first=occurrences.scan("first").getFirst();String firstJob=scheduledSubmission.submit(first).orElseThrow().jobId();
        var other=fixture();once(other);now(origin.plusSeconds(60));var second=occurrences.scan("second").getFirst();String secondJob=scheduledSubmission.submit(second).orElseThrow().jobId();
        member(f,post("/api/v1/jobs/"+firstJob+"/cancel"),Map.of()).andExpect(status().isOk());member(other,post("/api/v1/jobs/"+secondJob+"/cancel"),Map.of()).andExpect(status().isOk());int batch=schedulerProperties.getBatchSize();
        try{schedulerProperties.setBatchSize(1);now(origin.plusSeconds(61));occurrences.scan("bounded-release");assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE id IN (?,?) AND terminal_at_utc IS NOT NULL",Long.class,Long.valueOf(first.id()),Long.valueOf(second.id()))).isEqualTo(1);}
        finally{schedulerProperties.setBatchSize(batch);}
    }
}
