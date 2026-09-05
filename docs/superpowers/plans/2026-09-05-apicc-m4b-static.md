# apicc M4-B 服务端静态托管实现计划

> **面向 AI 代理的工作者：** 必需子技能：subagent-driven-development 或 executing-plans。

**目标：** Spring Boot 托管管理后台 SPA 静态产物：可配置目录 + SPA 路由回退；`/api/**` 行为零变更。自托管单 jar 即可同时服务 API 与控制台。

**工作目录：** `D:\workspace260609\project-2\apicc-m4-static`（worktree，分支 `feature/m4-static`）。**基线：main @ 537c3e5（mvn 128/128）。**

**环境硬约束：** JAVA_HOME 显式 `/c/Program Files/Java/jdk-21.0.12`；mvn `"/d/IDE/JetBrains/IntelliJ IDEA 2023.1.2/plugins/maven/lib/maven3/bin/mvn"`；命令带 `-s server/.mvn/settings.xml`。

**全局约束：** 品牌中立；中文 conventional commit（`feat(server): ...`）；服务端 API 行为零变更；AuthFilter 保护面不变（仅 `/api/v1/**`）。

---

### 任务 1：静态托管与 SPA 回退

- [ ] **步骤 1：失败的测试**（MockMvc，`@TempDir` 注入 console-dir）
  1. console 目录含 `index.html` → GET `/` → 200 content-type text/html、内容为该文件；GET `/workspaces`（SPA 深链，无对应文件）→ 200 index.html（fallback）；GET `/assets/app.js`（存在的静态文件）→ 200 原文件。
  2. `/api/v1/ping` → 200 JSON 不受扰（静态托管存在时）；`/api/v1/workspaces` 未认证 → 401（保护面不变）。
  3. console 目录缺失/为空 → GET `/` → 404 `{code:"console_not_found", message 含引导}`（指引构建 admin-web 并放置）；SPA 深链同样 404 引导。
  4. 以 `..` 等路径穿越探测静态解析 → 不逃逸 console 目录（404/400）。
- [ ] **步骤 2：实现**
  - 配置 `apicc.server.console-dir`（默认 `./console`，application.yml + @Value 注入，风格对齐既有 `apicc.server.*`）。
  - `WebMvcConfigurer`：`resourceChain` 资源处理器映射 `/**` 指向 `file:{console-dir}/`；SPA fallback 用低优先级 Controller 或 `addResourceHandlers` + view controller：非 `/api/**`、非含扩展名的未命中 GET → forward `/index.html`（存在时）；`/` 直接映射 index.html。
  - 目录缺失 → 不注册资源处理器（或注册空 fallback），404 走 GlobalExceptionHandler 增 `console_not_found` 映射（NoResourceFoundException 在 console 场景下的引导文案——注意既有 404 not_found 语义别被破坏：/api 面保持 not_found，非 /api 面且 console 缺失 → console_not_found）。
- [ ] **步骤 3：mvn test 全绿 + Commit** `feat(server): 管理后台静态托管与 SPA 回退`

### 任务 2：部署文档

- [ ] **步骤 1：核对清单**——server/README 增「管理后台部署」节：构建（`pnpm -C apps/admin-web install && pnpm -C apps/admin-web build`）、放置（dist/* → jar 运行目录 `console/`）、配置项（console-dir）、开发模式替代方案（vite dev 代理 `/api` 到本地服务端——与 admin-web 的 vite proxy 约定对齐，报告注明端口）；根 README 特性列表补「Web 管理后台」一行。
- [ ] **步骤 2：Commit** `docs(server): 管理后台部署指南`

---

## 规格覆盖对照

| 规格（m4 spec §2/§3） | 任务 |
|---|---|
| D2 部署模型（console-dir） | 1、2 |
| D3 SPA 回退 + /api 不受扰 | 1 |
| D7 测试门禁（server 侧） | 1 |
| 不变量（零 API 变更/品牌中立） | 全部 |

**明确推迟**：控制台产物打进 jar（保持产物外置，自托管灵活更新）、gzip/缓存头调优、HTTPS/反代文档（自托管者自备）。
