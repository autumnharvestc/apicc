package com.autumnharvestc.server;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 1 骨架契约测试：Spring context 可加载 + 健康探测端点可用（规格 m3 §3.5）。
 * 数据源覆写为 H2 内存库，测试不触碰文件库（server-data/）。
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import(ApiccServerApplicationTests.RequestBodyValidationProbeController.class)
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:h2:mem:apicc-test;DB_CLOSE_DELAY=-1",
        "apicc.server.data-dir=target/test-data",
        "apicc.server.console-dir=target/no-such-console-dir"
})
class ApiccServerApplicationTests {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void contextLoads() {
    }

    /** 规格 §3.5：GET /api/v1/ping → 200 {"status":"ok"}，无认证，供联调与 CI 就绪探测。 */
    @Test
    void pingReturnsOkWithoutAuth() throws Exception {
        mockMvc.perform(get("/api/v1/ping"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"));
    }

    /** 全局错误契约骨架：未匹配路由 → 404 {"code":...,"message":...}（规格 m3 §3 错误统一 {code,message}）。
     *  路径取非 /api/v1 面：任务 3 起 /api/v1/** 受 Bearer 认证保护，未认证的未知 v1 路由由过滤器先行 401
     *  （该行为在 AuthApiContractTest 钉住），404 映射覆盖移到此面。
     *  M4-B 起（m4 裁定③）非 /api 面且 console 缺失 → code=console_not_found + 引导文案；
     *  console 可用时的未知静态路由仍为 not_found（ConsoleStaticHostingTest 穿越探测钉住），
     *  /api 面带 token 未命中保持 not_found（console 包契约测试钉住）。console-dir 显式指向缺失路径保证确定性。 */
    @Test
    void unknownRouteReturns404WithCodeMessage() throws Exception {
        mockMvc.perform(get("/definitely-not-exists"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("console_not_found"))
                .andExpect(jsonPath("$.message").isNotEmpty());
    }

    /** 全局错误契约：@Valid @RequestBody 字段校验失败 → 400 {"code":"validation_failed",...}，不走 500 兜底。 */
    @Test
    void invalidRequestBodyReturns400WithValidationFailedCode() throws Exception {
        mockMvc.perform(post("/_test/validation-probe")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"))
                .andExpect(jsonPath("$.message").isNotEmpty());
    }

    /**
     * 请求体校验探针端点：仅在测试源码树中注册（@Import），模拟各接口的
     * @Valid @RequestBody 校验路径。路径须在 /api/v1 之外（任务 3 起 v1 面受 Bearer 认证保护，
     * 探针不走过滤链），带 _test 段避免与真实端点冲突。
     */
    @RestController
    static class RequestBodyValidationProbeController {

        record Payload(@NotBlank String name) {
        }

        @PostMapping("/_test/validation-probe")
        void accept(@Valid @RequestBody Payload payload) {
        }
    }
}
