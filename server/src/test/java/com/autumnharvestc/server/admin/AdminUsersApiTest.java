package com.autumnharvestc.server.admin;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 4 账号管理 API 契约测试（规格§2）：
 * GET/POST /api/v1/admin/users、password-reset、disable/enable、workspace-role——全部仅 SUPERADMIN（守卫在 Service）。
 * 独立内存库名 + admin 凭据走属性配置（AdminBootstrap 引导建号，参照 AdminBootstrapTest.EnvConfiguredTest）。
 * 用例按 @Order 顺序执行（同一内存库内先后建号，后者对已有 bob 归位后复用，保证幂等）。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@TestPropertySource(properties = {
        "apicc.server.allow-registration=true",
        "spring.datasource.url=jdbc:h2:mem:apicc-admin-api-test;DB_CLOSE_DELAY=-1",
        "apicc.server.admin-username=admin",
        "apicc.server.admin-password=admin-pass-2026"
})
class AdminUsersApiTest {

    @Autowired
    private MockMvc mockMvc;

    // ---- 测试脚手架 ----

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

    /** 超管 token：bootstrap 按属性配置建出的 admin。 */
    private String superadminToken() throws Exception {
        return loginToken("admin", "admin-pass-2026");
    }

    /** 注册 alice（幂等：已注册的 409 视为就绪）。 */
    private void registerAlice() throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"alice\",\"password\":\"password123\",\"displayName\":\"Alice\"}"))
                .andReturn();
        assertThat(result.getResponse().getStatus()).isIn(201, 409);
    }

    /** 经超管清单按用户名过滤取账号 id（无则返回 null）。 */
    private String findUserId(String username) throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/admin/users")
                        .header("Authorization", "Bearer " + superadminToken()))
                .andExpect(status().isOk())
                .andReturn();
        List<String> ids = JsonPath.read(result.getResponse().getContentAsString(),
                "$[?(@.username=='" + username + "')].id");
        return ids.isEmpty() ? null : ids.get(0);
    }

    /** admin 自身 id（清单按 username=="admin" 过滤）。 */
    private String adminId() throws Exception {
        return findUserId("admin");
    }

    /** 确保 bob 存在且处于初始态（密码 password123、未停用）：测试 1 可能已重置/停用。 */
    private String createBobAndGetId() throws Exception {
        String admin = superadminToken();
        String bobId = findUserId("bob");
        if (bobId == null) {
            mockMvc.perform(post("/api/v1/admin/users").header("Authorization", "Bearer " + admin)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"username\":\"bob\",\"password\":\"password123\",\"displayName\":\"Bob\"}"))
                    .andExpect(status().isCreated());
            bobId = findUserId("bob");
        } else {
            mockMvc.perform(post("/api/v1/admin/users/" + bobId + "/password-reset")
                            .header("Authorization", "Bearer " + admin)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"newPassword\":\"password123\"}"))
                    .andExpect(status().isNoContent());
            mockMvc.perform(post("/api/v1/admin/users/" + bobId + "/enable")
                            .header("Authorization", "Bearer " + admin))
                    .andExpect(status().isNoContent());
        }
        return bobId;
    }

    /** admin 建工作区（创建者自动 OWNER），返回 id。 */
    private String createWorkspaceAsAdmin() throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces")
                        .header("Authorization", "Bearer " + superadminToken())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"管理端分配区\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.id");
    }

    // ---- 清单/创建/重置密码（含超管守卫与修正后的重置断言）----

    @Test
    @Order(1)
    void listCreateDisableResetRestrictedToSuperadmin() throws Exception {
        registerAlice();
        String admin = superadminToken();
        String alice = loginToken("alice", "password123");
        // 非超管访问 → 403 superadmin_required
        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", "Bearer " + alice))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("superadmin_required"));
        // 清单不泄露 password_hash（响应 DTO 无 password 字样）
        MvcResult list = mockMvc.perform(get("/api/v1/admin/users").header("Authorization", "Bearer " + admin))
                .andExpect(status().isOk()).andReturn();
        assertThat(list.getResponse().getContentAsString()).doesNotContain("password");
        // 创建账号（校验同注册）：201 + role=USER；重名 → 409 username_taken
        mockMvc.perform(post("/api/v1/admin/users").header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"bob\",\"password\":\"password123\",\"displayName\":\"Bob\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.role").value("USER"));
        mockMvc.perform(post("/api/v1/admin/users").header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"bob\",\"password\":\"password123\",\"displayName\":\"Bob2\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("username_taken"));
        // 重置密码：不停用账号——旧密码 401 invalid_credentials、新密码 200（计划期修正后的断言）
        String bobId = findUserId("bob");
        mockMvc.perform(post("/api/v1/admin/users/" + bobId + "/password-reset")
                        .header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"newPassword\":\"newpass123\"}"))
                .andExpect(status().isNoContent());
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("bob", "password123")))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("bob", "newpass123")))
                .andExpect(status().isOk());
    }

    // ---- 停用/启用与入区定角色 ----

    @Test
    @Order(2)
    void disableEnableAndWorkspaceRoleAssignment() throws Exception {
        String admin = superadminToken();
        String bobId = createBobAndGetId();
        // 停用：登录 403 + 不能停用自己
        mockMvc.perform(post("/api/v1/admin/users/" + bobId + "/disable").header("Authorization", "Bearer " + admin))
                .andExpect(status().isNoContent());
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("bob", "password123")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("account_disabled"));
        mockMvc.perform(post("/api/v1/admin/users/" + adminId() + "/disable").header("Authorization", "Bearer " + admin))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("cannot_disable_self"));
        // 启用：恢复登录
        mockMvc.perform(post("/api/v1/admin/users/" + bobId + "/enable").header("Authorization", "Bearer " + admin))
                .andExpect(status().isNoContent());
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("bob", "password123")))
                .andExpect(status().isOk());
        // 入区定角色（把 bob 设为该区 ADMIN 后，经既有成员清单端点核对）
        String wsId = createWorkspaceAsAdmin();
        mockMvc.perform(put("/api/v1/admin/users/" + bobId + "/workspace-role")
                        .header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"workspaceId\":\"" + wsId + "\",\"role\":\"ADMIN\"}"))
                .andExpect(status().isNoContent());
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/members").header("Authorization", "Bearer " + admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.username=='bob')].role").value("ADMIN"));
    }

    // ---- 入区定角色校验（审查修复：OWNER 不可经此端点授予/变更；workspace 须存在）----

    /**
     * 载荷 role=OWNER → 400 validation_failed（@Pattern 收窄为 ADMIN|EDITOR|VIEWER）：
     * OWNER 的产生与转让只走成员 API 转让流程，堵住「改离现职 OWNER → 区内永久无 OWNER /
     * 授 OWNER → 永久双 OWNER」两条绕过 OWNER 不可变不变量的路径。
     */
    @Test
    @Order(3)
    void workspaceRoleRejectsOwnerAndUnknownWorkspace() throws Exception {
        String admin = superadminToken();
        String bobId = createBobAndGetId();
        // role=OWNER → 校验层 400（先于 service，无须真实 workspace）
        mockMvc.perform(put("/api/v1/admin/users/" + bobId + "/workspace-role")
                        .header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"workspaceId\":\"whatever\",\"role\":\"OWNER\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
        // workspaceId 不存在 → 404 workspace_not_found（对齐 user 侧与工作区面口径）
        mockMvc.perform(put("/api/v1/admin/users/" + bobId + "/workspace-role")
                        .header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"workspaceId\":\"no-such-workspace\",\"role\":\"ADMIN\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("workspace_not_found"));
    }

    // ---- 停用→令牌失效（审查修复：全程经真实 API，不手工经 repo 吊销）----

    /**
     * 经 API 停用后：既有令牌 /me 401（令牌失效链路）+ 登录 403 account_disabled——
     * 钉住 AdminService.setDisabled 内「停用 + 吊销全部令牌」的真实接线（此前用例系手工经 repo，
     * 删掉 service 里的吊销调用不会有任何测试变红）。
     */
    @Test
    @Order(4)
    void disableViaApiInvalidatesExistingTokenAndBlocksLogin() throws Exception {
        String admin = superadminToken();
        String bobId = createBobAndGetId();
        String bobToken = loginToken("bob", "password123");
        // 停用前令牌可用（基线）
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + bobToken))
                .andExpect(status().isOk());
        // 经 API 停用（不手工吊销）：204
        mockMvc.perform(post("/api/v1/admin/users/" + bobId + "/disable")
                        .header("Authorization", "Bearer " + admin))
                .andExpect(status().isNoContent());
        // 腿 1：旧令牌立即失效 → 401
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + bobToken))
                .andExpect(status().isUnauthorized());
        // 腿 2：登录被拒 → 403 account_disabled
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("bob", "password123")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("account_disabled"));
    }
}
