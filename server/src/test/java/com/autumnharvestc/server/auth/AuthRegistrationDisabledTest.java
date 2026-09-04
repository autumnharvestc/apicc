package com.autumnharvestc.server.auth;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 注册开关关闭（规格 m3 §2 D4 allowRegistration / §3.1 403 registration_disabled）。
 * 独立上下文 + 独立内存库名，避免与开关开的契约测试共享配置。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:h2:mem:apicc-auth-disabled-test;DB_CLOSE_DELAY=-1",
        "apicc.server.data-dir=target/test-data-auth",
        "apicc.server.allow-registration=false"
})
class AuthRegistrationDisabledTest {

    @Autowired
    private MockMvc mockMvc;

    /** allow-registration=false：注册 → 403 {"code":"registration_disabled"}。 */
    @Test
    void registerReturns403RegistrationDisabledWhenClosed() throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"isolated\",\"password\":\"password123\",\"displayName\":\"Iso\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("registration_disabled"))
                .andExpect(jsonPath("$.message").isNotEmpty());
    }
}
