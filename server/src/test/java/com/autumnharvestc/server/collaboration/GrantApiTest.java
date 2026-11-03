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
import static org.junit.jupiter.api.Assertions.assertAll;

@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-collaboration-t7-api;DB_CLOSE_DELAY=-1",
    "apicc.collaboration.policy.defaults.external-sharing-allowed=true",
    "apicc.collaboration.public-access.enabled=true", "apicc.collaboration.public-access.port=0",
    "apicc.collaboration.public-access.base-url=http://127.0.0.1:18791"})
class GrantApiTest extends ArtifactHttpFixture {
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties deployment;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage storage;
    @Test void createsFixedExternalGrantWithOneTimeSecret()throws Exception {
        var f=fixture();
        policy(f,true,Map.of("externalSharingAllowed",true));
        policy(f,false,Map.of("externalSharingAllowed",true));
        var publication=publish(f,preview(f,f.owner(),documentRequest(f)),UUID.randomUUID().toString());
        publication(f,f.owner(),publication.path("id").asText());
        var created=body(request(f.owner().token(),post(collaboration(f)+"/publications/"+publication.path("id").asText()+"/grants"),
            Map.of("operationIntent",UUID.randomUUID().toString(),"purpose","view","audience","external","expectedRevision",1)).andExpect(status().isCreated()));
        assertThat(created.path("publicationId").asText()).isEqualTo(publication.path("id").asText());
        assertThat(created.path("version").asLong()).isEqualTo(publication.path("version").asLong());
        assertThat(created.path("key").asText()).matches("[A-Za-z0-9_-]{43}");
        assertThat(created.path("publicId").asText()).matches("[A-Za-z0-9_-]{22}");
        assertThat(created.path("downloadAllowed").asBoolean()).isFalse();
        assertThat(created.path("generation").asLong()).isEqualTo(1);
        assertThat(created.path("publicUrl").asText()).isEqualTo("http://127.0.0.1:18791/s/"+created.path("publicId").asText());
    }

    @Test void memberViewIsOnlyProtectedMemberLocation()throws Exception {
        var f=fixture();
        var publication=publish(f,preview(f,f.owner(),documentRequest(f)),UUID.randomUUID().toString());
        var created=body(request(f.owner().token(),post(collaboration(f)+"/publications/"+publication.path("id").asText()+"/grants"),
            Map.of("operationIntent",UUID.randomUUID().toString(),"purpose","view","audience","members","expectedRevision",1)).andExpect(status().isCreated()));
        assertThat(created.path("memberPath").asText()).isEqualTo(collaboration(f)+"/publications/"+publication.path("id").asText());
        assertThat(created.hasNonNull("key")).isFalse();
        assertThat(created.hasNonNull("publicId")).isFalse();
        assertThat(created.hasNonNull("publicUrl")).isFalse();
    }

    JsonNode external(Fixture f,JsonNode publication,com.fasterxml.jackson.databind.node.ObjectNode command)throws Exception {
        return body(request(f.owner().token(),post(grantPath(f,publication)),command).andExpect(status().isCreated()));
    }
    String grantPath(Fixture f,JsonNode publication){return collaboration(f)+"/publications/"+publication.path("id").asText()+"/grants";}
    com.fasterxml.jackson.databind.node.ObjectNode command(){return json.createObjectNode().put("operationIntent",UUID.randomUUID().toString()).put("purpose","view").put("audience","external").put("expectedRevision",1);}
    JsonNode fixed(Fixture f)throws Exception {
        policy(f,true,Map.of("externalSharingAllowed",true));policy(f,false,Map.of("externalSharingAllowed",true));
        return publish(f,preview(f,f.owner(),documentRequest(f)),UUID.randomUUID().toString());
    }
    @ParameterizedTest @ValueSource(strings={"publicationRevision","unknown","purpose","audience","downloadType","intent","expiryMin","expiryMax"})
    void creationRejectsFiniteInvalidCommand(String branch)throws Exception {
        var f=fixture();var publication=fixed(f);external(f,publication,command());
        var input=command();String code="invalid_request";int status=400;
        switch(branch){
            case "publicationRevision"->{input.put("expectedRevision",0);status=409;code="publication_revision_conflict";}
            case "unknown"->input.put("arbitrary",true);
            case "purpose"->input.put("purpose","call");
            case "audience"->input.put("audience","anonymous");
            case "downloadType"->input.put("downloadAllowed","false");
            case "intent"->input.put("operationIntent","unsafe/intent");
            case "expiryMin"->input.put("expiresAt",artifactTime.now().toEpochMilli()+59999);
            case "expiryMax"->input.put("expiresAt",artifactTime.now().toEpochMilli()+91L*86400000);
        }
        request(f.owner().token(),post(grantPath(f,publication)),input).andExpect(status().is(status)).andExpect(jsonPath("$.code").value(code));
    }
    @ParameterizedTest @ValueSource(strings={"workspace","project"}) void missingExternalConsentRejects(String layer)throws Exception {
        var f=fixture();var publication=fixed(f);external(f,publication,command());
        policy(f,layer.equals("workspace"),Map.of("externalSharingAllowed",false));
        request(f.owner().token(),post(grantPath(f,publication)),command()).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("grant_policy_disabled"));
    }
    @Test void sourceReadAndManagementAreIndependent()throws Exception {
        var f=fixture();policy(f,true,Map.of("externalSharingAllowed",true));policy(f,false,Map.of("externalSharingAllowed",true));
        var publication=publish(f,preview(f,f.owner(),reportRequest(f)),UUID.randomUUID().toString());external(f,publication,command());
        capability(f,f.editor(),"publication.manage","allow");capability(f,f.editor(),"history.read","deny");
        request(f.editor().token(),post(grantPath(f,publication)),command()).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
    }
    @Test void missingManagementRejects()throws Exception {
        var f=fixture();var publication=fixed(f);external(f,publication,command());
        request(f.editor().token(),post(grantPath(f,publication)),command()).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
    }
    @Test void wrongScopeRejects()throws Exception {
        var f=fixture();var publication=fixed(f);external(f,publication,command());var members=command().put("audience","members");
        request(f.owner().token(),post("/api/v1/workspaces/"+f.workspace()+"/projects/"+f.other()+"/collaboration/publications/"+publication.path("id").asText()+"/grants"),members)
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("publication_not_found"));
    }
    @Test void sameIntentReconcilesWithoutPlaintextOrDuplicate()throws Exception {
        var f=fixture();var publication=fixed(f);var input=command();var first=external(f,publication,input);
        var replay=body(request(f.owner().token(),post(grantPath(f,publication)),input).andExpect(status().isOk()));
        assertThat(replay.path("id")).isEqualTo(first.path("id"));assertThat(replay.hasNonNull("key")).isFalse();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_grants WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()))).isEqualTo(1);
    }
    @Test void grantOwnsRealReferenceAndChargedMetadataAudit()throws Exception {
        var f=fixture();var publication=fixed(f);var created=external(f,publication,command());
        assertAll(
            ()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_references WHERE owner_kind='GRANT' AND owner_id=? AND target_kind='ARTIFACT' AND target_id=?",Long.class,created.path("id").asLong(),publication.path("id").asLong())).isEqualTo(1),
            ()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE kind='GRANT' AND object_id=?",Long.class,created.path("id").asLong())).isEqualTo(1),
            ()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE event_json LIKE '%GRANT_CREATED%' AND workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()))).isEqualTo(1));
    }
    @Test void projectGrantQuotaIsAtomic()throws Exception {
        var f=fixture();var publication=fixed(f);policy(f,false,Map.of("maxProjectActiveGrants",1));external(f,publication,command());
        request(f.owner().token(),post(grantPath(f,publication)),command()).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("collaboration_grant_limit"));
    }
    @Test void grantIntentCannotChangeCommand()throws Exception {
        var f=fixture();var publication=fixed(f);var input=command();external(f,publication,input);
        request(f.owner().token(),post(grantPath(f,publication)),input.deepCopy().put("audience","members"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("grant_intent_conflict"));
    }
    @Test void grantOperationIsNonsecretAndDoesNotReplacePublicationReceipt()throws Exception {
        var f=fixture();policy(f,true,Map.of("externalSharingAllowed",true));policy(f,false,Map.of("externalSharingAllowed",true));
        String publicationIntent=UUID.randomUUID().toString();var publication=publish(f,preview(f,f.owner(),documentRequest(f)),publicationIntent);
        var input=command();var grant=external(f,publication,input);
        mvc.perform(get(collaboration(f)+"/operations/"+publicationIntent).header("Authorization","Bearer "+f.owner().token()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.publicationId").value(publication.path("id").asText()));
        var receipt=body(mvc.perform(get(collaboration(f)+"/grant-operations/"+input.path("operationIntent").asText()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        assertThat(receipt.path("grantId").asText()).isEqualTo(grant.path("id").asText());
        assertThat(receipt.hasNonNull("key")).isFalse();assertThat(receipt.path("keyObtained").asBoolean()).isFalse();
    }
    @Test void deploymentConsentAndDownloadCeilingAreEnforced()throws Exception {
        var f=fixture();var publication=fixed(f);external(f,publication,command());
        request(f.owner().token(),post(grantPath(f,publication)),command().put("downloadAllowed",true))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("grant_policy_disabled"));
    }
    @Test void deploymentConsentIsRequiredEvenWithBothLocalConsents()throws Exception {
        var f=fixture();var publication=fixed(f);external(f,publication,command());var original=deployment.getDefaults();
        try{
            deployment.setDefaults(json.convertValue(Map.of("externalSharingAllowed",false),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));
            request(f.owner().token(),post(grantPath(f,publication)),command()).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("grant_policy_disabled"));
        }finally{deployment.setDefaults(original);}
    }
    @Test void disabledPublicationCannotCreateNewGrant()throws Exception {
        var f=fixture();var publication=fixed(f);external(f,publication,command());
        request(f.owner().token(),patch(collaboration(f)+"/publications/"+publication.path("id").asText()),Map.of("expectedRevision",1,"enabled",false)).andExpect(status().isOk());
        request(f.owner().token(),post(grantPath(f,publication)),command().put("expectedRevision",2)).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("grant_publication_disabled"));
    }
    @Test void globalGrantLimitIsIndependentOfProjectLimit()throws Exception {
        var f=fixture();var publication=fixed(f);long count=jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_grants WHERE state='active' AND audience='external' AND expires_at>?",Long.class,artifactTime.now().toEpochMilli());
        var original=deployment.getDeployment();
        try{
            deployment.setDeployment(json.convertValue(Map.of("deploymentMaxActiveGrants",count+1),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Deployment.class));
            external(f,publication,command());
            request(f.owner().token(),post(grantPath(f,publication)),command()).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("collaboration_grant_limit"));
        }finally{deployment.setDeployment(original);}
    }
    @ParameterizedTest @ValueSource(strings={"missing","scope","target","expired","responsibility"})
    void grantReferenceRequiresRealCurrentOwner(String branch)throws Exception {
        var f=fixture();var publication=fixed(f);var grant=external(f,publication,command());
        long ws=Long.parseLong(f.workspace()),project=Long.parseLong(f.project()),id=grant.path("id").asLong(),target=publication.path("id").asLong();
        var key=new com.autumnharvestc.server.collaboration.artifacts.StorageTypes.StoredKey(com.autumnharvestc.server.collaboration.artifacts.StorageTypes.Kind.ARTIFACT,target);
        long positive=storage.retain(f.owner().account().id(),ws,project,key,new com.autumnharvestc.server.collaboration.artifacts.StorageTypes.Owner(com.autumnharvestc.server.collaboration.artifacts.StorageTypes.OwnerKind.GRANT,id,java.time.Instant.ofEpochMilli(grant.path("expiresAt").asLong())));
        assertThat(positive).isPositive();
        if(branch.equals("missing"))id=Long.MAX_VALUE;
        if(branch.equals("scope"))project=Long.parseLong(f.other());
        if(branch.equals("target")){
            var second=publish(f,preview(f,f.owner(),documentRequest(f)),UUID.randomUUID().toString());
            key=new com.autumnharvestc.server.collaboration.artifacts.StorageTypes.StoredKey(com.autumnharvestc.server.collaboration.artifacts.StorageTypes.Kind.ARTIFACT,second.path("id").asLong());
        }
        if(branch.equals("expired"))artifactTime.advance(7L*86400000);
        if(branch.equals("responsibility"))capability(f,f.owner(),"publication.manage","deny");
        long finalProject=project,finalId=id;var finalKey=key;
        var failure=org.junit.jupiter.api.Assertions.assertThrows(com.autumnharvestc.server.core.ApiException.class,()->storage.retain(f.owner().account().id(),ws,finalProject,finalKey,new com.autumnharvestc.server.collaboration.artifacts.StorageTypes.Owner(com.autumnharvestc.server.collaboration.artifacts.StorageTypes.OwnerKind.GRANT,finalId,artifactTime.now().plusSeconds(60))));
        assertThat(failure.getCode()).isEqualTo("collaboration_reference_owner_invalid");
    }
    @Test void grantReferenceTakesStoredExpiry()throws Exception {
        var f=fixture();var publication=fixed(f);var grant=external(f,publication,command());
        long ref=storage.retain(f.owner().account().id(),Long.parseLong(f.workspace()),Long.parseLong(f.project()),
            new com.autumnharvestc.server.collaboration.artifacts.StorageTypes.StoredKey(com.autumnharvestc.server.collaboration.artifacts.StorageTypes.Kind.ARTIFACT,publication.path("id").asLong()),
            new com.autumnharvestc.server.collaboration.artifacts.StorageTypes.Owner(com.autumnharvestc.server.collaboration.artifacts.StorageTypes.OwnerKind.GRANT,grant.path("id").asLong(),artifactTime.now().plusSeconds(60)));
        assertThat(jdbc.queryForObject("SELECT expires_at FROM collaboration_storage_references WHERE id=?",Long.class,ref)).isEqualTo(grant.path("expiresAt").asLong());
    }
    // POSTHOC verification authorized by controller: these frozen guards were introduced before their own RED.
    @ParameterizedTest @ValueSource(strings={"missing","nonowner"}) void posthocFrozenReceiptRejection(String branch)throws Exception {
        var f=fixture();var publication=fixed(f);var command=command();var grant=external(f,publication,command);
        String path=collaboration(f)+"/grant-operations/"+command.path("operationIntent").asText();
        mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()).andExpect(jsonPath("$.grantId").value(grant.path("id").asText()));
        var actor=f.owner();
        if(branch.equals("nonowner")){
            actor=f.editor();capability(f,actor,"publication.manage","allow");
            mvc.perform(get(collaboration(f)+"/grants/"+grant.path("id").asText()).header("Authorization","Bearer "+actor.token())).andExpect(status().isOk());
        }else path=collaboration(f)+"/grant-operations/"+UUID.randomUUID();
        mvc.perform(get(path).header("Authorization","Bearer "+actor.token())).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("grant_operation_not_found"));
    }
    @ParameterizedTest @ValueSource(strings={"NONE","nonmember"}) void posthocFrozenCurrentContentRejectionOnNewGrantRoute(String branch)throws Exception {
        var f=fixture();var publication=fixed(f);capability(f,f.editor(),"publication.manage","allow");
        request(f.editor().token(),post(grantPath(f,publication)),command()).andExpect(status().isCreated());
        if(branch.equals("NONE")){
            String path=f.url()+"/access-members/"+f.editor().id();long revision=body(mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();
            request(f.owner().token(),put(path),Map.of("expectedRevision",revision,"role","NONE")).andExpect(status().isOk());
        }else mvc.perform(delete("/api/v1/workspaces/"+f.workspace()+"/members/"+f.editor().id()).param("expectedRevision","1").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
        mvc.perform(get("/api/v1/me").header("Authorization","Bearer "+f.editor().token())).andExpect(status().isOk());
        request(f.editor().token(),post(grantPath(f,publication)),command()).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
    }
}
