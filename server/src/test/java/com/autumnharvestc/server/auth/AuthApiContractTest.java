package com.autumnharvestc.server.auth;

import com.autumnharvestc.server.store.TokenRepo;
import com.autumnharvestc.server.store.UserRepo;
import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.matchesPattern;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 3 认证 API 契约测试（规格 m3 §3.1——载荷形状/状态码/错误码逐字对齐）。
 * 走完整过滤链（MockMvc 含 Filter bean）+ H2 内存库；各测试类独立内存库名避免串数据。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "apicc.server.allow-registration=true",
        "spring.datasource.url=jdbc:h2:mem:apicc-auth-test;DB_CLOSE_DELAY=-1"
})
class AuthApiContractTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepo users;

    @Autowired
    private TokenRepo tokens;

    /** ISO-8601 UTC 时间戳形状（裁定 B：expiresAt 序列化为 ISO-8601 UTC）。 */
    private static final String ISO_UTC = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z";

    /** base64url（无填充）形状——token 明文由 32 字节随机数编码而来（裁定 B）。 */
    private static final String BASE64URL = "[A-Za-z0-9_-]{40,}";

    private static String registerBody(String username, String password, String displayName) {
        return "{\"username\":\"" + username + "\",\"password\":\"" + password
                + "\",\"displayName\":\"" + displayName + "\"}";
    }

    private static String loginBody(String username, String password) {
        return "{\"username\":\"" + username + "\",\"password\":\"" + password + "\"}";
    }

    private void registerUser(String username, String password, String displayName) throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(registerBody(username, password, displayName)))
                .andExpect(status().isCreated());
    }

    private String loginAndGetToken(String username, String password) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody(username, password)))
                .andExpect(status().isOk())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.token");
    }

    // ---- register（规格 §3.1：201 {id, username, displayName}；409 username_taken；400 校验）----

    /** 注册成功：201 + 用户安全视图；响应不含密码/哈希字段（DTO 不泄露）。 */
    @Test
    void registerReturns201WithUserShapeAndNoSecretLeak() throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(registerBody("alice", "password123", "Alice")))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").isNotEmpty())
                .andExpect(jsonPath("$.username").value("alice"))
                .andExpect(jsonPath("$.displayName").value("Alice"))
                .andExpect(jsonPath("$.password").doesNotExist())
                .andExpect(jsonPath("$.passwordHash").doesNotExist());
    }

    /** 重复用户名 → 409 {"code":"username_taken"}。 */
    @Test
    void registerDuplicateUsernameReturns409UsernameTaken() throws Exception {
        registerUser("bob", "password123", "Bob");
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(registerBody("bob", "password456", "Bob2")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("username_taken"))
                .andExpect(jsonPath("$.message").isNotEmpty());
    }

    /** username 规则（规格 §3.1：3-32、[a-zA-Z0-9_-]）：过短与非法字符 → 400 validation_failed。 */
    @Test
    void registerInvalidUsernameReturns400ValidationFailed() throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(registerBody("ab", "password123", "A")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));

        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(registerBody("bad name!", "password123", "A")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
    }

    /** password 规则（规格 §3.1：≥8）：7 位密码 → 400 validation_failed。 */
    @Test
    void registerShortPasswordReturns400ValidationFailed() throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(registerBody("carol", "1234567", "C")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
    }

    /** password 上限 72（bcrypt 仅处理前 72 字节，超出静默截断——任务 3 审查钉住）：73 字符 → 400。 */
    @Test
    void registerOverlongPasswordReturns400ValidationFailed() throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(registerBody("carol-73", "x".repeat(73), "C")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
    }

    /** displayName 规则（裁定 C：必填，trim 后 1-32 字符）：空白与超长 → 400 validation_failed。 */
    @Test
    void registerInvalidDisplayNameReturns400ValidationFailed() throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(registerBody("dave", "password123", "  ")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));

        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(registerBody("dave", "password123", "x".repeat(33))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("validation_failed"));
    }

    /** 请求体缺失 → 400 bad_request（框架层兜底映射）。 */
    @Test
    void registerMissingBodyReturns400BadRequest() throws Exception {
        mockMvc.perform(post("/api/v1/auth/register"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("bad_request"));
    }

    // ---- login（规格 §3.1：200 {token, expiresAt, user}；401 invalid_credentials）----

    /** 登录成功：token 为 base64url；expiresAt 为 ISO-8601 UTC 且 ≈ now+30 天（裁定 B + 默认 TTL）。 */
    @Test
    void loginReturnsTokenExpiresAtAndUser() throws Exception {
        registerUser("erin", "password123", "Erin");
        MvcResult result = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("erin", "password123")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.token").value(matchesPattern(BASE64URL)))
                .andExpect(jsonPath("$.expiresAt").value(matchesPattern(ISO_UTC)))
                .andExpect(jsonPath("$.user.id").isNotEmpty())
                .andExpect(jsonPath("$.user.username").value("erin"))
                .andExpect(jsonPath("$.user.displayName").value("Erin"))
                .andExpect(jsonPath("$.user.passwordHash").doesNotExist())
                .andExpect(jsonPath("$.user.password").doesNotExist())
                .andReturn();

        String expiresAt = JsonPath.read(result.getResponse().getContentAsString(), "$.expiresAt");
        Instant expires = Instant.parse(expiresAt);
        Instant now = Instant.now();
        assertThat(expires).isBetween(now.plus(29, ChronoUnit.DAYS), now.plus(31, ChronoUnit.DAYS));
    }

    /** 密码错误 → 401 {"code":"invalid_credentials"}（不区分「用户不存在」与「密码错」）。 */
    @Test
    void loginWrongPasswordReturns401InvalidCredentials() throws Exception {
        registerUser("frank", "password123", "Frank");
        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("frank", "wrongpass1")))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("invalid_credentials"));
    }

    /** 未知用户 → 同样 401 invalid_credentials（不泄露用户存在性）。 */
    @Test
    void loginUnknownUserReturns401InvalidCredentials() throws Exception {
        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("no-such-user", "password123")))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("invalid_credentials"));
    }

    // ---- /me（规格 §3.1 + §6：200 {id, username, displayName, role}；401）----

    /** 有效 Bearer token → 200 用户安全视图；普通注册账号 role=USER（超管侧见 AdminBootstrapTest）。 */
    @Test
    void meReturnsCurrentUserWithValidToken() throws Exception {
        registerUser("grace", "password123", "Grace");
        String token = loginAndGetToken("grace", "password123");

        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").isNotEmpty())
                .andExpect(jsonPath("$.username").value("grace"))
                .andExpect(jsonPath("$.displayName").value("Grace"))
                .andExpect(jsonPath("$.role").value("USER")) // 普通注册账号
                .andExpect(jsonPath("$.passwordHash").doesNotExist());
    }

    /** 无 token 访问受保护端点 → 401 {"code":"unauthorized"}（裁定 A：过滤器直写）。 */
    @Test
    void meWithoutTokenReturns401Unauthorized() throws Exception {
        mockMvc.perform(get("/api/v1/me"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("unauthorized"))
                .andExpect(jsonPath("$.message").isNotEmpty());
    }

    /** 未知 token → 401 unauthorized。 */
    @Test
    void meWithUnknownTokenReturns401Unauthorized() throws Exception {
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + "x".repeat(43)))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("unauthorized"));
    }

    /** 非 Bearer 方案（如 Basic）→ 401 unauthorized。 */
    @Test
    void meWithNonBearerAuthorizationReturns401Unauthorized() throws Exception {
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Basic dXNlcjpwYXNz"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("unauthorized"));
    }

    // ---- logout（规格 §3.1：204 吊销当前 token；401）----

    /** logout → 204，且该 token 立即失效（再访问 /me 401；再次 logout 亦 401）。 */
    @Test
    void logoutRevokesTokenImmediately() throws Exception {
        registerUser("heidi", "password123", "Heidi");
        String token = loginAndGetToken("heidi", "password123");

        mockMvc.perform(post("/api/v1/auth/logout").header("Authorization", "Bearer " + token))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("unauthorized"));

        mockMvc.perform(post("/api/v1/auth/logout").header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized());
    }

    /** 无 token logout → 401（裁定 A：logout 不在放行清单）。 */
    @Test
    void logoutWithoutTokenReturns401Unauthorized() throws Exception {
        mockMvc.perform(post("/api/v1/auth/logout"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("unauthorized"));
    }

    // ---- 放行清单与其余 /api/v1 面（裁定 A）----

    /** ping 保持在放行清单（规格 §3.5：无认证健康探测）。 */
    @Test
    void pingStaysOpenWithoutAuth() throws Exception {
        mockMvc.perform(get("/api/v1/ping"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"));
    }

    /** /api/v1 面内未匹配路由且无 token → 认证过滤器先行 401（不向未认证方泄露路由存在性）。 */
    @Test
    void unknownV1RouteWithoutTokenReturns401Unauthorized() throws Exception {
        mockMvc.perform(get("/api/v1/definitely-not-exists"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("unauthorized"));
    }

    // ---- 停用账号（规格 §2：停用=拒绝登录+吊销令牌）----

    /**
     * 停用账号：登录 403 account_disabled；既有令牌一并失效（吊销）。
     * 拆两步钉纵深（审查修复）：第一步只停用、不吊销——旧 token /me 即 401，
     * 此时令牌在库仍有效，401 只能来自 AuthFilter 的 !disabled() 分支（钉死该纵深防线）；
     * 第二步再吊销全部令牌（停用端点的完整语义，见 AdminUsersApiTest 经 API 的端到端用例）。
     */
    @Test
    void disabledAccountRejectsLoginAndRevokesTokens() throws Exception {
        registerUser("paused", "password123", "暂停号");
        String token = loginAndGetToken("paused", "password123");
        // 既有令牌仍可用
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk());
        // 经 repo 停用（管理端点在任务 4）：第一步只停用、不吊销
        String userId = users.findByUsername("paused").orElseThrow().id();
        users.setDisabled(userId, true);
        // 只停用不吊销 → 旧 token /me 也 401（AuthFilter !disabled() 纵深分支被真实求值）
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("unauthorized"));
        // 第二步补吊销全部有效令牌
        tokens.revokeAllByUser(userId);
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("paused", "password123")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("account_disabled"));
        // 停用 + 错误密码 → 仍 401 invalid_credentials（密码校验在前，不向无凭据者泄露停用态）
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("paused", "wrongpass1")))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("invalid_credentials"));
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized());
    }
}
