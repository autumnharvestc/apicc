package com.autumnharvestc.server.store;

import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * users 表仓储（用例化方法，禁泛用 DAO——裁定 C）。
 * 事务边界约定：本任务不引 @Transactional；方法内均为单条 SQL。
 * insert 双分支（规格 2026-09-09 BIGINT 化，全局不变量 4/6）：identity = 不带 id 插入 +
 * GeneratedKeyHolder 取回生成键回填；appAssigned = nextId() 显式带 id 插入（外部策略预留）。
 */
@Repository
public class UserRepo {

    private static final String INSERT_SQL = """
            INSERT INTO users (username, password_hash, display_name, role, disabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """;

    private static final String INSERT_WITH_ID_SQL = """
            INSERT INTO users (id, username, password_hash, display_name, role, disabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """;

    private final JdbcTemplate jdbc;
    private final IdGeneration ids;

    public UserRepo(JdbcTemplate jdbc, IdGeneration ids) {
        this.jdbc = jdbc;
        this.ids = ids;
    }

    private static final RowMapper<UserAccount> MAPPER = UserRepo::mapRow;

    /** users 表行数（部署线 D6：管理员启动引导判空专用，禁他处泛用）。 */
    public long count() {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM users", Long.class);
        return n == null ? 0L : n;
    }

    /** 是否存在启用中的平台超管（启动重引导判据：有超管则引导让位，防超管丢失锁死）。 */
    public boolean existsSuperadmin() {
        Long n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM users WHERE role = 'SUPERADMIN' AND disabled = FALSE", Long.class);
        return n != null && n > 0;
    }

    /**
     * 注册落库，返回补全 id 的新记录（全局不变量 6）。username 唯一约束冲突以
     * DuplicateKeyException 上抛，服务层转 409 username_taken。
     */
    public UserAccount insert(UserAccount user) {
        OffsetDateTime createdAt = OffsetDateTime.ofInstant(user.createdAt(), ZoneOffset.UTC);
        if (ids.appAssigned()) {
            long assigned = ids.nextId();
            jdbc.update(INSERT_WITH_ID_SQL, assigned, user.username(), user.passwordHash(),
                    user.displayName(), user.role().name(), user.disabled(), createdAt);
            return user.withId(assigned);
        }
        KeyHolder keyHolder = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(INSERT_SQL, new String[]{"id"});
            ps.setString(1, user.username());
            ps.setString(2, user.passwordHash());
            ps.setString(3, user.displayName());
            ps.setString(4, user.role().name());
            ps.setBoolean(5, user.disabled());
            ps.setObject(6, createdAt);
            return ps;
        }, keyHolder);
        // 生成键形态随驱动可能是 BigInteger/Long，统一 .longValue()
        Number key = Objects.requireNonNull(keyHolder.getKey(), "users INSERT 未返回生成主键");
        return user.withId(key.longValue());
    }

    /** 账号管理（规格§2）：全量清单（created_at 升序）。 */
    public List<UserAccount> findAll() {
        return jdbc.query("""
                SELECT id, username, password_hash, display_name, role, disabled, created_at
                FROM users ORDER BY created_at, id
                """, MAPPER);
    }

    public void setDisabled(Long id, boolean disabled) {
        jdbc.update("UPDATE users SET disabled = ? WHERE id = ?", disabled, id);
    }

    public void updatePassword(Long id, String passwordHash) {
        jdbc.update("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, id);
    }

    /** 登录用：按用户名精确查找。 */
    public Optional<UserAccount> findByUsername(String username) {
        List<UserAccount> rows = jdbc.query("""
                SELECT id, username, password_hash, display_name, role, disabled, created_at
                FROM users WHERE username = ?
                """, MAPPER, username);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /** 成员候选搜索（规格 2026-09-09 成员搜索）：username/display_name 大小写不敏感包含匹配，
     * 排除已有成员与停用账号，username 升序截前 limit 条。LIKE 通配符转义防关键字注入语义。 */
    public List<UserAccount> searchCandidates(String workspaceId, String keyword, int limit) {
        String escaped = keyword.toLowerCase()
                .replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
        String like = "%" + escaped + "%";
        return jdbc.query("""
                SELECT u.id, u.username, u.password_hash, u.display_name, u.role, u.disabled, u.created_at
                FROM users u
                WHERE u.disabled = FALSE
                  AND NOT EXISTS (SELECT 1 FROM memberships m
                                  WHERE m.workspace_id = ? AND m.user_id = u.id)
                  AND (LOWER(u.username) LIKE ? ESCAPE '\\' OR LOWER(u.display_name) LIKE ? ESCAPE '\\')
                ORDER BY u.username
                LIMIT ?
                """, MAPPER, workspaceId, like, like, limit);
    }

    /** 认证过滤器装载身份：token → userId → 用户（/me 与受保护端点共用）。 */
    public Optional<UserAccount> findById(Long id) {
        try {
            return Optional.ofNullable(jdbc.queryForObject("""
                    SELECT id, username, password_hash, display_name, role, disabled, created_at
                    FROM users WHERE id = ?
                    """, MAPPER, id));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    private static UserAccount mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new UserAccount(
                rs.getLong("id"),
                rs.getString("username"),
                rs.getString("password_hash"),
                rs.getString("display_name"),
                PlatformRole.of(rs.getString("role")),
                rs.getBoolean("disabled"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant());
    }
}
