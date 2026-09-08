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
 * 任务 4/5 项目 ACL API 契约测试（规格 m3 §3.3）：GET/PUT /workspaces/{id}/projects/{projectId}/acl，
 * ADMIN+；role ∈ NONE/VIEWER/EDITOR/ADMIN；NONE=显式拒之门外；DELETE 行=恢复继承（契约括注）。
 * 任务 5 ACL 挂实体：ACL 操作的项目须经管理面创建（先建分组+项目再操作）；对不存在的项目 UUID，
 * PUT/GET/DELETE 皆 404 project_not_found（历史「任意 id 可预设」语义随实体化收紧）。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "apicc.server.allow-registration=true",
        "spring.datasource.url=jdbc:h2:mem:apicc-acl-test;DB_CLOSE_DELAY=-1"
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

    /** 建分组（项目创建的前置：项目须挂同工作区分组）。 */
    private String createGroup(String token, String wsId, String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/groups")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"" + name + "\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.id");
    }

    /** 经管理面建实体项目，返回项目 id（任务 5：ACL 只对实体项目可操作）。 */
    private String createProject(String token, String wsId, String groupId, String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/projects")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"groupId\":\"" + groupId + "\",\"name\":\"" + name + "\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.id");
    }

    /** 建分组+项目并返回项目 id（ACL 夹具一步到位）。 */
    private String createProjectFixture(String token, String wsId, String name) throws Exception {
        String groupId = createGroup(token, wsId, name + "分组");
        return createProject(token, wsId, groupId, name);
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
        String projectId = createProjectFixture(owner[1], wsId, "ACL写入项目");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
                        .header("Authorization", "Bearer " + admin[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + viewer[0] + "\",\"role\":\"NONE\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.userId").value(viewer[0]))
                .andExpect(jsonPath("$.role").value("NONE"));

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + viewer[0] + "\",\"role\":\"EDITOR\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("EDITOR"));
    }

    /** EDITOR/VIEWER/非成员写 ACL → 403 forbidden（守卫先于项目存在性校验）。 */
    @Test
    void putAclForbiddenBelowAdmin() throws Exception {
        String[] owner = newUser("a-bob");
        String[] editor = newUser("a-carl");
        String[] viewer = newUser("a-dave");
        String outsider = newUser("a-outsider1")[1];
        String wsId = createWorkspace(owner[1], "ACL写权限");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        putMember(owner[1], wsId, viewer[0], "VIEWER");
        String projectId = createProjectFixture(owner[1], wsId, "ACL写权限项目");

        for (String token : new String[]{editor[1], viewer[1], outsider}) {
            mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
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
        String projectId = createProjectFixture(owner[1], wsId, "ACL校验项目");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + java.util.UUID.randomUUID() + "\",\"role\":\"VIEWER\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("user_not_found"));

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + owner[0] + "\",\"role\":\"SUPERUSER\"}"))
                .andExpect(status().isBadRequest());
    }

    // ---- 项目存在性校验（任务 5 ACL 挂实体）----

    /** 项目不存在（未建实体的 UUID）→ PUT/GET/DELETE ACL 皆 404 project_not_found。 */
    @Test
    void aclOnMissingProjectReturns404() throws Exception {
        String[] owner = newUser("a-vin");
        String[] viewer = newUser("a-wanda");
        String wsId = createWorkspace(owner[1], "ACL项目404");
        String missingProjectId = java.util.UUID.randomUUID().toString();

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/" + missingProjectId + "/acl")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + viewer[0] + "\",\"role\":\"VIEWER\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("project_not_found"));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/" + missingProjectId + "/acl")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("project_not_found"));

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/projects/" + missingProjectId
                        + "/acl?userId=" + viewer[0])
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("project_not_found"));
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
        String projectId = createProjectFixture(owner[1], wsId, "ACL读权限项目");
        putAcl(owner[1], wsId, projectId, viewer[0], "NONE");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
                        .header("Authorization", "Bearer " + admin[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", hasSize(1)))
                .andExpect(jsonPath("$[0].userId").value(viewer[0]))
                .andExpect(jsonPath("$[0].role").value("NONE"));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk());

        for (String token : new String[]{editor[1], viewer[1], outsider}) {
            mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
                            .header("Authorization", "Bearer " + token))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.code").value("forbidden"));
        }
    }

    /** 实体项目无 ACL 行 → 200 []（对比：项目不存在 → 404，见 aclOnMissingProjectReturns404）。 */
    @Test
    void getAclEmptyWhenNoRows() throws Exception {
        String[] owner = newUser("a-lisa");
        String wsId = createWorkspace(owner[1], "ACL空清单");
        String projectId = createProjectFixture(owner[1], wsId, "ACL空清单项目");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
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
        String projectId = createProjectFixture(owner[1], wsId, "ACL删行项目");
        putAcl(owner[1], wsId, projectId, viewer[0], "NONE");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl?userId=" + viewer[0])
                        .header("Authorization", "Bearer " + admin[1]))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$").isEmpty());

        // 幂等
        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl?userId=" + viewer[0])
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
        String projectId = createProjectFixture(owner[1], wsId, "ACL删行权限项目");
        putAcl(owner[1], wsId, projectId, viewer[0], "NONE");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl?userId=" + viewer[0])
                        .header("Authorization", "Bearer " + editor[1]))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));
    }
}
