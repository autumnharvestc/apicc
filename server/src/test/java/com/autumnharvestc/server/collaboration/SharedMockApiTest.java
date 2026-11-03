package com.autumnharvestc.server.collaboration;

import com.autumnharvestc.server.collaboration.publicapi.PublicListener;
import com.autumnharvestc.server.collaboration.runtime.*;
import com.fasterxml.jackson.databind.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.*;
import org.springframework.test.context.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-t8-api;DB_CLOSE_DELAY=-1", "server.address=127.0.0.1", "apicc.collaboration.policy.defaults.external-sharing-allowed=true", "apicc.collaboration.policy.defaults.shared-mock-allowed=true", "apicc.collaboration.public-access.enabled=true"})
@Import(SharedMockApiTest.RealRuntime.class)
class SharedMockApiTest extends SharedMockFixture {
    static final int PUBLIC_PORT=port();
    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties){properties.add("apicc.collaboration.public-access.port",()->PUBLIC_PORT);properties.add("apicc.collaboration.public-access.base-url",()->"http://127.0.0.1:"+PUBLIC_PORT);}
    @org.springframework.boot.test.context.TestConfiguration(proxyBeanMethods=false)
    static class RealRuntime {
        @Bean NodeFixture nodeFixture()throws Exception{return new NodeFixture();}
        @Bean @Primary CollaborationRuntimeClient realMockClient(NodeFixture node,RuntimeProtocol protocol,ObjectMapper json)throws Exception {
            var properties=new RuntimeProperties();properties.setEnabled(true);properties.setBaseUrl(node.info.path("rpc").asText());properties.setSecretFile(node.secret.toString());return new CollaborationRuntimeClient(properties,protocol,json);
        }
    }
    static class NodeFixture implements AutoCloseable {
        Process process;JsonNode info;final Path secret;final Path root,phase;
        NodeFixture()throws Exception {
            Path directory=Path.of("").toAbsolutePath();if(directory.endsWith("server"))directory=directory.getParent();root=directory;
            phase=root.resolve(".superpowers/sdd/2026-11-01-apicc-f7f-collaboration");Files.createDirectories(phase);
            secret=Files.createTempFile(phase,"task8-synthetic-", ".secret");Files.writeString(secret,"synthetic-t8-private-rpc-0123456789abcdef");
            start(0);
        }
        void start(int port)throws Exception{String executable=System.getenv().getOrDefault("APICC_TEST_NODE","node");process=new ProcessBuilder(executable,"--experimental-transform-types",root.resolve("server/src/test/resources/shared-mock-process.mjs").toString(),String.valueOf(port)).directory(root.toFile()).redirectError(phase.resolve("task8-node-"+UUID.randomUUID()+".log").toFile()).start();var child=process;try{String line=java.util.concurrent.CompletableFuture.supplyAsync(()->{try{return child.inputReader().readLine();}catch(java.io.IOException e){throw new RuntimeException(e);}}).get(10,java.util.concurrent.TimeUnit.SECONDS);if(line==null)throw new IllegalStateException("Owned real Node fixture requires Node22+, Core/runtime builds; inspect phase stderr");info=new ObjectMapper().readTree(line);}catch(Exception failure){child.destroyForcibly().waitFor();throw failure;}}
        void restart()throws Exception{int port=URI.create(info.path("rpc").asText()).getPort();process.destroyForcibly().waitFor();start(port);}
        JsonNode records(HttpClient http,ObjectMapper json)throws Exception{return json.readTree(http.send(HttpRequest.newBuilder(URI.create(info.path("info").asText())).GET().build(),HttpResponse.BodyHandlers.ofString()).body());}
        @Override public void close()throws Exception {process.getOutputStream().close();if(!process.waitFor(5,java.util.concurrent.TimeUnit.SECONDS)){process.destroy();if(!process.waitFor(2,java.util.concurrent.TimeUnit.SECONDS))process.destroyForcibly().waitFor();}}
    }
    @Test void sameSavedRulesProduceTwoRealHttpResponsesAndNoControlHeadersReachNode()throws Exception {
        var f=fixture();var publication=mock(f);var grant=grant(f,publication);int before=node.records(http,json).path("calls").size();
        var local=http.send(HttpRequest.newBuilder(URI.create(node.info.path("local").asText()+"/items/item-7?q=A&q=B")).header("X-Business","present").GET().build(),HttpResponse.BodyHandlers.ofString());
        assertThat(local.statusCode()).isEqualTo(200);assertThat(local.body()).isEqualTo("{\"id\":\"item-7\"}");
        var shared=http.send(HttpRequest.newBuilder(URI.create(grant.path("baseUrl").asText()+"/items/item-7?q=A&q=B")).header("X-Apicc-Mock-Key",grant.path("key").asText()).header("Authorization","Bearer synthetic-private-member").header("Cookie","synthetic-private-cookie").header("Proxy-Authorization","synthetic-private-proxy").header("X-Apicc-Agent-Key","synthetic-private-control").header("X-Business","present").GET().build(),HttpResponse.BodyHandlers.ofString());
        assertThat(shared.statusCode()).isEqualTo(local.statusCode());assertThat(shared.body()).isEqualTo(local.body());
        assertThat(shared.headers().firstValue("Content-Type")).isEqualTo(local.headers().firstValue("Content-Type"));
        assertThat(shared.headers().firstValue("X-Mock-Fixture")).isEqualTo(Optional.of("fixed"));
        var records=node.records(http,json);var recorded=records.path("calls").get(before);assertThat(recorded.path("target").asText()).isEqualTo("/items/item-7?q=A&q=B");
        var names=new HashSet<String>();recorded.path("headers").fieldNames().forEachRemaining(names::add);
        assertThat(names).doesNotContain("authorization","cookie","proxy-authorization","x-apicc-mock-key","x-apicc-agent-key");assertThat(recorded.at("/headers/x-business").asText()).isEqualTo("present");
        assertThat(records.at("/logs/0/ruleId").asText()).isEqualTo("10000000-0000-4000-8000-000000000015");
        assertThat(recorded.path("ruleId")).isEqualTo(records.at("/logs/0/ruleId"));
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"CONNECT /items/item-7","GET //absolute.invalid/path","GET /items/..","GET /items/%2e%2e","GET /items/a%2fb"})
    void rejectsNonBusinessTargetsAfterValidAdmission(String methodTarget)throws Exception {
        var f=fixture();var grant=grant(f,mock(f));assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);
        String[] parts=methodTarget.split(" ",2);String target="/mock/"+grant.path("publicId").asText()+parts[1];
        try(var socket=new java.net.Socket("127.0.0.1",PUBLIC_PORT)){
            socket.setSoTimeout(3000);socket.getOutputStream().write((parts[0]+" "+target+" HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Apicc-Mock-Key: "+grant.path("key").asText()+"\r\nX-Business: present\r\nConnection: close\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII));socket.getOutputStream().flush();
            assertThat(new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream())).readLine()).contains(" 400 ");
        }
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"Authorization","Cookie","Proxy-Authorization","X-Apicc-Mock-Key","Set-Cookie","Location","Content-Length","Access-Control-Allow-Origin","Content-Security-Policy"})
    void realSavedSourcePreviewRejectsForbiddenDependenciesAndExcludedResponseNames(String name)throws Exception {
        var f=fixture();mock(f);var files=new ArrayList<Map<String,String>>();for(var file:node.info.path("forbidden").path(name))files.add(Map.of("path",file.path("path").asText(),"content",file.path("content").asText()));
        var saved=save(f.owner(),f.workspace(),f.project(),"2",files);
        request(f.owner().token(),post(collaboration(f)+"/previews"),Map.of("title","Forbidden dependency","includeEvidence",false,"source",Map.of("kind","mock","revision",saved.path("version").asText(),"manifestHash",saved.path("manifestHash").asText(),"scope",Map.of("kind","project")))).andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("mock_compile_failed"));
    }
}

abstract class SharedMockFixture extends CollaborationApiFixture {
    @Autowired SharedMockApiTest.NodeFixture node;
    @Autowired PublicListener listener;
    final HttpClient http=HttpClient.newHttpClient();
    HttpResponse<String> call(JsonNode grant,String target)throws Exception{return http.send(HttpRequest.newBuilder(URI.create(grant.path("baseUrl").asText()+target)).timeout(java.time.Duration.ofSeconds(4)).header("X-Apicc-Mock-Key",grant.path("key").asText()).header("X-Business","present").GET().build(),HttpResponse.BodyHandlers.ofString());}
    static int port(){try(var socket=new java.net.ServerSocket(0,0,InetAddress.getLoopbackAddress())){return socket.getLocalPort();}catch(Exception e){throw new IllegalStateException(e);}}
    String collaboration(Fixture f){return f.url()+"/collaboration";}
    void policy(Fixture f,boolean workspace,Map<String,?> settings)throws Exception {String path="/api/v1/workspaces/"+f.workspace()+(workspace?"":"/projects/"+f.project())+"/collaboration/policy";long revision=body(mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();request(f.owner().token(),put(path),Map.of("expectedRevision",revision,"settings",settings)).andExpect(status().isOk());}
    JsonNode mock(Fixture f)throws Exception {return mock(f,"files");}
    JsonNode mock(Fixture f,String variant)throws Exception {
        var files=new ArrayList<Map<String,String>>();for(var file:node.info.path(variant))files.add(Map.of("path",file.path("path").asText(),"content",file.path("content").asText()));
        var saved=save(f.owner(),f.workspace(),f.project(),"1",files);
        policy(f,true,Map.of("sharedMockAllowed",true,"externalSharingAllowed",true));policy(f,false,Map.of("sharedMockAllowed",true,"externalSharingAllowed",true));
        var source=Map.of("kind","mock","revision",saved.path("version").asText(),"manifestHash",saved.path("manifestHash").asText(),"scope",Map.of("kind","project"));
        var preview=body(request(f.owner().token(),post(collaboration(f)+"/previews"),Map.of("title","T8 fixed Mock","includeEvidence",false,"source",source)).andExpect(status().isCreated()));
        var published=body(request(f.owner().token(),post(collaboration(f)+"/publications"),Map.of("publicationIntentId",UUID.randomUUID().toString(),"previewId",preview.path("id").asText(),"candidateDigest",preview.path("candidateDigest").asText(),"expectedPolicyRevision",preview.path("expectedPolicyRevision").asLong())).andExpect(status().isCreated()));
        assertThat(published.path("enabled").asBoolean(true)).isFalse();
        return body(request(f.owner().token(),patch(collaboration(f)+"/publications/"+published.path("id").asText()),Map.of("expectedRevision",1,"enabled",true)).andExpect(status().isOk()));
    }
    JsonNode grant(Fixture f,JsonNode publication)throws Exception{return body(request(f.owner().token(),post(collaboration(f)+"/publications/"+publication.path("id").asText()+"/grants"),Map.of("operationIntent",UUID.randomUUID().toString(),"purpose","call","audience","external","expectedRevision",publication.path("revision").asLong())).andExpect(status().isCreated()));}
    void waitFor(java.util.concurrent.Callable<Boolean> condition)throws Exception{long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(3);while(!condition.call()&&System.nanoTime()<deadline)Thread.sleep(10);assertThat(condition.call()).as("bounded real-process observation reached").isTrue();}
    void capability(Fixture f,Actor actor,String code,String mode)throws Exception{String path=f.url()+"/access-members/"+actor.id();long revision=body(mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();request(f.owner().token(),put(path),Map.of("expectedRevision",revision,"capabilities",Map.of(code,mode))).andExpect(status().isOk());}
}
