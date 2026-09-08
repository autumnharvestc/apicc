package com.autumnharvestc.server.auth;

import com.autumnharvestc.server.store.PlatformRole;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

/**
 * 首个管理员启动引导（部署线 D6，规格 docs/superpowers/specs/2026-09-06-apicc-server-deploy-design.md）：
 * 注册默认关闭（D5）后全新部署必须保证可登录——启动时 users 表为空则创建管理员账号。
 * 幂等：非空表一律 no-op（重启不改名、不覆盖、不重打印）。
 * 凭据来源：环境变量优先（APICC_SERVER_ADMIN_USERNAME / APICC_SERVER_ADMIN_PASSWORD，
 * 宽松绑定 apicc.server.admin-username / apicc.server.admin-password；用户名给了而口令空
 * 同样走随机口令）；完全未配置时用户名 admin + 随机口令（SecureRandom 16 字节 base64url），
 * 口令以 WARN 仅此一次打印日志，提示立即登录修改。
 * 「管理员」语义 = 第一个账号：平台角色即 SUPERADMIN（users.role，规格 2026-09-08 §2「启动引导
 * 创建的首个账号自动 SUPERADMIN」）；建工作区成 OWNER（schema.sql 工作区级角色体系）语义不变。
 */
@Component
@Order(1) // 先于 DefaultWorkspaceSeeder（@Order(2)）：种子器的 OWNER 行依赖超管账号先建
public class AdminBootstrap implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AdminBootstrap.class);

    /** bcrypt 强度与 AuthService 注册同一约定（≥10）。 */
    private static final int BCRYPT_STRENGTH = 10;

    private final UserRepo users;
    private final String configuredUsername;
    private final String configuredPassword;
    private final PasswordEncoder passwordEncoder = new BCryptPasswordEncoder(BCRYPT_STRENGTH);

    public AdminBootstrap(UserRepo users,
                          @Value("${apicc.server.admin-username:}") String configuredUsername,
                          @Value("${apicc.server.admin-password:}") String configuredPassword) {
        this.users = users;
        this.configuredUsername = configuredUsername;
        this.configuredPassword = configuredPassword;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (users.count() > 0) {
            return;
        }
        String username = configuredUsername.isBlank() ? "admin" : configuredUsername.trim();
        if (username.length() > 32) {
            // users.username VARCHAR(32)，配置错误 fail-fast 于启动期而非落库期
            throw new IllegalStateException("apicc.server.admin-username 超过 32 字符: " + username);
        }
        boolean fromEnv = !configuredPassword.isBlank();
        String password = fromEnv ? configuredPassword : randomPassword();
        users.insert(new UserAccount(
                UUID.randomUUID().toString(), username,
                passwordEncoder.encode(password), username,
                PlatformRole.SUPERADMIN, false, Instant.now()));
        if (fromEnv) {
            log.info("首次启动：已创建管理员账号 {}（凭据来自环境变量），请妥善保管", username);
        } else {
            log.warn("首次启动：已创建管理员账号 {}，初始密码：{}（仅此一次打印，请立即登录并修改密码）",
                    username, password);
        }
    }

    /** 随机口令：16 字节 → base64url 22 字符，无歧义且满足登录口令长度约束。 */
    private static String randomPassword() {
        byte[] raw = new byte[16];
        new SecureRandom().nextBytes(raw);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }
}
