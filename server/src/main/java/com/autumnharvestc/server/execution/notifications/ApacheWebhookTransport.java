package com.autumnharvestc.server.execution.notifications;
import com.autumnharvestc.server.execution.scheduling.NotificationProperties;
import java.net.*;
import java.time.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.hc.client5.http.classic.methods.HttpPost;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.client5.http.impl.io.PoolingHttpClientConnectionManagerBuilder;
import org.apache.hc.client5.http.impl.routing.DefaultRoutePlanner;
import org.apache.hc.client5.http.impl.DefaultSchemePortResolver;
import org.apache.hc.client5.http.config.*;
import org.apache.hc.client5.http.protocol.HttpClientContext;
import org.apache.hc.core5.http.io.entity.ByteArrayEntity;
import org.apache.hc.core5.http.ContentType;
import org.apache.hc.core5.io.CloseMode;
import org.apache.hc.core5.util.Timeout;

public class ApacheWebhookTransport implements NotificationTransport,AutoCloseable {
    private final NotificationProperties properties;
    @FunctionalInterface public interface Lookup {InetAddress[] resolve(String host)throws java.net.UnknownHostException;}
    private final Lookup lookup;private final java.util.function.Predicate<DeliveryChannel> authorized;
    private final java.util.concurrent.ThreadPoolExecutor workers;
    private final javax.net.ssl.SSLContext deploymentTls;
    public ApacheWebhookTransport(NotificationProperties properties){this(properties,InetAddress::getAllByName,c->true);}
    public ApacheWebhookTransport(NotificationProperties properties,Lookup lookup,java.util.function.Predicate<DeliveryChannel> authorized){this(properties,lookup,authorized,null);}
    public ApacheWebhookTransport(NotificationProperties properties,Lookup lookup,java.util.function.Predicate<DeliveryChannel> authorized,javax.net.ssl.SSLContext deploymentTls){this.properties=properties;this.lookup=lookup;this.authorized=authorized;this.deploymentTls=deploymentTls;this.workers=new java.util.concurrent.ThreadPoolExecutor(properties.getConcurrency(),properties.getConcurrency(),0L,java.util.concurrent.TimeUnit.MILLISECONDS,new java.util.concurrent.SynchronousQueue<>(),r->{var t=new Thread(r,"notification-http");t.setDaemon(true);return t;},new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());}
    @Override public void close(){workers.shutdownNow();}
    @Override public DeliveryResult send(DeliveryChannel channel,byte[] fixedBody,String eventId,Instant deliveryTimestamp,NotificationLimits limits){
        var call=new Call(System.nanoTime()+java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(limits.requestTimeoutMs()));java.util.concurrent.Future<DeliveryResult> future;
        try{future=workers.submit(()->perform(channel,fixedBody,eventId,deliveryTimestamp,limits,call));}catch(java.util.concurrent.RejectedExecutionException busy){return new DeliveryResult("transport-busy",null,null,false);}
        try{return future.get(limits.requestTimeoutMs(),java.util.concurrent.TimeUnit.MILLISECONDS);}catch(java.util.concurrent.TimeoutException timeout){call.cancel();future.cancel(true);return new DeliveryResult("timeout",null,null,false);}catch(InterruptedException interrupted){call.cancel();future.cancel(true);Thread.currentThread().interrupt();return new DeliveryResult("timeout",null,null,false);}catch(Exception ignored){call.cancel();return new DeliveryResult("network-error",null,null,false);}
    }
    private static final class Call {
        final long deadline;final java.util.concurrent.atomic.AtomicBoolean cancelled=new java.util.concurrent.atomic.AtomicBoolean();final java.util.concurrent.atomic.AtomicReference<HttpPost> request=new java.util.concurrent.atomic.AtomicReference<>();final java.util.concurrent.atomic.AtomicReference<org.apache.hc.client5.http.impl.classic.CloseableHttpClient> client=new java.util.concurrent.atomic.AtomicReference<>();
        Call(long deadline){this.deadline=deadline;}
        void check(){if(cancelled.get()||System.nanoTime()>=deadline||Thread.currentThread().isInterrupted())throw new Denied("timeout");}
        void cancel(){cancelled.set(true);var r=request.get();if(r!=null)r.cancel();var c=client.get();if(c!=null)try{c.close(CloseMode.IMMEDIATE);}catch(Exception ignored){}}
    }
    private DeliveryResult perform(DeliveryChannel channel,byte[] fixedBody,String eventId,Instant deliveryTimestamp,NotificationLimits limits,Call call){
        try{
            call.check();
            var uri=channel.uri();if(!authorized.test(channel))return new DeliveryResult("channel-changed",null,null,false);if(fixedBody.length>limits.maxPayloadBytes())return new DeliveryResult("payload-too-large",null,null,false);if(!permitted(uri))return new DeliveryResult("outbound-denied",null,null,false);
            InetAddress[] addresses=uri.getHost().matches("[0-9.]+")||uri.getHost().contains(":")?new InetAddress[]{InetAddress.getByName(uri.getHost())}:lookup.resolve(uri.getHost());
            if(addresses==null||addresses.length==0||Arrays.stream(addresses).anyMatch(a->!addressAllowed(a)))return new DeliveryResult("outbound-denied",null,null,false);
            Runnable fence=()->{call.check();if(!authorized.test(channel))throw new Denied("channel-changed");if(!permitted(uri)||Arrays.stream(addresses).anyMatch(a->!addressAllowed(a)))throw new Denied("outbound-denied");call.check();};fence.run();
            var resolver=new org.apache.hc.client5.http.DnsResolver(){public InetAddress[] resolve(String host)throws UnknownHostException{fence.run();if(!host.equals(uri.getHost()))throw new UnknownHostException("Rejected endpoint");return addresses.clone();}public String resolveCanonicalHostname(String host){return host;}};
            var timeout=Timeout.ofMilliseconds(limits.requestTimeoutMs());
            var manager=PoolingHttpClientConnectionManagerBuilder.create().setTlsSocketStrategy(deploymentTls==null?org.apache.hc.client5.http.ssl.DefaultClientTlsStrategy.createSystemDefault():new org.apache.hc.client5.http.ssl.DefaultClientTlsStrategy(deploymentTls)).setDnsResolver(resolver).setMaxConnTotal(1).setMaxConnPerRoute(1).setDefaultConnectionConfig(ConnectionConfig.custom().setConnectTimeout(timeout).setSocketTimeout(timeout).build()).build();
            var request=new HttpPost(uri);request.setEntity(new ByteArrayEntity(fixedBody,ContentType.APPLICATION_JSON));request.setHeader("Connection","close");request.setHeader("Accept-Encoding","identity");request.setHeader("X-Apicc-Event-Id",eventId);request.setHeader("X-Apicc-Timestamp",deliveryTimestamp.toString());
            call.request.set(request);call.check();
            var mac=javax.crypto.Mac.getInstance("HmacSHA256");mac.init(new javax.crypto.spec.SecretKeySpec(channel.hmacSecret(),"HmacSHA256"));mac.update((deliveryTimestamp.toString()+".").getBytes(StandardCharsets.UTF_8));request.setHeader("X-Apicc-Signature","sha256="+HexFormat.of().formatHex(mac.doFinal(fixedBody)));
            var client=HttpClients.custom().setConnectionManager(manager).setRoutePlanner(new DefaultRoutePlanner(DefaultSchemePortResolver.INSTANCE)).setConnectionReuseStrategy((a,b,c)->false).addRequestInterceptorFirst((r,e,c)->fence.run()).disableAutomaticRetries().disableRedirectHandling().disableAuthCaching().disableCookieManagement().disableConnectionState().disableContentCompression().setDefaultRequestConfig(RequestConfig.custom().setAuthenticationEnabled(false).setRedirectsEnabled(false).setContentCompressionEnabled(false).setHardCancellationEnabled(true).setResponseTimeout(timeout).setConnectionRequestTimeout(timeout).build()).build();
            org.apache.hc.core5.http.ClassicHttpResponse response=null;
            try{call.client.set(client);fence.run();response=client.executeOpen(null,request,HttpClientContext.create());int status=response.getCode();if(response.getEntity()!=null){byte[] discarded=response.getEntity().getContent().readNBytes(limits.maxResponseBytes()+1);boolean oversized=discarded.length>limits.maxResponseBytes();Arrays.fill(discarded,(byte)0);call.check();if(oversized)return new DeliveryResult("response-too-large",status,null,false);}call.check();return new DeliveryResult(status>=200&&status<300?"acknowledged":status==408||status==429||status>=500?"http-retryable":"http-terminal",status,retryAfter(response.getFirstHeader("Retry-After"),deliveryTimestamp),status>=200&&status<300);}
            finally{client.close(CloseMode.IMMEDIATE);if(response!=null)try{response.close();}catch(java.io.IOException ignored){}}
        }catch(Denied denied){return new DeliveryResult(denied.code,null,null,false);}catch(Exception ignored){return new DeliveryResult(call.cancelled.get()||System.nanoTime()>=call.deadline?"timeout":"network-error",null,null,false);}
    }
    private static final class Denied extends RuntimeException {final String code;Denied(String code){super(code,null,false,false);this.code=code;}}
    private static Instant retryAfter(org.apache.hc.core5.http.Header header,Instant now){if(header==null)return null;try{String value=header.getValue();if(value.matches("[0-9]{1,9}"))return now.plusSeconds(Long.parseLong(value));return java.time.ZonedDateTime.parse(value,java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant();}catch(Exception ignored){return null;}}
    private boolean permitted(URI uri){
        if(uri==null||!Set.of("http","https").contains(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getFragment()!=null)return false;String origin;try{origin=NotificationChannelService.origin(uri);}catch(IllegalArgumentException unsupported){return false;}
        return properties.getAllowedWebhookOrigins().contains(origin)&&(!uri.getScheme().equals("http")||properties.getAllowHttpOrigins().contains(origin));
    }
    private boolean addressAllowed(InetAddress address){
        if(address.isAnyLocalAddress()||address.isMulticastAddress())return false;
        for(String cidr:properties.getAllowedWebhookCidrs())try{String[] parts=cidr.split("/");byte[] network=InetAddress.getByName(parts[0]).getAddress(),target=address.getAddress();int prefix=Integer.parseInt(parts[1]);if(network.length!=target.length||prefix<0||prefix>network.length*8)continue;boolean same=true;for(int bit=0;bit<prefix;bit++)if((network[bit/8]&(1<<(7-bit%8)))!=(target[bit/8]&(1<<(7-bit%8)))){same=false;break;}if(same)return true;}catch(Exception ignored){}
        return false;
    }
}
