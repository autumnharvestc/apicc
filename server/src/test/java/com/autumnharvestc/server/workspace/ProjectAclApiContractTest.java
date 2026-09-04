package com.autumnharvestc.server.workspace;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import static org.hamcrest.Matchers.hasSize;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 4 项目 ACL API 契约测试（规格 m3 §3.3）：GET/PUT /workspaces/{id}/projects/{projectId}/acl，
 * ADMIN+；role ∈ NONE/VIEWER/EDITOR/ADMIN；NONE=显式拒之门外；DELETE 行=恢复继承（契约括注）。
 * 裁定 A：ACL 按 projectId 寻址、服务端不做 projectId→目录校验——任意 id 可预设。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:h2:mem:apicc-acl-test;DB_CLOSE_DELAY=-1",
        "apicc.server.data-dir=target/test-data-acl"
})
class ProjectAclApiContractTest {

    @Autowired
    private MockMvc mockMvc;

    // ---- 测试脚手架 ----

    /** 注册并登录，返回 [userId, token]。 */
    private String[] newUser(String username) throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"" + username + "\",\"password\":\"password123\",\"displayName\":\""
                                + username + "\"}"))
                .andExpect(status().isCreated());
        MvcResult result = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"" + username + "\",\"password\":\"password123\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String body = result.getResponse().getContentAsString();
        return new String[]{JsonPath.read(body, "$.user.id"), JsonPath.read(body, "$.token")};
    }

    private String createWorkspace(String token, String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"" + name + "\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.id");
    }

    private void putMember(String callerToken, String wsId, String targetUserId, String role) throws Exception {
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + targetUserId)
                        .header("Authorization", "Bearer " + callerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"" + role + "\"}"))
                .andExpect(status().isOk());
    }

    private MvcResult putAcl(String callerToken, String wsId, String projectId, String targetUserId, String role)
            throws Exception {
        return mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
                        .header("Authorization", "Bearer " + callerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + targetUserId + "\",\"role\":\"" + role + "\"}"))
                .andReturn();
    }

    // ---- PUT acl（ADMIN+）----

    /** OWNER/ADMIN 可置 ACL 行（覆盖值 NONE/VIEWER/EDITOR/ADMIN 皆合法）；响应为行视图。 */
    @Test
    void putAclByAdminAndOwnerSucceeds() throws Exception {
        String[] owner = newUser("a-owner");
        String[] admin = newUser("a-admin");
        String[] viewer = newUser("a-viewer");
        String wsId = createWorkspace(owner[1], "ACL写入");
        putMember(owner[1], wsId, admin[0], "ADMIN");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                        .header("Authorization", "Bearer " + admin[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + viewer[0] + "\",\"role\":\"NONE\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.userId").value(viewer[0]))
                .andExpect(jsonPath("$.role").value("NONE"));

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + viewer[0] + "\",\"role\":\"EDITOR\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("EDITOR"));
    }

    /** EDITOR/VIEWER/非成员写 ACL → 403 forbidden。 */
    @Test
    void putAclForbiddenBelowAdmin() throws Exception {
        String[] owner = newUser("a-bob");
        String[] editor = newUser("a-carl");
        String[] viewer = newUser("a-dave");
        String outsider = newUser("a-outsider1")[1];
        String wsId = createWorkspace(owner[1], "ACL写权限");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        putMember(owner[1], wsId, viewer[0], "VIEWER");

        for (String token : new String[]{editor[1], viewer[1], outsider}) {
            mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                            .header("Authorization", "Bearer " + token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"userId\":\"" + viewer[0] + "\",\"role\":\"NONE\"}"))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.code").value("forbidden"));
        }
    }

    /** 目标用户不存在 → 404 user_not_found；role 非法值 → 400。 */
    @Test
    void putAclValidatesTargetUserAndRole() throws Exception {
        String[] owner = newUser("a-erin");
        String wsId = createWorkspace(owner[1], "ACL校验");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + java.util.UUID.randomUUID() + "\",\"role\":\"VIEWER\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("user_not_found"));

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + owner[0] + "\",\"role\":\"SUPERUSER\"}"))
                .andExpect(status().isBadRequest());
    }

    /** 裁定 A：ACL 可对任意 projectId 预设（服务端不做 projectId→内容目录校验）。 */
    @Test
    void putAclAcceptsArbitraryProjectId() throws Exception {
        String[] owner = newUser("a-frank");
        String[] viewer = newUser("a-grace");
        String wsId = createWorkspace(owner[1], "任意项目ID");

        MvcResult result = putAcl(owner[1], wsId, "no-such-content-project", viewer[0], "VIEWER");
        org.assertj.core.api.Assertions.assertThat(result.getResponse().getStatus()).isEqualTo(200);
    }

    // ---- GET acl（ADMIN+）----

    /** OWNER/ADMIN 可读清单 [{userId, role}]；EDITOR/VIEWER/非成员 → 403 forbidden。 */
    @Test
    void getAclReadableByAdminOnly() throws Exception {
        String[] owner = newUser("a-heidi");
        String[] admin = newUser("a-ivan");
        String[] editor = newUser("a-judy");
        String[] viewer = newUser("a-ken");
        String outsider = newUser("a-outsider2")[1];
        String wsId = createWorkspace(owner[1], "ACL读权限");
        putMember(owner[1], wsId, admin[0], "ADMIN");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        putMember(owner[1], wsId, viewer[0], "VIEWER");
        putAcl(owner[1], wsId, "p1", viewer[0], "NONE");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                        .header("Authorization", "Bearer " + admin[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", hasSize(1)))
                .andExpect(jsonPath("$[0].userId").value(viewer[0]))
                .andExpect(jsonPath("$[0].role").value("NONE"));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk());

        for (String token : new String[]{editor[1], viewer[1], outsider}) {
            mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                            .header("Authorization", "Bearer " + token))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.code").value("forbidden"));
        }
    }

    /** 空清单 → 200 []。 */
    @Test
    void getAclEmptyWhenNoRows() throws Exception {
        String[] owner = newUser("a-lisa");
        String wsId = createWorkspace(owner[1], "ACL空清单");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/p9/acl")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isEmpty());
    }

    // ---- DELETE acl（DELETE 行=恢复继承，规格 §3.3 括注；ADMIN+）----

    /** ADMIN 删行 → 204 且清单中消失（恢复继承）；重复删除幂等 204。 */
    @Test
    void deleteAclRowRestoresInheritanceIdempotently() throws Exception {
        String[] owner = newUser("a-mallory");
        String[] admin = newUser("a-nancy");
        String[] viewer = newUser("a-olivia");
        String wsId = createWorkspace(owner[1], "ACL删行");
        putMember(owner[1], wsId, admin[0], "ADMIN");
        putAcl(owner[1], wsId, "p1", viewer[0], "NONE");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/projects/p1/acl?userId=" + viewer[0])
                        .header("Authorization", "Bearer " + admin[1]))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$").isEmpty());

        // 幂等
        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/projects/p1/acl?userId=" + viewer[0])
                        .header("Authorization", "Bearer " + admin[1]))
                .andExpect(status().isNoContent());
    }

    /** EDITOR 删行 → 403 forbidden。 */
    @Test
    void deleteAclForbiddenBelowAdmin() throws Exception {
        String[] owner = newUser("a-peter");
        String[] editor = newUser("a-quinn");
        String[] viewer = newUser("a-rob");
        String wsId = createWorkspace(owner[1], "ACL删行权限");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        putAcl(owner[1], wsId, "p1", viewer[0], "NONE");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/projects/p1/acl?userId=" + viewer[0])
                        .header("Authorization", "Bearer " + editor[1]))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));
    }
}
