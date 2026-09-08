# 服务端账号与角色（计划 A）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 平台超级管理员角色（首个引导账号即超管）+ 账号生命周期管理（创建/重置密码/停用启用/入区定角色）+ 控制台「用户管理」页。规格：`docs/superpowers/specs/2026-09-08-apicc-server-org-rbac-design.md` 第 2、3、6 节。

**架构：** 沿用既有手写认证体系（`AuthFilter` + 请求属性注入 + `PermissionService`），`users` 表加 `role`/`disabled` 列，新增 `/api/v1/admin/*` 频道（超管守卫 = 控制器内显式校验），控制台新增用户管理页。**不改**内容同步契约、不引认证框架。

**技术栈：** Spring Boot 3.5.5 / JdbcTemplate / H2（内存库测试）/ Vue3 + antd-vue + pinia（admin-web）。

**约定：** 所有服务端测试沿用「每测试类独立 H2 内存库 + `apicc.server.data-dir=target/test-data-*` + MockMvc」既有模式；未发布阶段 `server-data` 真实库直接删库重开（schema 变更不迁移）。

---

## 文件结构

**服务端（修改）**
- `server/src/main/resources/schema.sql` — users 加 role/disabled 列
- `server/src/main/java/com/autumnharvestc/server/store/PlatformRole.java` — 创建：平台角色枚举
- `server/src/main/java/com/autumnharvestc/server/store/UserAccount.java` — 加 role/disabled 字段
- `server/src/main/java/com/autumnharvestc/server/store/UserRepo.java` — 插入/查询带新列；`findAll`；`setDisabled`；`updatePassword`；`revokeAllByUser`（TokenRepo）
- `server/src/main/java/com/autumnharvestc/server/store/TokenRepo.java` — 加 `revokeAllByUser`
- `server/src/main/java/com/autumnharvestc/server/auth/AuthService.java` — login 拒绝停用（403 account_disabled）
- `server/src/main/java/com/autumnharvestc/server/auth/AuthFilter.java` — 停用用户令牌拦截（纵深防御）
- `server/src/main/java/com/autumnharvestc/server/auth/AdminBootstrap.java` — 首账号 = SUPERADMIN
- `server/src/main/java/com/autumnharvestc/server/auth/UserView.java` — 加 role
- `server/src/main/java/com/autumnharvestc/server/admin/AdminController.java` — 创建：账号管理端点
- `server/src/main/java/com/autumnharvestc/server/admin/AdminService.java` — 创建：账号管理用例 + 超管守卫
- `server/src/main/java/com/autumnharvestc/server/admin/AdminRequests.java` — 创建：请求记录（创建/重置密码/定角色）

**控制台（修改/创建）**
- `apps/admin-web/src/api/contract.ts` — AdminUser 形状与载荷
- `apps/admin-web/src/api/client.ts` — admin* 方法
- `apps/admin-web/src/stores/session.ts` — /me 会话保留 role
- `apps/admin-web/src/stores/users.ts` — 创建：用户管理 store
- `apps/admin-web/src/views/UsersView.vue` — 创建：用户管理页
- `apps/admin-web/src/views/LayoutView.vue` — 菜单加「用户管理」（仅超管可见）
- `apps/admin-web/src/router/index.ts` — 路由 + 超管守卫

**测试**
- `server/src/test/java/com/autumnharvestc/server/admin/AdminUsersApiTest.java` — 创建
- `server/src/test/java/com/autumnharvestc/server/auth/AdminBootstrapTest.java` — 更新（role 断言）
- `server/src/test/java/com/autumnharvestc/server/auth/AuthApiContractTest.java` — 更新（/me 带 role）
- `apps/admin-web/tests/views/UsersView.test.ts` — 创建

---

### 任务 1：users 表 role/disabled 列与用户对象扩展

**文件：**
- 修改：`server/src/main/resources/schema.sql`
- 修改：`server/src/main/java/com/autumnharvestc/server/store/PlatformRole.java`（创建）
- 修改：`server/src/main/java/com/autumnharvestc/server/store/UserAccount.java`
- 修改：`server/src/main/java/com/autumnharvestc/server/store/UserRepo.java`

- [ ] **步骤 1：编写失败的测试**

在 `server/src/test/java/com/autumnharvestc/server/auth/AdminBootstrapTest.java` 的 `EnvConfiguredTest` 中追加 role 断言（此时编译失败——UserAccount 尚无 role）：

```java
        // 平台超管（规格§2）：启动引导创建的首个账号自动 SUPERADMIN
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("SUPERADMIN"));
```

（`token` 取自登录响应；该测试类需补一个登录+取 token 的前置步骤，参照 `AuthApiContractTest` 的 login 用法。）

- [ ] **步骤 2：运行测试确认编译失败**

运行：`JAVA_HOME="C:\Program Files\Java\jdk-21.0.12" ./mvnw -s .mvn/settings.xml -q test -Dtest=AdminBootstrapTest`（在 `server/` 目录）
预期：COMPILATION ERROR（`role()` 不存在）

- [ ] **步骤 3：实现**

`schema.sql` 的 users 表定义替换为（幂等 DDL 约定不变；既有库按惯例删库重开）：

```sql
CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(36)  NOT NULL,
    username      VARCHAR(32)  NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    display_name  VARCHAR(64)  NOT NULL,
    role          VARCHAR(16)  NOT NULL DEFAULT 'USER',
    disabled      BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_users PRIMARY KEY (id),
    CONSTRAINT uk_users_username UNIQUE (username),
    CONSTRAINT ck_users_role CHECK (role IN ('USER','SUPERADMIN'))
);
```

新建 `store/PlatformRole.java`：

```java
package com.autumnharvestc.server.store;

/** 平台角色（规格 2026-09-08 §2）：SUPERADMIN=账号管家（首个引导账号），USER=普通账号。 */
public enum PlatformRole {
    USER, SUPERADMIN;

    public static PlatformRole of(String value) {
        return value == null ? USER : valueOf(value);
    }
}
```

`UserAccount` 追加字段（record 顺序：既有调用点随编译错误逐一更新——`AuthService.register`、`AdminBootstrap.run`、`UserRepo.mapRow`、测试夹具）：

```java
public record UserAccount(
        String id,
        String username,
        String passwordHash,
        String displayName,
        PlatformRole role,
        boolean disabled,
        Instant createdAt) {
}
```

`UserRepo`：insert 增列；mapRow 读 `role`/`disabled`；新增：

```java
    /** 账号管理（规格§2）：全量清单（created_at 升序）。 */
    public List<UserAccount> findAll() {
        return jdbc.query("""
                SELECT id, username, password_hash, display_name, role, disabled, created_at
                FROM users ORDER BY created_at, id
                """, MAPPER);
    }

    public void setDisabled(String id, boolean disabled) {
        jdbc.update("UPDATE users SET disabled = ? WHERE id = ?", disabled, id);
    }

    public void updatePassword(String id, String passwordHash) {
        jdbc.update("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, id);
    }
```

- [ ] **步骤 4：运行该测试类与全量测试确认通过**

运行：`./mvnw -s .mvn/settings.xml test`
预期：全绿（构造点已随编译错误修正；新断言通过）

- [ ] **步骤 5：Commit**

```bash
git add server/src/main/resources/schema.sql server/src/main/java/com/autumnharvestc/server/store/ server/src/main/java/com/autumnharvestc/server/auth/ server/src/test/java/com/autumnharvestc/server/auth/AdminBootstrapTest.java
git commit -m "feat(server): users 表平台角色与停用列（首个引导账号即超管）"
```

---

### 任务 2：登录拒绝停用账号 + 停用吊销令牌 + 过滤器拦截

**文件：**
- 修改：`server/src/main/java/com/autumnharvestc/server/auth/AuthService.java`
- 修改：`server/src/main/java/com/autumnharvestc/server/auth/AuthFilter.java`
- 修改：`server/src/main/java/com/autumnharvestc/server/store/TokenRepo.java`
- 测试：`server/src/test/java/com/autumnharvestc/server/auth/AuthApiContractTest.java`

- [ ] **步骤 1：编写失败的测试**

`AuthApiContractTest` 追加：

```java
    /** 停用账号：登录 403 account_disabled；既有令牌一并失效（吊销）。 */
    @Test
    void disabledAccountRejectsLoginAndRevokesTokens() throws Exception {
        String registerBody = registerBody("paused", "password123", "暂停号");
        mockMvc.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON).content(registerBody))
                .andExpect(status().isCreated());
        var login = mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("paused", "password123")))
                .andExpect(status().isOk()).andReturn();
        String token = JSONPath.read(login.getResponse().getContentAsString(), "$.token").toString(); // 或按既有提取法
        // 既有令牌仍可用
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token)).andExpect(status().isOk());
        // 直接经 repo 停用（管理端点在任务 5）
        users.setDisabledByUsername("paused", true);
        tokens.revokeAllByUser(users.findByUsername("paused").orElseThrow().id());
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("paused", "password123")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("account_disabled"));
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized());
    }
```

（`users`/`tokens` 经 `@Autowired` 注入 repo；`JSONPath` 换成该文件既有的 token 提取写法。）

- [ ] **步骤 2：运行确认失败**

运行：`./mvnw -s .mvn/settings.xml test -Dtest=AuthApiContractTest`
预期：FAIL（`account_disabled` 未定义，登录仍 200）

- [ ] **步骤 3：实现**

`TokenRepo` 追加：

```java
    /** 停用账号时吊销其全部有效令牌（规格§2：停用=拒绝登录+吊销令牌）。 */
    public void revokeAllByUser(String userId) {
        jdbc.update("UPDATE tokens SET revoked = TRUE WHERE user_id = ? AND revoked = FALSE", userId);
    }
```

`AuthService.login` 在密码校验前插入：

```java
        if (account.disabled()) {
            throw new ApiException(HttpStatus.FORBIDDEN, "account_disabled", "账号已停用");
        }
```

`AuthFilter`（纵深防御：停用后未吊销的残余令牌也拦下）——`if (token.isPresent() && user.isPresent())` 改为：

```java
            if (token.isPresent() && user.isPresent() && !user.get().disabled()) {
```

- [ ] **步骤 4：运行确认通过**

运行：`./mvnw -s .mvn/settings.xml test -Dtest=AuthApiContractTest`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add server/src/main/java/com/autumnharvestc/server/auth/ server/src/main/java/com/autumnharvestc/server/store/TokenRepo.java server/src/test/java/com/autumnharvestc/server/auth/AuthApiContractTest.java
git commit -m "feat(server): 停用账号拒绝登录并吊销令牌"
```

---

### 任务 3：UserView 携带 role（/me 契约扩展）

**文件：**
- 修改：`server/src/main/java/com/autumnharvestc/server/auth/UserView.java`
- 测试：`server/src/test/java/com/autumnharvestc/server/auth/AuthApiContractTest.java`

- [ ] **步骤 1：编写失败的测试**

`AuthApiContractTest` 既有 `/me` 用例追加：

```java
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("USER")); // 普通注册账号
```

- [ ] **步骤 2：运行确认失败**

运行：`./mvnw -s .mvn/settings.xml test -Dtest=AuthApiContractTest`
预期：FAIL（`role` 字段缺失）

- [ ] **步骤 3：实现**

```java
public record UserView(String id, String username, String displayName, String role) {
    public static UserView of(UserAccount account) {
        return new UserView(account.id(), account.username(), account.displayName(), account.role().name());
    }
}
```

- [ ] **步骤 4：运行全量测试确认通过**（`UserView.of` 调用点编译错误随改）

运行：`./mvnw -s .mvn/settings.xml test`
预期：全绿

- [ ] **步骤 5：Commit**

```bash
git add server/src/main/java/com/autumnharvestc/server/auth/UserView.java server/src/test/java/com/autumnharvestc/server/auth/AuthApiContractTest.java
git commit -m "feat(server): /me 返回平台角色"
```

---

### 任务 4：账号管理 API（超管守卫）

**文件：**
- 创建：`server/src/main/java/com/autumnharvestc/server/admin/AdminRequests.java`
- 创建：`server/src/main/java/com/autumnharvestc/server/admin/AdminService.java`
- 创建：`server/src/main/java/com/autumnharvestc/server/admin/AdminController.java`
- 修改：`server/src/main/java/com/autumnharvestc/server/store/TokenRepo.java`（若无 revokeAllByUser 则此任务补齐——任务 2 已加）
- 测试：`server/src/test/java/com/autumnharvestc/server/admin/AdminUsersApiTest.java`（创建）

- [ ] **步骤 1：编写失败的测试**

`AdminUsersApiTest`（独立 H2 内存库 `apicc-admin-api-test`；夹具：bootstrap 建出超管 `admin/admin-pass-2026`，登录取 token，普通用户 `alice` 注册）：

```java
    private String superadminToken() throws Exception {
        return loginToken("admin", "admin-pass-2026");
    }

    @Test
    void listCreateDisableResetRestrictedToSuperadmin() throws Exception {
        String admin = superadminToken();
        String alice = loginToken("alice", "password123");
        // 非超管访问 → 403 superadmin_required
        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", "Bearer " + alice))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("superadmin_required"));
        // 清单含两个账号且不泄露 password_hash
        var list = mockMvc.perform(get("/api/v1/admin/users").header("Authorization", "Bearer " + admin))
                .andExpect(status().isOk()).andReturn();
        assertThat(list.getResponse().getContentAsString()).doesNotContain("password");
        // 创建账号（校验同注册）
        mockMvc.perform(post("/api/v1/admin/users").header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"bob\",\"password\":\"password123\",\"displayName\":\"Bob\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.role").value("USER"));
        mockMvc.perform(post("/api/v1/admin/users").header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"bob\",\"password\":\"password123\",\"displayName\":\"Bob2\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("username_taken"));
        // 重置密码：旧密码失效、新密码可登录
        String bobId = findUserId("bob");
        mockMvc.perform(post("/api/v1/admin/users/" + bobId + "/password-reset").header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"newPassword\":\"newpass123\"}"))
                .andExpect(status().isNoContent());
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("bob", "password123")))
                .andExpect(status().isForbidden()); // 停用前先重置：此处应 200——见下方修正说明
    }
```

**修正说明（写计划时预登记，执行时按此为准）**：重置密码**不**停用账号，旧密码登录应 401 invalid_credentials、新密码 200。上面最后一个断言写为：

```java
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("bob", "password123")))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("bob", "newpass123")))
                .andExpect(status().isOk());
```

再补停用/启用与入区定角色用例：

```java
    @Test
    void disableEnableAndWorkspaceRoleAssignment() throws Exception {
        String admin = superadminToken();
        String bobId = createBobAndGetId();
        // 停用：登录 403 + 不能停用自己
        mockMvc.perform(post("/api/v1/admin/users/" + bobId + "/disable").header("Authorization", "Bearer " + admin))
                .andExpect(status().isNoContent());
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("bob", "password123")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("account_disabled"));
        mockMvc.perform(post("/api/v1/admin/users/" + adminId() + "/disable").header("Authorization", "Bearer " + admin))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("cannot_disable_self"));
        // 启用：恢复登录
        mockMvc.perform(post("/api/v1/admin/users/" + bobId + "/enable").header("Authorization", "Bearer " + admin))
                .andExpect(status().isNoContent());
        mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("bob", "password123")))
                .andExpect(status().isOk());
        // 入区定角色（建一个工作区后，把 bob 设为该区 ADMIN）
        String wsId = createWorkspaceAsAdmin();
        mockMvc.perform(put("/api/v1/admin/users/" + bobId + "/workspace-role").header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"workspaceId\":\"" + wsId + "\",\"role\":\"ADMIN\"}"))
                .andExpect(status().isNoContent());
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/members").header("Authorization", "Bearer " + admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.username=='bob')].role").value("ADMIN"));
    }
```

（`findUserId/createBobAndGetId/adminId/createWorkspaceAsAdmin/loginToken` 为该测试类的私有夹具方法——分别用 `GET /api/v1/admin/users` 过滤、`POST /api/v1/workspaces`、login 提取实现；`adminId()` 经清单按 `username=="admin"` 过滤。）

- [ ] **步骤 2：运行确认失败**

运行：`./mvnw -s .mvn/settings.xml test -Dtest=AdminUsersApiTest`
预期：FAIL（404，端点不存在）

- [ ] **步骤 3：实现**

`admin/AdminRequests.java`：

```java
package com.autumnharvestc.server.admin;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/** 账号管理载荷（规格§2）：校验口径与注册一致（用户名 3-32 [a-zA-Z0-9_-]；密码 8-72）。 */
public final class AdminRequests {
    public record CreateUserRequest(
            @NotBlank @Size(min = 3, max = 32) @Pattern(regexp = "[a-zA-Z0-9_-]+", message = "仅允许字母、数字、下划线与连字符") String username,
            @NotBlank @Size(min = 8, max = 72) String password,
            @NotBlank @Size(max = 32) String displayName) {
    }

    public record ResetPasswordRequest(@NotBlank @Size(min = 8, max = 72) String newPassword) {
    }

    public record SetWorkspaceRoleRequest(@NotBlank String workspaceId,
                                          @NotBlank @Pattern(regexp = "OWNER|ADMIN|EDITOR|VIEWER") String role) {
    }
}
```

`admin/AdminService.java`（守卫 + 用例；密码哈希与 `AuthService` 同强度）：

```java
package com.autumnharvestc.server.admin;

import com.autumnharvestc.server.auth.AdminBootstrap;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.store.*;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** 账号生命周期用例（规格§2）：超管守卫 + 创建/重置密码/停用启用/入区定角色。 */
@Service
public class AdminService {

    private final UserRepo users;
    private final TokenRepo tokens;
    private final MembershipRepo memberships;
    private final PasswordEncoder encoder = new BCryptPasswordEncoder(10);

    public AdminService(UserRepo users, TokenRepo tokens, MembershipRepo memberships) {
        this.users = users;
        this.tokens = tokens;
        this.memberships = memberships;
    }

    private void requireSuperadmin(UserAccount caller) {
        if (caller.role() != PlatformRole.SUPERADMIN) {
            throw new ApiException(HttpStatus.FORBIDDEN, "superadmin_required", "需要平台超级管理员权限");
        }
    }

    public List<UserAccount> list(UserAccount caller) {
        requireSuperadmin(caller);
        return users.findAll();
    }

    public UserAccount create(UserAccount caller, AdminRequests.CreateUserRequest request) {
        requireSuperadmin(caller);
        users.findByUsername(request.username()).ifPresent(existing -> {
            throw new ApiException(HttpStatus.CONFLICT, "username_taken", "用户名已存在");
        });
        UserAccount account = new UserAccount(UUID.randomUUID().toString(), request.username(),
                encoder.encode(request.password()), request.displayName().trim(),
                PlatformRole.USER, false, Instant.now());
        users.insert(account);
        return account;
    }

    public void resetPassword(UserAccount caller, String userId, String newPassword) {
        requireSuperadmin(caller);
        users.findById(userId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "未找到账号"));
        users.updatePassword(userId, encoder.encode(newPassword));
        tokens.revokeAllByUser(userId); // 重置即踢下线
    }

    public void setDisabled(UserAccount caller, String userId, boolean disabled) {
        requireSuperadmin(caller);
        if (caller.id().equals(userId) && disabled) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "cannot_disable_self", "不能停用自己的账号");
        }
        users.findById(userId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "未找到账号"));
        users.setDisabled(userId, disabled);
        if (disabled) tokens.revokeAllByUser(userId);
    }

    /** 入区定角色（规格§2「分配使用」）：直接写 memberships（超管意志，无需目标区管理员同意）。 */
    public void setWorkspaceRole(UserAccount caller, String userId, String workspaceId, String role) {
        requireSuperadmin(caller);
        users.findById(userId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "未找到账号"));
        memberships.upsert(workspaceId, userId, role);
    }
}
```

（`memberships.upsert(workspaceId, userId, role)`：若 `MembershipRepo` 无此方法，按其既有 insert/update 风格补一个 `MERGE` 语义方法——H2 支持 `MERGE INTO`，或「查有则 UPDATE 无则 INSERT」两步。）

`admin/AdminController.java`：

```java
package com.autumnharvestc.server.admin;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.List;

/** 账号管理端点（规格§2）：全部仅 SUPERADMIN（守卫在 Service）。 */
@RestController
@RequestMapping("/api/v1/admin/users")
public class AdminController {

    private final AdminService admin;

    public AdminController(AdminService admin) {
        this.admin = admin;
    }

    public record AdminUserView(String id, String username, String displayName, String role, boolean disabled, String createdAt) {
        public static AdminUserView of(UserAccount u) {
            return new AdminUserView(u.id(), u.username(), u.displayName(), u.role().name(), u.disabled(), u.createdAt().toString());
        }
    }

    @GetMapping
    public List<AdminUserView> list(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller) {
        return admin.list(caller).stream().map(AdminUserView::of).toList();
    }

    @PostMapping
    public ResponseEntity<AdminUserView> create(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                                @Valid @RequestBody AdminRequests.CreateUserRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(AdminUserView.of(admin.create(caller, request)));
    }

    @PostMapping("/{id}/password-reset")
    public ResponseEntity<Void> resetPassword(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                              @PathVariable String id,
                                              @Valid @RequestBody AdminRequests.ResetPasswordRequest request) {
        admin.resetPassword(caller, id, request.newPassword());
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{id}/disable")
    public ResponseEntity<Void> disable(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable String id) {
        admin.setDisabled(caller, id, true);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{id}/enable")
    public ResponseEntity<Void> enable(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable String id) {
        admin.setDisabled(caller, id, false);
        return ResponseEntity.noContent().build();
    }

    @PutMapping("/{id}/workspace-role")
    public ResponseEntity<Void> setWorkspaceRole(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                                 @PathVariable String id,
                                                 @Valid @RequestBody AdminRequests.SetWorkspaceRoleRequest request) {
        admin.setWorkspaceRole(caller, id, request.workspaceId(), request.role());
        return ResponseEntity.noContent().build();
    }
}
```

- [ ] **步骤 4：运行确认通过**

运行：`./mvnw -s .mvn/settings.xml test -Dtest=AdminUsersApiTest`，随后全量 `./mvnw -s .mvn/settings.xml test`
预期：全绿

- [ ] **步骤 5：Commit**

```bash
git add server/src/main/java/com/autumnharvestc/server/admin/ server/src/test/java/com/autumnharvestc/server/admin/AdminUsersApiTest.java
git commit -m "feat(server): 账号管理 API（超管守卫：创建/重置密码/停用启用/入区定角色）"
```

---

### 任务 5：控制台「用户管理」页（用户管理 store + UsersView + 路由与菜单）

**文件：**
- 修改：`apps/admin-web/src/api/contract.ts`
- 修改：`apps/admin-web/src/api/client.ts`
- 修改：`apps/admin-web/src/stores/session.ts`
- 创建：`apps/admin-web/src/stores/users.ts`
- 创建：`apps/admin-web/src/views/UsersView.vue`
- 修改：`apps/admin-web/src/views/LayoutView.vue`
- 修改：`apps/admin-web/src/router/index.ts`
- 测试：`apps/admin-web/tests/views/UsersView.test.ts`（创建）

- [ ] **步骤 1：编写失败的测试**

`UsersView.test.ts`（fetch 桩模式与 MembersView 测试同款）核心用例：

```ts
  it("清单渲染 + 创建账号（client 载荷断言）+ 停用/启用/重置密码动作", async () => {
    // 桩：GET /admin/users → [{id:u1, username:alice, ...}, {id:ad, username:admin, role:SUPERADMIN}]
    //     POST /admin/users → 201 created；POST .../disable → 204；POST .../password-reset → 204
    const wrapper = await mountUsersView(handler);
    await flushPromises();
    expect(wrapper.findAll("tbody tr").length).toBe(2);
    await wrapper.find('[data-testid="users-create"]').trigger("click");
    await wrapper.find('[data-testid="users-form-username"]').setValue("bob");
    await wrapper.find('[data-testid="users-form-password"]').setValue("password123");
    await wrapper.find('[data-testid="users-form-display"]').setValue("Bob");
    await wrapper.find('[data-testid="users-form-save"]').trigger("click");
    await flushPromises();
    expect(postedCreate).toEqual({ username: "bob", password: "password123", displayName: "Bob" });
    // 行内动作
    await wrapper.find('[data-testid="user-disable-u1"]').trigger("click");
    expect(disabledCalls).toEqual(["u1"]);
  });
```

（断言「仅超管显示菜单」放 `LayoutView` 既有测试文件或本文件：`session.role === "USER"` 时菜单不含用户管理。）

- [ ] **步骤 2：运行确认失败**

运行：`pnpm exec vitest run tests/views/UsersView.test.ts`（在 `apps/admin-web/`）
预期：FAIL（UsersView 不存在）

- [ ] **步骤 3：实现**

`contract.ts` 追加：

```ts
export interface AdminUser { id: string; username: string; displayName: string; role: "USER" | "SUPERADMIN"; disabled: boolean; createdAt: string; }
```

`client.ts` 追加（沿既有 adminClient 拼装法，Authorization 头同款）：

```ts
  adminListUsers(): Promise<AdminUser[]>;
  adminCreateUser(input: { username: string; password: string; displayName: string }): Promise<AdminUser>;
  adminResetPassword(userId: string, newPassword: string): Promise<void>;
  adminSetDisabled(userId: string, disabled: boolean): Promise<void>;
  adminSetWorkspaceRole(userId: string, workspaceId: string, role: string): Promise<void>;
```

`session.ts`：/me 结果存 `role`（state 加 `role: "USER" | "SUPERADMIN"`，login/me 校活时写入）。

`stores/users.ts`：`state { items: AdminUser[], loading, error }` + `refresh()/create()/resetPassword()/setDisabled()`——错误上屏不抛出（沿 workspaces store 模式）。

`views/UsersView.vue`：a-table 清单（用户名/昵称/角色 tag/状态/创建时间/操作列：重置密码、停用|启用）+ 创建 a-modal（用户名/密码/昵称，client 校验同注册口径）+ 错误 a-alert。关键 testid：`users-create`、`users-form-*`、`user-disable-{id}`、`user-enable-{id}`、`user-reset-{id}`。

`LayoutView.vue`：菜单加「用户管理」项，`v-if="session.role === 'SUPERADMIN'"`；`router/index.ts` 加路由并在进入前校验 role（非超管重定向 workspaces）。

- [ ] **步骤 4：运行确认通过**

运行：`pnpm exec vitest run`（apps/admin-web）
预期：全绿

- [ ] **步骤 5：Commit**

```bash
git add apps/admin-web/src apps/admin-web/tests/views/UsersView.test.ts
git commit -m "feat(admin-web): 用户管理页（超管专属：清单/创建/重置密码/停用启用）"
```

---

### 任务 6：收尾验证

- [ ] **步骤 1：服务端全量 + 控制台全量**

运行：`./mvnw -s .mvn/settings.xml test`（server，预期 143+ 全绿）；`pnpm -C apps/admin-web test`（预期全绿）；`pnpm -C apps/admin-web build`
预期：全绿、构建成功

- [ ] **步骤 2：真机口径自查（本地起服验证超管链路）**

`java -jar server/target/*.jar` + 控制台 dist → admin 登录 → 用户管理建 bob → 重置密码 → 停用/启用 → bob 登录验证。（打包核验可并入批次收尾。）

- [ ] **步骤 3：推送**

```bash
git push origin main
```
