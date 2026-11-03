package com.autumnharvestc.server.collaboration.mock;

import com.autumnharvestc.server.collaboration.policy.PolicyReadView;
import com.autumnharvestc.server.core.ApiException;
import java.util.*;
import org.springframework.stereotype.Component;
import static com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage.number;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.Code.*;

@Component
public final class MockLimiter {
    private static final class Window {final ArrayDeque<Long> starts=new ArrayDeque<>();int active;void prune(long now){while(!starts.isEmpty()&&starts.getFirst()<=now-1000)starts.removeFirst();}}
    private final Window global=new Window();private final Map<Long,Window> projects=new HashMap<>();
    private final Map<Long,Integer> publications=new HashMap<>();
    public synchronized int active(long publication){return publications.getOrDefault(publication,0);}
    public synchronized AutoCloseable acquireGlobal(PolicyReadView policy){
        long now=System.nanoTime()/1_000_000;global.prune(now);
        if(global.active>=number(policy,DEPLOYMENT_MOCK_IN_FLIGHT)||global.starts.size()>=number(policy,DEPLOYMENT_MOCK_RPS))throw new ApiException(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS,"mock_capacity_exceeded","Mock 速率或在途容量已满，请稍后重试");
        global.active++;global.starts.addLast(now);
        return new AutoCloseable(){boolean closed;@Override public void close(){synchronized(MockLimiter.this){if(!closed){closed=true;global.active--;}}}};
    }
    public synchronized AutoCloseable acquire(long publication,long project,PolicyReadView policy){
        long now=System.nanoTime()/1_000_000;global.prune(now);projects.values().forEach(value->value.prune(now));projects.entrySet().removeIf(entry->entry.getValue().active==0&&entry.getValue().starts.isEmpty());
        var local=projects.computeIfAbsent(project,ignored->new Window());
        if(local.active>=number(policy,MOCK_IN_FLIGHT)||global.active>=number(policy,DEPLOYMENT_MOCK_IN_FLIGHT)||local.starts.size()>=number(policy,MOCK_RPS)||global.starts.size()>=number(policy,DEPLOYMENT_MOCK_RPS))throw new ApiException(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS,"mock_capacity_exceeded","Mock 速率或在途容量已满，请稍后重试");
        local.active++;global.active++;local.starts.addLast(now);global.starts.addLast(now);
        publications.merge(publication,1,Integer::sum);
        return new AutoCloseable(){boolean closed;@Override public void close(){synchronized(MockLimiter.this){if(!closed){closed=true;local.active--;global.active--;publications.computeIfPresent(publication,(key,value)->value==1?null:value-1);}}}};
    }
}
