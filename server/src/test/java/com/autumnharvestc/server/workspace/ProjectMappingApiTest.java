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
import org.springframework.test.web.servlet.ResultActions;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 计划 C 任务 1 项目映射桥 API 契约测试：POST /api/v1/workspaces/{id}/project-mapping。
 * 简报步骤 1 五分支：既有实体解析（created=false）/ 按需建组+项目（created=true，重放同 id 幂等）/
 * createIfMissing=false 且缺失 → 行级 missing:true（不建）/ EDITOR + createIfMissing=true 缺失 →
 * 行级 forbidden:true（裁定：批量部分成功语义，不整批 403）/ name 空白超长 → 400 validation_failed。
 * 另补：同名项目并存映射稳定（重放同 id）、batch_too_large、非成员 403 / 未知工作区 404（守卫先于一切）。
 * 独立内存库名 + admin 凭据走属性配置（计划 A/B 先例：AdminBootstrap 引导建号，DefaultWorkspaceSeeder
 * 建默认工作区+默认分组并给首个超管 OWNER 行——admin 直接可用）。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "apicc.server.allow-registration=true",
        "spring.datasource.url=jdbc:h2:mem:apicc-project-mapping-test;DB_CLOSE_DELAY=-1",
        "apicc.server.admin-username=admin",
        "apicc.server.admin-password=admin-pass-2026"
})
class ProjectMappingApiTest {

    @Autowired
    private MockMvc mockMvc;

    // ---- 测试脚手架（OrgApiTest 同款）----

    private String loginToken(String username, String password) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"" + username + "\",\"password\":\"" + password + "\"}"))
                .andExpect(status().isOk())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.token");
    }

    /** 注册普通账号（幂等：已注册的 409 视为就绪），返回 token。 */
    private String registerAndGetToken(String username) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"" + username + "\",\"password\":\"password123\",\"displayName\":\""
                                + username + "\"}"))
                .andReturn();
        assertThat(result.getResponse().getStatus()).isIn(201, 409);
        return loginToken(username, "password123");
    }

    /** 经超管清单按用户名取账号 id（AdminService 清单端点）。 */
    private String userId(String superadminToken, String username) throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/admin/users")
                        .header("Authorization", "Bearer " + superadminToken))
                .andExpect(status().isOk())
                .andReturn();
        List<String> ids = JsonPath.read(result.getResponse().getContentAsString(),
                "$[?(@.username=='" + username + "')].id");
        return ids.isEmpty() ? null : ids.get(0);
    }

    /** 把普通账号以指定角色加入默认工作区（计划 A 的入区定角色端点）。 */
    private void joinDefaultWorkspaceAs(String superadminToken, String username, String role) throws Exception {
        mockMvc.perform(put("/api/v1/admin/users/" + userId(superadminToken, username) + "/workspace-role")
                        .header("Authorization", "Bearer " + superadminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"workspaceId\":\"" + defaultWorkspaceId(superadminToken)
                                + "\",\"role\":\"" + role + "\"}"))
                .andExpect(status().isNoContent());
    }

    /** 握手端点取默认工作区 id。 */
    private String defaultWorkspaceId(String token) throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/connect").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.workspaceId");
    }

    /** 建分组（夹具内钉 201），返回 id。 */
    private String createGroup(String token, String wsId, String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/groups")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"" + name + "\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.id");
    }

    /** 建项目（夹具内钉 201），返回 id。 */
    private String createProject(String token, String wsId, String groupId, String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/projects")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"groupId\":\"" + groupId + "\",\"name\":\"" + name + "\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.id");
    }

    private ResultActions postMapping(String token, String wsId, String json) throws Exception {
        return mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/project-mapping")
                .header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json));
    }

    private String entry(String group, String project, boolean createIfMissing) {
        return "{\"group\":\"" + group + "\",\"project\":\"" + project + "\",\"createIfMissing\":" + createIfMissing + "}";
    }

    private String entriesOf(String... items) {
        return "{\"entries\":[" + String.join(",", items) + "]}";
    }

    private int listSize(String token, String url) throws Exception {
        MvcResult result = mockMvc.perform(get(url).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn();
        return ((List<?>) JsonPath.read(result.getResponse().getContentAsString(), "$")).size();
    }

    private int groupCount(String token, String wsId) throws Exception {
        return listSize(token, "/api/v1/workspaces/" + wsId + "/groups");
    }

    private int projectCount(String token, String wsId) throws Exception {
        return listSize(token, "/api/v1/workspaces/" + wsId + "/projects");
    }

    // ---- 分支 1/2/3：既有解析、按需建、missing 行 ----

    @Test
    void mappingResolvesCreatesAndIsIdempotent() throws Exception {
        String admin = loginToken("admin", "admin-pass-2026");
        String wsId = defaultWorkspaceId(admin);

        // 分支 1：既有实体 → 解析到同一实体 id、created=false（createIfMissing=false 只解析）
        String groupId = createGroup(admin, wsId, "电商");
        String projectId = createProject(admin, wsId, groupId, "宠物商店");
        postMapping(admin, wsId, entriesOf(entry("电商", "宠物商店", false)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mappings[0].group").value("电商"))
                .andExpect(jsonPath("$.mappings[0].project").value("宠物商店"))
                .andExpect(jsonPath("$.mappings[0].groupId").value(groupId))
                .andExpect(jsonPath("$.mappings[0].projectId").value(projectId))
                .andExpect(jsonPath("$.mappings[0].created").value(false));

        // 分支 2：新目录名 + createIfMissing=true → 建组+项目 → created=true
        String body = entriesOf(entry("教育", "校园系统", true));
        MvcResult created = postMapping(admin, wsId, body).andExpect(status().isOk())
                .andExpect(jsonPath("$.mappings[0].created").value(true))
                .andReturn();
        String createdBody = created.getResponse().getContentAsString();
        String newGroupId = JsonPath.read(createdBody, "$.mappings[0].groupId");
        String newProjectId = JsonPath.read(createdBody, "$.mappings[0].projectId");
        assertThat(newGroupId).isNotEqualTo(groupId);
        assertThat(newProjectId).isNotEqualTo(projectId);
        // 新建分组 is_default=false（默认分组唯一性不被迁移扰动）
        MvcResult groupsResult = mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/groups")
                        .header("Authorization", "Bearer " + admin))
                .andExpect(status().isOk())
                .andReturn();
        List<Boolean> defaults = JsonPath.read(groupsResult.getResponse().getContentAsString(),
                "$[?(@.name=='教育')].isDefault");
        assertThat(defaults).containsExactly(false);
        // 重放同一请求 → 同 id、created=false（幂等）
        postMapping(admin, wsId, body).andExpect(status().isOk())
                .andExpect(jsonPath("$.mappings[0].groupId").value(newGroupId))
                .andExpect(jsonPath("$.mappings[0].projectId").value(newProjectId))
                .andExpect(jsonPath("$.mappings[0].created").value(false));

        // 分支 3：createIfMissing=false 且缺失 → missing:true（不建）；混合批次部分成功
        int groupsBefore = groupCount(admin, wsId);
        int projectsBefore = projectCount(admin, wsId);
        postMapping(admin, wsId, entriesOf(
                        entry("电商", "宠物商店", false),
                        entry("不存在组", "不存在项目", false)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mappings[0].projectId").value(projectId))
                .andExpect(jsonPath("$.mappings[1].group").value("不存在组"))
                .andExpect(jsonPath("$.mappings[1].missing").value(true))
                .andExpect(jsonPath("$.mappings[1].groupId").doesNotExist())
                .andExpect(jsonPath("$.mappings[1].projectId").doesNotExist());
        assertThat(groupCount(admin, wsId)).isEqualTo(groupsBefore);
        assertThat(projectCount(admin, wsId)).isEqualTo(projectsBefore);
    }

    // ---- 同名项目并存：映射稳定（重放同 id；listByGroup 按 created_at,id 决定性排序）----

    @Test
    void sameNameProjectsMapStably() throws Exception {
        String admin = loginToken("admin", "admin-pass-2026");
        String wsId = defaultWorkspaceId(admin);
        String groupId = createGroup(admin, wsId, "并存组");
        String p1 = createProject(admin, wsId, groupId, "同名项目");
        String p2 = createProject(admin, wsId, groupId, "同名项目");
        assertThat(p1).isNotEqualTo(p2);
        // 首次映射命中其一（创建序首个；同刻并列由 id 决定性排序），重放同一 id（迁移幂等的实际保证）
        MvcResult first = postMapping(admin, wsId, entriesOf(entry("并存组", "同名项目", false)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mappings[0].groupId").value(groupId))
                .andReturn();
        String mapped = JsonPath.read(first.getResponse().getContentAsString(), "$.mappings[0].projectId");
        assertThat(mapped).isIn(p1, p2);
        postMapping(admin, wsId, entriesOf(entry("并存组", "同名项目", false)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mappings[0].projectId").value(mapped));
    }

    // ---- 分支 4：EDITOR 无权建 → 行级 forbidden:true（批量部分成功裁定），解析既有不受限 ----

    @Test
    void editorGetsRowLevelForbiddenAndCanResolveExisting() throws Exception {
        String admin = loginToken("admin", "admin-pass-2026");
        String wsId = defaultWorkspaceId(admin);
        registerAndGetToken("bob-mapping");
        joinDefaultWorkspaceAs(admin, "bob-mapping", "EDITOR");
        String editor = loginToken("bob-mapping", "password123");

        String groupId = createGroup(admin, wsId, "编辑可见组");
        String projectId = createProject(admin, wsId, groupId, "既有项目");

        // EDITOR 解析既有实体 → 200 resolved（解析是成员可读语义）
        postMapping(editor, wsId, entriesOf(entry("编辑可见组", "既有项目", false)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mappings[0].groupId").value(groupId))
                .andExpect(jsonPath("$.mappings[0].projectId").value(projectId))
                .andExpect(jsonPath("$.mappings[0].created").value(false));

        int groupsBefore = groupCount(editor, wsId);
        int projectsBefore = projectCount(editor, wsId);

        // 组缺失 + createIfMissing=true → 行级 forbidden:true（不整批 403），不建
        postMapping(editor, wsId, entriesOf(entry("无权新组", "新项目", true)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mappings[0].forbidden").value(true))
                .andExpect(jsonPath("$.mappings[0].groupId").doesNotExist());
        // 组在但项目缺失 + createIfMissing=true → 行级 forbidden:true
        postMapping(editor, wsId, entriesOf(entry("编辑可见组", "无权新项目", true)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mappings[0].forbidden").value(true))
                .andExpect(jsonPath("$.mappings[0].groupId").doesNotExist())
                .andExpect(jsonPath("$.mappings[0].projectId").doesNotExist());
        // EDITOR createIfMissing=false 且缺失 → missing:true（只解析不建）
        postMapping(editor, wsId, entriesOf(entry("无权新组", "新项目", false)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mappings[0].missing").value(true));
        assertThat(groupCount(editor, wsId)).isEqualTo(groupsBefore);
        assertThat(projectCount(editor, wsId)).isEqualTo(projectsBefore);
    }

    // ---- 分支 5：name 校验 + 批量上限 + 守卫面 ----

    @Test
    void validationAndBatchLimits() throws Exception {
        String admin = loginToken("admin", "admin-pass-2026");
        String wsId = defaultWorkspaceId(admin);

        // 名称空白 → 400 validation_failed；名称超长（65 字符）→ 400 validation_failed
        postMapping(admin, wsId, entriesOf(entry("  ", "项目", true)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
        postMapping(admin, wsId, entriesOf(entry("组", "p".repeat(65), true)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));

        // 201 条 → 400 batch_too_large；200 条整边界 → 200（缺失行 missing 呈现，不建）
        StringBuilder tooMany = new StringBuilder("{\"entries\":[");
        for (int i = 0; i < 201; i++) {
            if (i > 0) {
                tooMany.append(',');
            }
            tooMany.append(entry("批组" + i, "批项目", false));
        }
        tooMany.append("]}");
        postMapping(admin, wsId, tooMany.toString())
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("batch_too_large"));
        StringBuilder atLimit = new StringBuilder("{\"entries\":[");
        for (int i = 0; i < 200; i++) {
            if (i > 0) {
                atLimit.append(',');
            }
            atLimit.append(entry("界组" + i, "批项目", false));
        }
        atLimit.append("]}");
        MvcResult boundary = postMapping(admin, wsId, atLimit.toString())
                .andExpect(status().isOk())
                .andReturn();
        assertThat(((List<?>) JsonPath.read(boundary.getResponse().getContentAsString(), "$.mappings")).size())
                .isEqualTo(200);

        // 非成员 → 403 forbidden（守卫先于一切）；未知工作区 → 404 workspace_not_found
        String outsider = registerAndGetToken("oscar-mapping");
        postMapping(outsider, wsId, entriesOf(entry("任意组", "任意项目", false)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));
        postMapping(admin, java.util.UUID.randomUUID().toString(), entriesOf(entry("组", "项目", false)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("workspace_not_found"));
    }
}
