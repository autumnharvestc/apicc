package com.autumnharvestc.server.auth;

import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.http.MediaType;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 首个管理员启动引导（部署线 D6）+ 注册默认关（D5）钉住。
 * 集成场景走独立内存库名（与既有契约测试同一约定）；no-op 分支用纯单测
 * （ApplicationRunner 在上下文刷新后即执行，集成测试无法先于它预置用户）。
 */
class AdminBootstrapTest {

    /** 场景 1：环境变量凭据 → 按配置建号，登录可用。 */
    @SpringBootTest
    @AutoConfigureMockMvc
    @TestPropertySource(properties = {
            "spring.datasource.url=jdbc:h2:mem:apicc-admin-env-test;DB_CLOSE_DELAY=-1",
            "apicc.server.data-dir=target/test-data-admin-env",
            "apicc.server.admin-username=boss",
            "apicc.server.admin-password=secret123"
    })
    static class EnvConfiguredTest {

        @Autowired
        private MockMvc mockMvc;

        @Test
        void bootstrapsConfiguredAdminAndLoginSucceeds() throws Exception {
            mockMvc.perform(post("/api/v1/auth/login")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"username\":\"boss\",\"password\":\"secret123\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.token").isNotEmpty())
                    .andExpect(jsonPath("$.user.username").value("boss"));
        }
    }

    /** 场景 2：未配置 → admin + 随机口令，口令以 WARN 仅此一次打印且可登录。 */
    @SpringBootTest
    @AutoConfigureMockMvc
    @TestPropertySource(properties = {
            "spring.datasource.url=jdbc:h2:mem:apicc-admin-random-test;DB_CLOSE_DELAY=-1",
            "apicc.server.data-dir=target/test-data-admin-random"
    })
    @ExtendWith(OutputCaptureExtension.class)
    static class RandomPasswordTest {

        private static final Pattern INITIAL_PASSWORD =
                Pattern.compile("初始密码：([A-Za-z0-9_-]{22})");

        @Autowired
        private MockMvc mockMvc;

        @Test
        void bootstrapsAdminWithLoggedRandomPasswordAndLoginSucceeds(CapturedOutput output)
                throws Exception {
            var matcher = INITIAL_PASSWORD.matcher(output.getAll());
            assertThat(matcher.find()).as("日志应包含随机初始密码").isTrue();
            String password = matcher.group(1);
            mockMvc.perform(post("/api/v1/auth/login")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"username\":\"admin\",\"password\":\"" + password + "\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.user.username").value("admin"));
        }
    }

    /** 场景 3：注册默认关（D5）——不带任何开关属性时 register → 403 registration_disabled。 */
    @SpringBootTest
    @AutoConfigureMockMvc
    @TestPropertySource(properties = {
            "spring.datasource.url=jdbc:h2:mem:apicc-register-default-test;DB_CLOSE_DELAY=-1",
            "apicc.server.data-dir=target/test-data-register-default"
    })
    static class RegisterDisabledByDefaultTest {

        @Autowired
        private MockMvc mockMvc;

        @Test
        void registerIsForbiddenByDefault() throws Exception {
            mockMvc.perform(post("/api/v1/auth/register")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"username\":\"newbie\",\"password\":\"password123\",\"displayName\":\"N\"}"))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.code").value("registration_disabled"));
        }
    }

    /** no-op 分支纯单测：非空表绝不插入；插入载荷按配置/随机两形态核对。 */
    @Test
    void skipsInsertWhenUsersExistAndBuildsExpectedPayloads() {
        UserRepo repo = mock(UserRepo.class);
        var encoder = new BCryptPasswordEncoder();

        // 非空表：no-op
        when(repo.count()).thenReturn(1L);
        new AdminBootstrap(repo, "boss", "secret123").run(null);
        verify(repo).count();
        verify(repo, never()).insert(org.mockito.ArgumentMatchers.any());
        verifyNoMoreInteractions(repo);

        // 空表 + 环境变量凭据：按配置建号，哈希可验证
        when(repo.count()).thenReturn(0L);
        new AdminBootstrap(repo, "boss", "secret123").run(null);
        var envCaptor = ArgumentCaptor.forClass(UserAccount.class);
        verify(repo).insert(envCaptor.capture());
        assertThat(envCaptor.getValue().username()).isEqualTo("boss");
        assertThat(encoder.matches("secret123", envCaptor.getValue().passwordHash())).isTrue();

        // 空表 + 未配置：admin + 随机口令（base64url），哈希可验证且两次口令互不相同
        when(repo.count()).thenReturn(0L);
        new AdminBootstrap(repo, "", "").run(null);
        var randomCaptor = ArgumentCaptor.forClass(UserAccount.class);
        verify(repo, org.mockito.Mockito.times(2)).insert(randomCaptor.capture());
        assertThat(randomCaptor.getAllValues()).hasSize(2);
        assertThat(randomCaptor.getAllValues().get(1).username()).isEqualTo("admin");
        assertThat(randomCaptor.getAllValues().get(1).passwordHash()).startsWith("$2");
        assertThat(randomCaptor.getAllValues().get(1).passwordHash())
                .isNotEqualTo(randomCaptor.getAllValues().get(0).passwordHash());
    }
}
