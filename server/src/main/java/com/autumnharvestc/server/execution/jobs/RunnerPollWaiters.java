package com.autumnharvestc.server.execution.jobs;

import org.springframework.stereotype.Component;
import org.springframework.web.context.request.async.DeferredResult;
import java.util.*;
import java.util.concurrent.*;

@Component
public class RunnerPollWaiters {
    private final RunnerControlService control;
    private record Waiting(JobDtos.Exchange request,DeferredResult<JobDtos.Batch> result) {}
    private final ConcurrentMap<Long,Set<Waiting>> pending=new ConcurrentHashMap<>();
    public RunnerPollWaiters(RunnerControlService control){this.control=control;}
    public DeferredResult<JobDtos.Batch> poll(long agent,JobDtos.Exchange request){
        var batch=control.exchange(agent,request);var result=new DeferredResult<JobDtos.Batch>(control.pollWaitMs(agent),JobDtos.Batch.empty());
        if(!batch.isEmpty()){result.setResult(batch);return result;}
        var waiting=new Waiting(request,result);pending.computeIfAbsent(agent,k->ConcurrentHashMap.newKeySet()).add(waiting);
        result.onCompletion(()->remove(agent,waiting));result.onTimeout(()->{remove(agent,waiting);result.setResult(JobDtos.Batch.empty());});
        // Register then re-read closes the enqueue/register race. Assignment stays in the DB.
        complete(agent,waiting);return result;
    }
    public void wake(long agent){for(var waiting:List.copyOf(pending.getOrDefault(agent,Set.of())))complete(agent,waiting);}
    private void complete(long agent,Waiting waiting){
        if(waiting.result().isSetOrExpired()){remove(agent,waiting);return;}
        try{var batch=control.exchange(agent,waiting.request());if(!batch.isEmpty()){waiting.result().setResult(batch);remove(agent,waiting);}}
        catch(RuntimeException e){waiting.result().setErrorResult(e);remove(agent,waiting);}
    }
    private void remove(long agent,Waiting waiting){pending.computeIfPresent(agent,(id,entries)->{entries.remove(waiting);return entries.isEmpty()?null:entries;});}
}
