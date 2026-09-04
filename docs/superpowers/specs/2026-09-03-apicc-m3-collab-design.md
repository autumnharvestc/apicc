# apicc M3 设计规格：在线协作底座（自托管 Java 服务端 + 桌面端在线模式）

日期：2026-09-03
状态：已批准（用户指示「开始 M3」；技术选型出自用户原始需求：在线模式后端 Java、后台管理前端 Vue 归 M4）
上游：`2026-09-01-apicc-m1-local-core-design.md`（§5.1 StorageAdapter「M3 在线数据库实现同一接口——可移植性关键钩子」、§6 工作区文件结构）、`local/原始需求.md`（在线模式：项目访问权限管理、用户角色管理、本地-联机模式切换、本地-在线工作区互相迁移；该文件不入库）

---

## 1. 背景与目标

M1/M2 交付了完备的本地模式（接口定义/调试/测试/工作流/压测）。M3 打开「第二公民」场景：研发团队可选开启在线模式，获得**账号、团队空间、角色权限、项目访问控制、内容同步与本地↔在线迁移**。服务端为**自托管**——团队在自己的机器上运行，数据不出内网；工作区内容仍是与本地完全同构的文本文件树，延续「文本文件 + Git 优先」哲学。

### M3 成功标准

团队内网起一个服务端；成员注册登录后看到团队工作区列表；按角色浏览/编辑接口定义（VIEWER 只读、冲突有提示）；能把在线工作区拉取到本地离线使用，也能把本地工作区推送到在线共享。

### 非目标（后续里程碑/评估项）

实时协同编辑与在线存在感（WebSocket presence）、审批式版本生效流程（M3+ 评估）、管理后台 web 控制台（M4）、服务端执行编排与服务端分布式压测协调（后续评估）、邮件验证/找回密码、SSO/LDAP、透明远程调试运行（M3 的在线工作区调试运行走「先拉取到本地」引导）。

---

## 2. 关键决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | 技术栈 | Java 21 + Spring Boot 3.5.x + Maven 3.8+；服务端位于 monorepo 顶层 `server/`；groupId `com.autumnharvestc`、artifactId `apicc-server`、包前缀 `com.autumnharvestc.server` |
| D2 | 依赖基调 | `starter-web`（MVC，开虚拟线程）+ `spring-security-crypto`（仅 bcrypt——不引入全量 Spring Security，自写 once-per-request 认证过滤器，审计面小）+ `starter-validation` + `starter-jdbc`（JdbcTemplate 显式 SQL，表少不引入 JPA）+ H2（文件模式存元数据，纯 Java 零原生依赖；SQL 保持可移植子集，未来可换 Postgres）+ `starter-test`（JUnit5 + MockMvc，测试用 H2 内存库） |
| D3 | 仓库镜像 | 本机实测 Maven Central 不可达、Aliyun public 可达 → 仓库提交 `server/.mvn/settings.xml`（mirror: central → `https://maven.aliyun.com/repository/public`），**所有** mvn 命令（本地/CI）统一 `-s server/.mvn/settings.xml`；Maven Wrapper 的 distributionUrl 指向 Aliyun Apache 镜像（`https://mirrors.aliyun.com/apache/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip`）使 wrapper 本地亦可用。本机构建必须显式 `JAVA_HOME=C:\Program Files\Java\jdk-21.0.12`（PATH 默认 java 是 1.8） |
| D4 | 认证 | 注册（`allowRegistration` 配置开关，默认开）→ 登录签发**不透明 Bearer token**：随机 256bit、服务端存 SHA-256 哈希（不存明文）、固定 30 天有效、logout 吊销；密码 bcrypt 哈希。 `/auth/*` 与 `/me` 之外的全部端点要求有效 token |
| D5 | 权限模型 | 两层：①工作区成员角色 `OWNER > ADMIN > EDITOR > VIEWER`（membership 表）；②**项目级 ACL 覆盖**（project_acl 表：NONE / VIEWER / EDITOR / ADMIN），无行 = 按工作区角色继承。语义：VIEWER 读、EDITOR 写内容、ADMIN 管理成员与项目 ACL、OWNER 管理工作区（删除/转让/移除成员）。内容 API 按有效角色过滤：无读权限的子树不出现在 tree/files |
| D6 | 内容存储 | `server-data/workspaces/<wsId>/` 目录树与本地工作区**完全同构**（`apicc.workspace.yaml` + `groups/…`，M1 §6）；版本元数据表 `file_versions(workspace_id, path, content_hash, version, updated_by, updated_at)`——写路径：权限校验 → baseVersion 比对 → 写文件 → 更新版本（版本表为准；文件落盘失败回滚版本记录并 500）。服务端不做 schema 校验（内容合法性由客户端拉取后校验，服务端只当字节管家） |
| D7 | API 契约（v1） | 见 §3，全 JSON；错误统一 `{ code, message }`；乐观并发：PUT 携带 `baseVersion`，不匹配 → 409 + 服务端现状（`{ currentVersion, contentHash }`） |
| D8 | 同步/迁移协议 | **拉取**：GET tree（路径+hash+version 清单）→ 按需 GET files → 本地比对 hash 增量落盘。**推送**：客户端先 GET tree，本地比对出差异集，新文件标 `new`、已存在文件带服务端 version 作 baseVersion 走 batch push → 逐文件结果（pushed/conflict/failed），冲突默认跳过并列出——**从不盲目覆盖** |
| D9 | 桌面端集成 | main 进程 `onlineClient`（undici + token 管理 + Electron safeStorage 存 token，不可用则明文+警告）；`onlineStore`（服务器/登录态/在线工作区列表/在线树）；在线工作区复用侧树 TreeNodeDTO 映射渲染（VIEWER 只读态）；编辑推送带 409 冲突提示；迁移按钮（拉取到本地 / 推送在线，向导式进度+结果清单）；模式切换 = 工作区上下文切换（本地目录 ↔ 在线工作区），顶栏可辨标识 |
| D10 | 测试门禁 | server：`mvn -s server/.mvn/settings.xml test`（MockMvc 全 API 契约 + 服务层单测，H2 内存库）；桌面端：既有 vitest 门禁 + onlineClient/store/组件测试（内存替身同构）；联调轨（M3-C）以真服务端对跑 |

---

## 3. API 契约（v1，契约优先——A/B 两轨共同实现对象）

约定：认证端点外全部要求 `Authorization: Bearer <token>`；错误响应统一 `{ "code": string, "message": string }`；时间戳 ISO-8601 UTC。

### 3.1 认证

| 方法 路径 | 载荷 | 成功响应 | 错误 |
|---|---|---|---|
| POST `/api/v1/auth/register` | `{ username(3-32,[a-zA-Z0-9_-]), password(≥8), displayName }` | `201 { id, username, displayName }` | 409 username_taken；403 registration_disabled；400 校验 |
| POST `/api/v1/auth/login` | `{ username, password }` | `200 { token, expiresAt, user: { id, username, displayName } }` | 401 invalid_credentials |
| POST `/api/v1/auth/logout` | — | `204`（吊销当前 token） | 401 |
| GET `/api/v1/me` | — | `200 { id, username, displayName }` | 401 |

### 3.2 工作区与成员

| 方法 路径 | 语义 | 权限 |
|---|---|---|
| GET `/api/v1/workspaces` | 我参与的工作区列表 `[{ id, name, myRole, createdAt }]` | 登录 |
| POST `/api/v1/workspaces` | `{ name }` → `201 { id, name, myRole: "OWNER" }`（创建者自动 OWNER） | 登录 |
| GET `/api/v1/workspaces/{id}` | `{ id, name, myRole, memberCount }` | 成员 |
| DELETE `/api/v1/workspaces/{id}` | 删除（含内容目录） | OWNER |
| GET `/api/v1/workspaces/{id}/members` | `[{ userId, username, displayName, role }]` | 成员 |
| PUT `/api/v1/workspaces/{id}/members/{userId}` | `{ role }` 添加/变更成员角色 | ADMIN+（不能变更 OWNER；提升到 OWNER 仅 OWNER 可，MVP 转让=OWNER 将他人设为 OWNER 且自身降 ADMIN） |
| DELETE `/api/v1/workspaces/{id}/members/{userId}` | 移除成员 | ADMIN+（不能移除 OWNER） |

### 3.3 项目 ACL

| 方法 路径 | 语义 | 权限 |
|---|---|---|
| GET `/api/v1/workspaces/{id}/projects/{projectId}/acl` | `[{ userId, role }]`（role ∈ NONE/VIEWER/EDITOR/ADMIN） | ADMIN+ |
| PUT 同路径 | `{ userId, role }`（NONE=拒之门外；DELETE 行=恢复继承） | ADMIN+ |
| DELETE 同路径 `?userId=` | 删该用户 ACL 行=恢复工作区角色继承（**契约修订 2026-09-04：M3-A 实现发现 §3.3 缺 DELETE 行，规格补齐**） | ADMIN+ |

### 3.4 内容（核心同步面）

| 方法 路径 | 语义 | 权限 |
|---|---|---|
| GET `/api/v1/workspaces/{id}/tree` | `200 { workspaceId, rootVersion, files: [{ path, hash(sha-256 hex), version, size }], projects: [{ id, name, path, myRole }] }`——path 为相对工作区根的 `/` 分隔路径；projects.path 为该项目的目录相对路径（**契约修订 2026-09-03：M3-B 审查发现同名项目按 name 匹配会张冠李戴，客户端权限判定需 path 定位**）；无读权限的项目子树整体不出现 | 有效角色（NONE 项目过滤） |
| GET `/api/v1/workspaces/{id}/files?paths=a,b` | `200 { files: [{ path, content(文本), version, hash }], missing: [path] }`（≤200 路径/批） | 同上（任一路径无读权 → 该路径进 missing） |
| PUT `/api/v1/workspaces/{id}/files/{path}` | `{ content, baseVersion }`（新文件 baseVersion=0）→ `201 { path, version, hash }`；baseVersion 不匹配 → `409 { code: version_conflict, currentVersion, currentHash }` | EDITOR+（路径落入 NONE 项目 → 403 project_forbidden） |
| POST `/api/v1/workspaces/{id}/files/batch` | `{ files: [{ path, content, baseVersion }] }` ≤200 → `200 { results: [{ path, status: pushed\|conflict\|forbidden\|invalid, version?, currentVersion?, message? }] }`（部分成功语义，迁移与推送用） | EDITOR+ |
| DELETE `/api/v1/workspaces/{id}/files/{path}?baseVersion=` | 同 PUT 并发语义 → `204` | EDITOR+ |

path 规则：禁止 `..`、绝对路径、反斜杠、空段；`apicc.workspace.yaml` 仅 ADMIN+ 可写（防止 VIEWER 提权面——虽然 VIEWER 本来不可写，此处约束 ADMIN+ 是防止未来非 owner 编辑根配置产生歧义）。

### 3.5 服务端配置（application.yml）

`apicc.server.data-dir`（默认 `./server-data`）、`apicc.server.allow-registration`（默认 true）、`apicc.server.token-ttl-days`（默认 30）、H2 JDBC URL 指向 data-dir 下 `metadata` 库。健康探测：GET `/api/v1/ping` → `200 { status: "ok" }`（无认证，供联调与 CI 就绪探测）。

---

## 4. 子项目划分（契约优先，A/B 并行；C 在 A/B 合并后联调）

### 轨 1 — M3-A 服务端（`server/`，分支 `feature/m3-server`，worktree `apicc-m3-server`）

T1 骨架与测试基建（pom+settings+Boot 应用+ping+H2 schema 初始化+首个 MockMvc 测试）→ T2 域与存储（6 张表 + JdbcTemplate 仓储 + 单测）→ T3 认证 API → T4 工作区/成员/项目 ACL API 与权限判定服务 → T5 内容 API（tree/files/batch/乐观并发/权限过滤/落盘回滚）。基线 = 新包，无既有 Java 代码；每任务 `mvn -s server/.mvn/settings.xml test` 全绿推进。

### 轨 2 — M3-B 桌面端在线模式（分支 `feature/m3-online`，worktree `apicc-m3-online`）

T1 onlineClient（契约实现 + token 管理 + safeStorage）+ 类型契约 + 内存替身 → T2 onlineStore + 登录/服务器配置 UI → T3 在线工作区浏览/编辑推送/迁移 + 模式切换 + i18n。对 §3 契约开发，替身与契约测试钉住载荷形状；不依赖服务端代码存在。

### 轨 3 — M3-C 联调与工程化（A/B 合并后，分支 `feature/m3-integration`）

T1 端到端：脚本起服务端 → API 冒烟（注册→建区→推送→拉取→冲突）→ 桌面端 onlineClient 对真服务端的集成测试 → T2 CI 增 Java job（setup-java temurin 21 + settings.xml + mvn test）+ `server/README.md` 运行文档。

### 冲突面分析

轨 1 只动 `server/`；轨 2 只动 `apps/desktop` 与 `packages/core` 类型导出（如需共享 DTO 形状以 zod schema 落在 desktop shared，不动 core 则更佳——裁定：**契约 schema 全部落在 `apps/desktop/src/shared/online/`，不触碰 packages/core**，消除与轨 1 之外的重叠）。轨 3 只动 `.github`、脚本、`server/README.md`。A/B 并行无共享文件；契约漂移风险由 §3 的精确契约 + 双方契约测试对齐，C 轨兜底。

---

## 5. 验收

1. A/B 各自任务级 TDD + 终审闭环 + 全量门禁绿。
2. 合并后 main：TS 三包全绿 + `mvn -s server/.mvn/settings.xml test` 绿 + 打包冒烟过。
3. M3-C 端到端：真服务端上完成「注册两个用户 → 建 workspace → 第三用户 VIEWER 只读校验 → 推送/拉取/冲突 → 桌面端 onlineClient 集成测试」全链路。
4. 文档：`server/README.md` 含启动、配置、默认端口（8080）、数据目录说明。
