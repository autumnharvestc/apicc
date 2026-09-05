# apicc M4-A 管理控制台应用实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 浏览器管理后台 SPA：登录/注册 → 工作区管理 → 成员角色管理 → 项目 ACL 管理。消费 M3 §3 既有契约，零后端变更。

**架构：** `apps/admin-web`——Vite + Vue 3 + TS + vue-router + pinia + ant-design-vue ^4 + vue-i18n + zod。分层：`src/api/`（fetch 封装 + 契约 zod + 类型）、`src/stores/`（会话/工作区工厂 store）、`src/views/`（Login/Layout/Workspaces/Members/ProjectAcl）、`src/i18n/`。token 存 localStorage，401 全局拦截回登录页。

**工作目录：** `D:\workspace260609\project-2\apicc-m4-console`（worktree，分支 `feature/m4-console`）。**基线：main @ 537c3e5（CI 四 job 全绿）。**

**环境注意：** worktree 需先 `pnpm install`；desktop 的 electron 二进制不在本轨依赖面（admin-web 纯 web，vitest jsdom 即可）。

**全局约束：** 品牌中立；中文 conventional commit（`feat(admin): ...`）；显式路径 git add；门禁 = admin-web typecheck（vue-tsc 双 tsconfig 同 desktop 模式）+ admin-web 全量 vitest；i18n zh/en 成对零内联中文；组件内零工厂调用（store 由装配层注入——沿用 desktop 先例）；契约 fixture 逐字对齐 M3 规格 §3（含五次修订：projects.path、ACL DELETE、batch failed、禁冒号、projectId 规则——管理页面用到其中 path/ACL DELETE 语义）。

---

## 文件结构

```
apps/admin-web/
  package.json、vite.config.ts、vitest.config.ts、tsconfig.json、tsconfig.node.json
  index.html
  src/
    main.ts、App.vue、router/index.ts
    api/client.ts        ← fetch 封装（baseUrl 可配、Bearer、401 拦截、{code,message} 归一）
    api/contract.ts      ← §3 契约 zod schema + 类型（管理面所需端点）
    stores/session.ts    ← 登录态工厂（token/localStorage、user、login/register/logout）
    stores/workspaces.ts ← 工作区清单/成员/ACL 工厂
    views/LoginView.vue、LayoutView.vue、WorkspacesView.vue、MembersView.vue、ProjectAclView.vue
    i18n/zh-CN.json、en.json
  tests/                 ← 契约/客户端/store/组件测试（mock fetch，jsdom）
```

---

### 任务 1：脚手架 + API 客户端与契约

- [ ] **步骤 1：失败的测试**——①契约 schema：对 §3 管理面端点（auth 四端点、workspaces CRUD、members 三端点、projects acl 三端点、tree）的成功/错误 fixture parse 往返（fixture 从规格 §3 表格构造，409/403 错误形状 `{code,message}`）；②client（注入 fetch 替身）：请求拼装（路径/Bearer 头/JSON 体）、401 → 会话失效回调、错误归一、超时；③vite/vitest/typecheck 管线跑通（一个最小 App 挂载测试证明装配 OK）。
- [ ] **步骤 2：实现**——包脚手架（依赖版本与桌面端对齐，见规格 D1 清单）；client.ts（baseUrl 默认同源 `/api/v1`，可配置用于开发代理）；contract.ts 管理面子集；vitest 配置（jsdom 环境）。
- [ ] **步骤 3：Commit** `feat(admin): 控制台脚手架与 API 客户端契约层`

### 任务 2：认证会话

- [ ] **步骤 1：失败的测试**——①session store 工厂隔离；login 成功 → token 入 localStorage + user 态；失败 → error 通道不清旧态（沿用 desktop 语义）；logout → 清态留服务器档案？——Web 版无多服务器档案（MVP：单服务器 = 同源），登出仅清会话；②register（同页 tab）；③路由守卫：未登录访问受保护路由 → 重定向 /login（含回到原目标）；401 拦截 → 清会话 + 跳登录。
- [ ] **步骤 2：实现**——stores/session.ts、LoginView（登录/注册 a-tabs、表单校验：用户名 3-32 `[a-zA-Z0-9_-]`、密码 ≥8）、router 守卫、client 401 钩子接线。
- [ ] **步骤 3：Commit** `feat(admin): 登录注册与会话路由守卫`

### 任务 3：布局壳与工作区管理

- [ ] **步骤 1：失败的测试**——①Layout：侧栏导航（工作区/成员/ACL 入口按角色显隐——非 ADMIN 隐藏管理项）、顶栏当前用户 + 登出；②WorkspacesView：列表（id/name/myRole/createdAt）、创建（a-modal 表单）、删除（仅 OWNER 可见 + a-popconfirm 输入工作区名确认——不可逆操作）；③myRole 驱动的入口禁用。
- [ ] **步骤 2：实现**——LayoutView、WorkspacesView、stores/workspaces.ts（清单/创建/删除 + loading/error 通道）。
- [ ] **步骤 3：Commit** `feat(admin): 布局壳与工作区管理`

### 任务 4：成员管理

- [ ] **步骤 1：失败的测试**——①MembersView：列表（userId/username/displayName/role）、添加成员（输入 userId/用户名 + 选角色——§3.2 PUT members 对非成员即创建）、改角色（下拉即改，OWNER 行禁用）、移除（popconfirm，OWNER 行禁用）；②OWNER 转让：把他人设为 OWNER 时弹确认对话框（输入工作区名确认，文案说明自身将降为 ADMIN 且不可逆）；③403（非 ADMIN 直达 URL）→ 错误通道 + 回列表。
- [ ] **步骤 2：实现**——MembersView + store 扩展（members 清单/赋角色/移除/转让语义封装——转让 = PUT role OWNER 单调用，前端仅加确认）。
- [ ] **步骤 3：Commit** `feat(admin): 成员与角色管理`

### 任务 5：项目 ACL + 装配收口（含真服务端冒烟）

- [ ] **步骤 1：失败的测试**——①ProjectAclView：选工作区 → tree.projects 清单（展示 path/myRole）→ 选项目 → ACL 行表（userId/role）；按用户设角色（NONE=拒之门外）、删除行=恢复继承（两种操作的 UI 区分必须显式：NONE 是「明确拒绝」，删行是「回到工作区继承」——i18n 文案审校点）；②ACL 行的 userId 从成员列表下拉选择 + 支持手输非成员 userId（D5 语义：ACL 可预设）；③装配回归：五视图路由可达、守卫行为、i18n 键 zh/en parity。
- [ ] **步骤 2：实现**——ProjectAclView + store 扩展（tree 拉取缓存/acl 清单/设角色/删行）；`pnpm build`（vue-tsc + vite build）产出 dist 供部署。
- [ ] **步骤 3：真服务端冒烟**——仿 desktop e2e 模式（单文件集成测试，可复用其 runCommand 工具的思路）：起 jar + `vite preview` 或直接对 API 的 HTTP 冒烟（注册→登录→建区→改角色→设 ACL→删行恢复继承）+ 控制台产物 `dist/index.html` 被 server 托管后 `/` 200（依赖轨 2 合并；未合并前以本地 `console-dir` 指向 dist 验证并在报告注明）。Commit：`feat(admin): 项目 ACL 管理与装配收口` + `test(admin): 真服务端管理链路冒烟`。

---

## 规格覆盖对照

| 规格（m4 spec §2/§3） | 任务 |
|---|---|
| D1 形态/工具链 | 1 |
| D4 认证与会话 | 2 |
| D5 页面①②③ | 2、3 |
| D5 页面④（成员/转让） | 4 |
| D5 页面⑤（ACL/NONE vs 继承语义） | 5 |
| D6 权限驱动 UI | 3、4、5 |
| D7 测试门禁（admin 侧） | 全部 |
| D8 i18n | 全部 |

**明确推迟**：只读树浏览器（内容浏览走桌面端）、暗色主题、审计日志、批量操作。
