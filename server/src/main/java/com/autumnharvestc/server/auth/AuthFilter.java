package com.autumnharvestc.server.auth;

import com.autumnharvestc.server.core.GlobalExceptionHandler;
import com.autumnharvestc.server.store.TokenRecord;
import com.autumnharvestc.server.store.TokenRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.Set;

/**
 * Bearer 认证过滤器（规格 m3 §2 D4，裁定 A）：once-per-request bean。
 * 放行清单 = /api/v1/ping、/api/v1/auth/register、/api/v1/auth/login（logout 需认证）；
 * 其余 /api/v1/** 均需有效 Bearer token——含未匹配路由（401 先于 404，不向未认证方泄露路由存在性）；
 * 非 /api/v1 面放行交给 404 映射。
 * 认证成功后以请求属性向下传递身份（{@link #ATTR_USER}）与令牌哈希（{@link #ATTR_TOKEN_HASH}，logout 用）。
 */
@Component
public class AuthFilter extends OncePerRequestFilter {

    /** 当前用户（store.UserAccount）——受保护端点经 @RequestAttribute 取用。 */
    public static final String ATTR_USER = "apicc.user";
    /** 当前请求的 token 哈希（SHA-256 hex）——logout 吊销用。 */
    public static final String ATTR_TOKEN_HASH = "apicc.tokenHash";

    private static final Set<String> PUBLIC_PATHS =
            Set.of("/api/v1/ping", "/api/v1/auth/register", "/api/v1/auth/login");

    private final TokenRepo tokens;
    private final UserRepo users;
    private final TokenService tokenService;
    private final ObjectMapper objectMapper;

    public AuthFilter(TokenRepo tokens, UserRepo users, TokenService tokenService, ObjectMapper objectMapper) {
        this.tokens = tokens;
        this.users = users;
        this.tokenService = tokenService;
        this.objectMapper = objectMapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !path.startsWith("/api/v1/") || PUBLIC_PATHS.contains(path);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String plainToken = extractBearerToken(request);
        if (plainToken != null) {
            String tokenHash = tokenService.sha256Hex(plainToken);
            Optional<TokenRecord> token;
            Optional<UserAccount> user;
            // 裁定 C①（任务 3/4 审查留痕承接）：元数据库故障在过滤器内直写 500 {code:"internal_error"}——
            // 过滤器先于 DispatcherServlet，@RestControllerAdvice 不覆盖过滤器，放任上抛会成为容器错误页。
            // 只包 DB 查找段：chain 内控制器异常必须继续上抛给全局映射。
            try {
                token = tokens.findActiveByHash(tokenHash);
                user = token.isPresent() ? users.findById(token.get().userId()) : Optional.empty();
            } catch (RuntimeException ex) {
                writeJson(response, HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "internal_error", "服务端内部错误");
                return;
            }
            if (token.isPresent() && user.isPresent()) {
                request.setAttribute(ATTR_USER, user.get());
                request.setAttribute(ATTR_TOKEN_HASH, tokenHash);
                chain.doFilter(request, response);
                return;
            }
        }
        writeUnauthorized(response);
    }

    /** 解析 Authorization 头：仅接受 Bearer 方案（大小写不敏感）；缺失/格式不符返回 null。 */
    private String extractBearerToken(HttpServletRequest request) {
        String authorization = request.getHeader("Authorization");
        if (authorization == null || !authorization.regionMatches(true, 0, "Bearer ", 0, 7)) {
            return null;
        }
        String token = authorization.substring(7).trim();
        return token.isEmpty() ? null : token;
    }

    /**
     * 过滤器先于 DispatcherServlet，@RestControllerAdvice 不覆盖过滤器 → 直接写 401（裁定 A）。
     * 响应体仍为契约约定的 {code,message}，code=unauthorized。
     */
    private void writeUnauthorized(HttpServletResponse response) throws IOException {
        writeJson(response, HttpServletResponse.SC_UNAUTHORIZED, "unauthorized", "缺少或无效的 Bearer token");
    }

    /** 过滤器面统一响应形状：{code,message}（401 认证失败 / 500 元数据库故障——裁定 C①）。 */
    private void writeJson(HttpServletResponse response, int status, String code, String message) throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(objectMapper.writeValueAsString(
                new GlobalExceptionHandler.ApiError(code, message)));
    }
}
