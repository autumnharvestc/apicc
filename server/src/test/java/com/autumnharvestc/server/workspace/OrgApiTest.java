package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.store.FileVersionRepo;
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
import static org.hamcrest.Matchers.matchesPattern;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 计划 B 任务 2 组织管理 API 契约测试（规格 2026-09-08 §4）：
 * 分组 CRUD（ADMIN+ 守卫/默认分组不可改删/同工作区重名守卫）、项目 CRUD（同名允许/移动/删除级联内容）、
 * 连接握手 GET /api/v1/connect（默认工作区 + myRole）。
 * 独立内存库名 + admin 凭据走属性配置（AdminBootstrap 引导建号）；默认工作区/默认分组由
 * DefaultWorkspaceSeeder 启动种子就位（首个超管自动 OWNER——裁定②，myRole 断言据此对齐为 OWNER）。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "apicc.server.allow-registration=true",
        "spring.datasource.url=jdbc:h2:mem:apicc-org-api-test;DB_CLOSE_DELAY=-1",
        "apicc.server.admin-username=admin",
        "apicc.server.admin-password=admin-pass-2026"
})
class OrgApiTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private FileVersionRepo fileVersions;

    // ---- 测试脚手架（夹具按简报脚注实现）----

    private static String loginBody(String username, String password) {
        return "{\"username\":\"" + username + "\",\"password\":\"" + password + "\"}";
    }

    /** 登录并提取 token。 */
    private String loginToken(String username, String password) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody(username, password)))
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

    /** 握手端点取默认工作区 id（connect 本任务交付）。 */
    private String defaultWorkspaceId(String token) throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/connect").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.workspaceId");
    }

    /** 默认分组 id：分组清单按 isDefault=TRUE 过滤（守卫判据为标记列，非名称比对）。 */
    private String defaultGroupId(String admin, String wsId) throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/groups")
                        .header("Authorization", "Bearer " + admin))
                .andExpect(status().isOk())
                .andReturn();
        List<String> ids = JsonPath.read(result.getResponse().getContentAsString(),
                "$[?(@.isDefault == true)].id");
        assertThat(ids).hasSize(1);
        return ids.get(0);
    }

    private ResultActions postGroup(String token, String wsId, String name) throws Exception {
        return mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/groups")
                .header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"" + name + "\"}"));
    }

    private ResultActions renameGroup(String token, String wsId, String groupId, String name) throws Exception {
        return mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/groups/" + groupId + "/rename")
                .header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"" + name + "\"}"));
    }

    private ResultActions deleteGroup(String token, String wsId, String groupId) throws Exception {
        return mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/groups/" + groupId)
                .header("Authorization", "Bearer " + token));
    }

    /** 建项目（夹具内钉 201），返回 ResultActions 供 idOf 提取。 */
    private ResultActions createProject(String token, String wsId, String groupId, String name) throws Exception {
        return mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/projects")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"groupId\":\"" + groupId + "\",\"name\":\"" + name + "\"}"))
                .andExpect(status().isCreated());
    }

    private ResultActions renameProject(String token, String wsId, String projectId, String name) throws Exception {
        return mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/rename")
                .header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"" + name + "\"}"));
    }

    private ResultActions moveProject(String token, String wsId, String projectId, String groupId) throws Exception {
        return mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/move")
                .header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"groupId\":\"" + groupId + "\"}"));
    }

    private ResultActions deleteProject(String token, String wsId, String projectId) throws Exception {
        return mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/projects/" + projectId)
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isNoContent());
    }

    /** 推文件（新文件 baseVersion=0 → 201）。 */
    private void putFile(String token, String wsId, String path, String content) throws Exception {
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + path)
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"" + content + "\",\"baseVersion\":0}"))
                .andExpect(status().isCreated());
    }

    /** 建分组/建项目响应体提取 id。 */
    private String idOf(ResultActions action) throws Exception {
        return JsonPath.read(action.andReturn().getResponse().getContentAsString(), "$.id");
    }

    // ---- 分组：ADMIN+ 才可建；默认分组守卫；重名守卫 ----

    @Test
    void groupCrudGuards() throws Exception {
        String admin = loginToken("admin", "admin-pass-2026");
        String wsId = defaultWorkspaceId(admin);
        // 普通成员 alice 入区 EDITOR（经计划 A 入区定角色端点）
        registerAndGetToken("alice");
        joinDefaultWorkspaceAs(admin, "alice", "EDITOR");
        String alice = loginToken("alice", "password123");

        // EDITOR 建分组 → 403 forbidden（守卫先于存在性/重名检查）
        mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/groups").header("Authorization", "Bearer " + alice)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"研发\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));
        // ADMIN 建分组 → 201 {id, name}
        var created = postGroup(admin, wsId, "研发").andExpect(status().isCreated())
                .andExpect(jsonPath("$.name").value("研发"));
        // 同名 → 409 group_name_taken
        postGroup(admin, wsId, "研发").andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("group_name_taken"));
        // 改名 → 200；与另一分组撞名 → 409
        renameGroup(admin, wsId, idOf(created), "平台组").andExpect(status().isOk());
        String other = idOf(postGroup(admin, wsId, "后端组").andExpect(status().isCreated()));
        renameGroup(admin, wsId, other, "平台组").andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("group_name_taken"));
        // 默认分组：改名/删除 → 400 default_group_immutable
        String defaultId = defaultGroupId(admin, wsId);
        renameGroup(admin, wsId, defaultId, "改").andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("default_group_immutable"));
        deleteGroup(admin, wsId, defaultId).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("default_group_immutable"));
        // 分组名空白 → 400 validation_failed
        postGroup(admin, wsId, "  ").andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
        // 分组名超长（65 字符）→ 400 validation_failed
        postGroup(admin, wsId, "g".repeat(65)).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
        // 非空分组删除 → 409 group_not_empty；空分组 → 204
        createProject(admin, wsId, other, "项目甲");
        deleteGroup(admin, wsId, other).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("group_not_empty"));
        String temporary = idOf(postGroup(admin, wsId, "临时组").andExpect(status().isCreated()));
        deleteGroup(admin, wsId, temporary).andExpect(status().isNoContent());
        // 不存在的分组改名/删除 → 404 group_not_found（幽灵 id 用不存在的大数字，BIGINT 化口径 5）
        String ghost = "999999";
        renameGroup(admin, wsId, ghost, "幻影").andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("group_not_found"));
        deleteGroup(admin, wsId, ghost).andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("group_not_found"));
    }

    // ---- 项目：建/改名/移动/删除；同名允许；删除级联内容 ----

    @Test
    void projectCrudAndCascade() throws Exception {
        String admin = loginToken("admin", "admin-pass-2026");
        String wsId = defaultWorkspaceId(admin);
        String g = idOf(postGroup(admin, wsId, "g1").andExpect(status().isCreated()));
        // 同名项目并存 → 均 201，id 不同（夹具内钉 201）
        var p1 = createProject(admin, wsId, g, "同名项目");
        var p2 = createProject(admin, wsId, g, "同名项目");
        assertThat(idOf(p1)).isNotEqualTo(idOf(p2));
        // 项目名空白/超长 → 400 validation_failed
        mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/projects")
                        .header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"groupId\":\"" + g + "\",\"name\":\"   \"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
        mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/projects")
                        .header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"groupId\":\"" + g + "\",\"name\":\"" + "p".repeat(65) + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
        // 项目建在别的工作区/不存在的分组 → 404 group_not_found（外键不保证同工作区，服务层校验；
        // 幽灵分组 id 用不存在的大数字——BIGINT 化后 id 为数字）
        mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/projects")
                        .header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"groupId\":\"999999\",\"name\":\"孤儿\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("group_not_found"));
        // 项目清单：两同名项目均在列且 groupId 正确
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/projects").header("Authorization", "Bearer " + admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.name=='同名项目')]", org.hamcrest.Matchers.hasSize(2)));
        // 改名 → 200（同名允许，不查重）
        renameProject(admin, wsId, idOf(p2), "同名项目").andExpect(status().isOk());
        // 移动分组 → 204；目标分组不存在 → 404 group_not_found
        String g2 = idOf(postGroup(admin, wsId, "g2").andExpect(status().isCreated()));
        moveProject(admin, wsId, idOf(p2), g2).andExpect(status().isNoContent());
        moveProject(admin, wsId, idOf(p2), "999999")
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("group_not_found"));
        // 推一个文件进 p1 再删除 p1 → 204；文件行随之消失（file_versions 按 project_id 前缀删除）
        String p1Path = idOf(p1) + "/apis/a/api.yaml";
        putFile(admin, wsId, p1Path, "hello");
        assertThat(fileVersions.find(Long.parseLong(wsId), p1Path)).isPresent(); // 级联前基线：行在
        deleteProject(admin, wsId, idOf(p1));
        assertThat(fileVersions.find(Long.parseLong(wsId), p1Path)).isEmpty(); // 级联后：版本行消失
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree").header("Authorization", "Bearer " + admin))
                .andExpect(jsonPath("$.projects[?(@.id=='" + idOf(p1) + "')]").isEmpty())
                .andExpect(jsonPath("$.files[?(@.path=='" + p1Path + "')]").isEmpty());
        // 删除不存在的项目 → 404 project_not_found（幽灵 id 用不存在的大数字）
        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/projects/999999")
                        .header("Authorization", "Bearer " + admin))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("project_not_found"));
    }

    // ---- 握手：认证后返回默认工作区 ----

    @Test
    void connectReturnsDefaultWorkspace() throws Exception {
        String admin = loginToken("admin", "admin-pass-2026");
        // myRole 按夹具实际对齐：默认工作区由 seeder 建立，首个超管自动 OWNER（裁定②）
        // workspaceId 形态钉子：对外为字符串化数字（2026-09-09 BIGINT 化，全局不变量 1）
        mockMvc.perform(get("/api/v1/connect").header("Authorization", "Bearer " + admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.workspaceId").value(matchesPattern("^\\d+$")))
                .andExpect(jsonPath("$.workspaceName").value("默认工作区"))
                .andExpect(jsonPath("$.myRole").value("OWNER"));
        // 非成员 → 403 forbidden（裁定②兜底语义：守卫自然处理）
        String outsider = registerAndGetToken("oscar");
        mockMvc.perform(get("/api/v1/connect").header("Authorization", "Bearer " + outsider))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));
    }
}
