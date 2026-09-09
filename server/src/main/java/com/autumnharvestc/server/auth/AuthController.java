package com.autumnharvestc.server.auth;

import com.autumnharvestc.server.store.UserAccount;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 认证端点（规格 m3 §3.1）：config / register / login / logout / me。
 * config 与 register、login 在过滤器放行清单（裁定 A）；logout 与 me 需认证，
 * 身份与令牌哈希由 AuthFilter 以请求属性注入。
 */
@RestController
public class AuthController {

    private final AuthService auth;

    public AuthController(AuthService auth) {
        this.auth = auth;
    }

    /** 认证面公开配置（无认证）：登录页按 registrationOpen 决定是否显示注册入口。 */
    @GetMapping("/api/v1/auth/config")
    public Map<String, Boolean> config() {
        return Map.of("allowRegistration", auth.registrationOpen());
    }

    /** 201 {id, username, displayName}；409 username_taken；403 registration_disabled；400 校验。 */
    @PostMapping("/api/v1/auth/register")
    public ResponseEntity<UserView> register(@Valid @RequestBody RegisterRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(auth.register(request));
    }

    /** 200 {token, expiresAt, user}；401 invalid_credentials。 */
    @PostMapping("/api/v1/auth/login")
    public LoginResponse login(@Valid @RequestBody LoginRequest request) {
        return auth.login(request);
    }

    /** 204 吊销当前 token；401（无有效 token 时过滤器先行拦截）。 */
    @PostMapping("/api/v1/auth/logout")
    public ResponseEntity<Void> logout(@RequestAttribute(AuthFilter.ATTR_TOKEN_HASH) String tokenHash) {
        auth.logout(tokenHash);
        return ResponseEntity.noContent().build();
    }

    /** 200 {id, username, displayName, role}；401。 */
    @GetMapping("/api/v1/me")
    public UserView me(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount user) {
        return UserView.of(user);
    }
}
