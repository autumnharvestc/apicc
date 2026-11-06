package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.execution.scheduling.ScheduleTimeSource;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@Import(SyncScheduleHttpFixture.ClockConfiguration.class)
abstract class SyncScheduleHttpFixture extends SyncCheckHttpFixture {
    static final String SCHEDULE_DATABASE_URL="jdbc:h2:mem:apicc-sync-schedule-t11;DB_CLOSE_DELAY=-1";
    static boolean reportedDatabase;
    @TestConfiguration static class ClockConfiguration {
        static final AtomicReference<Instant> current=new AtomicReference<>(Instant.parse("2026-11-05T00:00:00Z"));
        @Bean @Primary ScheduleTimeSource syncTestTime(){return current::get;}
        @Bean org.springframework.test.context.DynamicPropertyRegistrar scheduleDatabase(){return properties->properties.add("spring.datasource.url",()->SCHEDULE_DATABASE_URL);}
        @Bean org.springframework.scheduling.TaskScheduler taskScheduler(){return org.mockito.Mockito.mock(org.springframework.scheduling.TaskScheduler.class,call->{if(call.getMethod().getName().equals("getClock"))return java.time.Clock.systemUTC();if(call.getMethod().getName().startsWith("schedule"))return org.mockito.Mockito.mock(java.util.concurrent.ScheduledFuture.class);return org.mockito.Answers.RETURNS_DEFAULTS.answer(call);});}
    }
    @Autowired SyncScheduleDriver driver;
    @Autowired SyncScheduleService schedules;
    @Autowired SyncStorage syncStorage;
    @Autowired org.springframework.transaction.support.TransactionTemplate transactions;
    @org.junit.jupiter.api.AfterEach void cleanOwnedSchedules(){if(f==null||jdbc.queryForObject("SELECT COUNT(*) FROM projects WHERE id=?",Integer.class,Long.parseLong(f.project()))==0)return;transactions.executeWithoutResult(status->{long w=Long.parseLong(f.workspace()),p=Long.parseLong(f.project());syncStorage.lock(w,p);for(var source:jdbc.queryForList("SELECT id FROM sync_sources WHERE workspace_id=? AND project_id=? AND schedule_json IS NOT NULL",String.class,w,p)){var grant=schedules.grant(w,p,source);grant.put("enabled",false);schedules.write(w,p,source,grant);}});}
    @BeforeEach void fixedScheduleTime() throws Exception {try(var connection=jdbc.getDataSource().getConnection()){String actual=connection.getMetaData().getURL();assertThat(actual).isEqualTo(SCHEDULE_DATABASE_URL.split(";")[0]);if(!reportedDatabase){reportedDatabase=true;System.out.println("T11_DATABASE "+actual);}}at("2026-11-05T00:00:00Z");}
    void at(String instant){ClockConfiguration.current.set(Instant.parse(instant));}
    String scheduleRoute(JsonNode source){return "/sources/"+source.path("id").asText()+"/schedule";}
    ObjectNode scheduleBody(JsonNode source,String generation,boolean enabled){var value=json.createObjectNode().put("formatVersion",1).put("expectedSourceRevision",source.path("revision").asText()).put("expectedGeneration",generation).put("enabled",enabled);value.set("rule",source.path("schedule").path("rule"));return value;}
    JsonNode authorize(JsonNode source,String generation,Actor actor) throws Exception {return body(sourceRequest("PUT",scheduleRoute(source),actor,scheduleBody(source,generation,true)).andExpect(status().isOk()));}
    JsonNode enabledHourlySource() throws Exception {var source=createUrlSource("/fast");checkToCandidate(source);authorize(source,"0",f.owner());return readSourceAsAdmin(source.path("id").asText());}
    void tickAtSameUtcInstantTwice(JsonNode source){at("2026-11-05T01:00:00Z");driver.tick();driver.tick();}
    int checkCountForTrigger(JsonNode source){return jdbc.queryForObject("SELECT COUNT(*) FROM sync_checks WHERE workspace_id=? AND project_id=? AND source_id=? AND details_json LIKE '%\"scheduleGeneration\"%'",Integer.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()),source.path("id").asText());}
    int automaticApplicationCount(){return jdbc.queryForObject("SELECT COUNT(*) FROM sync_operations WHERE project_id=? AND kind IN ('apply','rollback')",Integer.class,Long.parseLong(f.project()));}
    JsonNode awaitOneCompletedCheck(JsonNode source) throws Exception {var id=jdbc.queryForObject("SELECT id FROM sync_checks WHERE project_id=? AND source_id=? AND details_json LIKE '%\"scheduleGeneration\"%' ORDER BY created_at DESC FETCH FIRST 1 ROW ONLY",String.class,Long.parseLong(f.project()),source.path("id").asText());var completed=awaitCheckAs(id,f.owner());assertThat(completed.path("state").asText()).withFailMessage(completed.toString()).isEqualTo("succeeded");return completed;}
}
