package com.autumnharvestc.server.console;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.UUID;
import java.util.stream.Stream;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 1 静态托管契约测试：console 目录存在但为空（无 index.html）场景（裁定③）。
 * 与「目录不存在」同语义：非 /api 未命中 GET → 404 {code:"console_not_found"} + 引导文案。
 * 说明：目录在 @BeforeAll 创建、先于 Spring 上下文加载——实现不得在启动期扫描 console-dir（产物可运行中放置）。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = "spring.datasource.url=jdbc:h2:mem:apicc-console-empty-test;DB_CLOSE_DELAY=-1")
class ConsoleEmptyDirContractTest {

    /** 每次构建随机目录名，避免历史残留干扰「空目录」前提。 */
    static final Path EMPTY_DIR = Path.of("target", "empty-console-" + UUID.randomUUID());

    @Autowired
    private MockMvc mockMvc;

    @BeforeAll
    static void ensureEmptyDirExists() throws IOException {
        Files.createDirectories(EMPTY_DIR);
    }

    @AfterAll
    static void cleanUpEmptyDir() throws IOException {
        if (!Files.exists(EMPTY_DIR)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(EMPTY_DIR)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // target 下的临时目录，清理失败不影响测试结论
                }
            });
        }
    }

    @DynamicPropertySource
    static void consoleDirProperty(DynamicPropertyRegistry registry) {
        registry.add("apicc.server.console-dir", () -> EMPTY_DIR.toString());
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
