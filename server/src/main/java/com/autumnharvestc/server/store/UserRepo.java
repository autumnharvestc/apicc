package com.autumnharvestc.server.store;

import org.springframework.dao.EmptyResultDataAccessException;
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
 * users 表仓储（用例化方法，禁泛用 DAO——裁定 C）。
 * 事务边界约定：本任务不引 @Transactional；方法内均为单条 SQL。
 */
@Repository
public class UserRepo {

    private final JdbcTemplate jdbc;

    public UserRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final RowMapper<UserAccount> MAPPER = UserRepo::mapRow;

    /** users 表行数（部署线 D6：管理员启动引导判空专用，禁他处泛用）。 */
    public long count() {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM users", Long.class);
        return n == null ? 0L : n;
    }

    /** 注册落库。username 唯一约束冲突以 DuplicateKeyException 上抛，服务层转 409 username_taken。 */
    public void insert(UserAccount user) {
        jdbc.update("""
                INSERT INTO users (id, username, password_hash, display_name, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                user.id(), user.username(), user.passwordHash(), user.displayName(),
                OffsetDateTime.ofInstant(user.createdAt(), ZoneOffset.UTC));
    }

    /** 登录用：按用户名精确查找。 */
    public Optional<UserAccount> findByUsername(String username) {
        List<UserAccount> rows = jdbc.query("""
                SELECT id, username, password_hash, display_name, created_at
                FROM users WHERE username = ?
                """, MAPPER, username);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /** 认证过滤器装载身份：token → userId → 用户（/me 与受保护端点共用）。 */
    public Optional<UserAccount> findById(String id) {
        try {
            return Optional.ofNullable(jdbc.queryForObject("""
                    SELECT id, username, password_hash, display_name, created_at
                    FROM users WHERE id = ?
                    """, MAPPER, id));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    private static UserAccount mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new UserAccount(
                rs.getString("id"),
                rs.getString("username"),
                rs.getString("password_hash"),
                rs.getString("display_name"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant());
    }
}
