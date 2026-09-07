package com.autumnharvestc.server.console;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.not;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 1 静态托管契约测试（规格 m4 §2 D2/D3 + 简报裁定①–⑤）：console 目录存在场景。
 * 覆盖：/ 与 SPA 深链回退 index.html、静态资产原样、html no-cache 而 assets 默认头（裁定④）、
 * /api 面零受扰（ping 200 / 未认证 401 / 带 token 未命中 404 not_found）、路径穿越不逃逸 console-dir（裁定②）、
 * 静态面不要求认证（裁定⑤：AuthFilter shouldNotFilter 本就只拦 /api/v1/**，此处固化断言）。
 * 各断言请求均不携带 Authorization 头（除 /api 面），即「/ 与 /workspaces 不要求认证」的固化。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {"spring.datasource.url=jdbc:h2:mem:apicc-console-static-test;DB_CLOSE_DELAY=-1", "apicc.server.allow-registration=true"})
class ConsoleStaticHostingTest {

    /** console 产物目录：@TempDir 静态字段在上下文创建前就绪，经 DynamicPropertySource 注入 console-dir（裁定①）。 */
    @TempDir
    static Path consoleDir;

    /** index.html 与 app.js 内容只用 ASCII，避免响应字符集口径影响字节级断言。 */
    private static final String INDEX_HTML = "<!DOCTYPE html><html><head><title>apicc admin console</title></head>"
            + "<body><div id=\"app\">admin-console-index-marker</div></body></html>";

    private static final String APP_JS = "console.log('admin-console-asset-marker');";

    /** 穿越探测的金丝雀：放在 console-dir 之外（junit 临时根内、console 同级），逃逸即会 200。 */
    private static final String CANARY_NAME = "outside-canary.txt";

    private static final String CANARY_CONTENT = "outside-canary-marker-7f3a";

    @Autowired
    private MockMvc mockMvc;

    @DynamicPropertySource
    static void consoleDirProperty(DynamicPropertyRegistry registry) {
        registry.add("apicc.server.console-dir", () -> consoleDir.toString());
    }

    @BeforeAll
    static void seedTraversalCanary() throws IOException {
        Files.writeString(consoleDir.resolveSibling(CANARY_NAME), CANARY_CONTENT, StandardCharsets.UTF_8);
    }

    @BeforeEach
    void seedConsole() throws IOException {
        Files.createDirectories(consoleDir.resolve("assets"));
        Files.writeString(consoleDir.resolve("index.html"), INDEX_HTML, StandardCharsets.UTF_8);
        Files.writeString(consoleDir.resolve("assets").resolve("app.js"), APP_JS, StandardCharsets.UTF_8);
    }

    // ---- 组 1：console 存在（规格 D2/D3）----

    /** GET / → 200 text/html 且内容为 console 的 index.html；html 响应不缓存（裁定④）。 */
    @Test
    void servesIndexAtRoot() throws Exception {
        mockMvc.perform(get("/"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML))
                .andExpect(content().string(equalTo(INDEX_HTML)))
                .andExpect(header().string("Cache-Control", containsString("no-cache")));
    }

    /** SPA 深链（无对应文件、无扩展名）→ 200 回退 index.html 内容（裁定②），同样不缓存。 */
    @Test
    void servesSpaDeepLinkFromIndexFallback() throws Exception {
        mockMvc.perform(get("/workspaces"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML))
                .andExpect(content().string(equalTo(INDEX_HTML)))
                .andExpect(header().string("Cache-Control", containsString("no-cache")));
    }

    /** 存在的静态文件原样返回；assets 类走 Spring 默认响应头（无 Cache-Control，裁定④）。 */
    @Test
    void servesExistingStaticAsset() throws Exception {
        mockMvc.perform(get("/assets/app.js"))
                .andExpect(status().isOk())
                .andExpect(content().string(equalTo(APP_JS)))
                .andExpect(header().doesNotExist("Cache-Control"));
    }

    // ---- 组 2：/api 面零受扰（D3：/api/** 行为完全不受影响）----

    /** ping 在静态托管存在时仍 200 JSON。 */
    @Test
    void pingUnaffectedByStaticHosting() throws Exception {
        mockMvc.perform(get("/api/v1/ping"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"));
    }

    /** 受保护 API 未认证 → 401（保护面不变；静态托管不改变认证过滤器行为——裁定⑤）。 */
    @Test
    void protectedApiStillReturns401WithoutToken() throws Exception {
        mockMvc.perform(get("/api/v1/workspaces"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("unauthorized"));
    }

    /** 带 token 的 /api 未命中 → 404 not_found（JSON 契约），绝不回退 index.html。 */
    @Test
    void apiUnknownRouteWithTokenKeepsJsonNotFound() throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"console-user\",\"password\":\"password123\",\"displayName\":\"C\"}"))
                .andExpect(status().isCreated());
        MvcResult login = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"console-user\",\"password\":\"password123\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String token = JsonPath.read(login.getResponse().getContentAsString(), "$.token");

        mockMvc.perform(get("/api/v1/definitely-not-exists").header("Authorization", "Bearer " + token))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("not_found"));
    }

    // ---- 组 4：路径穿越不逃逸 console-dir（裁定②：resolve 后必须在 console-dir 内）----

    /** 三种穿越探测（../ 字面、多段 ../、URL 编码 %2F）均不得读到 console-dir 外的金丝雀 → 404。 */
    @Test
    void pathTraversalCannotEscapeConsoleDir() throws Exception {
        mockMvc.perform(get("/../" + CANARY_NAME))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("not_found"))
                .andExpect(content().string(not(containsString(CANARY_CONTENT))));

        mockMvc.perform(get("/assets/../../" + CANARY_NAME))
                .andExpect(status().isNotFound())
                .andExpect(content().string(not(containsString(CANARY_CONTENT))));

        mockMvc.perform(get("/..%2F" + CANARY_NAME))
                .andExpect(status().isNotFound())
                .andExpect(content().string(not(containsString(CANARY_CONTENT))));
    }
}
