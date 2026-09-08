package com.autumnharvestc.server.auth;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import com.autumnharvestc.server.store.TokenRepo;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 裁定 C①（任务 3/4 审查留痕承接）：AuthFilter 内 DB 异常 → 直写 500 {code:"internal_error"}。
 * 过滤器先于 DispatcherServlet，@RestControllerAdvice 不覆盖过滤器——异常若放任上抛会变成
 * 容器错误页（非契约形状），故必须在过滤器内统一形状。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:h2:mem:apicc-filter-err-test;DB_CLOSE_DELAY=-1"
})
class AuthFilterInternalErrorTest {

    @Autowired
    private MockMvc mockMvc;

    /** 仅本测试类上下文内替换 TokenRepo：令牌查找抛 DB 故障，模拟元数据库不可用。 */
    @MockitoBean
    private TokenRepo tokens;

    @Test
    void dbFailureInsideAuthFilterReturnsUnified500Shape() throws Exception {
        when(tokens.findActiveByHash(anyString()))
                .thenThrow(new DataAccessResourceFailureException("元数据库不可用"));

        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer some-token"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("internal_error"))
                .andExpect(jsonPath("$.message").isNotEmpty());
    }
}
