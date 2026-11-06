package com.autumnharvestc.server.sync;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import com.autumnharvestc.server.execution.materials.ProjectCredentialService;
import com.autumnharvestc.server.execution.ExecutionDtos.CredentialWrite;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.util.*;

class SyncCandidatesTest extends SyncCheckHttpFixture {
    @Autowired ProjectCredentialService credentials;
    @Autowired SyncMaterialService materials;
    @ParameterizedTest @ValueSource(strings={"auth","approval"})
    void durableFailureKeepsOnlyTheVerifiedFiniteSourceDiagnostic(String kind) throws Exception {
        checkToCandidate(createUrlSource("/fast"));var raw=sourceBody("url").put("url",node.info.path("origin").asText()+(kind.equals("auth")?"/auth":"/fast"));if(kind.equals("approval"))raw.put("url",raw.path("url").asText().replace("127.0.0.1","127.0.0.2"));var source=body(sourceRequest("POST","/sources",f.owner(),write(raw).put("expectedAssetVersion","2")).andExpect(status().isCreated()));var done=awaitCheck(submit(source,checkBody()).path("checkId").asText());assertThat(done.path("state").asText()).isEqualTo("failed");assertThat(done.path("detailCode").asText()).isEqualTo(kind.equals("auth")?"SYNC_HTTP_STATUS":"SYNC_NETWORK_DENIED");assertThat(done.toString()).doesNotContain("synthetic-t9","127.0.0.2",node.directory.toString());
    }
    @ParameterizedTest @ValueSource(strings={"version","header-extra","network-path"})
    void explicitMaterialCodecsRejectUnsupportedValuesBeforeAnySourceStart(String variant) throws Exception {
        var owner=users.findById(Long.parseLong(f.owner().id())).orElseThrow();String ref=variant.equals("network-path")?"network":"headers";
        var valid=variant.equals("network-path")?json.readTree("{\"formatVersion\":1,\"kind\":\"network-profile\",\"profile\":{\"kind\":\"direct\",\"name\":\"private test\",\"targetTlsBindings\":[]}}") :json.readTree("{\"formatVersion\":1,\"kind\":\"http-headers\",\"headers\":[{\"name\":\"Authorization\",\"value\":\"Bearer synthetic-t9\"}]}");
        credentials.put(owner,f.workspace(),f.project(),ref,new CredentialWrite("0",valid.toString()));var raw=sourceBody("url").put("url",node.info.path("origin").asText()+(variant.equals("network-path")?"/fast":"/auth")).put(variant.equals("network-path")?"networkProfileRef":"authRef",ref);var saved=body(sourceRequest("POST","/sources",f.owner(),write(raw).put("expectedAssetVersion","2")).andExpect(status().isCreated()));
        var plaintext=materials.resolve(owner,f.workspace(),f.project(),saved.path("id").asText(),"1","source-check",new com.autumnharvestc.server.execution.ExecutionDtos.CredentialSelection(ref,"1"));var decoded=json.readTree(plaintext.value());var privateRead=readPayload(saved);
        if(variant.equals("network-path")){var profile=(com.fasterxml.jackson.databind.node.ObjectNode)decoded.path("profile");profile.put("id",ref);privateRead.set("network",json.createObjectNode().put("kind","profile").put("revision","1").set("profile",profile));}else ((com.fasterxml.jackson.databind.node.ObjectNode)privateRead.path("material")).set("httpHeaders",decoded.path("headers"));
        var read=core.call("sync-read",privateRead,System.currentTimeMillis()+10000,32000000);assertThat(core.call("sync-plan",planning(saved,read,true),System.currentTimeMillis()+10000,32000000).path("candidate").path("changes").size()).isGreaterThan(0);
        var invalid=(com.fasterxml.jackson.databind.node.ObjectNode)valid.deepCopy();if(variant.equals("version"))invalid.put("formatVersion",2);if(variant.equals("header-extra"))((com.fasterxml.jackson.databind.node.ObjectNode)invalid.path("headers").get(0)).put("nativePath","C:/private/key");if(variant.equals("network-path"))((com.fasterxml.jackson.databind.node.ObjectNode)invalid.path("profile")).put("nativePath","C:/private/key");
        credentials.put(owner,f.workspace(),f.project(),ref,new CredentialWrite("1",invalid.toString()));int calls=sourceHostCalls();var done=awaitCheck(submit(saved,checkBody()).path("checkId").asText());assertThat(done.path("reasonCode").asText()).isEqualTo("material-invalid");assertThat(sourceHostCalls()).isEqualTo(calls);
    }
    @Test void versionedHeaderCodecUsesTheActualEncryptedBoundMaterial() throws Exception {
        checkToCandidate(createUrlSource("/fast"));var owner=users.findById(Long.parseLong(f.owner().id())).orElseThrow();
        credentials.put(owner,f.workspace(),f.project(),"headers",new CredentialWrite("0","{\"formatVersion\":1,\"kind\":\"http-headers\",\"headers\":[{\"name\":\"Authorization\",\"value\":\"Bearer synthetic-t9\"}]}"));
        var source=sourceBody("url").put("url",node.info.path("origin").asText()+"/auth").put("authRef","headers");var saved=body(sourceRequest("POST","/sources",f.owner(),write(source).put("expectedAssetVersion","2")).andExpect(status().isCreated()));assertThat(checkToCandidate(saved).path("applicable").asBoolean()).isTrue();
    }
    @ParameterizedTest @ValueSource(strings={"rotate","delete-recreate"})
    void materialLossDuringARealAuthenticatedReadCannotPublishOldMaterialResults(String mutation) throws Exception {
        versionedHeaderCodecUsesTheActualEncryptedBoundMaterial();var owner=users.findById(Long.parseLong(f.owner().id())).orElseThrow();String barrier=UUID.randomUUID().toString();var source=sourceBody("url").put("url",node.info.path("origin").asText()+"/auth/blocked/"+barrier).put("authRef","headers");var saved=body(sourceRequest("POST","/sources",f.owner(),write(source).put("expectedAssetVersion","2")).andExpect(status().isCreated()));var accepted=submit(saved,checkBody());awaitNode("received-"+barrier);
        try{if(mutation.equals("delete-recreate")){credentials.remove(owner,f.workspace(),f.project(),"headers","1");credentials.put(owner,f.workspace(),f.project(),"headers",new CredentialWrite("2","{\"formatVersion\":1,\"kind\":\"http-headers\",\"headers\":[]}"));}else credentials.put(owner,f.workspace(),f.project(),"headers",new CredentialWrite("1","rotated"));}finally{release(barrier);}
        var done=awaitCheck(accepted.path("checkId").asText());assertThat(done.path("state").asText()).isEqualTo("failed");assertThat(done.path("reasonCode").asText()).isEqualTo("material-changed");assertThat(done.path("candidateId").isNull()).isTrue();
    }
    @Test void syncAuthorizationLossAdvancesTheExistingResponsibilityLatch() throws Exception {
        checkToCandidate(createUrlSource("/fast"));var repo=new com.autumnharvestc.server.access.AccessRepo(jdbc);long w=Long.parseLong(f.workspace()),p=Long.parseLong(f.project()),a=Long.parseLong(editor().id());long before=repo.syncCheckEpoch(w,p,a),shared=repo.responsibilityEpoch(w,p,a);
        capabilities(null,Map.of("sync.check","deny"));capabilities(null,Map.of("sync.check","allow"));assertThat(repo.responsibilityEpoch(w,p,a)).isEqualTo(shared);assertThat(repo.syncCheckEpoch(w,p,a)).isGreaterThan(before);
    }
    @ParameterizedTest @ValueSource(strings={"assets","source","authority"})
    void completedCandidateApplicabilityChangesWithoutChangingFixedBytes(String mutation) throws Exception {
        var source=createUrlSource("/fast");var before=checkToCandidate(source);String id=before.path("candidate").path("id").asText();
        String fixed=jdbc.queryForObject("SELECT fixed_json FROM sync_candidates WHERE workspace_id=? AND project_id=? AND id=?",String.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()),id);
        switch(mutation){case "assets"->editProjectWithCurrentVersion();case "source"->sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),sourceUpdateBody(source).put("expectedAssetVersion","2")).andExpect(status().isOk());case "authority"->{capabilities(null,Map.of("sync.check","deny"));capabilities(null,Map.of("sync.check","allow"));}}
        var after=candidate(id);assertThat(after.path("applicable").asBoolean()).isFalse();assertThat(after.path("reasonCode").asText()).isEqualTo(switch(mutation){case "assets"->"project-assets-changed";case "source"->"source-revision-changed";default->"authorization-changed";});assertThat(after.path("candidate")).isEqualTo(before.path("candidate"));
        assertThat(jdbc.queryForObject("SELECT fixed_json FROM sync_candidates WHERE workspace_id=? AND project_id=? AND id=?",String.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()),id)).isEqualTo(fixed);
    }
    @ParameterizedTest @ValueSource(strings={"assets","source","authority","policy"})
    void changedSnapshotCannotPublishALateResult(String mutation) throws Exception {
        checkToCandidate(createUrlSource("/fast"));String barrier=UUID.randomUUID().toString();var source=createUrlSource("/blocked/"+barrier);var accepted=submit(source,checkBody());awaitNode("received-"+barrier);
        try{switch(mutation){case "assets"->editProjectWithCurrentVersion();case "source"->sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),sourceUpdateBody(source).put("expectedAssetVersion","2")).andExpect(status().isOk());case "authority"->{capabilities(null,Map.of("sync.check","deny"));capabilities(null,Map.of("sync.check","allow"));}case "policy"->{var request=json.createObjectNode().put("formatVersion",1).put("intentId",UUID.randomUUID().toString()).put("expectedRevision","0");request.set("policy",json.createObjectNode().put("formatVersion",1).put("scope","project").put("revision","1").put("connectTimeoutMs",9000));sourceRequest("PUT","/policy",f.owner(),request).andExpect(status().isOk());}}}finally{release(barrier);}
        var done=awaitCheck(accepted.path("checkId").asText());assertThat(done.path("state").asText()).isEqualTo("failed");assertThat(done.path("reasonCode").asText()).isEqualTo(switch(mutation){case "assets"->"project-assets-changed";case "source"->"source-revision-changed";case "policy"->"policy-changed";default->"authorization-changed";});assertThat(done.path("candidateId").isNull()).isTrue();
    }
    @Test void actual304ComparesCurrentProjectAndPreservesOldCandidate() throws Exception {
        var source=createUrlSource("/cache");var first=checkToCandidate(source);int old304=source304Responses();editProjectWithCurrentVersion();var accepted=submit(source,checkBody().put("expectedAssetVersion","3"));var done=awaitCheck(accepted.path("checkId").asText());assertThat(done.path("state").asText()).withFailMessage(done.toString()).isEqualTo("succeeded");var second=candidate(done.path("candidateId").asText());assertThat(source304Responses()).isEqualTo(old304+1);System.out.println("T9_304_FACTS current-project actual304="+source304Responses());assertThat(second.path("candidate").path("stamp").path("assetVersion").asText()).isEqualTo("3");assertThat(second.path("candidate").path("stamp").path("definitionRevision")).isNotEqualTo(first.path("candidate").path("stamp").path("definitionRevision"));assertThat(candidate(first.path("candidate").path("id").asText()).path("candidate")).isEqualTo(first.path("candidate"));
    }
    @Test void repeatedUpstreamCanReuseImmutableContentForANewCheck() throws Exception {var source=createUrlSource("/cache");var first=checkToCandidate(source);var second=checkToCandidate(source);assertThat(second.path("candidate")).isEqualTo(first.path("candidate"));}
    @Test void freshSuccessfulCheckRenewsDynamicExpiryWithoutChangingFixedBytesOrCreationTime() throws Exception {
        var source=createUrlSource("/cache");var first=checkToCandidate(source);int old304=source304Responses();String id=first.path("candidate").path("id").asText();long w=Long.parseLong(f.workspace()),p=Long.parseLong(f.project());var before=jdbc.queryForMap("SELECT fixed_json,created_at FROM sync_candidates WHERE workspace_id=? AND project_id=? AND id=?",w,p,id);
        jdbc.update("UPDATE sync_candidates SET expires_at=? WHERE workspace_id=? AND project_id=? AND id=?",new java.sql.Timestamp(System.currentTimeMillis()-1000),w,p,id);assertThat(candidate(id).path("reasonCode").asText()).isEqualTo("candidate-expired");var second=checkToCandidate(source);assertThat(source304Responses()).isEqualTo(old304+1);System.out.println("T9_304_FACTS expiry-renewal actual304="+source304Responses());assertThat(second.path("candidate")).isEqualTo(first.path("candidate"));assertThat(second.path("applicable").asBoolean()).isTrue();assertThat(jdbc.queryForMap("SELECT fixed_json,created_at FROM sync_candidates WHERE workspace_id=? AND project_id=? AND id=?",w,p,id)).isEqualTo(before);
    }
    @ParameterizedTest @ValueSource(strings={"rotate","delete"})
    void realCredentialLifecycleAdvancesGlobalFence(String mutation) throws Exception {
        var owner=users.findById(Long.parseLong(f.owner().id())).orElseThrow();long ws=Long.parseLong(f.workspace()),project=Long.parseLong(f.project());
        var accessRepo=new com.autumnharvestc.server.access.AccessRepo(jdbc);long before=accessRepo.projectRevision(ws,project);
        credentials.put(owner,f.workspace(),f.project(),"headers",new CredentialWrite("0","{\"formatVersion\":1,\"kind\":\"http-headers\",\"headers\":[{\"name\":\"Authorization\",\"value\":\"Bearer synthetic-t9\"}]}"));
        long registered=accessRepo.projectRevision(ws,project);
        if(mutation.equals("rotate"))credentials.put(owner,f.workspace(),f.project(),"headers",new CredentialWrite("1","changed"));else credentials.remove(owner,f.workspace(),f.project(),"headers","1");
        assertThat(accessRepo.projectRevision(ws,project)).isGreaterThan(registered);
    }
}
