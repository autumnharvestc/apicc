package com.autumnharvestc.server;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 1 骨架契约测试：Spring context 可加载 + 健康探测端点可用（规格 m3 §3.5）。
 * 数据源覆写为 H2 内存库，测试不触碰文件库（server-data/）。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:h2:mem:apicc-test;DB_CLOSE_DELAY=-1",
        "apicc.server.data-dir=target/test-data"
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

    /** 全局错误契约骨架：未匹配路由 → 404 {"code":"not_found","message":...}（规格 §3 错误统一 {code,message}）。 */
    @Test
    void unknownRouteReturns404WithCodeMessage() throws Exception {
        mockMvc.perform(get("/api/v1/definitely-not-exists"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("not_found"))
                .andExpect(jsonPath("$.message").isNotEmpty());
    }
}
