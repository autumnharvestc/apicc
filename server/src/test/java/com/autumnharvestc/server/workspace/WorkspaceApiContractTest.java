package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.store.GroupRecord;
import com.autumnharvestc.server.store.GroupRepo;
import com.autumnharvestc.server.store.ProjectRecord;
import com.autumnharvestc.server.store.ProjectRepo;
import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.matchesPattern;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 4 工作区 API 契约测试（规格 m3 §3.2 逐字对齐）：
 * GET/POST /api/v1/workspaces、GET/DELETE /api/v1/workspaces/{id}。
 * 含裁定 D：DELETE 先删库表行再递归删内容目录；目录生命周期以 data-dir 文件系统断言钉住。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "apicc.server.allow-registration=true",
        "spring.datasource.url=jdbc:h2:mem:apicc-ws-test;DB_CLOSE_DELAY=-1",
        "apicc.server.data-dir=target/test-data-ws",
        "apicc.server.admin-username=admin",
        "apicc.server.admin-password=admin-pass-2026"
})
class WorkspaceApiContractTest {

    private static final String ISO_UTC = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private GroupRepo groupRepo;

    @Autowired
    private ProjectRepo projectRepo;

    // ---- 测试脚手架 ----

    /** 登录并提取 token（admin 走 AdminBootstrap 属性凭据，见 AdminUsersApiTest 同款夹具）。 */
    private String loginAndGetToken(String username, String password) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"" + username + "\",\"password\":\"" + password + "\"}"))
                .andExpect(status().isOk())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.token");
    }

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

    private Path workspaceDir(String wsId) {
        return Path.of("target", "test-data-ws", "workspaces", wsId);
    }

    // ---- POST /api/v1/workspaces（规格 §3.2：201 {id, name, myRole:"OWNER"}，创建者自动 OWNER）----

    /** 规格 §1/§4：建区自动建「默认分组」（不可删语义在 Org 面验证）；ws.name 唯一约束。 */
    @Test
    void createSeedsDefaultGroupAndRejectsDuplicateName() throws Exception {
        String admin = loginAndGetToken("admin", "admin-pass-2026");
        MvcResult created = mockMvc.perform(post("/api/v1/workspaces")
                        .header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"ws-b\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        String wsId = JsonPath.read(created.getResponse().getContentAsString(), "$.id");
        // 同名工作区 → 409 workspace_name_taken
        mockMvc.perform(post("/api/v1/workspaces").header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"ws-b\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("workspace_name_taken"));
        // 默认分组已就位：经 detail 或清单接口断言（以 Org 面任务 2 的端点为准——此处经 DB repo 断言）
        // 实现后改为经 GET /api/v1/workspaces/{id}/groups 断言（任务 2 提供端点后回填此断言）
        GroupRecord group = groupRepo.findByName(wsId, "默认分组").orElseThrow();
        assertThat(group.workspaceId()).isEqualTo(wsId);
        assertThat(group.isDefault()).isTrue();
    }

    /** 创建成功：201 + OWNER 角色 + 内容目录 data-dir/workspaces/<id>/ 已建立（规格 §2 D6）。 */
    @Test
    void createReturns201OwnerRoleAndCreatesContentDir() throws Exception {
        String token = newUser("ws-alice")[1];
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Alpha\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").isNotEmpty())
                .andExpect(jsonPath("$.name").value("Alpha"))
                .andExpect(jsonPath("$.myRole").value("OWNER"))
                .andReturn();

        String wsId = JsonPath.read(result.getResponse().getContentAsString(), "$.id");
        assertThat(Files.isDirectory(workspaceDir(wsId))).isTrue();
    }

    /** name 空白 / 超 64 字符 → 400 validation_failed。 */
    @Test
    void createWithInvalidNameReturns400ValidationFailed() throws Exception {
        String token = newUser("ws-bob")[1];
        mockMvc.perform(post("/api/v1/workspaces")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"  \"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));

        mockMvc.perform(post("/api/v1/workspaces")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"" + "x".repeat(65) + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
    }

    // ---- GET /api/v1/workspaces（规格 §3.2：我参与的工作区列表 [{id, name, myRole, createdAt}]）----

    /** 列表形状：id/name/myRole/createdAt（ISO-8601 UTC），行按成员身份给出 myRole；无工作区 → 200 空数组。 */
    @Test
    void listReturnsMyWorkspacesWithRoles() throws Exception {
        String[] owner = newUser("ws-carol");
        String[] editor = newUser("ws-dave");
        String wsId = createWorkspace(owner[1], "Beta");

        putMember(owner[1], wsId, editor[0], "EDITOR");

        mockMvc.perform(get("/api/v1/workspaces").header("Authorization", "Bearer " + editor[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(wsId))
                .andExpect(jsonPath("$[0].name").value("Beta"))
                .andExpect(jsonPath("$[0].myRole").value("EDITOR"))
                .andExpect(jsonPath("$[0].createdAt").value(matchesPattern(ISO_UTC)));

        String stranger = newUser("ws-erin")[1];
        mockMvc.perform(get("/api/v1/workspaces").header("Authorization", "Bearer " + stranger))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isEmpty());
    }

    // ---- GET /api/v1/workspaces/{id}（规格 §3.2：{id, name, myRole, memberCount}，成员可读）----

    /** 详情形状 + memberCount 随成员增长；VIEWER 成员亦可读（权限=成员）。 */
    @Test
    void detailReturnsShapeWithMemberCount() throws Exception {
        String[] owner = newUser("ws-frank");
        String[] viewer = newUser("ws-grace");
        String wsId = createWorkspace(owner[1], "Gamma");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(wsId))
                .andExpect(jsonPath("$.name").value("Gamma"))
                .andExpect(jsonPath("$.myRole").value("OWNER"))
                .andExpect(jsonPath("$.memberCount").value(1));

        putMember(owner[1], wsId, viewer[0], "VIEWER");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.memberCount").value(2));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + viewer[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.myRole").value("VIEWER"));
    }

    /** 非成员读详情 → 403 forbidden；不存在的工作区 → 404 workspace_not_found。 */
    @Test
    void detailForbiddenForOutsiderAnd404ForMissing() throws Exception {
        String[] owner = newUser("ws-heidi");
        String outsider = newUser("ws-ivan")[1];
        String wsId = createWorkspace(owner[1], "Delta");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + outsider))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));

        mockMvc.perform(get("/api/v1/workspaces/" + UUID.randomUUID()).header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("workspace_not_found"));
    }

    // ---- DELETE /api/v1/workspaces/{id}（规格 §3.2：OWNER；含内容目录；裁定 D 顺序）----

    /** OWNER 删除：204；工作区记录消失（再读 404）；内容目录连同其中文件一并递归删除。 */
    @Test
    void deleteByOwnerRemovesRecordsAndContentDir() throws Exception {
        String[] owner = newUser("ws-judy");
        String wsId = createWorkspace(owner[1], "Epsilon");

        // 预置内容目录非空——递归删除的直接证据
        Path dir = workspaceDir(wsId);
        Files.createDirectories(dir.resolve("groups/demo"));
        Files.writeString(dir.resolve("groups/demo/project.config"), "demo");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound());

        assertThat(Files.notExists(dir)).isTrue();
    }

    /** 删区连带清空 groups/projects 行（审查修复：projects → groups 顺序清 fk_projects_group 引用）。 */
    @Test
    void deleteByOwnerAlsoClearsGroupsAndProjects() throws Exception {
        String[] owner = newUser("ws-nadia");
        String wsId = createWorkspace(owner[1], "Theta");
        // 预置：create 联动的默认分组 + 直插一多余分组与两个项目（分挂两组；任务 2 前无端点，经 repo 造数）
        GroupRecord defaultGroup = groupRepo.findByName(wsId, "默认分组").orElseThrow();
        GroupRecord spareGroup = new GroupRecord(
                UUID.randomUUID().toString(), wsId, "备选组", false, Instant.now());
        groupRepo.insert(spareGroup);
        projectRepo.insert(new ProjectRecord(
                UUID.randomUUID().toString(), wsId, defaultGroup.id(), "挂默认组项目", Instant.now()));
        projectRepo.insert(new ProjectRecord(
                UUID.randomUUID().toString(), wsId, spareGroup.id(), "挂备选组项目", Instant.now()));

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNoContent());

        assertThat(projectRepo.listByWorkspace(wsId)).isEmpty();
        assertThat(groupRepo.listByWorkspace(wsId)).isEmpty();
    }

    /** 非 OWNER 删除（ADMIN/非成员）→ 403 forbidden，工作区仍在；不存在 → 404 workspace_not_found。 */
    @Test
    void deleteByNonOwnerForbidden() throws Exception {
        String[] owner = newUser("ws-ken");
        String[] admin = newUser("ws-lisa");
        String outsider = newUser("ws-mallory")[1];
        String wsId = createWorkspace(owner[1], "Zeta");
        putMember(owner[1], wsId, admin[0], "ADMIN");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + admin[1]))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + outsider))
                .andExpect(status().isForbidden());

        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk());

        mockMvc.perform(delete("/api/v1/workspaces/" + UUID.randomUUID())
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("workspace_not_found"));
    }
}
