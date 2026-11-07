package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.execution.scheduling.DatabaseScheduleTimeSource;
import com.autumnharvestc.server.execution.scheduling.ScheduleTimeSource;
import java.time.*;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.test.context.TestContextManager;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@Import(SyncCheckDatabaseClockTest.ControlledTimers.class)
@TestPropertySource(properties="apicc.scheduler.mode=disabled")
class SyncCheckDatabaseClockTest extends SyncCheckHttpFixture {
    @MockitoBean ScheduleTimeSource businessTime;
    @Autowired SyncCheckProperties ownership;
    @TestConfiguration static class ControlledTimers {
        // This disabled deployment owns its worker queue; override the inherited runtime URL before DataSource binding.
        @Bean static BeanFactoryPostProcessor clockDatabase(ConfigurableEnvironment environment){
            return beans->environment.getPropertySources().addFirst(new MapPropertySource("clock-test-database",java.util.Map.of("spring.datasource.url","jdbc:h2:mem:apicc-sync-database-clock;DB_CLOSE_DELAY=-1")));
        }
        @Bean org.springframework.scheduling.TaskScheduler taskScheduler(){return mock(org.springframework.scheduling.TaskScheduler.class,call->{
            if(call.getMethod().getName().equals("getClock"))return Clock.systemUTC();
            if(call.getMethod().getName().startsWith("schedule"))return mock(java.util.concurrent.ScheduledFuture.class);
            return org.mockito.Answers.RETURNS_DEFAULTS.answer(call);
        });}
    }
    @Test void clockContextKeepsItsSchedulerControlAndSourcesSeparateFromTheNormalContext() throws Exception {
        var source=createUrlSource("/fast");
        var normal=new TestContextManager(SyncChecksTest.class).getTestContext().getApplicationContext();
        var normalJdbc=normal.getBean(org.springframework.jdbc.core.JdbcTemplate.class);
        try(var clockConnection=jdbc.getDataSource().getConnection();var normalConnection=normalJdbc.getDataSource().getConnection()){
            String clockUrl=clockConnection.getMetaData().getURL(),normalUrl=normalConnection.getMetaData().getURL();
            assertThat(clockUrl).as("Independent clock and normal workers must have separate metadata authorities").isNotEqualTo(normalUrl);
            System.out.println("DB_CLOCK_CONTEXT_ISOLATION clock="+clockUrl+" normal="+normalUrl);
        }
        assertThat(jdbc.queryForObject("SELECT mode FROM execution_scheduler_control WHERE id=1",String.class)).isEqualTo("disabled");
        assertThat(normalJdbc.queryForObject("SELECT mode FROM execution_scheduler_control WHERE id=1",String.class)).isEqualTo("embedded");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sync_sources WHERE workspace_id=? AND project_id=? AND id=?",Integer.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()),source.path("id").asText())).isEqualTo(1);
        assertThat(normalJdbc.queryForObject("SELECT COUNT(*) FROM sync_sources WHERE workspace_id=? AND project_id=? AND id=?",Integer.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()),source.path("id").asText()))
            .as("The normal worker must not see the clock context's source or check scope").isZero();
    }
    @Test void interfaceMockBusinessClockJumpsCannotMoveTheActualSyncReadLease() throws Exception {
        when(businessTime.now()).thenReturn(Instant.parse("2035-01-01T00:00:00Z"));
        String barrier=UUID.randomUUID().toString();var source=createUrlSource("/blocked/"+barrier);var accepted=submit(source,checkBody());String id=accepted.path("checkId").asText();
        try{
            awaitNode("received-"+barrier);int calls=sourceHostCalls();var initial=assertRealLease(id);
            when(businessTime.now()).thenReturn(Instant.parse("2099-01-01T00:00:00Z"));var advanced=awaitRenewal(id,initial);
            when(businessTime.now()).thenReturn(Instant.parse("1970-01-01T00:00:00Z"));awaitRenewal(id,advanced);
            assertThat(sourceHostCalls()).as("The same actual source read remains owned across business-clock jumps").isEqualTo(calls);
            assertThat(java.nio.file.Files.exists(node.directory.resolve("collected-"+barrier))).isFalse();
            sourceRequest("POST","/checks/"+id+"/cancel",editor(),json.createObjectNode()).andExpect(status().isAccepted());awaitNode("collected-"+barrier);
            assertThat(awaitCheck(id).path("state").asText()).isEqualTo("cancelled");
        }finally{release(barrier);}
    }
    Instant lease(String id){return jdbc.queryForObject("SELECT lease_until_utc FROM sync_checks WHERE workspace_id=? AND project_id=? AND id=?",OffsetDateTime.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()),id).toInstant();}
    Instant assertRealLease(String id){
        var until=lease(id);var databaseNow=new DatabaseScheduleTimeSource(jdbc).now();long remaining=Duration.between(databaseNow,until).toMillis();
        assertThat(remaining).as("The persisted runtime lease follows real DB UTC, never the mock business date").isBetween(1L,ownership.getLeaseMs());
        System.out.println("DB_CLOCK_BOUNDARY check="+id+" business="+businessTime.now()+" database="+databaseNow+" leaseUntil="+until+" leaseRemainingMs="+remaining);return until;
    }
    Instant awaitRenewal(String id,Instant previous) throws Exception {
        long until=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(6);
        while(System.nanoTime()<until){var current=lease(id);if(current.isAfter(previous))return assertRealLease(id);Thread.sleep(10);}
        throw new AssertionError("The real ownership pulse did not renew the still-held source after a business-clock jump");
    }
}
