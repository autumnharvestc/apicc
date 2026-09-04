# apicc M3-B 桌面端在线模式实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 桌面端在线模式 MVP：服务器配置与登录 → 在线工作区列表 → 打开在线工作区（树浏览按角色只读/可编辑、接口编辑与推送带 409 冲突提示）→ 迁移（在线拉取到本地 / 本地推送到在线）→ 本地/在线工作区上下文切换（顶栏可辨标识）。对规格 §3 API 契约开发，**不依赖服务端代码存在**（契约 schema + 内存替身钉住载荷）。

**架构：** `shared/online/`（契约 zod schema + DTO 类型）、main 进程 `main/online/`（undici 客户端 + token 安全存储 + IPC 频道 `online:*`）、渲染层 `stores/online.ts` + 组件（登录/服务器配置、在线工作区列表、迁移向导）；在线工作区树复用侧树 TreeNodeDTO 映射；调试/运行边界 = 在线工作区先拉取到本地（UI 引导，不实现远程执行）。

**技术栈：** 既有栈 + undici（desktop 已有依赖链，若未直依赖则新增 dependencies）；Electron safeStorage（token 存储，不可用时降级明文 + console.warn）。

**工作目录：** `D:\workspace260609\project-2\apicc-m3-online`（worktree，分支 `feature/m3-online`）。**基线：main @ 1510af8（core 203 / cli 26 / desktop 278 全绿）。**

**全局约束：** 品牌中立；中文 conventional commit（`feat(desktop): ...`）；显式路径 git add；门禁 = desktop typecheck 双跑 + desktop 全量 + core 全量；IPC channels 单源 + zod 校验 + memory 替身同构 + 深拷贝；组件内零工厂调用；i18n zh/en 成对零内联中文；**不触碰 packages/core**（契约 schema 全部落 `apps/desktop/src/shared/online/`）。

---

## 文件结构

```
apps/desktop/src/
  shared/online/contract.ts      ← §3 契约 zod schema（Auth/Workspace/Tree/File 载荷与错误形状）
  shared/online/types.ts         ← OnlineWorkspaceSummary/OnlineTreeNode 等渲染层 DTO
  shared/channels.ts、types.ts   ← 增 online:* 频道与 ApiccApi 方法
  main/online/client.ts          ← undici 封装：baseUrl+token、统一错误 {code,message}、超时
  main/online/tokenStore.ts      ← safeStorage 加密存取（不可用降级明文 + warn）
  main/online/session.ts         ← online 会话（登录态/当前在线工作区/树缓存）
  main/ipc.ts、preload、renderer/src/api/memory.ts ← 同步
  renderer/src/stores/online.ts  ← 工厂 store：服务器档案/登录态/工作区列表/在线树/迁移进度
  renderer/src/components/OnlineLoginDialog.vue、OnlineWorkspaceList.vue、OnlineMigrateDialog.vue
  renderer/src/App.vue、SideTree.vue、TopBar.vue ← 在线上下文装配（只读态/标识/切换）
  i18n zh/en                     ← online.* 命名空间
```

---

### 任务 1：契约 schema 与 onlineClient（main 进程）

- [ ] **步骤 1：失败的测试**——①契约 schema：对规格 §3 各端点的成功/错误载荷 fixture 做 parse 往返（register/login/tree/files/PUT/batch/错误 `{code,message}`/409 `version_conflict` 形状）；②client（注入假 fetch）：请求方法/路径/JSON 体/Authorization 头拼装正确；401 → 会话失效事件；409 → 冲突对象原样上抛；网络错误 → 统一 `network_error` 码；③tokenStore：safeStorage 可用/不可用两路（注入替身）。
- [ ] **步骤 2：实现**——contract.ts 逐端点 schema（响应先 safeParse 再出口，形状不符 → `protocol_error`）；client 方法面向用例（`register/login/logout/me/listWorkspaces/createWorkspace/getTree/getFiles/putFile/batchPush/deleteFile/manageMembers/manageAcl`）；超时默认 15s；tokenStore 用 safeStorage（`isEncryptionAvailable()` 判断）；online 会话串联（登录 → 存 token → 请求自动带头）。
- [ ] **步骤 3：门禁 + Commit** `feat(desktop): 在线契约 schema 与 onlineClient（token 安全存储）`

### 任务 2：onlineStore 与登录/服务器配置 UI

- [ ] **步骤 1：失败的测试**——①store 工厂隔离（先例）；②服务器档案（url 昵称）增删改持久化到本地配置（经 IPC 存 session 侧或 localStorage——按既有偏好存储模式选，报告注明）；③登录流程：login 成功 → token 入 store、失败 → error 通道且不清旧态；④登出 → 204 + 清态；⑤OnlineLoginDialog 组件：表单校验（url 形态/用户名密码必填）、提交调 store、错误上屏。
- [ ] **步骤 2：实现**——stores/online.ts（工厂，显式注入 onlineApi）；OnlineLoginDialog.vue + 服务器档案管理；App.vue 入口（TopBar 或侧树空态——按既有布局选低侵入点，报告注明）；i18n `online.*`。
- [ ] **步骤 3：门禁 + Commit** `feat(desktop): 在线登录与服务器配置`

### 任务 3：在线工作区浏览/编辑/迁移与模式切换（装配收口）

- [ ] **步骤 1：失败的测试**——①打开在线工作区 → getTree → 侧树按 TreeNodeDTO 映射渲染（无权项目不出现）；VIEWER 只读态（编辑器禁用/无保存钮）vs EDITOR 可编辑；②保存接口定义 → putFile（带 baseVersion）→ 成功提示；409 → 冲突对话框（显示服务端更新时间/版本，选项：拉取覆盖我的/放弃）；③迁移-拉取：进度 + 结果清单（新拉/更新/跳过计数），落到本地目录选择；④迁移-推送：本地工作区列表/目录选择 → 先取服务端 tree 比对 → 差异 batch → 结果清单（冲突默认跳过列出）；⑤模式切换：本地 ↔ 在线工作区上下文互斥，顶栏标识当前模式；⑥关闭在线工作区 → 会话清理（树缓存/编辑缓冲）。
- [ ] **步骤 2：实现**——main/online/session.ts（当前在线工作区状态 + 树缓存 + 文件内容缓存）；编辑复用既有编辑器（api:get 的在线版 = getFiles 取单文件解析为接口定义——**只读字段按 ApiDefinition schema 校验，坏数据进 problems 不崩**）；保存 = 序列化回文本 putFile；迁移向导 OnlineMigrateDialog.vue；TopBar 模式标识；SideTree 只读装饰（VIEWER 角色标签）。装配测试 + 全量回归 + 打包冒烟（gen:icon → dist:dir → smoke:dir）。
- [ ] **步骤 3：Commit** `feat(desktop): 在线工作区浏览/编辑推送/迁移与模式切换`

---

## 规格覆盖对照

| 规格（m3 spec §2/§3） | 任务 |
|---|---|
| D9 桌面端集成（client/token） | 1 |
| D9 登录/服务器配置 | 2 |
| D9 浏览/编辑/冲突/迁移/模式切换 | 3 |
| D8 同步协议（客户端侧） | 3 |
| §3 契约（客户端实现面） | 1–3 |

**明确推迟**：远程调试/运行执行、实时协同、离线队列自动重推、多人编辑锁定提示。
