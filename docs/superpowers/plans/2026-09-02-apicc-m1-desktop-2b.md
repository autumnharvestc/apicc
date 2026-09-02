# apicc M1 计划 2B：测试管理面与打包 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付测试管理全流程：用例与环境面板、集合运行与报告视图、导入向导（含 CLI 非交互导入）、详细设计编辑器与 agent 导出、electron-builder 打包；同时把 UI 组件库统一切换为 **Ant Design Vue 4.x**（用户指定，docs: https://antdv.com/components/overview-cn）。

**架构：** UI 基座迁移到 ant-design-vue 4（`ConfigProvider` 承载 locale（zh_CN/en_US 与既有 i18n 状态联动）与 theme（`theme.darkAlgorithm`/`theme.defaultAlgorithm` 与既有三态主题联动））；既有六组件按映射表迁移到 antd 组件并保留全部 `data-testid` 与既有 store 契约。新功能全部走既有装配约定（组合根创建 store，props 下发）与 IPC 契约模式（session 内存模型 + 显式 save；新增 IPC 频道带 zod 入参校验）。`debug:send` 扩展响应快照（afterResponse 捕获），消除 ResponseViewer 的「—」占位。

**技术栈：** 既有栈 + `ant-design-vue` ^4、`electron-builder`（打包冒烟用 dir 目标）、zod（IPC 入参校验，core 已有依赖）。

**范围说明：** 压测并发模型、DAG 工作流仍属 M2；`ResponseViewer` 的「—」占位由本计划任务 3 消除。

---

## 文件结构（2B 新增/修改）

```
apps/desktop/src/
  shared/channels.ts            ← 增 6 频道：env:create、env:vars:save、run:collection、
                                  runs:list、runs:get、import:preview/apply、design:export（共 8）
  shared/types.ts               ← 增 EnvCreateInput、RunInput、RunSummaryDTO、ImportPreviewDTO、
                                  DebugOutput 扩展 response?: { status; headers; bodyText; timeMs }
  main/
    session.ts                  ← 增 createEnvironment / setEnvironmentVariables / importProject
    ipc.ts                      ← 增频道分支 + zod 入参校验（validateArgs）
    debug.ts                    ← DebugOutput 增 response 快照（bus 捕获 afterResponse）
    runs.ts                     ← 运行历史读取（runs:list / runs:get）
  renderer/src/
    App.vue                     ← ConfigProvider 包裹（locale + theme 联动）+ 视图切换（调试/运行/导入/设计）
    components/                 ← 存量六组件迁移 antd（保留 data-testid 与 store 契约）
    components/CasePanel.vue    ← 新增：用例列表与编辑
    components/EnvPanel.vue     ← 新增：环境与变量
    components/RunView.vue      ← 新增：集合运行 + 结果表格
    components/RunsHistory.vue  ← 新增：运行历史抽屉
    components/ImportWizard.vue ← 新增：导入向导（三步）
    components/DesignPanel.vue  ← 新增：详细设计编辑与导出
    stores/cases.ts、envs.ts、run.ts、importW.ts、design.ts  ← 新增 store（内存替身 TDD）
packages/cli/src/main.ts        ← 增 `apicc import <file> --group <name> [--yes]`
apps/desktop/electron-builder.yml + package.json 打包脚本
```

---

### 任务 1：引入 ant-design-vue 与 ConfigProvider 联动（i18n/主题）

**文件：**
- 修改：`apps/desktop/package.json`（依赖 ant-design-vue ^4；vue-i18n 移回 dependencies——打包前归位）
- 修改：`apps/desktop/src/renderer/src/main.ts`、`App.vue`、`src/renderer/src/i18n/bridge.ts`、`theme.ts`
- 测试：`apps/desktop/tests/renderer/App.test.ts`（更新断言）、`apps/desktop/tests/renderer/components/antd-linkage.test.ts`（新增）

- [ ] **步骤 1：安装与全局装配**

```bash
pnpm -C apps/desktop add ant-design-vue
pnpm -C apps/desktop add -D @types/node
# vue-i18n 归位：从 devDependencies 移到 dependencies（pnpm remove 后重新 add 即可）
```

`bridge.ts` 扩展（新增导出，保持 `initI18n` 单例不变）：

```ts
export function currentLocale(): Locale {
  initI18n();
  return i18nGlobal.global.locale.value as Locale;
}
```

`theme.ts` 增加响应式偏好（供 ConfigProvider 联动）：

```ts
import { ref } from "vue";
export const themePreference = ref<Theme>(loadPreference());
export function savePreference(preference: Theme): void {
  localStorage.setItem(KEY, preference);
  themePreference.value = preference;
}
```

`App.vue` 顶层改为 ConfigProvider 包裹（locale 与主题算法联动）：

```vue
<script setup lang="ts">
import { computed } from "vue";
import { ConfigProvider, theme as antdTheme } from "ant-design-vue";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import enUS from "ant-design-vue/es/locale/en_US";
import { currentLocale } from "./i18n/bridge.js";
import { themePreference, resolveTheme } from "./theme.js";

const antdLocale = computed(() => (currentLocale() === "zh-CN" ? zhCN : enUS));
const antdTheme = computed(() => ({
  algorithm: resolveTheme(themePreference.value, window.matchMedia("(prefers-color-scheme: dark)").matches)
    === "dark" ? antdTheme2.darkAlgorithm : antdTheme2.defaultAlgorithm,
}));
const antdTheme2 = antdTheme;
</script>
```

实现更正指令（照做）：上面片段存在先后引用问题——以如下最终形态为准：

```ts
import { computed } from "vue";
import { ConfigProvider, theme as antdTheme } from "ant-design-vue";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import enUS from "ant-design-vue/es/locale/en_US";
import { currentLocale } from "./i18n/bridge.js";
import { themePreference, resolveTheme } from "./theme.js";

const antdLocale = computed(() => (currentLocale() === "zh-CN" ? zhCN : enUS));
const antdThemeConfig = computed(() => ({
  algorithm:
    resolveTheme(themePreference.value, window.matchMedia("(prefers-color-scheme: dark)").matches) === "dark"
      ? antdTheme.darkAlgorithm
      : antdTheme.defaultAlgorithm,
}));
```

模板：`<a-config-provider :locale="antdLocale" :theme="antdThemeConfig">…既有布局…</a-config-provider>`。

- [ ] **步骤 2：更新受影响测试并新增联动测试**

`App.test.ts`：mount 改为同时挂 ConfigProvider（或直接挂 App——App 已内含 ConfigProvider），断言「渲染就绪标记」不变。

新增 `tests/renderer/components/antd-linkage.test.ts`：

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18nInstance } from "../../src/renderer/src/i18n/index.js";
import ThemeLanguageToggle from "../../src/renderer/src/components/ThemeLanguageToggle.vue";

async function mountToggle() {
  setActivePinia(createPinia());
  const { i18n } = createI18nInstance();
  const wrapper = mount(ThemeLanguageToggle, { global: { plugins: [i18n] } });
  return wrapper;
}

describe("antd 联动数据源", () => {
  it("语言循环后 currentLocale 变化（ConfigProvider locale 源）", async () => {
    const wrapper = await mountToggle();
    const before = currentLocale();
    await wrapper.find('[data-testid="lang-toggle"]').trigger("click");
    expect(currentLocale()).not.toBe(before);
  });
  it("主题循环后 themePreference 变化（ConfigProvider algorithm 源）", async () => {
    const wrapper = await mountToggle();
    const before = themePreference.value;
    await wrapper.find('[data-testid="theme-toggle"]').trigger("click");
    expect(themePreference.value).not.toBe(before);
  });
});
```

- [ ] **步骤 3：运行与提交**

运行：`cd apps/desktop && pnpm vitest run`（既有 58 用例中受 antd DOM 影响的断言在任务 2 组件迁移时统一修，本任务只保证 App/联动测试绿）
预期：本任务涉及测试 PASS

```bash
git add apps/desktop pnpm-lock.yaml
git commit -m "feat(desktop): 引入 ant-design-vue，ConfigProvider 联动语言与主题算法"
```

---

### 任务 2：存量组件迁移 antd（保留 data-testid 与 store 契约）

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/` 下 TopBar.vue、ConfirmDialog.vue、EmptyState.vue、SideTree.vue、RequestEditor.vue、ResponseViewer.vue、App.vue（布局换 a-layout）
- 测试：`apps/desktop/tests/renderer/components/components.test.ts`、`App.test.ts` 更新

- [ ] **步骤 1：迁移映射（实现者按此表执行，模板细节自行适配 antd API）**

| 现状 | antd 组件 | 约束 |
|------|-----------|------|
| 顶栏按钮组/工作区名 | `a-space` + `a-button` + `a-typography-text` | 保留 `data-testid` 于触发钮 |
| ConfirmDialog | `a-modal`（open/title/okText/cancelText）+ `a-input`（initialValue） | 组件对外 props/emit 契约不变（open/title/inputPlaceholder/confirm(value|null)） |
| EmptyState | `a-empty` | props text 保留 |
| SideTree 树体 | `a-tree`（受控 `expandedKeys`/`selectedKeys` + `fieldNames` 或构造 treeData） | 节点动作钮保留（title slot 内 hover 钮）；`data-testid="tree-api"` 挂在 api 节点的 title 包裹元素上；选中 emit select |
| RequestEditor | 方法 `a-select`、URL `a-input`、tabs `a-tabs`、行编辑 `a-input`+`a-button`、auth 表单 `a-select`+`a-input` | `data-testid="editor-url"`/`"send-btn"` 保留；send 钮 `a-button type="primary"` |
| ResponseViewer | `a-tabs` + `a-descriptions`/`a-table`（断言列表）+ `a-tag`（passed/failed 徽标） | `data-testid="response-empty"` 保留；不臆造字段 |
| App 布局 | `a-layout`（a-layout-sider 240px + a-layout-content） | 三栏结构不变 |
| 错误展示条 | `a-alert type="error"` 可关闭（替代自研条） | `data-testid="app-error"` 保留，关闭走 reportError 通道清空 |

- [ ] **步骤 2：更新组件测试（断言语义不变，选择器适配 antd）**

原则：`data-testid` 仍是主钩子；antd 内部交互（如 a-select 下拉）用 `wrapper.findComponent({ name: 'ASelect' })` 或对触发元素 `setValue/trigger` 的方式——实现者按 antd 4 实测行为调整并在测试顶部注释说明交互方式。所有既有用例语义（选中/创建/删除确认/发送禁用/空态/断言明细）必须保留。

- [ ] **步骤 3：运行与提交**

运行：`cd apps/desktop && pnpm vitest run`（全部用例语义等价通过）+ `pnpm typecheck` + core 回归
预期：desktop 全量绿

```bash
git add apps/desktop
git commit -m "refactor(desktop): 存量组件迁移 ant-design-vue 并保留测试契约"
```

---

### 任务 3：debug:send 响应快照扩展（消除「—」占位）

**文件：**
- 修改：`apps/desktop/src/main/debug.ts`、`apps/desktop/src/shared/types.ts`
- 修改：`apps/desktop/src/renderer/src/components/ResponseViewer.vue`
- 测试：`apps/desktop/tests/main/debug.test.ts`、`apps/desktop/tests/renderer/components/components.test.ts`

- [ ] **步骤 1：编写失败的测试**

`tests/main/debug.test.ts` 追加：

```ts
it("DebugOutput 携带响应快照（status/headers/bodyText/timeMs）", async () => {
  const { s, api } = await setup("set");
  const result = await sendDebug(s, { apiId: api.id, caseId: api.cases[0]!.id, envName: "dev" });
  expect(result.response).toBeDefined();
  expect(result.response!.status).toBe(200);
  expect(result.response!.bodyText).toContain("ok");
  expect(result.response!.timeMs).toBeGreaterThanOrEqual(0);
});
```

- [ ] **步骤 2：运行验证失败 → 实现**

`shared/types.ts`：`DebugOutput` 增 `response?: { status: number; headers: Record<string, string>; bodyText: string; timeMs: number }`。

`main/debug.ts`：`sendDebug` 内创建 bus 后注册一次性捕获：

```ts
let response: DebugOutput["response"] | undefined;
const off = bus.on("afterResponse", (p) => {
  // p 携带 status/timeMs（事件契约）；bodyText/headers 由 Runner 的 responseView 提供——
  // 实现更正：直接在 Runner 事件里扩展 afterResponse 载荷为
  // { status: number; timeMs: number; headers: Record<string,string>; bodyText: string }（可选新增字段），
  // core 的 bus.ts RunEventMap.afterResponse 增加可选 headers/bodyText 字段并由 runner.ts 触发点填充。
  response = { status: p.status, headers: p.headers ?? {}, bodyText: p.bodyText ?? "", timeMs: p.timeMs };
});
try { /* run */ } finally { off(); }
return { run, outcome, response };
```

配套 core 改动（加法式，规格 §5.2 允许可选增量）：`packages/core/src/events/bus.ts` 的 `afterResponse` 载荷增 `headers?: Record<string, string>; bodyText?: string`；`packages/core/src/runner/runner.ts` 的 afterResponse 触发点填充这两字段；core 测试补一条断言（payload 含 bodyText）。core 全量回归必须绿。

- [ ] **步骤 3：ResponseViewer 用真实响应**

body tab 渲染 `props.result.response.bodyText`（`<pre>` 展示，尝试 JSON pretty）；headers tab 渲染 `Object.entries(response.headers)` 表格；无 response 时保留「—」。更新 components.test：props 带 response 时断言 bodyText 可见（替换原「—」断言的适用范围——无 response 仍「—」）。

- [ ] **步骤 4：运行与提交**

运行：`cd packages/core && pnpm vitest run && cd ../../apps/desktop && pnpm vitest run`
预期：全绿

```bash
git add packages/core apps/desktop
git commit -m "feat(desktop): 调试输出携带响应快照，ResponseViewer 展示真实响应体与头"
```

---

### 任务 4：环境面板（session 环境操作 + env IPC + EnvPanel）

**文件：**
- 修改：`apps/desktop/src/main/session.ts`、`src/shared/channels.ts`、`src/shared/types.ts`、`src/main/ipc.ts`、`src/renderer/src/api/memory.ts`、`src/preload/preload.ts`
- 创建：`apps/desktop/src/renderer/src/stores/envs.ts`、`apps/desktop/src/renderer/src/components/EnvPanel.vue`
- 测试：`apps/desktop/tests/main/session.test.ts`（追加）、`apps/desktop/tests/main/ipc.test.ts`（追加）、`apps/desktop/tests/renderer/stores/envs.test.ts`（新增）

- [ ] **步骤 1：编写失败的 session/IPC 测试**

`tests/main/session.test.ts` 追加：

```ts
it("createEnvironment 派生环境并继承父变量；setEnvironmentVariables 覆盖", async () => {
  const s = createSession();
  const dir = root();
  await s.create(dir, "w");
  await s.open(dir);
  const g = s.createGroup("g");
  const p = s.createProject(g.id, "p");
  p.environments.push({ id: "e-dev", name: "dev", variables: { baseUrl: "http://d", token: "t" } });
  const env = s.createEnvironment(p.id, { name: "sit", extends: "dev" });
  await s.save();
  const s2 = createSession();
  await s2.open(dir);
  const sit = s2.workspace.groups[0]!.projects[0]!.environments.find((e) => e.name === "sit")!;
  expect(sit.extends).toBe("dev");
  await s2.setEnvironmentVariables(sit.id, { baseUrl: "http://s" });
  const reopened = createSession();
  await reopened.open(dir);
  const sitVars = reopened.workspace.groups[0]!.projects[0]!.environments.find((e) => e.name === "sit")!.variables;
  expect(sitVars).toEqual({ baseUrl: "http://s" });
});
```

`tests/main/ipc.test.ts` 追加：`env:create`（{ projectId, name, extends? } → 返回环境对象）与 `env:vars:save`（{ envId, variables } → 落盘读回）两链路断言。

- [ ] **步骤 2：运行验证失败 → 实现**

`session.ts` 追加：

```ts
function createEnvironment(projectId: string, input: { name: string; extends?: string }): Environment {
  const { workspace: ws } = ensureOpen();
  const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === projectId);
  if (!project) throw new Error(`未找到项目: ${projectId}`);
  const env: Environment = { id: randomUUID(), name: input.name, extends: input.extends, variables: {} };
  project.environments.push(env);
  return env;
}
function setEnvironmentVariables(envId: string, variables: Record<string, string>): void {
  const { workspace: ws } = ensureOpen();
  const env = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.environments).find((x) => x.id === envId);
  if (!env) throw new Error(`未找到环境: ${envId}`);
  env.variables = variables;
}
```

（返回对象暴露两方法；`renameNode`/`deleteNode` 的 environment kind 已存在，无需新增。）

`channels.ts` 增 `EnvCreate: "env:create"`、`EnvVarsSave: "env:vars:save"`；`ipc.ts` 增两分支（Create 后 `await session.save()`；VarsSave 调 `setEnvironmentVariables` 后 `await session.save()`）。preload/memory/types 同步（memory 语义对齐 session）。

- [ ] **步骤 3：envs store + EnvPanel 组件（TDD）**

`tests/renderer/stores/envs.test.ts`：store 状态 `{ envs, selectedEnvId }`；actions `load(projectId)`（从 tree DTO 的 project envs 或 apiGet envs——用 `api.envList? ` 不存在，改从 `treeGet` 的 project 节点 envs 取）；`create({ projectId, name, extends? })` 后刷新；`saveVars(envId, variables)`；`remove(kind='environment', id)` 复用 tree store 模式。EnvPanel（antd 组件）：环境 `a-select`/列表 + 变量 `a-table` 行编辑 + 「从现有环境派生」`a-modal`（选父环境）+ 删除确认。三绿后提交。

```bash
git add apps/desktop
git commit -m "feat(desktop): 环境面板——派生/变量编辑/删除（session+IPC+store+组件）"
```

---

### 任务 5：用例面板（多用例编辑 + apiSave 持久化）

**文件：**
- 创建：`apps/desktop/src/renderer/src/stores/cases.ts`、`apps/desktop/src/renderer/src/components/CasePanel.vue`
- 测试：`apps/desktop/tests/renderer/stores/cases.test.ts`（新增）

- [ ] **步骤 1：编写失败的 cases store 测试**

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../src/renderer/src/stores/editor.js";
import { useCasesStore } from "../../src/renderer/src/stores/cases.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  return { api, editor, cases: useCasesStore(api, editor) };
}

describe("cases store", () => {
  it("addCase 新增基座用例并选中", async () => {
    const { editor, cases } = await seeded();
    const before = editor.api!.cases.length;
    const created = cases.addCase({ name: "新用例", scope: "base" });
    expect(editor.api!.cases.length).toBe(before + 1);
    expect(cases.selectedCaseId).toBe(created.id);
    expect(editor.dirty).toBe(true);
  });
  it("removeCase 删除用例（至少保留一个时拒绝删除最后一个）", async () => {
    const { editor, cases } = await seeded();
    expect(cases.removeCase(editor.api!.cases[0]!.id)).toBe(false);
    const extra = cases.addCase({ name: "extra", scope: "base" });
    expect(cases.removeCase(extra.id)).toBe(true);
    expect(editor.api!.cases.some((c) => c.id === extra.id)).toBe(false);
  });
  it("saveCases 经 editor.save 持久化", async () => {
    const { api, editor, cases } = await seeded();
    cases.addCase({ name: "持久", scope: "base" });
    await cases.save();
    const fresh = createMemoryApi();
    fresh.groups = api.groups;
    const reEditor = useEditorStore(fresh);
    await reEditor.load(editor.api!.id);
    expect(reEditor.api!.cases.some((c) => c.name === "持久")).toBe(true);
  });
});
```

- [ ] **步骤 2：运行验证失败 → 实现 cases store**

`stores/cases.ts`：

```ts
import { defineStore } from "pinia";
import { randomUUID } from "node:crypto";
import type { ApiccApi } from "../../shared/types.js";
import type { useEditorStore } from "./editor.js";

type Editor = ReturnType<typeof useEditorStore>;

export function useCasesStore(api: ApiccApi, editor: Editor) {
  return defineStore("cases", {
    state: () => ({ selectedCaseId: null as string | null }),
    actions: {
      addCase(input: { name: string; scope: string }) {
        if (!editor.api) throw new Error("未加载接口");
        const created = { id: randomUUID(), name: input.name, scope: input.scope, parameters: {}, assertions: [] };
        editor.api.cases.push(created);
        this.selectedCaseId = created.id;
        return created;
      },
      removeCase(caseId: string): boolean {
        if (!editor.api || editor.api.cases.length <= 1) return false;
        const index = editor.api.cases.findIndex((c) => c.id === caseId);
        if (index < 0) return false;
        editor.api.cases.splice(index, 1);
        if (this.selectedCaseId === caseId) this.selectedCaseId = editor.api.cases[0]!.id;
        return true;
      },
      select(caseId: string) { this.selectedCaseId = caseId; },
      async save() { await editor.save(); },
    },
  })(api, editor);
}
```

注意：`randomUUID` 来自 `node:crypto`——渲染层不可用！实现更正指令（照做）：id 改用 `crypto.randomUUID()`（浏览器全局，jsdom/Node ≥19 均有），不导入 node:crypto。

- [ ] **步骤 3：CasePanel 组件（antd）**

`CasePanel.vue`：props 接收 `editor`/`cases` store（组合根下发）；`a-table` 或列表渲染用例（名称/scope 标签/断言数），行内编辑名称（a-input）与 scope（a-select：base + 该接口所属项目的环境名列表——从 editor.envs 的父 project envs？editor.envs 即项目环境列表，直接用其 name 集合）；断言编辑区：选中用例的 `a-table` 行编辑（target 下拉/op 下拉/expected 输入/headerName·path 条件显示）+ 前置/后置脚本 `a-textarea`；「添加用例」「删除用例」（最后一个禁用）+「保存用例」按钮走 `cases.save()`。data-testid：`case-row`、`case-add`、`case-delete`、`case-save`、`assert-table`。补组件测试：添加用例后列表出现新行且 `case-save` 后 apiSave 被调（memory 语义）。

- [ ] **步骤 4：运行与提交**

三绿门禁后：

```bash
git add apps/desktop
git commit -m "feat(desktop): 用例面板——多用例编辑/断言表格/脚本（apiSave 持久化）"
```

---

### 任务 6：集合运行 + 报告视图 + 运行历史

**文件：**
- 修改：`apps/desktop/src/shared/channels.ts`、`types.ts`、`src/main/ipc.ts`、`src/main/debug.ts`（同文件放 runCollection）、`src/preload/preload.ts`、`src/renderer/src/api/memory.ts`
- 创建：`apps/desktop/src/main/runs.ts`、`apps/desktop/src/renderer/src/stores/run.ts`、`apps/desktop/src/renderer/src/components/RunView.vue`、`RunsHistory.vue`
- 测试：`apps/desktop/tests/main/runs.test.ts`（新增）、`apps/desktop/tests/renderer/stores/run.test.ts`（新增）

- [ ] **步骤 1：编写失败的 runs/IPC 测试**

`tests/main/runs.test.ts`：

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRuns, readRun } from "../../src/main/runs.js";

const sample = {
  collectionId: "c", collectionName: "demo", startedAt: "2026-09-02T00:00:00.000Z",
  finishedAt: "2026-09-02T00:00:01.000Z", total: 2, passed: 1, failed: 1, cases: [],
};

describe("runs 历史", () => {
  it("listRuns 返回摘要（新→旧），readRun 读回完整结果", () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runslist-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run-a.json"), JSON.stringify({ ...sample, startedAt: "2026-09-02T01:00:00.000Z" }));
    writeFileSync(join(dir, "run-b.json"), JSON.stringify(sample));
    const list = listRuns(dir);
    expect(list).toHaveLength(2);
    expect(list[0]!.file).toBe("run-a.json");
    expect(list[0]!.collectionName).toBe("demo");
    expect(readRun(dir, "run-a.json")!.total).toBe(2);
  });
  it("非法文件跳过不抛", () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runslist2-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "{broken");
    expect(listRuns(dir)).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行验证失败 → 实现 runs.ts 与 IPC**

`src/main/runs.ts`：

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "@apicc/core";

export interface RunSummaryDTO { file: string; collectionName: string; startedAt: string; total: number; passed: number; failed: number }

export function listRuns(runsDir: string): RunSummaryDTO[] {
  try {
    return readdirSync(runsDir)
      .filter((f) => f.endsWith(".json"))
      .map((file) => {
        try {
          const r = JSON.parse(readFileSync(join(runsDir, file), "utf8")) as RunResult;
          return { file, collectionName: r.collectionName, startedAt: r.startedAt, total: r.total, passed: r.passed, failed: r.failed };
        } catch {
          return null;
        }
      })
      .filter((x): x is RunSummaryDTO => x !== null)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function readRun(runsDir: string, file: string): RunResult | null {
  if (!file.endsWith(".json") || file.includes("/") || file.includes("\\")) return null;
  try {
    return JSON.parse(readFileSync(join(runsDir, file), "utf8")) as RunResult;
  } catch {
    return null;
  }
}
```

`channels.ts` 增 `RunCollection: "run:collection"`、`RunsList: "runs:list"`、`RunsGet: "runs:get"`；`ipc.ts` 增分支：`run:collection`（{ collectionId, envName? } → 经 session.locateApi 类似遍历取 collection/project，构造完整 collection 走 `CollectionRunner`，runsDir 固定 `join(session.root, ".apicc", "runs")`，返回 RunResult）；`runs:list` → `listRuns(join(session.root, ".apicc", "runs"))`；`runs:get` → `readRun(...)`。session 增 `locateCollection(collectionId)` 辅助（同 locateApi 模式）。preload/memory/types 同步（memory 的 runCollection 返回固定成功、runs list/get 基于内存样例）。

- [ ] **步骤 3：run store + RunView/RunsHistory 组件（antd）**

`stores/run.ts`（TDD，memory api）：状态 `{ running, result, summaries, historyOpen }`；actions `runCollection(collectionId, envName?)`（running 门控）、`loadHistory()`、`openRun(file)`。`RunView.vue`：集合/环境下拉（当前选中集合与项目环境）+「运行」按钮（a-button primary，loading=running）+ 结果 `a-table`（接口/用例/数据行/结果 Tag/耗时/详情展开）+ 汇总 `a-statistic` 或文本；`RunsHistory.vue`：`a-drawer` 内历史列表（点击载入完整结果回填表格）。data-testid：`run-btn`、`run-table`、`runs-history-btn`、`history-row`。组件测试：注入 memory api 断言 run 后表格出现、失败行 Tag 为 failed。

- [ ] **步骤 4：运行与提交**

三绿门禁后：

```bash
git add apps/desktop
git commit -m "feat(desktop): 集合运行视图与运行历史（run:collection + runs:list/get）"
```

---

### 任务 7：导入向导 + CLI 非交互导入

**文件：**
- 修改：`apps/desktop/src/shared/channels.ts`、`types.ts`、`src/main/ipc.ts`、`src/main/session.ts`、`src/preload/preload.ts`、`src/renderer/src/api/memory.ts`
- 创建：`apps/desktop/src/renderer/src/stores/importW.ts`、`apps/desktop/src/renderer/src/components/ImportWizard.vue`
- 修改：`packages/cli/src/main.ts`（`apicc import`）
- 测试：`apps/desktop/tests/main/ipc.test.ts`（追加）、`apps/desktop/tests/renderer/stores/importW.test.ts`（新增）、`packages/cli/tests/e2e.test.ts`（追加）

- [ ] **步骤 1：session.importProject + IPC**

`session.ts` 追加：

```ts
async importProject(groupName: string, imported: { project: Project }): Promise<void> {
  const { workspace: ws } = ensureOpen();
  let group = ws.groups.find((x) => x.name === groupName);
  if (!group) { group = createGroup(groupName); }
  const existing = group.projects.find((x) => x.name === imported.project.name);
  if (existing) throw new Error(`项目已存在: ${imported.project.name}`);
  group.projects.push(imported.project);
  await save();
}
```

`channels.ts` 增 `ImportPreview: "import:preview"`、`ImportApply: "import:apply"`；`ipc.ts` 分支：preview 用 `registry.listImporters()` 逐个 detect（返回 `{ importerName, project, warnings }`，无命中抛「无法识别的导入格式」）；apply 调 `session.importProject(groupName, project)`。`registry` 需在 ipc deps 可得——`createIpcDeps` 增可选 `importers?: Importer[]`（默认 createDefaultRegistry().listImporters()），测试注入固定 importer。zod 校验：preview/apply 入参用 zod schema 校验（`z.object({ content: z.string(), fileName: z.string() })`）。

- [ ] **步骤 2：编写失败的向导 store 测试 → 实现**

`tests/renderer/stores/importW.test.ts`：store 状态 `{ preview: null, applying }`；`previewFile(fileName, content)` → api.importPreview 返回结构入状态；`apply(groupName)` 调 api.importApply 后触发 workspace.refresh。memory 的 importPreview 返回固定 preview、importApply 记录调用。实现 `stores/importW.ts`。

`ImportWizard.vue`（antd `a-steps` 三步）：① 选择文件（`a-button` 走 `apicc.wsPickDirectory` 不适用文件——新 IPC `app:pickFile`？避免新增：复用 `input[type=file]` 在渲染层读文本（Electron file input 可读用户所选文件），读出 content + fileName 进 preview）→ ② 预览（`a-tree` 渲染 project 结构 + warnings `a-alert` 列表 + 目标分组名输入）→ ③ 完成（apply + 刷新 + 成功态）。测试覆盖三步推进与取消。

- [ ] **步骤 3：CLI 非交互导入**

`packages/cli/src/main.ts` 增命令：

```ts
program
  .command("import")
  .argument("<file>", "导入文件路径")
  .requiredOption("--group <name>", "目标分组名")
  .option("--yes", "跳过预览直接写入", false)
  .action(async (file: string, opts: { group: string; yes: boolean }) => {
    const root = findWorkspaceRoot(process.cwd());
    if (!root) throw new Error("未找到 apicc.workspace.yaml");
    const content = readFileSync(file, "utf8");
    const importer = registry.listImporters().find((i) => i.detect(file, content));
    if (!importer) throw new Error("无法识别的导入格式");
    const { project, warnings } = importer.parse(content);
    if (!opts.yes) {
      log(`预览：将导入项目「${project.name}」（集合 ${project.collections.length} 个）`);
      for (const w of warnings) log(`[警告] ${w}`);
      log("非交互模式请加 --yes 确认写入");
      return;
    }
    const storage = registry.getStorage()!;
    const { workspace } = await storage.load(root);
    let group = workspace.groups.find((x) => x.name === opts.group);
    if (!group) { group = { id: crypto.randomUUID(), name: opts.group, projects: [] }; workspace.groups.push(group); }
    if (group.projects.some((x) => x.name === project.name)) throw new Error(`项目已存在: ${project.name}`);
    group.projects.push(project);
    await storage.save(root, workspace);
    for (const w of warnings) log(`[警告] ${w}`);
    log(`已导入项目「${project.name}」到分组「${opts.group}」`);
  });
```

`packages/cli/tests/e2e.test.ts` 追加：OpenAPI 样例文件 import --yes → 退出码 0 → 重开工作区断言项目存在；重复导入抛「项目已存在」。

- [ ] **步骤 4：运行与提交**

三包门禁（core/cli/desktop）后：

```bash
git add apps/desktop packages/cli
git commit -m "feat(desktop): 导入向导与 CLI 非交互导入（preview/apply 双通道）"
```

---

### 任务 8：详细设计编辑器 + IPC 入参校验收口

**文件：**
- 创建：`apps/desktop/src/renderer/src/stores/design.ts`、`apps/desktop/src/renderer/src/components/DesignPanel.vue`
- 修改：`apps/desktop/src/main/ipc.ts`（validateArgs 收口全部频道）、`src/shared/channels.ts`（DesignExport: "design:export"）、`src/main/main.ts`（export 用 dialog.showSaveDialog）
- 测试：`apps/desktop/tests/main/ipc.test.ts`（追加）、`apps/desktop/tests/renderer/stores/design.test.ts`（新增）

- [ ] **步骤 1：design store 测试 → 实现**

design store：状态 `{ content, dirty }`；`load(api)` 读 `editor.api.design ?? ""`；`setContent(text)` 置 dirty；`save()` 写回 `editor.api.design` + `editor.save()`；`exportMarkdown()` 调 `api.designExport(apiId)` 返回保存路径。渲染层富文本不需要——`a-textarea`（等宽字体）+ 只读预览（渲染 renderDesignMarkdown 的纯文本或简单 md 转 HTML？**YAGNI：预览用 `a-typography` 段落展示原文即可，M1 不做 md 渲染**）。DesignPanel：设计 textarea + 保存 + 「导出 agent 设计」按钮（a-button，调 designExport，成功 message 显示路径）。

`channels.ts` 增 `DesignExport: "design:export"`；`ipc.ts` 分支：`designExport(apiId)` → 取接口、`renderDesignMarkdown`（core 已导出）、`dialog.showSaveDialog`（defaultPath `${api.name}.design.md`）→ 写文件返回路径（取消返回空串）。main.ts 的 dialog 依赖经 ipc deps 注入（`saveFile: (defaultName, content) => Promise<string>`，测试注入内存实现）。

- [ ] **步骤 2：IPC 入参校验收口**

`ipc.ts` 顶部定义各频道 zod schema（如 `NodeCreateInput`、`DebugInput`、`RunInput`、`EnvCreateInput`、`EnvVarsSaveInput`、`ImportApplyInput`——与 shared/types.ts 字段一一对应）：

```ts
const schemas: Record<string, z.ZodTypeAny> = {
  [IpcChannel.WsOpen]: z.string(),
  [IpcChannel.WsCreate]: z.tuple([z.string(), z.string()]),
  // ...全部频道
};
```

`handle` 入口统一 `schemas[channel]!.parse(args)`（多参频道包 tuple），失败抛带频道名的可读错误（经 I1 通道显示）。preload 白名单不变。测试：`ipc.test.ts` 追加「入参形状非法时抛可读错误」两例。

- [ ] **步骤 3：运行与提交**

三绿门禁后：

```bash
git add apps/desktop
git commit -m "feat(desktop): 详细设计编辑器与导出、IPC 入参 zod 校验收口"
```

---

### 任务 9：electron-builder 打包冒烟

**文件：**
- 创建：`apps/desktop/electron-builder.yml`
- 修改：`apps/desktop/package.json`（脚本 `dist:dir`）

- [ ] **步骤 1：打包配置**

`apps/desktop/electron-builder.yml`：

```yaml
appId: com.autumnharvestc.apicc
productName: apicc
directories:
  output: release
  appBuildFiles: build
files:
  - dist-electron/**/*
  - dist-renderer/**/*
  - package.json
extraMetadata:
  main: dist-electron/main/main.js
win:
  target: dir
```

`package.json` scripts 增：

```json
"dist:dir": "pnpm build && electron-builder --dir"
```

依赖：`pnpm -C apps/desktop add -D electron-builder`。

注意：electron-builder 需要二进制产物路径与 `files` 清单一致（dist-electron 保留目录结构：`main/main.js`、`preload.cjs`、`shared/`；`extraMetadata.main` 已指 `dist-electron/main/main.js`，与 `package.json.main` 保持一致）。preload 的 `preload.cjs` 在 `dist-electron` 根——`main.ts` 的 `join(__dirname, "../preload.cjs")` 相对 `dist-electron/main/` 解析为 `dist-electron/preload.cjs`，与 files 清单 `dist-electron/**/*` 匹配。

- [ ] **步骤 2：打包冒烟**

运行：`pnpm -C apps/desktop dist:dir`
预期：`apps/desktop/release/win-unpacked/apicc.exe` 产出。启动冒烟（spawn exe 存活数秒 + 无 FATAL），结果写报告。

- [ ] **步骤 3：收尾清理与提交**

顺带清理（审查遗留）：`components.test.ts:87-88` 陈旧注释（「返回体无 kind」）更新为瘦 DTO 语义；`RequestEditor.vue` "unsaved" 硬编码改走 i18n（`editor.unsaved` 键，两语言补齐）；vue-i18n 确认在 dependencies。

三绿门禁后：

```bash
git add apps/desktop
git commit -m "build(desktop): electron-builder dir 打包冒烟与收尾清理"
```

---

## 自检结果

1. **规格覆盖度（2B 范围）**：用例面板（任务 5）、环境面板含派生（任务 4，规格 §3.1 环境派生 UI）、集合运行+报告（任务 6，规格 §7.2）、导入（任务 7，规格 §7.4 + 计划 1 注 1 的 CLI import）、详细设计与导出（任务 8，规格 §7.5）、打包（任务 9）、ResponseViewer 占位消除（任务 3，计划 1 遗留）、IPC 入参校验（任务 8，宽审查建议）。antd 迁移（任务 1-2，用户指定）。
2. **占位符扫描**：任务 4/6/7 的组件实现以「antd 组件选型 + data-testid 契约 + store 契约 + 测试先行」给出完整行为定义，核心逻辑代码完整；antd API 细节由实现者按 4.x 文档适配（在映射表与约束内）。无 TODO/待定。
3. **类型一致性**：新频道名在 channels.ts 单源；`NodeCreatedDTO`/`DebugOutput.response`/`RunSummaryDTO` 在 shared/types.ts 单源；session 新方法（createEnvironment/setEnvironmentVariables/importProject/locateCollection）与 ipc 分支一一对应。

## 执行注意事项

- 品牌中立：UI 文案、测试数据、包配置（appId 已为 com.autumnharvestc）不得出现竞品品牌名
- 每任务提交前三绿（typecheck/desktop/core），涉 CLI 时加 cli 全量
- antd 4 组件交互测试的选择器策略在任务 2 定型后，任务 3-8 沿用同一策略
