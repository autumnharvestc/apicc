package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.collaboration.policy.*;
import java.time.Duration;
import java.util.concurrent.ScheduledFuture;
import org.springframework.context.SmartLifecycle;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Component;

/** One owned callback on the existing scheduler. Scope discovery is a bounded keyset rotation. */
@Component
public class CollaborationCleanup implements SmartLifecycle {
    private static final org.slf4j.Logger log=org.slf4j.LoggerFactory.getLogger(CollaborationCleanup.class);
    private final TaskScheduler scheduler;
    private final CollaborationStorage storage;
    private final CollaborationPolicyService policies;
    private ScheduledFuture<?> task;
    private boolean running;
    private long workspace=-1,project=-1;
    public CollaborationCleanup(TaskScheduler scheduler,CollaborationStorage storage,CollaborationPolicyService policies){this.scheduler=scheduler;this.storage=storage;this.policies=policies;}
    @Override public synchronized void start(){
        if(running)return;
        var policy=policies.publicationSnapshot(0,0);
        // The already-approved interval minimum drives discovery; effective per-scope intervals gate work.
        var interval=(PolicyReadView.IntegerSetting)policy.settings().stream().filter(value->value.code()==PolicyReadView.Code.CLEANUP_INTERVAL_MS).findFirst().orElseThrow();
        running=true;
        task=scheduler.scheduleWithFixedDelay(this::dispatch,Duration.ofMillis(interval.minimum()));
    }
    private synchronized void dispatch(){
        if(!running)return;
        var policy=policies.publicationSnapshot(0,0);
        int limit=Math.toIntExact(CollaborationStorage.number(policy,PolicyReadView.Code.CLEANUP_BATCH_SIZE));
        var scopes=storage.cleanupScopes(workspace,project,limit);
        for(var scope:scopes){
            workspace=scope.workspace();project=scope.project();
            try{storage.cleanupIfDue(workspace,project);}
            catch(RuntimeException failure){log.warn("Collaboration cleanup failed for scope {}/{} ({})",workspace,project,failure.getClass().getSimpleName());}
        }
        if(scopes.size()<limit){workspace=-1;project=-1;}
    }
    @Override public synchronized void stop(){running=false;if(task!=null){task.cancel(false);task=null;}}
    @Override public synchronized boolean isRunning(){return running;}
}
