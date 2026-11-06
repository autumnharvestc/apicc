package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.collaboration.runtime.*;
import com.autumnharvestc.server.core.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import java.util.concurrent.ConcurrentHashMap;

/** Node owns slots until actual collection. Java owns invocation cancellation and durable status. */
@Component
public class SyncCheckWorker {
    private record Key(String workspace,String project,String check) {}
    private static final class Work {volatile Thread thread;volatile boolean cancelled;boolean finishing;}
    private final ObjectProvider<SyncCheckService> service;
    private final CollaborationRuntimeClient runtime;
    private final RuntimeProtocol protocol;
    private final int slots;
    private final Object wakeup=new Object();
    private volatile boolean closed;
    private final java.util.List<Thread> dispatchers=new java.util.ArrayList<>();
    private final ConcurrentHashMap<Key,Work> work=new ConcurrentHashMap<>();
    public SyncCheckWorker(ObjectProvider<SyncCheckService> service,CollaborationRuntimeClient runtime,RuntimeProtocol protocol,SyncPolicyService.Deployment deployment){this.service=service;this.runtime=runtime;this.protocol=protocol;slots=Math.toIntExact(deployment.getCeilings().getOrDefault("hostConcurrency",SyncDtos.DEFAULTS.get("hostConcurrency")));if(slots<1||slots>16)throw new IllegalArgumentException("SYNC_POLICY_INVALID");}
    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
    public void start(){service.getObject().recover();for(int index=0;index<slots;index++){var thread=Thread.ofVirtual().name("apicc-sync-worker-"+index).unstarted(this::dispatch);dispatchers.add(thread);thread.start();}}
    public void wake(){synchronized(wakeup){wakeup.notifyAll();}}
    private void dispatch(){while(!closed){try{var next=service.getObject().claim();if(next.isPresent()){var item=next.get();execute(item.workspace(),item.project(),item.check());}else synchronized(wakeup){wakeup.wait(100);}}catch(InterruptedException stopped){if(closed)return;}catch(RuntimeException failure){if(closed)return;try{synchronized(wakeup){wakeup.wait(100);}}catch(InterruptedException stopped){if(closed)return;}}}}
    private void execute(String ws,String project,String id){
        var key=new Key(ws,project,id);var owned=new Work();
        owned.thread=Thread.currentThread();work.put(key,owned);run(key,owned);
    }
    private void run(Key key,Work owned){
        String reason=null,detail=null;boolean uncertain=false;boolean planning=false;
        try{
            var checks=service.getObject();var snapshot=checks.prepare(key.workspace(),key.project(),key.check());
            int output=Math.toIntExact(snapshot.effective().path("deploymentLimits").path("maxWireBytes").asLong()-snapshot.effective().path("deploymentLimits").path("envelopeReserveBytes").asLong());
            var payload=checks.resolveMaterials(snapshot);JsonNode read;
            if(owned.cancelled)throw new InterruptedException();checks.validate(snapshot);
            try{read=runtime.call("sync-read",payload,snapshot.deadlineAtMs(),output);}
            catch(CollaborationRuntimeClient.Failure failure){
                    // Only this finite pre-execution refusal is repeatable. Transport/timeout never are.
                    if(!failure.code().equals("SYNC_BUSY"))throw failure;
                    checks.waiting(snapshot);return; // Persist backoff and release this Java slot for another project.
            }
            checks.validate(snapshot);planning=true;var plan=(ObjectNode)snapshot.planPayload().deepCopy();plan.set("read",read);
            checks.complete(snapshot,runtime.call("sync-plan",plan,snapshot.deadlineAtMs(),output));return;
        }catch(InterruptedException failure){reason="cancelled";}
        catch(SyncCheckService.Invalidated failure){reason=failure.reason;}
        catch(CollaborationRuntimeClient.Failure failure){
            detail=protocol.syncDetailCode(failure.code());
            if(owned.cancelled)reason="cancelled";
            else if(failure.code().equals("RPC_UNAVAILABLE")){reason="runtime-unavailable";uncertain=true;}
            else if(java.util.Set.of("RPC_DEADLINE_EXCEEDED","RPC_CANCELLED","RPC_RESPONSE_INVALID","RPC_MESSAGE_TOO_LARGE","SYNC_PROCESS_UNCOLLECTED").contains(failure.code())){reason="runtime-uncertain";uncertain=true;}
            else reason=planning?"comparison-failed":"source-read-failed";
        }catch(ApiException failure){reason=failure.getCode().equals("collaboration_storage_limit")?"storage-limit":failure.getStatus().value()==403?"authorization-changed":"material-changed";}
        catch(Exception failure){reason="comparison-failed";}
        finally{
            synchronized(owned){owned.finishing=true;}
            Thread.interrupted(); // HttpClient preserves interruption; the short DB status transaction is independent.
            try{if(reason!=null)service.getObject().finish(key.workspace(),key.project(),key.check(),reason,uncertain,detail);}
            finally{work.remove(key,owned);}
        }
    }
    private void cancelOwned(Work owned){synchronized(owned){owned.cancelled=true;if(!owned.finishing)owned.thread.interrupt();}}
    public boolean cancel(String ws,String project,String id){var owned=work.get(new Key(ws,project,id));if(owned==null)return false;cancelOwned(owned);return true;}
    void cancelScope(long ws,Long project){for(var entry:work.entrySet())if(entry.getKey().workspace().equals(String.valueOf(ws))&&(project==null||entry.getKey().project().equals(String.valueOf(project))))cancelOwned(entry.getValue());}
    @jakarta.annotation.PreDestroy public void close(){closed=true;for(var owned:work.values())cancelOwned(owned);for(var thread:dispatchers)thread.interrupt();wake();}
}
