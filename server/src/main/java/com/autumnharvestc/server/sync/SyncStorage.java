package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage;
import com.autumnharvestc.server.collaboration.policy.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.*;
import java.util.*;
/** Fixed policy/access/quota gates precede every synchronization content lock. No lock acquisition in the deferred observer. */
@Service
public class SyncStorage {
    private final CollaborationStorage storage;private final CollaborationPolicyService policies;private final CollaborationPolicyRepo gates;
    private final Object key=new Object();
    public SyncStorage(CollaborationStorage storage,CollaborationPolicyService policies,CollaborationPolicyRepo gates){this.storage=storage;this.policies=policies;this.gates=gates;}
    private record Scope(long workspace,long project) {}
    private static final class Context {final Map<Scope,PolicyReadView> policies=new LinkedHashMap<>();final Set<Scope> changed=new LinkedHashSet<>();}
    public void globalGate(){gates.lockGate();}
    public void lock(long ws,long project){var policy=policies.publicationSnapshot(ws,project);storage.lockScope(ws,project);context().policies.put(new Scope(ws,project),policy);}
    public void attachLocked(long ws,long project,PolicyReadView policy){context().policies.put(new Scope(ws,project),policy);}
    public void changed(long ws,long project){var context=context();var scope=new Scope(ws,project);if(!context.policies.containsKey(scope))throw new IllegalStateException("Synchronization storage requires policy/access/quota gates before content locks");context.changed.add(scope);}
    private Context context(){
        if(!TransactionSynchronizationManager.isSynchronizationActive())throw new IllegalStateException("Synchronization storage requires its owning transaction");
        var found=(Context)TransactionSynchronizationManager.getResource(key);if(found!=null)return found;var context=new Context();TransactionSynchronizationManager.bindResource(key,context);
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization(){public void beforeCommit(boolean readOnly){for(var scope:context.changed)storage.synchronizationChanged(scope.workspace(),scope.project(),context.policies.get(scope));}public void afterCompletion(int status){TransactionSynchronizationManager.unbindResourceIfPossible(key);}});return context;
    }
}
