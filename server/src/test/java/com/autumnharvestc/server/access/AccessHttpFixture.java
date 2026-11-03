package com.autumnharvestc.server.access;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Synthetic accounts and real application routes, with explicit revisions in each request. */
@SpringBootTest
@AutoConfigureMockMvc(print = org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
@TestPropertySource(properties = {
        "apicc.server.allow-registration=true",
        "spring.datasource.url=jdbc:h2:mem:apicc-access-t2;DB_CLOSE_DELAY=-1"
})
abstract class AccessHttpFixture {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired ProjectAccessService access;

    record Actor(String id, String token) {}
    record Scope(Actor owner, Actor target, String workspace, String project) {
        String workspaceUrl() { return "/api/v1/workspaces/" + workspace; }
        String projectUrl() { return workspaceUrl() + "/projects/" + project; }
    }

    JsonNode body(ResultActions response) throws Exception {
        return json.readTree(response.andReturn().getResponse().getContentAsString());
    }

    Actor newActor() throws Exception {
        String name = "t2-" + UUID.randomUUID().toString().substring(0, 16);
        String id = body(mvc.perform(post("/api/v1/auth/register").contentType("application/json")
                .content(json.writeValueAsString(Map.of("username", name, "password", "password123", "displayName", name))))
                .andExpect(status().isCreated())).get("id").asText();
        String token = body(mvc.perform(post("/api/v1/auth/login").contentType("application/json")
                .content(json.writeValueAsString(Map.of("username", name, "password", "password123"))))
                .andExpect(status().isOk())).get("token").asText();
        return new Actor(id, token);
    }

    Scope scope() throws Exception {
        Actor owner = newActor();
        Actor target = newActor();
        String ws = body(mvc.perform(post("/api/v1/workspaces").header("Authorization", "Bearer " + owner.token())
                .contentType("application/json").content(json.writeValueAsString(Map.of("name", "T2 access " + owner.id()))))
                .andExpect(status().isCreated())).get("id").asText();
        String group = body(mvc.perform(post("/api/v1/workspaces/" + ws + "/groups")
                .header("Authorization", "Bearer " + owner.token()).contentType("application/json")
                .content("{\"name\":\"T2 group\"}")).andExpect(status().isCreated())).get("id").asText();
        String project = body(mvc.perform(post("/api/v1/workspaces/" + ws + "/projects")
                .header("Authorization", "Bearer " + owner.token()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("groupId", group, "name", "T2 project"))))
                .andExpect(status().isCreated())).get("id").asText();
        return new Scope(owner, target, ws, project);
    }

    ResultActions member(Scope f, String role, long revision) throws Exception {
        return mvc.perform(put(f.workspaceUrl() + "/members/" + f.target().id())
                .header("Authorization", "Bearer " + f.owner().token()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("role", role, "expectedRevision", revision))));
    }

    ResultActions acl(Scope f, String role, long revision) throws Exception {
        return mvc.perform(put(f.projectUrl() + "/acl")
                .header("Authorization", "Bearer " + f.owner().token()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("userId", f.target().id(), "role", role, "expectedRevision", revision))));
    }

    ResultActions assets(Scope f) throws Exception {
        return mvc.perform(get(f.projectUrl() + "/assets").header("Authorization", "Bearer " + f.target().token()));
    }
}
