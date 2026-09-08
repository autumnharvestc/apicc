package com.autumnharvestc.server.auth;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.store.PlatformRole;
import com.autumnharvestc.server.store.TokenRecord;
import com.autumnharvestc.server.store.TokenRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

/**
 * 认证用例（规格 m3 §2 D4 / §3.1）：注册（bcrypt + 开关）、登录（签发不透明 token）、登出（吊销）。
 * 错误以 ApiException 携带语义化 code，由 GlobalExceptionHandler 统一映射 {code,message}。
 */
@Service
public class AuthService {

    /** bcrypt 强度 ≥10（计划任务 3 约定）。 */
    private static final int BCRYPT_STRENGTH = 10;

    private final UserRepo users;
    private final TokenRepo tokens;
    private final TokenService tokenService;
    private final PasswordEncoder passwordEncoder = new BCryptPasswordEncoder(BCRYPT_STRENGTH);
    private final boolean allowRegistration;
    private final Duration tokenTtl;

    public AuthService(UserRepo users,
                       TokenRepo tokens,
                       TokenService tokenService,
                       @Value("${apicc.server.allow-registration:false}") boolean allowRegistration,
                       @Value("${apicc.server.token-ttl-days:30}") int tokenTtlDays) {
        this.users = users;
        this.tokens = tokens;
        this.tokenService = tokenService;
        this.allowRegistration = allowRegistration;
        this.tokenTtl = Duration.ofDays(tokenTtlDays);
    }

    /** 注册：开关关闭 → 403 registration_disabled；重名 → 409 username_taken（含唯一约束竞态兜底）。 */
    public UserView register(RegisterRequest request) {
        if (!allowRegistration) {
            throw new ApiException(HttpStatus.FORBIDDEN, "registration_disabled", "注册已关闭");
        }
        users.findByUsername(request.username()).ifPresent(existing -> {
            throw new ApiException(HttpStatus.CONFLICT, "username_taken", "用户名已存在");
        });
        UserAccount account = new UserAccount(
                UUID.randomUUID().toString(),
                request.username(),
                passwordEncoder.encode(request.password()),
                request.displayName().trim(),
                PlatformRole.USER,
                false,
                Instant.now());
        try {
            users.insert(account);
        } catch (DuplicateKeyException ex) {
            // 并发同名注册兜底：users.username 唯一约束
            throw new ApiException(HttpStatus.CONFLICT, "username_taken", "用户名已存在");
        }
        return UserView.of(account);
    }

    /** 登录：凭据不符一律 401 invalid_credentials（用户不存在与密码错误同响应，不泄露存在性）。 */
    public LoginResponse login(LoginRequest request) {
        UserAccount account = users.findByUsername(request.username())
                .orElseThrow(() -> new ApiException(HttpStatus.UNAUTHORIZED, "invalid_credentials", "用户名或密码错误"));
        if (!passwordEncoder.matches(request.password(), account.passwordHash())) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "invalid_credentials", "用户名或密码错误");
        }
        String plainToken = tokenService.issue();
        Instant expiresAt = Instant.now().plus(tokenTtl);
        tokens.insert(new TokenRecord(tokenService.sha256Hex(plainToken), account.id(), expiresAt, false, Instant.now()));
        return new LoginResponse(plainToken, expiresAt, UserView.of(account));
    }

    /** 登出：按库存哈希幂等吊销。token 已失效时过滤器先行 401，正常到不了重复吊销。 */
    public void logout(String tokenHash) {
        tokens.revokeByHash(tokenHash);
    }
}
