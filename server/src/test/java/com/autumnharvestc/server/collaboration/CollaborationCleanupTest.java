package com.autumnharvestc.server.collaboration;

import java.time.*;
import java.util.*;
import java.util.concurrent.ScheduledFuture;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.*;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.*;

/** Production assembly/dispatch, with only the actual scheduler's time trigger captured. */
@Import(CollaborationCleanupTest.Scheduling.class)
@TestPropertySource(properties="spring.datasource.url=jdbc:h2:mem:apicc-final-collaboration-cleanup;DB_CLOSE_DELAY=-1")
class CollaborationCleanupTest extends ArtifactHttpFixture {
    record Task(Runnable action, ScheduledFuture<?> future) {}
    static class Captured {
        final List<Task> tasks=new ArrayList<>();
        void tick(){for(var task:List.copyOf(tasks))task.action().run();}
    }
    @org.springframework.boot.test.context.TestConfiguration
    static class Scheduling {
        @Bean Captured captured(){return new Captured();}
        @Bean TaskScheduler taskScheduler(Captured captured){return org.mockito.Mockito.mock(TaskScheduler.class,call->{
            if(call.getMethod().getName().equals("getClock"))return Clock.systemUTC();
            if(call.getMethod().getName().startsWith("schedule")){
                var future=org.mockito.Mockito.mock(ScheduledFuture.class);captured.tasks.add(new Task(call.getArgument(0),future));return future;
            }
            return org.mockito.Answers.RETURNS_DEFAULTS.answer(call);
        });}
    }
    @Autowired Captured captured;
    @Autowired org.springframework.context.ApplicationContext context;
    @Autowired com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties deployment;
    void dispatchCycle(){int scopes=jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_accounts",Integer.class);for(int index=0;index<=scopes;index++)captured.tick();}
    @Test void productionDispatchUsesEffectiveIntervalAndBatchThenStops()throws Exception{
        deployment.setDefaults(json.convertValue(Map.of("cleanupIntervalMs",60000,"cleanupBatchSize",1),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));
        var f=fixture();var expired=List.of(preview(f,f.owner(),documentRequest(f)),preview(f,f.owner(),documentRequest(f)));
        long ws=Long.parseLong(f.workspace()),project=Long.parseLong(f.project());artifactTime.advance(600000);
        var active=preview(f,f.owner(),documentRequest(f));dispatchCycle();
        var softly=new org.assertj.core.api.SoftAssertions();
        softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_previews WHERE workspace_id=? AND project_id=? AND state='expired'",Long.class,ws,project)).as("actual registered production dispatch, batch one").isEqualTo(1);
        dispatchCycle();softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_previews WHERE workspace_id=? AND project_id=? AND state='expired'",Long.class,ws,project)).as("same effective interval cannot run twice").isEqualTo(1);
        artifactTime.advance(60000);dispatchCycle();softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_previews WHERE workspace_id=? AND project_id=? AND state='expired'",Long.class,ws,project)).isEqualTo(2);
        softly.assertThat(jdbc.queryForObject("SELECT state FROM collaboration_previews WHERE id=?",String.class,active.path("id").asLong())).isEqualTo("pending");
        var lifecycles=context.getBeansOfType(org.springframework.context.SmartLifecycle.class).values().stream().filter(value->value.getClass().getPackageName().startsWith("com.autumnharvestc.server.collaboration")).toList();
        lifecycles.forEach(org.springframework.context.Lifecycle::stop);
        artifactTime.advance(600000);captured.tick();softly.assertThat(jdbc.queryForObject("SELECT state FROM collaboration_previews WHERE id=?",String.class,active.path("id").asLong())).as("stopped lifecycle cannot dispatch captured callbacks").isEqualTo("pending");
        softly.assertThat(captured.tasks.stream().filter(task->org.mockito.Mockito.mockingDetails(task.future()).getInvocations().stream().anyMatch(call->call.getMethod().getName().equals("cancel"))).count()).as("owned schedule cancelled").isEqualTo(1);
        lifecycles.forEach(org.springframework.context.Lifecycle::start);deployment.setDefaults(null);softly.assertAll();
    }
}
