# apicc M2-B 工作流设计器 UI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付工作流设计器（Vue Flow 画布 + 生命周期 + 影响提醒 + 运行着色）——「编排 → 保存 → 发布/启用 → 运行着色」完整闭环。

**架构：** 8 个新 IPC 频道（zod 校验，复用 validateArgs 模式）；session 增工作流操作（复用 core transitionWorkflowStatus/validateEnablement/workflowImpact/WorkflowRunner）；渲染层新增 `workflowDesign` store 与 `wfCanvas.ts` 纯函数（Workflow ↔ Vue Flow 元素双向转换 + 着色映射——TDD 主战场）；Vue Flow 组件为薄壳（jsdom 渲染受限，挂载冒烟 + 数据层断言为准）。装配沿用组合根约定。

**技术栈：** 既有栈 + `@vue-flow/core`（MIT）。

**工作目录：** `D:\workspace260609\project-2\apicc-m2`（worktree，分支 feature/m2）。**基线：core 171 / cli 10 / desktop 140 测试全绿。**

**全局约束：** 入库文件不得出现竞品品牌名；中文 conventional commit；显式路径 git add；每任务门禁 = desktop typecheck（含 electron tsconfig）+ desktop 全量 + core 全量（涉 core dist 消费变更先 `pnpm -C packages/core build`），任务 8 加 dist:dir + smoke:dir；组件内零工厂调用；Vue Flow API 细节按官方文档适配（测试以 data-testid 与数据层为准）。

---

## 文件结构（2B 新增/修改）

```
apps/desktop/src/
  shared/channels.ts         ← 增 8 频道：wf:list/get/create/delete/save/set-status/impact/run
  shared/types.ts            ← 增 ApiccApi 8 方法 + DTO（WorkflowSummary、WorkflowDesignSaveInput…）
  main/session.ts            ← 增 locateWorkflow/createWorkflow/deleteWorkflow/saveWorkflow/setWorkflowStatus
  main/ipc.ts                ← 增 8 分支（zod 校验入表）
  renderer/src/api/memory.ts ← 替身扩展 8 方法
  renderer/src/
    stores/workflowDesign.ts ← 设计器 store（加载/编辑缓冲/dirty/保存/生命周期/运行）
    stores/wfList.ts         ← 工作流列表 store（项目级列表/新建/删除）
    wf/wfCanvas.ts           ← 纯函数：toFlowElements / applyNodeAdd / applyNodeRemove / applyEdgeAdd /
                                applyEdgeRemove / colorForState（TDD 主战场）
    components/WfListView.vue     ← 项目工作流列表（挂侧树下方或属性区）
    components/WfDesigner.vue     ← 设计器三区视图（顶栏/画布/属性面板）
    components/WfNode.vue         ← Vue Flow 自定义节点
    components/WfPropertyPanel.vue← 节点/边属性面板
    components/WfResultDrawer.vue ← 运行结果抽屉
  App.vue                    ← 增「工作流」视图入口与装配
  renderer/src/i18n/*.json   ← 增 wf.* 键（两语言同构）
tests (apps/desktop/tests/):
  main/ipc.test.ts（追加）、renderer/stores/workflowDesign.test.ts、wfList.test.ts、
  renderer/wf/wfCanvas.test.ts、renderer/components/wfDesigner.test.ts（挂载冒烟+数据断言）
```

---

### 任务 1：wf IPC 契约 + session 工作流操作 + 替身扩展

**文件：** 修改 `shared/channels.ts`、`shared/types.ts`、`main/session.ts`、`main/ipc.ts`、`renderer/src/api/memory.ts`、`preload/preload.ts`；测试 `tests/main/ipc.test.ts`（追加）

- [ ] **步骤 1：编写失败的 IPC 测试**（ipc.test.ts 追加，模式同既有：临时工作区 + createIpcDeps）

```ts
describe("工作流 IPC", () => {
  it("wf:create → wf:list → wf:get → wf:save → wf:set-status 全链路", async () => {
    // 建工作区 + 分组 + 项目（含一个接口/用例）后：
    const wf = await deps.handle("wf:create", {}, { projectId: project.id, name: "条件流" });
    expect(wf.status).toBe("draft");
    expect((await deps.handle("wf:list", {}, { projectId: project.id })).map((w) => w.name)).toEqual(["条件流"]);
    const got = await deps.handle("wf:get", {}, { workflowId: wf.id });
    expect(got.workflow.id).toBe(wf.id);
    expect(got.projectId).toBe(project.id);
    const saved = await deps.handle("wf:save", {}, { workflow: { ...wf, nodes: [{ id: "n1", kind: "request", apiId: api.id, caseId: api.cases[0].id }] } });
    expect(saved.status).toBe("draft");
    const r = await deps.handle("wf:set-status", {}, { workflowId: wf.id, next: "published" });
    expect(r.workflow.status).toBe("published");
    const enabled = await deps.handle("wf:set-status", {}, { workflowId: wf.id, next: "enabled" });
    expect(enabled.workflow.status).toBe("enabled");
    expect(enabled.errors).toEqual([]);
  });

  it("wf:set-status 启用校验失败返回 errors 且状态不变", async () => {
    // 建空节点工作流（request 节点引用不存在用例）→ publish → enable
    // 断言：enable 返回 { workflow(status=published), errors: 数组非空 }，不改状态
  });

  it("wf:impact 反查引用；wf:delete 删除后列表为空", async () => {
    // 工作流引用真实用例 → wf:impact({ caseId }) 命中 → wf:delete → list 为空
  });

  it("重名创建拒绝；未知 workflowId 抛「未找到工作流」", async () => { /* 断言错误消息 */ });
});
```

（断言细节实现者按 memory/session 语义对齐——错误文案与 session 一致：「未找到工作流」「项目已存在」风格沿用。）

- [ ] **步骤 2：实现**

session.ts 追加（模式对齐 locateCollection/createCollection）：

```ts
function locateWorkflow(workflowId: string): { workflow: Workflow; project: Project; group: Group } | undefined;
function createWorkflow(projectId: string, name: string): Workflow;      // 重名拒绝「工作流已存在: name」；status draft
function deleteWorkflow(workflowId: string): void;                        // 未命中抛「未找到工作流」
async function saveWorkflow(workflow: Workflow): Promise<void>;           // 按 id 定位替换 + save()（status 保持，由 setWorkflowStatus 单独管理）
function setWorkflowStatus(workflowId: string, next: WorkflowStatus): { workflow: Workflow; errors: string[]; warnings: string[] } {
  // locate → validateEnablement（next==="enabled" 时）→ transitionWorkflowStatus（捕获异常转 { errors } 返回？）
  // 裁定：draft→published / published→enabled 失败（校验未过）返回 { workflow(状态不变), errors, warnings }；
  // 非法迁移（如 draft→enabled）直接抛错（UI 按钮禁用本不应触发）。
}
```

channels/types/ipc 分支（zod 入表）/preload/memory 全部同步；memory 语义对齐 session（错误文案一致）。

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): 工作流 IPC 契约与会话操作（8 频道 + 替身扩展）"
```

---

### 任务 2：workflowDesign / wfList store + 工作流列表入口

**文件：** 创建 `stores/workflowDesign.ts`、`stores/wfList.ts`；测试 `tests/renderer/stores/workflowDesign.test.ts`、`wfList.test.ts`（jsdom pragma）

- [ ] **步骤 1：编写失败的测试（节选核心断言，实现者补全夹具）**

workflowDesign：`load(workflowId)` 拉全量并建编辑缓冲；`updateNode/updateEdge/addEdge/removeNode...` 只改缓冲并置 dirty（快照比对 getter，先例同 editor）；`save()` 走 api.wfSave 且 dirty 复位；`setStatus(next)` 失败时 `validationErrors` 可见、状态不变；`run(envName?)` 走 api.wfRun 存 runResult（running 门控）。
wfList：`load(projectId)` / `create(name)` / `remove(id)`（确认回调模式，先例同 tree store）。

- [ ] **步骤 2：实现两个 store（工厂每调用 createPinia 隔离，先例）**

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add apps/desktop/src/renderer/src/stores apps/desktop/tests/renderer/stores
git commit -m "feat(desktop): 工作流设计器与列表 store（编辑缓冲/生命周期/运行）"
```

---

### 任务 3：wfCanvas 纯函数（转换与着色，TDD 主战场）

**文件：** 创建 `src/renderer/src/wf/wfCanvas.ts`；测试 `tests/renderer/wf/wfCanvas.test.ts`（node 环境即可，纯数据）

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { toFlowElements, applyNodeAdd, applyNodeRemove, applyEdgeAdd, applyEdgeRemove, colorForState } from "../../src/renderer/src/wf/wfCanvas.js";
import type { Workflow } from "@apicc/core";

const wf: Workflow = {
  id: "w", name: "流", status: "enabled",
  nodes: [
    { id: "n1", kind: "request", apiId: "a1", caseId: "c1", label: "登录", position: { x: 0, y: 0 } },
    { id: "n2", kind: "noop", label: "占位", position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", condition: "prev.passed" }],
};

describe("toFlowElements", () => {
  it("Workflow → Vue Flow 元素：节点带 position/自定义 data，边带 condition 标签数据", () => {
    const { nodes, edges } = toFlowElements(wf);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ id: "n1", position: { x: 0, y: 0 }, data: { node: wf.nodes[0], missing: false } });
    expect(edges[0]).toMatchObject({ id: "e1", source: "n1", target: "n2", data: { condition: "prev.passed" } });
  });
  it("missing 标注：apiIds 集合不含节点引用时 missing=true", () => {
    const { nodes } = toFlowElements(wf, { apiIds: new Set(["other"]) });
    expect(nodes[0]!.data.missing).toBe(true);
    expect(nodes[1]!.data.missing).toBe(false); // noop 不标
  });
});

describe("编辑变换（不可变：返回新缓冲）", () => {
  it("applyNodeAdd 追加节点（position 缺省网格摆放）", () => {
    const b = applyNodeAdd(wf, { id: "nX", kind: "request", apiId: "a", caseId: "c" });
    expect(b.nodes.at(-1)!.id).toBe("nX");
    expect(b.nodes.at(-1)!.position).toBeDefined();
    expect(b).not.toBe(wf); // 原对象不变
  });
  it("applyNodeRemove 同时移除关联边", () => {
    const b = applyNodeRemove(wf, "n1");
    expect(b.nodes.some((n) => n.id === "n1")).toBe(false);
    expect(b.edges.some((e) => e.from === "n1" || e.to === "n1")).toBe(false);
  });
  it("applyEdgeAdd 拒绝自环与重复（同 from-to-condition）", () => {
    expect(() => applyEdgeAdd(wf, { source: "n1", target: "n1" })).toThrow(/自环/);
    expect(() => applyEdgeAdd(wf, { source: "n1", target: "n2", condition: undefined })).toThrow(/已存在/);
  });
  it("applyEdgeRemove 按 id 移除", () => { /* 同款断言 */ });
});

describe("colorForState", () => {
  it("状态 → CSS 类名映射", () => {
    expect(colorForState("passed")).toBe("wf-node-passed");
    expect(colorForState("failed")).toBe("wf-node-failed");
    expect(colorForState("skipped")).toBe("wf-node-skipped");
    expect(colorForState("noop")).toBe("wf-node-noop");
    expect(colorForState(undefined)).toBe("");
  });
});
```

- [ ] **步骤 2：运行验证失败 → 实现**

实现要点：`toFlowElements(workflow, opts?: { apiIds?: Set<string>; nodeStates?: Map<string, NodeState> })` 返回 Vue Flow 兼容形状（`{ id, type: "wf", position, data: { node, missing, stateClass } }` / `{ id, source, target, data: { condition, edge } }`，`type: "wfEdge"`）；编辑变换全部不可变（spread 返回新 Workflow 缓冲）；`applyEdgeAdd` 的去重判定与 core validate 的 duplicate-edge 同口径（from+to+condition）。

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add apps/desktop/src/renderer/src/wf apps/desktop/tests/renderer/wf
git commit -m "feat(desktop): 画布数据层——Workflow↔Vue Flow 转换、编辑变换、着色映射"
```

---

### 任务 4：设计器视图装配（Vue Flow 画布 + 属性面板 + 保存）

**文件：** 创建 `components/WfDesigner.vue`、`WfNode.vue`、`WfPropertyPanel.vue`；修改 `App.vue`（新视图入口 + 装配）；测试 `tests/renderer/components/wfDesigner.test.ts`

- [ ] **步骤 1：编写失败的测试**

挂载冒烟 + 数据断言（Vue Flow 在 jsdom 渲染受限——断言以 store 缓冲与 data-testid 包裹层为准）：
- 未选工作流 → 空态；选中后画布容器渲染（`data-testid="wf-canvas"`）
- 「添加请求节点」「添加占位节点」按钮 → store 缓冲新增节点（经 wfCanvas 变换后 nodes 数增长）
- 选中节点后属性面板显示 label 输入 / 接口用例改绑级联（memory 种子数据）/ noop 切换；改动置 dirty
- 删除选中节点 → 缓冲节点与关联边减少
- 保存按钮 → api.wfSave 被调、dirty 复位（spy 断言）
- 边选中 → 条件表达式 textarea 显示既有值，改后置 dirty

- [ ] **步骤 2：实现**

- `WfDesigner.vue`：props 接收 `workflowDesign`/`wfList`/`workspace`/`reportError`（组合根下发）；三区布局（顶栏 a-space / 中央 Vue Flow 容器 `data-testid="wf-canvas"` / 右侧 WfPropertyPanel a-layout-sider 280px）；Vue Flow 使用 `:nodes/:edges` 受控 + `@nodes-change/@edges-change/@connect` 事件回写 store（经 wfCanvas 变换）；自定义节点 `type: "wf"` 用 template #node-wf 插槽内嵌 WfNode
- `WfNode.vue`：props 接收节点 data；渲染 label、api 名/case 名（经 resolve 缓存查 memory——**改为 data 预注入**：toFlowElements 时由调用方把 apiName/caseName 解析进 data，画布不做查找）、missing 红框 class、状态 class
- `WfPropertyPanel.vue`：无选中 → 提示；节点选中 → a-form（label / 接口用例 a-cascader（options 由 workspace 树构造）/ kind 切换 a-switch「空过占位」）；边选中 → condition a-textarea + 可用变量说明（`prev.passed`、`vars.*`、`env.*`）+ 语法提示（JS 表达式，异常按不通过）
- `App.vue`：视图切换组追加「工作流」；选中侧树工作流节点 → 装配设计器（load）

- [ ] **步骤 3：运行验证通过 + 手工冒烟（build:renderer + electron CDP：建流→加节点→连线→保存→重开不丢）+ Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): 工作流设计器视图——Vue Flow 画布、属性面板与保存链路"
```

---

### 任务 5：生命周期与校验错误展示

**文件：** 修改 `WfDesigner.vue`（顶栏按钮组 + 错误列表）、`stores/workflowDesign.ts`（如需补字段）；测试追加

- [ ] **步骤 1：编写失败的测试**

- draft → 「发布」可用：点击后 `setStatus("published")`；若返回 errors 非空 → `validationErrors` 可见（a-alert 列表 data-testid="wf-errors"）且状态不变
- published → 「启用」可用（校验失败同上）；「解除启用」enabled 可用
- 按钮禁用态随 workflow.status（data-testid：wf-publish / wf-enable / wf-retract）
- 运行按钮：enabled 直接运行；draft 点击 → 确认弹窗「草稿运行仅结构校验」→ 确认后带 force 标记（**裁定：wf:run 无需 force 参数——主进程 run:workflow 对 draft 抛错，UI 对 draft 的运行按钮直接禁用并提示先发布**。与简报「确认后强制运行」不同，取更简语义并在报告注明）

- [ ] **步骤 2：实现顶栏按钮组与错误列表**

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): 工作流生命周期按钮组与启用校验错误展示"
```

---

### 任务 6：删除影响提醒

**文件：** 修改 `SideTree.vue`（删除用例/接口前置 impact 查询）、`App.vue`（提供 api 与确认弹窗通道）；测试 `tests/renderer/components/components.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

- 删除被引用用例：api.wfImpact 返回命中 → 确认弹窗内容含工作流名与节点 label（data-testid="impact-list"）→ 确认后删除执行
- 无命中 → 直接删除（无额外弹窗）
- 取消 → 不删除

- [ ] **步骤 2：实现**

SideTree 的 deleteNode 确认回调链路前置 `api.wfImpact`（kind 为 api/case 时）：命中清单渲染进 ConfirmDialog（或复用列表插槽）；文案 i18n `tree.impactWarning`（「该用例被以下工作流引用，删除后对应节点将标记为缺失（可改绑恢复）」）。

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): 删除用例/接口的工作流影响提醒"
```

---

### 任务 7：运行着色与结果抽屉

**文件：** 修改 `WfDesigner.vue`（运行按钮 → 着色）、`WfResultDrawer.vue`（新建 a-drawer）；测试追加

- [ ] **步骤 1：编写失败的测试**

- 运行完成 → store.runResult 就绪 → toFlowElements 的 nodeStates 由 nodeResults 映射（passed/failed/skipped/noop → colorForState）→ 画布节点 class 断言（挂载层断言 store→变换输出即可）
- 结果抽屉：a-drawer 列出节点（label/state Tag/断言消息）+ warnings a-alert
- 运行中 run 按钮.loading；历史不重复落盘（每次 wf:run 已自动落盘，UI 不重复写）

- [ ] **步骤 2：实现**

`WfResultDrawer.vue`：props `result: WorkflowRunResult | null`、`open`；节点列表 a-table（label/状态 Tag/耗时/错误）。WfDesigner 运行完成后 `store.runResult` → `toFlowElements(workflow, { nodeStates })` 重算画布 class（stateClass 已在 wfCanvas 支持，任务 3 预留 nodeStates 参数——核对签名后接线）。

- [ ] **步骤 3：运行验证通过 + 手工冒烟（真实运行三节点流，画布着色可见）+ Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): 画布运行着色与结果抽屉"
```

---

### 任务 8：打包与收尾

**文件：** 修改 `apps/desktop/package.json`（@vue-flow/core 归 devDeps——renderer bundle 先例；如任务 1 误入 dependencies）

- [ ] **步骤 1：依赖归位核对 + 全量门禁 + 打包冒烟**

`pnpm -C apps/desktop dist:dir && pnpm -C apps/desktop run smoke:dir`；三绿门禁打包前后各一轮；顺带核对账本延后项（T2① a-table row-key、T8⑥ 断言密度——若涉及本任务文件顺手修，否则留账）。

- [ ] **步骤 2：Commit**

```bash
git add apps/desktop
git commit -m "build(desktop): 设计器打包冒烟与依赖归位收尾"
```

---

## 规格覆盖对照

| 规格条目 | 任务 |
|----------|------|
| 8 频道契约（§3） | 1 |
| 侧树 workflows 入口 + 列表（§4/D3） | 2 |
| 画布数据层（§5 wfCanvas） | 3 |
| 设计器三区 + 属性面板 + 保存（§4/D4） | 4 |
| 生命周期 + 校验错误（§4 顶栏） | 5 |
| 影响提醒（§4） | 6 |
| 运行着色 + 抽屉（§4 运行着色） | 7 |
| 打包/合规（§7） | 8 |

## 自检结果

1. **覆盖度**：规格全节映射；推迟项（自动布局/撤销重做/小地图/工作流级变量）未混入。
2. **占位符扫描**：无 TODO；Vue Flow 组件交互以「data-testid + store 契约 + 数据层断言」为完整行为定义，jsdom 限制的适配自由度已在约束中显式授予。
3. **类型一致性**：8 频道在 channels 单源；ApiccApi 8 方法签名在 types.ts 单源；`toFlowElements` 的 nodeStates 参数（任务 3 预留、任务 7 消费）与 `colorForState`（任务 3 定义、任务 7 消费）签名锁定；WorkflowRunResult 形状以 M2-A runner.ts 为准。

## 执行注意事项

- 品牌中立；每任务提交前三绿 + desktop typecheck（含 electron tsconfig：session.ts 变更必须过）
- Vue Flow 交互测试的 jsdom 限制：任何「拖拽」类断言一律降级为对 store 变换函数的直接调用断言
- memory 替身扩展必须与 session 语义同口径（错误文案一致）
