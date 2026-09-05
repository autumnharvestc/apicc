package com.autumnharvestc.server.console;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.file.Path;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 1 静态托管契约测试：console 目录存在但为空（无 index.html）场景（裁定③）。
 * 与「目录不存在」同语义：非 /api 未命中 GET → 404 {code:"console_not_found"} + 引导文案。
 * 空目录用 static @TempDir（JUnit 在上下文加载前建好、类结束自动清理——审查顺修 2）；
 * 目录先于 Spring 上下文就绪，反向钉住「实现不得在启动期扫描 console-dir」（产物可运行中放置）。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = "spring.datasource.url=jdbc:h2:mem:apicc-console-empty-test;DB_CLOSE_DELAY=-1")
class ConsoleEmptyDirContractTest {

    /** JUnit 建立的全新空目录：存在但无 index.html。 */
    @TempDir
    static Path emptyConsoleDir;

    @Autowired
    private MockMvc mockMvc;

    @DynamicPropertySource
    static void consoleDirProperty(DynamicPropertyRegistry registry) {
        registry.add("apicc.server.console-dir", () -> emptyConsoleDir.toString());
    }

    /** GET /（目录在但无 index.html）→ 404 console_not_found + 引导。 */
    @Test
    void rootReturnsGuidedConsoleNotFound() throws Exception {
        mockMvc.perform(get("/"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("console_not_found"))
                .andExpect(jsonPath("$.message", containsString("pnpm -C apps/admin-web build")));
    }

    /** SPA 深链同样 404 console_not_found + 引导。 */
    @Test
    void spaDeepLinkReturnsGuidedConsoleNotFound() throws Exception {
        mockMvc.perform(get("/workspaces"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("console_not_found"))
                .andExpect(jsonPath("$.message", containsString("pnpm -C apps/admin-web build")));
    }
}
