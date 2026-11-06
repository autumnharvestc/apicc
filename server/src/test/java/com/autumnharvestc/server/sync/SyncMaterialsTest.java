package com.autumnharvestc.server.sync;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import com.autumnharvestc.server.store.UserRepo;
import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.execution.materials.ProjectCredentialService;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
class SyncMaterialsTest extends SyncHttpFixture {
    static final java.nio.file.Path key;
    static {try{key=java.nio.file.Files.createTempFile("apicc-sync-t7-key-",".bin");java.nio.file.Files.write(key,new byte[32]);key.toFile().deleteOnExit();}catch(Exception e){throw new ExceptionInInitializerError(e);}}
    @DynamicPropertySource static void key(DynamicPropertyRegistry properties){properties.add("apicc.execution.materials.master-key-file",()->key.toString());}
    @Autowired SyncMaterialService materials;
    @Autowired ProjectCredentialService credentials;
    @Autowired UserRepo users;
    @Autowired com.autumnharvestc.server.execution.materials.ProjectCredentialStore store;
    record Bound(com.autumnharvestc.server.store.UserAccount owner,String source) {}
    Bound bound() throws Exception {
        var owner=users.findById(Long.parseLong(f.owner().id())).orElseThrow();credentials.put(owner,f.workspace(),f.project(),"url-auth",new CredentialWrite("0","Bearer synthetic-t7"));
        var saved=body(sourceRequest("POST","/sources",f.owner(),write(sourceBody("url").put("authRef","url-auth"))).andExpect(status().isCreated()));
        return new Bound(owner,saved.path("id").asText());
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"purpose","unbound-ref","stale-source","unknown-source","check-denied","none","disabled","tombstone","stale-credential","missing-key","check-denied-before-decrypt","cross-project-source","viewer"})
    void sourceProjectActorPurposeAndVersionsAreRevalidatedBeforeDecryption(String kind) throws Exception {
        var fixed=bound();var selected=new CredentialSelection("url-auth","1");
        assertThat(materials.resolve(fixed.owner(),f.workspace(),f.project(),fixed.source(),"1","source-check",selected).value()).isEqualTo("Bearer synthetic-t7");
        var actor=fixed.owner();String source=fixed.source(),revision="1",purpose="source-check",project=f.project(),expectedCode=null;int expected=403;
        switch(kind){
            case "purpose"->purpose="publish";
            case "unbound-ref"->{credentials.put(fixed.owner(),f.workspace(),f.project(),"other",new CredentialWrite("0","same-project-secret"));selected=new CredentialSelection("other","1");}
            case "stale-source"->{revision="0";expected=409;}
            case "unknown-source"->{source=java.util.UUID.randomUUID().toString();expected=404;}
            case "cross-project-source"->{project=anotherProject();expected=404;}
            case "check-denied-before-decrypt"->{capabilities(null,java.util.Map.of("sync.check","deny"));actor=users.findById(Long.parseLong(editor().id())).orElseThrow();var envelope=store.find(Long.parseLong(f.workspace()),Long.parseLong(f.project()),"url-auth").orElseThrow();store.save(new com.autumnharvestc.server.execution.materials.ProjectCredentialStore.Envelope(envelope.workspaceId(),envelope.projectId(),envelope.refId(),envelope.version(),"unavailable-key",envelope.nonce(),envelope.ciphertext()));}
            case "check-denied"->{capabilities(null,java.util.Map.of("sync.check","deny"));actor=users.findById(Long.parseLong(editor().id())).orElseThrow();}
            case "viewer"->{capabilities("VIEWER",java.util.Map.of("sync.check","allow"));actor=users.findById(Long.parseLong(editor().id())).orElseThrow();}
            case "none"->{capabilities("NONE",java.util.Map.of("sync.check","inherit"));actor=users.findById(Long.parseLong(editor().id())).orElseThrow();}
            case "disabled"->users.setDisabled(fixed.owner().id(),true);
            case "tombstone"->{credentials.remove(fixed.owner(),f.workspace(),f.project(),"url-auth","1");selected=new CredentialSelection("url-auth","2");expected=409;expectedCode="credential_missing";}
            case "stale-credential"->{credentials.put(fixed.owner(),f.workspace(),f.project(),"url-auth",new CredentialWrite("1","rotated-value"));expected=409;expectedCode="credential_version_conflict";}
            case "missing-key"->{var envelope=store.find(Long.parseLong(f.workspace()),Long.parseLong(f.project()),"url-auth").orElseThrow();store.save(new com.autumnharvestc.server.execution.materials.ProjectCredentialStore.Envelope(envelope.workspaceId(),envelope.projectId(),envelope.refId(),envelope.version(),"unavailable-key",envelope.nonce(),envelope.ciphertext()));expected=503;expectedCode="credential_unavailable";}
        }
        final var finalCode=expectedCode;final var finalProject=project;final var finalActor=actor;final var finalSource=source;final var finalRevision=revision;final var finalPurpose=purpose;final var finalSelected=selected;final int finalStatus=expected;
        org.assertj.core.api.Assertions.assertThatThrownBy(()->materials.resolve(finalActor,f.workspace(),finalProject,finalSource,finalRevision,finalPurpose,finalSelected))
            .isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->{assertThat(e.getStatus().value()).isEqualTo(finalStatus);if(finalCode!=null)assertThat(e.getCode()).isEqualTo(finalCode);assertThat(e.getMessage()).doesNotContain("Bearer synthetic-t7","rotated-value","same-project-secret",key.toString());});
    }
    @Test void credentialManagementStaysSeparateFromSourceManagement() throws Exception {
        var fixed=bound();capabilities(null,java.util.Map.of("sync.manage","allow","credential.manage","deny"));
        var actor=users.findById(Long.parseLong(editor().id())).orElseThrow();
        org.assertj.core.api.Assertions.assertThatThrownBy(()->credentials.put(actor,f.workspace(),f.project(),"url-auth",new CredentialWrite("1","secret"))).isInstanceOf(com.autumnharvestc.server.core.ApiException.class);
        assertThat(materials.resolve(actor,f.workspace(),f.project(),fixed.source(),"1","source-check",new CredentialSelection("url-auth","1")).value()).isEqualTo("Bearer synthetic-t7");
    }
    @Test void realEnvelopeIsEncryptedAndCredentialTombstoneCannotResetVersion() throws Exception {
        var fixed=bound();var envelope=store.find(Long.parseLong(f.workspace()),Long.parseLong(f.project()),"url-auth").orElseThrow();
        assertThat(new String(envelope.ciphertext(),java.nio.charset.StandardCharsets.UTF_8)).doesNotContain("Bearer synthetic-t7");
        credentials.remove(fixed.owner(),f.workspace(),f.project(),"url-auth","1");
        org.assertj.core.api.Assertions.assertThatThrownBy(()->credentials.put(fixed.owner(),f.workspace(),f.project(),"url-auth",new CredentialWrite("0","reset"))).isInstanceOf(com.autumnharvestc.server.core.ApiException.class);
        assertThat(credentials.put(fixed.owner(),f.workspace(),f.project(),"url-auth",new CredentialWrite("2","new" )).version()).isEqualTo("3");
    }
    @Test void resolvesRealEncryptedProjectCredentialForBoundSourceAndCheckPurpose() throws Exception {
        var owner=users.findById(Long.parseLong(f.owner().id())).orElseThrow();
        credentials.put(owner,f.workspace(),f.project(),"url-auth",new CredentialWrite("0","Bearer synthetic-t7"));
        var source=sourceBody("url").put("authRef","url-auth");
        var saved=body(sourceRequest("POST","/sources",f.owner(),write(source)).andExpect(status().isCreated()));
        org.assertj.core.api.Assertions.assertThatCode(()->{
            var result=materials.resolve(owner,f.workspace(),f.project(),saved.path("id").asText(),"1","source-check",new CredentialSelection("url-auth","1"));
            assertThat(result.value()).isEqualTo("Bearer synthetic-t7");
        }).doesNotThrowAnyException();
        assertThat(saved.toString()).doesNotContain("Bearer synthetic-t7");
    }

    @Test void foreignProjectCredentialCannotSupplyABoundButMissingLocalReference() throws Exception {
        var fixed=bound();String other=anotherProject();
        credentials.put(fixed.owner(),f.workspace(),other,"foreign-only",new CredentialWrite("0","foreign-project-secret"));
        var source=readSourceAsAdmin(fixed.source());var request=sourceUpdateBody(source);((com.fasterxml.jackson.databind.node.ObjectNode)request.path("source")).put("authRef","foreign-only");
        sourceRequest("PUT","/sources/"+fixed.source(),f.owner(),request).andExpect(status().isOk());
        org.assertj.core.api.Assertions.assertThatThrownBy(()->materials.resolve(fixed.owner(),f.workspace(),f.project(),fixed.source(),"2","source-check",new CredentialSelection("foreign-only","1"))).isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->{assertThat(e.getStatus().value()).isEqualTo(409);assertThat(e.getCode()).isEqualTo("credential_missing");assertThat(e.getMessage()).doesNotContain("foreign-project-secret");});
    }
}
