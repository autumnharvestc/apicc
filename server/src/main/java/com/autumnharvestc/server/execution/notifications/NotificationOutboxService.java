package com.autumnharvestc.server.execution.notifications;
import java.util.*;
import java.time.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;
import org.springframework.transaction.support.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.autumnharvestc.server.execution.scheduling.*;

@Service
public class NotificationOutboxService {
    private final NotificationOutboxRepo repo;private final NotificationChannelRepo channels;private final NotificationChannelService channelService;private final ObjectMapper json;
    private final NotificationEventRepo gate;private final ScheduleTimeSource time;private final NotificationProperties properties;private final SchedulePolicyService policies;private final ChannelCipher cipher;private final NotificationTransport transport;private final TransactionTemplate transaction;
    private final String owner=UUID.randomUUID().toString();
    private java.util.concurrent.ThreadPoolExecutor dispatchWorkers;
    @jakarta.annotation.PostConstruct void initializeDispatch(){dispatchWorkers=new java.util.concurrent.ThreadPoolExecutor(properties.getConcurrency(),properties.getConcurrency(),0L,java.util.concurrent.TimeUnit.MILLISECONDS,new java.util.concurrent.SynchronousQueue<>(),r->{var t=new Thread(r,"notification-dispatch");t.setDaemon(true);return t;},new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());}
    @jakarta.annotation.PreDestroy void closeDispatch(){dispatchWorkers.shutdownNow();}
    public void dispatch(){for(int i=0;i<properties.getConcurrency();i++)try{dispatchWorkers.execute(()->{try{deliverOne();}catch(RuntimeException ignored){/* Durable lease recovery; never log secrets or raw errors. */}});}catch(java.util.concurrent.RejectedExecutionException busy){break;}}
    public NotificationOutboxService(NotificationOutboxRepo repo,NotificationChannelRepo channels,NotificationChannelService channelService,ObjectMapper json,NotificationEventRepo gate,ScheduleTimeSource time,NotificationProperties properties,SchedulePolicyService policies,ChannelCipher cipher,NotificationTransport transport,TransactionTemplate transaction){this.repo=repo;this.channels=channels;this.channelService=channelService;this.json=json;this.gate=gate;this.time=time;this.properties=properties;this.policies=policies;this.cipher=cipher;this.transport=transport;this.transaction=transaction;}
    private NotificationLimits limits(String value){try{return json.readValue(value,NotificationLimits.class);}catch(Exception ignored){throw ChannelCipher.unavailable();}}
    @Transactional(propagation=Propagation.MANDATORY)
    public void enqueue(long event,long ws,long project,String body,List<String> selected,Instant now){
        for(String id:selected){
            var row=channels.find(ws,Long.parseLong(id),false).orElseThrow(ChannelCipher::unavailable);var limits=channelService.limits(row);
            String encoded;try{encoded=json.writeValueAsString(limits);}catch(Exception ignored){throw new IllegalStateException("Cannot encode notification limits");}
            boolean full=repo.pending(null,null)>=properties.getMaxPendingDeliveries()||repo.pending(ws,null)>=((Number)((Map<?,?>)policies.effectiveWorkspace(ws).get("effective")).get("maxPendingDeliveries")).longValue()||repo.pending(ws,project)>=((Number)((Map<?,?>)policies.effective(ws,project).get("effective")).get("maxPendingDeliveries")).longValue();
            long delivery=repo.insert(event,ws,project,row.id(),row.version(),body,com.autumnharvestc.server.core.Hashes.sha256Hex(body.getBytes(java.nio.charset.StandardCharsets.UTF_8)),encoded,now.plusMillis(limits.deliveryTtlMs()),now);
            if(full)repo.terminal(delivery,"rejected","notification-capacity",null,now);else if(!row.enabled()||row.deleted())repo.terminal(delivery,"stopped","channel-changed",null,now);else if(body.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>limits.maxPayloadBytes())repo.terminal(delivery,"rejected","payload-too-large",null,now);
        }
    }
    public List<NotificationOutboxRepo.DeliveryView> views(long event){return repo.views(event);}
    public String state(long event){var rows=views(event);if(rows.isEmpty())return "in-app";if(rows.stream().anyMatch(r->Set.of("pending","sending").contains(r.state())))return "pending";return rows.stream().allMatch(r->r.state().equals("acknowledged"))?"acknowledged":"failed";}
    private NotificationOutboxRepo.Row claim(){
        return transaction.execute(status->{
            gate.gate();var now=time.now();
            for(long id:repo.due(now,properties.getConcurrency())){
                var candidate=repo.find(id,false).orElseThrow();var channel=channels.find(candidate.workspace(),candidate.channel(),true);var row=repo.find(id,true).orElseThrow();
                if(!Set.of("pending","sending").contains(row.state()))continue;
                if(!now.isBefore(row.deadline())){repo.terminal(id,"expired","delivery-expired",null,now);continue;}
                var limits=limits(row.limits());if(row.attempts()>=limits.maxAttempts()){repo.terminal(id,"failed","delivery-exhausted",null,now);continue;}
                if(channel.isEmpty()||!channel.orElseThrow().enabled()||channel.orElseThrow().deleted()||channel.orElseThrow().version()!=row.version()){repo.terminal(id,"stopped","channel-changed",null,now);continue;}
                if(row.body()==null||!com.autumnharvestc.server.core.Hashes.sha256Hex(row.body().getBytes(java.nio.charset.StandardCharsets.UTF_8)).equals(row.hash())){repo.terminal(id,"failed","payload-unavailable",null,now);continue;}
                if(repo.active(now)>=properties.getConcurrency())return null;
                return repo.take(row,owner,UUID.randomUUID().toString(),now.plusMillis(properties.getLeaseMs()),now);
            }
            return null;
        });
    }
    public boolean deliverOne(){
        if(TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Notification send cannot inherit a database transaction");
        var claim=claim();if(claim==null)return false;DeliveryResult result;DeliveryChannel channel=null;
        try{
            var current=channels.find(claim.workspace(),claim.channel(),false).filter(r->r.version()==claim.version()&&r.enabled()&&!r.deleted());
            if(current.isEmpty())result=new DeliveryResult("channel-changed",null,null,false);
            else{channel=cipher.open(current.orElseThrow());var l=limits(claim.limits());long remaining=Duration.between(time.now(),claim.deadline()).toMillis();if(remaining<=0)result=new DeliveryResult("delivery-expired",null,null,false);else result=transport.send(channel,claim.body().getBytes(java.nio.charset.StandardCharsets.UTF_8),String.valueOf(claim.event()),time.now(),new NotificationLimits(Math.min(Math.min(l.requestTimeoutMs(),properties.getRequestTimeoutMs()),remaining),l.maxAttempts(),l.retryMinMs(),l.retryMaxMs(),l.jitterRatio(),l.deliveryTtlMs(),l.maxPayloadBytes(),l.maxResponseBytes()));}
        }catch(com.autumnharvestc.server.core.ApiException ignored){result=new DeliveryResult("channel-unavailable",null,null,false);}finally{if(channel!=null)Arrays.fill(channel.hmacSecret(),(byte)0);}
        var safe=result;transaction.executeWithoutResult(status->complete(claim,safe));return true;
    }
    private void complete(NotificationOutboxRepo.Row claim,DeliveryResult result){
        gate.gate();var channel=channels.find(claim.workspace(),claim.channel(),true);var current=repo.find(claim.id(),true).orElseThrow();var now=time.now();
        if(!current.state().equals("sending")||!Objects.equals(current.owner(),claim.owner())||!Objects.equals(current.token(),claim.token())||!Objects.equals(current.leaseUntil(),claim.leaseUntil())||!now.isBefore(claim.leaseUntil())||current.version()!=claim.version()||!current.hash().equals(claim.hash()))return;
        if(channel.isEmpty()||channel.orElseThrow().version()!=claim.version()||!channel.orElseThrow().enabled()||channel.orElseThrow().deleted()){repo.terminal(claim.id(),"stopped","channel-changed",result.status(),now);return;}
        if(!now.isBefore(claim.deadline())||result.reasonCode().equals("delivery-expired")){repo.complete(claim,"expired","delivery-expired",result.status(),null,now);return;}
        if(result.acknowledged()){repo.complete(claim,"acknowledged","acknowledged",result.status(),null,now);return;}
        var limits=limits(claim.limits());boolean retry=Set.of("network-error","timeout","transport-busy","http-retryable").contains(result.reasonCode());
        if(!retry){repo.complete(claim,"failed",result.reasonCode(),result.status(),null,now);return;}
        if(claim.attempts()>=limits.maxAttempts()){repo.complete(claim,"failed","delivery-exhausted",result.status(),null,now);return;}
        long delay=Math.min(limits.retryMaxMs(),limits.retryMinMs()*(1L<<Math.min(20,claim.attempts()-1)));if(limits.jitterRatio()>0)delay=Math.max(1,Math.round(delay*(1+java.util.concurrent.ThreadLocalRandom.current().nextDouble(-limits.jitterRatio(),limits.jitterRatio()))));
        var next=now.plusMillis(delay);if(result.retryAfter()!=null&&result.retryAfter().isAfter(next))next=result.retryAfter();
        if(!next.isBefore(claim.deadline()))repo.complete(claim,"expired","delivery-expired",result.status(),null,now);else repo.complete(claim,"pending",result.reasonCode(),result.status(),next,now);
    }
}
