package com.autumnharvestc.server.collaboration;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-collaboration-t7-life;DB_CLOSE_DELAY=-1",
    "apicc.collaboration.policy.defaults.external-sharing-allowed=true",
    "apicc.collaboration.public-access.enabled=true", "apicc.collaboration.public-access.port=0",
    "apicc.collaboration.public-access.base-url=http://127.0.0.1:18793"})
class GrantLifecycleTest extends GrantHttpFixture {
    @Test void finalAccessFailureKeepsAuthorizedReadAndReportsMissingObservations()throws Exception{
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));
        ArtifactRetentionTest.AuditFault.attempts.set(0);jdbc.execute("CREATE TRIGGER final_access_fault BEFORE INSERT ON collaboration_management_audit FOR EACH ROW CALL '"+ArtifactRetentionTest.AuditFault.class.getName()+"'");
        try{
            readable(grant);var audit=body(request(f.owner().token(),get(collaboration(f)+"/audit"),Map.of()).andExpect(status().isOk()));
            org.junit.jupiter.api.Assertions.assertAll(()->assertThat(ArtifactRetentionTest.AuditFault.attempts.get()).isEqualTo(1),()->assertThat(audit.at("/accessDetails/state").asText()).isEqualTo("observations-missing"));
        }finally{jdbc.execute("DROP TRIGGER IF EXISTS final_access_fault");}
    }
    @Test void finalAccessRetentionDoesNotEraseManagementAndCannotSpendReleaseReservations()throws Exception{
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external").put("durationMs",90L*86400000));readable(grant);
        var softly=new org.assertj.core.api.SoftAssertions();long ws=Long.parseLong(f.workspace()),project=Long.parseLong(f.project());
        long observedUntil=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        while(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE workspace_id=? AND project_id=? AND event_json LIKE '%PUBLIC_%'",Long.class,ws,project)==0 && System.nanoTime()<observedUntil)Thread.sleep(10);
        softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE workspace_id=? AND project_id=? AND event_json LIKE '%PUBLIC_%'",Long.class,ws,project)).isEqualTo(1);
        artifactTime.advance(7L*86400000);storage.cleanup(ws,project);
        softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE workspace_id=? AND project_id=? AND event_json LIKE '%PUBLIC_%'",Long.class,ws,project)).isZero();
        softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE workspace_id=? AND project_id=? AND event_json LIKE '%GRANT_CREATED%'",Long.class,ws,project)).isEqualTo(1);
        deployment.setDefaults(json.convertValue(Map.of("externalSharingAllowed",true,"maxPreviewsPerPerson",20),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));
        for(int index=0;index<8;index++){
            var control=preview(f,f.owner(),documentRequest(f).put("title",""));int overhead=json.writeValueAsBytes(control.path("artifact")).length;
            preview(f,f.owner(),documentRequest(f).put("title","x".repeat(8388608-overhead)));
        }
        var usage=storage.usage(0,0);assertThat(usage.occupiedBytes()).isGreaterThanOrEqualTo(64L*1048576);assertThat(usage.reservedAuditBytes()).isPositive();
        deployment.setDeployment(json.convertValue(Map.of("deploymentMaxStorageBytes",usage.occupiedBytes()),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Deployment.class));
        try{
            readable(grant);softly.assertThat(storage.usage(0,0)).isEqualTo(usage);
            var audit=body(request(f.owner().token(),get(collaboration(f)+"/audit"),Map.of()).andExpect(status().isOk()));softly.assertThat(audit.at("/accessDetails/state").asText()).isEqualTo("observations-missing");
            request(f.owner().token(),delete(collaboration(f)+"/grants/"+grant.path("id").asText()),Map.of("expectedRevision",1)).andExpect(status().isNoContent());
        }finally{deployment.setDeployment(null);}
        softly.assertAll();
    }
    @Test void finalAccessDetailsAreChargedAnonymousFiniteAndIndependentFromManagement()throws Exception{
        var f=fixture();var publication=fixedDocument(f);deployment.setDefaults(json.convertValue(Map.of("externalSharingAllowed",true,"externalDownloadAllowed",true),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));
        policy(f,true,Map.of("externalDownloadAllowed",true));policy(f,false,Map.of("externalDownloadAllowed",true));
        var grant=createGrant(f,publication,grantCommand("view","external").put("downloadAllowed",true));readable(grant);
        assertThat(readPath("/share-api/"+grant.path("publicId").asText()+"/download","X-Apicc-Share-Key",grant.path("key").asText(),null).statusCode()).isEqualTo(200);
        var audit=body(request(f.owner().token(),get(collaboration(f)+"/audit"),Map.of()).andExpect(status().isOk()));
        var details=new ArrayList<com.fasterxml.jackson.databind.JsonNode>();for(var row:audit.path("collaboration"))if(row.path("action").asText().startsWith("PUBLIC_"))details.add(row);
        var softly=new org.assertj.core.api.SoftAssertions();softly.assertThat(details).hasSize(2);softly.assertThat(audit.at("/accessDetails/state").asText()).isEqualTo("bounded");
        for(var row:details){softly.assertThat(row.path("actorId").isNull()).isTrue();softly.assertThat(row.path("objectId").asText()).isEqualTo(publication.path("id").asText());softly.assertThat(row.toString()).doesNotContain(grant.path("key").asText(),grant.path("publicId").asText(),"http","/share-api");}
        softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE kind='AUDIT' AND metadata_json LIKE '%PUBLIC_%' AND workspace_id=? AND project_id=?",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()))).isEqualTo(2);
        policy(f,false,Map.of("accessAuditRetentionMs",0));readable(grant);var disabled=body(request(f.owner().token(),get(collaboration(f)+"/audit"),Map.of()).andExpect(status().isOk()));softly.assertThat(disabled.at("/accessDetails/state").asText()).isEqualTo("disabled");
        storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE workspace_id=? AND project_id=? AND event_json LIKE '%PUBLIC_%'",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()))).isZero();
        softly.assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE workspace_id=? AND project_id=? AND event_json LIKE '%GRANT_CREATED%'",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()))).isEqualTo(1);softly.assertAll();
    }
    static final int PUBLIC_PORT=loopbackPort();
    @org.springframework.test.context.DynamicPropertySource static void publicOrigin(org.springframework.test.context.DynamicPropertyRegistry registry){registry.add("apicc.collaboration.public-access.port",()->PUBLIC_PORT);registry.add("apicc.collaboration.public-access.base-url",()->"http://127.0.0.1:"+PUBLIC_PORT);}
    @BeforeEach void defaults(){deployment.setDefaults(json.convertValue(Map.of("externalSharingAllowed",true),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));}
    @ParameterizedTest @ValueSource(strings={"missing","wrong","other-version","other-project","mock-purpose","random-id","query"})
    void invalidKeyAndBindingAreIndistinguishable(String branch)throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        String id=grant.path("publicId").asText(),key=grant.path("key").asText();
        if(branch.equals("missing"))key=null;
        if(branch.equals("wrong"))key="A".repeat(43);
        if(branch.equals("random-id"))id="A".repeat(22);
        if(branch.equals("query")){id+="?key="+key;key=null;}
        if(branch.equals("other-version")){var second=publish(f,preview(f,f.owner(),documentRequest(f)),UUID.randomUUID().toString());assertThat(second.path("version").asLong()).isGreaterThan(publication.path("version").asLong());key=createGrant(f,second,grantCommand("view","external")).path("key").asText();}
        if(branch.equals("other-project")){var other=fixture();var second=fixedDocument(other);key=createGrant(other,second,grantCommand("view","external")).path("key").asText();}
        if(branch.equals("mock-purpose")){var mock=fixedMock(f);key=createGrant(f,mock,grantCommand("call","external").put("expectedRevision",mock.path("revision").asLong())).path("key").asText();}
        var response=readPath("/share-api/"+id,"X-Apicc-Share-Key",key,null);result(response,404,"share_unavailable");
        assertThat(response.body()).doesNotContain("Synthetic fixed document",grant.path("key").asText());
    }
    @Test void rotationActuallyRejectsOriginalHttpKeyAndDoesNotReplayPlaintext()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var first=createGrant(f,publication,grantCommand("view","external"));readable(first);
        String oldKey=first.path("key").asText();String publicUrl=first.path("publicUrl").asText().replace("/s/","/share-api/");
        String intent=UUID.randomUUID().toString();var input=Map.of("operationIntent",intent,"expectedRevision",1);
        var rotated=body(request(f.owner().token(),post(collaboration(f)+"/grants/"+first.path("id").asText()+"/rotate"),input).andExpect(status().isCreated()));
        var response=java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(publicUrl)).header("X-Apicc-Share-Key",oldKey).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertAll(()->assertThat(rotated.path("key").asText()).matches("[A-Za-z0-9_-]{43}").isNotEqualTo(oldKey),
            ()->result(response,404,"share_unavailable"),()->assertThat(response.body()).doesNotContain(oldKey),()->assertThat(response.body()).doesNotContain("Synthetic fixed document"));
        readable(rotated);
        var replay=body(request(f.owner().token(),post(collaboration(f)+"/grants/"+first.path("id").asText()+"/rotate"),input).andExpect(status().isOk()));
        assertThat(replay.hasNonNull("key")).isFalse();assertThat(replay.path("generation").asLong()).isEqualTo(2);
    }
    @ParameterizedTest @ValueSource(strings={"revoked","expired","publication_disabled"})
    void verifiedKeyExplainsOnlyFiniteInactiveReason(String reason)throws Exception {
        var f=fixture();var publication=fixedDocument(f);var input=grantCommand("view","external").put("expiresAt",artifactTime.now().toEpochMilli()+60000);
        var grant=createGrant(f,publication,input);readable(grant);
        if(reason.equals("revoked"))request(f.owner().token(),delete(collaboration(f)+"/grants/"+grant.path("id").asText()),Map.of("expectedRevision",1)).andExpect(status().isNoContent());
        if(reason.equals("expired"))artifactTime.advance(60000);
        if(reason.equals("publication_disabled"))request(f.owner().token(),patch(collaboration(f)+"/publications/"+publication.path("id").asText()),Map.of("expectedRevision",1,"enabled",false)).andExpect(status().isOk());
        inactive(read(grant,grant.path("key").asText()),reason);
        result(read(grant,"A".repeat(43)),404,"share_unavailable");
    }
    @Test void defaultDownloadIsClosedAndExplicitDownloadContainsOnlySavedSafeBody()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        result(readPath("/share-api/"+grant.path("publicId").asText()+"/download","X-Apicc-Share-Key",grant.path("key").asText(),null),404,"share_unavailable");
    }
    @Test void explicitDownloadHasAttachmentAndNeverContainsAccessSecret()throws Exception {
        var f=fixture();var publication=fixedDocument(f);
        deployment.setDefaults(json.convertValue(Map.of("externalSharingAllowed",true,"externalDownloadAllowed",true),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));
        policy(f,true,Map.of("externalDownloadAllowed",true));policy(f,false,Map.of("externalDownloadAllowed",true));
        var grant=createGrant(f,publication,grantCommand("view","external").put("downloadAllowed",true));readable(grant);
        var response=readPath("/share-api/"+grant.path("publicId").asText()+"/download","X-Apicc-Share-Key",grant.path("key").asText(),null);
        assertThat(response.statusCode()).isEqualTo(200);assertThat(response.headers().firstValue("Content-Disposition").orElse("")).contains("attachment");
        assertThat(response.body()).doesNotContain(grant.path("key").asText());assertThat(json.readTree(response.body()).path("kind").asText()).isEqualTo("document");
    }
    @Test void mockUsesDedicatedKeyAndMembersNeedCurrentIdentity()throws Exception {
        var f=fixture();var publication=fixedMock(f);var member=createGrant(f,publication,grantCommand("call","members").put("expectedRevision",2));
        var document=fixedDocument(f);var view=createGrant(f,document,grantCommand("view","external"));readable(view);
        String path="/mock/"+member.path("publicId").asText()+"/synthetic";
        var valid=readPath(path,"X-Apicc-Mock-Key",member.path("key").asText(),f.viewer().token());
        var anonymous=readPath(path,"X-Apicc-Mock-Key",member.path("key").asText(),null);
        var wrong=readPath(path,"X-Apicc-Mock-Key",view.path("key").asText(),f.viewer().token());
        request(f.owner().token(),put(f.url()+"/access-members/"+f.viewer().id()),Map.of("expectedRevision",0,"role","NONE")).andExpect(status().isOk());
        var lost=readPath(path,"X-Apicc-Mock-Key",member.path("key").asText(),f.viewer().token());
        assertAll(()->result(valid,503,"collaboration_mock_unavailable"),()->result(anonymous,401,"unauthorized"),()->result(wrong,404,"share_unavailable"),()->result(lost,403,"forbidden"));
        assertThat(valid.body()).doesNotContain("sourceProjectRevision","keyHash",member.path("key").asText());
    }
    @ParameterizedTest @ValueSource(strings={"removed","disabled","management","history","content","default"})
    void responsibilityLossAndRegainNeverRevivesOriginalSecret(String branch)throws Exception {
        var f=fixture();JsonNode publication=fixedDocument(f);Actor responsible=f.owner();
        if(Set.of("removed","disabled","management","history").contains(branch)){
            responsible=f.editor();capability(f,responsible,"publication.manage","allow");
            if(branch.equals("history"))publication=publish(f,preview(f,f.owner(),reportRequest(f)),UUID.randomUUID().toString());
        }
        var grant=body(request(responsible.token(),post(createPath(f,publication)),grantCommand("view","external")).andExpect(status().isCreated()));
        assertThat(read(grant,grant.path("key").asText()).statusCode()).isEqualTo(200);
        if(branch.equals("removed")){
            String member="/api/v1/workspaces/"+f.workspace()+"/members/"+responsible.id();
            long revision=body(mvc.perform(get("/api/v1/workspaces/"+f.workspace()+"/access-members/"+responsible.id()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();
            mvc.perform(delete(member).param("expectedRevision",String.valueOf(revision)).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
            request(f.owner().token(),put(member),Map.of("expectedRevision",revision+1,"role","EDITOR")).andExpect(status().isOk());capability(f,responsible,"publication.manage","allow");
        }else if(branch.equals("disabled")){
            String platform=login("admin","admin-pass-2026");long revision=jdbc.queryForObject("SELECT state_revision FROM users WHERE id=?",Long.class,responsible.account().id());
            request(platform,post("/api/v1/admin/users/"+responsible.id()+"/disable"),Map.of("expectedRevision",revision)).andExpect(status().isNoContent());
            request(platform,post("/api/v1/admin/users/"+responsible.id()+"/enable"),Map.of("expectedRevision",revision+1)).andExpect(status().isNoContent());
        }else if(branch.equals("content")){
            String path=f.url()+"/access-members/"+responsible.id();
            request(f.owner().token(),put(path),Map.of("expectedRevision",0,"role","NONE")).andExpect(status().isOk());
            request(f.owner().token(),put(path),Map.of("expectedRevision",1,"action","confirm-inheritance")).andExpect(status().isOk());
        }else if(branch.equals("default")){
            String path=f.url()+"/access-policy";request(f.owner().token(),put(path),Map.of("expectedRevision",0,"defaults",Map.of("publication.manage","deny"))).andExpect(status().isOk());
            request(f.owner().token(),put(path),Map.of("expectedRevision",1,"defaults",Map.of("publication.manage","inherit"))).andExpect(status().isOk());
        }else{
            String code=branch.equals("history")?"history.read":"publication.manage";capability(f,responsible,code,"deny");capability(f,responsible,code,"allow");
        }
        var response=read(grant,grant.path("key").asText());
        assertAll(()->inactive(response,"responsibility_changed"),()->assertThat(jdbc.queryForObject("SELECT reason FROM collaboration_grants WHERE id=?",String.class,grant.path("id").asLong())).isEqualTo("responsibility_changed"));
        var fresh=createGrant(f,publication,grantCommand("view","external"));assertThat(read(fresh,fresh.path("key").asText()).statusCode()).isEqualTo(200);
    }
    @ParameterizedTest @ValueSource(strings={"external","duration","sensitive"})
    void actualPolicyTighteningAndLooseningBetweenReadsNeverRevivesSecret(String branch)throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        if(branch.equals("external")){policy(f,false,Map.of("externalSharingAllowed",false));policy(f,false,Map.of("externalSharingAllowed",true));}
        if(branch.equals("duration")){policy(f,false,Map.of("maxShareDurationMs",60000,"defaultShareDurationMs",60000));policy(f,false,Map.of("maxShareDurationMs",90L*86400000,"defaultShareDurationMs",7L*86400000));}
        if(branch.equals("sensitive")){policy(f,false,Map.of("extraSensitiveHeaders",List.of("x-new-private")));policy(f,false,Map.of("extraSensitiveHeaders",List.of()));}
        inactive(read(grant,grant.path("key").asText()),"policy_changed");
    }
    @Test void unrelatedPolicyEditDoesNotInvalidateSavedProjection()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        policy(f,false,Map.of("defaultPageSize",25));readable(grant);
    }
    @ParameterizedTest @ValueSource(strings={"stale","unknown","expired"}) void rotateHasCurrentCasAndCannotReviveExpiredGrant(String branch)throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external").put("expiresAt",artifactTime.now().toEpochMilli()+60000));readable(grant);
        var command=json.createObjectNode().put("operationIntent",UUID.randomUUID().toString()).put("expectedRevision",branch.equals("stale")?0:1);
        if(branch.equals("unknown"))command.put("expiryExtension",true);if(branch.equals("expired"))artifactTime.advance(60000);
        request(f.owner().token(),post(collaboration(f)+"/grants/"+grant.path("id").asText()+"/rotate"),command)
            .andExpect(status().is(branch.equals("unknown")?400:409)).andExpect(jsonPath("$.code").value(branch.equals("unknown")?"invalid_request":branch.equals("stale")?"grant_revision_conflict":"grant_inactive"));
    }
    @Test void rotateIntentReconcilesAndMemberViewCannotGainForwardableSecret()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        var input=Map.of("expectedRevision",1,"operationIntent",UUID.randomUUID().toString());
        request(f.owner().token(),post(collaboration(f)+"/grants/"+grant.path("id").asText()+"/rotate"),input).andExpect(status().isCreated());
        var replay=request(f.owner().token(),post(collaboration(f)+"/grants/"+grant.path("id").asText()+"/rotate"),input).andReturn().getResponse();
        var member=createGrant(f,publication,grantCommand("view","members"));
        var refused=request(f.owner().token(),post(collaboration(f)+"/grants/"+member.path("id").asText()+"/rotate"),Map.of("expectedRevision",1,"operationIntent",UUID.randomUUID().toString())).andReturn().getResponse();
        assertAll(()->assertThat(replay.getStatus()).isEqualTo(200),()->assertThat(refused.getStatus()).isEqualTo(400));
    }
    @Test void rotateChecksCurrentQuotaAndRevisionExhaustion()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);createGrant(f,publication,grantCommand("view","external"));policy(f,false,Map.of("maxProjectActiveGrants",1));
        request(f.owner().token(),post(collaboration(f)+"/grants/"+grant.path("id").asText()+"/rotate"),Map.of("expectedRevision",1,"operationIntent",UUID.randomUUID().toString()))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("collaboration_grant_limit"));
    }
    @Test void revisionExhaustionCannotWrapGrantOrSecretGeneration()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        jdbc.update("UPDATE collaboration_grants SET revision=9007199254740991,generation=9007199254740991 WHERE id=?",grant.path("id").asLong());
        request(f.owner().token(),post(collaboration(f)+"/grants/"+grant.path("id").asText()+"/rotate"),Map.of("expectedRevision",9007199254740991L,"operationIntent",UUID.randomUUID().toString()))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("grant_revision_exhausted"));
    }
    public static class AuditFault implements org.h2.api.Trigger {
        @Override public void fire(java.sql.Connection connection,Object[] oldRow,Object[] newRow)throws java.sql.SQLException {throw new java.sql.SQLException("Synthetic T7 management audit failure","45000");}
    }
    @Test void qualificationLossJoinsGrantReferenceAccountingAndAuditTransaction()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        String path=f.url()+"/access-members/"+f.owner().id();long revision=body(mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();
        var before=storage.usage(Long.parseLong(f.workspace()),Long.parseLong(f.project()));
        jdbc.execute("CREATE TRIGGER t7_lifecycle_audit_fault BEFORE INSERT ON collaboration_management_audit FOR EACH ROW CALL '"+AuditFault.class.getName()+"'");
        try{
            request(f.owner().token(),put(path),Map.of("expectedRevision",revision,"capabilities",Map.of("publication.manage","deny"))).andExpect(status().isInternalServerError());
        }finally{jdbc.execute("DROP TRIGGER t7_lifecycle_audit_fault");}
        assertThat(storage.usage(Long.parseLong(f.workspace()),Long.parseLong(f.project()))).isEqualTo(before);readable(grant);
        assertThat(jdbc.queryForObject("SELECT state FROM collaboration_grants WHERE id=?",String.class,grant.path("id").asLong())).isEqualTo("active");
    }
    @Test void responsibilityEndIsActualMutationTimeAndCleanupCannotRestartItAtRead()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        artifactTime.advance(86400000);long ended=artifactTime.now().toEpochMilli();capability(f,f.owner(),"publication.manage","deny");artifactTime.advance(86400000);capability(f,f.owner(),"publication.manage","allow");
        assertThat(jdbc.queryForObject("SELECT ended_at FROM collaboration_grants WHERE id=?",Long.class,grant.path("id").asLong())).isEqualTo(ended);
        inactive(read(grant,grant.path("key").asText()),"responsibility_changed");
        assertThat(jdbc.queryForObject("SELECT inactive_since FROM collaboration_storage_objects WHERE kind='ARTIFACT' AND object_id=?",Long.class,publication.path("id").asLong())).isEqualTo(ended);
    }
    @Test void managementRecordIsFiniteNonsecretAndScopeBound()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        String path=collaboration(f)+"/grants/"+grant.path("id").asText();
        var own=body(mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        var other=mvc.perform(get(path).header("Authorization","Bearer "+f.editor().token())).andReturn().getResponse();
        var missing=mvc.perform(get(collaboration(f)+"/grants/9223372036854775807").header("Authorization","Bearer "+f.owner().token())).andReturn().getResponse();
        var wrong=mvc.perform(get("/api/v1/workspaces/"+f.workspace()+"/projects/"+f.other()+"/collaboration/grants/"+grant.path("id").asText()).header("Authorization","Bearer "+f.owner().token())).andReturn().getResponse();
        assertAll(()->assertThat(own.path("id")).isEqualTo(grant.path("id")),()->assertThat(own.hasNonNull("key")).isFalse(),()->assertThat(own.hasNonNull("keyHash")).isFalse(),
            ()->assertThat(other.getStatus()).isEqualTo(403),()->assertThat(missing.getStatus()).isEqualTo(404),()->assertThat(wrong.getStatus()).isEqualTo(404));
    }
    @Test void rotationRequiresCurrentManagerAndCannotReuseCreateIntent()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var command=grantCommand("view","external");var grant=createGrant(f,publication,command);readable(grant);
        String path=collaboration(f)+"/grants/"+grant.path("id").asText()+"/rotate";
        var other=request(f.editor().token(),post(path),Map.of("expectedRevision",1,"operationIntent",UUID.randomUUID().toString())).andReturn().getResponse();
        var intent=request(f.owner().token(),post(path),Map.of("expectedRevision",1,"operationIntent",command.path("operationIntent").asText())).andReturn().getResponse();
        assertAll(()->assertThat(other.getStatus()).isEqualTo(403),()->assertThat(intent.getStatus()).isEqualTo(409));
    }
    @ParameterizedTest @ValueSource(strings={"stale","unknown","manager","missing"}) void revokeIsVersionedAndAuthorized(String branch)throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        var command=json.createObjectNode().put("expectedRevision",branch.equals("stale")?0:1);if(branch.equals("unknown"))command.put("force",true);
        String id=branch.equals("missing")?"9223372036854775807":grant.path("id").asText();
        var actor=branch.equals("manager")?f.editor():f.owner();
        request(actor.token(),delete(collaboration(f)+"/grants/"+id),command).andExpect(status().is(branch.equals("stale")?409:branch.equals("unknown")?400:branch.equals("manager")?403:404));
    }
    @Test void operationReceiptsAreActuallyChargedWithGrant()throws Exception {
        var f=fixture();var publication=fixedDocument(f);createGrant(f,publication,grantCommand("view","external"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind='GRANT_OPERATION'",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()))).isEqualTo(1);
    }
    JsonNode evidencePublication(Fixture f)throws Exception {
        deployment.setDefaults(json.convertValue(Map.of("externalSharingAllowed",true,"evidenceAllowed",true),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));
        policy(f,true,Map.of("externalSharingAllowed",true,"evidenceAllowed",true));policy(f,false,Map.of("externalSharingAllowed",true,"evidenceAllowed",true));
        var input=json.createObjectNode().put("title","Selected synthetic evidence").put("includeEvidence",true);var artifact=input.putObject("source").put("kind","member-upload").putObject("artifact");
        artifact.put("formatVersion",1).put("kind","report").put("title","Synthetic bounded evidence");artifact.putObject("source").put("trust","member-claim").put("revision","member-evidence-1").put("digest","a".repeat(64));artifact.putArray("summary");artifact.putArray("limitations");
        var report=artifact.putObject("report").put("sourceCategory","run").put("startedAt","2026-11-01T00:00:00Z").put("finishedAt","2026-11-01T00:00:01Z").put("verdict","unknown");
        for(String name:List.of("counts","failures","nodes","trace"))report.putArray(name);var evidence=report.putArray("evidence");
        for(int i=0;i<10;i++)evidence.addObject().put("nodeId","synthetic-"+i).put("status","available").put("responseBody","x".repeat(8000));
        return publish(f,preview(f,f.owner(),input),UUID.randomUUID().toString());
    }
    @Test void evidenceTighteningIsDurableButNewProjectionBudgetsAreNotRetroactive()throws Exception {
        var f=fixture();var publication=evidencePublication(f);var grant=createGrant(f,publication,grantCommand("view","external"));
        var original=read(grant,grant.path("key").asText());assertThat(original.statusCode()).isEqualTo(200);assertThat(json.readTree(original.body()).at("/report/evidence").size()).isEqualTo(10);
        policy(f,false,Map.of("evidenceAllowed",false));policy(f,false,Map.of("evidenceAllowed",true));inactive(read(grant,grant.path("key").asText()),"policy_changed");
    }
    @Test void lowerNewPublicationSizeBudgetDoesNotRefetchOrRewriteSavedSafeCopy()throws Exception {
        var f=fixture();var publication=evidencePublication(f);var grant=createGrant(f,publication,grantCommand("view","external"));
        var original=read(grant,grant.path("key").asText());assertThat(original.statusCode()).isEqualTo(200);assertThat(original.body().getBytes(java.nio.charset.StandardCharsets.UTF_8).length).isGreaterThan(65536);
        policy(f,false,Map.of("maxArtifactBytes",65536,"maxEvidenceBytes",65536));rpc.unavailable=true;
        var saved=read(grant,grant.path("key").asText());assertThat(saved.statusCode()).isEqualTo(200);assertThat(saved.body()).isEqualTo(original.body());
    }
    @ParameterizedTest @ValueSource(strings={"create","rotate","revoke"}) void grantCommandAuditFailureRollsBackHashReferencesReceiptsAndCharges(String command)throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        // The public response may arrive before its best-effort observation commits.
        long observedUntil=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        while(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE workspace_id=? AND project_id=? AND retention_class='access'",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()))==0 && System.nanoTime()<observedUntil)Thread.sleep(10);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE workspace_id=? AND project_id=? AND retention_class='access'",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()))).isEqualTo(1);
        var before=storage.usage(Long.parseLong(f.workspace()),Long.parseLong(f.project()));
        byte[] hash=jdbc.queryForObject("SELECT key_hash FROM collaboration_grants WHERE id=?",byte[].class,grant.path("id").asLong());
        jdbc.execute("CREATE TRIGGER t7_command_audit_fault BEFORE INSERT ON collaboration_management_audit FOR EACH ROW CALL '"+AuditFault.class.getName()+"'");
        try{
            if(command.equals("create"))request(f.owner().token(),post(createPath(f,publication)),grantCommand("view","external")).andExpect(status().isInternalServerError());
            if(command.equals("rotate"))request(f.owner().token(),post(collaboration(f)+"/grants/"+grant.path("id").asText()+"/rotate"),Map.of("expectedRevision",1,"operationIntent",UUID.randomUUID().toString())).andExpect(status().isInternalServerError());
            if(command.equals("revoke"))request(f.owner().token(),delete(collaboration(f)+"/grants/"+grant.path("id").asText()),Map.of("expectedRevision",1)).andExpect(status().isInternalServerError());
        }finally{jdbc.execute("DROP TRIGGER t7_command_audit_fault");}
        assertAll(()->assertThat(storage.usage(Long.parseLong(f.workspace()),Long.parseLong(f.project()))).isEqualTo(before),
            ()->assertThat(jdbc.queryForObject("SELECT key_hash FROM collaboration_grants WHERE id=?",byte[].class,grant.path("id").asLong())).isEqualTo(hash),
            ()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_grants WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()))).isEqualTo(1),
            ()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_grant_operations WHERE grant_id=?",Long.class,grant.path("id").asLong())).isEqualTo(1));
        readable(grant);
    }
    @Test void savedReportReadNeedsCurrentHistoryAuthorityButNotOriginalArchiveOrNode()throws Exception {
        var f=fixture();policy(f,true,Map.of("externalSharingAllowed",true));policy(f,false,Map.of("externalSharingAllowed",true));
        var publication=publish(f,preview(f,f.owner(),reportRequest(f)),UUID.randomUUID().toString());var grant=createGrant(f,publication,grantCommand("view","external"));
        var original=read(grant,grant.path("key").asText());assertThat(original.statusCode()).isEqualTo(200);
        jdbc.update("UPDATE execution_jobs SET report_state='expired',report_content=NULL WHERE id=?",Long.parseLong(f.job()));rpc.unavailable=true;
        var saved=read(grant,grant.path("key").asText());assertThat(saved.statusCode()).isEqualTo(200);assertThat(saved.body()).isEqualTo(original.body());
        capability(f,f.owner(),"history.read","deny");inactive(read(grant,grant.path("key").asText()),"responsibility_changed");
    }
    @ParameterizedTest @ValueSource(strings={"evidence","sensitive"})
    void currentlyNoncompliantFixedCopyCannotIssueNewGrant(String restriction)throws Exception {
        var f=fixture();var publication=restriction.equals("evidence")?evidencePublication(f):fixedDocument(f);
        // Real saved projection, no grant exists when the current policy is tightened.
        policy(f,false,restriction.equals("evidence")?Map.of("evidenceAllowed",false):Map.of("extraSensitiveHeaders",List.of("x-new-private")));
        var before=storage.usage(Long.parseLong(f.workspace()),Long.parseLong(f.project()));
        request(f.owner().token(),post(createPath(f,publication)),grantCommand("view","external"))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("grant_policy_disabled"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_grants WHERE publication_id=?",Long.class,publication.path("id").asLong())).isZero();
        assertThat(storage.usage(Long.parseLong(f.workspace()),Long.parseLong(f.project()))).isEqualTo(before);
    }
    @Test void legacyActivePolicyMismatchIsCommittedBefore410AndCannotRevive()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        // Legacy persisted-state fallback: a legitimate preexisting grant is read under a newly
        // loaded deployment restriction before its reconciliation. No forged artifact/provenance.
        deployment.setDefaults(json.convertValue(Map.of("externalSharingAllowed",true,"extraSensitiveHeaders",List.of("x-new-private")),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));
        inactive(read(grant,grant.path("key").asText()),"policy_changed");
        assertThat(jdbc.queryForObject("SELECT state FROM collaboration_grants WHERE id=?",String.class,grant.path("id").asLong())).isEqualTo("inactive");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_references WHERE owner_kind='GRANT' AND owner_id=?",Long.class,grant.path("id").asLong())).isZero();
        defaults();inactive(read(grant,grant.path("key").asText()),"policy_changed");
    }
    @ParameterizedTest @ValueSource(strings={"delete","cleanup"})
    void expiredUnreadGrantDoesNotBreakPolicyAfterNormalArtifactRemoval(String removal)throws Exception {
        var f=fixture();var publication=fixedDocument(f);long expiry=artifactTime.now().toEpochMilli()+60000;
        var grant=createGrant(f,publication,grantCommand("view","external").put("expiresAt",expiry));readable(grant);
        artifactTime.advance(60000);removeExpiredArtifact(f,publication,removal);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_publications WHERE id=?",Long.class,publication.path("id").asLong())).isZero();
        // No intervening public GET may rescue the grant state before normal policy reconciliation.
        policy(f,false,Map.of("defaultPageSize",25));
        assertExpiredTombstone(f,grant,expiry);
    }
    void removeExpiredArtifact(Fixture f,JsonNode publication,String removal)throws Exception {
        if(removal.equals("delete"))request(f.owner().token(),delete(collaboration(f)+"/publications/"+publication.path("id").asText()),Map.of("expectedRevision",1)).andExpect(status().isNoContent());
        else{artifactTime.advance(31L*86400000);for(int batch=0;batch<3;batch++)storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));}
    }
    void assertExpiredTombstone(Fixture f,JsonNode grant,long expiry)throws Exception {
        assertThat(jdbc.queryForMap("SELECT state,reason,ended_at,revision FROM collaboration_grants WHERE id=?",grant.path("id").asLong()))
            .containsEntry("STATE","inactive").containsEntry("REASON","expired").containsEntry("ENDED_AT",expiry).containsEntry("REVISION",2L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_references WHERE owner_kind='GRANT' AND owner_id=?",Long.class,grant.path("id").asLong())).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE kind='GRANT' AND object_id=? AND reserved_bytes=0",Long.class,grant.path("id").asLong())).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_grant_operations WHERE grant_id=?",Long.class,grant.path("id").asLong())).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE kind='GRANT_OPERATION' AND workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()))).isEqualTo(1);
    }
    @ParameterizedTest @ValueSource(strings={"policy","startup"})
    void reconciliationExpiresAtOriginalDeadlineBeforeFixedBodyCompliance(String reconciliation)throws Exception {
        var f=fixture();var publication=fixedDocument(f);long expiry=artifactTime.now().toEpochMilli()+60000;
        var grant=createGrant(f,publication,grantCommand("view","external").put("expiresAt",expiry));readable(grant);artifactTime.advance(60000);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_publications WHERE id=?",Long.class,publication.path("id").asLong())).isEqualTo(1);
        if(reconciliation.equals("policy"))policy(f,false,Map.of("extraSensitiveHeaders",List.of("x-new-private")));
        else{
            deployment.setDefaults(json.convertValue(Map.of("externalSharingAllowed",true,"extraSensitiveHeaders",List.of("x-new-private")),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));
            grants.reconcileAppliedDeployment();
        }
        assertExpiredTombstone(f,grant,expiry);
    }
    @ParameterizedTest @ValueSource(strings={"rotate","revoke","qualification"})
    void grantChangeAuditContainsAcceptedRevision(String change)throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        var created=grantEvents(grant);assertThat(created).hasSize(1);assertThat(created.getFirst().revision()).isEqualTo(1L);
        String action;
        if(change.equals("rotate")){
            request(f.owner().token(),post(collaboration(f)+"/grants/"+grant.path("id").asText()+"/rotate"),Map.of("expectedRevision",1,"operationIntent",UUID.randomUUID().toString())).andExpect(status().isCreated());action="GRANT_ROTATED";
        }else if(change.equals("revoke")){
            request(f.owner().token(),delete(collaboration(f)+"/grants/"+grant.path("id").asText()),Map.of("expectedRevision",1)).andExpect(status().isNoContent());action="GRANT_REVOKED";
        }else{capability(f,f.owner(),"publication.manage","deny");action="GRANT_INVALIDATED";}
        var changed=grantEvents(grant).stream().filter(event->event.action().name().equals(action)).toList();
        assertThat(changed).hasSize(1);assertThat(changed.getFirst().revision()).isEqualTo(2L);
    }
    List<com.autumnharvestc.server.collaboration.artifacts.StorageTypes.AuditEvent> grantEvents(JsonNode grant){
        return jdbc.query("SELECT event_json FROM collaboration_management_audit WHERE retention_class='management' ORDER BY id",(row,index)->{
            try{return json.readValue(row.getString(1),com.autumnharvestc.server.collaboration.artifacts.StorageTypes.AuditEvent.class);}catch(Exception failure){throw new IllegalStateException("Cannot read finite audit event",failure);}
        }).stream().filter(event->event.objectKind()==com.autumnharvestc.server.collaboration.artifacts.StorageTypes.Kind.GRANT&&event.objectId()==grant.path("id").asLong()).toList();
    }
}
