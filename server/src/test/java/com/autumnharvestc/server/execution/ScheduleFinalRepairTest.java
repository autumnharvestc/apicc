package com.autumnharvestc.server.execution;

import java.time.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@org.springframework.test.context.TestPropertySource(properties="spring.datasource.url=jdbc:h2:mem:apicc-final-repair;DB_CLOSE_DELAY=-1")
class ScheduleFinalRepairTest extends OccurrenceFixture {
    @org.junit.jupiter.api.BeforeEach @org.junit.jupiter.api.AfterEach void isolatePolicy(){jdbc.update("DELETE FROM execution_configs WHERE scope_type IN ('schedule-ws','schedule-project')");}
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.execution.scheduling.ScheduledJobSubmission submission;

    @ParameterizedTest @ValueSource(strings={"disabled","deleted","unreadable","lowered-policy"})
    void authorizedPurePauseRetainsUnavailableChoicesAndCancelsBothUnsubmittedStates(String cause)throws Exception {
        var f=fixture();now(origin);String channels="/api/v1/workspaces/"+f.ws()+"/notification-channels";
        String channel=body(member(f,post(channels),Map.of("expectedVersion","0","name","old selected channel","url","https://hook.example.test/private","hmacSecret","synthetic-hmac-secret","enabled",true)).andExpect(status().isCreated())).path("id").asText();
        var input=save(f);input.put("rule",Map.of("kind","cron","expression","0 * * * * *","timeZone","UTC","dstOverlap","first"));
        input.put("policies",Map.of("lateToleranceMs",10000,"misfire","skip","catchupWindowMs",300000,"overlap","queue-one","queueTimeoutMs",300000));
        var notifications=Map.of("inApp",true,"eventKinds",List.of("failed"),"channelIds",List.of(channel));input.put("notifications",notifications);
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText(),url=f.url()+"/schedules/"+id;
        member(f,put(url),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());
        now(origin.plusSeconds(60));occurrences.scan("first-pending");now(origin.plusSeconds(120));occurrences.scan("second-waiter");
        assertThat(jdbc.queryForList("SELECT state FROM execution_schedule_occurrences WHERE schedule_id=? ORDER BY planned_at_utc",String.class,Long.valueOf(id))).containsExactly("pending","waiting-overlap");
        if(cause.equals("deleted"))member(f,delete(channels+"/"+channel+"?expectedVersion=1"),Map.of()).andExpect(status().isNoContent());
        else if(cause.equals("unreadable"))jdbc.update("UPDATE execution_notification_channels SET key_id='missing-key' WHERE id=?",Long.valueOf(channel));
        else if(cause.equals("disabled"))member(f,put(channels+"/"+channel),Map.of("expectedVersion","1","enabled",false)).andExpect(status().isOk());
        else member(f,put("/api/v1/workspaces/"+f.ws()+"/schedule-policy"),Map.of("expectedVersion","0","policy",Map.of("queueTimeoutMs",1000,"maxQueueTimeoutMs",1000))).andExpect(status().isOk());
        member(f,put(url),Map.of("expectedVersion","1","enabled",false)).andExpect(status().isConflict());
        member(f,put(url),Map.of("expectedVersion","2","enabled",false,"notifications",Map.of("inApp",true,"eventKinds",List.of("failed"),"channelIds",List.of("9223372036854775807")))).andExpect(status().isConflict());
        member(f,put(url),Map.of("expectedVersion","2","enabled",false)).andExpect(status().isOk())
            .andExpect(jsonPath("$.enabled").value(false)).andExpect(jsonPath("$.cancellationVersion").value("1")).andExpect(jsonPath("$.notifications.channelIds[0]").value(channel));
        assertThat(jdbc.queryForList("SELECT reason_code FROM execution_schedule_occurrences WHERE schedule_id=?",String.class,Long.valueOf(id))).containsExactly("schedule-cancelled","schedule-cancelled");
        member(f,put(url),Map.of("expectedVersion","3","enabled",true)).andExpect(status().is4xxClientError());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
    }

    @Test void newlyAdmittedDeadlineUsesCurrentLowerCapWithoutChangingAnAlreadySealedOccurrence()throws Exception {
        var f=fixture();String id=cron(f,"skip",300000);now(origin.plusSeconds(60));var old=occurrences.scan("sealed-before-cap").getFirst();
        member(f,put("/api/v1/workspaces/"+f.ws()+"/schedule-policy"),Map.of("expectedVersion","0","policy",Map.of("queueTimeoutMs",1000,"maxQueueTimeoutMs",1000))).andExpect(status().isOk());
        now(origin.plusSeconds(120));occurrences.scan("new-after-cap");
        var deadlines=jdbc.queryForList("SELECT queue_deadline_utc FROM execution_schedule_occurrences WHERE schedule_id=? ORDER BY planned_at_utc",OffsetDateTime.class,Long.valueOf(id));
        assertThat(deadlines).containsExactly(origin.plusSeconds(360).atOffset(ZoneOffset.UTC),origin.plusSeconds(121).atOffset(ZoneOffset.UTC));
        member(f,get(f.url()+"/schedules/"+id),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("2")).andExpect(jsonPath("$.revision").value("1")).andExpect(jsonPath("$.policies.queueTimeoutMs").value(300000));
        assertThat(jdbc.queryForObject("SELECT queue_deadline_utc FROM execution_schedule_occurrences WHERE id=?",OffsetDateTime.class,Long.valueOf(old.id()))).isEqualTo(origin.plusSeconds(360).atOffset(ZoneOffset.UTC));
    }

    @ParameterizedTest @ValueSource(strings={"passed","failed"})
    void historyReadsTheActualJobSummaryWithoutOptionalNotifications(String verdict)throws Exception {
        var f=fixture();now(origin);var input=save(f);input.put("rule",Map.of("kind","once","atUtc",origin.plusSeconds(60).toString(),"timeZone","UTC"));input.put("notifications",Map.of("inApp",false,"eventKinds",List.of(),"channelIds",List.of()));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());
        now(origin.plusSeconds(60));clock.set(origin.plusSeconds(60));String job=submission.submit(occurrences.scan("real-summary").getFirst()).orElseThrow().jobId();
        beat(f,1,1);send(f,message(job,"accepted","accepted-"+job)).andExpect(status().isOk());send(f,start(job)).andExpect(status().isOk());
        var done=message(job,"completed","completed-"+job);done.putAll(Map.of("verdict",verdict,"finishedAt",origin.plusSeconds(61).toString(),"executionReleased",true,"evidenceComplete",true,"reportHash",HASH,"reportBytes",1));send(f,done).andExpect(status().isOk());
        var page=body(member(f,get(f.url()+"/schedules/"+id+"/history"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].execution.verdict").value(verdict)));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_events WHERE schedule_id=?",Long.class,Long.valueOf(id))).isZero();
        wire("final-history-"+verdict,page);
        jdbc.update("UPDATE execution_jobs SET summary_json=? WHERE id=?","{\"verdict\":\"PRIVATE https://secret/?token=x\"}",Long.valueOf(job));
        var unknown=body(member(f,get(f.url()+"/schedules/"+id+"/history"),Map.of()).andExpect(status().isOk()));
        assertThat(unknown.path("items").get(0).path("execution").path("verdict").isNull()).isTrue();assertThat(unknown.toString()).doesNotContain("PRIVATE","https://secret");
    }
}
