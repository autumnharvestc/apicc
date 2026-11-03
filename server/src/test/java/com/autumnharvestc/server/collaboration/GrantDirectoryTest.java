package com.autumnharvestc.server.collaboration;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-t9-grant-directory;DB_CLOSE_DELAY=-1",
    "apicc.collaboration.policy.defaults.external-sharing-allowed=true", "apicc.collaboration.policy.defaults.shared-mock-allowed=true", "apicc.collaboration.public-access.enabled=true",
    "apicc.collaboration.public-access.port=0", "apicc.collaboration.public-access.base-url=http://127.0.0.1:18791"})
class GrantDirectoryTest extends ArtifactHttpFixture {
    @ParameterizedTest @ValueSource(strings={"sub-minute","above-policy","both","fractional","unsafe"})
    void round1RelativeDurationValidatesActualBoundsAndExclusiveExpiry(String mutation)throws Exception {
        var f=fixture();var publication=fixed(f);policy(f,true,Map.of("defaultShareDurationMs",90000,"maxShareDurationMs",120000));policy(f,false,Map.of("defaultShareDurationMs",90000,"maxShareDurationMs",120000));
        var command=json.createObjectNode().put("operationIntent",UUID.randomUUID().toString()).put("purpose","view").put("audience","members").put("expectedRevision",1).put("durationMs",60000);
        request(f.owner().token(),post(directory(f,publication)),command).andExpect(status().isCreated());command.put("operationIntent",UUID.randomUUID().toString());
        switch(mutation){case "sub-minute"->command.put("durationMs",59999);case "above-policy"->command.put("durationMs",120001);case "both"->command.put("expiresAt",artifactTime.now().toEpochMilli()+90000);case "fractional"->command.put("durationMs",60000.5);case "unsafe"->command.put("durationMs",9007199254740992L);default->throw new IllegalArgumentException(mutation);}
        request(f.owner().token(),post(directory(f,publication)),command).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("invalid_request"));
    }
    @Test void round1RelativeDurationStartsAtServerCreateTimeWithoutReplayExtension()throws Exception {
        var f=fixture();var publication=fixed(f);policy(f,true,Map.of("defaultShareDurationMs",90000,"maxShareDurationMs",120000,"externalSharingAllowed",true));policy(f,false,Map.of("defaultShareDurationMs",90000,"maxShareDurationMs",120000,"externalSharingAllowed",true));
        var command=json.createObjectNode().put("operationIntent",UUID.randomUUID().toString()).put("purpose","view").put("audience","external").put("expectedRevision",1).put("durationMs",60000);
        artifactTime.advance(275);long createdAt=artifactTime.now().toEpochMilli();
        var created=body(request(f.owner().token(),post(directory(f,publication)),command).andExpect(status().isCreated()));
        assertThat(created.path("key").asText()).isNotEmpty();
        org.junit.jupiter.api.Assertions.assertAll(()->assertThat(created.path("expiresAt").asLong()).isEqualTo(createdAt+60000),()->assertThat(created.path("revision").asLong()).isEqualTo(1));
        artifactTime.advance(1000);var replay=body(request(f.owner().token(),post(directory(f,publication)),command).andExpect(status().isOk()));
        assertThat(replay.path("id")).isEqualTo(created.path("id"));assertThat(replay.path("expiresAt")).isEqualTo(created.path("expiresAt"));assertThat(replay.has("key")).isFalse();
        command.put("durationMs",120000);request(f.owner().token(),post(directory(f,publication)),command).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("grant_intent_conflict"));
    }
    @Test void round1LegacyDefaultAndAbsoluteIntentFingerprintsRemainReplayCompatible()throws Exception {
        var f=fixture();var publication=fixed(f);
        for(boolean absolute:new boolean[]{false,true}) {
            String intent=UUID.randomUUID().toString();Long expiry=absolute?artifactTime.now().toEpochMilli()+120000:null;
            var command=json.createObjectNode().put("operationIntent",intent).put("purpose","view").put("audience","members").put("expectedRevision",1);if(expiry!=null)command.put("expiresAt",expiry);
            var created=body(request(f.owner().token(),post(directory(f,publication)),command).andExpect(status().isCreated()));
            String oldText=publication.path("id").asText()+":Create[intent="+intent+", purpose=view, audience=members, download=false, expiresAt="+expiry+", expectedRevision=1]";
            String expected=com.autumnharvestc.server.core.Hashes.sha256Hex(oldText.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertThat(jdbc.queryForObject("SELECT fingerprint FROM collaboration_grant_operations WHERE operation_intent=?",String.class,intent)).isEqualTo(expected);
            artifactTime.advance(1000);var replay=body(request(f.owner().token(),post(directory(f,publication)),command).andExpect(status().isOk()));assertThat(replay.path("id")).isEqualTo(created.path("id"));assertThat(replay.path("expiresAt")).isEqualTo(created.path("expiresAt"));assertThat(replay.has("key")).isFalse();
        }
    }
    JsonNode fixed(Fixture f)throws Exception{return publish(f,preview(f,f.owner(),documentRequest(f)),UUID.randomUUID().toString());}
    String directory(Fixture f,JsonNode publication){return collaboration(f)+"/publications/"+publication.path("id").asText()+"/grants";}
    JsonNode create(Fixture f,JsonNode publication,String audience)throws Exception {
        return body(request(f.owner().token(),post(directory(f,publication)),Map.of("operationIntent",UUID.randomUUID().toString(),"purpose","view","audience",audience,"expectedRevision",1)).andExpect(status().isCreated()));
    }
    JsonNode page(Fixture f,JsonNode publication)throws Exception{return body(mvc.perform(get(directory(f,publication)).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));}

    @Test void directoryRecoversSavedGrantMetadataAfterCreateResponseIsGone()throws Exception {
        var f=fixture();var publication=fixed(f);var created=create(f,publication,"members");
        var result=page(f,publication);
        assertThat(result.path("items").findValuesAsText("id")).containsExactly(created.path("id").asText());
        assertThat(result.path("nextCursor").asText()).isEmpty();
    }
    @Test void directoryRechecksTheSameCurrentManagementAuthorityAsReadById()throws Exception {
        var f=fixture();var publication=fixed(f);var grant=create(f,publication,"members");capability(f,f.editor(),"publication.manage","allow");
        mvc.perform(get(collaboration(f)+"/grants/"+grant.path("id").asText()).header("Authorization","Bearer "+f.editor().token())).andExpect(status().isOk());
        capability(f,f.editor(),"publication.manage","deny");
        mvc.perform(get(directory(f,publication)).header("Authorization","Bearer "+f.editor().token())).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
    }
    @Test void directoryRejectsARealPublicationInAnotherExistingProject()throws Exception {
        var f=fixture();var publication=fixed(f);create(f,publication,"members");
        mvc.perform(get("/api/v1/workspaces/"+f.workspace()+"/projects/"+f.other()+"/collaboration/publications/"+publication.path("id").asText()+"/grants").header("Authorization","Bearer "+f.owner().token()))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("publication_not_found"));
    }
    @Test void directoryUsesCurrentPolicyDefaultAndExplicitBoundedPage()throws Exception {
        var f=fixture();var publication=fixed(f);var first=create(f,publication,"members");var second=create(f,publication,"members");var third=create(f,publication,"members");
        policy(f,false,Map.of("defaultPageSize",1,"maxPageSize",2));
        var result=page(f,publication);
        assertThat(result.path("items").findValuesAsText("id")).containsExactly(third.path("id").asText());
        assertThat(result.path("nextCursor").asText()).isNotBlank();
        var explicit=body(mvc.perform(get(directory(f,publication)).param("limit","2").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        assertThat(explicit.path("items").findValuesAsText("id")).containsExactly(third.path("id").asText(),second.path("id").asText());
    }
    @ParameterizedTest @ValueSource(strings={"0","3","1.5","NaN","201"})
    void directoryRejectsOutOfPolicyPageSize(String limit)throws Exception {
        var f=fixture();var publication=fixed(f);var grant=create(f,publication,"members");policy(f,false,Map.of("defaultPageSize",1,"maxPageSize",2));
        assertThat(page(f,publication).path("items").findValuesAsText("id")).contains(grant.path("id").asText());
        mvc.perform(get(directory(f,publication)).param("limit",limit).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("invalid_request"));
    }
    @Test void directoryRejectsUnknownQueryAfterARealPositiveRead()throws Exception {
        var f=fixture();var publication=fixed(f);var grant=create(f,publication,"members");assertThat(page(f,publication).path("items").findValuesAsText("id")).contains(grant.path("id").asText());
        mvc.perform(get(directory(f,publication)).param("arbitrary","true").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("invalid_request"));
    }
    @Test void directoryNeverRecoversASecretAndKeepsMemberOnlyLocation()throws Exception {
        var f=fixture();var publication=fixed(f);policy(f,true,Map.of("externalSharingAllowed",true));policy(f,false,Map.of("externalSharingAllowed",true));
        var external=create(f,publication,"external");assertThat(external.hasNonNull("key")).isTrue();var member=create(f,publication,"members");
        var result=page(f,publication);assertThat(result.path("items").size()).isEqualTo(2);
        for(var item:result.path("items")){assertThat(item.has("key")).isFalse();assertThat(item.has("keyHash")).isFalse();assertThat(item.has("key_hash")).isFalse();}
        var memberView=result.path("items").get(0);assertThat(memberView.path("id").asText()).isEqualTo(member.path("id").asText());
        assertThat(memberView.path("memberPath").asText()).isEqualTo(collaboration(f)+"/publications/"+publication.path("id").asText());
        assertThat(memberView.has("publicId")).isFalse();assertThat(memberView.has("publicUrl")).isFalse();
    }
    @Test void directoryKeepsRevokedMetadataAndMatchesReportReadAuthority()throws Exception {
        var f=fixture();var publication=publish(f,preview(f,f.owner(),reportRequest(f)),UUID.randomUUID().toString());var grant=create(f,publication,"members");
        capability(f,f.editor(),"publication.manage","allow");capability(f,f.editor(),"history.read","deny");
        mvc.perform(get(collaboration(f)+"/grants/"+grant.path("id").asText()).header("Authorization","Bearer "+f.editor().token())).andExpect(status().isOk());
        var result=body(mvc.perform(get(directory(f,publication)).header("Authorization","Bearer "+f.editor().token())).andExpect(status().isOk()));
        assertThat(result.path("items").findValuesAsText("id")).containsExactly(grant.path("id").asText());
        request(f.owner().token(),delete(collaboration(f)+"/grants/"+grant.path("id").asText()),Map.of("expectedRevision",1)).andExpect(status().isNoContent());
        assertThat(page(f,publication).path("items").get(0).path("reason").asText()).isEqualTo("revoked");
    }
    JsonNode one(Fixture f,JsonNode publication,String cursor)throws Exception {
        var request=get(directory(f,publication)).param("limit","1").header("Authorization","Bearer "+f.owner().token());
        if(cursor!=null)request.param("cursor",cursor);return body(mvc.perform(request).andExpect(status().isOk()));
    }
    @Test void directoryContinuesTheActualStableCursorWithoutDuplicates()throws Exception {
        var f=fixture();var publication=fixed(f);var first=create(f,publication,"members");var second=create(f,publication,"members");var third=create(f,publication,"members");
        var head=one(f,publication,null);assertThat(head.path("items").findValuesAsText("id")).containsExactly(third.path("id").asText());assertThat(head.path("nextCursor").asText()).isNotBlank();
        var next=one(f,publication,head.path("nextCursor").asText());
        assertThat(next.path("items").findValuesAsText("id")).containsExactly(second.path("id").asText());
        var end=one(f,publication,next.path("nextCursor").asText());assertThat(end.path("items").findValuesAsText("id")).containsExactly(first.path("id").asText());assertThat(end.path("nextCursor").asText()).isEmpty();
    }
    @Test void directoryCursorExcludesANewGrantInsertedAfterItsHighWater()throws Exception {
        var f=fixture();var publication=fixed(f);create(f,publication,"members");create(f,publication,"members");
        var head=one(f,publication,null);assertThat(head.path("items").size()).isEqualTo(1);assertThat(head.path("nextCursor").asText()).isNotBlank();var later=create(f,publication,"members");
        assertThat(one(f,publication,head.path("nextCursor").asText()).path("items").findValuesAsText("id")).doesNotContain(later.path("id").asText());
    }
    @ParameterizedTest @ValueSource(strings={"publication","project","workspace","limit","malformed","extra","negative","overlong"})
    void directoryBindsAndValidatesAnActualPreviouslyIssuedCursor(String branch)throws Exception {
        var f=fixture();var publication=fixed(f);create(f,publication,"members");create(f,publication,"members");var head=one(f,publication,null);
        assertThat(head.path("items").size()).isEqualTo(1);String cursor=head.path("nextCursor").asText();assertThat(cursor).isNotBlank();
        String path=directory(f,publication),limit="1";
        if(branch.equals("publication")){var another=fixed(f);create(f,another,"members");path=directory(f,another);assertThat(page(f,another).path("items").size()).isEqualTo(1);}
        if(branch.equals("project")){
            var other=new Fixture(f.owner(),f.editor(),f.viewer(),f.workspace(),f.group(),f.other(),f.project(),f.assets(),f.job(),f.execution(),f.report(),f.agent(),f.agentToken());
            var another=fixed(other);create(other,another,"members");path=directory(other,another);assertThat(page(other,another).path("items").size()).isEqualTo(1);
        }
        if(branch.equals("workspace")){String decoded=new String(java.util.Base64.getUrlDecoder().decode(cursor),java.nio.charset.StandardCharsets.US_ASCII);String[] fields=decoded.split(":");fields[1]=String.valueOf(Long.parseLong(f.workspace())+1);cursor=java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(String.join(":",fields).getBytes(java.nio.charset.StandardCharsets.US_ASCII));}
        if(branch.equals("limit"))limit="2";
        if(branch.equals("malformed"))cursor="not-json";
        if(branch.equals("extra"))cursor=java.util.Base64.getUrlEncoder().withoutPadding().encodeToString((new String(java.util.Base64.getUrlDecoder().decode(cursor),java.nio.charset.StandardCharsets.US_ASCII)+":extra").getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        if(branch.equals("negative")){String decoded=new String(java.util.Base64.getUrlDecoder().decode(cursor),java.nio.charset.StandardCharsets.US_ASCII);String[] fields=decoded.split(":");fields[5]="-1";cursor=java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(String.join(":",fields).getBytes(java.nio.charset.StandardCharsets.US_ASCII));}
        if(branch.equals("overlong"))cursor="a".repeat(257);
        mvc.perform(get(path).param("limit",limit).param("cursor",cursor).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("collaboration_cursor_invalid"));
    }
    @ParameterizedTest @ValueSource(strings={"document","report","member-upload","mock"})
    void authorizedEditorPreviewGetsOnlyCapturedFiniteConstraints(String kind)throws Exception {
        var f=fixture();capability(f,f.editor(),"publication.manage","allow");capability(f,f.editor(),"history.read","allow");capability(f,f.editor(),"mock.manage","allow");
        policy(f,true,Map.of("sharedMockAllowed",true));
        policy(f,false,Map.ofEntries(Map.entry("sharedMockAllowed",true),Map.entry("defaultShareDurationMs",60000),Map.entry("maxShareDurationMs",120000),Map.entry("maxSourceBytes",1048576),Map.entry("maxArtifactBytes",65536),Map.entry("maxFieldBytes",512),Map.entry("maxEvidenceBytes",4096),Map.entry("memberUploadRetentionMs",86400000),Map.entry("inactiveArtifactRetentionMs",86400000)));
        var input=kind.equals("report")?reportRequest(f):documentRequest(f);
        if(kind.equals("mock"))((com.fasterxml.jackson.databind.node.ObjectNode)input.path("source")).put("kind","mock");
        if(kind.equals("member-upload")){
            var projected=preview(f,f.owner(),reportRequest(f)).path("artifact").deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)projected.path("source")).put("trust","member-claim");
            input=json.createObjectNode().put("title","Selected member report").put("includeEvidence",false);input.putObject("source").put("kind","member-upload").set("artifact",projected);
        }
        mvc.perform(get(f.url()+"/collaboration/policy").header("Authorization","Bearer "+f.editor().token())).andExpect(status().isForbidden());
        var candidate=preview(f,f.editor(),input);var c=candidate.path("constraints");
        org.junit.jupiter.api.Assertions.assertAll(
            ()->assertThat(c.path("defaultShareDurationMs").path("value").asLong()).isEqualTo(60000),
            ()->assertThat(c.path("maxShareDurationMs").path("value").asLong()).isEqualTo(120000),
            ()->assertThat(c.path("maxSourceBytes").path("value").asLong()).isEqualTo(1048576),
            ()->assertThat(c.path("maxArtifactBytes").path("value").asLong()).isEqualTo(65536),
            ()->assertThat(c.path("maxFieldBytes").path("value").asLong()).isEqualTo(512),
            ()->assertThat(c.path("maxEvidenceBytes").path("value").asLong()).isEqualTo(4096),
            ()->assertThat(c.path("memberUploadRetentionMs").path("value").asLong()).isEqualTo(86400000),
            ()->assertThat(c.path("inactiveArtifactRetentionMs").path("value").asLong()).isEqualTo(86400000),
            ()->assertThat(c.path("evidenceAllowed").path("value").isBoolean()).isTrue(),
            ()->assertThat(c.path("externalSharingAllowed").path("value").isBoolean()).isTrue(),
            ()->assertThat(c.path("externalDownloadAllowed").path("value").isBoolean()).isTrue(),
            ()->assertThat(c.path("defaultShareDurationMs").path("source").asText()).isEqualTo("project"));
        assertThat(c.size()).isEqualTo(11);for(var fact:c)assertThat(fact.properties().stream().map(Map.Entry::getKey).toList()).containsExactlyInAnyOrder("value","source");
        policy(f,false,Map.of("defaultShareDurationMs",120000));
        var reread=body(mvc.perform(get(collaboration(f)+"/previews/"+candidate.path("id").asText()).header("Authorization","Bearer "+f.editor().token())).andExpect(status().isOk()));
        assertThat(reread.path("constraints").path("defaultShareDurationMs").path("value").asLong()).isEqualTo(60000);
    }
    @Test void grantDirectoryGetsCurrentFiniteConstraintsWithoutAdminPolicyOrSourceRead()throws Exception {
        var f=fixture();var publication=publish(f,preview(f,f.owner(),reportRequest(f)),UUID.randomUUID().toString());create(f,publication,"members");
        capability(f,f.editor(),"publication.manage","allow");capability(f,f.editor(),"history.read","deny");policy(f,false,Map.of("defaultShareDurationMs",120000,"maxShareDurationMs",180000));
        mvc.perform(get(f.url()+"/collaboration/policy").header("Authorization","Bearer "+f.editor().token())).andExpect(status().isForbidden());
        var result=body(mvc.perform(get(directory(f,publication)).header("Authorization","Bearer "+f.editor().token())).andExpect(status().isOk()));var c=result.path("constraints");
        org.junit.jupiter.api.Assertions.assertAll(
            ()->assertThat(c.path("defaultShareDurationMs").path("value").asLong()).isEqualTo(120000),
            ()->assertThat(c.path("maxShareDurationMs").path("value").asLong()).isEqualTo(180000),
            ()->assertThat(c.path("defaultShareDurationMs").path("source").asText()).isEqualTo("project"),
            ()->assertThat(c.path("externalSharingAllowed").path("value").isBoolean()).isTrue(),
            ()->assertThat(c.path("externalDownloadAllowed").path("value").isBoolean()).isTrue());
        assertThat(c.size()).isEqualTo(4);for(var fact:c)assertThat(fact.properties().stream().map(Map.Entry::getKey).toList()).containsExactlyInAnyOrder("value","source");
    }
    @Test void previewConstraintsRemainFromTheSavedCandidateAfterPolicyChanges()throws Exception {
        var f=fixture();capability(f,f.editor(),"publication.manage","allow");policy(f,false,Map.of("defaultShareDurationMs",60000));
        var candidate=preview(f,f.editor(),documentRequest(f));assertThat(candidate.path("state").asText()).isEqualTo("pending");
        policy(f,false,Map.of("defaultShareDurationMs",120000));
        var current=body(mvc.perform(get(f.url()+"/collaboration/policy").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        assertThat(current.path("settings").findValuesAsText("code")).contains("defaultShareDurationMs");
        var saved=body(mvc.perform(get(collaboration(f)+"/previews/"+candidate.path("id").asText()).header("Authorization","Bearer "+f.editor().token())).andExpect(status().isOk()));
        assertThat(saved.path("constraints").path("defaultShareDurationMs").path("value").asLong()).isEqualTo(60000);
    }
}
