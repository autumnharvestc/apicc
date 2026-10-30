package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.execution.notifications.*;
import com.autumnharvestc.server.execution.scheduling.NotificationProperties;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class WebhookTransportTest {
    final NotificationLimits limits=new NotificationLimits(1000,2,1000,2000,0,10000,1024,128);
    static final Instant TIME=Instant.parse("2035-01-01T00:00:00Z");
    static final byte[] SECRET="synthetic-signature-secret".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    static final class Endpoint implements AutoCloseable {
        final HttpServer server;final AtomicInteger count=new AtomicInteger();final java.util.concurrent.ExecutorService executor;
        Endpoint(String address,com.sun.net.httpserver.HttpHandler handler)throws Exception{this(address,handler,1);}
        Endpoint(String address,com.sun.net.httpserver.HttpHandler handler,int concurrency)throws Exception{executor=java.util.concurrent.Executors.newFixedThreadPool(concurrency,r->{var t=new Thread(r,"synthetic-webhook");t.setDaemon(true);return t;});server=HttpServer.create(new InetSocketAddress(address,0),0);server.setExecutor(executor);server.createContext("/",e->{count.incrementAndGet();handler.handle(e);});server.start();}
        String origin(String host){return "http://"+host+":"+server.getAddress().getPort();}
        public void close(){server.stop(0);executor.shutdownNow();}
    }
    NotificationProperties permit(String origin,String cidr){var p=new NotificationProperties();p.setAllowedWebhookOrigins(List.of(origin));p.setAllowHttpOrigins(List.of(origin));p.setAllowedWebhookCidrs(List.of(cidr));return p;}
    DeliveryResult send(ApacheWebhookTransport transport,String origin,byte[] body){return transport.send(new DeliveryChannel("1","1",URI.create(origin+"/"),SECRET),body,"123",TIME,limits);}
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"host-case","ipv6-expanded"})
    void equivalentChannelOriginMatchesOnlyTheExactCanonicalDeploymentPermit(String kind)throws Exception{
        boolean ipv6=kind.equals("ipv6-expanded");try(var endpoint=new Endpoint(ipv6?"::1":"127.0.0.1",e->{e.sendResponseHeaders(204,-1);e.close();})){
            String canonical=endpoint.origin(ipv6?"[::1]":"synthetic.invalid"),raw=endpoint.origin(ipv6?"[0:0:0:0:0:0:0:1]":"SYNTHETIC.invalid");var p=permit(canonical,ipv6?"::1/128":"127.0.0.1/32");assertThat(p.isValid()).isTrue();
            try(var transport=new ApacheWebhookTransport(p,h->new InetAddress[]{InetAddress.getByName("127.0.0.1")},c->true)){assertThat(send(transport,raw,new byte[0]).acknowledged()).isTrue();assertThat(endpoint.count).hasValue(1);p.setAllowedWebhookOrigins(List.of());assertThat(send(transport,raw,new byte[0]).acknowledged()).isFalse();assertThat(endpoint.count).hasValue(1);}
        }
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.CsvSource({"https://hook.example.test,true","http://[::1]:9443,true","https://[2001:db8::1:0:0:1]:9443,true","https://[::ffff:7f00:1],true","https://HOOK.example.test,false","https://hook.example.test:443,false","https://[0:0:0:0:0:0:0:1],false","https://[2001:db8:0:0:1:0:0:1]:9443,false","https://[::ffff:127.0.0.1],false","https://127.1,false","https://0177.0.0.1,false","https://hook.example.test:0,false","https://hook.example.test:65536,false","https://hook.example.test/path,false","https://xn--a.test,false"})
    void deploymentOriginSyntaxRemainsStrictAndMatchesTheClientCanonicalForm(String origin,boolean accepted){var p=new NotificationProperties();p.setAllowedWebhookOrigins(List.of(origin));assertThat(p.isValid()).isEqualTo(accepted);}
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"https://xn--bcher-kva.test","https://bücher.test"})
    void initialNotificationDeploymentDoesNotClaimIdnSupport(String origin){var p=new NotificationProperties();p.setAllowedWebhookOrigins(List.of(origin));assertThat(p.isValid()).isFalse();}
    @Test void unsupportedLegacyOriginIsDeniedWithoutStartingAConnection()throws Exception{
        try(var endpoint=new Endpoint("127.0.0.1",e->{e.sendResponseHeaders(204,-1);e.close();})){var p=permit(endpoint.origin("synthetic.invalid"),"127.0.0.1/32");try(var transport=new ApacheWebhookTransport(p,h->new InetAddress[]{InetAddress.getByName("127.0.0.1")},c->true)){var result=send(transport,endpoint.origin("xn--a.test"),new byte[0]);assertThat(result.reasonCode()).isEqualTo("outbound-denied");assertThat(endpoint.count).hasValue(0);}}
    }
    @Test void permittedLocalEndpointReceivesOneSignedFixedBody()throws Exception{
        var count=new AtomicInteger();var body=new AtomicReference<byte[]>();var signature=new AtomicReference<String>();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/",e->{count.incrementAndGet();body.set(e.getRequestBody().readAllBytes());signature.set(e.getRequestHeaders().getFirst("X-Apicc-Signature"));e.sendResponseHeaders(204,-1);e.close();});server.start();
        try{var p=new NotificationProperties();String origin="http://127.0.0.1:"+server.getAddress().getPort();p.setAllowedWebhookOrigins(List.of(origin));p.setAllowHttpOrigins(List.of(origin));p.setAllowedWebhookCidrs(List.of("127.0.0.1/32"));byte[] fixed="{\"id\":\"123\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);byte[] secret="synthetic-signature-secret".getBytes(java.nio.charset.StandardCharsets.UTF_8);var timestamp=Instant.parse("2035-01-01T00:00:00Z");
            DeliveryResult result;try(var transport=new ApacheWebhookTransport(p)){result=transport.send(new DeliveryChannel("1","1",URI.create(origin+"/"),secret),fixed,"123",timestamp,limits);}
            assertThat(result.acknowledged()).isTrue();assertThat(result.status()).isEqualTo(204);assertThat(count).hasValue(1);assertThat(body.get()).isEqualTo(fixed);
            var mac=javax.crypto.Mac.getInstance("HmacSHA256");mac.init(new javax.crypto.spec.SecretKeySpec(secret,"HmacSHA256"));mac.update((timestamp.toString()+".").getBytes(java.nio.charset.StandardCharsets.UTF_8));assertThat(signature.get()).isEqualTo("sha256="+HexFormat.of().formatHex(mac.doFinal(fixed)));
        }finally{server.stop(0);}
    }
    @Test void controlledDnsAddressesActuallyConnectWithoutASecondResolution()throws Exception{
        try(var endpoint=new Endpoint("127.0.0.1",e->{e.sendResponseHeaders(204,-1);e.close();})){String origin=endpoint.origin("synthetic.invalid");var p=permit(origin,"127.0.0.1/32");var calls=new AtomicInteger();try(var transport=new ApacheWebhookTransport(p,h->new InetAddress[]{InetAddress.getByName(calls.incrementAndGet()==1?"127.0.0.1":"127.0.0.2")},c->true)){assertThat(send(transport,origin,new byte[0]).acknowledged()).isTrue();assertThat(endpoint.count).hasValue(1);assertThat(calls).hasValue(1);}}
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"mixed-v4","mixed-v6","empty"})
    void aSingleUnauthorizedDnsAnswerRejectsTheWholeCollection(String kind)throws Exception{
        try(var endpoint=new Endpoint("127.0.0.1",e->{e.sendResponseHeaders(204,-1);e.close();})){String origin=endpoint.origin("synthetic.invalid");var p=permit(origin,"127.0.0.1/32");var calls=new AtomicInteger();try(var transport=new ApacheWebhookTransport(p,h->{int call=calls.incrementAndGet();return kind.equals("empty")?new InetAddress[0]:new InetAddress[]{InetAddress.getByName("127.0.0.1"),InetAddress.getByName(kind.equals("mixed-v6")?"::1":"127.0.0.2")};},c->true)){assertThat(send(transport,origin,new byte[0]).acknowledged()).isFalse();assertThat(endpoint.count).hasValue(0);}}
    }
    @Test void revokedChannelCannotStartEvenALiteralAddressRequest()throws Exception{
        try(var endpoint=new Endpoint("127.0.0.1",e->{e.sendResponseHeaders(204,-1);e.close();})){String origin=endpoint.origin("127.0.0.1");try(var transport=new ApacheWebhookTransport(permit(origin,"127.0.0.1/32"),InetAddress::getAllByName,c->false)){assertThat(send(transport,origin,new byte[0]).acknowledged()).isFalse();assertThat(endpoint.count).hasValue(0);}}
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(ints={401,407,302})
    void automaticAuthenticationCookiesProxyCompressionAndRedirectsAreNotUsed(int status)throws Exception{
        var cookies=new java.util.concurrent.CopyOnWriteArrayList<String>();var encodings=new java.util.concurrent.CopyOnWriteArrayList<String>();var auth=new java.util.concurrent.CopyOnWriteArrayList<String>();var connections=new java.util.concurrent.CopyOnWriteArrayList<String>();var number=new AtomicInteger();String proxy=System.getProperty("http.proxyHost"),port=System.getProperty("http.proxyPort");
        try(var trap=new Endpoint("127.0.0.1",e->{e.sendResponseHeaders(500,-1);e.close();});var endpoint=new Endpoint("127.0.0.1",e->{cookies.add(Objects.toString(e.getRequestHeaders().getFirst("Cookie"),"none"));auth.add(Objects.toString(e.getRequestHeaders().getFirst("Authorization"),"none"));encodings.add(e.getRequestHeaders().getFirst("Accept-Encoding"));connections.add(e.getRequestHeaders().getFirst("Connection"));e.getResponseHeaders().set("WWW-Authenticate","Basic realm=synthetic");e.getResponseHeaders().set("Proxy-Authenticate","Basic realm=synthetic");e.getResponseHeaders().set("Set-Cookie","synthetic=value; Path=/");e.getResponseHeaders().set("Location","/must-not-follow");e.sendResponseHeaders(number.incrementAndGet()==1?status:204,-1);e.close();})){System.setProperty("http.proxyHost","127.0.0.1");System.setProperty("http.proxyPort",String.valueOf(trap.server.getAddress().getPort()));String origin=endpoint.origin("synthetic.invalid");try(var transport=new ApacheWebhookTransport(permit(origin,"127.0.0.1/32"),h->new InetAddress[]{InetAddress.getByName("127.0.0.1")},c->true)){assertThat(send(transport,origin,new byte[0]).acknowledged()).isFalse();assertThat(endpoint.count).hasValue(1);assertThat(send(transport,origin,new byte[0]).acknowledged()).isTrue();assertThat(endpoint.count).hasValue(2);assertThat(trap.count).hasValue(0);assertThat(cookies).containsExactly("none","none");assertThat(auth).containsExactly("none","none");assertThat(encodings).containsExactly("identity","identity");assertThat(connections).containsExactly("close","close");}}
        finally{if(proxy==null)System.clearProperty("http.proxyHost");else System.setProperty("http.proxyHost",proxy);if(port==null)System.clearProperty("http.proxyPort");else System.setProperty("http.proxyPort",port);}
    }
    @Test void anExplicitlyPermittedIpv6LiteralCanConnect()throws Exception{
        try(var endpoint=new Endpoint("::1",e->{e.sendResponseHeaders(204,-1);e.close();})){String origin=endpoint.origin("[::1]");try(var transport=new ApacheWebhookTransport(permit(origin,"::1/128"))){assertThat(send(transport,origin,new byte[0]).acknowledged()).isTrue();assertThat(endpoint.count).hasValue(1);}}
    }
    @Test void utf8PayloadBudgetPreventsAnyNetworkRequest()throws Exception{
        try(var endpoint=new Endpoint("127.0.0.1",e->{e.sendResponseHeaders(204,-1);e.close();})){String origin=endpoint.origin("127.0.0.1");try(var transport=new ApacheWebhookTransport(permit(origin,"127.0.0.1/32"))){var result=send(transport,origin,"密".repeat(400).getBytes(java.nio.charset.StandardCharsets.UTF_8));assertThat(result.acknowledged()).isFalse();assertThat(endpoint.count).hasValue(0);}}
    }
    @Test void oversizeSecretEchoIsBoundedAndNeverAppearsInTheResult()throws Exception{
        try(var endpoint=new Endpoint("127.0.0.1",e->{byte[] echo=("synthetic-url-and-signature-secret".repeat(20)).getBytes();e.sendResponseHeaders(200,echo.length);e.getResponseBody().write(echo);e.close();})){String origin=endpoint.origin("127.0.0.1");try(var transport=new ApacheWebhookTransport(permit(origin,"127.0.0.1/32"))){var result=send(transport,origin,new byte[0]);assertThat(result.reasonCode()).isEqualTo("response-too-large");assertThat(result.acknowledged()).isFalse();assertThat(result.toString()).doesNotContain("synthetic-url-and-signature-secret");}}
    }
    @Test void retryAfterIsASafeTimeAndRedirectsNeverCreateAnotherRequest()throws Exception{
        try(var endpoint=new Endpoint("127.0.0.1",e->{e.getResponseHeaders().set("Retry-After","120");e.getResponseHeaders().set("Location","/redirect-target");e.sendResponseHeaders(429,-1);e.close();})){String origin=endpoint.origin("127.0.0.1");try(var transport=new ApacheWebhookTransport(permit(origin,"127.0.0.1/32"))){var result=send(transport,origin,new byte[0]);assertThat(result.retryAfter()).isEqualTo(TIME.plusSeconds(120));assertThat(result.status()).isEqualTo(429);assertThat(endpoint.count).hasValue(1);}}
    }
    @Test void wholeSendDeadlineCancelsATricklingResponseRatherThanRenewingPerRead()throws Exception{
        try(var endpoint=new Endpoint("127.0.0.1",e->{e.sendResponseHeaders(200,100);try{for(int i=0;i<100;i++){e.getResponseBody().write(1);e.getResponseBody().flush();Thread.sleep(30);}}catch(Exception ignored){}finally{e.close();}})){String origin=endpoint.origin("127.0.0.1");try(var transport=new ApacheWebhookTransport(permit(origin,"127.0.0.1/32"))){long started=System.nanoTime();var result=send(transport,origin,new byte[0]);long elapsed=java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started);assertThat(elapsed).as("entire operation deadline in milliseconds").isLessThan(1800);assertThat(result.reasonCode()).isEqualTo("timeout");assertThat(result.acknowledged()).isFalse();}}
    }
    @Test void aDnsLookupFinishingAfterDeadlineCannotStartALateConnection()throws Exception{
        try(var endpoint=new Endpoint("127.0.0.1",e->{e.sendResponseHeaders(204,-1);e.close();})){String origin=endpoint.origin("synthetic.invalid");try(var transport=new ApacheWebhookTransport(permit(origin,"127.0.0.1/32"),h->{long end=System.nanoTime()+java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(2500);while(System.nanoTime()<end){java.util.concurrent.locks.LockSupport.parkNanos(10000000);Thread.interrupted();}return new InetAddress[]{InetAddress.getByName("127.0.0.1")};},c->true)){long started=System.nanoTime();var result=send(transport,origin,new byte[0]);assertThat(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)).isLessThan(1800);assertThat(result.reasonCode()).isEqualTo("timeout");Thread.sleep(1800);assertThat(endpoint.count).hasValue(0);}}
    }
    @Test void deploymentRevocationDuringDnsPreventsTheNewRequest()throws Exception{
        try(var endpoint=new Endpoint("127.0.0.1",e->{e.sendResponseHeaders(204,-1);e.close();})){String origin=endpoint.origin("synthetic.invalid");var p=permit(origin,"127.0.0.1/32");try(var transport=new ApacheWebhookTransport(p,h->{p.setAllowedWebhookOrigins(List.of());return new InetAddress[]{InetAddress.getByName("127.0.0.1")};},c->true)){assertThat(send(transport,origin,new byte[0]).acknowledged()).isFalse();assertThat(endpoint.count).hasValue(0);}}
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.CsvSource({"trusted,true","untrusted,false","wrong-host,false"})
    void deploymentPrivateCaRetainsCertificateAndHostnameValidation(String mode,boolean acknowledged)throws Exception{
        var directory=java.nio.file.Files.createTempDirectory("apicc-notification-synthetic-tls-");var store=directory.resolve("synthetic.p12");com.sun.net.httpserver.HttpsServer server=null;var executor=java.util.concurrent.Executors.newSingleThreadExecutor(r->{var t=new Thread(r,"synthetic-https");t.setDaemon(true);return t;});
        try{
            var process=new ProcessBuilder(java.nio.file.Path.of(System.getProperty("java.home"),"bin",System.getProperty("os.name").startsWith("Windows")?"keytool.exe":"keytool").toString(),"-genkeypair","-alias","synthetic","-keyalg","RSA","-keysize","2048","-storetype","PKCS12","-keystore",store.toString(),"-storepass","synthetic-only-pass","-keypass","synthetic-only-pass","-dname","CN=synthetic.invalid","-ext","SAN=dns:synthetic.invalid","-validity","2","-noprompt").redirectErrorStream(true).start();process.getInputStream().readAllBytes();assertThat(process.waitFor()).isZero();
            var keys=java.security.KeyStore.getInstance("PKCS12");try(var stream=java.nio.file.Files.newInputStream(store)){keys.load(stream,"synthetic-only-pass".toCharArray());}var km=javax.net.ssl.KeyManagerFactory.getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm());km.init(keys,"synthetic-only-pass".toCharArray());var tm=javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm());tm.init(keys);var tls=javax.net.ssl.SSLContext.getInstance("TLS");tls.init(km.getKeyManagers(),tm.getTrustManagers(),new java.security.SecureRandom());
            server=com.sun.net.httpserver.HttpsServer.create(new InetSocketAddress("127.0.0.1",0),0);server.setHttpsConfigurator(new com.sun.net.httpserver.HttpsConfigurator(tls));server.setExecutor(executor);var count=new AtomicInteger();server.createContext("/",e->{count.incrementAndGet();e.sendResponseHeaders(204,-1);e.close();});server.start();String origin="https://"+(mode.equals("wrong-host")?"other.invalid":"synthetic.invalid")+":"+server.getAddress().getPort();var p=permit(origin,"127.0.0.1/32");
            try(var transport=new ApacheWebhookTransport(p,h->new InetAddress[]{InetAddress.getByName("127.0.0.1")},c->true,mode.equals("untrusted")?null:tls)){var result=transport.send(new DeliveryChannel("1","1",URI.create(origin+"/"),SECRET),new byte[0],"123",TIME,new NotificationLimits(3000,2,1000,2000,0,10000,1024,128));assertThat(result.acknowledged()).isEqualTo(acknowledged);assertThat(count).hasValue(acknowledged?1:0);}
        }finally{if(server!=null)server.stop(0);executor.shutdownNow();java.nio.file.Files.deleteIfExists(store);java.nio.file.Files.deleteIfExists(directory);}
    }
}
