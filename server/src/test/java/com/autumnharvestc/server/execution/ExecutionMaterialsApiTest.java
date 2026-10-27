package com.autumnharvestc.server.execution;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import java.nio.file.*;
import java.util.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc(print = org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
@TestPropertySource(properties = {
    "spring.datasource.url=jdbc:h2:mem:apicc-execution-materials-test;DB_CLOSE_DELAY=-1", "apicc.server.allow-registration=true",
    "apicc.server.admin-username=admin", "apicc.server.admin-password=admin-pass-2026",
    "apicc.execution.policy.snapshot-bytes=128", "apicc.execution.policy.single-attachment-bytes=16", "apicc.execution.policy.total-input-bytes=512"
})
class ExecutionMaterialsApiTest {
    static Path keyFile;
    static { try { keyFile=Files.createTempFile("apicc-material-test-key-",".bin"); Files.write(keyFile,new byte[32]); keyFile.toFile().deleteOnExit(); } catch(Exception e){throw new ExceptionInInitializerError(e);} }
    @DynamicPropertySource static void key(DynamicPropertyRegistry props){props.add("apicc.execution.materials.master-key-file",()->keyFile.toString());props.add("apicc.execution.materials.key-id",()->"test-key");}
    @Autowired MockMvc mvc; @Autowired ObjectMapper json; @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    record Fixture(String token,String ws,String group,String project,String other,String snapshot) {
        String url(){return "/api/v1/workspaces/"+ws+"/projects/"+project;}
    }
    JsonNode body(ResultActions result)throws Exception{return json.readTree(result.andReturn().getResponse().getContentAsString());}
    Fixture fixture()throws Exception{
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content("{\"username\":\"admin\",\"password\":\"admin-pass-2026\"}")).andExpect(status().isOk())).get("token").asText();
        String ws=body(mvc.perform(get("/api/v1/connect").header("Authorization","Bearer "+token)).andExpect(status().isOk())).get("workspaceId").asText();
        String group=body(mvc.perform(get("/api/v1/workspaces/"+ws+"/groups").header("Authorization","Bearer "+token)).andExpect(status().isOk())).get(0).get("id").asText();
        String project=create(token,ws,group),other=create(token,ws,group);
        mvc.perform(put("/api/v1/workspaces/"+ws+"/projects/"+project+"/assets").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsString(Map.of("format","contract-files-v1","contractProjectId","10000000-0000-4000-8000-000000000001","expectedVersion","0","changes",List.of(Map.of("path","project.yaml","content","fixed")),"deletes",List.of())))).andExpect(status().isOk());
        String snapshot=body(mvc.perform(post("/api/v1/workspaces/"+ws+"/projects/"+project+"/execution-snapshots").header("Authorization","Bearer "+token).contentType("application/json").content("{\"expectedVersion\":\"1\"}")).andExpect(status().isCreated())).get("snapshotId").asText();
        return new Fixture(token,ws,group,project,other,snapshot);
    }
    String create(String token,String ws,String group)throws Exception{return body(mvc.perform(post("/api/v1/workspaces/"+ws+"/projects").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsString(Map.of("groupId",group,"name","material project")))).andExpect(status().isCreated())).get("id").asText();}
    ResultActions putCredential(Fixture f,String expected,String value)throws Exception{return mvc.perform(put(f.url()+"/credentials/bearer").header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(Map.of("expectedVersion",expected,"value",value))));}
    ResultActions local(Fixture f,String project,List<?> credentials,List<?> attachments)throws Exception{return mvc.perform(post("/api/v1/execution-snapshots/"+f.snapshot()+"/local-materials").header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(Map.of("projectId",project,"credentials",credentials,"attachments",attachments))));}

    @Test void projectSelectionCannotCrossAuthoritativeSnapshotScope()throws Exception{
        Fixture f=fixture();
        local(f,f.other(),List.of(Map.of("refId","bearer","version","1")),List.of()).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("materials_scope_mismatch"));
    }
    @Test void unassignedAgentCannotFetchMaterialsEvenWithAnArbitraryJobAndExecution()throws Exception{
        Fixture f=fixture();
        String agent=body(mvc.perform(post("/api/v1/agents").header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"name\":\"material agent\"}")).andExpect(status().isCreated())).get("id").asText();
        String enrollment=body(mvc.perform(post("/api/v1/agents/"+agent+"/enrollments").header("Authorization","Bearer "+f.token())).andExpect(status().isCreated())).get("enrollmentToken").asText();
        String token=body(mvc.perform(post("/api/v1/runner/enroll").contentType("application/json").content(json.writeValueAsString(Map.of("enrollmentToken",enrollment)))).andExpect(status().isCreated())).get("agentToken").asText();
        mvc.perform(post("/api/v1/runner/jobs/999/materials").header("Authorization","Bearer "+token).contentType("application/json").content("{\"executionId\":\"888\"}")).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("assignment_required"));
    }
    @Test void encryptedCredentialRoundTripHidesValuesAndRejectsChangedPreparation()throws Exception{
        Fixture f=fixture();
        putCredential(f,"0","synthetic-sensitive-one").andExpect(status().isOk()).andExpect(jsonPath("$.version").value("1")).andExpect(jsonPath("$.value").doesNotExist());
        var first=jdbc.queryForMap("SELECT key_id,nonce,ciphertext FROM execution_project_credentials WHERE project_id=? AND ref_id='bearer'",Long.valueOf(f.project()));
        assertThat(first.get("key_id")).isEqualTo("test-key"); assertThat((byte[])first.get("nonce")).hasSize(12);
        assertThat(new String((byte[])first.get("ciphertext"),java.nio.charset.StandardCharsets.UTF_8)).doesNotContain("synthetic-sensitive-one");
        local(f,f.project(),List.of(Map.of("refId","bearer","version","1")),List.of()).andExpect(status().isOk()).andExpect(jsonPath("$.credentials[0].value").value("synthetic-sensitive-one"));
        putCredential(f,"1","synthetic-sensitive-two").andExpect(status().isOk()).andExpect(jsonPath("$.version").value("2"));
        assertThat(jdbc.queryForObject("SELECT nonce FROM execution_project_credentials WHERE project_id=? AND ref_id='bearer'",byte[].class,Long.valueOf(f.project()))).isNotEqualTo((byte[])first.get("nonce"));
        local(f,f.project(),List.of(Map.of("refId","bearer","version","1")),List.of()).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("credential_version_conflict"));
        mvc.perform(get(f.url()+"/credentials").header("Authorization","Bearer "+f.token())).andExpect(status().isOk()).andExpect(jsonPath("$[0].value").doesNotExist());
    }
    @Test void staleWriteCannotCreateMissingCredential()throws Exception{
        Fixture f=fixture(); putCredential(f,"1","must-not-save").andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("credential_version_conflict"));
    }
    @Test void attachmentsHaveFixedHashAndVersionAndRejectSensitiveNetworkUploads()throws Exception{
        Fixture f=fixture(); String bytes=Base64.getEncoder().encodeToString("rows".getBytes());
        JsonNode file=body(mvc.perform(post(f.url()+"/attachments").header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(Map.of("refId","rows","expectedVersion","0","kind","file","contentBase64",bytes)))).andExpect(status().isCreated()));
        assertThat(file.get("hash").asText()).isEqualTo("bc51e9e65d79e1c90ba544ab2eae1044ccdf8c1af7a559ba375cba4276f7d99e");
        local(f,f.project(),List.of(),List.of(Map.of("refId","rows","version","1","hash",file.get("hash").asText()))).andExpect(status().isOk()).andExpect(jsonPath("$.attachments[0].contentBase64").value(bytes));
        mvc.perform(post(f.url()+"/attachments").header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(Map.of("refId","private-key","expectedVersion","0","kind","sensitive-network","contentBase64",bytes)))).andExpect(status().isBadRequest());
        mvc.perform(post(f.url()+"/attachments").header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(Map.of("refId","large","expectedVersion","0","kind","file","contentBase64",Base64.getEncoder().encodeToString(new byte[17]))))).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("attachment_size_limit"));
        mvc.perform(delete(f.url()+"/attachments/rows").param("expectedVersion","1").header("Authorization","Bearer "+f.token())).andExpect(status().isNoContent());
        // A deleted ref is absent to a refreshed client, but its internal version must never reset.
        mvc.perform(post(f.url()+"/attachments").header("Authorization","Bearer "+f.token()).contentType("application/json").content(json.writeValueAsString(Map.of("refId","rows","expectedVersion","0","kind","file","contentBase64",bytes)))).andExpect(status().isCreated()).andExpect(jsonPath("$.version").value("3"));
        local(f,f.project(),List.of(),List.of(Map.of("refId","rows","version","1","hash",file.get("hash").asText()))).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("attachment_version_conflict"));
    }
    @Test void corruptedOrRelocatedCiphertextAndMissingDeploymentKeyRefuseValuesWithoutLeakingThem()throws Exception{
        Fixture f=fixture();putCredential(f,"0","synthetic-sensitive-value").andExpect(status().isOk());
        jdbc.update("INSERT INTO execution_project_credentials(workspace_id,project_id,ref_id,version,key_id,nonce,ciphertext) SELECT workspace_id,project_id,'relocated',version,key_id,nonce,ciphertext FROM execution_project_credentials WHERE project_id=? AND ref_id='bearer'",Long.valueOf(f.project()));
        var invalid=local(f,f.project(),List.of(Map.of("refId","relocated","version","1")),List.of()).andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("credential_unavailable"));
        assertThat(invalid.andReturn().getResponse().getContentAsString()).doesNotContain("synthetic-sensitive-value");
        byte[] ciphertext=jdbc.queryForObject("SELECT ciphertext FROM execution_project_credentials WHERE project_id=? AND ref_id='bearer'",byte[].class,Long.valueOf(f.project()));
        ciphertext[0]^=1;jdbc.update("UPDATE execution_project_credentials SET ciphertext=? WHERE project_id=? AND ref_id='bearer'",ciphertext,Long.valueOf(f.project()));
        local(f,f.project(),List.of(Map.of("refId","bearer","version","1")),List.of()).andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("credential_unavailable"));
        byte[] key=Files.readAllBytes(keyFile);
        try{
            Files.delete(keyFile);
            var rejected=putCredential(f,"1","must-never-save-plaintext").andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("credential_unavailable"));
            assertThat(rejected.andReturn().getResponse().getContentAsString()).doesNotContain("must-never-save-plaintext").doesNotContain(keyFile.toString());
            assertThat(jdbc.queryForObject("SELECT version FROM execution_project_credentials WHERE project_id=? AND ref_id='bearer'",Long.class,Long.valueOf(f.project()))).isEqualTo(1L);
        }finally{Files.write(keyFile,key);}
    }
    @Test void platformInfrastructureRoleDoesNotGrantAnotherProjectsCredentialAccess()throws Exception{
        Fixture f=fixture();String username="material-outsider-"+f.project();
        String user=body(mvc.perform(post("/api/v1/auth/register").contentType("application/json").content(json.writeValueAsString(Map.of("username",username,"password","password123","displayName",username)))).andExpect(status().isCreated())).get("id").asText();
        jdbc.update("UPDATE users SET role='SUPERADMIN' WHERE id=?",Long.valueOf(user));
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",username,"password","password123")))).andExpect(status().isOk())).get("token").asText();
        mvc.perform(get(f.url()+"/credentials").header("Authorization","Bearer "+token)).andExpect(status().isForbidden());
        mvc.perform(post("/api/v1/execution-snapshots/"+f.snapshot()+"/local-materials").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsString(Map.of("projectId",f.project(),"credentials",List.of(),"attachments",List.of())))).andExpect(status().isForbidden());
    }
    @Test void deletingProjectRemovesItsCredentialEnvelopesAndOrdinaryAttachments()throws Exception{
        Fixture f=fixture();putCredential(f,"0","deleted-project-secret").andExpect(status().isOk());
        mvc.perform(post(f.url()+"/attachments").header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"refId\":\"rows\",\"expectedVersion\":\"0\",\"kind\":\"file\",\"contentBase64\":\"cm93cw==\"}")).andExpect(status().isCreated());
        mvc.perform(delete(f.url()).header("Authorization","Bearer "+f.token())).andExpect(status().isNoContent());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_project_credentials WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_project_attachments WHERE project_id=?",Long.class,Long.valueOf(f.project()))).isZero();
    }
}
