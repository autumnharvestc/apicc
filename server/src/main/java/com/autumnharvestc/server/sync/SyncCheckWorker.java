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
    private static final class Work {final SyncRepo.Dispatch claim;volatile Thread thread;volatile boolean cancelled,ownershipLost;volatile long localUntil;boolean finishing;Work(SyncRepo.Dispatch claim,long until){this.claim=claim;localUntil=until;}}
    private final ObjectProvider<SyncCheckService> service;
    private final CollaborationRuntimeClient runtime;
    private final RuntimeProtocol protocol;
    private final int slots;
    private final SyncCheckProperties properties;
    private final String ownerId=java.util.UUID.randomUUID().toString();
    private final java.util.concurrent.atomic.AtomicBoolean started=new java.util.concurrent.atomic.AtomicBoolean(),pulseActive=new java.util.concurrent.atomic.AtomicBoolean();
    private volatile java.util.concurrent.ScheduledExecutorService monitor;
    private volatile Thread pulseThread;
    private final Object wakeup=new Object();
    private volatile boolean closed;
    private final java.util.List<Thread> dispatchers=new java.util.ArrayList<>();
    private final ConcurrentHashMap<Key,Work> work=new ConcurrentHashMap<>();
    public SyncCheckWorker(ObjectProvider<SyncCheckService> service,CollaborationRuntimeClient runtime,RuntimeProtocol protocol,SyncPolicyService.Deployment deployment,SyncCheckProperties properties){this.service=service;this.runtime=runtime;this.protocol=protocol;this.properties=properties;slots=Math.toIntExact(deployment.getCeilings().getOrDefault("hostConcurrency",SyncDtos.DEFAULTS.get("hostConcurrency")));if(slots<1||slots>16)throw new IllegalArgumentException("SYNC_POLICY_INVALID");}
    String ownerId(){return ownerId;}
    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
    public void start(){
        if(closed||!started.compareAndSet(false,true))return;
        service.getObject().recover();
        monitor=java.util.concurrent.Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("apicc-sync-ownership-clock").factory());
        monitor.scheduleWithFixedDelay(this::tick,properties.getMonitorIntervalMs(),properties.getMonitorIntervalMs(),java.util.concurrent.TimeUnit.MILLISECONDS);
        for(int index=0;index<slots;index++){var thread=Thread.ofVirtual().name("apicc-sync-worker-"+index).unstarted(this::dispatch);dispatchers.add(thread);thread.start();}
    }
    public void wake(){synchronized(wakeup){wakeup.notifyAll();}}
    private void dispatch(){while(!closed){try{long requested=System.nanoTime();var next=service.getObject().claim();if(next.isPresent())execute(next.get(),requested);else synchronized(wakeup){wakeup.wait(100);}}catch(InterruptedException stopped){if(closed)return;}catch(RuntimeException failure){if(closed)return;try{synchronized(wakeup){wakeup.wait(100);}}catch(InterruptedException stopped){if(closed)return;}}}}
    private void execute(SyncRepo.Dispatch claim,long requested){
        var key=new Key(claim.workspace(),claim.project(),claim.check());var owned=new Work(claim,requested+java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(properties.getLeaseMs()));
        owned.thread=Thread.currentThread();work.put(key,owned);run(key,owned);
    }
    /** This timer never performs DB work: even a blocked renewal must not stop local expiry. */
    private void tick(){
        if(closed)return;long now=System.nanoTime();for(var owned:work.values())if(now-owned.localUntil>=0)cancelOwned(owned,true);
        if(!pulseActive.compareAndSet(false,true))return;
        var thread=Thread.ofVirtual().name("apicc-sync-ownership-pulse").unstarted(this::pulse);pulseThread=thread;
        if(closed){pulseActive.set(false);return;}thread.start();
    }
    private void pulse(){
        try{
            if(closed)return;
            for(var owned:work.values()){
                synchronized(owned){if(owned.finishing||owned.cancelled||owned.ownershipLost)continue;}
                long requested=System.nanoTime();
                try{
                    var observed=service.getObject().refreshOwnership(owned.claim);
                    if(observed!=SyncCheckService.Observation.RUNNING){cancelOwned(owned,observed==SyncCheckService.Observation.LOST);continue;}
                    // Publish each ACK before unrelated recovery; a late ACK can never revive a stopped/expired Work.
                    synchronized(owned){
                        if(owned.finishing||owned.cancelled||owned.ownershipLost)continue;
                        long now=System.nanoTime(),until=requested+java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(properties.getLeaseMs());
                        if(now-owned.localUntil>=0||now-until>=0)cancelOwned(owned,true);else owned.localUntil=until;
                    }
                }catch(RuntimeException unavailable){/* No ACK: the independent monotonic deadline remains in force. */}
            }
            if(!closed)try{service.getObject().recover();}catch(RuntimeException unavailable){/* Bounded next pulse retries observation, never the external read. */}
        }finally{pulseActive.set(false);}
    }
    private void requireLocal(Work owned) throws InterruptedException {
        if(System.nanoTime()-owned.localUntil>=0)cancelOwned(owned,true);
        if(owned.ownershipLost)throw new SyncCheckService.Invalidated("runtime-uncertain");if(owned.cancelled)throw new InterruptedException();
    }
    private void run(Key key,Work owned){
        String reason=null,detail=null;boolean uncertain=false;boolean planning=false;
        try{
            requireLocal(owned);var checks=service.getObject();var snapshot=checks.prepare(owned.claim);
            int output=Math.toIntExact(snapshot.effective().path("deploymentLimits").path("maxWireBytes").asLong()-snapshot.effective().path("deploymentLimits").path("envelopeReserveBytes").asLong());
            var payload=checks.resolveMaterials(snapshot);JsonNode read;
            requireLocal(owned);checks.validate(snapshot,owned.claim);requireLocal(owned);
            try{read=runtime.call("sync-read",payload,snapshot.deadlineAtMs(),output);}
            catch(CollaborationRuntimeClient.Failure failure){
                    // Only this finite pre-execution refusal is repeatable. Transport/timeout never are.
                    if(!failure.code().equals("SYNC_BUSY"))throw failure;
                    checks.waiting(snapshot,owned.claim);return; // Persist backoff and release this Java slot for another project.
            }
            requireLocal(owned);checks.validate(snapshot,owned.claim);planning=true;var plan=(ObjectNode)snapshot.planPayload().deepCopy();plan.set("read",read);
            var planned=runtime.call("sync-plan",plan,snapshot.deadlineAtMs(),output);requireLocal(owned);checks.complete(snapshot,planned,owned.claim);return;
        }catch(InterruptedException failure){reason=owned.ownershipLost?"runtime-uncertain":"cancelled";uncertain=owned.ownershipLost;}
        catch(SyncCheckService.Invalidated failure){reason=failure.reason;uncertain=reason.equals("runtime-uncertain");}
        catch(CollaborationRuntimeClient.Failure failure){
            detail=protocol.syncDetailCode(failure.code());
            if(owned.ownershipLost){reason="runtime-uncertain";uncertain=true;}
            else if(owned.cancelled)reason="cancelled";
            else if(failure.code().equals("RPC_UNAVAILABLE")){reason="runtime-unavailable";uncertain=true;}
            else if(java.util.Set.of("RPC_DEADLINE_EXCEEDED","RPC_CANCELLED","RPC_RESPONSE_INVALID","RPC_MESSAGE_TOO_LARGE","SYNC_PROCESS_UNCOLLECTED").contains(failure.code())){reason="runtime-uncertain";uncertain=true;}
            else reason=planning?"comparison-failed":"source-read-failed";
        }catch(ApiException failure){reason=failure.getCode().equals("collaboration_storage_limit")?"storage-limit":failure.getStatus().value()==403?"authorization-changed":"material-changed";}
        catch(Exception failure){reason="comparison-failed";}
        finally{
            synchronized(owned){owned.finishing=true;}
            Thread.interrupted(); // HttpClient preserves interruption; the short DB status transaction is independent.
            try{if(reason!=null)service.getObject().finish(owned.claim,reason,uncertain,detail);}
            finally{work.remove(key,owned);}
        }
    }
    private void cancelOwned(Work owned,boolean lost){synchronized(owned){if(owned.finishing)return;if(lost)owned.ownershipLost=true;else owned.cancelled=true;owned.thread.interrupt();}}
    public boolean cancel(String ws,String project,String id){var owned=work.get(new Key(ws,project,id));if(owned==null)return false;cancelOwned(owned,false);return true;}
    void cancelScope(long ws,Long project){for(var entry:work.entrySet())if(entry.getKey().workspace().equals(String.valueOf(ws))&&(project==null||entry.getKey().project().equals(String.valueOf(project))))cancelOwned(entry.getValue(),false);}
    @jakarta.annotation.PreDestroy public void close(){closed=true;var clock=monitor;if(clock!=null)clock.shutdownNow();var pulse=pulseThread;if(pulse!=null)pulse.interrupt();for(var owned:work.values())cancelOwned(owned,false);for(var thread:dispatchers)thread.interrupt();wake();}
}
