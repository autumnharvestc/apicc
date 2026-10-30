package com.autumnharvestc.server.execution.notifications;

import java.util.*;
import java.net.URI;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;

@Service
@Transactional
public class NotificationChannelService {
    private final NotificationChannelRepo repo;private final NotificationEventRepo events;private final ChannelCipher cipher;private final WorkspaceGuard guard;
    @org.springframework.beans.factory.annotation.Autowired private com.autumnharvestc.server.execution.scheduling.NotificationProperties properties;
    @org.springframework.beans.factory.annotation.Autowired private com.fasterxml.jackson.databind.ObjectMapper json;
    @org.springframework.beans.factory.annotation.Autowired private NotificationOutboxRepo outbox;
    @org.springframework.beans.factory.annotation.Autowired private com.autumnharvestc.server.execution.scheduling.ScheduleTimeSource time;
    @org.springframework.beans.factory.annotation.Autowired private com.autumnharvestc.server.execution.agent.AgentRepo audit;
    public NotificationChannelService(NotificationChannelRepo repo,NotificationEventRepo events,ChannelCipher cipher,WorkspaceGuard guard){this.repo=repo;this.events=events;this.cipher=cipher;this.guard=guard;}
    public record Write(String expectedVersion,String name,String url,String hmacSecret,Boolean enabled,NotificationLimits limits){}
    public record Metadata(String id,String workspaceId,String name,String kind,String version,boolean enabled,String origin,String status,NotificationLimits limits,String appliesTo,String keyState,List<String> reasonCodes){}
    public Metadata create(UserAccount caller,String ws,Write input){
        guard.requireAdmin(id(ws),caller);events.gate();guard.requireAdmin(id(ws),caller);if(version(input.expectedVersion())!=0)throw error(org.springframework.http.HttpStatus.CONFLICT,"version_conflict","新渠道expectedVersion必须为0");validate(input);var limits=input.limits()==null?NotificationLimits.deployment(properties):input.limits();limits.validate(properties);var uri=URI.create(input.url());long channel=repo.reserve(id(ws),input.name(),Boolean.TRUE.equals(input.enabled()),origin(uri));repo.ciphertext(channel,cipher.seal(id(ws),channel,1,input.url(),input.hmacSecret()));repo.limits(channel,encode(limits));audit.audit(caller.id(),"notification-channel.create","notify-channel",channel,1L);return metadata(repo.find(id(ws),channel,false).orElseThrow());
    }
    public Map<String,Object> list(UserAccount caller,String ws){guard.requireAdmin(id(ws),caller);return Map.of("items",repo.list(id(ws)).stream().map(this::metadata).toList());}
    private Metadata metadata(NotificationChannelRepo.Row row){
        String status="disabled",keyState="not-checked";var reasons=new ArrayList<String>();
        if(row.enabled())try{var delivery=cipher.open(row);Arrays.fill(delivery.hmacSecret(),(byte)0);status="available";keyState="available";}
        catch(com.autumnharvestc.server.core.ApiException e){status="unavailable";keyState="unavailable";reasons.add("channel-key-unavailable");}
        String safeOrigin;try{safeOrigin=origin(URI.create(row.origin()));}catch(IllegalArgumentException unsupported){safeOrigin=null;reasons.add("unsupported-origin");if(row.enabled())status="unavailable";}
        return new Metadata(String.valueOf(row.id()),String.valueOf(row.workspace()),row.name(),"webhook",String.valueOf(row.version()),row.enabled(),safeOrigin,status,limits(row),"new-deliveries",keyState,List.copyOf(reasons));
    }
    /** Effective for new deliveries. Persisted outbox budgets remain immutable. */
    public NotificationLimits limits(NotificationChannelRepo.Row row){try{var d=NotificationLimits.deployment(properties);var saved=row.limits()==null?d:json.readValue(row.limits(),NotificationLimits.class);long retryMax=Math.min(saved.retryMaxMs(),d.retryMaxMs());return new NotificationLimits(Math.min(saved.requestTimeoutMs(),d.requestTimeoutMs()),Math.min(saved.maxAttempts(),d.maxAttempts()),Math.min(saved.retryMinMs(),retryMax),retryMax,Math.min(saved.jitterRatio(),d.jitterRatio()),Math.min(saved.deliveryTtlMs(),d.deliveryTtlMs()),Math.min(saved.maxPayloadBytes(),d.maxPayloadBytes()),Math.min(saved.maxResponseBytes(),d.maxResponseBytes()));}catch(Exception e){throw ChannelCipher.unavailable();}}
    private String encode(NotificationLimits limits){try{return json.writeValueAsString(limits);}catch(Exception e){throw new IllegalStateException("Cannot encode notification limits");}}
    public Metadata update(UserAccount caller,String ws,String channel,Write input){
        guard.requireAdmin(id(ws),caller);events.gate();var old=repo.find(id(ws),id(channel),true).filter(r->!r.deleted()).orElseThrow(()->error(org.springframework.http.HttpStatus.NOT_FOUND,"channel_not_found","渠道不存在"));guard.requireAdmin(id(ws),caller);if(version(input.expectedVersion())!=old.version())throw error(org.springframework.http.HttpStatus.CONFLICT,"version_conflict","渠道版本已变化");if(old.version()==Long.MAX_VALUE)throw error(org.springframework.http.HttpStatus.CONFLICT,"version_exhausted","渠道版本已达上限");
        boolean enabled=input.enabled()==null?old.enabled():input.enabled();String name=input.name()==null?old.name():input.name();var limits=input.limits()==null?limits(old):input.limits();limits.validate(properties);String origin=old.origin();ChannelCipher.Envelope envelope=new ChannelCipher.Envelope(old.keyId(),old.nonce(),old.ciphertext());
        validateName(name);if(input.url()!=null)validateUrl(input.url());
        DeliveryChannel previous=null;try{if(input.url()==null||input.hmacSecret()==null)previous=cipher.open(old);String url=input.url()==null?previous.uri().toString():input.url();String secret=input.hmacSecret()==null?new String(previous.hmacSecret(),java.nio.charset.StandardCharsets.UTF_8):input.hmacSecret();validate(new Write(input.expectedVersion(),name,url,secret,enabled,limits));origin=origin(URI.create(url));envelope=cipher.seal(id(ws),old.id(),old.version()+1,url,secret);}catch(com.autumnharvestc.server.core.ApiException unavailable){if(enabled||input.url()!=null||input.hmacSecret()!=null)throw unavailable;/* Revocation must remain possible without a usable deployment key. Re-enable then needs fresh material. */}finally{if(previous!=null)Arrays.fill(previous.hmacSecret(),(byte)0);}
        repo.update(old,name,origin,enabled,false,encode(limits),envelope);outbox.stopChannel(old.id(),old.version(),time.now());audit.audit(caller.id(),"notification-channel.update","notify-channel",old.id(),old.version()+1);return metadata(repo.find(id(ws),old.id(),false).orElseThrow());
    }
    public void delete(UserAccount caller,String ws,String channel,String expected){guard.requireAdmin(id(ws),caller);events.gate();var old=repo.find(id(ws),id(channel),true).filter(r->!r.deleted()).orElseThrow(()->error(org.springframework.http.HttpStatus.NOT_FOUND,"channel_not_found","渠道不存在"));guard.requireAdmin(id(ws),caller);if(version(expected)!=old.version())throw error(org.springframework.http.HttpStatus.CONFLICT,"version_conflict","渠道版本已变化");repo.update(old,old.name(),old.origin(),false,true,old.limits(),new ChannelCipher.Envelope(old.keyId(),old.nonce(),old.ciphertext()));outbox.stopChannel(old.id(),old.version(),time.now());audit.audit(caller.id(),"notification-channel.delete","notify-channel",old.id(),old.version()+1);}
    public List<Map<String,String>> selectable(long ws){return repo.list(ws).stream().filter(r->metadata(r).status().equals("available")).map(r->Map.of("id",String.valueOf(r.id()),"name",r.name(),"kind","webhook")).toList();}
    private static void validate(Write input){
        validateName(input.name());if(input.enabled()==null||input.hmacSecret()==null||input.hmacSecret().getBytes(java.nio.charset.StandardCharsets.UTF_8).length<16||input.hmacSecret().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>256)throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","渠道开关或签名密钥格式无效");validateUrl(input.url());
    }
    private static void validateName(String name){if(name==null||name.isBlank()||name.length()>128||name.chars().anyMatch(c->c<32))throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","渠道名称格式无效");}
    private static void validateUrl(String url){try{if(url==null||url.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>8192)throw new IllegalArgumentException();origin(URI.create(url));}catch(Exception ignored){throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","渠道地址必须为8192字节内、不含用户信息和片段的受支持HTTP(S)地址");}}
    static String origin(URI uri){return com.autumnharvestc.server.execution.scheduling.NotificationOrigin.canonical(uri);}
}
