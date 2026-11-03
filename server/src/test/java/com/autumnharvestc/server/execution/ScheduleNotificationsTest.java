package com.autumnharvestc.server.execution;

import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import com.autumnharvestc.server.execution.scheduling.ScheduledJobSubmission;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@org.springframework.test.context.TestPropertySource(properties="spring.datasource.url=jdbc:h2:mem:apicc-t5-events;DB_CLOSE_DELAY=-1")
class ScheduleNotificationsTest extends OccurrenceFixture {
    @Autowired com.autumnharvestc.server.access.AccessFixtureRevisions eventVersions;
    @Autowired ScheduledJobSubmission submission;
    @Autowired com.autumnharvestc.server.execution.notifications.NotificationEventService notificationEvents;
    @Autowired com.autumnharvestc.server.execution.notifications.NotificationTimer notificationTimer;
    @Autowired com.autumnharvestc.server.execution.scheduling.NotificationProperties outbound;
    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean com.autumnharvestc.server.execution.notifications.NotificationEventRepo notificationRepo;
    @Autowired org.springframework.transaction.PlatformTransactionManager notificationTransactions;
    @org.junit.jupiter.api.BeforeEach void isolateNotificationSources(){
        jdbc.update("UPDATE execution_notification_outbox SET state='failed',reason_code='fixture-finished',lease_until_utc=NULL WHERE state IN ('pending','sending')");
        jdbc.update("DELETE FROM execution_notification_events");jdbc.update("UPDATE execution_schedule_occurrences SET notification_processed_version=1");
        jdbc.update("UPDATE execution_schedules SET notifications_json=?","{\"inApp\":false,\"eventKinds\":[],\"channelIds\":[]}");
    }
    String url(F f){return "/api/v1/workspaces/"+f.ws()+"/notifications";}
    void expired(F f)throws Exception{once(f);now(origin.plusSeconds(60));occurrences.scan("expiry");now(origin.plusSeconds(361));occurrences.scan("expiry-finished");}
    void denyHistory(F f) throws Exception {
        String user=String.valueOf(scheduleUsers.findByUsername("admin").orElseThrow().id());String endpoint=f.url()+"/access-members/"+user;
        // An active positive ACL keeps the old SQL NONE-only shortcut from preempting the history target.
        member(f,put(f.url()+"/acl"),Map.of("userId",user,"role","ADMIN","expectedRevision",eventVersions.acl(f.ws(),f.project(),user))).andExpect(status().isOk());
        var visible=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).path("items");
        assertThat(visible).anySatisfy(event->assertThat(event.path("projectId").asText()).isEqualTo(f.project()));
        long revision=body(member(f,get(endpoint),Map.of()).andExpect(status().isOk())).path("revision").asLong();
        member(f,put(endpoint),Map.of("expectedRevision",revision,"capabilities",Map.of("history.read","deny"))).andExpect(status().isOk());
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"page","read","notification-history","schedule-history"})
    void historyWithdrawalHidesActualResultSurfaces(String route) throws Exception {
        var f=fixture();expired(f);var event=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).path("items").get(0);
        String id=event.path("id").asText(),schedule=f.url()+"/schedules/"+event.path("scheduleId").asText();
        member(f,post(url(f)+"/"+id+"/read"),Map.of()).andExpect(status().isOk());
        member(f,get(schedule+"/notification-history"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].eventKind").value("expired"));
        member(f,get(schedule+"/history"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].state").value("expired"));
        String readId=id;if(route.equals("read")){expired(f);readId=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).path("items").get(0).path("id").asText();}
        String unreadId=readId;
        denyHistory(f);
        if(route.equals("page"))member(f,get(url(f)),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items").isEmpty());
        else if(route.equals("read")){var response=member(f,post(url(f)+"/"+unreadId+"/read"),Map.of());org.junit.jupiter.api.Assertions.assertAll(()->response.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden")),()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_reads WHERE event_id=?",Long.class,Long.valueOf(unreadId))).isZero());}
        else member(f,get(schedule+(route.equals("notification-history")?"/notification-history":"/history")),Map.of()).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
        // Configuration/contract metadata is independent of reading actual historical results.
        member(f,get(schedule),Map.of()).andExpect(status().isOk());
    }
    @Test void historyFilteringPrecedesNotificationPageLimit() throws Exception {
        var visible=fixture();expired(visible);var hidden=fixture();expired(hidden);expired(hidden);expired(hidden);
        member(hidden,get(url(hidden)).param("limit","1"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].projectId").value(hidden.project()));
        denyHistory(hidden);
        member(visible,get(url(visible)).param("limit","1"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].projectId").value(visible.project())).andExpect(jsonPath("$.nextBeforeId").isEmpty());
    }
    @Test void pendingMembershipCannotLeakNotificationResults() throws Exception {
        var f=fixture();expired(f);String name="pending-notif-"+f.project();
        String user=body(mvc.perform(post("/api/v1/auth/register").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123","displayName","Pending notification")))).andExpect(status().isCreated())).path("id").asText();
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123")))).andExpect(status().isOk())).path("token").asText();
        member(f,put("/api/v1/workspaces/"+f.ws()+"/members/"+user),eventVersions.memberFields(f.ws(),user,"EDITOR")).andExpect(status().isOk());
        member(f,put(f.url()+"/acl"),Map.of("userId",user,"role","ADMIN","expectedRevision",eventVersions.acl(f.ws(),f.project(),user))).andExpect(status().isOk());
        var target=new F(token,f.ws(),f.group(),f.project(),f.snapshot(),f.agent(),f.agentToken(),f.assets());
        member(target,get(url(f)),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(1));
        member(f,delete("/api/v1/workspaces/"+f.ws()+"/members/"+user).param("expectedRevision",String.valueOf(eventVersions.member(f.ws(),user))),Map.of()).andExpect(status().isNoContent());
        member(f,put("/api/v1/workspaces/"+f.ws()+"/members/"+user),eventVersions.memberFields(f.ws(),user,"EDITOR")).andExpect(status().isOk());
        member(target,get(f.url()+"/access"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.overrideState").value("pending-confirmation"));
        member(target,get(url(f)),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items").isEmpty());
    }
    @Test void ordinaryCapabilityRecordDoesNotHideReadableNotifications() throws Exception {
        var f=fixture();expired(f);member(f,get(url(f)),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(1));
        String user=String.valueOf(scheduleUsers.findByUsername("admin").orElseThrow().id());
        member(f,put(f.url()+"/access-members/"+user),Map.of("expectedRevision",0,"capabilities",Map.of("script.edit","deny"))).andExpect(status().isOk());
        var access=body(member(f,get(f.url()+"/access"),Map.of()).andExpect(status().isOk()));
        assertThat(access.path("capabilities")).anySatisfy(value->assertThat(value.asText()).isEqualTo("history.read"));
        assertThat(access.path("overrideState").asText()).isEqualTo("inherited");
        member(f,get(url(f)),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(1));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"disabled","removed"})
    void notificationPageRechecksQualificationAfterObservationWait(String loss) throws Exception {
        var f=fixture();expired(f);String name="notif-wait-"+java.util.UUID.randomUUID().toString().substring(0,12);
        String user=body(mvc.perform(post("/api/v1/auth/register").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123","displayName","Notification reader")))).andExpect(status().isCreated())).path("id").asText();
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123")))).andExpect(status().isOk())).path("token").asText();
        member(f,put("/api/v1/workspaces/"+f.ws()+"/members/"+user),eventVersions.memberFields(f.ws(),user,"VIEWER")).andExpect(status().isOk());
        var target=new F(token,f.ws(),f.group(),f.project(),f.snapshot(),f.agent(),f.agentToken(),f.assets());
        member(target,get(url(f)),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(1));
        var held=new java.util.concurrent.CountDownLatch(1);var release=new java.util.concurrent.CountDownLatch(1);var entered=new java.util.concurrent.CountDownLatch(1);
        var holderSession=new java.util.concurrent.atomic.AtomicLong();var readerSession=new java.util.concurrent.atomic.AtomicLong();
        org.mockito.Mockito.doAnswer(invocation->{if(Thread.currentThread().getName().equals("task5-notification-reader")){readerSession.set(jdbc.queryForObject("SELECT SESSION_ID()",Long.class));entered.countDown();}return invocation.callRealMethod();}).when(notificationRepo).gate();
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(3)) {
            var holder=pool.submit(()->new org.springframework.transaction.support.TransactionTemplate(notificationTransactions).executeWithoutResult(tx->{notificationRepo.gate();holderSession.set(jdbc.queryForObject("SELECT SESSION_ID()",Long.class));held.countDown();try{if(!release.await(10,java.util.concurrent.TimeUnit.SECONDS))throw new IllegalStateException("notification holder release timed out");}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IllegalStateException(e);}}));
            java.util.concurrent.Future<org.springframework.test.web.servlet.ResultActions> pending=null;
            try {
                assertThat(held.await(3,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                pending=pool.submit(()->{Thread.currentThread().setName("task5-notification-reader");return member(target,get(url(f)),Map.of());});
                assertThat(entered.await(3,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                long until=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);boolean blocked=false;
                while(System.nanoTime()<until){if(jdbc.queryForObject("SELECT COUNT(*) FROM INFORMATION_SCHEMA.SESSIONS WHERE SESSION_ID=? AND BLOCKER_ID=?",Long.class,readerSession.get(),holderSession.get())>0){blocked=true;break;}java.util.concurrent.TimeUnit.MILLISECONDS.sleep(10);}
                assertThat(blocked).as("actual notification HTTP reader waits at observation DB gate").isTrue();
                pool.submit(()->{if(loss.equals("disabled"))member(f,post("/api/v1/admin/users/"+user+"/disable"),Map.of("expectedRevision",1)).andExpect(status().isNoContent());else member(f,delete("/api/v1/workspaces/"+f.ws()+"/members/"+user).param("expectedRevision",String.valueOf(eventVersions.member(f.ws(),user))),Map.of()).andExpect(status().isNoContent());return true;}).get(3,java.util.concurrent.TimeUnit.SECONDS);
            } finally {release.countDown();}
            holder.get(5,java.util.concurrent.TimeUnit.SECONDS);pending.get(5,java.util.concurrent.TimeUnit.SECONDS).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
        }
    }
    @Test void realExpiredOccurrenceProducesOneSafeDurableEvent() throws Exception {
        var f=fixture();once(f);now(origin.plusSeconds(60));occurrences.scan("notification-source");
        now(origin.plusSeconds(361));occurrences.scan("notification-expiry");
        String url="/api/v1/workspaces/"+f.ws()+"/notifications";
        var first=body(member(f,get(url),Map.of()).andExpect(status().isOk()));
        assertThat(first.path("items").size()).isEqualTo(1);
        assertThat(first.at("/items/0/eventKind").asText()).isEqualTo("expired");
        assertThat(first.at("/items/0/reasonCode").asText()).isEqualTo("schedule-queue-expired");
        String id=first.at("/items/0/id").asText();
        assertThat(body(member(f,get(url),Map.of()).andExpect(status().isOk())).at("/items/0/id").asText()).isEqualTo(id);
        assertThat(first.toString()).doesNotContain("task_json","request","response","script","agentToken","password","environment");
    }
    @Test void latestProjectPermissionFiltersPreviouslyVisibleEvents()throws Exception{
        var f=fixture();expired(f);assertThat(body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).path("items").size()).isEqualTo(1);
        long user=scheduleUsers.findByUsername("admin").orElseThrow().id();
        jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) VALUES(?,?,?,'NONE',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),user);
        assertThat(body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).path("items").size()).isZero();
    }
    @Test void readIsIdempotentAndBelongsToOneMember()throws Exception{
        var f=fixture();expired(f);String id=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).at("/items/0/id").asText();
        member(f,post(url(f)+"/"+id+"/read"),Map.of()).andExpect(status().isOk());member(f,post(url(f)+"/"+id+"/read"),Map.of()).andExpect(status().isOk());
        assertThat(body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).at("/items/0/read").asBoolean()).isTrue();
        String username="notif"+System.nanoTime();var registered=body(mvc.perform(post("/api/v1/auth/register").contentType("application/json").content(json.writeValueAsString(Map.of("username",username,"password","safe-synthetic-pass","displayName","通知成员")))).andExpect(status().isCreated()));
        long user=registered.path("id").asLong();String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",username,"password","safe-synthetic-pass")))).andExpect(status().isOk())).path("token").asText();
        jdbc.update("INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,'VIEWER',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),user);
        var second=body(mvc.perform(get(url(f)).header("Authorization","Bearer "+token)).andExpect(status().isOk()));assertThat(second.at("/items/0/read").asBoolean()).isFalse();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.CsvSource({"failed,failed","timed-out,abnormal","passed,succeeded"})
    void realJobTerminalProjectionKeepsVerdictEvidenceAndPendingReportIndependent(String verdict,String kind)throws Exception{
        var f=fixture();String plan=once(f);member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","2","notifications",Map.of("inApp",true,"eventKinds",List.of(kind),"channelIds",List.of()))).andExpect(status().isOk());
        now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));String job=submission.submit(occurrences.scan("real-job").getFirst()).orElseThrow().jobId();
        beat(f,1,1);send(f,message(job,"accepted","n-accepted")).andExpect(status().isOk());send(f,start(job)).andExpect(status().isOk());
        var done=message(job,"completed","n-done");done.putAll(Map.of("verdict",verdict,"finishedAt","2035-01-01T00:01:01Z","executionReleased",true,"evidenceComplete",false,"reportHash",HASH,"reportBytes",1,"reasonCode","secret-token-synthetic"));send(f,done).andExpect(status().isOk());
        var value=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk()));assertThat(value.path("items").size()).isEqualTo(1);var event=value.at("/items/0");
        assertThat(event.path("eventKind").asText()).isEqualTo(kind);assertThat(event.path("verdict").asText()).isEqualTo(verdict);assertThat(event.path("evidenceState").asText()).isEqualTo("incomplete");assertThat(event.path("reportState").asText()).isEqualTo("pending");assertThat(event.path("notificationState").asText()).isEqualTo("in-app");assertThat(value.toString()).doesNotContain("secret-token-synthetic");
        assertThat(event.path("snapshotId").asText()).isEqualTo(f.snapshot());assertThat(event.path("finishedAtUtc").asText()).isEqualTo("2035-01-01T00:01:01Z");assertThat(event.has("startedAtUtc")).isTrue();assertThat(event.path("startedAtUtc").isNull()).isTrue();
        assertThat(body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).at("/items/0/id").asText()).isEqualTo(event.path("id").asText());
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"not-selected","in-app-disabled"})
    void eventPreferencesAreObservedOnce(String preference)throws Exception{
        var f=fixture();String plan=once(f);member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","2","notifications",Map.of("inApp",!preference.equals("in-app-disabled"),"eventKinds",preference.equals("not-selected")?List.of("failed"):List.of("expired"),"channelIds",List.of()))).andExpect(status().isOk());now(origin.plusSeconds(60));occurrences.scan("pref");now(origin.plusSeconds(361));occurrences.scan("pref-end");
        assertThat(body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).path("items").size()).isZero();
        member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","3","notifications",Map.of("inApp",true,"eventKinds",List.of("expired"),"channelIds",List.of()))).andExpect(status().isOk());assertThat(body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).path("items").size()).isZero();
    }
    @Test void budgetPauseUsesTheActualPlanVersionWithoutInventingOccurrence()throws Exception{
        var f=fixture();String plan=cron(f,"catch-up-one",300000);member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","2","policies",Map.of("lateToleranceMs",10000,"misfire","catch-up-one","catchupWindowMs",86400000,"overlap","skip","queueTimeoutMs",300000))).andExpect(status().isOk());int old=schedulerProperties.getEvaluationMaxCandidates();
        try{schedulerProperties.setEvaluationMaxCandidates(10);now(origin.plusSeconds(3600));occurrences.scan("budget-pause");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(plan))).isZero();
            var event=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).at("/items/0");assertThat(event.path("eventKind").asText()).isEqualTo("paused");assertThat(event.path("reasonCode").asText()).isEqualTo("schedule-evaluation-limit");assertThat(event.path("sourceVersion").asText()).isEqualTo("4");assertThat(event.path("sourceId").asText()).isEqualTo("schedule/"+plan);
        }finally{schedulerProperties.setEvaluationMaxCandidates(old);}
    }
    @Test void observerPersistsWithoutAMemberReadingOrBeingOnline()throws Exception{
        var f=fixture();expired(f);long end=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(3);long count=0;
        while(System.nanoTime()<end){count=jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_events WHERE project_id=?",Long.class,Long.valueOf(f.project()));if(count>0)break;Thread.sleep(20);}
        assertThat(count).as("durable polling runs without notification GET").isEqualTo(1);
    }
    @Test void memberPagesUseAStableCursorAndApplyVisibilityBeforeThePageLimit()throws Exception{
        var f=fixture();expired(f);String first=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).at("/items/0/id").asText();expired(f);expired(f);
        var page=body(member(f,get(url(f)+"?limit=1"),Map.of()).andExpect(status().isOk()));assertThat(page.path("items").size()).isEqualTo(1);assertThat(page.path("nextBeforeId").isNull()).isFalse();String cursor=page.path("nextBeforeId").asText();var second=body(member(f,get(url(f)+"?limit=1&beforeId="+cursor),Map.of()).andExpect(status().isOk()));assertThat(second.path("items").size()).isEqualTo(1);assertThat(second.at("/items/0/id").asText()).isNotEqualTo(page.at("/items/0/id").asText());
        member(f,get(url(f)+"?limit=0"),Map.of()).andExpect(status().isBadRequest());wire("t5-notification-center",page);
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(booleans={true,false})
    void cancellationSkipIsExplicitlySelectedAndAnUnselectedSourceIsConsumed(boolean selected)throws Exception{
        var f=fixture();String plan=once(f);if(selected)member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","2","notifications",Map.of("inApp",true,"eventKinds",List.of("skipped"),"channelIds",List.of()))).andExpect(status().isOk());now(origin.plusSeconds(60));occurrences.scan("skip-source");member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion",selected?"3":"2","enabled",false)).andExpect(status().isOk());
        var page=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk()));assertThat(page.path("items").size()).isEqualTo(1); // Default paused event may coexist; check occurrence kinds explicitly.
        var kinds=new ArrayList<String>();page.path("items").forEach(e->kinds.add(e.path("eventKind").asText()));assertThat(kinds).contains(selected?"skipped":"paused");if(!selected){assertThat(kinds).doesNotContain("skipped");member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","3","notifications",Map.of("inApp",true,"eventKinds",List.of("skipped"),"channelIds",List.of()))).andExpect(status().isOk());var after=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk()));assertThat(after.path("items").findValuesAsText("eventKind")).doesNotContain("skipped");}
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.CsvSource({"intent_source_conflict,intent_source_conflict","synthetic-secret-machine-code,schedule-rejected"})
    void realAuthorityRejectionUsesOnlyAnAllowedSafeReason(String producerReason,String expected)throws Exception{
        var f=fixture();once(f);now(origin.plusSeconds(60));var claim=occurrences.scan("rejected-source").getFirst();com.autumnharvestc.server.execution.scheduling.NotificationAuthorityFixture.reject(occurrences,claim,producerReason);var page=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk()));assertThat(page.path("items").size()).isEqualTo(1);assertThat(page.at("/items/0/eventKind").asText()).isEqualTo("failed");assertThat(page.at("/items/0/reasonCode").asText()).isEqualTo(expected);assertThat(page.toString()).doesNotContain("synthetic-secret-machine-code");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.CsvSource({"controls,safename","only,未命名"})
    void sourceNamesAreBoundedBusinessLabelsWithoutControlCharacters(String form,String expected)throws Exception{
        var f=fixture();String plan=once(f);member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","2","name",form.equals("controls")?"safe\nname\t":"\u202e")).andExpect(status().isOk());now(origin.plusSeconds(60));occurrences.scan("safe-name");now(origin.plusSeconds(361));occurrences.scan("safe-name-end");var event=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).at("/items/0");assertThat(event.path("scheduleName").asText()).isEqualTo(expected);
    }
    @Test void blockedWebhookDispatchCannotBlockSchedulerWakeOrExceedConfiguredConcurrency()throws Exception{
        var release=new java.util.concurrent.CountDownLatch(1);var entered=new java.util.concurrent.CountDownLatch(2);var active=new java.util.concurrent.atomic.AtomicInteger();var maximum=new java.util.concurrent.atomic.AtomicInteger();
        try(var endpoint=new WebhookTransportTest.Endpoint("127.0.0.1",e->{int n=active.incrementAndGet();maximum.accumulateAndGet(n,Math::max);entered.countDown();try{release.await(4,java.util.concurrent.TimeUnit.SECONDS);e.sendResponseHeaders(204,-1);}catch(Exception ignored){}finally{active.decrementAndGet();e.close();}},3)){
            var f=fixture();String originUrl=endpoint.origin("127.0.0.1");outbound.setAllowedWebhookOrigins(List.of(originUrl));outbound.setAllowHttpOrigins(List.of(originUrl));outbound.setAllowedWebhookCidrs(List.of("127.0.0.1/32"));String channel=body(member(f,post("/api/v1/workspaces/"+f.ws()+"/notification-channels"),Map.of("expectedVersion","0","name","阻塞合成端","url",originUrl+"/","hmacSecret","synthetic-hmac-secret","enabled",true,"limits",Map.of("requestTimeoutMs",3000,"maxAttempts",2,"retryMinMs",1000,"retryMaxMs",2000,"jitterRatio",0.0,"deliveryTtlMs",60000,"maxPayloadBytes",16384,"maxResponseBytes",128))).andExpect(status().isCreated())).path("id").asText();
            for(int i=0;i<3;i++){String plan=once(f);member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","2","notifications",Map.of("inApp",false,"eventKinds",List.of("expired"),"channelIds",List.of(channel)))).andExpect(status().isOk());now(origin.plusSeconds(60));occurrences.scan("background-source");now(origin.plusSeconds(361));occurrences.scan("background-expiry");}notificationEvents.observe(Long.valueOf(f.ws()));
            long start=System.nanoTime();notificationTimer.wake();assertThat(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)).isLessThan(500);assertThat(entered.await(2,java.util.concurrent.TimeUnit.SECONDS)).as("real dispatch workers enter receiver while wake has returned").isTrue();assertThat(endpoint.count).hasValue(2);start=System.nanoTime();notificationTimer.wake();assertThat(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)).isLessThan(500);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_outbox WHERE project_id=? AND state='pending'",Long.class,Long.valueOf(f.project()))).isEqualTo(1);
            release.countDown();long end=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(3);while(System.nanoTime()<end){notificationTimer.wake();if(jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_outbox WHERE project_id=? AND state='acknowledged'",Long.class,Long.valueOf(f.project()))==3)break;Thread.sleep(20);}assertThat(endpoint.count).hasValue(3);assertThat(maximum.get()).isLessThanOrEqualTo(outbound.getConcurrency());
        }finally{release.countDown();outbound.setAllowedWebhookOrigins(List.of());outbound.setAllowHttpOrigins(List.of());outbound.setAllowedWebhookCidrs(List.of());}
    }
    @Test void schedulerWakeEventuallyPrunesAConsumedOldSourceWithoutMemberGet()throws Exception{
        var f=fixture();expired(f);notificationEvents.observe(Long.valueOf(f.ws()));now(origin.plusSeconds(31L*86400));notificationTimer.wake();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_events WHERE project_id=? AND body_json IS NULL",Long.class,Long.valueOf(f.project()))).isEqualTo(1);
    }
    @Test void drainedWorkspacesDoNotOccupyTheBoundedObserverPage()throws Exception{
        jdbc.update("UPDATE execution_schedules SET notification_processed_version=version");var f=fixture();expired(f);notificationEvents.observe(Long.valueOf(f.ws()));assertThat(notificationRepo.workspaces(1)).doesNotContain(Long.valueOf(f.ws()));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"name","notifications","stop"})
    void anObservedPauseCannotBeRecreatedByAnOrdinaryEditOrRepeatedStop(String edit)throws Exception{
        var f=fixture();now(origin);String plan=body(member(f,post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated())).path("id").asText();var before=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk()));String event=before.at("/items/0/id").asText();var patch=new LinkedHashMap<String,Object>();patch.put("expectedVersion","1");if(edit.equals("name"))patch.put("name","普通名称编辑");else if(edit.equals("stop"))patch.put("enabled",false);else patch.put("notifications",Map.of("inApp",true,"eventKinds",List.of("paused"),"channelIds",List.of()));member(f,put(f.url()+"/schedules/"+plan),patch).andExpect(status().isOk());var after=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk()));assertThat(after.path("items").size()).isEqualTo(1);assertThat(after.at("/items/0/id").asText()).isEqualTo(event);assertThat(after.at("/items/0/sourceVersion").asText()).isEqualTo("1");
    }
    @Test void anUnselectedPauseCannotBeBackfilledByChangingNotificationPreferences()throws Exception{
        var f=fixture();now(origin);var input=save(f);input.put("notifications",Map.of("inApp",true,"eventKinds",List.of("failed"),"channelIds",List.of()));String plan=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();assertThat(body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).path("items").size()).isZero();member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","1","notifications",Map.of("inApp",true,"eventKinds",List.of("paused"),"channelIds",List.of()))).andExpect(status().isOk());assertThat(body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).path("items").size()).isZero();
    }
    @Test void automaticPauseKeepsTheActualCauseAndSourceVersionAcrossMetadataEdits()throws Exception{
        var f=fixture();String plan=cron(f,"catch-up-one",300000);member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","2","policies",Map.of("lateToleranceMs",10000,"misfire","catch-up-one","catchupWindowMs",86400000,"overlap","skip","queueTimeoutMs",300000))).andExpect(status().isOk());int budget=schedulerProperties.getEvaluationMaxCandidates();try{schedulerProperties.setEvaluationMaxCandidates(10);now(origin.plusSeconds(3600));occurrences.scan("pause-source-budget");var changed=body(member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","4","name","仅改名称")).andExpect(status().isOk()));assertThat(changed.path("pausedReasonCode").asText()).isEqualTo("schedule-evaluation-limit");var event=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk())).at("/items/0");assertThat(event.path("sourceVersion").asText()).isEqualTo("4");assertThat(event.path("reasonCode").asText()).isEqualTo("schedule-evaluation-limit");}finally{schedulerProperties.setEvaluationMaxCandidates(budget);}
    }
    @Test void reenablePauseAndDeletionFormOnlyRealNewPauseSources()throws Exception{
        var f=fixture();now(origin);String plan=body(member(f,post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated())).path("id").asText();notificationEvents.observe(Long.valueOf(f.ws()));member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","2","enabled",false)).andExpect(status().isOk());notificationEvents.observe(Long.valueOf(f.ws()));member(f,put(f.url()+"/schedules/"+plan),Map.of("expectedVersion","3","enabled",false)).andExpect(status().isOk());notificationEvents.observe(Long.valueOf(f.ws()));member(f,delete(f.url()+"/schedules/"+plan+"?expectedVersion=4"),Map.of()).andExpect(status().isNoContent());var page=body(member(f,get(url(f)),Map.of()).andExpect(status().isOk()));assertThat(page.path("items").findValuesAsText("sourceVersion")).containsExactly("5","3","1");assertThat(page.at("/items/0/reasonCode").asText()).isEqualTo("schedule-deleted");
    }
}
