package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.collaboration.runtime.RuntimeProtocol;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class SyncApplyTest extends SyncApplicationHttpFixture {
    @Test void realCandidateAppliesAssetsBaselineHistoryAndReceiptTogether() throws Exception {
        var source=createUrlSource("/fast");var view=checkToCandidate(source);assertThat(view.path("applicable").asBoolean()).isTrue();var request=application(view);
        var receipt=body(sourceRequest("POST","/applications",editor(),request).andExpect(status().isOk()));
        assertThat(receipt.path("status").asText()).isEqualTo("committed");assertThat(receipt.path("afterStamp").path("assetVersion").asText()).isEqualTo("3");assertThat(currentVersion()).isEqualTo("3");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sync_history WHERE project_id=?",Integer.class,Long.parseLong(f.project()))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT baseline_revision FROM sync_sources WHERE project_id=? AND id=?",String.class,Long.parseLong(f.project()),source.path("id").asText())).isEqualTo("1");
        assertThat(body(sourceRequest("GET","/operations/"+request.path("intentId").asText(),editor(),null).andExpect(status().isOk()))).isEqualTo(receipt);
    }
    @Test void finiteResolveSuppliesCanonicalContentArtifactsFromTheActualCandidate() throws Exception {
        var view=checkToCandidate(createUrlSource("/fast"));var request=application(view);var fixed=json.readTree(jdbc.queryForObject("SELECT fixed_json FROM sync_candidates WHERE project_id=? AND id=?",String.class,Long.parseLong(f.project()),view.path("candidate").path("id").asText()));var input=json.createObjectNode();input.set("candidate",fixed.path("candidate"));input.set("planInput",fixed.path("planInput"));input.set("decisions",request.path("decisions"));var wrapper=json.createObjectNode().put("kind","online-commit");wrapper.set("input",input);
        var result=org.junit.jupiter.api.Assertions.assertDoesNotThrow(()->core.call("sync-resolve",wrapper,System.currentTimeMillis()+10000,32000000));
        assertThat(result.path("plan").path("decisionsDigest")).isEqualTo(request.path("decisionsDigest"));int bareBytes=json.writeValueAsBytes(result.path("plan")).length;assertThatThrownBy(()->core.call("sync-resolve",wrapper,System.currentTimeMillis()+10000,bareBytes+64)).isInstanceOfSatisfying(com.autumnharvestc.server.collaboration.runtime.CollaborationRuntimeClient.Failure.class,failure->assertThat(failure.code()).isIn("SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED","RPC_INVALID_OUTPUT","RPC_MESSAGE_TOO_LARGE"));for(String key:java.util.List.of("before","after","baseline")){var artifact=result.path(key);var text=artifact.path("text").asText();assertThat(artifact.path("reference").path("digest").asText()).isEqualTo(com.autumnharvestc.server.core.Hashes.sha256HexUtf8(text));assertThat(artifact.path("reference").path("bytes").asLong()).isEqualTo(text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);}
    }

    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"source","mapping","baseline","authority","expiry","core","asset"})
    void fixedCandidateIsRejectedByTheRealApplicationEndpoint(String change) throws Exception {
        var source=createUrlSource("/fast");var view=checkToCandidate(source);var request=application(view);assertThat(view.path("applicable").asBoolean()).isTrue();
        switch(change){
            case "source" -> sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),sourceUpdateBody(source).put("expectedAssetVersion","2")).andExpect(status().isOk());
            case "mapping" -> jdbc.update("UPDATE sync_sources SET mapping_revision='1' WHERE project_id=?",Long.parseLong(f.project()));
            case "baseline" -> jdbc.update("UPDATE sync_sources SET baseline_revision='1' WHERE project_id=?",Long.parseLong(f.project()));
            case "authority" -> capabilities(null,java.util.Map.of("sync.manage","deny"));
            case "expiry" -> jdbc.update("UPDATE sync_candidates SET expires_at=DATEADD('SECOND',-1,CURRENT_TIMESTAMP) WHERE project_id=?",Long.parseLong(f.project()));
            case "core" -> {var fixed=(ObjectNode)json.readTree(jdbc.queryForObject("SELECT fixed_json FROM sync_candidates WHERE project_id=?",String.class,Long.parseLong(f.project())));((ObjectNode)fixed.path("candidate").path("stamp")).put("coreBuildId","f".repeat(64));((ObjectNode)fixed.path("planInput").path("stamp")).put("coreBuildId","f".repeat(64));jdbc.update("UPDATE sync_candidates SET fixed_json=? WHERE project_id=?",fixed.toString(),Long.parseLong(f.project()));}
            case "asset" -> editProjectWithCurrentVersion();
        }
        String before=currentVersion();sourceRequest("POST","/applications",editor(),request).andExpect(status().isConflict());assertThat(currentVersion()).isEqualTo(before);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sync_history WHERE project_id=?",Integer.class,Long.parseLong(f.project()))).isZero();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"sourceId","expectedSourceRevision","expectedAssetVersion","candidateDigest","decisionsDigest"})
    void applicationBindsEveryExpectedIdentityAndDigest(String field) throws Exception {
        var view=checkToCandidate(createUrlSource("/fast"));var request=application(view);if(field.equals("sourceId"))request.put(field,createUrlSource("/other").path("id").asText());else request.put(field,field.endsWith("Digest")?"f".repeat(64):"9");
        sourceRequest("POST","/applications",editor(),request).andExpect(status().isConflict());assertThat(currentVersion()).isEqualTo("2");
    }
    @Test void applyCapabilityIsRequiredEvenForAnEditor() throws Exception {
        var view=checkToCandidate(createUrlSource("/fast"));var request=application(view);capabilities(null,java.util.Map.of("sync.apply","deny"));sourceRequest("POST","/applications",editor(),request).andExpect(status().isForbidden());assertThat(currentVersion()).isEqualTo("2");
    }
    public static class FailHistory implements org.h2.api.Trigger {
        static volatile long project;
        public void fire(java.sql.Connection connection,Object[] oldRow,Object[] row) throws java.sql.SQLException {if(((Number)row[1]).longValue()==project)throw new java.sql.SQLException("synthetic transaction fault after asset write");}
    }
    @Test void databaseFailureRollsBackAssetsAuditBaselineHistoryAndIntent() throws Exception {
        var view=checkToCandidate(createUrlSource("/fast"));var request=application(view);long project=Long.parseLong(f.project());String assetsBefore=json.writeValueAsString(assets.get(users.findById(Long.parseLong(editor().id())).orElseThrow(),f.workspace(),f.project()));int audit=jdbc.queryForObject("SELECT COUNT(*) FROM execution_management_audit WHERE scope_type='project' AND scope_id=?",Integer.class,project);
        FailHistory.project=project;jdbc.execute("CREATE TRIGGER t10_fail_history BEFORE INSERT ON sync_history FOR EACH ROW CALL 'com.autumnharvestc.server.sync.SyncApplyTest$FailHistory'");
        try{sourceRequest("POST","/applications",editor(),request).andExpect(status().isInternalServerError());}finally{jdbc.execute("DROP TRIGGER t10_fail_history");FailHistory.project=0;}
        assertThat(json.writeValueAsString(assets.get(users.findById(Long.parseLong(editor().id())).orElseThrow(),f.workspace(),f.project()))).isEqualTo(assetsBefore);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_management_audit WHERE scope_type='project' AND scope_id=?",Integer.class,project)).isEqualTo(audit);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sync_operations WHERE project_id=? AND intent_id=?",Integer.class,project,request.path("intentId").asText())).isZero();assertThat(jdbc.queryForObject("SELECT baseline_revision FROM sync_sources WHERE project_id=?",String.class,project)).isEqualTo("0");
    }

    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"source","authority","policy","asset"})
    void commitRechecksAfterLockFreeCoreWork(String mutation) throws Exception {
        var source=createUrlSource("/fast");var request=application(checkToCandidate(source));java.nio.file.Files.deleteIfExists(node.directory.resolve("resolve-held"));control("/hold-resolve");
        var pending=java.util.concurrent.CompletableFuture.supplyAsync(()->{try{return sourceRequest("POST","/applications",editor(),request).andReturn().getResponse().getStatus();}catch(Exception e){throw new java.util.concurrent.CompletionException(e);}});
        try{awaitNode("resolve-held");switch(mutation){case "source"->sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),sourceUpdateBody(source).put("expectedAssetVersion","2")).andExpect(status().isOk());case "authority"->capabilities(null,java.util.Map.of("sync.manage","deny"));case "policy"->{var patch=json.createObjectNode().put("formatVersion",1).put("intentId",newIntent()).put("expectedRevision","0");patch.set("policy",json.createObjectNode().put("formatVersion",1).put("revision","1").put("scope","project").put("connectTimeoutMs",9000));sourceRequest("PUT","/policy",f.owner(),patch).andExpect(status().isOk());}case "asset"->editProjectWithCurrentVersion();}}finally{control("/release-resolve");}
        assertThat(pending.get(10,java.util.concurrent.TimeUnit.SECONDS)).isEqualTo(409);assertThat(applicationMutationCount(request.path("intentId").asText())).isZero();
    }
    void control(String path) throws Exception{java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(node.info.path("origin").asText()+path)).GET().build(),java.net.http.HttpResponse.BodyHandlers.discarding());}
}
