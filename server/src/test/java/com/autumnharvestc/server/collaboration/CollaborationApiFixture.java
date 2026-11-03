package com.autumnharvestc.server.collaboration;

import com.autumnharvestc.server.core.Hashes;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import com.autumnharvestc.server.collaboration.artifacts.SourceSnapshotReader;
import com.autumnharvestc.server.collaboration.runtime.RuntimeProtocol;
import com.fasterxml.jackson.databind.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.*;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Synthetic real HTTP sources; no target requests, Node build, or persisted source logging. */
@SpringBootTest
@AutoConfigureMockMvc(print=MockMvcPrint.NONE)
@TestPropertySource(properties={
    "spring.datasource.url=jdbc:h2:mem:apicc-collaboration-t6;DB_CLOSE_DELAY=-1",
    "apicc.server.allow-registration=true", "apicc.server.admin-username=admin",
    "apicc.server.admin-password=admin-pass-2026",
    "apicc.execution.control-base-url=https://control.test/api/v1"
})
abstract class CollaborationApiFixture {
    static final String CONTRACT="10000000-0000-4000-8000-000000000001";
    static final String BUILD="a".repeat(64);
    static final String EMPTY="4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
    static final String SCRIPT="afaf628a48532cff1e1e9264f328830ea1678b877853e324bab040039d0721d0";
    static final String RUNTIME="node-22.19.0-v8-12.4.254.21-node.29-script-"+SCRIPT;
    static final long SOURCE_LIMIT=16*1024*1024;
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepo users;
    @Autowired SourceSnapshotReader sources;
    @Autowired RuntimeProtocol protocol;
    record Actor(String id,String token,UserAccount account) {}
    record Fixture(Actor owner,Actor editor,Actor viewer,String workspace,String group,String project,String other,
                   JsonNode assets,String job,String execution,byte[] report,String agent,String agentToken) {
        String url(){return "/api/v1/workspaces/"+workspace+"/projects/"+project;}
    }
    JsonNode body(ResultActions result)throws Exception{return json.readTree(result.andReturn().getResponse().getContentAsByteArray());}
    ResultActions request(String token,MockHttpServletRequestBuilder request,Object value)throws Exception {
        return mvc.perform(request.header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsBytes(value)));
    }
    Actor actor()throws Exception {
        String name="t6-"+UUID.randomUUID().toString().substring(0,16);
        String id=body(mvc.perform(post("/api/v1/auth/register").contentType("application/json")
            .content(json.writeValueAsBytes(Map.of("username",name,"displayName",name,"password","password123")))).andExpect(status().isCreated())).path("id").asText();
        String token=login(name,"password123");return new Actor(id,token,users.findById(Long.valueOf(id)).orElseThrow());
    }
    String login(String name,String password)throws Exception {
        return body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsBytes(Map.of("username",name,"password",password)))).andExpect(status().isOk())).path("token").asText();
    }
    String project(Actor owner,String ws,String group)throws Exception {
        return body(request(owner.token(),post("/api/v1/workspaces/"+ws+"/projects"),Map.of("name","same readable project name","groupId",group)).andExpect(status().isCreated())).path("id").asText();
    }
    JsonNode save(Actor owner,String ws,String project,String version,List<Map<String,String>> files)throws Exception {
        return body(request(owner.token(),put("/api/v1/workspaces/"+ws+"/projects/"+project+"/assets"),
            Map.of("format","contract-files-v1","contractProjectId",CONTRACT,"expectedVersion",version,"changes",files,"deletes",List.of())).andExpect(status().isOk()));
    }
    Fixture fixture()throws Exception {
        return fixture(0);
    }
    Fixture fixture(int reportBytes)throws Exception {
        return fixture(reportBytes,false);
    }
    Fixture fixtureWithPermit()throws Exception{return fixture(0,true);}
    Fixture fixture(int reportBytes,boolean permit)throws Exception {
        Actor owner=actor(),editor=actor(),viewer=actor();
        String ws=body(request(owner.token(),post("/api/v1/workspaces"),Map.of("name","T6 fixed sources "+owner.id())).andExpect(status().isCreated())).path("id").asText();
        String group=body(request(owner.token(),post("/api/v1/workspaces/"+ws+"/groups"),Map.of("name","Sources")).andExpect(status().isCreated())).path("id").asText();
        for(var member:List.of(Map.entry(editor,"EDITOR"),Map.entry(viewer,"VIEWER")))
            request(owner.token(),put("/api/v1/workspaces/"+ws+"/members/"+member.getKey().id()),Map.of("role",member.getValue(),"expectedRevision",0)).andExpect(status().isOk());
        String project=project(owner,ws,group),other=project(owner,ws,group);
        var files=new ArrayList<Map<String,String>>();
        try(var stream=getClass().getResourceAsStream("/asset-mutation-fixtures.json")) {
            for(var file:json.readTree(stream).path("beforeFiles"))files.add(Map.of("path",file.path("path").asText(),"content",file.path("content").asText()));
        }
        JsonNode assets=save(owner,ws,project,"0",files);save(owner,ws,other,"0",files);
        String url="/api/v1/workspaces/"+ws+"/projects/"+project;
        String snapshot=body(request(owner.token(),post(url+"/execution-snapshots"),Map.of("expectedVersion","1")).andExpect(status().isCreated())).path("snapshotId").asText();
        String platform=login("admin","admin-pass-2026");
        String agent=body(request(platform,post("/api/v1/agents"),Map.of("name","T6 synthetic archive")).andExpect(status().isCreated())).path("id").asText();
        request(platform,put("/api/v1/agents/"+agent+"/workspace-grants"),Map.of("workspaceIds",List.of(ws))).andExpect(status().isOk());
        request(owner.token(),put("/api/v1/workspaces/"+ws+"/agent-project-allocations"),Map.of("agentId",agent,"projectIds",List.of(project))).andExpect(status().isOk());
        request(owner.token(),put(url+"/execution-settings"),Map.of("expectedVersion","0","agentIds",List.of(agent),"defaultAgentId",agent,"policy",Map.of())).andExpect(status().isOk());
        String enrollment=body(request(platform,post("/api/v1/agents/"+agent+"/enrollments"),Map.of()).andExpect(status().isCreated())).path("enrollmentToken").asText();
        String agentToken=body(mvc.perform(post("/api/v1/runner/enroll").contentType("application/json").content(json.writeValueAsBytes(Map.of("enrollmentToken",enrollment)))).andExpect(status().isCreated())).path("agentToken").asText();
        var runtime=new LinkedHashMap<String,Object>();runtime.put("protocolVersion",1);runtime.put("sessionId","t6-session");runtime.put("coreBuildId",BUILD);runtime.put("scriptApiId",SCRIPT);runtime.put("nodeVersion","22.19.0");runtime.put("v8Version","12.4.254.21-node.29");runtime.put("runtimeCompatibilityId",RUNTIME);runtime.put("capabilities",List.of("task:suite","protocol:http","script:trusted-core"));
        runtime.put("configuration",Map.of("configVersion","0","appliedConfigVersion","0","pendingFields",List.of(),"restartRequiredFields",List.of(),"status","applied"));
        request(agentToken,post("/api/v1/runner/runtime"),runtime).andExpect(status().isOk());
        var preparation=new LinkedHashMap<String,Object>();preparation.put("scope",Map.of("workspaceId",ws,"groupId",group,"projectId",project));preparation.put("manifestHash",assets.path("manifestHash").asText());preparation.put("scriptPlanDigest",EMPTY);preparation.put("scriptRequirements",List.of());preparation.put("executionProfile","no-script");preparation.put("dispatchKind","dedicated-task");preparation.put("requiredCoreBuildId",BUILD);preparation.put("requiredCapabilities",List.of("task:suite","protocol:http"));preparation.put("runtimeCompatibilityId",RUNTIME);
        var submission=Map.of("intentId",UUID.randomUUID().toString(),"agentId",agent,"snapshotId",snapshot,"target",Map.of("kind","suite","suiteId",CONTRACT,"allowDraft",false),"runConfig",Map.of("jobTimeoutMs",60000),"materials",Map.of("projectId",project,"credentials",List.of(),"attachments",List.of()),"preparation",preparation);
        JsonNode created=body(request(owner.token(),post(url+"/jobs"),submission).andExpect(status().isCreated()));
        String job=created.path("jobId").asText(),execution=created.path("executionId").asText();
        request(agentToken,post("/api/v1/runner/heartbeat"),Map.of("sessionId","t6-session","appliedConfigVersion","0","availableSlots",1,"availableSharedDebugSlots",0,"acknowledgements",List.of())).andExpect(status().isOk());
        if(permit){
            request(agentToken,post("/api/v1/runner/messages"),List.of(Map.of("jobId",job,"executionId",execution,"kind","accepted","messageId","t6-accepted-"+job))).andExpect(status().isOk());
            var start=new LinkedHashMap<String,Object>();start.put("jobId",job);start.put("executionId",execution);start.put("kind","start-request");start.put("messageId","t6-start-"+job);start.put("inputsDigest",jdbc.queryForObject("SELECT inputs_digest FROM execution_jobs WHERE id=?",String.class,Long.parseLong(job)));start.put("policyVersion",jdbc.queryForObject("SELECT version FROM execution_policy_revision WHERE id=1",String.class));start.put("scriptPlanDigest",EMPTY);start.put("scriptRequirements",List.of());start.put("executionProfile","no-script");start.put("runtimeCompatibilityId",RUNTIME);start.put("credentialVersions",Map.of());
            request(agentToken,post("/api/v1/runner/messages"),List.of(start)).andExpect(status().isOk());assertThat(jdbc.queryForObject("SELECT permit_id FROM execution_jobs WHERE id=?",Long.class,Long.parseLong(job))).as("actual durable start permit prerequisite").isPositive();
        }
        var reportValue=json.valueToTree(Map.of("kind","suite","collectionId",CONTRACT,"collectionName","Synthetic report","startedAt","2026-11-01T00:00:00Z","finishedAt","2026-11-01T00:00:01Z","total",0,"passed",0,"failed",0,"skipped",0,"cases",List.of()));
        if(reportBytes>0) {
            int padding=reportBytes-json.writeValueAsBytes(reportValue).length;
            if(padding<0)throw new IllegalArgumentException("Test report size must contain the valid report");
            ((com.fasterxml.jackson.databind.node.ObjectNode)reportValue).put("collectionName","Synthetic report"+"x".repeat(padding));
        }
        byte[] report=json.writeValueAsBytes(reportValue);
        if(reportBytes>0)assertThat(report.length).isEqualTo(reportBytes);
        // Actual existing completion and archive protocol; no direct INSERT/archive shortcut.
        var completed=new LinkedHashMap<String,Object>();completed.put("jobId",job);completed.put("executionId",execution);completed.put("messageId","t6-completed-"+job);completed.put("kind","completed");completed.put("verdict","interrupted");completed.put("finishedAt","2026-11-01T00:00:01Z");completed.put("executionReleased",true);completed.put("evidenceComplete",true);completed.put("reportHash",Hashes.sha256Hex(report));completed.put("reportBytes",report.length);
        request(agentToken,post("/api/v1/runner/messages"),List.of(completed)).andExpect(status().isOk());
        mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").header("Authorization","Bearer "+agentToken).param("executionId",execution).header("X-Report-Hash",Hashes.sha256Hex(report)).contentType("application/octet-stream").content(report)).andExpect(status().isOk()).andExpect(jsonPath("$.archived").value(true));
        // Checked-in generated T3/T4 schema establishes a valid projection payload without Node/dist.
        var payload=json.createObjectNode();var input=payload.putObject("input");input.put("sourceKind","server-archive").put("title","Synthetic report").put("redaction","unavailable");input.putObject("source").put("revision",execution).put("digest",Hashes.sha256Hex(report));input.putArray("privateMarkers");input.putObject("report").put("format","run").set("body",json.readTree(report));
        var policy=payload.putObject("policy");policy.put("revision",1).put("includeEvidence",false).put("maxFieldBytes",8192).put("maxEvidenceBytes",1048576).put("maxArtifactBytes",8388608);for(String key:List.of("extraSensitiveHeaders","extraSensitiveQuery","extraSensitiveFields","extraSensitivePointers"))policy.putArray(key);
        var wire=json.createObjectNode().put("protocolVersion",1).put("operation","project-report").put("requestId","t6-prerequisite").put("inputDigest",RuntimeProtocol.digestJson(payload)).put("deadlineEpochMs",4000000000000L).put("outputBudgetBytes",33554432);wire.set("payload",payload);
        assertThat(protocol.validRequest(wire)).as("real archived source has a valid strict projection wire shape").isTrue();
        return new Fixture(owner,editor,viewer,ws,group,project,other,assets,job,execution,report,agent,agentToken);
    }
}

/** Real HTTP transport is doubled only at the slow private Core RPC boundary. */
@org.springframework.context.annotation.Import(ArtifactHttpFixture.Configuration.class)
abstract class ArtifactHttpFixture extends CollaborationApiFixture {
    @org.springframework.boot.test.context.TestConfiguration(proxyBeanMethods=false)
    static class Configuration {
        @org.springframework.context.annotation.Bean @org.springframework.context.annotation.Primary MutableTime artifactTestTime(){return new MutableTime();}
        @org.springframework.context.annotation.Bean FixtureRpc artifactTestRpc(ObjectMapper json,RuntimeProtocol protocol)throws Exception{return new FixtureRpc(json,protocol);}
        @org.springframework.context.annotation.Bean @org.springframework.context.annotation.Primary
        com.autumnharvestc.server.collaboration.runtime.CollaborationRuntimeClient artifactTestClient(FixtureRpc rpc,ObjectMapper json,RuntimeProtocol protocol)throws Exception {
            var properties=new com.autumnharvestc.server.collaboration.runtime.RuntimeProperties();properties.setEnabled(true);properties.setBaseUrl(rpc.origin());properties.setSecretFile(rpc.secretFile.toString());
            return new com.autumnharvestc.server.collaboration.runtime.CollaborationRuntimeClient(properties,protocol,json);
        }
    }
    static class MutableTime extends com.autumnharvestc.server.collaboration.artifacts.CollaborationTime {
        final java.util.concurrent.atomic.AtomicReference<java.time.Instant> value=new java.util.concurrent.atomic.AtomicReference<>(java.time.Instant.now());
        @Override public java.time.Instant now(){return value.get();}
        void advance(long milliseconds){value.updateAndGet(instant->instant.plusMillis(milliseconds));}
        void reset(){value.set(java.time.Instant.now());}
    }
    static class FixtureRpc implements AutoCloseable {
        final ObjectMapper json;final RuntimeProtocol protocol;final com.sun.net.httpserver.HttpServer server;
        final java.util.concurrent.ExecutorService executor=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor();
        final java.nio.file.Path secretFile;final List<JsonNode> requests=new java.util.concurrent.CopyOnWriteArrayList<>();
        volatile java.util.concurrent.CountDownLatch entered,release;volatile Runnable responseAction=()->{};volatile boolean unavailable,mockDiagnostics,mockDeadlineDiagnostic;volatile int mockDelay;volatile String mismatch="";
        FixtureRpc(ObjectMapper json,RuntimeProtocol protocol)throws Exception {
            this.json=json;this.protocol=protocol;var directory=java.nio.file.Path.of("target","t6-http-fixture");java.nio.file.Files.createDirectories(directory);
            secretFile=java.nio.file.Files.createTempFile(directory,"rpc-",".secret");java.nio.file.Files.writeString(secretFile,UUID.randomUUID().toString()+UUID.randomUUID());
            server=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);server.setExecutor(executor);
            server.createContext("/rpc",exchange->{try{respond(exchange);}catch(Exception problem){throw new RuntimeException("Synthetic RPC fixture failed",problem);}finally{exchange.close();}});server.start();
        }
        String origin(){return "http://127.0.0.1:"+server.getAddress().getPort();}
        void reset(){requests.clear();entered=null;release=null;responseAction=()->{};unavailable=false;mockDiagnostics=false;mockDeadlineDiagnostic=false;mockDelay=0;mismatch="";}
        void block(){entered=new java.util.concurrent.CountDownLatch(1);release=new java.util.concurrent.CountDownLatch(1);}
        void respond(com.sun.net.httpserver.HttpExchange exchange)throws Exception {
            var request=json.readTree(exchange.getRequestBody());if(!protocol.validRequest(request))throw new IllegalStateException("Fixture received nonstrict input");requests.add(request.deepCopy());
            var signal=entered;var wait=release;if(signal!=null){signal.countDown();if(!wait.await(10,java.util.concurrent.TimeUnit.SECONDS))throw new IllegalStateException("Fixture HTTP barrier timed out");}
            responseAction.run();
            if(unavailable){byte[] bytes=json.writeValueAsBytes(Map.of("code","RPC_UNAVAILABLE","requestId",request.path("requestId").asText(),"retryable",false));exchange.sendResponseHeaders(503,bytes.length);exchange.getResponseBody().write(bytes);return;}
            var input=request.at("/payload/input");boolean document=request.path("operation").asText().equals("project-document");
            var artifact=json.createObjectNode().put("formatVersion",1).put("kind",document?"document":"report").put("title",input.path("title").asText());
            artifact.putObject("source").put("trust",document?"saved-contract":"server-archive").put("revision",input.at("/source/revision").asText()).put("digest",input.at("/source/digest").asText());artifact.putArray("summary");artifact.putArray("limitations");
            if(document){var view=artifact.putObject("document");view.putArray("apis");view.putArray("models");view.putArray("components");}
            else{var report=artifact.putObject("report").put("sourceCategory","run").put("startedAt",input.at("/report/body/startedAt").asText()).put("finishedAt",input.at("/report/body/finishedAt").asText()).put("verdict","unknown");for(String name:List.of("counts","failures","nodes","trace","evidence"))report.putArray(name);}
            if(!mismatch.isEmpty()){
                var source=(com.fasterxml.jackson.databind.node.ObjectNode)artifact.path("source");
                switch(mismatch){case "trust"->source.put("trust","member-claim");case "revision"->source.put("revision","different-revision");case "digest"->source.put("digest","b".repeat(64));case "kind"->{artifact.put("kind","debug-history");artifact.remove("document");var report=artifact.putObject("report").put("sourceCategory","debug").put("startedAt","2026-11-01T00:00:00Z").put("finishedAt","2026-11-01T00:00:01Z").put("verdict","unknown");for(String name:List.of("counts","failures","nodes","trace","evidence"))report.putArray(name);}}
            }
            JsonNode output=artifact;
            if(input.path("sourceKind").asText().equals("member-upload")){var member=(com.fasterxml.jackson.databind.node.ObjectNode)input.path("artifact").deepCopy();member.put("title","SECOND_PROJECTION");if(!request.at("/payload/policy/includeEvidence").asBoolean())((com.fasterxml.jackson.databind.node.ObjectNode)member.path("report")).putArray("evidence");output=member;}
            if(request.path("operation").asText().equals("compile-mock")){
                var result=json.createObjectNode().put("ok",!mockDiagnostics&&!mockDeadlineDiagnostic);if(mockDiagnostics||mockDeadlineDiagnostic)result.putArray("diagnostics").addObject().put("severity","error").put("code",mockDeadlineDiagnostic?"SHARED_MOCK_DEADLINE_INVALID":"MOCK_RESPONSE_HEADER_FORBIDDEN").put("path","rules/0").put("message","Synthetic located refusal").put("lossy",false);
                else{var plan=result.putObject("plan").put("sourceProjectRevision","opaque-core-plan-identity");var route=plan.putArray("routes").addObject().put("contractId",CONTRACT).put("method","GET").put("pathTemplate","/synthetic");route.putArray("segments").addObject().put("kind","literal").put("value","synthetic");var rule=route.putArray("rules").addObject().put("id","synthetic-rule").put("contractId",CONTRACT).put("responseBindingId","synthetic-response").put("status",200).put("mediaType","application/json").put("delayMs",mockDelay);rule.putArray("conditions");rule.putObject("headers");rule.putArray("body").add(123).add(125);}output=result;
            }
            var response=(com.fasterxml.jackson.databind.node.ObjectNode)request.deepCopy();response.set("payload",output);response.put("coreBuildIdentity",protocol.coreBuildIdentity()).put("outputDigest",RuntimeProtocol.digestJson(output)).put("outputBytes",json.writeValueAsBytes(output).length).put("wireBytes",1);
            byte[] bytes=json.writeValueAsBytes(response);while(response.path("wireBytes").asInt()!=bytes.length){response.put("wireBytes",bytes.length);bytes=json.writeValueAsBytes(response);}
            if(!protocol.validResponse(response))throw new IllegalStateException("Fixture response must be strict generated DTO");exchange.sendResponseHeaders(200,bytes.length);exchange.getResponseBody().write(bytes);
        }
        @Override public void close()throws Exception{server.stop(0);executor.close();java.nio.file.Files.deleteIfExists(secretFile);}
    }
    @Autowired FixtureRpc rpc;
    @Autowired MutableTime artifactTime;
    @org.junit.jupiter.api.BeforeEach void resetArtifactHttp(){rpc.reset();artifactTime.reset();}
    String collaboration(Fixture f){return f.url()+"/collaboration";}
    com.fasterxml.jackson.databind.node.ObjectNode documentRequest(Fixture f){
        var request=json.createObjectNode().put("title","Synthetic fixed document").put("includeEvidence",false);var source=request.putObject("source").put("kind","document").put("revision","1").put("manifestHash",f.assets().path("manifestHash").asText());source.putObject("scope").put("kind","project");return request;
    }
    com.fasterxml.jackson.databind.node.ObjectNode reportRequest(Fixture f){var request=json.createObjectNode().put("title","Synthetic fixed report").put("includeEvidence",false);request.putObject("source").put("kind","server-report").put("jobId",f.job());return request;}
    JsonNode preview(Fixture f,Actor actor,JsonNode input)throws Exception{return body(request(actor.token(),post(collaboration(f)+"/previews"),input).andExpect(status().isCreated()));}
    com.fasterxml.jackson.databind.node.ObjectNode confirmation(JsonNode preview,String intent){return json.createObjectNode().put("publicationIntentId",intent).put("previewId",preview.path("id").asText()).put("candidateDigest",preview.path("candidateDigest").asText()).put("expectedPolicyRevision",preview.path("expectedPolicyRevision").asLong());}
    JsonNode publish(Fixture f,JsonNode preview,String intent)throws Exception{return body(request(f.owner().token(),post(collaboration(f)+"/publications"),confirmation(preview,intent)).andExpect(status().isCreated()));}
    JsonNode publication(Fixture f,Actor actor,String id)throws Exception{return body(mvc.perform(get(collaboration(f)+"/publications/"+id).header("Authorization","Bearer "+actor.token())).andExpect(status().isOk()));}
    long publicationCount(Fixture f){return jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_publications WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()));}
    long previewCount(Fixture f){return jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_previews WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()));}
    void capability(Fixture f,Actor actor,String code,String mode)throws Exception{
        String path=f.url()+"/access-members/"+actor.id();long revision=body(mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();
        request(f.owner().token(),put(path),Map.of("expectedRevision",revision,"capabilities",Map.of(code,mode))).andExpect(status().isOk());
    }
    void policy(Fixture f,boolean workspace,Map<String,?> settings)throws Exception{
        String path="/api/v1/workspaces/"+f.workspace()+(workspace?"":"/projects/"+f.project())+"/collaboration/policy";long revision=body(mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();
        request(f.owner().token(),put(path),Map.of("expectedRevision",revision,"settings",settings)).andExpect(status().isOk());
    }
}
