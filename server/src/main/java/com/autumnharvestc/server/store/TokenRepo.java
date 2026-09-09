package com.autumnharvestc.server.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

/**
 * tokens 表仓储（用例化方法——裁定 C）：哈希查找只认「未吊销且未过期」的令牌（规格 m3 §2 D4）。
 * 过期判定以应用时钟为参（可测试性）；时间统一 UTC。
 */
@Repository
public class TokenRepo {

    private final JdbcTemplate jdbc;

    public TokenRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final RowMapper<TokenRecord> MAPPER = TokenRepo::mapRow;

    /** 登录签发落库（仅存 SHA-256 哈希）。token_hash 为主键，重复签发同哈希即约束冲突。 */
    public void insert(TokenRecord token) {
        jdbc.update("""
                INSERT INTO tokens (token_hash, user_id, expires_at, revoked, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                token.tokenHash(), token.userId(),
                OffsetDateTime.ofInstant(token.expiresAt(), ZoneOffset.UTC),
                token.revoked(),
                OffsetDateTime.ofInstant(token.createdAt(), ZoneOffset.UTC));
    }

    /** 认证过滤器用：按哈希取活动令牌——已吊销或已过期的令牌不返回（等效不存在 → 401）。 */
    public Optional<TokenRecord> findActiveByHash(String tokenHash) {
        List<TokenRecord> rows = jdbc.query("""
                SELECT token_hash, user_id, expires_at, revoked, created_at
                FROM tokens
                WHERE token_hash = ? AND revoked = FALSE AND expires_at > ?
                """, MAPPER, tokenHash, OffsetDateTime.now(ZoneOffset.UTC));
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /** 登出吊销：幂等（无行受影响不报错）。 */
    public void revokeByHash(String tokenHash) {
        jdbc.update("UPDATE tokens SET revoked = TRUE WHERE token_hash = ?", tokenHash);
    }

    /** 停用账号时吊销其全部有效令牌（规格§2：停用=拒绝登录+吊销令牌）。 */
    public void revokeAllByUser(Long userId) {
        jdbc.update("UPDATE tokens SET revoked = TRUE WHERE user_id = ? AND revoked = FALSE", userId);
    }

    private static TokenRecord mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new TokenRecord(
                rs.getString("token_hash"),
                rs.getLong("user_id"),
                rs.getObject("expires_at", OffsetDateTime.class).toInstant(),
                rs.getBoolean("revoked"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant());
    }
}
