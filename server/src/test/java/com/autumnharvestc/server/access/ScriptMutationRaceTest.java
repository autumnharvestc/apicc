package com.autumnharvestc.server.access;

import com.autumnharvestc.server.collaboration.runtime.*;
import com.autumnharvestc.server.store.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.*;
import static org.assertj.core.api.Assertions.*;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@TestPropertySource(properties="spring.datasource.url=jdbc:h2:mem:apicc-script-entry-t5;DB_CLOSE_DELAY=-1")
class ScriptMutationRaceTest extends AccessHttpFixture {
    static final ObjectMapper WIRE=new ObjectMapper();
    static final String SECRET="synthetic-entry-secret-0123456789abcdef";
    static final AtomicReference<Exchange> RPC=new AtomicReference<>();
    static final HttpServer HTTP;
    static final Path KEY;
    static {
        try {
            KEY=Files.createTempFile("apicc-t5-rpc-",".key");Files.writeString(KEY,SECRET);KEY.toFile().deleteOnExit();
            HTTP=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);HTTP.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
            HTTP.createContext("/rpc",request->{try {
                var state=RPC.get();if(state==null){request.sendResponseHeaders(503,-1);return;}
                var value=WIRE.readTree(request.getRequestBody());
                if(!canonical(value.path("payload")).equals(canonical(state.payload))&&state.next!=null&&canonical(value.path("payload")).equals(canonical(state.next.payload)))state=state.next;
                if(!SECRET.equals(request.getRequestHeaders().getFirst("X-Apicc-Collaboration-Key"))||!new RuntimeProtocol(WIRE).validRequest(value)||!value.path("operation").asText().equals("classify-asset-mutation")||!canonical(value.path("payload")).equals(canonical(state.payload))) {
                    state.mismatch.set(true);request.sendResponseHeaders(400,-1);return;
                }
                state.calls.incrementAndGet();state.started.countDown();
                if(!state.release.await(10,TimeUnit.SECONDS))throw new IllegalStateException("fixture release timed out");
                if(state.fail){request.sendResponseHeaders(state.failureStatus,-1);return;}
                var response=(ObjectNode)value.deepCopy();response.set("payload",state.result);
                response.put("coreBuildIdentity",new RuntimeProtocol(WIRE).coreBuildIdentity()).put("outputDigest",RuntimeProtocol.digestJson(state.result));
                response.put("outputBytes",WIRE.writeValueAsBytes(state.result).length).put("wireBytes",0);
                byte[] bytes=WIRE.writeValueAsBytes(response);
                while(response.path("wireBytes").asInt()!=bytes.length){response.put("wireBytes",bytes.length);bytes=WIRE.writeValueAsBytes(response);}
                request.sendResponseHeaders(200,bytes.length);request.getResponseBody().write(bytes);
            } catch(Exception failure){throw new java.io.IOException(failure);} finally {request.close();}});HTTP.start();
        } catch(Exception failure){throw new ExceptionInInitializerError(failure);}
    }
    static class Exchange {
        final JsonNode payload,result;final boolean fail;final AtomicInteger calls=new AtomicInteger();final AtomicBoolean mismatch=new AtomicBoolean();
        volatile Exchange next;int failureStatus=503;
        final CountDownLatch started=new CountDownLatch(1),release;
        Exchange(JsonNode before,JsonNode after,JsonNode result,boolean fail,boolean gated){payload=WIRE.createObjectNode().set("beforeFiles",before);((ObjectNode)payload).set("afterFiles",after);this.result=result;this.fail=fail;release=new CountDownLatch(gated?1:0);}
    }
    static JsonNode canonical(JsonNode payload){var result=WIRE.createObjectNode();for(String key:List.of("beforeFiles","afterFiles")){var sorted=new TreeMap<String,String>();payload.path(key).forEach(file->sorted.put(file.path("path").asText(),file.path("content").asText()));result.set(key,WIRE.valueToTree(sorted));}return result;}
    @DynamicPropertySource static void runtime(DynamicPropertyRegistry p){p.add("apicc.collaboration.runtime.enabled",()->true);p.add("apicc.collaboration.runtime.base-url",()->"http://127.0.0.1:"+HTTP.getAddress().getPort());p.add("apicc.collaboration.runtime.secret-file",KEY::toString);}
    @Autowired FileVersionRepo files;
    @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Autowired org.springframework.transaction.PlatformTransactionManager transactions;
    @Autowired CollaborationRuntimeClient runtime;
    JsonNode fixture;
    @BeforeEach void fixtures() throws Exception {try(var input=getClass().getResourceAsStream("/asset-mutation-fixtures.json")){fixture=json.readTree(input);}RPC.set(null);}
    @AfterEach void release(){var state=RPC.getAndSet(null);if(state!=null)state.release.countDown();}
    @AfterAll static void stop(){HTTP.stop(0);}
    JsonNode variant(String name){for(var entry:fixture.path("cases"))if(entry.path("name").asText().equals(name))return entry;throw new IllegalArgumentException(name);}
    JsonNode before(){return fixture.path("beforeFiles");}
    void seed(Scope f,boolean atomic){new org.springframework.transaction.support.TransactionTemplate(transactions).executeWithoutResult(tx->{files.lockProject(Long.valueOf(f.workspace()),Long.valueOf(f.project()));for(var file:before())files.applyProjectAssetFile(Long.valueOf(f.workspace()),f.project()+"/"+file.path("path").asText(),file.path("content").asText(),com.autumnharvestc.server.core.Hashes.sha256HexUtf8(file.path("content").asText()),Long.valueOf(f.owner().id()));if(atomic)jdbc.update("UPDATE projects SET asset_format='contract-files-v1',contract_project_id='10000000-0000-4000-8000-000000000001',asset_version=1 WHERE id=?",Long.valueOf(f.project()));});}
    void denyScript(Scope f) throws Exception {mvc.perform(put(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":0,\"capabilities\":{\"script.edit\":\"deny\"}}")).andExpect(status().isOk());}
    List<FileVersionRecord> stored(Scope f){return files.listByProject(Long.valueOf(f.workspace()),Long.valueOf(f.project()));}
    long revision(Scope f){return jdbc.queryForObject("SELECT asset_version FROM projects WHERE id=?",Long.class,Long.valueOf(f.project()));}
    Map<String,String> map(JsonNode entries){var result=new TreeMap<String,String>();entries.forEach(file->result.put(file.path("path").asText(),file.path("content").asText()));return result;}
    Object delta(Scope f,JsonNode after){var old=map(before());var next=map(after);var changes=new ArrayList<Map<String,String>>();next.forEach((path,content)->{if(!content.equals(old.get(path)))changes.add(Map.of("path",path,"content",content));});var deletes=old.keySet().stream().filter(path->!next.containsKey(path)).toList();return Map.of("format","contract-files-v1","contractProjectId","10000000-0000-4000-8000-000000000001","expectedVersion",String.valueOf(revision(f)),"changes",changes,"deletes",deletes);}
    org.springframework.test.web.servlet.ResultActions atomic(Scope f,JsonNode after) throws Exception {return mvc.perform(put(f.projectUrl()+"/assets").header("Authorization","Bearer "+f.target().token()).contentType("application/json").content(json.writeValueAsString(delta(f,after))));}
    Exchange expect(JsonNode after,JsonNode result,boolean fail,boolean gated){var state=new Exchange(before(),after,result,fail,gated);RPC.set(state);return state;}
    void positiveRpc(Exchange state){assertThat(runtime.call("classify-asset-mutation",state.payload,System.currentTimeMillis()+5000,1_048_576)).isEqualTo(state.result);state.calls.set(0);}

    // A role-only atomic write must fail for all actual script surfaces, including deletion of owners.
    @ParameterizedTest @ValueSource(strings={"collection-script","ancestor-script","case-script","child-condition","delete-ancestor","delete-collection"})
    void atomicScriptMutationIsDeniedAndPreservesRealRevision(String name) throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,true);var sample=variant(name);var state=expect(sample.path("afterFiles"),sample.path("result"),false,false);positiveRpc(state);denyScript(f);
        var beforeFiles=stored(f);long revisionBefore=revision(f);var response=atomic(f,sample.path("afterFiles"));var afterFiles=stored(f);long revisionAfter=revision(f);
        assertAll(()->response.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden")),()->assertThat(afterFiles).isEqualTo(beforeFiles),()->assertThat(revisionAfter).isEqualTo(revisionBefore),()->assertThat(state.calls.get()).isEqualTo(1),()->assertThat(state.mismatch.get()).isFalse());
    }
    // Catches keyword/file-extension guesses, and treating a child reference itself as script editing.
    @ParameterizedTest @ValueSource(strings={"metadata","subflow-reference"})
    void ordinaryWiringStillUsesCompleteClassificationAndSucceeds(String name) throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,true);var sample=variant(name);var state=expect(sample.path("afterFiles"),sample.path("result"),false,false);positiveRpc(state);denyScript(f);
        atomic(f,sample.path("afterFiles")).andExpect(status().isOk());
        assertAll(()->assertThat(state.calls.get()).isEqualTo(1),()->assertThat(state.mismatch.get()).isFalse(),()->assertThat(stored(f).stream().collect(java.util.stream.Collectors.toMap(r->r.path().substring(f.project().length()+1),FileVersionRecord::content))).isEqualTo(map(sample.path("afterFiles"))));
    }
    @ParameterizedTest @ValueSource(strings={"put","batch","delete"})
    void legacyRoutesCannotBypassScriptClassification(String route) throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,false);var sample=variant("collection-script");var old=map(before());var next=map(sample.path("afterFiles"));String path=next.keySet().stream().filter(p->!Objects.equals(old.get(p),next.get(p))).findFirst().orElseThrow();
        JsonNode after=sample.path("afterFiles");if(route.equals("delete")){var deleted=json.createArrayNode();for(var file:before())if(!file.path("path").asText().equals("project.yaml"))deleted.add(file);after=deleted;path="project.yaml";}
        var state=expect(after,sample.path("result"),route.equals("delete"),false);if(!route.equals("delete"))positiveRpc(state);denyScript(f);var saved=stored(f);long rev=revision(f);
        String url=f.workspaceUrl()+"/files/"+f.project()+"/"+path;
        org.springframework.test.web.servlet.ResultActions response;
        if(route.equals("batch"))response=mvc.perform(post(f.workspaceUrl()+"/files/batch").header("Authorization","Bearer "+f.target().token()).contentType("application/json").content(json.writeValueAsString(Map.of("files",List.of(Map.of("path",f.project()+"/"+path,"baseVersion",1,"content",next.get(path)))))));
        else if(route.equals("delete"))response=mvc.perform(delete(url).param("baseVersion","1").header("Authorization","Bearer "+f.target().token()));
        else response=mvc.perform(put(url).header("Authorization","Bearer "+f.target().token()).contentType("application/json").content(json.writeValueAsString(Map.of("baseVersion",1,"content",next.get(path)))));
        assertAll(()->{if(route.equals("batch"))response.andExpect(status().isOk()).andExpect(jsonPath("$.results[0].status").value("forbidden"));else response.andExpect(status().isForbidden());},()->assertThat(stored(f)).isEqualTo(saved),()->assertThat(revision(f)).isEqualTo(rev),()->assertThat(state.calls.get()).isEqualTo(1),()->assertThat(state.mismatch.get()).isFalse());
    }
    @Test void unavailableClassificationFailsClosedForRestrictedAtomicWriter() throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,true);var sample=variant("metadata");var state=expect(sample.path("afterFiles"),sample.path("result"),true,false);denyScript(f);var saved=stored(f);long rev=revision(f);var response=atomic(f,sample.path("afterFiles"));
        assertAll(()->response.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden")),()->assertThat(stored(f)).isEqualTo(saved),()->assertThat(revision(f)).isEqualTo(rev),()->assertThat(state.calls.get()).isEqualTo(1));
    }
    @Test void unknownLayoutFailsClosed() throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,true);var after=fixture.path("invalidCases").get(0).path("afterFiles");var state=expect(after,json.createObjectNode(),true,false);state.failureStatus=400;denyScript(f);var saved=stored(f);long rev=revision(f);var response=atomic(f,after);
        assertAll(()->response.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden")),()->assertThat(stored(f)).isEqualTo(saved),()->assertThat(revision(f)).isEqualTo(rev),()->assertThat(state.calls.get()).isEqualTo(1),()->assertThat(state.mismatch.get()).isFalse());
    }
    @Test void legacyBatchAuthorizesEachItemAndKeepsPartialSuccess() throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,false);var script=variant("collection-script");var metadata=variant("metadata");var first=expect(script.path("afterFiles"),script.path("result"),false,false);positiveRpc(first);
        var second=new Exchange(before(),metadata.path("afterFiles"),metadata.path("result"),false,false);first.next=second;
        assertThat(runtime.call("classify-asset-mutation",second.payload,System.currentTimeMillis()+5000,1_048_576)).isEqualTo(second.result);second.calls.set(0);denyScript(f);
        var old=map(before());var changed=map(script.path("afterFiles"));String scriptPath=changed.keySet().stream().filter(p->!Objects.equals(old.get(p),changed.get(p))).findFirst().orElseThrow();
        var response=mvc.perform(post(f.workspaceUrl()+"/files/batch").header("Authorization","Bearer "+f.target().token()).contentType("application/json").content(json.writeValueAsString(Map.of("files",List.of(Map.of("path",f.project()+"/"+scriptPath,"baseVersion",1,"content",changed.get(scriptPath)),Map.of("path",f.project()+"/project.yaml","baseVersion",1,"content",map(metadata.path("afterFiles")).get("project.yaml")))))));
        assertAll(()->response.andExpect(status().isOk()).andExpect(jsonPath("$.results[0].status").value("forbidden")).andExpect(jsonPath("$.results[1].status").value("pushed")),()->assertThat(files.find(Long.valueOf(f.workspace()),f.project()+"/"+scriptPath).orElseThrow().version()).isEqualTo(1),()->assertThat(stored(f).stream().collect(java.util.stream.Collectors.toMap(r->r.path().substring(f.project().length()+1),FileVersionRecord::content))).isEqualTo(map(metadata.path("afterFiles"))),()->assertThat(first.calls.get()).isEqualTo(1),()->assertThat(second.calls.get()).isEqualTo(1),()->assertThat(first.mismatch.get()||second.mismatch.get()).isFalse());
    }
    @ParameterizedTest @ValueSource(strings={"script","ordinary","unavailable"})
    void configuredClassificationAuditHasTrueLocationsAndRevision(String kind) throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,true);var sample=variant(kind.equals("script")?"child-condition":"metadata");var state=expect(sample.path("afterFiles"),sample.path("result"),kind.equals("unavailable"),false);if(!state.fail)positiveRpc(state);
        atomic(f,sample.path("afterFiles")).andExpect(status().isOk());
        var rows=jdbc.query("SELECT asset_summary,asset_locations_json,asset_before_revision,asset_after_revision,version FROM execution_management_audit WHERE actor_id=? AND scope_id=? AND action='asset.change'",(r,n)->Map.of("summary",r.getString(1),"locations",r.getString(2),"before",r.getString(3),"after",r.getString(4),"version",r.getLong(5)),Long.valueOf(f.target().id()),Long.valueOf(f.project()));
        assertThat(rows).singleElement().satisfies(row->{assertThat(row.get("summary")).isEqualTo(kind.equals("unavailable")?"classification-unavailable":kind.equals("script")?"script-changed":"script-unchanged");assertThat(parse((String)row.get("locations"))).isEqualTo(kind.equals("unavailable")?json.valueToTree(List.of("project.yaml")):sample.path("result").path("locations"));assertThat(row.get("before")).isEqualTo(fixture.path("beforeManifest").asText());assertThat(row.get("after")).isEqualTo(sample.path("afterManifest").asText());assertThat(row.get("version")).isEqualTo(2L);});
        assertThat(state.calls.get()).isEqualTo(1);assertThat(state.mismatch.get()).isFalse();
    }
    JsonNode parse(String value){try{return json.readTree(value);}catch(Exception e){throw new IllegalArgumentException(e);}}

    org.springframework.test.web.servlet.ResultActions mutate(Scope f,String route,JsonNode after) throws Exception {
        if(route.equals("atomic"))return atomic(f,after);
        var old=map(before());var next=map(after);
        String path=route.equals("delete")?"project.yaml":next.keySet().stream().filter(p->!Objects.equals(old.get(p),next.get(p))).findFirst().orElseThrow();
        String url=f.workspaceUrl()+"/files/"+f.project()+"/"+path;
        if(route.equals("delete"))return mvc.perform(delete(url).param("baseVersion","1").header("Authorization","Bearer "+f.target().token()));
        if(route.equals("put"))return mvc.perform(put(url).header("Authorization","Bearer "+f.target().token()).contentType("application/json").content(json.writeValueAsString(Map.of("baseVersion",1,"content",next.get(path)))));
        return mvc.perform(post(f.workspaceUrl()+"/files/batch").header("Authorization","Bearer "+f.target().token()).contentType("application/json").content(json.writeValueAsString(Map.of("files",List.of(Map.of("path",f.project()+"/"+path,"baseVersion",1,"content",next.get(path)))))));
    }
    JsonNode deleteAfter(){return fixture.path("invalidCases").get(0).path("afterFiles");}
    void assertDenied(org.springframework.test.web.servlet.ResultActions response,String route) throws Exception {
        if(route.equals("batch"))response.andExpect(status().isOk()).andExpect(jsonPath("$.results[0].status").value("forbidden"));else response.andExpect(status().isForbidden());
    }
    @ParameterizedTest @ValueSource(strings={"atomic","put","batch","delete"})
    void classificationPauseRechecksScriptWithdrawal(String route) throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,route.equals("atomic"));var sample=variant("collection-script");var after=route.equals("delete")?deleteAfter():sample.path("afterFiles");
        var state=expect(after,sample.path("result"),route.equals("delete"),true);var saved=stored(f);long rev=revision(f);
        try(var pool=Executors.newFixedThreadPool(2)) {
            var pending=pool.submit(()->mutate(f,route,after));
            try {
                assertThat(state.started.await(5,TimeUnit.SECONDS)).isTrue();
                pool.submit(()->{denyScript(f);return true;}).get(3,TimeUnit.SECONDS);
                assertThat(access.resolve(Long.valueOf(f.target().id()),Long.valueOf(f.workspace()),Long.valueOf(f.project())).capabilities()).doesNotContain(Capability.SCRIPT_EDIT);
            } finally {state.release.countDown();}
            var response=pending.get(5,TimeUnit.SECONDS);
            assertAll(()->assertDenied(response,route),()->assertThat(stored(f)).isEqualTo(saved),()->assertThat(revision(f)).isEqualTo(rev),()->assertThat(state.calls.get()).isEqualTo(1),()->assertThat(state.mismatch.get()).isFalse());
        }
    }
    @ParameterizedTest @org.junit.jupiter.params.provider.CsvSource({"atomic,disabled","atomic,remove","atomic,NONE","atomic,pending","atomic,viewer","put,disabled","put,remove","put,NONE","put,pending","put,viewer"})
    void classificationPauseRechecksCurrentQualifications(String route,String loss) throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());if(loss.equals("pending"))acl(f,"ADMIN",0).andExpect(status().isOk());seed(f,route.equals("atomic"));var sample=variant("metadata");var state=expect(sample.path("afterFiles"),sample.path("result"),false,true);var saved=stored(f);long rev=revision(f);
        try(var pool=Executors.newFixedThreadPool(2)) {
            var pending=pool.submit(()->mutate(f,route,sample.path("afterFiles")));
            try {
                assertThat(state.started.await(5,TimeUnit.SECONDS)).isTrue();
                pool.submit(()->{switch(loss) {
                    case "disabled" -> {jdbc.update("UPDATE users SET role='SUPERADMIN' WHERE id=?",Long.valueOf(f.owner().id()));mvc.perform(post("/api/v1/admin/users/"+f.target().id()+"/disable").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":1}")).andExpect(status().isNoContent());}
                    case "remove","pending" -> {mvc.perform(delete(f.workspaceUrl()+"/members/"+f.target().id()).param("expectedRevision","1").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());if(loss.equals("pending"))member(f,"EDITOR",2).andExpect(status().isOk());}
                    case "NONE" -> acl(f,"NONE",0).andExpect(status().isOk());
                    case "viewer" -> member(f,"VIEWER",1).andExpect(status().isOk());
                }return true;}).get(3,TimeUnit.SECONDS);
                var role=access.resolve(Long.valueOf(f.target().id()),Long.valueOf(f.workspace()),Long.valueOf(f.project())).effectiveRole();
                if(loss.equals("viewer"))assertThat(role).contains(com.autumnharvestc.server.core.Role.VIEWER);else assertThat(role).isEmpty();
            } finally {state.release.countDown();}
            var response=pending.get(5,TimeUnit.SECONDS);
            assertAll(()->response.andExpect(status().isForbidden()),()->assertThat(stored(f)).isEqualTo(saved),()->assertThat(revision(f)).isEqualTo(rev),()->assertThat(state.mismatch.get()).isFalse());
        }
    }
    @ParameterizedTest @ValueSource(strings={"atomic","put","batch","delete"})
    void fixedCompleteSnapshotRejectsConcurrentOtherFileChange(String route) throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,route.equals("atomic"));var metadata=variant("metadata");var script=variant("collection-script");var after=route.equals("delete")?deleteAfter():metadata.path("afterFiles");var first=expect(after,metadata.path("result"),route.equals("delete"),true);
        var second=new Exchange(before(),script.path("afterFiles"),script.path("result"),false,false);first.next=second;
        try(var pool=Executors.newFixedThreadPool(2)) {
            var pending=pool.submit(()->mutate(f,route,after));List<FileVersionRecord> ownerFiles;long ownerRevision;
            try {
                assertThat(first.started.await(5,TimeUnit.SECONDS)).isTrue();
                var owner=new Scope(f.owner(),f.owner(),f.workspace(),f.project());
                var committed=pool.submit(()->mutate(owner,route.equals("atomic")?"atomic":"put",script.path("afterFiles"))).get(3,TimeUnit.SECONDS);
                committed.andExpect(route.equals("atomic")?status().isOk():status().isCreated());
                ownerFiles=stored(f);ownerRevision=revision(f);assertThat(second.calls.get()).isEqualTo(1);assertThat(first.mismatch.get()||second.mismatch.get()).isFalse();
            } finally {first.release.countDown();}
            var response=pending.get(5,TimeUnit.SECONDS);
            assertAll(()->{if(route.equals("batch"))response.andExpect(status().isOk()).andExpect(jsonPath("$.results[0].status").value("conflict"));else response.andExpect(status().isConflict());},()->assertThat(stored(f)).isEqualTo(ownerFiles),()->assertThat(revision(f)).isEqualTo(ownerRevision));
        }
    }
    @Test void projectLockWaitStillAllowsPermissionRevocationToCommit() throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,true);var sample=variant("collection-script");var state=expect(sample.path("afterFiles"),sample.path("result"),false,true);var saved=stored(f);long rev=revision(f);var held=new CountDownLatch(1);var releaseLock=new CountDownLatch(1);var holderSession=new AtomicLong();
        try(var pool=Executors.newFixedThreadPool(3)) {
            var pending=pool.submit(()->atomic(f,sample.path("afterFiles")));
            Future<?> holder=null;
            try {
                assertThat(state.started.await(5,TimeUnit.SECONDS)).isTrue();
                holder=pool.submit(()->new org.springframework.transaction.support.TransactionTemplate(transactions).executeWithoutResult(tx->{files.lockProject(Long.valueOf(f.workspace()),Long.valueOf(f.project()));holderSession.set(jdbc.queryForObject("SELECT SESSION_ID()",Long.class));held.countDown();try{if(!releaseLock.await(10,TimeUnit.SECONDS))throw new IllegalStateException("holder release timed out");}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IllegalStateException(e);}}));
                assertThat(held.await(3,TimeUnit.SECONDS)).as("RPC must not hold the project lock").isTrue();state.release.countDown();
                long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);boolean blocked=false;
                while(System.nanoTime()<until){if(jdbc.queryForObject("SELECT COUNT(*) FROM INFORMATION_SCHEMA.SESSIONS WHERE BLOCKER_ID=?",Long.class,holderSession.get())>0){blocked=true;break;}TimeUnit.MILLISECONDS.sleep(10);}
                assertThat(blocked).as("actual writer waits on holder's project row lock").isTrue();
                pool.submit(()->{denyScript(f);return true;}).get(3,TimeUnit.SECONDS);
                assertThat(access.resolve(Long.valueOf(f.target().id()),Long.valueOf(f.workspace()),Long.valueOf(f.project())).capabilities()).doesNotContain(Capability.SCRIPT_EDIT);
            } finally {state.release.countDown();releaseLock.countDown();}
            if(holder!=null)holder.get(5,TimeUnit.SECONDS);
            var response=pending.get(5,TimeUnit.SECONDS);
            assertAll(()->response.andExpect(status().isForbidden()),()->assertThat(stored(f)).isEqualTo(saved),()->assertThat(revision(f)).isEqualTo(rev));
        }
    }
    @Test void taskWithdrawalDoesNotRemoveIndependentAssetEditing() throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,true);var sample=variant("metadata");var state=expect(sample.path("afterFiles"),sample.path("result"),false,true);
        try(var pool=Executors.newFixedThreadPool(2)) {
            var pending=pool.submit(()->atomic(f,sample.path("afterFiles")));
            try {assertThat(state.started.await(5,TimeUnit.SECONDS)).isTrue();pool.submit(()->mvc.perform(put(f.projectUrl()+"/access-members/"+f.target().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":0,\"capabilities\":{\"task.execute\":\"deny\"}}")).andExpect(status().isOk())).get(3,TimeUnit.SECONDS);}finally{state.release.countDown();}
            pending.get(5,TimeUnit.SECONDS).andExpect(status().isOk());assertThat(revision(f)).isEqualTo(2);
        }
    }
    @Test void ordinaryClassificationSurvivesOnlyScriptWithdrawal() throws Exception {
        var f=scope();member(f,"EDITOR",0).andExpect(status().isOk());seed(f,true);var sample=variant("metadata");var state=expect(sample.path("afterFiles"),sample.path("result"),false,true);
        try(var pool=Executors.newFixedThreadPool(2)) {
            var pending=pool.submit(()->atomic(f,sample.path("afterFiles")));
            try{assertThat(state.started.await(5,TimeUnit.SECONDS)).isTrue();pool.submit(()->{denyScript(f);return true;}).get(3,TimeUnit.SECONDS);}finally{state.release.countDown();}
            pending.get(5,TimeUnit.SECONDS).andExpect(status().isOk());assertThat(revision(f)).isEqualTo(2);assertThat(state.calls.get()).isEqualTo(1);assertThat(state.mismatch.get()).isFalse();
        }
    }
}
