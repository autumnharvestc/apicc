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

import java.util.UUID;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 4 权限矩阵测试（计划步骤 1）：OWNER/ADMIN/EDITOR/VIEWER/非成员 五视角 ×
 * 读列表/建区/删区/读成员/改角色/移除/读ACL/改ACL。
 * 单方法顺序推进（矩阵步骤间有状态依赖：改角色→移除→删区），断言每格状态码。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:h2:mem:apicc-matrix-test;DB_CLOSE_DELAY=-1",
        "apicc.server.data-dir=target/test-data-matrix"
})
class WorkspacePermissionMatrixTest {

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

    /** 矩阵主用例：八种操作 × 五视角。 */
    @Test
    void permissionMatrixAcrossFiveViewsAndEightOperations() throws Exception {
        String[] owner = newUser("x-owner");
        String[] admin = newUser("x-admin");
        String[] editor = newUser("x-editor");
        String[] viewer = newUser("x-viewer");
        String[] outsider = newUser("x-outsider");
        String[] scratch = newUser("x-scratch"); // 改角色/移除的目标

        String wsId = createWorkspace(owner[1], "矩阵");
        putMember(owner[1], wsId, admin[0], "ADMIN");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        putMember(owner[1], wsId, viewer[0], "VIEWER");
        putMember(owner[1], wsId, scratch[0], "VIEWER");

        String ownerToken = owner[1], adminToken = admin[1], editorToken = editor[1],
                viewerToken = viewer[1], outsiderToken = outsider[1];

        // ---- 读列表 GET /workspaces：登录即可（五视角全 200）----
        for (String token : new String[]{ownerToken, adminToken, editorToken, viewerToken, outsiderToken}) {
            mockMvc.perform(get("/api/v1/workspaces").header("Authorization", "Bearer " + token))
                    .andExpect(status().isOk());
        }

        // ---- 建区 POST /workspaces：登录即可（五视角全 201）----
        for (String token : new String[]{ownerToken, adminToken, editorToken, viewerToken, outsiderToken}) {
            mockMvc.perform(post("/api/v1/workspaces")
                            .header("Authorization", "Bearer " + token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"name\":\"own-" + UUID.randomUUID() + "\"}"))
                    .andExpect(status().isCreated());
        }

        // ---- 读成员 GET members：成员 200，非成员 403 ----
        for (String token : new String[]{ownerToken, adminToken, editorToken, viewerToken}) {
            mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/members")
                            .header("Authorization", "Bearer " + token))
                    .andExpect(status().isOk());
        }
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/members")
                        .header("Authorization", "Bearer " + outsiderToken))
                .andExpect(status().isForbidden());

        // ---- 改角色 PUT members：EDITOR/VIEWER/非成员 403，ADMIN/OWNER 200 ----
        for (String token : new String[]{editorToken, viewerToken, outsiderToken}) {
            mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + scratch[0])
                            .header("Authorization", "Bearer " + token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"role\":\"EDITOR\"}"))
                    .andExpect(status().isForbidden());
        }
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + scratch[0])
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"EDITOR\"}"))
                .andExpect(status().isOk());
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + scratch[0])
                        .header("Authorization", "Bearer " + ownerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"EDITOR\"}"))
                .andExpect(status().isOk());

        // ---- 移除 DELETE members：EDITOR/VIEWER/非成员 403，ADMIN/OWNER 204（被移除者访问即失）----
        for (String token : new String[]{editorToken, viewerToken, outsiderToken}) {
            mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/members/" + scratch[0])
                            .header("Authorization", "Bearer " + token))
                    .andExpect(status().isForbidden());
        }
        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/members/" + scratch[0])
                        .header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isNoContent());
        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + scratch[1]))
                .andExpect(status().isForbidden());

        // ---- 读ACL GET acl：OWNER/ADMIN 200，EDITOR/VIEWER/非成员 403 ----
        for (String token : new String[]{ownerToken, adminToken}) {
            mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                            .header("Authorization", "Bearer " + token))
                    .andExpect(status().isOk());
        }
        for (String token : new String[]{editorToken, viewerToken, outsiderToken}) {
            mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                            .header("Authorization", "Bearer " + token))
                    .andExpect(status().isForbidden());
        }

        // ---- 改ACL PUT acl：OWNER/ADMIN 200，EDITOR/VIEWER/非成员 403 ----
        for (String token : new String[]{editorToken, viewerToken, outsiderToken}) {
            mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                            .header("Authorization", "Bearer " + token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"userId\":\"" + viewer[0] + "\",\"role\":\"NONE\"}"))
                    .andExpect(status().isForbidden());
        }
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + viewer[0] + "\",\"role\":\"NONE\"}"))
                .andExpect(status().isOk());
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/p1/acl")
                        .header("Authorization", "Bearer " + ownerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + viewer[0] + "\",\"role\":\"EDITOR\"}"))
                .andExpect(status().isOk());

        // ---- 删区 DELETE workspace：仅 OWNER 204，其余（含 ADMIN）403 ----
        for (String token : new String[]{adminToken, editorToken, viewerToken, outsiderToken}) {
            mockMvc.perform(delete("/api/v1/workspaces/" + wsId)
                            .header("Authorization", "Bearer " + token))
                    .andExpect(status().isForbidden());
        }
        mockMvc.perform(delete("/api/v1/workspaces/" + wsId)
                        .header("Authorization", "Bearer " + ownerToken))
                .andExpect(status().isNoContent());
        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + ownerToken))
                .andExpect(status().isNotFound());
    }
}
