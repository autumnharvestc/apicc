# apicc M4 设计规格：管理后台（Vue Web 控制台）

日期：2026-09-05
状态：已批准（用户指示「开始 M4」；原始需求：后台管理为 web 端、Vue 实现；UI 风格 ant design）
上游：M3 规格（`2026-09-03-apicc-m3-collab-design.md`——§3 全部管理 API 已实现并经 CI 验证）、M1 规格（§3.2「管理后台（M4）」）

---

## 1. 背景与目标

M3 交付了自托管服务端与桌面端在线模式，但工作区/成员/项目 ACL 的管理只能靠 API 调用。M4 交付**浏览器可用的管理后台**：管理员登录后完成用户角色管理与项目访问权限管理（原始需求点名的两件事），无需碰任何配置文件。

### M4 成功标准

自托管者把控制台静态产物放到服务端旁（或开发模式直连），浏览器打开 → 登录 → 看到工作区列表 → 管理成员角色（含 OWNER 转让）、按项目配 ACL（NONE 拒绝/恢复继承）——全程零 API 手工调用。

### 非目标

桌面端在线模式的功能变更（M3 已交付的保持不动）、服务端 API 变更（M4 只消费 §3 既有契约，**零后端行为变更**——服务端唯一新增是静态文件托管）、实时在线状态、审计日志、暗色主题切换（沿用 antd 默认亮色）。

---

## 2. 关键决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | 形态与位置 | monorepo 新工作区包 `apps/admin-web`（Vue 3 + Vite SPA）；工具链与桌面端同版（vue ^3.5、vite ^8.2、vitest ^4.1、ant-design-vue ^4.2、pinia ^4、vue-i18n ^11、zod ^4.5、TS ^5.9） |
| D2 | 部署模型 | **服务端托管静态产物**：Spring Boot 以可配置目录 `apicc.server.console-dir`（默认 `./console`，即与 server-data 同级）对外提供 SPA；自托管流程 = `pnpm -C apps/admin-web build` → 把 `dist/` 放到 jar 运行目录的 `console/` 下。目录缺失时 `/` 返回带引导文案的 404 JSON |
| D3 | SPA 路由回退 | 非 `/api/**` 且非静态资源命中的 GET → forward 到 `/index.html`（MVC 资源处理器 + SPA fallback）；`/api/**` 行为完全不受影响。静态端点不要求认证（AuthFilter 本就只拦 `/api/v1/**`），API 调用仍走 Bearer token |
| D4 | 认证与会话 | 复用 M3 契约（register/login/logout/me）；token 存 localStorage（Web 场景无 safeStorage）；axios？——不引新 HTTP 库，**原生 fetch 封装**（与 desktop onlineClient 同构风格：401 → 清会话回登录页、错误统一 `{code,message}`） |
| D5 | 页面集（MVP） | ①登录/注册（双 tab）②布局壳（侧栏导航 + 当前用户 + 登出）③工作区列表/创建/删除（OWNER 删除有确认）④成员管理（列表/添加成员并赋角色/改角色/移除/OWNER 转让确认——转让是 OWNER 专属且不可逆，需输入工作区名确认）⑤项目 ACL（项目清单来自 tree.projects；按用户行编辑角色，NONE=拒之门外，删除行=恢复继承——「NONE」与「继承」的语义区分必须在 UI 文案中显式呈现） |
| D6 | 权限驱动的 UI | 前端按 myRole 禁用不可用操作（VIEWER 只读视图、非 ADMIN 隐藏成员/ACL 入口），但**以后端 403 为准**——前端隐藏只是体验层；契约 zod schema 与载荷形状对齐 M3 §3（含五次契约修订） |
| D7 | 测试门禁 | admin-web：vitest（store/组件/契约 fixture，jsdom；与 desktop 同模式——mock fetch 替身）；server：静态托管与 SPA fallback 的 MockMvc 契约测试；联调：真服务端 + 构建产物冒烟（起 jar + console 产物 → HTTP 断言 / 与 /api/v1/ping）并入 M4-A 最后任务 |
| D8 | i18n | zh/en 成对（vue-i18n，沿用桌面端 `zh-CN.json/en.json` 扁平命名空间模式）；组件零内联文案 |

### 不变量

品牌中立（新包零竞品名）；中文 conventional commit；显式路径 git add；`com.autumnharvestc` / `@apicc`；服务端零行为变更（除 D2/D3 的静态托管）。

---

## 3. 子项目划分（两轨并行，文件面零重叠）

### 轨 1 — M4-A 管理控制台应用（`apps/admin-web`，分支 `feature/m4-console`，worktree `apicc-m4-console`）

T1 包脚手架 + API 客户端 + 契约 schema（zod，对齐 M3 §3 含五次修订）+ fetch 替身 + 测试基建 → T2 认证（登录/注册/token 会话/路由守卫/me）→ T3 布局壳 + 工作区列表/创建/删除 → T4 成员管理 → T5 项目 ACL + 装配收口 + 构建管线（`build` = vue-tsc + vite build）。每任务门禁 = admin-web 全量 + typecheck。

### 轨 2 — M4-B 服务端静态托管（`server/`，分支 `feature/m4-static`，worktree `apicc-m4-static`）

T1 静态托管：`apicc.server.console-dir` 配置、资源处理器 + SPA fallback（`/` 与未命中路径 → index.html；`/api/**` 不受影响；console 目录缺失 → 404 JSON 带引导文案）、MockMvc 测试（文件存在/缺失/SPA 回退/API 不受扰四组）→ T2 server/README 部署章节 + 根 README 一行。服务端零 API 变更。

### 冲突面分析

轨 1 只动 `apps/admin-web`（新建）与 `pnpm-lock.yaml`（新依赖——与轨 2 无冲突，若并发提交 lockfile 冲突由控制者合并时重装生成）；轨 2 只动 `server/` 与 README。M4 合并后无需独立联调轨：轨 1 T5 的真服务端冒烟即承担 M3-C 式端到端验证（控制台产物 vs 真服务端）。

---

## 4. 验收

1. 两轨各自 TDD 闭环 + 终审 + 全量门禁绿（轨 1 含 `pnpm -C apps/admin-web build` 成功；轨 2 含 mvn test 绿）。
2. 合并后 main：既有四包测试全绿 + admin-web 测试绿 + mvn test 绿 + 打包冒烟过（desktop 不受扰）。
3. 端到端（轨 1 T5）：真服务端 + 控制台构建产物 → 注册/登录/建区/改角色/配 ACL 的 HTTP 级冒烟全过。
4. CI：pnpm -r test 自动纳入 admin-web（workspace 包），无需改 workflow。
