# apicc M3-A 在线协作服务端（Java/Spring Boot）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 自托管在线协作服务端 MVP：账号认证（bcrypt + 不透明 Bearer token）、团队工作区与成员角色、项目级 ACL、内容同步 API（树清单/文件读写/批推送/乐观并发）——API 面与权限模型严格对齐规格 §3 契约。

**架构：** Spring Boot 3.5.x 单模块 Maven 工程，包 `com.autumnharvestc.server`，分层 `auth/ workspace/ content/ core（权限/存储）`；元数据 H2 文件库（JdbcTemplate 显式 SQL，schema.sql 初始化）；工作区内容为 `server-data/workspaces/<wsId>/` 下与本地同构的文本树；认证为 once-per-request Filter；错误统一 `{code,message}`。

**技术栈：** Java 21、Spring Boot 3.5.5（starter-web/security-crypto/validation/jdbc/test + H2）、Maven。**零额外依赖**（不用 JPA/Spring Security 全量/Flyway——schema.sql + spring.sql.init 即可）。

**工作目录：** `D:\workspace260609\project-2\apicc-m3-server`（worktree，分支 `feature/m3-server`）。**基线：全新包，无 Java 既有代码；TS 三包不受影响。**

**环境硬约束：**
- 构建/测试命令统一：`cd server && mvn -s .mvn/settings.xml test`（settings 走 Aliyun mirror——本机 Maven Central 不可达）。
- 本机必须 `JAVA_HOME=C:\Program Files\Java\jdk-21.0.12`（Git Bash：`export JAVA_HOME="/c/Program Files/Java/jdk-21.0.12"`；PATH 默认 java 是 1.8）。本机 Maven 3.8.1 位于 `D:\IDE\JetBrains\IntelliJ IDEA 2023.1.2\plugins\maven\lib\maven3\bin\mvn`。
- 首次构建需联网下载依赖（走 Aliyun，已验证可达）；Spring Boot 3.5.5 在镜像上存在。

**全局约束：** 品牌中立（注释/文档不得出现竞品名）；中文 conventional commit（`feat(server): ...`）+ 显式路径 git add；SQL 用可移植子集（未来可换 Postgres——避免 H2 专有语法）；API 行为以规格 §3 契约为唯一事实（路径/载荷/错误码逐字对齐）；Java 注释中文、聚焦约束说明。

---

## 文件结构

```
server/
  .mvn/settings.xml                 ← Aliyun mirror（mirrorOf: central）
  .mvn/maven.config                 ← 可选：-s 透传（若配置则命令可省 -s；二选一，报告注明）
  mvnw / mvnw.cmd / .mvn/wrapper/   ← Wrapper（distributionUrl 指向 Aliyun Apache 镜像 3.9.9）
  pom.xml                           ← Boot 3.5.5 parent、Java 21、上述依赖
  src/main/java/com/autumnharvestc/server/
    ApiccServerApplication.java
    core/        ← Role/AclRole 枚举、PermissionService、异常与全局错误映射({code,message})
    auth/        ← AuthController、AuthService、TokenService、AuthFilter
    workspace/   ← WorkspaceController/Service、MemberController、ProjectAclController
    content/     ← ContentController、ContentService（tree/files/batch/并发/落盘）
    store/       ← JdbcTemplate 仓储（UserRepo/TokenRepo/WorkspaceRepo/MembershipRepo/AclRepo/FileVersionRepo）
  src/main/resources/application.yml、schema.sql
  src/test/java/com/autumnharvestc/server/...   ← MockMvc 契约测试 + 服务层单测（H2 内存）
  .gitignore                                    ← target/、server-data/
```

---

### 任务 1：骨架与测试基建

- [ ] **步骤 1：失败的测试**——`ApiccServerApplicationTests`：context 加载 + `GET /api/v1/ping` → 200 `{status:"ok"}`（MockMvc，H2 内存库 URL，spring.sql.init 启用）。
- [ ] **步骤 2：实现**——pom、settings.xml（mirrorOf central → aliyun public）、Wrapper（`wrapper:wrapper` 生成后改 distributionUrl 为 Aliyun Apache 镜像；若本机生成 wrapper 需联网，允许用本机 mvn 直接生成——wrapper 命令本身走 settings）、application.yml（`apicc.server.data-dir=./server-data`、`allow-registration=true`、`token-ttl-days=30`；H2 URL 指向 data-dir/metadata；`spring.sql.init.mode=always` + schema.sql 幂等 DDL `CREATE TABLE IF NOT EXISTS`）、PingController、全局异常映射骨架（`{code,message}` + 401/403/404/409/400 语义化 code）。验证：`mvn -s .mvn/settings.xml test` 绿 + `mvn spring-boot:run` 手动 ping 后停掉。
- [ ] **步骤 3：Commit** `feat(server): 服务端骨架——Boot 应用/Aliyun 镜像配置/H2 schema/测试基建`

### 任务 2：域模型与存储

- [ ] **步骤 1：失败的测试**——仓储层单测（H2 内存 + 真实 SQL）：users 唯一约束、tokens 哈希查找/过期/吊销、memberships 角色存取、project_acl 覆盖行、file_versions 每路径版本递增与唯一。
- [ ] **步骤 2：实现**——schema.sql 六表（见规格 D5/D6；角色 CHECK 约束；`file_versions(workspace_id, path)` 唯一）；枚举 `Role(OWNER,ADMIN,EDITOR,VIEWER)`、`AclRole(NONE,VIEWER,EDITOR,ADMIN)` 与 DB 字符串互转；六个 JdbcTemplate 仓储（方法面向用例命名，禁泛用 DAO）；`PermissionService.effectiveRole(workspaceId, userId, projectId?)`（ACL 覆盖优先，NONE 短路；无行继承工作区角色）+ 读写判定（`canRead/canWrite/isAdmin/isOwner`）。uuid 主键用 `UUID.randomUUID()`（char/uuid 列随 H2 模式，报告注明选择）。
- [ ] **步骤 3：Commit** `feat(server): 域模型与存储——用户/令牌/工作区/成员/项目ACL/文件版本`

### 任务 3：认证 API

- [ ] **步骤 1：失败的测试**——MockMvc 契约测试逐条对齐规格 §3.1：register 201/409/403（关闭注册时）/400（用户名与密码规则）；login 200（token/expiresAt/user 形状）/401；logout 204 且该 token 立即失效（再访问 /me 401）；/me 200/401；无 token 访问受保护端点 401。
- [ ] **步骤 2：实现**——AuthService（bcrypt 强度 ≥10；token = 32 字节随机 → base64url 返回用户、SHA-256 hex 入库；expiresAt = now+ttl）；AuthFilter（once-per-request：`Authorization: Bearer` 解析 → 哈希查 token → 过期/吊销校验 → `request.setAttribute("apicc.user", …)`；/api/v1/auth/* 与 /api/v1/ping 放行）；AuthController + `@Valid` 载荷校验；注册开关读配置。
- [ ] **步骤 3：Commit** `feat(server): 认证 API——注册/登录/登出/me 与 Bearer 过滤器`

### 任务 4：工作区/成员/项目 ACL API

- [ ] **步骤 1：失败的测试**——契约逐条对齐 §3.2/§3.3 + 权限矩阵测试（VIEWER/EDITOR/ADMIN/OWNER/非成员 五视角 × 读列表/建区/删区/读成员/改角色/移除/读ACL/改ACL）+ 规则测试（不能变更/移除 OWNER；OWNER 转让=设他人 OWNER 且自身降 ADMIN；创建者自动 OWNER；DELETE 区后内容目录一并删除）。
- [ ] **步骤 2：实现**——WorkspaceController/MemberController/ProjectAclController + Service；创建工作区时建内容目录（data-dir/workspaces/<id>/）；删除走目录递归删（失败则 500 并保持记录——报告注明取舍）；成员变更与 ACL 写操作校验调用者角色；响应 DTO 不泄露 password_hash/token。
- [ ] **步骤 3：Commit** `feat(server): 工作区/成员/项目 ACL API 与权限判定`

### 任务 5：内容同步 API

- [ ] **步骤 1：失败的测试**——契约逐条对齐 §3.4：tree（清单形状/hash/version/无权项目过滤/ping 用例造多项目）；files 批量取（missing 语义/≤200 上限 400）；PUT（新文件 baseVersion=0 → 201；内容变更 version 递增；同 hash 重写 version 是否递增——裁定：**不递增**，幂等 200；baseVersion 不匹配 → 409 带 currentVersion/currentHash；非法路径 400 path_invalid；apicc.workspace.yaml 非 ADMIN+ 写 → 403）；DELETE 并发语义；batch（混合 pushed/conflict/forbidden/invalid 部分成功）；权限（VIEWER 读 OK 写 403；NONE 项目路径 tree/files/PUT 三面全挡）；落盘失败回滚（注入失败目录模拟只读盘 → 500 且版本未递增——重试可恢复）。
- [ ] **步骤 2：实现**——ContentController/Service：path 校验器（禁 `..`/绝对/反斜杠/空段/尾斜杠）；读路径 resolve 后必须仍在工作区根内（防穿越）；hash=sha-256 hex；写路径单方法内完成「校验→比对→写文件→upsert 版本」，文件 IO 异常时回滚版本并 500 io_error；tree 的 projects 清单来自内容树推导（`groups/<name>/projects/<id>` 目录约定——对照 M1 §6 结构读取；若推导规则复杂则从 file_versions 路径集合推导，实现者按 M1 §6 结构对齐并在报告注明推导口径）；批量接口逐文件独立 try/catch 部分成功。
- [ ] **步骤 3：全量回归 + Commit** `feat(server): 内容同步 API——树清单/文件读写/批推送与乐观并发`

---

## 规格覆盖对照

| 规格（m3 spec §2/§3） | 任务 |
|---|---|
| D1/D2/D3 技术栈与镜像 | 1 |
| D4 认证 | 3 |
| D5 权限模型 | 2、4 |
| D6 内容存储 | 2、5 |
| D7 API 契约 §3.1/3.2/3.3 | 3、4 |
| D7 API 契约 §3.4 + 3.5 配置 | 1、5 |
| D8 同步协议（服务端侧） | 5 |

**明确推迟**：实时协同、审批流程、服务端执行编排、限流、审计日志、Postgres 方言验证。
