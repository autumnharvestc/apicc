package com.autumnharvestc.server.execution;

import java.util.*;
import org.junit.jupiter.api.Test;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.assertj.core.api.Assertions.*;

class ScheduleDriverFencingTest extends OccurrenceFixture {
    @org.springframework.beans.factory.annotation.Autowired org.springframework.transaction.PlatformTransactionManager occurrenceTransactions;
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"scan","claim","submit"})
    void authorityOrchestrationRejectsAnAmbientTransactionBeforeAnyPartialChange(String operation)throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var claim=operation.equals("scan")?null:occurrences.scan("original").getFirst();if(operation.equals("claim"))now(origin.plusSeconds(91));
        var tx=new org.springframework.transaction.support.TransactionTemplate(occurrenceTransactions);
        assertThatThrownBy(()->tx.execute(status->switch(operation){case "scan"->occurrences.scan("nested");case "claim"->occurrences.claim("nested",claim.id());default->occurrences.submit(claim,context->originalJob(f,context));})).isInstanceOf(IllegalStateException.class).hasMessageContaining("outside");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isEqualTo(operation.equals("scan")?0L:1L);
        if(claim!=null)assertThat(jdbc.queryForObject("SELECT owner_id FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("original");
    }
    @Test void laterPlanEditsCannotCancelAnAlreadySubmittedOriginalJob()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("submitted-owner").getFirst();var link=occurrences.submit(claim,context->originalJob(f,context)).orElseThrow();
        member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","enabled",false)).andExpect(status().isOk());assertThat(state(link.jobId())).isEqualTo("queued");assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("submitted");
        member(f,get(f.url()+"/schedules/"+id+"/history"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].execution.availability").value("available")).andExpect(jsonPath("$.items[0].execution.state").value("queued")).andExpect(jsonPath("$.items[0].execution.released").value(false)).andExpect(jsonPath("$.items[0].execution.reportState").value("none"));
    }
    @Test void anOldClaimCannotBorrowANewerLeaseGrantedToTheSameOwner()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var old=occurrences.scan("same-owner").getFirst();now(origin.plusSeconds(91));occurrences.claim("same-owner",old.id()).orElseThrow();
        assertThat(occurrences.submit(old,context->originalJob(f,context))).isEmpty();
    }
    @Test void recoveryRechecksTheOriginalSubjectsCurrentAuthority()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();long subject=scheduleUsers.findByUsername("admin").orElseThrow().id();
        try{jdbc.update("UPDATE users SET disabled=TRUE WHERE id=?",subject);now(origin.plusSeconds(91));assertThat(occurrences.claim("restarted",claim.id())).isEmpty();assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("rejected");}
        finally{jdbc.update("UPDATE users SET disabled=FALSE WHERE id=?",subject);}
    }
    @Test void submissionAuthorityLossPersistsRejectionAfterOriginalTransactionRollsBack()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();long subject=scheduleUsers.findByUsername("admin").orElseThrow().id();
        try{jdbc.update("UPDATE users SET disabled=TRUE WHERE id=?",subject);assertThatCode(()->occurrences.submit(claim,context->originalJob(f,context))).doesNotThrowAnyException();assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("rejected");}
        finally{jdbc.update("UPDATE users SET disabled=FALSE WHERE id=?",subject);}
    }
    @Test void cleanedTerminalIdentityCannotBeClaimedOrSubmittedAgain()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();jdbc.update("UPDATE execution_schedule_occurrences SET state='expired' WHERE id=?",Long.valueOf(claim.id()));jdbc.update("DELETE FROM execution_schedule_occurrences WHERE id=?",Long.valueOf(claim.id()));
        assertThatCode(()->{assertThat(occurrences.claim("old-driver",claim.id())).isEmpty();assertThat(occurrences.submit(claim,context->originalJob(f,context))).isEmpty();}).doesNotThrowAnyException();
    }
    @Test void manualEmbeddedDriversAndOuterWakeUseTheCommonDatabaseAuthority()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));
        new com.autumnharvestc.server.execution.scheduling.EmbeddedScheduleDriver(occurrences,scheduledSubmission,"embedded-one").tick();
        new com.autumnharvestc.server.execution.scheduling.EmbeddedScheduleDriver(occurrences,scheduledSubmission,"embedded-two").tick();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isEqualTo(1);
    }
    @Test void outerWakeAdmitsThroughTheRealAuthority()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));new com.autumnharvestc.server.execution.scheduling.EmbeddedScheduleTimer(occurrences,scheduledSubmission).wake();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isEqualTo(1);
    }
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.execution.jobs.JobService originalJobs;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.execution.scheduling.ScheduledJobSubmission scheduledSubmission;
    com.autumnharvestc.server.execution.scheduling.ScheduleOccurrenceService.JobLink originalJob(F f,com.autumnharvestc.server.execution.scheduling.ScheduleOccurrenceService.SubmissionContext context){
        var e=context.execution();var request=new com.autumnharvestc.server.execution.jobs.JobDtos.Submit(context.intentId(),e.agentId(),e.snapshotId(),e.target(),e.environmentId(),null,e.runConfig(),context.materials(),e.preparation(),e.network());
        var job=originalJobs.submit(scheduleUsers.findByUsername("admin").orElseThrow(),f.ws(),f.project(),request);
        return new com.autumnharvestc.server.execution.scheduling.ScheduleOccurrenceService.JobLink((String)job.get("jobId"),(String)job.get("executionId"));
    }
    @Test void guardedSubmissionAtomicallyLinksARealOriginalJob()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();
        var link=occurrences.submit(claim,context->originalJob(f,context));assertThat(link).isPresent();
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("submitted");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isEqualTo(1);
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"lease","owner","generation","disabled","revision","disable-enable","terminal","barrier","deadline"})
    void staleClaimCannotCreateOrLinkAnyJob(String change)throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();
        switch(change){
            case "lease"->now(origin.plusSeconds(90));case "deadline"->now(origin.plusSeconds(360));
            case "owner"->claim=new com.autumnharvestc.server.execution.scheduling.ScheduleOccurrenceService.Claim(claim.id(),"other",claim.generation(),claim.revision(),claim.cancellationVersion(),claim.leaseUntilUtc());
            case "barrier"->claim=new com.autumnharvestc.server.execution.scheduling.ScheduleOccurrenceService.Claim(claim.id(),claim.ownerId(),claim.generation(),claim.revision(),"999",claim.leaseUntilUtc());
            case "generation"->{control.change(new com.autumnharvestc.server.execution.scheduling.ScheduleControlService.Update("disabled","1"));control.change(new com.autumnharvestc.server.execution.scheduling.ScheduleControlService.Update("embedded","2"));}
            case "disabled"->control.change(new com.autumnharvestc.server.execution.scheduling.ScheduleControlService.Update("disabled","1"));
            case "revision"->member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","rule",Map.of("kind","once","atUtc","2035-01-01T00:02:00Z","timeZone","Asia/Shanghai"))).andExpect(status().isOk());
            case "disable-enable"->{member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","enabled",false)).andExpect(status().isOk());member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","3","enabled",true)).andExpect(status().isOk());}
            case "terminal"->jdbc.update("UPDATE execution_schedule_occurrences SET state='expired' WHERE id=?",Long.valueOf(claim.id()));
        }
        assertThat(occurrences.submit(claim,context->originalJob(f,context))).isEmpty();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
    }
    @Test void leaseExpirationDuringCallbackRollsBackTheRealJobAndAssociation()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();
        assertThat(occurrences.submit(claim,context->{var link=originalJob(f,context);now(origin.plusSeconds(90));return link;})).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"missing","scope","intent","execution"})
    void callbackCannotForgeARealMatchingJobAssociation(String invalid)throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();
        String otherJob=invalid.equals("missing")?"9223372036854775807":seed(invalid.equals("scope")?fixture():f,"queued");
        var forged=new com.autumnharvestc.server.execution.scheduling.ScheduleOccurrenceService.JobLink(otherJob,invalid.equals("missing")||invalid.equals("execution")?"9223372036854775807":execution(otherJob));
        assertThatThrownBy(()->occurrences.submit(claim,context->forged)).isInstanceOf(IllegalStateException.class);
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("pending");
    }
    @Test void cannotStealAnUnexpiredLease()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();now(origin.plusSeconds(89));
        assertThat(occurrences.claim("other",claim.id())).isEmpty();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"submitted","skipped","rejected","expired"})
    void terminalRecordsCannotBeReclaimed(String state)throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();jdbc.update("UPDATE execution_schedule_occurrences SET state=? WHERE id=?",state,Long.valueOf(claim.id()));now(origin.plusSeconds(91));
        assertThat(occurrences.claim("other",claim.id())).isEmpty();
    }
    @Test void disabledControlCannotGrantARecoveryLease()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();control.change(new com.autumnharvestc.server.execution.scheduling.ScheduleControlService.Update("disabled","1"));now(origin.plusSeconds(91));
        assertThat(occurrences.claim("other",claim.id())).isEmpty();
    }
    @Test void originalQueueDeadlineExpiresTheOccurrenceWithoutRenewingIt()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("owner").getFirst();now(origin.plusSeconds(360));
        assertThat(occurrences.claim("late",claim.id())).isEmpty();assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(claim.id()))).isEqualTo("expired");
    }
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.execution.scheduling.ScheduleControlService control;
    @org.junit.jupiter.api.BeforeEach void resetControl(){jdbc.update("UPDATE execution_scheduler_control SET mode='embedded',version=1,generation=1 WHERE id=1");}
    @Test void changesModeWithIncreasingPersistentGeneration()throws Exception {
        var f=fixture();member(f,put("/api/v1/scheduler/control"),Map.of("mode","disabled","expectedVersion","1")).andExpect(status().isOk())
            .andExpect(jsonPath("$.mode").value("disabled")).andExpect(jsonPath("$.generation").value("2")).andExpect(jsonPath("$.version").value("2"));
    }
    @Test void exposesPersistentEmbeddedControlWithStringVersions()throws Exception {
        var f=fixture();member(f,get("/api/v1/scheduler/control"),Map.of()).andExpect(status().isOk())
            .andExpect(jsonPath("$.mode").value("embedded")).andExpect(jsonPath("$.generation").value("1")).andExpect(jsonPath("$.version").value("1"));
    }
    @Test void rejectsStaleControlVersion()throws Exception {
        var f=fixture();member(f,put("/api/v1/scheduler/control"),Map.of("mode","disabled","expectedVersion","0")).andExpect(status().isConflict());
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"generation","version"})
    void rejectsExhaustedControlCounters(String column)throws Exception {
        var f=fixture();jdbc.update("UPDATE execution_scheduler_control SET "+column+"=? WHERE id=1",Long.MAX_VALUE);
        member(f,put("/api/v1/scheduler/control"),Map.of("mode","disabled","expectedVersion",column.equals("version")?String.valueOf(Long.MAX_VALUE):"1")).andExpect(status().isConflict());
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"external","unknown",""})
    void rejectsUnregisteredMode(String mode)throws Exception {
        var f=fixture();member(f,put("/api/v1/scheduler/control"),Map.of("mode",mode,"expectedVersion","1")).andExpect(status().isBadRequest());
    }
    @Test void rejectsDeploymentMismatchWithoutResettingPersistentAuthority(){
        assertThatThrownBy(()->control.initialize("disabled")).isInstanceOf(IllegalStateException.class).hasMessageContaining("expectedVersion");
        assertThat(control.read().mode()).isEqualTo("embedded");
    }
    @Test void disabledControlStopsAdmissionAndProjectsUnavailableOptions()throws Exception {
        var f=fixture();once(f);control.change(new com.autumnharvestc.server.execution.scheduling.ScheduleControlService.Update("disabled","1"));now(origin.plusSeconds(60));
        assertThat(occurrences.scan("disabled-driver")).isEmpty();
        member(f,get(f.url()+"/schedules/options"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.schedulerAvailable").value(false));
    }
    @Test void optionsFollowPersistentModeEvenWhenDeploymentStillEmbedded()throws Exception {
        var f=fixture();control.change(new com.autumnharvestc.server.execution.scheduling.ScheduleControlService.Update("disabled","1"));
        member(f,get(f.url()+"/schedules/options"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.schedulerAvailable").value(false));
    }
    @Test void claimsFreezeThePersistentGenerationAfterVersionedHandoff()throws Exception {
        var f=fixture();once(f);control.change(new com.autumnharvestc.server.execution.scheduling.ScheduleControlService.Update("disabled","1"));control.change(new com.autumnharvestc.server.execution.scheduling.ScheduleControlService.Update("embedded","2"));now(origin.plusSeconds(60));
        assertThat(occurrences.scan("new-generation")).singleElement().extracting(c->c.generation()).isEqualTo("3");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"GET","PUT"})
    void ordinaryAuthenticatedUserCannotReadOrMutatePlatformControl(String method)throws Exception {
        String name="control-"+java.util.UUID.randomUUID().toString().substring(0,12);
        mvc.perform(post("/api/v1/auth/register").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123","displayName",name)))).andExpect(status().isCreated());
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123")))).andExpect(status().isOk())).path("token").asText();
        mvc.perform((method.equals("GET")?get("/api/v1/scheduler/control"):put("/api/v1/scheduler/control").contentType("application/json").content("{\"mode\":\"disabled\",\"expectedVersion\":\"1\"}")).header("Authorization","Bearer "+token)).andExpect(status().isForbidden());
    }
}
