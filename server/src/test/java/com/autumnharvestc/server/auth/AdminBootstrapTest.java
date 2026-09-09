package com.autumnharvestc.server.auth;

import com.autumnharvestc.server.store.PlatformRole;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import com.jayway.jsonpath.JsonPath;
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
import org.springframework.test.web.servlet.MvcResult;

import java.time.Instant;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
            "apicc.server.admin-username=boss",
            "apicc.server.admin-password=secret123"
    })
    static class EnvConfiguredTest {

        @Autowired
        private MockMvc mockMvc;

        @Test
        void bootstrapsConfiguredAdminAndLoginSucceeds() throws Exception {
            MvcResult result = mockMvc.perform(post("/api/v1/auth/login")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"username\":\"boss\",\"password\":\"secret123\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.token").isNotEmpty())
                    .andExpect(jsonPath("$.user.username").value("boss"))
                    .andReturn();
            String token = JsonPath.read(result.getResponse().getContentAsString(), "$.token");

            // 平台超管（规格§2）：启动引导创建的首个账号自动 SUPERADMIN
            mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.role").value("SUPERADMIN"));
        }
    }

    /** 场景 2：未配置 → admin + 随机口令，口令以 WARN 仅此一次打印且可登录。 */
    @SpringBootTest
    @AutoConfigureMockMvc
    @TestPropertySource(properties = {
            "spring.datasource.url=jdbc:h2:mem:apicc-admin-random-test;DB_CLOSE_DELAY=-1"
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
            "spring.datasource.url=jdbc:h2:mem:apicc-register-default-test;DB_CLOSE_DELAY=-1"
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

    /** no-op 分支纯单测：有启用超管绝不插入；插入载荷按配置/随机两形态核对。 */
    @Test
    void skipsInsertWhenUsersExistAndBuildsExpectedPayloads() {
        UserRepo repo = mock(UserRepo.class);
        var encoder = new BCryptPasswordEncoder();

        // 有启用超管：no-op（判据已从「表空」扩为「无启用超管」，重引导回归另测）
        when(repo.existsSuperadmin()).thenReturn(true);
        new AdminBootstrap(repo, "boss", "secret123").run(null);
        verify(repo).existsSuperadmin();
        verify(repo, never()).insert(org.mockito.ArgumentMatchers.any());

        // 无超管 + 表空：环境变量凭据建号，哈希可验证
        when(repo.existsSuperadmin()).thenReturn(false);
        when(repo.count()).thenReturn(0L);
        new AdminBootstrap(repo, "boss", "secret123").run(null);
        var envCaptor = ArgumentCaptor.forClass(UserAccount.class);
        verify(repo).insert(envCaptor.capture());
        assertThat(envCaptor.getValue().username()).isEqualTo("boss");
        assertThat(encoder.matches("secret123", envCaptor.getValue().passwordHash())).isTrue();

        // 无超管 + 表空 + 未配置：admin + 随机口令（base64url），哈希可验证且两次口令互不相同
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

    /** 重引导回归（用户实测：计划 A 前存量库 admin role=USER，注册关闭+无超管 → 无人能管理）：
     * 表非空但无启用超管 → 重新引导；同名存量账号占用时用户名避让为 <名>-sys。 */
    @Test
    void rebootstrapsWhenNoActiveSuperadminAndAvoidsNameClash() {
        UserRepo repo = mock(UserRepo.class);
        var encoder = new BCryptPasswordEncoder();
        when(repo.existsSuperadmin()).thenReturn(false);
        when(repo.count()).thenReturn(3L);
        when(repo.findByUsername("admin")).thenReturn(java.util.Optional.of(
                new UserAccount("legacy", "admin", "$2legacy", "旧账号", PlatformRole.USER, false, Instant.now())));
        new AdminBootstrap(repo, "", "").run(null);
        var captor = ArgumentCaptor.forClass(UserAccount.class);
        verify(repo).insert(captor.capture());
        assertThat(captor.getValue().username()).isEqualTo("admin-sys");
        assertThat(captor.getValue().role()).isEqualTo(PlatformRole.SUPERADMIN);
        // 随机口令不可预知：仅验证哈希形态
        assertThat(captor.getValue().passwordHash()).startsWith("$2");
    }
}
