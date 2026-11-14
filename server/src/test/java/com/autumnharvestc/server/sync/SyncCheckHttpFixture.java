package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.collaboration.runtime.*;
import com.autumnharvestc.server.execution.assets.ProjectAssetsService;
import com.autumnharvestc.server.store.UserRepo;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

abstract class SyncCheckHttpFixture extends SyncHttpFixture {
    static final String DATABASE_URL="jdbc:h2:mem:apicc-sync-runtime;DB_CLOSE_DELAY=-1";
    static final class Node implements AutoCloseable {
        final Path directory;final Process process;final JsonNode info;
        Node(){Process launched=null;try{
            directory=Files.createTempDirectory("apicc-t9-java-");var current=Path.of("").toAbsolutePath();var root=Files.isDirectory(current.resolve("apps"))?current:current.getParent();
            process=new ProcessBuilder(System.getenv().getOrDefault("APICC_TEST_NODE","node"),root.resolve("server/src/test/resources/sync-check-process.mjs").toString(),directory.toString()).directory(root.toFile()).redirectError(directory.resolve("node-stderr.log").toFile()).start();
            launched=process;
            var line=CompletableFuture.supplyAsync(()->{try{return process.inputReader().readLine();}catch(Exception e){throw new RuntimeException(e);}}).get(15,TimeUnit.SECONDS);
            if(line==null)throw new IllegalStateException("Node prerequisite: "+Files.readString(directory.resolve("node-stderr.log")));
            info=new ObjectMapper().readTree(line);
            process.onExit().thenRun(()->{if(process.exitValue()!=0)System.err.println(diagnostic());});
            Runtime.getRuntime().addShutdownHook(new Thread(()->{try{close();}catch(Exception error){System.err.println(error);process.destroyForcibly();}}));
        }catch(Exception error){if(launched!=null){launched.destroyForcibly();try{launched.waitFor(5,TimeUnit.SECONDS);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}}throw new ExceptionInInitializerError(error);}}
        String diagnostic(){
            String stderr;try{stderr=Files.readString(directory.resolve("node-stderr.log"));}catch(Exception error){stderr="stderr unavailable: "+error.getClass().getSimpleName();}
            if(stderr.length()>8192)stderr=stderr.substring(stderr.length()-8192);
            return "SYNC_FIXTURE_EXIT pid="+process.pid()+" exit="+(process.isAlive()?"alive":process.exitValue())+" directory="+directory+"\n"+stderr;
        }
        void requireAlive(){if(!process.isAlive())throw new AssertionError(diagnostic());}
        public void close() throws Exception {
            if(process.isAlive()){
                try{process.getOutputStream().write(1);process.getOutputStream().flush();}
                catch(java.io.IOException error){if(process.isAlive())throw error;}
                if(!process.waitFor(10,TimeUnit.SECONDS)){process.destroyForcibly().waitFor();throw new IllegalStateException("Owned sync fixture required forced shutdown: "+diagnostic());}
            }
            if(process.exitValue()!=0)throw new IllegalStateException(diagnostic());
        }
    }
    static final Node node=new Node();
    static final Path key;
    static {try{key=Files.createTempFile("apicc-sync-t9-key-",".bin");Files.write(key,new byte[32]);key.toFile().deleteOnExit();}catch(Exception error){throw new ExceptionInInitializerError(error);}}
    @DynamicPropertySource static void runtime(DynamicPropertyRegistry props){props.add("spring.datasource.url",()->DATABASE_URL);props.add("apicc.collaboration.runtime.enabled",()->true);props.add("apicc.collaboration.runtime.base-url",()->node.info.path("url").asText());props.add("apicc.collaboration.runtime.secret-file",()->node.info.path("secretFile").asText());props.add("apicc.execution.materials.master-key-file",()->key.toString());}
    @Autowired CollaborationRuntimeClient core;
    @Autowired RuntimeProtocol protocol;
    @Autowired ProjectAssetsService assets;
    @Autowired UserRepo users;
    @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Override JsonNode initialProjectFiles() {
        node.requireAlive();
        return node.info.required("initialFiles");
    }
    @BeforeEach void canonicalAssets() throws Exception {
        node.requireAlive();
        var delta=json.createObjectNode().put("format","contract-files-v1").put("contractProjectId","00000000-0000-4000-8000-000000000070").put("expectedVersion","1");delta.set("changes",node.info.path("files"));delta.set("deletes",json.createArrayNode());
        mvc.perform(put(f.projectUrl()+"/assets").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(delta.toString())).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("2"));
    }
    @org.junit.jupiter.api.AfterEach void sharedRuntimeSurvived(){node.requireAlive();}
    JsonNode createUrlSource(String path) throws Exception {var source=sourceBody("url").put("url",node.info.path("origin").asText()+path);return body(sourceRequest("POST","/sources",f.owner(),write(source).put("expectedAssetVersion","2")).andExpect(status().isCreated()));}
    ObjectNode checkBody(){return json.createObjectNode().put("formatVersion",1).put("intentId",UUID.randomUUID().toString()).put("expectedSourceRevision","1").put("expectedAssetVersion","2");}
    ObjectNode planning(JsonNode source,JsonNode read,boolean complete){
        var stored=assets.get(users.findById(Long.parseLong(f.owner().id())).orElseThrow(),f.workspace(),f.project());
        var payload=json.createObjectNode().put("kind",complete?"source-read":"source-read-online").put("allocationSeed","apicc-sync-id-v1");payload.set("read",read);payload.set("source",source);
        var stamp=json.createObjectNode().put("formatVersion",1).put("kind","online").put("projectId",stored.contractProjectId()).put("assetVersion",stored.version()).put("sourceRevision","1").put("mappingRevision","0").put("baselineRevision","0").put("authorizationGeneration","1").put("coreBuildId",protocol.coreBuildIdentity());if(complete)stamp.put("definitionRevision",node.info.path("definitionRevision").asText());payload.set("stamp",stamp);
        payload.set("mapping",json.createObjectNode().put("formatVersion",1).put("sourceId",source.path("id").asText()).put("namespace",source.path("id").asText()).put("revision","0").put("algorithm","apicc-sync-id-v1").set("entries",json.createArrayNode()));
        payload.set("baselineFiles",json.createArrayNode());var local=json.createArrayNode();stored.files().forEach(file->local.add(json.createObjectNode().put("path",file.path()).put("content",file.content())));payload.set("localFiles",local);payload.set("otherSourceMappings",json.createArrayNode());
        payload.set("budget",json.createObjectNode().put("maxSourceBytes",5242880).put("maxCompareInputBytes",16777216).put("maxCompareOutputBytes",8388608).put("maxNormalizeDepth",128).put("maxNormalizeNodes",100000));return payload;
    }
    ObjectNode readPayload(JsonNode source){
        var payload=json.createObjectNode();payload.set("input",json.createObjectNode().put("formatVersion",1).put("deadlineAtMs",System.currentTimeMillis()+15000).set("source",source));((ObjectNode)payload.path("input")).set("budget",json.createObjectNode().put("connectTimeoutMs",1000).put("maxAttempts",1).put("maxSourceBytes",5242880).put("gitDiskThresholdBytes",268435456));
        payload.set("context",json.createObjectNode().put("workspaceId",f.workspace()).put("projectId",f.project()).put("sourceRevision","1").put("authorizationGeneration","1").put("invocationId",UUID.randomUUID().toString()).put("projectConcurrency",1).put("hostConcurrency",4));payload.set("material",json.createObjectNode().put("leaseId",UUID.randomUUID().toString()).put("identity","a".repeat(64)));payload.set("network",json.createObjectNode().put("kind","direct").put("revision","0"));return payload;
    }
    JsonNode actualRead(JsonNode source){return core.call("sync-read",readPayload(source),System.currentTimeMillis()+15000,32000000);}
    JsonNode awaitCheck(String id) throws Exception {return awaitCheckAs(id,editor());}
    JsonNode awaitCheckAs(String id,Actor actor) throws Exception {long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(12);while(System.nanoTime()<until){var state=body(sourceRequest("GET","/checks/"+id,actor,null).andExpect(status().isOk()));if(Set.of("succeeded","failed","cancelled","lost").contains(state.path("state").asText()))return state;Thread.sleep(20);}throw new AssertionError("Check did not settle: "+id);}
    JsonNode checkToCandidate(JsonNode source) throws Exception {var accepted=body(sourceRequest("POST","/sources/"+source.path("id").asText()+"/checks",editor(),checkBody()).andExpect(status().isAccepted()));var check=awaitCheck(accepted.path("checkId").asText());assertThat(check.path("state").asText()).withFailMessage(check.toString()).isEqualTo("succeeded");return body(sourceRequest("GET","/candidates/"+check.path("candidateId").asText(),editor(),null).andExpect(status().isOk()));}
    JsonNode submit(JsonNode source,ObjectNode request) throws Exception {return body(sourceRequest("POST","/sources/"+source.path("id").asText()+"/checks",editor(),request).andExpect(status().isAccepted()));}
    String currentVersion(){return jdbc.queryForObject("SELECT CAST(asset_version AS VARCHAR) FROM projects WHERE id=?",String.class,Long.parseLong(f.project()));}
    void editProjectWithCurrentVersion() throws Exception {var stored=body(mvc.perform(get(f.projectUrl()+"/assets").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));var file=java.util.stream.StreamSupport.stream(stored.path("files").spliterator(),false).filter(value->value.path("path").asText().equals("project.yaml")).findFirst().orElseThrow();var delta=json.createObjectNode().put("format","contract-files-v1").put("contractProjectId",stored.path("contractProjectId").asText()).put("expectedVersion",stored.path("version").asText());delta.set("changes",json.createArrayNode().add(json.createObjectNode().put("path","project.yaml").put("content",file.path("content").asText().replace("name: T9","name: T9 changed"))));delta.set("deletes",json.createArrayNode());mvc.perform(put(f.projectUrl()+"/assets").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(delta.toString())).andExpect(status().isOk());}
    void awaitNode(String name) throws Exception {long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(6);while(System.nanoTime()<until){if(Files.exists(node.directory.resolve(name)))return;Thread.sleep(10);}throw new AssertionError("Actual source barrier absent: "+name);}
    void release(String barrier) throws Exception {java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(node.info.path("origin").asText()+"/release/"+barrier)).GET().build(),java.net.http.HttpResponse.BodyHandlers.discarding());}
    int sourceHostCalls() throws Exception {var response=java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(node.info.path("origin").asText()+"/control")).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());return json.readTree(response.body()).path("calls").asInt();}
    int source304Responses() throws Exception {var response=java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(node.info.path("origin").asText()+"/control")).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());return json.readTree(response.body()).path("cache304").asInt();}
    JsonNode candidate(String id) throws Exception {return body(sourceRequest("GET","/candidates/"+id,editor(),null).andExpect(status().isOk()));}
}
