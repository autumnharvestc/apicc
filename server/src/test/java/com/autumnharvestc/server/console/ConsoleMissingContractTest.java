package com.autumnharvestc.server.console;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.UUID;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 1 静态托管契约测试：console 目录缺失场景（裁定③）。
 * 目录不存在 → 非 /api 未命中 GET（根路径与 SPA 深链）→ 404 {code:"console_not_found"} + 引导文案
 * （指引 pnpm -C apps/admin-web build 并将 dist 放入 console-dir）；/api 面保持既有语义：
 * 带 token 未命中 → 404 not_found（不被 console_not_found 波及），未认证 → 401（保护面不变，裁定⑤）。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = "spring.datasource.url=jdbc:h2:mem:apicc-console-missing-test;DB_CLOSE_DELAY=-1")
class ConsoleMissingContractTest {

    /** 每次构建随机路径，保证目录必然不存在（实现方承诺从不创建该目录）。 */
    static final String MISSING_DIR = "target/missing-console-" + UUID.randomUUID();

    @Autowired
    private MockMvc mockMvc;

    @DynamicPropertySource
    static void consoleDirProperty(DynamicPropertyRegistry registry) {
        registry.add("apicc.server.console-dir", () -> MISSING_DIR);
    }

    /** GET / → 404 console_not_found，message 含构建与放置引导。 */
    @Test
    void rootReturnsGuidedConsoleNotFound() throws Exception {
        mockMvc.perform(get("/"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("console_not_found"))
                .andExpect(jsonPath("$.message", containsString("pnpm -C apps/admin-web build")))
                .andExpect(jsonPath("$.message", containsString("dist")));
    }

    /** SPA 深链同样 404 console_not_found + 引导。 */
    @Test
    void spaDeepLinkReturnsGuidedConsoleNotFound() throws Exception {
        mockMvc.perform(get("/workspaces"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("console_not_found"))
                .andExpect(jsonPath("$.message", containsString("pnpm -C apps/admin-web build")));
    }

    /** /api 面带 token 未命中 → 既有 404 not_found（console 缺失不得波及 API 错误语义——裁定③）。 */
    @Test
    void apiUnknownRouteWithTokenKeepsJsonNotFound() throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"missing-console-user\",\"password\":\"password123\",\"displayName\":\"M\"}"))
                .andExpect(status().isCreated());
        MvcResult login = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"missing-console-user\",\"password\":\"password123\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String token = JsonPath.read(login.getResponse().getContentAsString(), "$.token");

        mockMvc.perform(get("/api/v1/definitely-not-exists").header("Authorization", "Bearer " + token))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("not_found"));
    }

    /** /api 根路径（无尾斜杠）同属 API 面 → not_found，与解析器 api||api/ 口径对称（审查顺修 1）。 */
    @Test
    void apiRootPathKeepsJsonNotFound() throws Exception {
        mockMvc.perform(get("/api"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("not_found"));
    }

    /** /api 保护面不变：未认证 → 401（先于 404，裁定⑤）。 */
    @Test
    void protectedApiStillReturns401WithoutToken() throws Exception {
        mockMvc.perform(get("/api/v1/workspaces"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("unauthorized"));
    }
}
