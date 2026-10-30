package com.autumnharvestc.server.execution;

import java.time.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import com.autumnharvestc.server.execution.scheduling.*;

/** Actual disabled deployment: no mocked timer and no manual scan after handoff. */
@SpringBootTest @AutoConfigureMockMvc(print=org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-disabled-lifecycle;DB_CLOSE_DELAY=-1","apicc.scheduler.mode=disabled","apicc.scheduler.scan-interval-ms=100","apicc.scheduler.batch-size=1","apicc.notification.scan-interval-ms=100","apicc.server.allow-registration=true","apicc.server.admin-username=admin","apicc.server.admin-password=admin-pass-2026","apicc.execution.control-base-url=https://control.test/api/v1"})
@org.springframework.context.annotation.Import(JobsFixture.ClockConfiguration.class)
class ScheduleDisabledLifecycleTest {
    @Autowired org.springframework.context.ConfigurableApplicationContext context;
    @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Autowired ScheduleOccurrenceService occurrences;
    @Autowired ScheduledJobSubmission submission;
    @Autowired ScheduleControlService control;
    @org.springframework.test.context.bean.override.mockito.MockitoBean ScheduleTimeSource time;
    @org.springframework.test.context.DynamicPropertySource static void key(org.springframework.test.context.DynamicPropertyRegistry registry){registry.add("apicc.execution.materials.master-key-file",()->JobsFixture.KEY.toString());}
    @Test void disabledProductionSchedulingObservesFirstReleaseAndRetentionWithoutAdmittingNewTriggers()throws Exception {
        assertThat(context.getBeansOfType(EmbeddedScheduleTimer.class)).isEmpty();assertThat(control.read().mode()).isEqualTo("disabled");
        var helper=new ScheduleFixture(){};context.getAutowireCapableBeanFactory().autowireBean(helper);var f=helper.fixture();var origin=Instant.parse("2035-01-01T00:00:00Z");when(time.now()).thenReturn(origin);
        // Import an in-flight original through the same authority before the handoff.
        control.change(new ScheduleControlService.Update("embedded",control.read().version()));
        var input=helper.save(f);input.put("rule",Map.of("kind","once","atUtc",origin.plusSeconds(60).toString(),"timeZone","UTC"));input.put("notifications",Map.of("inApp",false,"eventKinds",List.of(),"channelIds",List.of()));
        String id=helper.body(helper.member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();helper.member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());
        when(time.now()).thenReturn(origin.plusSeconds(60));helper.clock.set(origin.plusSeconds(60));var claim=occurrences.scan("before-disabled-handoff").getFirst();String job=submission.submit(claim).orElseThrow().jobId();
        control.change(new ScheduleControlService.Update("disabled",control.read().version()));
        input.put("rule",Map.of("kind","once","atUtc",origin.plusSeconds(3600).toString(),"timeZone","UTC"));String future=helper.body(helper.member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();helper.member(f,put(f.url()+"/schedules/"+future),Map.of("expectedVersion","1","enabled",true)).andExpect(status().isOk());
        when(time.now()).thenReturn(origin.plusSeconds(120));helper.member(f,post("/api/v1/jobs/"+job+"/cancel"),Map.of()).andExpect(status().isOk());
        await(()->jdbc.queryForObject("SELECT terminal_at_utc FROM execution_schedule_occurrences WHERE id=?",OffsetDateTime.class,Long.valueOf(claim.id()))!=null);
        var first=jdbc.queryForObject("SELECT terminal_at_utc FROM execution_schedule_occurrences WHERE id=?",OffsetDateTime.class,Long.valueOf(claim.id()));assertThat(first).isEqualTo(origin.plusSeconds(120).atOffset(ZoneOffset.UTC));
        when(time.now()).thenReturn(origin.plusSeconds(121));Thread.sleep(250);assertThat(jdbc.queryForObject("SELECT terminal_at_utc FROM execution_schedule_occurrences WHERE id=?",OffsetDateTime.class,Long.valueOf(claim.id()))).isEqualTo(first);
        when(time.now()).thenReturn(origin.plus(Duration.ofDays(31)));
        await(()->jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE id=?",Long.class,Long.valueOf(claim.id()))==0);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id=?",Long.class,Long.valueOf(future))).isZero();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isEqualTo(1);
    }
    private static void await(java.util.function.BooleanSupplier check)throws Exception{long until=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(3);while(!check.getAsBoolean()&&System.nanoTime()<until)Thread.sleep(10);assertThat(check.getAsBoolean()).as("actual production scheduled wakeup within bounded observation").isTrue();}
}
