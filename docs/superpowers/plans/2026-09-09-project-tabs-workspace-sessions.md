# 项目页签栏与工作区会话化（计划 C）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 桌面端顶栏项目页签栏——本地 1 + 在线 N 工作区并存驻留，跨工作区切换项目（各自保留状态与草稿），关签=项目关闭（dirty 须确认），退出程序 dirty 确认，重启按签恢复。

**架构：** 主进程 online 会话表化（`Map<workspaceId, {workspaceState, treeCache}>` + 活跃指针）；渲染层 online store 同构表化；新增渲染层 tabs store（签注册表 + 激活编排 + localStorage 持久化）；本地 editor store 会话表化（`Map<apiId, 会话>`）；debug.result 按 apiId 表化；顶栏第二行新增 ProjectTabs 组件；App.vue 启动恢复改为按签重建；main 进程新增退出 dirty 拦截。服务端零改动。

**技术栈：** Electron（main/preload/renderer IPC）、Vue 3 + Pinia、vitest jsdom 全挂载 harness。

**环境约束：**
- desktop 测试：worktree 根 `pnpm install`（fresh）→ `pnpm --filter @apicc/desktop test`；typecheck `pnpm --filter @apicc/desktop typecheck`；e2e-server 需真服（归收尾任务）。
- 写代码禁用 heredoc；块注释内禁「星号斜杠」；提交信息中文。

**规格勘误（实现口径以此为准，已获控制者裁定）：**
- 规格原文「workflowDesign 已是按 workflowId 的会话表」**与实际不符**——它是单会话（stores/workflowDesign.ts:18-124，且切流已有 dirty 确认 App.vue:320-347）。本轮口径：workflowDesign **维持单会话**，其 dirty 确认扩展覆盖「切项目签」与「关签」（有草稿时弹既有 ConfirmDialog 确认）；工作流设计器草稿驻留**不在本轮**（与规格「明确不做」的接口级页签同批延后）。终审报告须向用户披露此偏差。

**全局不变量（每任务审查透镜）：**
1. **项目选中即成签**：无论侧树点项目、主页卡片点项目，统一走 tabs store 的 `openProjectTab`（已存在则仅激活）——不存在「选中项目但不入签」的状态。
2. **切签免确认、草稿驻留**：api 编辑器草稿按 apiId 会话驻留，切签/切工作区零丢失零确认；workflowDesign 单会话例外（有草稿时切换弹确认，规格勘误）。
3. **关签=项目关闭**：驱逐该项目的 editor 会话（本地）与 online 编辑缓冲（在线）；有未保存修改 → 确认弹窗；无 → 直接关。
4. **工作区驻留**：本地会话不动（单例即驻留）；在线会话入表驻留；某工作区全部签关后工作区保持在后台驻留（在线 TopBar 工作区名保留）。工作区级关闭唯一入口=退出在线工作区按钮（新增确认弹窗列出受影响项目数）。
5. **持久化只记签结构**（`apicc.projectTabs`：`{tabs:[{workspaceRef,projectId}], activeIndex}`，workspaceRef=`{kind:"local",dir}|{kind:"online",workspaceId,name}`）；草稿不落盘；启动按签重建（本地重开目录、在线 resume+token 验证，失败签标记离线不可激活）。
6. **退出程序 dirty 拦截**：main 进程窗口 close → preventDefault → 询问渲染层任一 editor/workflowDesign/online 缓冲 dirty → 有则 main `dialog.showMessageBox` 确认 → 确认才销毁。
7. **既有单槽测试的改写口径**：凡断言「openWorkspace 覆盖上一工作区」「切接口清压测/编辑器」的用例，按新语义重写而非删除；`tests/main/online/session-workspace.test.ts:104-115` 的覆盖式切换用例重写为表语义。
8. **禁碰**：desktop `main/session.ts` 本地单例（本地并发=1 是规格形态，本计划不加表）；服务端零改动。

---

### 任务 1：主进程 online 会话表化（本地 1+在线 N 的 N 侧地基）

**文件：**
- 修改：`apps/desktop/src/main/online/session.ts`（单槽 `workspaceState`/`treeCache` :205-206 → 表 + 活跃指针；`openWorkspace` :253-256 入表激活；`closeWorkspace` :259-262 支持带 id 出表/无参关活跃；`requireWorkspace` :208-211 查表；`activateWorkspace(id)` 新增=纯切指针；`getTreeView` :270-286 按活跃指针取缓存；logout :332-341 清全表）
- 修改：`apps/desktop/src/main/ipc.ts`（`online:workspace:open` :619-630 失败回滚改「仅当表空才回滚」；`online:workspace:close` :631-633 载荷可带 workspaceId；新增 `online:workspace:activate` 通道）
- 修改：`apps/desktop/src/shared/channels.ts` :41-65（通道清单补 activate；close 载荷形状）
- 修改：`apps/desktop/src/preload/preload.ts`（对应 API 面）
- 修改：`apps/desktop/src/renderer/src/api/memory.ts`（替身 :1054-1063 单槽 `onlineWs` 改表语义：open 入表、activate 切换、close 按 id）
- 测试：`apps/desktop/tests/main/online/session-workspace.test.ts`（:75-165 重写为表语义：入表/激活/出表/树缓存按工作区隔离/未登录拒绝）；`tests/main/online/ipc-online-ws.test.ts`（activate 通道 + close 带 id）

- [ ] **步骤 1：按上述表语义改 session.ts + IPC + preload + 替身（先改测试红→实现绿）**

会话表核心形状：

```ts
interface OnlineWorkspaceSession {
  workspaceState: OnlineWorkspaceState;
  treeCache: { tree: OnlineTreeNode[]; groups: OnlineGroup[] } | null;
}
let sessions = new Map<string, OnlineWorkspaceSession>(); // key = workspaceState.id
let activeId: string | null = null;
```

- `openWorkspace(input)`：入表（已存在则更新 workspaceState）+ 置活跃 + 清该工作区树缓存；`activateWorkspace(id)`：表中有且已登录才切活跃，否则抛既有「尚未打开在线工作区」口径错误；`closeWorkspace(id?)`：无参关活跃、有关则按 id 出表；出表后活跃指针若指向被关工作区则置 null（**不自动切到其他驻留工作区**——切换只由 activate 显式驱动）；`requireWorkspace(id)`：id 必须等于活跃工作区 id（防跨工作区误写，语义不变）；`logout` 清表。
- IPC `online:workspace:activate`：载荷 `{workspaceId}`，转发 activateWorkspace；`online:workspace:close` 载荷改 `{workspaceId?}`。
- 替身 memory.ts 的 `onlineWs` 单值改 `Map` + 活跃 id，`onlineWorkspaceOpen/Activate/Close/TreeView` 语义与主进程一致。

- [ ] **步骤 2：desktop 单测绿（session-workspace/ipc-online-ws 重写用例）+ typecheck**
- [ ] **步骤 3：Commit** `feat(desktop): 主进程 online 会话表化——工作区驻留与显式激活`

---

### 任务 2：渲染层 online store 表化 + 互斥清场退役

**文件：**
- 修改：`apps/desktop/src/renderer/src/stores/online.ts`（`activeWorkspace` :89 与 onlineTree :91、projects :93 改为 `sessions: Map<id,{workspace, tree, projects}>` + `activeWorkspaceId` getter/computed 兼容旧名；编辑缓冲 :95-102 表化为 `Map<workspaceId, 缓冲>`，活跃缓冲随 activeWorkspaceId；`openWorkspace` :317-330 入表不覆盖；新增 `activateWorkspace(id)`（调 IPC activate + 切活跃 + editor 上下文换挡）；`closeWorkspace(id?)` :333-346 出表；`logout` :279-287 全清；`refreshTreeView`/`selectNode`/`saveApi` 走活跃缓冲）
- 修改：`apps/desktop/src/renderer/src/components/OnlineLoginDialog.vue` :126-133（`workspace.reset()` 互斥清场**退役**——开在线工作区不再关本地：本地 1+在线 N 并存是本计划核心；改为 tabs 维度处理，本任务先删该行、由任务 6 接成签联动）
- 修改：`apps/desktop/src/renderer/src/components/HomeView.vue` :280-301（`openLocalDir`/`startCreateLocal` 的 `online.closeWorkspace()` 互斥退役——本地打开不再退在线；同上由 tabs 接管）
- 修改：`apps/desktop/src/main/ipc.ts` :368-383（`ws:open`/`ws:create` 分支内的 `online?.closeWorkspace()` main 侧互斥退役）
- 测试：`tests/renderer/stores/online-workspace.test.ts`（:59-95 单槽语义重写为表语义；:96-217 编辑缓冲按工作区隔离用例）；`tests/renderer/components/onlineWorkspace.test.ts`（:299-333 互斥断言组退役/改写为并存断言）；`tests/main/ipc.test.ts`（ws:open 清理链断言移除）；`tests/renderer/api/memory.ts` 已在任务 1 表化

- [ ] **步骤 1：表化 + 互斥退役（TDD：先重写测试红→实现绿）**

渲染层在线会话形状（与主进程同构）：

```ts
interface OnlineSession {
  workspace: { id: string; name: string; myRole: OnlineRole };
  tree: TreeNodeDTO[];
  projects: OnlineProject[];
  buffer: OnlineBuffer | null; // 编辑缓冲随工作区走
}
sessions: Record<string, OnlineSession>; activeWorkspaceId: string | null;
```

向后兼容面：`activeWorkspace` 保留为 computed（返回活跃 session 的 workspace 或 null）——TopBar/视图层零改动面优先。

- [ ] **步骤 2：desktop 单测绿 + typecheck**
- [ ] **步骤 3：Commit** `feat(desktop): 渲染层 online store 会话表化，本地/在线互斥清场退役`

---

### 任务 3：tabs store——签注册表、激活编排、持久化

**文件：**
- 创建：`apps/desktop/src/renderer/src/stores/tabs.ts`
- 测试：`apps/desktop/tests/renderer/stores/tabs.test.ts`

- [ ] **步骤 1：写失败的 store 测试**（用例清单：成签去重/激活切换编排/关签驱逐/持久化读写/恢复重建含在线 token 失败标记离线）
- [ ] **步骤 2：实现**

```ts
export interface ProjectTab {
  tabId: string;              // tab-<自增>，运行期唯一
  workspaceRef:
    | { kind: "local"; dir: string }
    | { kind: "online"; workspaceId: string; name: string };
  projectId: string;
  projectName: string;
}
state: { tabs: ProjectTab[]; activeTabId: string | null; offlineTabIds: string[] }
```

动作（deps 注入 workspace/online/editor/onlineBuffer 依赖，组件内零工厂调用）：
- `openProjectTab(ref, project)`：同 `workspaceRef+projectId` 已存在 → 仅激活；否则成签置活跃。
- `activateTab(tabId)` 编排：①在线签且未活跃 → `online.activateWorkspace`（失败 → 标记 offlineTabIds、error 上屏、不切换）；②工作区上下文就位后 → 项目选中（本地 `workspace.tree.select("project", id)` / 在线 `online.selectNode` 项目节点）；③editor 上下文由活跃项目驱动（任务 4 接线，本任务留接口 `onProjectActivated` 钩子）。
- `closeTab(tabId)`：**调用方保证 dirty 已确认**（组件层负责）；驱逐该项目的编辑器会话（调 deps.evictProjectSessions(workspaceRef, projectId)——任务 4 实现具体驱逐，本任务留接口）；若关的是活跃签 → 活跃切相邻签（无签则 null → 回主页）。
- `persist()/restore()`：localStorage `apicc.projectTabs`；`restore(deps)` 逐签重建——本地签 `workspace.open(dir)` 失败标记离线；在线签 `online.activateWorkspace`（内部 token 验证）失败标记离线；离线签渲染禁用态可再激活。
- 持久化形状守卫照 `online.ts readPersisted` 先例（损坏降级空签表）。
- **App.test.ts:84 的测试隔离键清单补 `apicc.projectTabs`**。

- [ ] **步骤 3：store 测试绿 + typecheck；Commit** `feat(desktop): tabs store——项目签注册表与激活编排`

---

### 任务 4：编辑器会话表化（本地 editor + 在线缓冲消费 + debug 驻留）

**文件：**
- 修改：`apps/desktop/src/renderer/src/stores/editor.ts`（单会话 :19-24 → `Map<apiId, {api, envs, snapshot}>` + `activeApiId`；`load` 定位/拉取会话槽；`save`/`reloadEnvs` 按槽写；`dirty` 按活跃槽；新增 `evictProject(projectId, apiIds)` 供关签驱逐——本地项目 apiId 集合由 tree 取；保持对外 getters 兼容（`api`/`snapshot` 返回活跃槽，消费者 cases/design/debug 零改动或最小改动））
- 修改：`apps/desktop/src/renderer/src/stores/debug.ts`（`result` :19-28 单值 → `Map<apiId, DebugOutput>`，`send` 写活跃 apiId 槽，消费组件按活跃 apiId 读——App.vue/RequestEditor 取值点适配）
- 修改：`apps/desktop/src/renderer/src/stores/cases.ts` / `stores/design.ts`（经 editor 活跃槽自然兼容，核对即可）
- 修改：`apps/desktop/src/renderer/src/App.vue` :248-253（`watch(editor.apiId) → stress.clear()` 保留——压测会话不驻留，规格外延后）
- 测试：`tests/renderer/stores/editor.test.ts`（既有单会话用例改会话表语义 + 新增跨会话驻留/驱逐用例）；`tests/renderer/stores/debug.test.ts`（结果按 apiId 驻留）

- [ ] **步骤 1：TDD 改写（先重写测试）**
- [ ] **步骤 2：desktop 单测绿 + typecheck；Commit** `feat(desktop): 编辑器会话表化——草稿按 apiId 驻留，debug 结果随签`

---

### 任务 5：ProjectTabs 组件 + TopBar 第二行接入

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/ProjectTabs.vue`
- 修改：`apps/desktop/src/renderer/src/App.vue`（TopBar 下方插 `<ProjectTabs>`；`openProjectFromHome` :367-370 改走 tabs.openProjectTab；启动恢复 :155-202 改 tabs.restore 优先——lastWorkspace 单槽逻辑 :116-131 **退役**（持久化职责移交签表），`apicc.lastWorkspace` 读写删除、`apicc.lastApi` 保留（恢复选中接口按活跃签项目过滤））
- 修改：`apps/desktop/src/renderer/src/components/TopBar.vue`（工作区名区兼容多工作区驻留显示——活跃工作区名即可，现有绑定经 online.activeWorkspace computed 兼容零改动，核对）
- 修改：`apps/desktop/src/renderer/src/components/HomeView.vue`（卡片 @open → openProject 走成签；`visibleProjects` 的 `:active` 高亮改「该项目签存在且激活」）
- 测试：`apps/desktop/tests/renderer/components/projectTabs.test.ts`（渲染/滚动箭头类/激活高亮/关闭钮/离线签禁用）；`tests/renderer/App.test.ts`（:94-116 openLocalDir 助手适配成签链路；恢复用例改签表驱动）

组件要点：`v-for :key` 拼 index 防 path 碰撞；溢出滚动+两侧低对比箭头（仅溢出时显示）；`×` → 若该项目 dirty（editor.dirty 或 workflowDesign.dirty 或活跃 online 缓冲 dirty）弹 ConfirmDialog「未保存的修改将丢弃」确认后 `tabs.closeTab`，无 dirty 直关；激活签高亮；离线签禁用点按重试激活。

- [ ] **步骤 1：TDD；步骤 2：desktop 单测绿 + typecheck；Commit** `feat(desktop): 顶栏项目页签栏——成签/切签/关签确认/离线态`

---

### 任务 6：生命周期收口——退出在线工作区确认、工作流 dirty 联动、退出程序拦截

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/TopBar.vue` :62-68（exitOnline → 新确认 Modal：列受影响项目数（该项目工作区的签数与草稿态）→ 确认后 `tabs.closeWorkspaceTabs(ref)`（关其全部签+驱逐会话）→ `online.closeWorkspace()`）
- 修改：`apps/desktop/src/renderer/src/stores/tabs.ts`（补 `closeWorkspaceTabs(ref)`；activateTab 的编排接 workflowDesign dirty 确认回调——由组件层传入 `confirmWorkflowDraft` 钩子，规格勘误口径）
- 修改：`apps/desktop/src/main/main.ts` :79-81（窗口 close 事件 → `event.preventDefault()` → `ipc` 询问渲染层 dirty（新增通道 `app:dirty-check`，渲染层聚合 editor/workflowDesign/online 活跃缓冲 dirty）→ 有 dirty 则 `dialog.showMessageBox`（确认丢弃/取消）→ `destroy()`；无 dirty 直接放行）
- 修改：`apps/desktop/src/shared/channels.ts` + `preload/preload.ts`（`app:dirty-check` 通道；渲染层注册 handler 的组合根接线）
- 测试：`tests/renderer/components/topBar.test.ts`（退出在线确认弹窗两分支）；`tests/main/main-quit.test.ts`（dirty 拦截：无 dirty 直关/有 dirty 取消不关/确认后关——window close 事件以可控 stub 驱动）；App.test 补「切签工作流草稿确认」用例

- [ ] **步骤 1：TDD；步骤 2：desktop 单测绿 + typecheck；Commit** `feat(desktop): 生命周期收口——工作区级关闭确认与退出程序 dirty 拦截`

---

### 任务 7：全量验证 + 真机打包冒烟

- [ ] **步骤 1：三包全量**（desktop 全量含 e2e-server（先 build server jar）、admin-web、server mvn——本计划零服务端改动，server 跑全量仅为兜底）
- [ ] **步骤 2：真机打包冒烟（打包 CDP，仓库既有四道底线口径）**：本地+在线各开两项目 → 交叉切签草稿驻留 → 关签确认 → 退出在线确认 → 重启签恢复 → 退出程序 dirty 拦截
- [ ] **步骤 3：Commit（如有零星修复）** `test(desktop): 计划 C 全量验证与真机冒烟收尾`

---

## 自检记录

- 规格六节覆盖：并存形态（任务 1/2）、页签栏（任务 3/5）、编辑器会话表化（任务 4）、生命周期（任务 6）、服务端零改动（无任务触碰）、测试口径（各任务测试节 + 任务 7 真机冒烟）。
- 类型一致性：tabs store 的 workspaceRef 形状在任务 3 定义、任务 5/6 消费；`evictProjectSessions`/`confirmWorkflowDraft` 钩子任务 3 留接口、任务 4/6 落地。
- 已知风险：①任务 2 的互斥退役波及 4 处实现+3 个测试文件——并存语义的测试改写量大；②editor 表化的消费者兼容靠「活跃槽 getters 兼容」策略，cases/design 理论零改动但必须核对；③退出程序拦截是 main 进程新钩子（无先例），测试用可控 stub 驱动 window close 事件。
- 规格勘误已在计划头部声明（workflowDesign 单会话 + 退出程序确认），终审报告须向用户披露。
