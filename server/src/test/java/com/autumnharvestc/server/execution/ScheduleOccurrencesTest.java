package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.execution.scheduling.*;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import static org.mockito.Mockito.when;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@org.springframework.context.annotation.Import(OccurrenceFixture.TransactionGateConfiguration.class)
abstract class OccurrenceFixture extends ScheduleFixture {
    @org.springframework.beans.factory.annotation.Autowired ScheduleOccurrenceService occurrences;
    @MockitoBean ScheduleTimeSource scheduleClock;
    @org.springframework.beans.factory.annotation.Autowired GatedTransactions gatedTransactions;
    static class GatedTransactions extends org.springframework.transaction.support.TransactionTemplate {
        private volatile java.util.concurrent.CyclicBarrier beginGate;
        GatedTransactions(org.springframework.transaction.PlatformTransactionManager manager){super(manager);}
        void gate(java.util.concurrent.CyclicBarrier value){beginGate=value;}
        @Override public <T>T execute(org.springframework.transaction.support.TransactionCallback<T> callback){return super.execute(status->{
            var gate=beginGate;
            if(gate!=null&&Thread.currentThread().getName().startsWith("schedule-concurrent-")){
                assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
                try{gate.await(10,java.util.concurrent.TimeUnit.SECONDS);}catch(Exception error){throw new IllegalStateException(error);}
            }
            return callback.doInTransaction(status);
        });}
    }
    @org.springframework.boot.test.context.TestConfiguration
    static class TransactionGateConfiguration {
        @org.springframework.context.annotation.Bean @org.springframework.context.annotation.Primary
        GatedTransactions scheduleTransactions(org.springframework.transaction.PlatformTransactionManager manager){return new GatedTransactions(manager);}
    }
    final Instant origin=Instant.parse("2035-01-01T00:00:00Z");
    @org.junit.jupiter.api.BeforeEach void isolateSchedules(){jdbc.update("UPDATE execution_schedules SET enabled=FALSE,next_planned_at_utc=NULL");jdbc.update("UPDATE execution_scheduler_control SET mode='embedded',generation=1,version=1 WHERE id=1");jdbc.update("UPDATE execution_schedule_occurrences SET state='skipped',lease_until_utc=NULL WHERE state IN ('pending','waiting-overlap')");}
    @org.junit.jupiter.api.AfterEach void releaseFixtureSchedules(){jdbc.update("UPDATE execution_schedules SET enabled=FALSE,next_planned_at_utc=NULL");jdbc.update("UPDATE execution_scheduler_control SET mode='embedded',generation=1,version=1 WHERE id=1");}
    void now(Instant value){when(scheduleClock.now()).thenReturn(value);}
    String once(F f)throws Exception {
        now(origin);var input=save(f);input.put("rule",Map.of("kind","once","atUtc","2035-01-01T00:01:00Z","timeZone","Asia/Shanghai"));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();
        member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());return id;
    }
    String cron(F f,String misfire,long queue)throws Exception {
        now(origin);var input=save(f);input.put("rule",Map.of("kind","cron","expression","0 * * * * *","timeZone","Asia/Shanghai","dstOverlap","first"));
        input.put("policies",Map.of("lateToleranceMs",10000,"misfire",misfire,"catchupWindowMs",300000,"overlap","skip","queueTimeoutMs",queue));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());return id;
    }
}

class ScheduleOccurrencesTest extends OccurrenceFixture {
    @Test void databaseTimeSourceCanObserveAnElapsedLeaseWithinOneRealTransaction(){
        var databaseTime=new DatabaseScheduleTimeSource(jdbc);var tx=new org.springframework.transaction.support.TransactionTemplate(transactionManager);
        tx.executeWithoutResult(status->{
            var initial=databaseTime.now();var deadline=initial.plusMillis(5);long finish=System.nanoTime()+java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(20);
            while(System.nanoTime()<finish)jdbc.queryForObject("SELECT 1",Integer.class);
            assertThat(databaseTime.now()).as("database lease expiry must become observable inside the holding transaction").isAfterOrEqualTo(deadline);
        });
    }
    @Test void aLegalNanosecondOnceIsDueAtItsExactOriginalUtcIdentity()throws Exception {
        var f=fixture();now(origin);var input=save(f);String planned="2035-01-01T00:01:00.123456789Z";input.put("rule",Map.of("kind","once","atUtc",planned,"timeZone","Asia/Shanghai"));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());now(Instant.parse(planned));
        assertThat(occurrences.scan("nanosecond-due")).hasSize(1);assertThat(jdbc.queryForObject("SELECT planned_at_utc FROM execution_schedule_occurrences WHERE schedule_id=?",java.time.OffsetDateTime.class,Long.valueOf(id)).toInstant()).isEqualTo(Instant.parse(planned));
    }
    @Test void denseCronConsumesGapNoticeOnlyWhenItsAdvancedPrefixCrossesTheGap()throws Exception {
        var f=fixture();var previous=body(member(f,get("/api/v1/workspaces/"+f.ws()+"/schedule-policy"),Map.of()).andExpect(status().isOk()));
        var config=jdbc.query("SELECT version,config_json,applied_version,pending_fields_json,restart_fields_json FROM execution_configs WHERE scope_type='schedule-ws' AND scope_id=?",(r,n)->List.<Object>of(r.getLong(1),r.getString(2),r.getLong(3),r.getString(4),r.getString(5)),Long.valueOf(f.ws()));
        try{
            member(f,put("/api/v1/workspaces/"+f.ws()+"/schedule-policy"),Map.of("expectedVersion",previous.path("version").asText(),"policy",Map.of("minIntervalMs",1000))).andExpect(status().isOk());
            now(Instant.parse("2030-03-10T06:59:55Z"));var input=save(f);input.put("rule",Map.of("kind","cron","expression","* * * * * *","timeZone","America/New_York","dstOverlap","first"));
            String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());now(Instant.parse("2030-03-10T07:00:05Z"));occurrences.scan("before-prefix-crossing");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_missed_windows WHERE schedule_id=? AND reason_code='dst-gap-skipped'",Long.class,Long.valueOf(id))).isZero();
            for(int i=0;i<10;i++)occurrences.scan("advance-prefix");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_missed_windows WHERE schedule_id=? AND reason_code='dst-gap-skipped'",Long.class,Long.valueOf(id))).isEqualTo(1);
        }finally{
            if(config.isEmpty())jdbc.update("DELETE FROM execution_configs WHERE scope_type='schedule-ws' AND scope_id=?",Long.valueOf(f.ws()));
            else{var old=config.getFirst();jdbc.update("UPDATE execution_configs SET version=?,config_json=?,applied_version=?,pending_fields_json=?,restart_fields_json=? WHERE scope_type='schedule-ws' AND scope_id=?",old.get(0),old.get(1),old.get(2),old.get(3),old.get(4),Long.valueOf(f.ws()));}
        }
    }
    @Test void aRevisionCannotRecreateTheSameUtcIdentityEvenAfterClockRollback()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));occurrences.scan("revision-one");now(origin.plusSeconds(59));
        member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","policies",Map.of("lateToleranceMs",10000,"misfire","skip","catchupWindowMs",600000,"overlap","skip","queueTimeoutMs",300000))).andExpect(status().isOk());now(origin.plusSeconds(60));assertThat(occurrences.scan("revision-two")).isEmpty();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isEqualTo(1);
    }
    @Test void historyPagesActualRowsAndMissedWindowsIndependentlyAndKeepsDeletedPlanReadable()throws Exception {
        var f=fixture();String id=cron(f,"catch-up-one",300000);now(origin.plusSeconds(235));occurrences.scan("first-history");now(origin.plusSeconds(475));occurrences.scan("second-history");
        var first=body(member(f,get(f.url()+"/schedules/"+id+"/history?limit=1"),Map.of()).andExpect(status().isOk()));assertThat(first.path("nextBeforeId").isTextual()).isTrue();assertThat(first.path("nextMissedBeforeId").isTextual()).isTrue();
        var second=body(member(f,get(f.url()+"/schedules/"+id+"/history?limit=1&beforeId="+first.path("nextBeforeId").asText()+"&missedBeforeId="+first.path("nextMissedBeforeId").asText()),Map.of()).andExpect(status().isOk()));assertThat(second.path("items").get(0).path("id")).isNotEqualTo(first.path("items").get(0).path("id"));assertThat(second.path("missedWindows").get(0).path("id")).isNotEqualTo(first.path("missedWindows").get(0).path("id"));
        var other=fixture();member(other,get(other.url()+"/schedules/"+id+"/history"),Map.of()).andExpect(status().isNotFound());member(f,delete(f.url()+"/schedules/"+id+"?expectedVersion=2"),Map.of()).andExpect(status().isNoContent());member(f,get(f.url()+"/schedules/"+id+"/history"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.evaluationStatus").value("deleted"));
    }
    @Test void explicitResumeUsesNowAfterTheDurableWatermarkWithoutCatchingUpThePause()throws Exception {
        var f=fixture();String id=cron(f,"catch-up-one",300000);now(origin.plusSeconds(60));occurrences.scan("before-pause");member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","enabled",false)).andExpect(status().isOk());now(origin.plusSeconds(235));member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","3","enabled",true)).andExpect(status().isOk()).andExpect(jsonPath("$.nextPlannedAtUtc").value("2035-01-01T00:04:00Z"));assertThat(occurrences.scan("resumed-before-next")).isEmpty();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"no-adapter","no-proof","active-job","pending-notification","pending","lease","young"})
    void retentionRequiresTerminalAgeNoLeaseAndCompleteReferenceProof(String unsafe)throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("retention-safety").getFirst();
        if(!unsafe.equals("pending")){now(origin.plusSeconds(360));occurrences.claim("expire",claim.id());}
        now(origin.plusSeconds((unsafe.equals("young")?29L:31L)*86400));
        if(unsafe.equals("lease"))jdbc.update("UPDATE execution_schedule_occurrences SET lease_until_utc=? WHERE id=?",origin.plusSeconds(32L*86400).atOffset(java.time.ZoneOffset.UTC),Long.valueOf(claim.id()));
        ScheduleRetentionService.References references=unsafe.equals("no-adapter")?null:row->unsafe.equals("no-proof")?null:new ScheduleRetentionService.Proof(!unsafe.equals("active-job"),!unsafe.equals("pending-notification"));
        assertThat(retention.prune(List.of(claim.id()),references)).isZero();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE id=?",Long.class,Long.valueOf(claim.id()))).isEqualTo(1);
    }
    @Test void retentionNeverExceedsTheConfiguredBatch()throws Exception {
        var a=fixture();once(a);now(origin.plusSeconds(60));var first=occurrences.scan("retention-a").getFirst();now(origin.plusSeconds(360));occurrences.claim("expire-a",first.id());
        var b=fixture();once(b);now(origin.plusSeconds(60));var second=occurrences.scan("retention-b").getFirst();now(origin.plusSeconds(360));occurrences.claim("expire-b",second.id());now(origin.plusSeconds(31L*86400));int batch=schedulerProperties.getBatchSize();
        try{schedulerProperties.setBatchSize(1);assertThat(retention.prune(List.of(first.id(),second.id()),row->new ScheduleRetentionService.Proof(true,true))).isEqualTo(1);}finally{schedulerProperties.setBatchSize(batch);}
    }
    @Test void catchupNeverRenewsAnAlreadyElapsedOriginalQueueDeadline()throws Exception {
        var f=fixture();String id=once(f);member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","policies",Map.of("lateToleranceMs",10000,"misfire","catch-up-one","catchupWindowMs",300000,"overlap","skip","queueTimeoutMs",1000))).andExpect(status().isOk());now(origin.plusSeconds(71));
        assertThat(occurrences.scan("expired-at-observation")).isEmpty();assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE schedule_id=?",String.class,Long.valueOf(id))).isEqualTo("expired");
    }
    @Test void boundedWindowCannotConfuseItsBudgetEdgeWithTheEndOfACron(){
        assertThatThrownBy(()->calculator.boundedDue(new ScheduleDtos.CronRule("* * * * * *","Asia/Shanghai","first"),origin,origin.plusSeconds(10),1000,10)).isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getCode()).isEqualTo("schedule-evaluation-limit"));
    }
    @Test void historyIncludesLargestEntityIdWhenThereIsNoCursor()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("largest-id").getFirst();jdbc.update("UPDATE execution_schedule_occurrences SET id=? WHERE id=?",Long.MAX_VALUE,Long.valueOf(claim.id()));
        member(f,get(f.url()+"/schedules/"+id+"/history"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].id").value(String.valueOf(Long.MAX_VALUE)));
    }
    @org.springframework.beans.factory.annotation.Autowired ScheduleRetentionService retention;
    @Test void boundedRetentionDeletesAnOldTerminalDetailWithCompleteReferenceProof()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("retention").getFirst();now(origin.plusSeconds(360));occurrences.claim("expired",claim.id());now(origin.plusSeconds(31L*86400));
        assertThat(retention.prune(List.of(claim.id()),row->new ScheduleRetentionService.Proof(true,true))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE id=?",Long.class,Long.valueOf(claim.id()))).isZero();
        assertThat(jdbc.queryForObject("SELECT evaluated_through_utc FROM execution_schedules WHERE id=?",java.time.OffsetDateTime.class,Long.valueOf(id))).isNotNull();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"resume","revision"})
    void evaluationBaselineChangesDoNotClaimAGapFromBeforeTheyTookEffect(String change)throws Exception {
        var f=fixture();now(Instant.parse("2030-03-09T08:00:00Z"));var input=save(f);input.put("rule",Map.of("kind","cron","expression",change.equals("revision")?"0 30 1 * * *":"0 30 2 * * *","timeZone","America/New_York","dstOverlap","first"));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());
        if(change.equals("resume")){now(Instant.parse("2030-03-09T09:00:00Z"));member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","enabled",false)).andExpect(status().isOk());}
        now(Instant.parse("2030-03-10T08:00:00Z"));member(f,put(f.url()+"/schedules/"+id),change.equals("resume")?Map.of("expectedVersion","3","enabled",true):Map.of("expectedVersion","2","rule",Map.of("kind","cron","expression","0 30 2 * * *","timeZone","America/New_York","dstOverlap","first"))).andExpect(status().isOk());
        now(Instant.parse("2030-03-11T06:30:00Z"));occurrences.scan("new-baseline");assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_missed_windows WHERE schedule_id=? AND reason_code='dst-gap-skipped'",Long.class,Long.valueOf(id))).isZero();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(booleans={false,true})
    void recordsAnActuallyObservedNewYorkGapAtTheNextLegalEvaluation(boolean precedingOccurrence)throws Exception {
        var f=fixture();now(Instant.parse(precedingOccurrence?"2030-03-09T00:00:00Z":"2030-03-09T08:00:00Z"));var input=save(f);input.put("rule",Map.of("kind","cron","expression","0 30 2 * * *","timeZone","America/New_York","dstOverlap","first"));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());
        if(precedingOccurrence){now(Instant.parse("2030-03-09T07:30:00Z"));occurrences.scan("before-gap");}
        now(Instant.parse("2030-03-11T06:30:00Z"));occurrences.scan("after-gap");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_missed_windows WHERE schedule_id=? AND reason_code='dst-gap-skipped'",Long.class,Long.valueOf(id))).isEqualTo(1);
    }
    @Test void missedGapDoesNotIncludeTheAdmittedBoundaryAfterDatabasePrecisionRounding()throws Exception {
        var f=fixture();String id=cron(f,"catch-up-one",300000);now(origin.plusSeconds(235));occurrences.scan("gap-boundary");
        assertThat(jdbc.queryForObject("SELECT through_utc FROM execution_schedule_missed_windows WHERE schedule_id=?",java.time.OffsetDateTime.class,Long.valueOf(id)).toInstant()).isEqualTo(origin.plusMillis(179999));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(ints={0,101})
    void rejectsHistoryPagingOutsideMemberBounds(int limit)throws Exception {
        var f=fixture();String id=once(f);member(f,get(f.url()+"/schedules/"+id+"/history?limit="+limit),Map.of()).andExpect(status().isBadRequest());
    }
    @Test void historyExposesTypedBusinessFactsAndIndependentMissedWindowPaging()throws Exception {
        var f=fixture();String id=cron(f,"catch-up-one",300000);now(origin.plusSeconds(235));occurrences.scan("history");
        var history=body(member(f,get(f.url()+"/schedules/"+id+"/history?limit=1"),Map.of()).andExpect(status().isOk()));
        assertThat(history.path("items").get(0).path("state").asText()).isEqualTo("pending");assertThat(history.path("items").get(0).path("delayMs").asLong()).isEqualTo(55000);
        assertThat(history.path("items").get(0).path("execution").path("availability").asText()).isEqualTo("not-submitted");
        assertThat(history.path("missedWindows").get(0).path("missedCount").isNull()).isTrue();assertThat(history.toString()).doesNotContain("ownerId","leaseUntil","materials_json");wire("t3-history",history);
    }
    @org.springframework.beans.factory.annotation.Autowired ScheduleRuleCalculator calculator;
    @Test void boundedWindowReturnsMoreThanPreviewFiveAndItsActualLastInstant(){
        var due=calculator.boundedDue(new ScheduleDtos.CronRule("* * * * * *","Asia/Shanghai","first"),origin,origin.plusSeconds(20),1000,50);
        assertThat(due.candidates()).hasSize(20);assertThat(due.candidates().getLast().plannedAtUtc()).isEqualTo("2035-01-01T00:00:20Z");
    }
    @Test void boundedWindowMustNotClaimCompletenessBeyondItsBudget(){
        assertThatThrownBy(()->calculator.boundedDue(new ScheduleDtos.CronRule("* * * * * *","Asia/Shanghai","first"),origin,origin.plusSeconds(20),1000,10)).isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getCode()).isEqualTo("schedule-evaluation-limit"));
    }
    @Test void defaultSkipSealsOldGapAndAdmitsOnlyWithinLateTolerance()throws Exception {
        var f=fixture();String id=cron(f,"skip",300000);now(origin.plusSeconds(241));occurrences.scan("after-outage");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT planned_at_utc FROM execution_schedule_occurrences WHERE schedule_id=?",java.time.OffsetDateTime.class,Long.valueOf(id)).toInstant()).isEqualTo(origin.plusSeconds(240));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_missed_windows WHERE schedule_id=?",Long.class,Long.valueOf(id))).isEqualTo(1);
    }
    @Test void catchupOneAdmitsOnlyLatestWindowCandidateWithOriginalDeadline()throws Exception {
        var f=fixture();String id=cron(f,"catch-up-one",300000);now(origin.plusSeconds(235));occurrences.scan("catch-up");
        assertThat(jdbc.queryForObject("SELECT planned_at_utc FROM execution_schedule_occurrences WHERE schedule_id=?",java.time.OffsetDateTime.class,Long.valueOf(id)).toInstant()).isEqualTo(origin.plusSeconds(180));
        assertThat(jdbc.queryForObject("SELECT queue_deadline_utc FROM execution_schedule_occurrences WHERE schedule_id=?",java.time.OffsetDateTime.class,Long.valueOf(id)).toInstant()).isEqualTo(origin.plusSeconds(480));
    }
    @Test void lateOnceWithSkipCreatesOnlyAMissedWindow()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(71));assertThat(occurrences.scan("late-once")).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isZero();
    }
    @Test void currentPolicyIntervalIsRecheckedAgainstPersistentLastAdmission()throws Exception {
        var f=fixture();String id=cron(f,"skip",300000);now(origin.plusSeconds(60));occurrences.scan("first");
        member(f,put(f.url()+"/schedule-policy"),Map.of("expectedVersion","0","policy",Map.of("minIntervalMs",120000))).andExpect(status().isOk());now(origin.plusSeconds(120));occurrences.scan("too-dense");
        assertThat(jdbc.queryForObject("SELECT paused_reason_code FROM execution_schedules WHERE id=?",String.class,Long.valueOf(id))).isEqualTo("schedule-interval-too-short");
    }
    @Test void evaluationBudgetFailurePersistsReadablePause()throws Exception {
        var f=fixture();now(origin);var input=save(f);input.put("rule",Map.of("kind","cron","expression","0 * * * * *","timeZone","Asia/Shanghai","dstOverlap","first"));input.put("policies",Map.of("lateToleranceMs",10000,"misfire","catch-up-one","catchupWindowMs",86400000,"overlap","skip","queueTimeoutMs",300000));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());int original=schedulerProperties.getEvaluationMaxCandidates();
        try{
            schedulerProperties.setEvaluationMaxCandidates(10);now(origin.plusSeconds(1235));occurrences.scan("bounded");
            var paused=body(member(f,get(f.url()+"/schedules/"+id),Map.of()).andExpect(status().isOk()));
            assertThat(paused.path("enabled").asBoolean()).isFalse();assertThat(paused.path("pausedReasonCode").asText()).isEqualTo("schedule-evaluation-limit");assertThat(paused.path("cancellationVersion").asText()).isEqualTo("1");
            assertThat(paused.path("evaluatedThroughUtc").isNull()).isTrue();assertThat(paused.path("lastAdmittedPlannedAtUtc").isNull()).isTrue();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).as("unproven budget failure must not manufacture a UTC occurrence identity").isZero();
        }
        finally{schedulerProperties.setEvaluationMaxCandidates(original);}
    }
    @Test void budgetPauseCanResumeThroughNormalVersionedApiAfterClockRollback()throws Exception {
        var f=fixture();now(origin);var input=save(f);input.put("rule",Map.of("kind","cron","expression","0 * * * * *","timeZone","Asia/Shanghai","dstOverlap","first"));input.put("policies",Map.of("lateToleranceMs",10000,"misfire","catch-up-one","catchupWindowMs",86400000,"overlap","skip","queueTimeoutMs",300000));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());int original=schedulerProperties.getEvaluationMaxCandidates();
        try{
            schedulerProperties.setEvaluationMaxCandidates(10);now(origin.plusSeconds(1235));occurrences.scan("budget-before-rollback");
            var paused=body(member(f,get(f.url()+"/schedules/"+id),Map.of()).andExpect(status().isOk()));assertThat(paused.path("pausedReasonCode").asText()).isEqualTo("schedule-evaluation-limit");
            now(origin);member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion",paused.path("version").asText(),"enabled",true)).andExpect(status().isOk()).andExpect(jsonPath("$.nextPlannedAtUtc").value("2035-01-01T00:01:00Z"));
            now(origin.plusSeconds(60));assertThatCode(()->occurrences.scan("resumed-after-rollback")).doesNotThrowAnyException();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE schedule_id=?",String.class,Long.valueOf(id))).isEqualTo("pending");
            assertThat(jdbc.queryForObject("SELECT planned_at_utc FROM execution_schedule_occurrences WHERE schedule_id=?",java.time.OffsetDateTime.class,Long.valueOf(id)).toInstant()).isEqualTo(origin.plusSeconds(60));
            assertThat(jdbc.queryForObject("SELECT evaluated_through_utc FROM execution_schedules WHERE id=?",java.time.OffsetDateTime.class,Long.valueOf(id)).toInstant()).isEqualTo(origin.plusSeconds(60));
        }finally{schedulerProperties.setEvaluationMaxCandidates(original);}
    }
    @Test void automaticPauseCancelsOtherOldPendingBeforeAnyResume()throws Exception {
        var f=fixture();String id=cron(f,"skip",300000);now(origin.plusSeconds(60));var old=occurrences.scan("old").getFirst();jdbc.update("UPDATE execution_schedules SET subject_user_id=9223372036854775807 WHERE id=?",Long.valueOf(id));now(origin.plusSeconds(120));occurrences.scan("lost-rights");
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(old.id()))).isEqualTo("skipped");
    }
    @Test void watermarkPreventsRecreationAfterTerminalDetailCleanupOrClockRollback()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));occurrences.scan("first");jdbc.update("DELETE FROM execution_schedule_occurrences WHERE schedule_id=?",Long.valueOf(id));
        jdbc.update("UPDATE execution_schedules SET next_planned_at_utc=TIMESTAMP WITH TIME ZONE '2035-01-01 00:01:00+00' WHERE id=?",Long.valueOf(id));now(origin.plusSeconds(59));assertThat(occurrences.scan("backward")).isEmpty();now(origin.plusSeconds(60));
        assertThat(occurrences.scan("replayed-index")).isEmpty();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isZero();
    }
    @Test void scanRecoversPersistedPendingBeforeScanningNewTimes()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));var first=occurrences.scan("before").getFirst();now(origin.plusSeconds(91));
        assertThat(occurrences.scan("after")).singleElement().extracting(c->c.id()).isEqualTo(first.id());
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"disable","delete","revision"})
    void planBarrierImmediatelySkipsOnlyUnsubmittedRecords(String change)throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));var old=occurrences.scan("old").getFirst();
        if(change.equals("delete"))member(f,delete(f.url()+"/schedules/"+id+"?expectedVersion=2"),Map.of()).andExpect(status().isNoContent());
        else member(f,put(f.url()+"/schedules/"+id),change.equals("disable")?Map.of("expectedVersion","2","enabled",false):Map.of("expectedVersion","2","rule",Map.of("kind","once","atUtc","2035-01-01T00:02:00Z","timeZone","Asia/Shanghai"))).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE id=?",String.class,Long.valueOf(old.id()))).isEqualTo("skipped");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"reauthorize","control","disable","watermark","delete"})
    void rolledBackOldRejectionCannotPauseANewerAuthority(String mutation)throws Exception {
        var f=fixture();String id=once(f);jdbc.update("UPDATE execution_schedules SET subject_user_id=9223372036854775807 WHERE id=?",Long.valueOf(id));
        var armed=new java.util.concurrent.atomic.AtomicBoolean();
        org.mockito.Mockito.when(scheduleClock.now()).thenAnswer(call->{
            if(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()&&armed.compareAndSet(false,true)){
                org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(new org.springframework.transaction.support.TransactionSynchronization(){
                    @Override public void afterCompletion(int status){if(status!=STATUS_ROLLED_BACK)return;
                        var tx=new org.springframework.transaction.support.TransactionTemplate(transactionManager);tx.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
                        tx.executeWithoutResult(s->{
                            if(mutation.equals("control"))jdbc.update("UPDATE execution_scheduler_control SET generation=generation+1,version=version+1 WHERE id=1");
                            else if(mutation.equals("watermark"))jdbc.update("UPDATE execution_schedules SET evaluated_through_utc=TIMESTAMP WITH TIME ZONE '2035-01-01 00:01:00+00' WHERE id=?",Long.valueOf(id));
                            else if(mutation.equals("delete"))schedules.delete(scheduleUsers.findByUsername("admin").orElseThrow(),f.ws(),f.project(),id,"2");
                            else schedules.update(scheduleUsers.findByUsername("admin").orElseThrow(),f.ws(),f.project(),id,new ScheduleDtos.Update("2",null,null,null,null,null,mutation.equals("disable")?false:null,mutation.equals("reauthorize")?true:null,null));
                        });
                    }
                });
            }
            return origin.plusSeconds(60);
        });
        assertThatCode(()->occurrences.scan("rejected-old-authority")).doesNotThrowAnyException();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isZero();
        assertThat(jdbc.queryForObject("SELECT paused_reason_code FROM execution_schedules WHERE id=?",String.class,Long.valueOf(id))).isNotEqualTo("schedule-subject-unavailable");
    }
    @org.springframework.beans.factory.annotation.Autowired org.springframework.transaction.PlatformTransactionManager transactionManager;
    @Test void restartsRecoverTheSamePendingIdentityBeforeNewCandidates()throws Exception {
        var f=fixture();String schedule=once(f);now(origin.plusSeconds(60));var first=occurrences.scan("before-restart").getFirst();
        now(origin.plusSeconds(91));var recovered=occurrences.claim("after-restart",first.id());
        assertThat(recovered).isPresent();assertThat(recovered.orElseThrow().id()).isEqualTo(first.id());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(schedule))).isEqualTo(1);
    }
    @Test void triggerSealsMetadataOnlyMaterialVersionsAtObservationTime()throws Exception {
        var f=fixture();member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","0","value","PRIVATE-ONE")).andExpect(status().isOk());
        now(origin);var input=save(f);input.put("rule",Map.of("kind","once","atUtc","2035-01-01T00:01:00Z","timeZone","Asia/Shanghai"));execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","api","mode","current-at-trigger")),"attachments",List.of()));
        String schedule=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+schedule),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());
        member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","1","value","PRIVATE-TWO")).andExpect(status().isOk());now(origin.plusSeconds(60));occurrences.scan("material-driver");
        String materials=jdbc.queryForObject("SELECT materials_json FROM execution_schedule_occurrences WHERE schedule_id=?",String.class,Long.valueOf(schedule));
        assertThat(materials).isNotNull();assertThat(json.readTree(materials).path("credentials").get(0).path("version").asText()).isEqualTo("2");assertThat(materials).doesNotContain("PRIVATE");
    }
    @Test void missingSubjectProducesReadableRejectionAndPausesFutureTriggers()throws Exception {
        var f=fixture();String id=once(f);jdbc.update("UPDATE execution_schedules SET subject_user_id=9223372036854775807 WHERE id=?",Long.valueOf(id));now(origin.plusSeconds(60));occurrences.scan("authority-driver");
        assertThat(jdbc.queryForObject("SELECT state FROM execution_schedule_occurrences WHERE schedule_id=?",String.class,Long.valueOf(id))).isEqualTo("rejected");
        assertThat(jdbc.queryForObject("SELECT paused_reason_code FROM execution_schedules WHERE id=?",String.class,Long.valueOf(id))).isEqualTo("schedule-subject-unavailable");
    }
    @Test void doesNotAdmitAFutureCandidate()throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(59));
        assertThat(occurrences.scan("early-driver")).isEmpty();
    }
    @Test void concurrentRealTransactionsAdmitOnlyOneUtcIdentity()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));
        var gate=new java.util.concurrent.CyclicBarrier(2);var names=new java.util.concurrent.atomic.AtomicInteger();var pool=java.util.concurrent.Executors.newFixedThreadPool(2,runnable->new Thread(runnable,"schedule-concurrent-"+names.incrementAndGet()));gatedTransactions.gate(gate);
        try{
            var a=pool.submit(()->{try{return (Object)occurrences.scan("one");}catch(Throwable failure){return failure;}});
            var b=pool.submit(()->{try{return (Object)occurrences.scan("two");}catch(Throwable failure){return failure;}});
            Object first=a.get(20,java.util.concurrent.TimeUnit.SECONDS),second=b.get(20,java.util.concurrent.TimeUnit.SECONDS);
            assertThat(first).isInstanceOf(List.class);assertThat(second).isInstanceOf(List.class);
            var claims=new ArrayList<Object>((List<?>)first);claims.addAll((List<?>)second);
            assertThat(claims).hasSize(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(id))).isEqualTo(1);
        }finally{gatedTransactions.gate(null);pool.shutdownNow();}
    }
    @Test void admitsOnePersistedOccurrenceAtThePlannedUtcInstant()throws Exception {
        var f=fixture();String id=once(f);now(origin.plusSeconds(60));
        var admitted=occurrences.scan("driver-one");assertThat(admitted).hasSize(1);
        var row=jdbc.queryForMap("SELECT * FROM execution_schedule_occurrences WHERE schedule_id=?",Long.valueOf(id));
        assertThat(row.get("STATE")).isEqualTo("pending");assertThat(row.get("REVISION")).isEqualTo(1L);
        assertThat(row.get("CANCELLATION_VERSION")).isEqualTo(0L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
    }
}
