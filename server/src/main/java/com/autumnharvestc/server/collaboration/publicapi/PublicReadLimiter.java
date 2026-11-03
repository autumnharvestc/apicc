package com.autumnharvestc.server.collaboration.publicapi;

import com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage;
import com.autumnharvestc.server.collaboration.policy.PolicyReadView;
import com.autumnharvestc.server.core.ApiException;
import java.util.*;
import org.springframework.stereotype.Component;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.Code.*;

/** Single-Java rolling one-second budgets. Idle windows accumulate no additional allowance. */
@Component
public class PublicReadLimiter {
    private static final class Window {
        final ArrayDeque<Long> starts=new ArrayDeque<>();
        int inFlight;
        void prune(long now){while(!starts.isEmpty()&&starts.getFirst()<=now-1000)starts.removeFirst();}
    }
    private final Window global=new Window();
    private final Map<Long,Window> grants=new HashMap<>();
    public synchronized Lease acquire(long grant,PolicyReadView policy,long now){
        global.prune(now);
        grants.values().forEach(window->window.prune(now));
        grants.entrySet().removeIf(entry->entry.getValue().inFlight==0&&entry.getValue().starts.isEmpty());
        var local=grants.computeIfAbsent(grant,ignored->new Window());
        if(global.starts.size()>=CollaborationStorage.number(policy,DEPLOYMENT_PUBLIC_READ_RPS)
                ||local.starts.size()>=CollaborationStorage.number(policy,PUBLIC_READ_RPS)
                ||global.inFlight>=CollaborationStorage.number(policy,DEPLOYMENT_PUBLIC_READ_IN_FLIGHT)
                ||local.inFlight>=CollaborationStorage.number(policy,PUBLIC_READ_IN_FLIGHT)){
            throw new ApiException(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS,"share_capacity_exceeded","共享读取容量已满，请稍后重试");
        }
        global.starts.addLast(now);local.starts.addLast(now);global.inFlight++;local.inFlight++;
        return new Lease(local);
    }
    public final class Lease implements AutoCloseable {
        private final Window local;
        private boolean closed;
        private Lease(Window local){this.local=local;}
        @Override public void close(){synchronized(PublicReadLimiter.this){if(!closed){closed=true;global.inFlight--;local.inFlight--;}}}
    }
}
