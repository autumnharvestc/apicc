package com.autumnharvestc.server.sync;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class SyncReviewBoundariesTest extends SyncApplicationHttpFixture {
    @ParameterizedTest @ValueSource(booleans={true,false})
    void currentCheckAndApplyCapabilitiesRemainIndependent(boolean applyOnly) throws Exception {
        capabilities(null,Map.of("sync.check",applyOnly?"deny":"allow","sync.apply",applyOnly?"allow":"deny"));
        var source=createUrlSource("/fast");
        var accepted=body(sourceRequest("POST","/sources/"+source.path("id").asText()+"/checks",f.owner(),checkBody()).andExpect(status().isAccepted()));
        var completed=awaitCheckAs(accepted.path("checkId").asText(),f.owner());
        assertThat(completed.path("state").asText()).isEqualTo("succeeded");
        var view=candidate(completed.path("candidateId").asText());
        var request=application(view);
        if(applyOnly){
            sourceRequest("POST","/sources/"+source.path("id").asText()+"/checks",editor(),checkBody()).andExpect(status().isForbidden());
            sourceRequest("POST","/applications",editor(),request).andExpect(status().isOk());
            assertThat(currentVersion()).isEqualTo("3");
        }else{
            sourceRequest("POST","/applications",editor(),request).andExpect(status().isForbidden());
            assertThat(currentVersion()).isEqualTo("2");
            assertThat(awaitCheck(submit(source,checkBody()).path("checkId").asText()).path("state").asText()).isEqualTo("succeeded");
        }
    }

    @Test void aNewSuccessfulResultExpiresOnlyOlderCandidatesOfTheSameSource() throws Exception {
        String upstream=UUID.randomUUID().toString();var source=createUrlSource("/changing/"+upstream);
        var first=checkToCandidate(source);String firstId=id(first);var fixed=stored(firstId);var application=application(first);
        var other=checkToCandidate(createUrlSource("/unrelated/"+UUID.randomUUID()));
        revision(upstream,"B");var second=checkToCandidate(source);
        assertThat(id(second)).isNotEqualTo(firstId);
        assertThat(candidate(firstId).path("reasonCode").asText()).isEqualTo("candidate-expired");
        assertThat(candidate(id(other)).path("applicable").asBoolean()).isTrue();
        assertThat(candidate(firstId).path("candidate")).isEqualTo(first.path("candidate"));
        assertThat(stored(firstId)).isEqualTo(fixed);
        var rejected=body(sourceRequest("POST","/applications",editor(),application).andExpect(status().isConflict()));
        assertThat(rejected.path("code").asText()).isEqualTo("candidate-expired");
        assertThat(currentVersion()).isEqualTo("2");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sync_history WHERE project_id=?",Integer.class,Long.parseLong(f.project()))).isZero();
    }

    @Test void returningToAnExistingDeterministicCandidateExpiresTheInterveningResult() throws Exception {
        String upstream=UUID.randomUUID().toString();var source=createUrlSource("/changing/"+upstream);
        var first=checkToCandidate(source);String firstId=id(first);var fixed=stored(firstId);long firstExpiry=expiry(firstId);
        assertThat(checkToCandidate(source).path("candidate")).isEqualTo(first.path("candidate"));
        assertThat(expiry(firstId)).isGreaterThan(firstExpiry);
        revision(upstream,"B");var second=checkToCandidate(source);assertThat(id(second)).isNotEqualTo(firstId);
        revision(upstream,"A");var returned=checkToCandidate(source);
        assertThat(returned.path("candidate")).isEqualTo(first.path("candidate"));
        assertThat(returned.path("applicable").asBoolean()).isTrue();
        assertThat(stored(firstId)).isEqualTo(fixed);
        assertThat(candidate(id(second)).path("reasonCode").asText()).isEqualTo("candidate-expired");
    }

    @ParameterizedTest @ValueSource(strings={"source","capability","member","rotate","delete"})
    void invalidatedSnapshotCollectsTheActualReadBeforeTheSourceIsReleased(String mutation) throws Exception {
        String barrier=UUID.randomUUID().toString();var raw=sourceBody("url").put("url",node.info.path("origin").asText()+"/blocked/"+barrier);
        if(Set.of("rotate","delete").contains(mutation)){
            credential("0");raw.put("authRef","headers").put("url",node.info.path("origin").asText()+"/auth/blocked/"+barrier);
        }
        var source=body(sourceRequest("POST","/sources",f.owner(),write(raw).put("expectedAssetVersion","2")).andExpect(status().isCreated()));
        String check=submit(source,checkBody()).path("checkId").asText();awaitNode("received-"+barrier);
        try{
            var initial=lease(check);long renewalBound=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);
            while(!lease(check).isAfter(initial)&&System.nanoTime()<renewalBound)Thread.sleep(10);
            assertThat(lease(check)).as("A valid held read renews before any invalidation").isAfter(initial);
            assertThat(java.nio.file.Files.exists(node.directory.resolve("collected-"+barrier))).isFalse();
            int calls=sourceHostCalls();
            switch(mutation){
                case "source"->{var update=sourceUpdateBody(source).put("expectedAssetVersion","2");((com.fasterxml.jackson.databind.node.ObjectNode)update.path("source")).put("url",node.info.path("origin").asText()+"/updated/"+barrier);sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),update).andExpect(status().isOk());}
                case "capability"->capabilities(null,Map.of("sync.check","deny"));
                case "member"->{var member=body(mvc.perform(get(f.workspaceUrl()+"/access-members/"+editor().id()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));mvc.perform(delete(f.workspaceUrl()+"/members/"+editor().id()).param("expectedRevision",member.path("revision").asText()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());}
                case "rotate"->credential("1");
                case "delete"->mvc.perform(delete(f.projectUrl()+"/credentials/headers").param("expectedVersion","1").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
            }
            long changed=System.nanoTime();boolean collected=awaitCollected(barrier,6);
            System.out.println("SYNC_INVALIDATION mutation="+mutation+" check="+check+" collectedBeforeRelease="+collected+" elapsedMs="+TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-changed)+" nodeDirectory="+node.directory);
            assertThat(collected).as("Invalidation must collect the real source within six seconds without releasing its barrier").isTrue();
            var done=awaitCheckAs(check,f.owner());assertThat(done.path("state").asText()).isEqualTo("failed");
            assertThat(done.path("reasonCode").asText()).isEqualTo(switch(mutation){case "source"->"source-revision-changed";case "rotate","delete"->"material-changed";default->"authorization-changed";});
            assertThat(done.path("candidateId").isNull()).isTrue();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sync_candidates WHERE project_id=? AND source_id=?",Integer.class,Long.parseLong(f.project()),source.path("id").asText())).isZero();
            assertThat(sourceHostCalls()).as("Invalidation does not replay the source").isEqualTo(calls);
        }finally{release(barrier);}
    }

    String id(JsonNode view){return view.path("candidate").path("id").asText();}
    Map<String,Object> stored(String id){return jdbc.queryForMap("SELECT fixed_json,created_at FROM sync_candidates WHERE workspace_id=? AND project_id=? AND id=?",Long.parseLong(f.workspace()),Long.parseLong(f.project()),id);}
    long expiry(String id){return jdbc.queryForObject("SELECT expires_at FROM sync_candidates WHERE workspace_id=? AND project_id=? AND id=?",java.sql.Timestamp.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()),id).getTime();}
    Instant lease(String check){return jdbc.queryForObject("SELECT lease_until_utc FROM sync_checks WHERE workspace_id=? AND project_id=? AND id=?",OffsetDateTime.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()),check).toInstant();}
    void revision(String upstream,String value) throws Exception {java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(node.info.path("origin").asText()+"/set-revision/"+upstream+"/"+value)).GET().build(),java.net.http.HttpResponse.BodyHandlers.discarding());}
    void credential(String expected) throws Exception {mvc.perform(put(f.projectUrl()+"/credentials/headers").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(json.writeValueAsString(Map.of("expectedVersion",expected,"value","{\"formatVersion\":1,\"kind\":\"http-headers\",\"headers\":[{\"name\":\"Authorization\",\"value\":\"Bearer synthetic-t9\"}]}")))).andExpect(status().isOk());}
    boolean awaitCollected(String barrier,int seconds) throws Exception {long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(seconds);while(System.nanoTime()<until){if(java.nio.file.Files.exists(node.directory.resolve("collected-"+barrier)))return true;Thread.sleep(10);}return java.nio.file.Files.exists(node.directory.resolve("collected-"+barrier));}
}
