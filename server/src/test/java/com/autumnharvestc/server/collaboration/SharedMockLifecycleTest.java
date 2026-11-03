package com.autumnharvestc.server.collaboration;

import java.net.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.hc.core5.http.*;
import org.apache.hc.core5.http.impl.bootstrap.AsyncServerBootstrap;
import org.apache.hc.core5.http.nio.*;
import org.apache.hc.core5.http.protocol.HttpContext;
import org.apache.hc.core5.io.CloseMode;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-t8-lifecycle;DB_CLOSE_DELAY=-1", "server.address=127.0.0.1", "apicc.collaboration.policy.defaults.external-sharing-allowed=true", "apicc.collaboration.policy.defaults.shared-mock-allowed=true", "apicc.collaboration.public-access.enabled=true"})
@Import(SharedMockApiTest.RealRuntime.class)
class SharedMockLifecycleTest extends SharedMockFixture {
    static final int PUBLIC_PORT=port();
    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties){properties.add("apicc.collaboration.public-access.port",()->PUBLIC_PORT);properties.add("apicc.collaboration.public-access.base-url",()->"http://127.0.0.1:"+PUBLIC_PORT);}
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties deployment;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.grants.GrantService grants;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.publicapi.PublicAdmissionState admissionState;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.mock.SharedMockGateway gateway;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.mock.MockLimiter mockLimits;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.policy.CollaborationPolicyService policies;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.audit.AccessObservations observations;
    @Test void disconnectedPublicConnectionReclaimsItsActualSessionRegistration()throws Exception {
        @SuppressWarnings("unchecked") var sessions=(java.util.Map<String,org.apache.hc.core5.reactor.IOSession>)ownedField(listener,"sessions");
        org.apache.hc.core5.reactor.IOSession registered;String id;
        try(var socket=new Socket("127.0.0.1",PUBLIC_PORT)){
            socket.setSoTimeout(2000);socket.getOutputStream().write("GET /t8-session-lifecycle HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".getBytes(StandardCharsets.US_ASCII));socket.getOutputStream().flush();
            assertThat(new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream())).readLine()).as("actual public handler reached").contains(" 404 ");
            var entry=sessions.entrySet().stream().filter(value->value.getValue().getRemoteAddress().equals(socket.getLocalSocketAddress())).findFirst().orElseThrow();id=entry.getKey();registered=entry.getValue();assertThat(registered.isOpen()).as("actual connection is registered before caller close").isTrue();assertThat(sessions.get(id)).isSameAs(registered);
        }
        waitFor(()->!registered.isOpen());
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);while(sessions.containsKey(id)&&System.nanoTime()<until)Thread.sleep(10);
        assertThat(sessions.containsKey(id)).as("closed public connection removes its strong session registration").isFalse();
    }
    @Test void responseDeadlineCollectsRealTransportBeforeReleasingGatewayOwnership()throws Exception {
        var original=deployment.getDefaults();try{
            deploymentDefaults(java.util.Map.of("maxMockResponseBytes",8*1024*1024,"maxArtifactBytes",32*1024*1024));
            var f=fixture();var smallGrant=grant(f,mock(f));assertThat(call(smallGrant,"/items/item-7").statusCode()).isEqualTo(200);
            var files=new java.util.ArrayList<java.util.Map<String,String>>();for(var file:node.info.path("large"))files.add(java.util.Map.of("path",file.path("path").asText(),"content",file.path("content").asText().replace("x".repeat(1600),"x".repeat(4*1024*1024))));
            var saved=save(f.owner(),f.workspace(),f.project(),"2",files);policy(f,false,java.util.Map.of("mockInFlight",1,"mockCallTimeoutMs",15000));
            var preview=body(request(f.owner().token(),post(collaboration(f)+"/previews"),java.util.Map.of("title","Finite backpressure response","includeEvidence",false,"source",java.util.Map.of("kind","mock","revision",saved.path("version").asText(),"manifestHash",saved.path("manifestHash").asText(),"scope",java.util.Map.of("kind","project")))).andExpect(status().isCreated()));
            var publication=body(request(f.owner().token(),post(collaboration(f)+"/publications"),java.util.Map.of("publicationIntentId",java.util.UUID.randomUUID().toString(),"previewId",preview.path("id").asText(),"candidateDigest",preview.path("candidateDigest").asText(),"expectedPolicyRevision",preview.path("expectedPolicyRevision").asLong())).andExpect(status().isCreated()));
            publication=body(request(f.owner().token(),post(collaboration(f)+"/publications/"+publication.path("id").asText()+"/enable"),java.util.Map.of("expectedRevision",1)).andExpect(status().isOk()));
            var grant=grant(f,publication);long publicationId=publication.path("id").asLong();int before=node.records(http,json).path("calls").size();
            try(var socket=new Socket()){
                socket.setReceiveBufferSize(1024);socket.connect(new InetSocketAddress("127.0.0.1",PUBLIC_PORT));socket.setSoTimeout(16000);
                socket.getOutputStream().write(("GET /mock/"+grant.path("publicId").asText()+"/items/item-7 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Apicc-Mock-Key: "+grant.path("key").asText()+"\r\nX-Business: present\r\n\r\n").getBytes(StandardCharsets.US_ASCII));socket.getOutputStream().flush();
                var head=new StringBuilder();while(!head.toString().endsWith("\r\n\r\n")){int next=socket.getInputStream().read();assertThat(next).as("real response head reached").isNotNegative();head.append((char)next);assertThat(head.length()).isLessThan(8192);}assertThat(head.toString()).startsWith("HTTP/1.1 200 ");
                assertThat(node.records(http,json).path("calls").get(before).path("ruleId").asText()).isEqualTo("10000000-0000-4000-8000-000000000015");
                @SuppressWarnings("unchecked") var active=(java.util.Set<Object>)ownedField(listener,"active");
                Object exchange=active.stream().filter(value->((com.sun.net.httpserver.HttpExchange)value).getRequestURI().getPath().contains(grant.path("publicId").asText())).findFirst().orElseThrow();
                var collected=(CountDownLatch)ownedField(exchange,"collected");@SuppressWarnings("unchecked") var worker=(java.util.concurrent.atomic.AtomicReference<Thread>)ownedField(exchange,"worker");
                assertThat(collected.getCount()).as("actual response is waiting on transport, not Node/read-body").isEqualTo(1);assertThat(mockLimits.active(publicationId)).isEqualTo(1);assertThat(call(grant,"/missing").statusCode()).isEqualTo(429);
                boolean premature=false;long observationEnd=System.nanoTime()+TimeUnit.SECONDS.toNanos(18);
                while(System.nanoTime()<observationEnd){if(collected.getCount()>0&&(mockLimits.active(publicationId)==0||worker.get()==null||!active.contains(exchange))){premature=true;break;}if(collected.getCount()==0&&worker.get()==null&&!active.contains(exchange))break;Thread.sleep(2);}
                boolean releasedEarly=premature;
                org.junit.jupiter.api.Assertions.assertAll(()->assertThat(releasedEarly).as("gateway ownership cannot end while response transport is uncollected").isFalse(),()->assertThat(collected.getCount()).as("deadline causes actual transport collection without client close/read").isZero(),()->assertThat(mockLimits.active(publicationId)).isZero(),()->assertThat(worker.get()).isNull(),()->assertThat(active).doesNotContain(exchange));
            }
            assertThat(call(smallGrant,"/items/item-7").statusCode()).isEqualTo(200);
        }finally{deployment.setDefaults(original);}
    }
    private static Object ownedField(Object owner,String name)throws Exception {var field=owner.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(owner);}
    void deploymentDefaults(java.util.Map<String,Object> changes){var original=deployment.getDefaults();com.fasterxml.jackson.databind.node.ObjectNode copy=original==null?json.createObjectNode():json.valueToTree(original);changes.forEach((key,value)->copy.set(key,json.valueToTree(value)));deployment.setDefaults(json.convertValue(copy,com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));}
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"Set-Cookie","Location","Connection","Content-Security-Policy","Access-Control-Allow-Origin"})
    void javaConstrainsActualRpcResponseControlHeaders(String name)throws Exception {
        var f=fixture();var grant=grant(f,mock(f));assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);
        var response=http.send(java.net.http.HttpRequest.newBuilder(URI.create(grant.path("baseUrl").asText()+"/items/item-7")).timeout(java.time.Duration.ofSeconds(3)).header("X-Apicc-Mock-Key",grant.path("key").asText()).header("X-Business","present").header("X-Synthetic-Response-Header",name).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).isEqualTo(503);
    }
    @Test void runtimeCapacityIsAnImmediate429WithoutBackgroundRetry()throws Exception {
        var f=fixture();var one=grant(f,mock(f,"slow"));var other=fixture();var two=grant(other,mock(other));int before=node.records(http,json).path("calls").size();var pending=CompletableFuture.supplyAsync(()->{try{return call(one,"/items/item-7");}catch(Exception e){throw new RuntimeException(e);}});java.net.http.HttpResponse<String> response;
        try{waitFor(()->node.records(http,json).path("calls").size()>before);response=call(two,"/items/item-7");}finally{pending.get();}assertThat(response.statusCode()).isEqualTo(429);assertThat(node.records(http,json).path("calls").size()).isEqualTo(before+1);
    }
    @Test void configuredSensitiveBusinessHeaderNeverEntersNode()throws Exception {
        var original=deployment.getDefaults();try{deploymentDefaults(java.util.Map.of("extraSensitiveHeaders",java.util.List.of("X-Private")));var f=fixture();var grant=grant(f,mock(f));int before=node.records(http,json).path("calls").size();var response=http.send(java.net.http.HttpRequest.newBuilder(URI.create(grant.path("baseUrl").asText()+"/items/item-7")).header("X-Apicc-Mock-Key",grant.path("key").asText()).header("X-Business","present").header("X-Private","synthetic-private-input").GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).isEqualTo(200);assertThat(node.records(http,json).path("calls").get(before).path("headers").has("x-private")).isFalse();}finally{deployment.setDefaults(original);}
    }
    @Test void authorizedOriginUsesExactCurrentProjectIntersection()throws Exception {
        var original=deployment.getDefaults();try{deploymentDefaults(java.util.Map.of("corsAllowedOrigins",java.util.List.of("https://allowed.test")));var f=fixture();var grant=grant(f,mock(f));var response=origin(grant,"https://allowed.test");assertThat(response.statusCode()).isEqualTo(200);assertThat(response.headers().firstValue("Access-Control-Allow-Origin")).contains("https://allowed.test");assertThat(response.headers().firstValue("Access-Control-Allow-Credentials")).isEmpty();policy(f,false,java.util.Map.of("corsAllowedOrigins",java.util.List.of()));assertThat(origin(grant,"https://allowed.test").statusCode()).isEqualTo(403);}finally{deployment.setDefaults(original);}
    }
    java.net.http.HttpResponse<String> origin(com.fasterxml.jackson.databind.JsonNode grant,String origin)throws Exception{return http.send(java.net.http.HttpRequest.newBuilder(URI.create(grant.path("baseUrl").asText()+"/items/item-7")).timeout(java.time.Duration.ofSeconds(3)).header("X-Apicc-Mock-Key",grant.path("key").asText()).header("X-Business","present").header("Origin",origin).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());}
    java.net.http.HttpResponse<String> preflight(String publicId,String origin,String method,String headers)throws Exception{return http.send(java.net.http.HttpRequest.newBuilder(URI.create(listener.origin()+"/mock/"+publicId+"/items/item-7")).timeout(java.time.Duration.ofSeconds(3)).header("Origin",origin).header("Access-Control-Request-Method",method).header("Access-Control-Request-Headers",headers).method("OPTIONS",java.net.http.HttpRequest.BodyPublishers.noBody()).build(),java.net.http.HttpResponse.BodyHandlers.ofString());}
    @Test void standardPreflightIsUniformWithoutResourceLookupNodeOrHitLog()throws Exception {
        var original=deployment.getDefaults();try{deploymentDefaults(java.util.Map.of("corsAllowedOrigins",java.util.List.of("https://allowed.test")));var f=fixture();var publication=mock(f);var grant=grant(f,publication);var before=node.records(http,json);long logs=jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_mock_logs",Long.class);
            var known=preflight(grant.path("publicId").asText(),"https://allowed.test","GET","x-apicc-mock-key, x-business, authorization");var unknown=preflight("A".repeat(22),"https://allowed.test","GET","x-apicc-mock-key, x-business, authorization");assertThat(known.statusCode()).isEqualTo(204);assertThat(unknown.statusCode()).isEqualTo(204);assertThat(known.body()).isEmpty();assertThat(unknown.body()).isEmpty();assertThat(known.headers().firstValue("Access-Control-Allow-Origin")).contains("https://allowed.test");assertThat(known.headers().firstValue("Access-Control-Allow-Credentials")).isEmpty();assertThat(node.records(http,json).path("operations")).isEqualTo(before.path("operations"));assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_mock_logs",Long.class)).isEqualTo(logs);
            var noKey=http.send(java.net.http.HttpRequest.newBuilder(URI.create(grant.path("baseUrl").asText()+"/items/item-7")).header("Origin","https://allowed.test").GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(noKey.statusCode()).isEqualTo(404);
        }finally{deployment.setDefaults(original);}
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"origin","method","header"})
    void preflightRejectsOnlyReachedInvalidCorsMetadata(String branch)throws Exception {
        var original=deployment.getDefaults();try{deploymentDefaults(java.util.Map.of("corsAllowedOrigins",java.util.List.of("https://allowed.test")));
            assertThat(preflight("A".repeat(22),"https://allowed.test","GET","x-apicc-mock-key").statusCode()).isEqualTo(204);
            var response=preflight("A".repeat(22),branch.equals("origin")?"https://other.test":"https://allowed.test",branch.equals("method")?"CONNECT":"GET",branch.equals("header")?"not a header":"x-apicc-mock-key");assertThat(response.statusCode()).isEqualTo(403);assertThat(response.headers().firstValue("Access-Control-Allow-Origin")).isEmpty();
        }finally{deployment.setDefaults(original);}
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"rps","inflight","bytes"})
    void preflightSharesExistingGlobalAndByteBudgets(String branch)throws Exception {
        var original=deployment.getDefaults();var originalTotals=deployment.getDeployment();try{deploymentDefaults(java.util.Map.of("corsAllowedOrigins",java.util.List.of("https://allowed.test")));assertThat(preflight("A".repeat(22),"https://allowed.test","GET","x-apicc-mock-key").statusCode()).isEqualTo(204);
            if(branch.equals("bytes")){deploymentDefaults(java.util.Map.of("maxMockRequestBytes",1024));assertThat(preflight("A".repeat(22),"https://allowed.test","GET","x".repeat(1600)).statusCode()).isEqualTo(413);}
            else if(branch.equals("rps")){Thread.sleep(1100);deployment.setDeployment(json.convertValue(java.util.Map.of("deploymentMockRps",1),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Deployment.class));assertThat(preflight("A".repeat(22),"https://allowed.test","GET","x-apicc-mock-key").statusCode()).isEqualTo(204);assertThat(preflight("B".repeat(22),"https://allowed.test","GET","x-apicc-mock-key").statusCode()).isEqualTo(429);}
            else{var f=fixture();var grant=grant(f,mock(f,"slow"));deployment.setDeployment(json.convertValue(java.util.Map.of("deploymentMockInFlight",1),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Deployment.class));int before=node.records(http,json).path("calls").size();var pending=CompletableFuture.supplyAsync(()->{try{return call(grant,"/items/item-7");}catch(Exception e){throw new RuntimeException(e);}});try{waitFor(()->node.records(http,json).path("calls").size()>before);assertThat(preflight("A".repeat(22),"https://allowed.test","GET","x-apicc-mock-key").statusCode()).isEqualTo(429);}finally{assertThat(pending.get().statusCode()).isEqualTo(200);}}
        }finally{deployment.setDefaults(original);deployment.setDeployment(originalTotals);}
    }
    @Test void absoluteFormBusinessTargetIsRejectedAfterValidAdmission()throws Exception {
        var f=fixture();var grant=grant(f,mock(f));assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);
        try(var socket=new Socket("127.0.0.1",PUBLIC_PORT)){socket.setSoTimeout(2000);socket.getOutputStream().write(("GET http://example.test/mock/"+grant.path("publicId").asText()+"/items/item-7 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Apicc-Mock-Key: "+grant.path("key").asText()+"\r\nX-Business: present\r\n\r\n").getBytes(StandardCharsets.US_ASCII));socket.getOutputStream().flush();assertThat(new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream())).readLine()).contains(" 400 ");}
    }
    @Test void killedNodeFailsOldCallWithoutReplayAndNewCallLoadsFixedPlan()throws Exception {
        var f=fixture();var grant=grant(f,mock(f,"slow"));int before=node.records(http,json).path("calls").size();var pending=CompletableFuture.supplyAsync(()->{try{return call(grant,"/items/item-7");}catch(Exception e){throw new RuntimeException(e);}});waitFor(()->node.records(http,json).path("calls").size()>before);
        node.restart();var old=pending.get();assertThat(node.records(http,json).path("calls").size()).isZero();assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);assertThat(node.records(http,json).path("calls").size()).isEqualTo(1);assertThat(old.statusCode()).isEqualTo(503);assertThat(json.readTree(old.body()).path("code").asText()).isEqualTo("collaboration_mock_unavailable");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"large","longHeaders"})
    void currentResponseAndHeaderBytesAreBounded(String variant)throws Exception {
        var f=fixture();var grant=grant(f,mock(f,variant));assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);policy(f,false,java.util.Map.of("maxMockResponseBytes",1024));var response=call(grant,"/items/item-7");assertThat(response.statusCode()).isEqualTo(503);
    }
    @Test void stopOfOwnedPublicListenerCancelsReachedNodeWorkAndCollectsSlot()throws Exception {
        var f=fixture();var grant=grant(f,mock(f,"slow"));var properties=new com.autumnharvestc.server.collaboration.publicapi.PublicAccessProperties();properties.setEnabled(true);properties.setPort(0);
        var owned=new com.autumnharvestc.server.collaboration.publicapi.PublicListener(properties,grants,json,admissionState,gateway,mockLimits,policies,observations);owned.run(new org.springframework.boot.DefaultApplicationArguments());int index=node.records(http,json).path("calls").size();
        var pending=http.sendAsync(java.net.http.HttpRequest.newBuilder(URI.create(owned.origin()+"/mock/"+grant.path("publicId").asText()+"/items/item-7")).timeout(java.time.Duration.ofSeconds(4)).header("X-Apicc-Mock-Key",grant.path("key").asText()).header("X-Business","present").GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString()).handle((response,error)->response);
        try{waitFor(()->node.records(http,json).path("calls").size()>index);owned.close();waitFor(()->node.records(http,json).path("calls").get(index).path("cancelled").asBoolean());assertThat(pending.get()).isNull();assertThat(owned.running()).isFalse();assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);}finally{owned.close();}
    }
    @Test void disableUsesSameCasAndShowsRealDrainingThenCollectedState()throws Exception {
        var f=fixture();var publication=mock(f,"slow");var grant=grant(f,publication);int index=node.records(http,json).path("calls").size();var pending=CompletableFuture.supplyAsync(()->{try{return call(grant,"/items/item-7");}catch(Exception e){throw new RuntimeException(e);}});waitFor(()->node.records(http,json).path("calls").size()>index);
        var disabled=body(request(f.owner().token(),post(collaboration(f)+"/publications/"+publication.path("id").asText()+"/disable"),java.util.Map.of("expectedRevision",2)).andExpect(status().isOk()));
        var old=pending.get();assertThat(disabled.path("enabled").asBoolean(true)).isFalse();assertThat(disabled.at("/activity/activeRequests").asInt()).isEqualTo(1);assertThat(disabled.at("/activity/state").asText()).isEqualTo("draining");assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(410);assertThat(old.statusCode()).isEqualTo(200);
        waitFor(()->body(mvc.perform(get(collaboration(f)+"/publications/"+publication.path("id").asText()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).at("/activity/activeRequests").asInt(-1)==0);
    }
    @Test void realActivePublicationCountIsVisibleDuringReachedNodeDelay()throws Exception {
        var f=fixture();var publication=mock(f,"slow");var grant=grant(f,publication);int index=node.records(http,json).path("calls").size();var pending=CompletableFuture.supplyAsync(()->{try{return call(grant,"/items/item-7");}catch(Exception e){throw new RuntimeException(e);}});
        try{waitFor(()->node.records(http,json).path("calls").size()>index);var state=body(mvc.perform(get(collaboration(f)+"/publications/"+publication.path("id").asText()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));assertThat(state.at("/activity/activeRequests").asInt()).isEqualTo(1);}finally{pending.get();}
    }
    @Test void enableDisableAliasesHaveSamePurposeAuthorityAndRevisionChecks()throws Exception {
        var f=fixture();var publication=mock(f);String path=collaboration(f)+"/publications/"+publication.path("id").asText()+"/disable";
        request(f.owner().token(),post(path),java.util.Map.of("expectedRevision",999)).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("publication_revision_conflict"));
    }
    @Test void enableDisableDoesNotUsePublicationManageAsMockAuthority()throws Exception {
        var f=fixture();var publication=mock(f);capability(f,f.editor(),"publication.manage","allow");request(f.editor().token(),post(collaboration(f)+"/publications/"+publication.path("id").asText()+"/disable"),java.util.Map.of("expectedRevision",2)).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"project-rps","global-rps","global-inflight"})
    void finiteProjectAndGlobalIntersection(String branch)throws Exception {
        var f=fixture();var one=grant(f,mock(f,branch.equals("global-inflight")?"slow":"files"));
        var other=fixture();var two=grant(other,mock(other));var original=deployment.getDeployment();
        try{
            if(branch.equals("project-rps"))policy(f,false,java.util.Map.of("mockRps",1));
            else {if(branch.equals("global-rps"))Thread.sleep(1100);deployment.setDeployment(json.convertValue(java.util.Map.of(branch.equals("global-rps")?"deploymentMockRps":"deploymentMockInFlight",1),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Deployment.class));}
            if(branch.equals("global-inflight")){
                int index=node.records(http,json).path("calls").size();var pending=java.util.concurrent.CompletableFuture.supplyAsync(()->{try{return call(one,"/items/item-7");}catch(Exception e){throw new RuntimeException(e);}});
                waitFor(()->node.records(http,json).path("calls").size()>index);assertThat(call(two,"/items/item-7").statusCode()).isEqualTo(429);assertThat(pending.get().statusCode()).isEqualTo(200);
            }else{assertThat(call(one,"/items/item-7").statusCode()).isEqualTo(200);assertThat(call(branch.equals("project-rps")?one:two,"/items/item-7").statusCode()).isEqualTo(429);}
        }finally{deployment.setDeployment(original);}
    }
    @Test void deadlineCancelsUnfinishedBodyAndSlotCanOnlyBeUsedAfterReadSettles()throws Exception {
        var f=fixture();var grant=grant(f,mock(f));policy(f,false,java.util.Map.of("mockCallTimeoutMs",1000,"mockInFlight",1));
        try(var socket=new Socket("127.0.0.1",PUBLIC_PORT)){
            socket.setSoTimeout(1600);socket.getOutputStream().write(("POST /mock/"+grant.path("publicId").asText()+"/items/item-7 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Apicc-Mock-Key: "+grant.path("key").asText()+"\r\nContent-Length: 10\r\n\r\n").getBytes(StandardCharsets.US_ASCII));socket.getOutputStream().flush();
            String status;try{status=new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream())).readLine();}catch(java.net.SocketTimeoutException absent){status="NO_DEADLINE_RESPONSE";}
            assertThat(status).contains(" 408 ");
        }
        assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);
    }
    @Test void requestHeaderBytesShareTheBoundBeforeNode()throws Exception {
        var f=fixture();var grant=grant(f,mock(f));policy(f,false,java.util.Map.of("maxMockRequestBytes",1024));
        var response=http.send(java.net.http.HttpRequest.newBuilder(URI.create(grant.path("baseUrl").asText()+"/items/item-7")).timeout(java.time.Duration.ofSeconds(3)).header("X-Apicc-Mock-Key",grant.path("key").asText()).header("X-Business","x".repeat(1025)).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(413);
    }
    @Test void projectCapacityRejectsBeforeReadingBody()throws Exception {
        var f=fixture();var grant=grant(f,mock(f,"slow"));policy(f,false,java.util.Map.of("mockInFlight",1));
        int index=node.records(http,json).path("calls").size();
        try(var socket=new Socket("127.0.0.1",PUBLIC_PORT)){
            socket.getOutputStream().write(("GET /mock/"+grant.path("publicId").asText()+"/items/item-7 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Apicc-Mock-Key: "+grant.path("key").asText()+"\r\nX-Business: present\r\n\r\n").getBytes(StandardCharsets.US_ASCII));socket.getOutputStream().flush();
            waitFor(()->node.records(http,json).path("calls").size()>index);
            try(var blocked=new Socket("127.0.0.1",PUBLIC_PORT)){
                blocked.setSoTimeout(250);blocked.getOutputStream().write(("POST /mock/"+grant.path("publicId").asText()+"/items/item-7 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Apicc-Mock-Key: "+grant.path("key").asText()+"\r\nContent-Length: 100000\r\n\r\n").getBytes(StandardCharsets.US_ASCII));blocked.getOutputStream().flush();
                String status;try{status=new java.io.BufferedReader(new java.io.InputStreamReader(blocked.getInputStream())).readLine();}catch(java.net.SocketTimeoutException absent){status="NO_ADMISSION_RESPONSE";}
                assertThat(status).as("capacity must be rejected before waiting on unread body").contains(" 429 ");
            }
        }
    }
    @Test void realCallerDisconnectCancelsReachedNodeDelay()throws Exception {
        var f=fixture();var grant=grant(f,mock(f,"slow"));int index=node.records(http,json).path("calls").size();
        try(var socket=new Socket("127.0.0.1",PUBLIC_PORT)){
            socket.getOutputStream().write(("GET /mock/"+grant.path("publicId").asText()+"/items/item-7 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Apicc-Mock-Key: "+grant.path("key").asText()+"\r\nX-Business: present\r\n\r\n").getBytes(StandardCharsets.US_ASCII));socket.getOutputStream().flush();
            waitFor(()->node.records(http,json).path("calls").size()>index);
        }
        long deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(500);boolean cancelled=false;while(System.nanoTime()<deadline){cancelled=node.records(http,json).path("calls").get(index).path("cancelled").asBoolean();if(cancelled)break;Thread.sleep(10);}
        assertThat(cancelled).as("caller FIN reaches real Node AbortSignal during configured 1200ms delay").isTrue();
        assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);
    }
    @Test void boundedBodyRejectsBeforeNode()throws Exception {
        var f=fixture();var grant=grant(f,mock(f,"slow"));policy(f,false,java.util.Map.of("maxMockRequestBytes",1024));
        var response=http.send(java.net.http.HttpRequest.newBuilder(URI.create(grant.path("baseUrl").asText()+"/items/item-7")).timeout(java.time.Duration.ofSeconds(4)).header("X-Apicc-Mock-Key",grant.path("key").asText()).POST(java.net.http.HttpRequest.BodyPublishers.ofString("x".repeat(1025))).build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(413);
    }
    /** Characterizes the existing dependency before changing the public listener transport. */
    @Test void existingAsyncTransportNotifiesRealGetDisconnectWhileResponseHasNotStarted()throws Exception {
        var reached=new CountDownLatch(1);var failed=new CountDownLatch(1);var released=new CountDownLatch(1);var failures=new AtomicInteger();
        var server=AsyncServerBootstrap.bootstrap().setIOSessionDecorator(com.autumnharvestc.server.collaboration.publicapi.DisconnectSession::new).setRequestRouter((incoming,routeContext)->()->new AsyncServerExchangeHandler(){
            @Override public void handleRequest(HttpRequest request,EntityDetails entity,ResponseChannel channel,HttpContext context){reached.countDown();}
            @Override public void updateCapacity(CapacityChannel channel)throws java.io.IOException{channel.update(1024);}
            @Override public void consume(ByteBuffer bytes){bytes.position(bytes.limit());}
            @Override public void streamEnd(List<? extends Header> trailers){}
            @Override public int available(){return 0;}
            @Override public void produce(DataStreamChannel channel){}
            @Override public void failed(Exception error){failures.incrementAndGet();failed.countDown();}
            @Override public void releaseResources(){released.countDown();}
        }).create();
        try{
            server.start();var endpoint=server.listen(new InetSocketAddress("127.0.0.1",0),URIScheme.HTTP).get(3,TimeUnit.SECONDS);
            try(var socket=new Socket()){
                socket.connect(endpoint.getAddress());socket.getOutputStream().write("GET /mock/owned/items HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".getBytes(StandardCharsets.US_ASCII));socket.getOutputStream().flush();
                assertThat(reached.await(2,TimeUnit.SECONDS)).isTrue();assertThat(failures.get()).isZero();
            }
            assertThat(failed.await(2,TimeUnit.SECONDS)).as("real disconnect before any response reaches failed").isTrue();
            assertThat(released.await(2,TimeUnit.SECONDS)).as("exchange cleanup follows actual connection failure").isTrue();
        }finally{server.close(CloseMode.IMMEDIATE);}
    }
}
