package com.autumnharvestc.server.sync;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class SyncChecksTest extends SyncCheckHttpFixture {
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"replay","body","actor"})
    void intentReplayIsBoundToActorBodyAndReturnsTheOriginalDurableCheck(String variant) throws Exception {
        var source=createUrlSource("/fast");var request=checkBody();var first=submit(source,request);assertThat(awaitCheck(first.path("checkId").asText()).path("state").asText()).isEqualTo("succeeded");int calls=sourceHostCalls();
        if(variant.equals("replay")){assertThat(submit(source,request)).isEqualTo(first);assertThat(sourceHostCalls()).isEqualTo(calls);}
        if(variant.equals("body"))sourceRequest("POST","/sources/"+source.path("id").asText()+"/checks",editor(),request.deepCopy().put("expectedSourceRevision","2")).andExpect(status().isConflict());
        if(variant.equals("actor"))sourceRequest("POST","/sources/"+source.path("id").asText()+"/checks",f.owner(),request).andExpect(status().isForbidden());
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"source","assets","shape"})
    void newCheckRequiresCurrentExpectedVersionsAndStrictIntent(String invalid) throws Exception {
        var source=createUrlSource("/fast");checkToCandidate(source);var request=checkBody();if(invalid.equals("source"))request.put("expectedSourceRevision","0");if(invalid.equals("assets"))request.put("expectedAssetVersion","1");if(invalid.equals("shape"))request.put("rawSecret","not-a-field");int calls=sourceHostCalls();
        sourceRequest("POST","/sources/"+source.path("id").asText()+"/checks",editor(),request).andExpect(invalid.equals("shape")?status().isBadRequest():status().isConflict());assertThat(sourceHostCalls()).isEqualTo(calls);
    }
    @Test void durableLookupRediscoveriesUseFiniteSummariesAndNoPrivateContent() throws Exception {
        var source=createUrlSource("/fast");var accepted=submit(source,checkBody());var done=awaitCheck(accepted.path("checkId").asText());assertThat(done.path("state").asText()).isEqualTo("succeeded");
        var lookup=body(sourceRequest("GET","/checks?sourceId="+source.path("id").asText(),editor(),null).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk()));
        assertThat(lookup.path("latestAttempt").path("checkId")).isEqualTo(accepted.path("checkId"));assertThat(lookup.path("latestSuccess").path("candidateId")).isEqualTo(done.path("candidateId"));assertThat(lookup.toString()).doesNotContain("rawText","planInput","localFiles","privateRoot");
    }
    @Test void durableAcceptedCheckCreatesAnImmutableCandidateWithoutAnExecutionJob() throws Exception {
        var source=createUrlSource("/fast");
        var view=checkToCandidate(source);
        assertThat(view.path("candidate").path("stamp").path("assetVersion").asText()).isEqualTo("2");
        assertThat(view.path("candidate").path("stamp").path("definitionRevision").asText()).hasSize(64);
        assertThat(view.path("applicable").asBoolean()).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sync_checks WHERE workspace_id=? AND project_id=? AND state='succeeded'",Integer.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE workspace_id=? AND project_id=?",Integer.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()))).isZero();
    }
    @Test void actualDatabaseAssetsCompleteOnlineFingerprintInTheFiniteCorePlan() throws Exception {
        var source=createUrlSource("/fast");var read=actualRead(source);
        var positive=core.call("sync-plan",planning(source,read,true),System.currentTimeMillis()+10000,32000000);
        assertThat(positive.path("candidate").path("stamp").path("definitionRevision").asText()).hasSize(64);
        assertThat(positive.path("candidate").path("changes").size()).isGreaterThan(0);
        var result=assertDoesNotThrowOnline(source,read);
        assertThat(result.path("candidate").path("stamp").path("definitionRevision")).isEqualTo(positive.path("candidate").path("stamp").path("definitionRevision"));
        assertThat(result.path("candidate").path("stamp").path("assetVersion").asText()).isEqualTo("2");
    }
    private com.fasterxml.jackson.databind.JsonNode assertDoesNotThrowOnline(com.fasterxml.jackson.databind.JsonNode source,com.fasterxml.jackson.databind.JsonNode read){return org.junit.jupiter.api.Assertions.assertDoesNotThrow(()->core.call("sync-plan",planning(source,read,false),System.currentTimeMillis()+10000,32000000),"online DB metadata must acquire its semantic fingerprint inside sync-plan");}
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"files","budget","complete-stamp"})
    void onlineCompletionProtectionCorrectnessAfterImplementation(String variant) throws Exception {
        var source=createUrlSource("/fast");var read=actualRead(source);var input=planning(source,read,false);((com.fasterxml.jackson.databind.node.ObjectNode)input.path("budget")).put("maxCompareInputBytes",1048576);assertThat(core.call("sync-plan",input,System.currentTimeMillis()+10000,32000000).path("candidate").path("changes").size()).isGreaterThan(0);
        String code;
        if(variant.equals("files")){((com.fasterxml.jackson.databind.node.ObjectNode)input.path("localFiles").get(0)).put("content","invalid: [");code="SYNC_INVALID_FILES";}
        else if(variant.equals("budget")){((com.fasterxml.jackson.databind.node.ArrayNode)input.path("localFiles")).add(json.createObjectNode().put("path","large.txt").put("content","x".repeat(1100000)));code="SYNC_COMPARE_INPUT_BYTES_EXCEEDED";}
        else{input=planning(source,read,true);((com.fasterxml.jackson.databind.node.ObjectNode)input.path("stamp")).put("definitionRevision","f".repeat(64));code="SYNC_STAMP_MISMATCH";}
        var invalid=input;assertThatThrownBy(()->core.call("sync-plan",invalid,System.currentTimeMillis()+10000,32000000)).isInstanceOfSatisfying(com.autumnharvestc.server.collaboration.runtime.CollaborationRuntimeClient.Failure.class,error->assertThat(error.code()).isEqualTo(code));
    }
}
