package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.access.AccessHttpFixture;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.context.TestPropertySource;
import java.util.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real registered identities, live membership, project assets and revisions; no test jobs. */
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-sync-t7;DB_CLOSE_DELAY=-1", "apicc.server.allow-registration=true"})
abstract class SyncHttpFixture extends AccessHttpFixture {
    Scope f;
    final String module="00000000-0000-4000-8000-000000000071", secondModule="00000000-0000-4000-8000-000000000072";
    @BeforeEach void validProject() throws Exception {
        f=scope(); member(f,"EDITOR",0).andExpect(status().isOk());
        mvc.perform(put(f.projectUrl()+"/assets").header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
            .content(json.writeValueAsString(Map.of("format","contract-files-v1","contractProjectId","00000000-0000-4000-8000-000000000070","expectedVersion","0","changes",initialProjectFiles(),"deletes",List.of())))).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("1"));
    }
    JsonNode initialProjectFiles() {
        // Java-only source metadata tests do not enable Core asset decoding.
        return json.valueToTree(List.of(Map.of("path","project.yaml","content","id: 00000000-0000-4000-8000-000000000070\nname: T7\n"),
            Map.of("path","collections/"+module+"/collection.yaml","content","id: "+module+"\nname: Target\n"),
            Map.of("path","collections/"+secondModule+"/collection.yaml","content","id: "+secondModule+"\nname: Second\n")));
    }
    String anotherProject() throws Exception {
        String group=body(mvc.perform(get(f.projectUrl()+"/assets").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("groupId").asText();
        String project=body(mvc.perform(post(f.workspaceUrl()+"/projects").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(json.writeValueAsString(Map.of("groupId",group,"name","Another T7 target")))).andExpect(status().isCreated())).path("id").asText();
        mvc.perform(get(f.workspaceUrl()+"/projects/"+project+"/assets").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("0"));
        return project;
    }
    Actor editor(){return f.target();}
    ObjectNode sourceBody(String kind){
        var source=json.createObjectNode().put("formatVersion",1).put("id",UUID.randomUUID().toString()).put("revision","1").put("moduleId",module).put("kind",kind);
        source.set("schedule",json.valueToTree(Map.of("enabled",false,"rule",Map.of("kind","cron","expression","0 0 * * * *","timeZone","UTC","dstOverlap","first"))));
        if(kind.equals("url"))source.put("url","https://spec.test/openapi.json");
        else {source.put("repositoryUrl",kind.equals("git-ssh")?"ssh://git@spec.test/repo.git":"https://spec.test/repo.git").put("ref","main").put("filePath","openapi.yaml");if(kind.equals("git-ssh"))source.put("privateKeyRef","ssh-key").put("knownHostsRef","known-hosts");}
        return source;
    }
    ObjectNode write(JsonNode source){var body=json.createObjectNode().put("formatVersion",1).put("intentId",UUID.randomUUID().toString()).put("expectedAssetVersion","1").put("expectedSourceRevision","0");body.set("source",source);return body;}
    ObjectNode sourceUpdateBody(JsonNode source){var copy=(ObjectNode)source.deepCopy();copy.put("revision",new java.math.BigInteger(source.path("revision").asText()).add(java.math.BigInteger.ONE).toString());return write(copy).put("expectedSourceRevision",source.path("revision").asText());}
    JsonNode createSourceAsAdmin(String kind) throws Exception{return body(sourceRequest("POST","/sources",f.owner(),write(sourceBody(kind))).andExpect(status().isCreated()));}
    JsonNode readSourceAsAdmin(String id) throws Exception{return body(sourceRequest("GET","/sources/"+id,f.owner(),null).andExpect(status().isOk()));}
    ResultActions sourceRequest(String method,String path,Actor actor,JsonNode value) throws Exception {
        var request=request(org.springframework.http.HttpMethod.valueOf(method),f.projectUrl()+"/sync"+path).header("Authorization","Bearer "+actor.token());
        if(value!=null)request.contentType("application/json").content(json.writeValueAsString(value));
        return mvc.perform(request);
    }
    void capabilities(String role,Map<String,String> caps) throws Exception {
        long revision=body(mvc.perform(get(f.projectUrl()+"/access-members/"+editor().id()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();
        var body=new LinkedHashMap<String,Object>();body.put("expectedRevision",revision);body.put("capabilities",caps);if(role!=null)body.put("role",role);
        mvc.perform(put(f.projectUrl()+"/access-members/"+editor().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(json.writeValueAsString(body))).andExpect(status().isOk());
    }
}
