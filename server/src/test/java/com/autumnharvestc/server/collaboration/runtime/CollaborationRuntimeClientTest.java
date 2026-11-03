package com.autumnharvestc.server.collaboration.runtime;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.params.provider.CsvSource;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import static org.junit.jupiter.api.Assertions.*;
import static org.assertj.core.api.Assertions.assertThat;

class CollaborationRuntimeClientTest {
    static final String SECRET="synthetic-secret-0123456789abcdef";
    static final String READY_DIGEST="36b0201a3de46864b79b836e17d888c1a3555fc205bcef650184a604e94acab4";
    final ObjectMapper json=new ObjectMapper();
    final RuntimeProtocol protocol=new RuntimeProtocol(json);
    @TempDir Path directory;
    final List<HttpServer> servers=new ArrayList<>();
    @AfterEach void close(){servers.forEach(server->server.stop(0));}
    RuntimeProperties properties() throws Exception {
        var properties=new RuntimeProperties();properties.setEnabled(true);
        properties.setBaseUrl("http://127.0.0.1:1"); // Valid fixed origin for constructor-only branches.
        var file=directory.resolve("secret");Files.writeString(file,SECRET+"\n");properties.setSecretFile(file.toString());
        properties.setMaxWireBytes(1_048_576);properties.setConnectTimeoutMs(3000);properties.setCallTimeoutMs(10000);properties.setMockTimeoutMs(35000);
        return properties;
    }
    String listen(Consumer<com.sun.net.httpserver.HttpExchange> handler) throws Exception {
        var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/rpc",exchange->{try{handler.accept(exchange);}finally{exchange.close();}});server.start();servers.add(server);
        return "http://127.0.0.1:"+server.getAddress().getPort();
    }
    ObjectNode response(JsonNode request) {
        var value=(ObjectNode)request.deepCopy();value.put("coreBuildIdentity",protocol.coreBuildIdentity());
        value.set("payload",json.createObjectNode().put("ready",true));
        value.put("outputDigest",READY_DIGEST).put("outputBytes",14).put("wireBytes",1);
        return value;
    }
    void send(com.sun.net.httpserver.HttpExchange exchange,ObjectNode value) {
        send(exchange,value,false);
    }
    void send(com.sun.net.httpserver.HttpExchange exchange,ObjectNode value,boolean chunked) {
        try {
            byte[] bytes=json.writeValueAsBytes(value);
            while(value.path("wireBytes").asInt()!=bytes.length){value.put("wireBytes",bytes.length);bytes=json.writeValueAsBytes(value);}
            exchange.sendResponseHeaders(200,chunked?0:bytes.length);exchange.getResponseBody().write(bytes);
        }catch(Exception error){throw new RuntimeException(error);}
    }
    CollaborationRuntimeClient client(RuntimeProperties properties){return new CollaborationRuntimeClient(properties,protocol,json);}
    void fails(String code,Runnable call){assertTrue(assertThrows(RuntimeException.class,call::run).getMessage().contains(code));}

    @Test void defaultsAreOptionalAndUseDocumentedBudgets(){
        var p=new RuntimeProperties();assertFalse(p.isEnabled());
        assertAll(()->assertEquals(3000,p.getConnectTimeoutMs()),()->assertEquals(10000,p.getCallTimeoutMs()),()->assertEquals(35000,p.getMockTimeoutMs()),()->assertEquals(33_554_432,p.getMaxWireBytes()));
    }
    @Test void disabledOldServiceHasExplicitUnavailableWithoutReadingSecret(){
        var p=new RuntimeProperties();p.setSecretFile(directory.resolve("missing").toString());
        fails("RPC_UNAVAILABLE",()->client(p).call("health",json.createObjectNode(),System.currentTimeMillis()+1000,4096));
    }
    @ParameterizedTest @ValueSource(strings={"missing","","short"}) void enabledBadSecretFilesRefuseStartup(String value) throws Exception {
            var p=properties();var path=directory.resolve("bad-"+UUID.randomUUID());if(!value.equals("missing"))Files.writeString(path,value);p.setSecretFile(path.toString());
            fails("RPC_SECRET_FILE_INVALID",()->client(p));
    }
    @Test void enabledValidSecretFileConstructorPrerequisite() throws Exception {
        var p=properties();assertDoesNotThrow(()->client(p));
    }
    @ParameterizedTest @ValueSource(strings={"\nsecond-line","\u0000suffix","\tsuffix","非ASCII"}) void unportableSecretCannotEnableHeaderAuthentication(String suffix) throws Exception {
        var p=properties();Files.writeString(Path.of(p.getSecretFile()),SECRET+suffix);fails("RPC_SECRET_FILE_INVALID",()->client(p));
    }
    @ParameterizedTest @CsvSource({"99,10000,35000,1048576","30001,10000,35000,1048576","3000,999,35000,1048576","3000,300001,35000,1048576","3000,10000,999,1048576","3000,10000,120001,1048576","3000,10000,35000,1048575","3000,10000,35000,134217729"})
    void rangesRejectWithoutClamping(int connect,int call,int mock,int wire) throws Exception {
            var p=properties();p.setBaseUrl("http://127.0.0.1:1");p.setConnectTimeoutMs(connect);p.setCallTimeoutMs(call);p.setMockTimeoutMs(mock);p.setMaxWireBytes(wire);
            fails("RPC_CONFIGURATION_INVALID",()->client(p));
    }
    @Test void generatedSchemasUseExactSharedStructuralAndNonBmpFixtures() throws Exception {
        try(var stream=getClass().getResourceAsStream("/collaboration-runtime-fixtures.json")) {
            var checks=new ArrayList<org.junit.jupiter.api.function.Executable>();
            for(var fixture:json.readTree(stream))checks.add(()->assertEquals(fixture.path("wireValid").asBoolean(),protocol.validRequest(fixture.path("request")),fixture.path("name").asText()));
            assertAll(checks);
        }
    }
    @Test void fixedTypedTreeDigestKnownVectors() throws Exception {
        try(var stream=getClass().getResourceAsStream("/collaboration-digest-vectors.json")) {
            var checks=new ArrayList<org.junit.jupiter.api.function.Executable>();
            for(var vector:json.readTree(stream))checks.add(()->assertEquals(java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(java.util.HexFormat.of().parseHex(vector.get(1).asText()))),RuntimeProtocol.digestJson(json.readTree(vector.get(0).asText())),vector.get(0).asText()));
            assertAll(checks);
        }
    }
    @Test void validLoopbackHasActualSecretAndResponseIdentity() throws Exception {
        var p=properties();var calls=new AtomicInteger();
        p.setBaseUrl(listen(exchange->{try{assertEquals(SECRET,exchange.getRequestHeaders().getFirst("X-Apicc-Collaboration-Key"));calls.incrementAndGet();var request=json.readTree(exchange.getRequestBody());assertTrue(protocol.validRequest(request));send(exchange,response(request));}catch(Exception error){throw new RuntimeException(error);}}));
        assertEquals(true,client(p).call("health",json.createObjectNode(),System.currentTimeMillis()+3000,4096).path("ready").asBoolean());assertEquals(1,calls.get());
    }
    @ParameterizedTest @ValueSource(strings={"protocolVersion","operation","requestId","inputDigest","coreBuildIdentity","outputDigest","outputBytes","deadlineEpochMs","outputBudgetBytes","unknown"})
    void rejectsEveryResponseBindingBeforeReturningPayload(String field) throws Exception {
            var p=properties();p.setBaseUrl(listen(exchange->{try{var value=response(json.readTree(exchange.getRequestBody()));if(field.equals("protocolVersion"))value.put(field,2);else if(List.of("outputBytes","deadlineEpochMs","outputBudgetBytes").contains(field))value.put(field,0);else value.put(field,"synthetic-wrong");send(exchange,value);}catch(Exception error){throw new RuntimeException(error);}}));
            fails("RPC_RESPONSE_INVALID",()->client(p).call("health",json.createObjectNode(),System.currentTimeMillis()+3000,4096));
    }
    @Test void rejectsDeclaredWireBytes() throws Exception {
        var p=properties();p.setBaseUrl(listen(exchange->{try{var value=response(json.readTree(exchange.getRequestBody()));byte[] bytes=json.writeValueAsBytes(value);exchange.sendResponseHeaders(200,0);exchange.getResponseBody().write(bytes);}catch(Exception error){throw new RuntimeException(error);}}));
        fails("RPC_RESPONSE_INVALID",()->client(p).call("health",json.createObjectNode(),System.currentTimeMillis()+3000,4096));
    }
    @Test void rejectsActualWireOverage() throws Exception {
        var big=properties();big.setBaseUrl(listen(exchange->{try{var request=json.readTree(exchange.getRequestBody());var value=response(request);value.set("payload",json.createObjectNode().put("scriptChanged",false).set("locations",json.createArrayNode().add("x".repeat(1_048_576))));send(exchange,value,true);}catch(Exception error){throw new RuntimeException(error);}}));
        var payload=json.createObjectNode();payload.set("beforeFiles",json.createArrayNode());payload.set("afterFiles",json.createArrayNode());
        fails("RPC_MESSAGE_TOO_LARGE",()->client(big).call("classify-asset-mutation",payload,System.currentTimeMillis()+3000,2_097_152));
    }
    @Test void parentDeadlineCapsCallAndFailureIsNeverRetried() throws Exception {
        var p=properties();var calls=new AtomicInteger();var release=new CountDownLatch(1);
        p.setBaseUrl(listen(exchange->{calls.incrementAndGet();try{release.await(2,TimeUnit.SECONDS);send(exchange,response(json.readTree(exchange.getRequestBody())));}catch(Exception error){throw new RuntimeException(error);}}));
        try{fails("RPC_DEADLINE_EXCEEDED",()->client(p).call("health",json.createObjectNode(),System.currentTimeMillis()+150,4096));assertEquals(1,calls.get());}finally{release.countDown();}
    }
    @Test void expiredParentNeverMakesNetworkCall() throws Exception {
        var p=properties();var calls=new AtomicInteger();p.setBaseUrl(listen(exchange->{calls.incrementAndGet();try{send(exchange,response(json.readTree(exchange.getRequestBody())));}catch(Exception error){throw new RuntimeException(error);}}));
        fails("RPC_DEADLINE_EXCEEDED",()->client(p).call("health",json.createObjectNode(),1,4096));assertEquals(0,calls.get());
    }
    @ParameterizedTest @ValueSource(strings={"http://user:password@127.0.0.1:1234","http://127.0.0.1:1234/path","http://127.0.0.1:1234?target=1","http://127.0.0.1:1234#fragment","file:///tmp/runtime","relative"})
    void deploymentMustBeFixedExactHttpOrigin(String origin) throws Exception {
        var p=properties();p.setBaseUrl(origin);fails("RPC_CONFIGURATION_INVALID",()->client(p));
    }
    @Test void redirectsAreRejectedWithoutContactingAnotherOrigin() throws Exception {
        var calls=new AtomicInteger();String target=listen(exchange->{calls.incrementAndGet();try{send(exchange,response(json.readTree(exchange.getRequestBody())));}catch(Exception error){throw new RuntimeException(error);}});
        var p=properties();p.setBaseUrl(listen(exchange->{try{exchange.getResponseHeaders().set("Location",target+"/rpc");byte[] bytes="{}".getBytes();exchange.sendResponseHeaders(302,bytes.length);exchange.getResponseBody().write(bytes);}catch(Exception error){throw new RuntimeException(error);}}));
        assertAll(()->fails("RPC_RESPONSE_INVALID",()->client(p).call("health",json.createObjectNode(),System.currentTimeMillis()+3000,4096)),()->assertEquals(0,calls.get()));
    }
    @Test void rejectsUnknownOperationBeforeNetwork() throws Exception {
        var calls=new AtomicInteger();var p=properties();p.setBaseUrl(listen(exchange->{calls.incrementAndGet();try{send(exchange,response(json.readTree(exchange.getRequestBody())));}catch(Exception error){throw new RuntimeException(error);}}));
        assertAll(()->fails("RPC_INVALID_REQUEST",()->client(p).call("eval",json.createObjectNode(),System.currentTimeMillis()+3000,4096)),()->assertEquals(0,calls.get()));
    }
    @Test void rejectsActualRequestWireOverageBeforeNetwork() throws Exception {
        var calls=new AtomicInteger();var p=properties();p.setBaseUrl(listen(exchange->{calls.incrementAndGet();try{send(exchange,response(json.readTree(exchange.getRequestBody())));}catch(Exception error){throw new RuntimeException(error);}}));
        JsonNode fixtures;try(var stream=getClass().getResourceAsStream("/collaboration-runtime-fixtures.json")){fixtures=json.readTree(stream);}
        ObjectNode payload=fixtures.get(0).path("request").path("payload").deepCopy();((ObjectNode)payload.get("input")).put("title","x".repeat(1_048_576));
        assertAll(()->fails("RPC_MESSAGE_TOO_LARGE",()->client(p).call("project-report",payload,System.currentTimeMillis()+3000,4096)),()->assertEquals(0,calls.get()));
    }
    @Test void ordinaryCallBudgetCapsParentRemainingDeadline() throws Exception {
        var captured=new java.util.concurrent.atomic.AtomicLong();var p=properties();long before=System.currentTimeMillis();
        p.setBaseUrl(listen(exchange->{try{var request=json.readTree(exchange.getRequestBody());captured.set(request.path("deadlineEpochMs").asLong());send(exchange,response(request));}catch(Exception error){throw new RuntimeException(error);}}));
        assertTrue(client(p).call("health",json.createObjectNode(),before+600000,4096).path("ready").asBoolean());
        assertTrue(captured.get()<=before+10500,"normal call must be capped by configured10s budget");
    }
    @ParameterizedTest @ValueSource(longs={1000,600000}) void mockUsesOwnBudgetCappedByParent(long remaining) throws Exception {
        var captured=new java.util.concurrent.atomic.AtomicLong();var p=properties();long before=System.currentTimeMillis();
        var payload=json.readTree("{\"plan\":{\"sourceProjectRevision\":\"r1\",\"routes\":[]},\"input\":{\"method\":\"GET\",\"target\":\"/\",\"headers\":{},\"body\":[]},\"policy\":{\"maxResponseBytes\":1024,\"maxDelayMs\":30000,\"requestDeadlineMs\":35000,\"extraSensitiveHeaders\":[],\"extraSensitiveQuery\":[],\"extraSensitiveFields\":[],\"extraSensitivePointers\":[]}}");
        p.setBaseUrl(listen(exchange->{try{var request=json.readTree(exchange.getRequestBody());captured.set(request.path("deadlineEpochMs").asLong());var value=response(request);var output=json.readTree("{\"status\":404,\"mediaType\":\"text/plain\",\"headers\":{},\"body\":[],\"delayMs\":0,\"reason\":\"NO_ROUTE\"}");value.set("payload",output);value.put("outputDigest",RuntimeProtocol.digestJson(output));value.put("outputBytes",json.writeValueAsBytes(output).length);send(exchange,value);}catch(Exception error){throw new RuntimeException(error);}}));
        assertEquals(404,client(p).call("respond-mock",payload,before+remaining,4096).path("status").asInt());
        assertTrue(Math.abs(captured.get()-(before+Math.min(remaining,35000)))<=500,"Mock owns35s call budget while respecting remaining parent");
    }
    @Test void acceptsActualRawPayloadByteSpanWithNodeNumberAndEscapeSpelling() throws Exception {
        var p=properties();
        JsonNode fixtures;try(var stream=getClass().getResourceAsStream("/collaboration-runtime-fixtures.json")){fixtures=json.readTree(stream);}
        var dto=json.readTree("{\"formatVersion\":1,\"kind\":\"document\",\"title\":\"非ASCII 😀 \\\" \\n\",\"source\":{\"trust\":\"member-claim\",\"revision\":\"r1\",\"digest\":\"d1\"},\"summary\":[{\"labelCode\":\"number\",\"value\":1e-7}],\"limitations\":[],\"document\":{\"apis\":[],\"models\":[],\"components\":[]}}");
        var payload=json.createObjectNode();payload.set("input",json.createObjectNode().put("sourceKind","member-upload").set("artifact",dto));payload.set("policy",fixtures.get(0).path("request").path("payload").path("policy"));
        p.setBaseUrl(listen(exchange->{try{
            var value=response(json.readTree(exchange.getRequestBody()));value.set("payload",dto);value.put("outputDigest",RuntimeProtocol.digestJson(dto));
            String jackson=json.writeValueAsString(dto);String wire=jackson.replace("1.0E-7","1e-7").replace("非ASCII","\\u975eASCII");assertNotEquals(jackson,wire);
            value.put("outputBytes",wire.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
            byte[] bytes=json.writeValueAsString(value).replace(jackson,wire).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            while(value.path("wireBytes").asInt()!=bytes.length){value.put("wireBytes",bytes.length);bytes=json.writeValueAsString(value).replace(jackson,wire).getBytes(java.nio.charset.StandardCharsets.UTF_8);}
            exchange.sendResponseHeaders(200,0);exchange.getResponseBody().write(bytes);
        }catch(Exception error){throw new RuntimeException(error);}}));
        assertEquals(dto,client(p).call("project-document",payload,System.currentTimeMillis()+3000,4096));
    }
    @Test void deadlineAlsoBoundsStreamingBodyAfterHeaders() throws Exception {
        var p=properties();var started=new CountDownLatch(1);var release=new CountDownLatch(1);var completed=new CountDownLatch(1);
        p.setBaseUrl(listen(exchange->{try{
            var value=response(json.readTree(exchange.getRequestBody()));byte[] bytes=json.writeValueAsBytes(value);while(value.path("wireBytes").asInt()!=bytes.length){value.put("wireBytes",bytes.length);bytes=json.writeValueAsBytes(value);}
            exchange.sendResponseHeaders(200,0);exchange.getResponseBody().write(bytes,0,1);exchange.getResponseBody().flush();started.countDown();release.await(2,TimeUnit.SECONDS);exchange.getResponseBody().write(bytes,1,bytes.length-1);
        }catch(Exception ignored){}}));
        var client=client(p);long deadline=System.currentTimeMillis()+250;
        var future=CompletableFuture.runAsync(()->{try{fails("RPC_DEADLINE_EXCEEDED",()->client.call("health",json.createObjectNode(),deadline,4096));}finally{completed.countDown();}});
        try{assertTrue(started.await(1,TimeUnit.SECONDS));assertTrue(completed.await(600,TimeUnit.MILLISECONDS),"deadline must stop an unfinished response body while sender is held");}
        finally{release.countDown();future.join();}
    }
    org.springframework.boot.test.context.runner.ApplicationContextRunner bindingContext(){
        return new org.springframework.boot.test.context.runner.ApplicationContextRunner()
            .withConfiguration(org.springframework.boot.autoconfigure.AutoConfigurations.of(org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration.class))
            .withBean(ObjectMapper.class,ObjectMapper::new).withBean(RuntimeProperties.class).withBean(RuntimeProtocol.class).withBean(CollaborationRuntimeClient.class);
    }
    @Test void productionBindingDefaultDisabledStartsWithoutNodeOrSecret(){
        bindingContext().run(context->{
            assertThat(context).hasNotFailed();var p=context.getBean(RuntimeProperties.class);assertFalse(p.isEnabled());assertEquals(3000,p.getConnectTimeoutMs());
            fails("RPC_UNAVAILABLE",()->context.getBean(CollaborationRuntimeClient.class).call("health",json.createObjectNode(),System.currentTimeMillis()+1000,4096));
        });
    }
    @Test void productionBindingEnabledValuesDriveActualLoopbackClient() throws Exception {
        var p=properties();String origin=listen(exchange->{try{send(exchange,response(json.readTree(exchange.getRequestBody())));}catch(Exception error){throw new RuntimeException(error);}});
        bindingContext().withPropertyValues("apicc.collaboration.runtime.enabled=true","apicc.collaboration.runtime.base-url="+origin,"apicc.collaboration.runtime.secret-file="+p.getSecretFile(),"apicc.collaboration.runtime.connect-timeout-ms=1234","apicc.collaboration.runtime.call-timeout-ms=5678","apicc.collaboration.runtime.max-wire-bytes=1048576").run(context->{
            assertThat(context).hasNotFailed();var bound=context.getBean(RuntimeProperties.class);assertTrue(bound.isEnabled());assertEquals(1234,bound.getConnectTimeoutMs());assertEquals(5678,bound.getCallTimeoutMs());assertEquals(1048576,bound.getMaxWireBytes());
            assertTrue(context.getBean(CollaborationRuntimeClient.class).call("health",json.createObjectNode(),System.currentTimeMillis()+1000,4096).path("ready").asBoolean());
        });
    }
    @Test void productionBindingEnabledBadSecretFailsStartup(){
        bindingContext().withPropertyValues("apicc.collaboration.runtime.enabled=true","apicc.collaboration.runtime.base-url=http://127.0.0.1:1","apicc.collaboration.runtime.secret-file="+directory.resolve("missing")).run(context->{assertThat(context).hasFailed();assertThat(context.getStartupFailure()).hasRootCauseMessage("RPC_SECRET_FILE_INVALID");});
    }
    @Test void productionBindingInvalidRangeFailsStartup() throws Exception {
        var p=properties();bindingContext().withPropertyValues("apicc.collaboration.runtime.enabled=true","apicc.collaboration.runtime.base-url=http://127.0.0.1:1","apicc.collaboration.runtime.secret-file="+p.getSecretFile(),"apicc.collaboration.runtime.call-timeout-ms=999").run(context->{assertThat(context).hasFailed();assertThat(context.getStartupFailure()).hasRootCauseMessage("RPC_CONFIGURATION_INVALID");});
    }
}
