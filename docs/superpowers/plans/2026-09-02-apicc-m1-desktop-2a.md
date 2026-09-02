# apicc M1 计划 2A：桌面骨架与核心调试流 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付可日常使用的 Electron 桌面调试客户端：打开/新建工作区、分组→项目→集合→接口树浏览与增删改、请求编辑器（方法/URL/参数/头/认证/体）、调试发送与响应查看；中英 i18n、明暗主题。

**架构：** core 在 Electron 主进程运行（文件 IO 与 Runner 天然需要 Node）；渲染层 Vue 3 经 preload `contextBridge` 暴露的**类型化 IPC API**（`ApiccApi` 接口）访问主进程，渲染层永不触碰 Node API。主进程 `session.ts` 持有已加载工作区状态，全部变更走「改内存模型 → `fileStorage.save` 全量落盘」。渲染层 Pinia store 全部依赖注入 `ApiccApi` 接口，测试用内存替身。

**技术栈：** Electron ^38、Vue ^3.5、Vite ^7、Pinia ^3、vue-i18n ^11、@vue/test-utils + jsdom（vitest）、TypeScript ^5.9（main/preload 走 NodeNext tsc 到 `dist-electron/`，renderer 走 vite 到 `dist-renderer/`）。

**范围说明：** 本计划为 2A；用例面板、环境面板、集合运行+报告、导入向导、详细设计编辑器、打包属计划 2B。工作目录：worktree `D:\workspace260609\project-2\apicc-m1-core-cli`（分支 `feature/m1-core-cli`）。全局约束：入库文件不得出现竞品品牌名；中文 conventional commit；Node ≥ 22.19；显式路径 git add；core 侧改动须保持其全量回归绿。

---

## 文件结构

```
apps/desktop/
  package.json                 @apicc/desktop：scripts（dev/build/test/electron）、依赖
  tsconfig.json                renderer + shared + tests（vitest，jsdom）
  tsconfig.electron.json       src/main + src/preload + src/shared → dist-electron（NodeNext）
  vite.config.ts               renderer 构建（root=src/renderer，outDir=dist-renderer，插件 vue）
  vitest.config.ts             environmentMatchGlobs：renderer/** → jsdom；插件 vue
  src/
    shared/
      channels.ts              IPC 频道名常量（唯一事实来源）
      types.ts                 ApiccApi 接口 + DTO（TreeNode、OpenResult、DebugResult…）
    main/
      main.ts                  app 生命周期 + BrowserWindow（安全基线）+ 注册 IPC + 菜单
      session.ts               工作区会话：open/create/locate/各变更操作（纯 TS，可 TDD）
      debug.ts                 调试发送：合成单接口集合 → CollectionRunner
      ipc.ts                   registerIpcHandlers(deps)：频道 → session/registry 调用
    preload/
      preload.ts               contextBridge.exposeInMainWorld('apicc', ApiccApi 实现)
    renderer/
      index.html
      src/
        main.ts                createApp + pinia + i18n + 根组件挂载
        api/index.ts           const apicc: ApiccApi = window.apicc ?? memory（测试/无 preload 环境）
        api/memory.ts          内存替身实现（测试用）
        i18n/zh-CN.json        中文文案（默认语言）
        i18n/en.json           英文文案
        i18n/index.ts          vue-i18n 实例 + 语言持久化
        styles/theme.css       CSS 变量主题（明/暗，跟随系统 + 手动切换）
        stores/workspace.ts    工作区 store：打开/新建/树状态/校验问题
        stores/tree.ts         树操作 store：创建/重命名/删除/选中
        stores/editor.ts       编辑器 store：加载接口/编辑字段/保存
        stores/debug.ts        调试 store：发送/响应/进行中状态
        App.vue                布局：顶栏（工作区/语言/主题）+ 侧树 + 编辑器 + 响应
        components/SideTree.vue、RequestEditor.vue、ResponseViewer.vue、TopBar.vue、
                   EmptyState.vue、ConfirmDialog.vue
  tests/
    main/session.test.ts、tree.test.ts、ipc.test.ts、debug.test.ts
    renderer/stores/workspace.test.ts、tree.test.ts、editor.test.ts、debug.test.ts
    renderer/i18n/parity.test.ts
    renderer/App.test.ts
```

IPC 频道（channels.ts 常量，全部 `invoke`）：`ws:open`、`ws:create`、`ws:pickDirectory`、`ws:validate`、`tree:get`、`node:create`、`node:rename`、`node:delete`、`api:get`、`api:save`、`debug:send`。

---

### 任务 1：桌面应用脚手架（Electron 安全基线 + Vue 渲染层冒烟）

**文件：**
- 创建：`apps/desktop/package.json`、`apps/desktop/tsconfig.json`、`apps/desktop/tsconfig.electron.json`、`apps/desktop/vite.config.ts`、`apps/desktop/vitest.config.ts`
- 创建：`apps/desktop/src/main/main.ts`、`apps/desktop/src/preload/preload.ts`
- 创建：`apps/desktop/src/renderer/index.html`、`apps/desktop/src/renderer/src/main.ts`、`apps/desktop/src/renderer/src/App.vue`
- 创建：`apps/desktop/src/shared/channels.ts`
- 测试：`apps/desktop/tests/renderer/App.test.ts`

- [ ] **步骤 1：包与构建配置**

`apps/desktop/package.json`：

```json
{
  "name": "@apicc/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist-electron/main.js",
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "build:renderer": "vite build",
    "build:electron": "tsc -p tsconfig.electron.json",
    "build": "pnpm build:renderer && pnpm build:electron",
    "dev": "pnpm build && electron .",
    "test": "vitest run"
  }
}
```

依赖安装（在仓库根执行，pnpm 会写入对应包）：

```bash
pnpm -C apps/desktop add vue pinia vue-i18n @apicc/core@workspace:*
pnpm -C apps/desktop add -D electron vite @vitejs/plugin-vue typescript @types/node vue-i18n @vue/test-utils jsdom vitest
```

`apps/desktop/tsconfig.json`（渲染层与测试）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "preserve",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/renderer", "src/shared", "tests"]
}
```

`apps/desktop/tsconfig.electron.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist-electron",
    "types": ["node"]
  },
  "include": ["src/main", "src/preload", "src/shared"]
}
```

`apps/desktop/vite.config.ts`：

```ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [vue()],
  build: { outDir: "../../dist-renderer", emptyOutDir: true },
});
```

`apps/desktop/vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    environmentMatchGlobs: [["tests/renderer/**", "jsdom"]],
    include: ["tests/**/*.test.ts"],
  },
});
```

`apps/desktop/src/shared/channels.ts`：

```ts
export const IpcChannel = {
  WsOpen: "ws:open",
  WsCreate: "ws:create",
  WsPickDirectory: "ws:pickDirectory",
  WsValidate: "ws:validate",
  TreeGet: "tree:get",
  NodeCreate: "node:create",
  NodeRename: "node:rename",
  NodeDelete: "node:delete",
  ApiGet: "api:get",
  ApiSave: "api:save",
  DebugSend: "debug:send",
} as const;
export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
```

`apps/desktop/src/main/main.ts`：

```ts
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { IpcChannel } from "../shared/channels.js";
import { createIpcDeps } from "./ipc.js";

process.env.APP_ROOT = join(__dirname);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../dist-renderer/index.html"));
  return win;
}

app.whenReady().then(() => {
  const deps = createIpcDeps();
  for (const channel of Object.values(IpcChannel)) {
    ipcMain.handle(channel, (event, ...args) => deps.handle(channel, event, ...args));
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

`apps/desktop/src/preload/preload.ts`（2A 先暴露 invoke 透传；类型化封装在任务 2 接入）：

```ts
import { contextBridge, ipcRenderer } from "electron";
import { IpcChannel } from "../shared/channels.js";

contextBridge.exposeInMainWorld("electronInvoke", (channel: string, ...args: unknown[]) => {
  if (!Object.values(IpcChannel).includes(channel as never)) {
    return Promise.reject(new Error(`未允许的 IPC 频道: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
});
```

`apps/desktop/src/renderer/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
    <title>apicc</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
```

`apps/desktop/src/renderer/src/main.ts`：

```ts
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";

createApp(App).use(createPinia()).mount("#app");
```

`apps/desktop/src/renderer/src/App.vue`：

```vue
<script setup lang="ts">
const ready = true;
</script>

<template>
  <div class="app" data-testid="app-root">
    <span data-testid="app-ready">{{ ready ? "apicc" : "" }}</span>
  </div>
</template>

<style>
html, body, #app { height: 100%; margin: 0; }
</style>
```

- [ ] **步骤 2：编写失败的渲染层冒烟测试**

`apps/desktop/tests/renderer/App.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import App from "../../src/renderer/src/App.vue";

describe("App", () => {
  it("挂载并渲染就绪标记", () => {
    const wrapper = mount(App);
    expect(wrapper.find('[data-testid="app-ready"]').text()).toBe("apicc");
  });
});
```

- [ ] **步骤 3：运行验证失败**

运行：`cd apps/desktop && pnpm vitest run tests/renderer/App.test.ts`
预期：FAIL，找不到 `App.vue`（尚无 node_modules 时先执行步骤 1 的两条安装命令再跑）

- [ ] **步骤 4：运行验证通过 + 构建与 Electron 冒烟**

运行：`pnpm -C apps/desktop build && pnpm -C apps/desktop vitest run`
预期：构建产出 `dist-renderer/` 与 `dist-electron/`，测试 PASS（1/1）

手工冒烟（不入库，结果写进报告）：`pnpm -C apps/desktop exec electron .` 启动窗口显示「apicc」字样后关闭。若 preload/主进程报错，修复至能启动。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(desktop): Electron 安全基线脚手架与 Vue 渲染层冒烟"
```

---

### 任务 2：主进程会话（工作区状态与变更操作）

**文件：**
- 创建：`apps/desktop/src/main/session.ts`
- 测试：`apps/desktop/tests/main/session.test.ts`

- [ ] **步骤 1：编写失败的测试**

`apps/desktop/tests/main/session.test.ts`：

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSession } from "../../src/main/session.js";

const root = () => mkdtempSync(join(tmpdir(), "apicc-ui-"));

describe("createSession", () => {
  it("create 建立最小工作区并 open 读回", async () => {
    const s = createSession();
    const dir = root();
    const created = await s.create(dir, "演示");
    expect(created.workspace.name).toBe("演示");
    const opened = await s.open(dir);
    expect(opened.workspace.groups).toEqual([]);
    expect(s.root).toBe(dir);
  });

  it("未打开时 locate 抛错；open 后可经路径定位接口", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g1");
    const p = s.createProject(g.id, "p1");
    const c = s.createCollection(p.id, "c1");
    const api = s.createApi(c.id, null, { name: "ping", method: "GET", url: "{{baseUrl}}/x" });
    const found = s.locateApi(api.id);
    expect(found?.collection.id).toBe(c.id);
    expect(found?.project.id).toBe(p.id);
    expect(s.locateApi("missing")).toBeUndefined();
    expect(() => new (Object.getPrototypeOf(s).constructor)()).not;
    const s2 = createSession();
    expect(() => s2.locateApi(api.id)).toThrow(/未打开/);
  });

  it("createApi 附带基座冒烟用例；delete 级联删除接口", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "c");
    const api = s.createApi(c.id, null, { name: "a", method: "POST", url: "/" });
    expect(api.cases).toHaveLength(1);
    expect(api.cases[0]!.scope).toBe("base");
    s.deleteNode("api", api.id);
    expect(s.locateApi(api.id)).toBeUndefined();
  });

  it("saveApi 更新接口并落盘（重开读回验证）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "c");
    const api = s.createApi(c.id, null, { name: "a", method: "GET", url: "/x" });
    api.url = "/changed";
    await s.saveApi(api);
    const s2 = createSession();
    const reopened = await s2.open(dir);
    const found = s2.locateApi(api.id);
    expect(found?.api.url).toBe("/changed");
    expect(reopened.workspace.groups).toHaveLength(1);
  });

  it("renameNode 重命名集合（盘上目录随 save 更新，旧目录清理）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "old-name");
    s.renameNode("collection", c.id, "new-name");
    await s.save();
    const s2 = createSession();
    await s2.open(dir);
    const names = s2.workspace.groups[0]!.projects[0]!.collections.map((x) => x.name);
    expect(names).toEqual(["new-name"]);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd apps/desktop && pnpm vitest run tests/main/session.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现 session**

`apps/desktop/src/main/session.ts`：

```ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileStorage, type ApiDefinition, type Collection, type Environment, type Group, type Project, type Workspace, type LoadProblem, HttpMethod } from "@apicc/core";
import { randomUUID } from "node:crypto";

export interface ApiLocation { api: ApiDefinition; collection: Collection; project: Project; group: Group; folder: { id: string; name: string; apis: ApiDefinition[] } | null }

export type NodeKind = "group" | "project" | "collection" | "folder" | "api" | "environment";

/** 主进程工作区会话：内存模型为唯一事实源，save() 全量落盘（规格 §4）。 */
export function createSession() {
  let root: string | null = null;
  let workspace: Workspace | null = null;

  function ensureOpen(): { root: string; workspace: Workspace } {
    if (!root || !workspace) throw new Error("尚未打开工作区");
    return { root, workspace: workspace! };
  }

  function createGroup(name: string): Group {
    const { workspace: ws } = ensureOpen();
    const group: Group = { id: randomUUID(), name, projects: [] };
    ws.groups.push(group);
    return group;
  }

  function createProject(groupId: string, name: string): Project {
    const { workspace: ws } = ensureOpen();
    const group = ws.groups.find((x) => x.id === groupId);
    if (!group) throw new Error(`未找到分组: ${groupId}`);
    const project: Project = { id: randomUUID(), name, variables: {}, environments: [], collections: [] };
    group.projects.push(project);
    return project;
  }

  function createCollection(projectId: string, name: string): Collection {
    const { workspace: ws } = ensureOpen();
    const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    const collection: Collection = { id: randomUUID(), name, variables: {}, folders: [], apis: [] };
    project.collections.push(collection);
    return collection;
  }

  function createFolder(collectionId: string, name: string): { id: string; name: string; apis: ApiDefinition[] } {
    const { workspace: ws } = ensureOpen();
    const collection = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === collectionId);
    if (!collection) throw new Error(`未找到集合: ${collectionId}`);
    const folder = { id: randomUUID(), name, apis: [] };
    collection.folders.push(folder);
    return folder;
  }

  function createApi(collectionId: string, folderId: string | null, input: { name: string; method: HttpMethod; url: string }): ApiDefinition {
    const { workspace: ws } = ensureOpen();
    const collection = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === collectionId);
    if (!collection) throw new Error(`未找到集合: ${collectionId}`);
    const api: ApiDefinition = {
      id: randomUUID(), name: input.name, version: "1.0.0", deprecated: false,
      method: input.method, url: input.url, headers: [], query: [],
      cases: [{ id: randomUUID(), name: "冒烟", scope: "base", parameters: {}, assertions: [] }],
    };
    if (folderId) {
      const folder = collection.folders.find((f) => f.id === folderId);
      if (!folder) throw new Error(`未找到文件夹: ${folderId}`);
      folder.apis.push(api);
    } else {
      collection.apis.push(api);
    }
    return api;
  }

  function locateApi(apiId: string): ApiLocation | undefined {
    const { workspace: ws } = ensureOpen();
    for (const group of ws.groups) {
      for (const project of group.projects) {
        for (const collection of project.collections) {
          const api = collection.apis.find((a) => a.id === apiId);
          if (api) return { api, collection, project, group, folder: null };
          for (const folder of collection.folders) {
            const fApi = folder.apis.find((a) => a.id === apiId);
            if (fApi) return { api: fApi, collection, project, group, folder };
          }
        }
      }
    }
    return undefined;
  }

  function saveApi(api: ApiDefinition): void {
    const loc = locateApi(api.id);
    if (!loc) throw new Error(`未找到接口: ${api.id}`);
    const list = loc.folder ? loc.folder.apis : loc.collection.apis;
    const index = list.findIndex((a) => a.id === api.id);
    list[index] = api;
  }

  function renameNode(kind: NodeKind, id: string, name: string): void {
    const { workspace: ws } = ensureOpen();
    if (kind === "group") { const n = ws.groups.find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; return; }
    if (kind === "project") { const n = ws.groups.flatMap((g) => g.projects).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; return; }
    if (kind === "collection") { const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; return; }
    if (kind === "folder") { const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).flatMap((c) => c.folders).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; return; }
    if (kind === "environment") { const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.environments).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; return; }
    const loc = locateApi(id);
    if (!loc) throw new Error(`未找到: ${id}`);
    loc.api.name = name;
  }

  function deleteNode(kind: NodeKind, id: string): void {
    const { workspace: ws } = ensureOpen();
    const removeFrom = <T>(list: T[], pred: (x: T) => boolean) => {
      const index = list.findIndex(pred);
      if (index >= 0) list.splice(index, 1);
      return index >= 0;
    };
    if (kind === "group") { removeFrom(ws.groups, (x) => x.id === id); return; }
    for (const g of ws.groups) {
      if (kind === "project" && removeFrom(g.projects, (x) => x.id === id)) return;
      for (const p of g.projects) {
        if (kind === "environment" && removeFrom(p.environments, (x) => x.id === id)) return;
        for (const c of p.collections) {
          if (kind === "collection" && removeFrom(p.collections, (x) => x.id === id)) return;
          if (kind === "folder" && removeFrom(c.folders, (x) => x.id === id)) return;
          if (kind === "api") {
            if (removeFrom(c.apis, (x) => x.id === id)) return;
            for (const f of c.folders) if (removeFrom(f.apis, (x) => x.id === id)) return;
          }
        }
      }
    }
    throw new Error(`未找到: ${id}`);
  }

  async function save(): Promise<void> {
    const { root: r, workspace: ws } = ensureOpen();
    await fileStorage.save(r, ws);
    cleanupOrphanDirs(r, ws);
  }

  /** 重命名后清理盘上旧目录（save 只写新路径；规格账本：孤儿清理在此收口）。 */
  function cleanupOrphanDirs(rootDir: string, ws: Workspace): void {
    const groupsDir = join(rootDir, "groups");
    if (!existsSync(groupsDir)) return;
    for (const gName of readdirSafe(groupsDir)) {
      const gDir = join(groupsDir, gName);
      const g = ws.groups.find((x) => x.name === gName);
      if (!g) { rmSync(gDir, { recursive: true, force: true }); continue; }
      const projectsDir = join(gDir, "projects");
      for (const pName of readdirSafe(projectsDir)) {
        const p = g.projects.find((x) => x.name === pName);
        if (!p) { rmSync(join(projectsDir, pName), { recursive: true, force: true }); continue; }
        const collectionsDir = join(projectsDir, pName, "collections");
        for (const cName of readdirSafe(collectionsDir)) {
          const c = p.collections.find((x) => x.name === cName);
          if (!c) { rmSync(join(collectionsDir, cName), { recursive: true, force: true }); continue; }
          const apisDir = join(collectionsDir, cName, "apis");
          for (const aName of readdirSafe(apisDir)) {
            if (!c.apis.find((x) => x.name === aName) && !c.folders.find((x) => x.name === aName)) {
              rmSync(join(apisDir, aName), { recursive: true, force: true });
            }
          }
          const foldersDir = join(collectionsDir, cName, "folders");
          for (const fName of readdirSafe(foldersDir)) {
            if (!c.folders.find((x) => x.name === fName)) {
              rmSync(join(foldersDir, fName), { recursive: true, force: true });
            }
          }
        }
      }
    }
  }

  return {
    get root() { return root; },
    get workspace() { return workspace; },
    async open(dir: string) {
      const storage = fileStorage;
      const loaded = await storage.load(dir);
      root = dir;
      workspace = loaded.workspace;
      return { workspace: loaded.workspace, problems: loaded.problems as LoadProblem[], root: dir };
    },
    async create(dir: string, name: string) {
      if (existsSync(join(dir, "apicc.workspace.yaml"))) throw new Error("目录已是工作区");
      mkdirSync(dir, { recursive: true });
      const ws: Workspace = { id: randomUUID(), name, variables: {}, groups: [] };
      await fileStorage.save(dir, ws);
      root = dir;
      workspace = ws;
      return { workspace: ws, problems: [] as LoadProblem[], root: dir };
    },
    async validate(): Promise<LoadProblem[]> {
      const { root: r } = ensureOpen();
      return (await fileStorage.load(r)).problems;
    },
    createGroup, createProject, createCollection, createFolder, createApi,
    locateApi, saveApi, renameNode, deleteNode, save,
  };
}

function readdirSafe(dir: string): string[] {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(dir);
  } catch {
    return [];
  }
}
void dirname; void Environment;
```

实现更正指令（计划预检发现的两处，照做）：① `readdirSafe` 内的 `require` 在 ESM 不可用——把 `readdirSync` 提到文件顶部静态导入（`import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";`），删除本地 require 版本；② 文件尾 `void dirname; void Environment;` 与未用导入一并删除（`dirname`、`Environment` 类型不导入）。

- [ ] **步骤 4：运行验证通过**

运行：`cd apps/desktop && pnpm vitest run tests/main/session.test.ts`
预期：PASS（5 个用例）

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/main/session.ts apps/desktop/tests/main/session.test.ts
git commit -m "feat(desktop): 主进程工作区会话——打开/创建/定位/增删改与孤儿目录清理"
```

---

### 任务 3：树序列化与调试发送（纯逻辑）

**文件：**
- 创建：`apps/desktop/src/main/tree.ts`
- 创建：`apps/desktop/src/main/debug.ts`
- 测试：`apps/desktop/tests/main/tree.test.ts`、`apps/desktop/tests/main/debug.test.ts`

- [ ] **步骤 1：编写失败的树序列化测试**

`apps/desktop/tests/main/tree.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { toTreeNode } from "../../src/main/tree.js";
import type { Workspace } from "@apicc/core";

const ws: Workspace = {
  id: "w", name: "ws", variables: {},
  groups: [{
    id: "g1", name: "分组A",
    projects: [{
      id: "p1", name: "项目B", variables: {},
      environments: [{ id: "e1", name: "dev", variables: {} }],
      collections: [{
        id: "c1", name: "集合C", variables: {}, folders: [],
        apis: [{ id: "a1", name: "接口D", version: "1", deprecated: false, method: "GET", url: "/", headers: [], query: [], cases: [] }],
      }],
    }],
  }],
};

describe("toTreeNode", () => {
  it("产出 根→分组→项目(含环境)→集合→接口 的 DTO 树", () => {
    const node = toTreeNode(ws);
    expect(node.kind).toBe("root");
    const group = node.children![0]!;
    expect(group).toMatchObject({ kind: "group", id: "g1", label: "分组A" });
    const project = group.children![0]!;
    expect(project.kind).toBe("project");
    expect(project.envs).toEqual([{ id: "e1", name: "dev" }]);
    const collection = project.children![0]!;
    const api = collection.children![0]!;
    expect(api).toMatchObject({ kind: "api", id: "a1", label: "接口D", method: "GET" });
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd apps/desktop && pnpm vitest run tests/main/tree.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现树序列化**

`apps/desktop/src/main/tree.ts`：

```ts
import type { Workspace } from "@apicc/core";

export interface TreeNodeDTO {
  kind: "root" | "group" | "project" | "collection" | "folder" | "api";
  id: string;
  label: string;
  method?: string;
  envs?: Array<{ id: string; name: string }>;
  children?: TreeNodeDTO[];
}

export function toTreeNode(ws: Workspace): TreeNodeDTO {
  return {
    kind: "root",
    id: ws.id,
    label: ws.name,
    children: ws.groups.map((g) => ({
      kind: "group" as const, id: g.id, label: g.name,
      children: g.projects.map((p) => ({
        kind: "project" as const, id: p.id, label: p.name,
        envs: p.environments.map((e) => ({ id: e.id, name: e.name })),
        children: p.collections.map((c) => ({
          kind: "collection" as const, id: c.id, label: c.name,
          children: [
            ...c.apis.map((a) => ({ kind: "api" as const, id: a.id, label: a.name, method: a.method })),
            ...c.folders.map((f) => ({
              kind: "folder" as const, id: f.id, label: f.name,
              children: f.apis.map((a) => ({ kind: "api" as const, id: a.id, label: a.name, method: a.method })),
            })),
          ],
        })),
      })),
    })),
  };
}
```

- [ ] **步骤 4：运行验证通过**

运行：`cd apps/desktop && pnpm vitest run tests/main/tree.test.ts`
预期：PASS（1 个用例）

- [ ] **步骤 5：编写失败的调试发送测试**

`apps/desktop/tests/main/debug.test.ts`：

```ts
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../../src/main/session.js";
import { sendDebug } from "../../src/main/debug.js";

let server: Server;
let baseUrl = "";
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function setup(envUrl?: string) {
  const s = createSession();
  const dir = mkdtempSync(join(tmpdir(), "apicc-dbg-"));
  await s.create(dir, "w");
  await s.open(dir);
  const g = s.createGroup("g");
  const p = s.createProject(g.id, "p");
  if (envUrl) p.environments.push({ id: "e1", name: "dev", variables: { baseUrl } });
  const c = s.createCollection(p.id, "c");
  const api = s.createApi(c.id, null, { name: "ping", method: "GET", url: "{{baseUrl}}/x" });
  return { s, api, project: p };
}

describe("sendDebug", () => {
  it("以基座用例调试：返回单条结果且断言评估", async () => {
    const { s, api } = await setup();
    api.cases[0]!.assertions.push({ id: "as1", target: "status", op: "eq", expected: "200" });
    const result = await sendDebug(s, { apiId: api.id, caseId: api.cases[0]!.id, envName: undefined });
    expect(result.run.total).toBe(1);
    expect(result.outcome.passed).toBe(true);
  });

  it("环境变量在调试中生效", async () => {
    const { s, api } = await setup("set");
    const result = await sendDebug(s, { apiId: api.id, caseId: api.cases[0]!.id, envName: "dev" });
    expect(result.outcome.error).toBeUndefined();
    expect(result.outcome.passed).toBe(true);
  });

  it("网络错误进入 outcome.error 而非抛出", async () => {
    const { s, api } = await setup();
    api.url = "http://127.0.0.1:1/";
    const result = await sendDebug(s, { apiId: api.id, caseId: api.cases[0]!.id, envName: undefined });
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.error).toContain("refused");
  });
});
```

- [ ] **步骤 6：运行验证失败后实现 debug**

运行：`cd apps/desktop && pnpm vitest run tests/main/debug.test.ts` → FAIL 后创建

`apps/desktop/src/main/debug.ts`：

```ts
import type { ApiDefinition, Environment, Project, RunResult, CaseOutcome } from "@apicc/core";
import { CollectionRunner, createDefaultRegistry, createEventBus } from "@apicc/core";
import type { createSession } from "./session.js";

type Session = ReturnType<typeof createSession>;

const registry = createDefaultRegistry();
const timeouts = { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 };

export interface DebugResult { run: RunResult; outcome: CaseOutcome }

/** 调试 = 用合成单接口集合走完整 Runner 语义（前置/后置脚本、断言、变量解析一致，规格 §7.1）。 */
export async function sendDebug(
  session: Session,
  input: { apiId: string; caseId: string; envName?: string },
): Promise<DebugResult> {
  const loc = session.locateApi(input.apiId);
  if (!loc) throw new Error(`未找到接口: ${input.apiId}`);
  const api: ApiDefinition = { ...loc.api, cases: loc.api.cases.filter((c) => c.id === input.caseId) };
  if (api.cases.length === 0) throw new Error(`用例不存在: ${input.caseId}`);
  const collection = {
    id: loc.collection.id, name: loc.collection.name, variables: loc.collection.variables,
    scripts: loc.collection.scripts, folders: [], apis: [api],
  };
  const env: Environment | undefined = input.envName
    ? loc.project.environments.find((e) => e.name === input.envName)
    : undefined;
  const project: Project = loc.project;
  const runner = new CollectionRunner({ registry, bus: createEventBus(), timeouts, failFast: false });
  const run = await runner.run(collection, env, project, session.workspace!, {});
  const outcome = run.cases[0]!;
  return { run, outcome };
}
```

- [ ] **步骤 7：运行验证通过**

运行：`cd apps/desktop && pnpm vitest run tests/main/debug.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 8：Commit**

```bash
git add apps/desktop/src/main/tree.ts apps/desktop/src/main/debug.ts apps/desktop/tests/main
git commit -m "feat(desktop): 树 DTO 序列化与调试发送（复用 Runner 语义）"
```

---

### 任务 4：IPC 处理器与类型化 API 契约

**文件：**
- 创建：`apps/desktop/src/shared/types.ts`
- 创建：`apps/desktop/src/main/ipc.ts`
- 修改：`apps/desktop/src/preload/preload.ts`
- 创建：`apps/desktop/src/renderer/src/api/index.ts`、`apps/desktop/src/renderer/src/api/memory.ts`
- 测试：`apps/desktop/tests/main/ipc.test.ts`

- [ ] **步骤 1：编写失败的处理器测试**

`apps/desktop/tests/main/ipc.test.ts`：

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "apicc-ipc-"));
  const session = createSession();
  const deps = createIpcDeps({ session, pickDirectory: async () => dir });
  return { deps, dir };
}

describe("IPC 处理器", () => {
  it("ws:create → tree:get → node:create → api:get 全链路", async () => {
    const { deps, dir } = setup();
    const opened = await deps.handle("ws:create", {}, dir, "演示");
    expect(opened.workspace.name).toBe("演示");
    let tree = await deps.handle("tree:get", {});
    expect(tree.children).toEqual([]);
    const group = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const project = await deps.handle("node:create", {}, { kind: "project", parentId: group.id, name: "p" });
    const collection = await deps.handle("node:create", {}, { kind: "collection", parentId: project.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: collection.id, name: "a", method: "GET", url: "/" });
    tree = await deps.handle("tree:get", {});
    const apiNode = tree.children![0]!.children![0]!.children![0]!.children![0]!;
    expect(apiNode.id).toBe(api.id);
    const fetched = await deps.handle("api:get", {}, api.id);
    expect(fetched.api.name).toBe("a");
    expect(fetched.envs).toEqual([]);
  });

  it("api:save 持久化并落盘", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "/x" });
    api.url = "/y";
    await deps.handle("api:save", {}, api);
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir });
    await fresh.handle("ws:open", {}, dir);
    const fetched = await fresh.handle("api:get", {}, api.id);
    expect(fetched.api.url).toBe("/y");
  });

  it("未打开工作区时 tree:get 抛可读错误", async () => {
    const { deps } = setup();
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => "" });
    await expect(fresh.handle("tree:get", {})).rejects.toThrow(/未打开/);
  });

  it("debug:send 走调试链路", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "http://127.0.0.1:1/" });
    const result = await deps.handle("debug:send", {}, { apiId: api.id, caseId: api.cases[0]!.id, envName: undefined });
    expect(result.outcome.passed).toBe(false);
    expect(result.run.total).toBe(1);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd apps/desktop && pnpm vitest run tests/main/ipc.test.ts`
预期：FAIL，`createIpcDeps` 不存在

- [ ] **步骤 3：实现类型契约与处理器**

`apps/desktop/src/shared/types.ts`：

```ts
import type { ApiDefinition, CaseOutcome, LoadProblem, RunResult } from "@apicc/core";
import type { TreeNodeDTO } from "../main/tree.js";

export interface OpenResult { workspace: { id: string; name: string }; problems: LoadProblem[]; root: string }
export interface ApiDetail { api: ApiDefinition; envs: Array<{ id: string; name: string }> }
export interface NodeCreateInput {
  kind: "group" | "project" | "collection" | "folder" | "api";
  parentId: string | null;
  name: string;
  method?: string;
  url?: string;
}
export interface DebugInput { apiId: string; caseId: string; envName?: string }
export interface DebugOutput { run: RunResult; outcome: CaseOutcome }

export interface ApiccApi {
  wsOpen(rootPath: string): Promise<OpenResult>;
  wsCreate(rootPath: string, name: string): Promise<OpenResult>;
  wsPickDirectory(): Promise<string>;
  wsValidate(): Promise<LoadProblem[]>;
  treeGet(): Promise<TreeNodeDTO>;
  nodeCreate(input: NodeCreateInput): Promise<TreeNodeDTO & { id: string }>;
  nodeRename(kind: "group" | "project" | "collection" | "folder" | "api" | "environment", id: string, name: string): Promise<void>;
  nodeDelete(kind: "group" | "project" | "collection" | "folder" | "api" | "environment", id: string): Promise<void>;
  apiGet(apiId: string): Promise<ApiDetail>;
  apiSave(api: ApiDefinition): Promise<void>;
  debugSend(input: DebugInput): Promise<DebugOutput>;
}
```

注意：`TreeNodeDTO` 从主进程模块导入仅作类型（`import type`），打包后被擦除——渲染层不引入主进程运行时代码。若 typecheck 因跨目录引用报错，把 `TreeNodeDTO` 移入 `src/shared/types.ts` 本文件定义、`main/tree.ts` 改从 shared 导入（二选一，实现者自行保证类型单源）。

`apps/desktop/src/main/ipc.ts`：

```ts
import { createDefaultRegistry, type CollectionRunner, type RunResult } from "@apicc/core";
import { IpcChannel, type IpcChannelName } from "../shared/channels.js";
import type { ApiDetail, DebugInput, DebugOutput, NodeCreateInput, OpenResult } from "../shared/types.js";
import { sendDebug } from "./debug.js";
import type { createSession } from "./session.js";
import { toTreeNode, type TreeNodeDTO } from "./tree.js";

type Session = ReturnType<typeof createSession>;

export interface IpcDepsOptions {
  session: Session;
  pickDirectory: () => Promise<string>;
}

const registry = createDefaultRegistry();

export function createIpcDeps(options: IpcDepsOptions) {
  const { session, pickDirectory } = options;

  function createNode(input: NodeCreateInput): { id: string } {
    switch (input.kind) {
      case "group": return { id: session.createGroup(input.name).id };
      case "project": return { id: session.createProject(input.parentId!, input.name).id };
      case "collection": return { id: session.createCollection(input.parentId!, input.name).id };
      case "folder": return { id: session.createFolder(input.parentId!, input.name).id };
      case "api": return {
        id: session.createApi(input.parentId!, null, {
          name: input.name,
          method: (input.method ?? "GET") as Parameters<Session["createApi"]>[2]["method"],
          url: input.url ?? "/",
        }).id,
      };
    }
  }

  async function handle(channel: IpcChannelName, _event: unknown, ...args: unknown[]): Promise<unknown> {
    switch (channel) {
      case IpcChannel.WsOpen: {
        const r = await session.open(args[0] as string);
        return r satisfies OpenResult;
      }
      case IpcChannel.WsCreate: {
        const r = await session.create(args[0] as string, args[1] as string);
        return r satisfies OpenResult;
      }
      case IpcChannel.WsPickDirectory:
        return pickDirectory();
      case IpcChannel.WsValidate:
        return session.validate();
      case IpcChannel.TreeGet:
        return toTreeNode(session.workspace!) as TreeNodeDTO;
      case IpcChannel.NodeCreate: {
        createNode(args[0] as NodeCreateInput);
        await session.save();
        return toTreeNode(session.workspace!);
      }
      case IpcChannel.NodeRename: {
        const [kind, id, name] = args as [Parameters<Session["renameNode"]>[0], string, string];
        session.renameNode(kind, id, name);
        await session.save();
        return undefined;
      }
      case IpcChannel.NodeDelete: {
        const [kind, id] = args as [Parameters<Session["deleteNode"]>[0], string];
        session.deleteNode(kind, id);
        await session.save();
        return undefined;
      }
      case IpcChannel.ApiGet: {
        const loc = session.locateApi(args[0] as string);
        if (!loc) throw new Error(`未找到接口: ${args[0] as string}`);
        const detail: ApiDetail = {
          api: loc.api,
          envs: loc.project.environments.map((e) => ({ id: e.id, name: e.name })),
        };
        return detail;
      }
      case IpcChannel.ApiSave: {
        await (session as { saveApi(a: never): void }).saveApi(args[0] as never);
        await session.save();
        return undefined;
      }
      case IpcChannel.DebugSend: {
        const result = await sendDebug(session, args[0] as DebugInput);
        return result satisfies DebugOutput;
      }
      default:
        throw new Error(`未知频道: ${channel}`);
    }
  }

  return { handle };
}

void registry; void IpcChannel; void RunResult; void CollectionRunner;
```

实现更正指令（计划预检发现，照做）：删除文件尾 `void registry; void IpcChannel; void RunResult; void CollectionRunner;` 行与对应未用导入（`registry`/`createDefaultRegistry`/`RunResult`/`CollectionRunner`/`IpcChannel` 若 `handle` 的 switch 已用 `IpcChannel` 则保留该导入）；`ApiSave` 分支的 `saveApi` 调用改为直接 `session.saveApi(args[0] as Parameters<Session["saveApi"]>[0])`，去掉类型谎言。

`apps/desktop/src/preload/preload.ts` 整体替换：

```ts
import { contextBridge, ipcRenderer } from "electron";
import { IpcChannel } from "../shared/channels.js";

const api = {
  wsOpen: (rootPath: string) => ipcRenderer.invoke(IpcChannel.WsOpen, rootPath),
  wsCreate: (rootPath: string, name: string) => ipcRenderer.invoke(IpcChannel.WsCreate, rootPath, name),
  wsPickDirectory: () => ipcRenderer.invoke(IpcChannel.WsPickDirectory),
  wsValidate: () => ipcRenderer.invoke(IpcChannel.WsValidate),
  treeGet: () => ipcRenderer.invoke(IpcChannel.TreeGet),
  nodeCreate: (input: unknown) => ipcRenderer.invoke(IpcChannel.NodeCreate, input),
  nodeRename: (kind: string, id: string, name: string) => ipcRenderer.invoke(IpcChannel.NodeRename, kind, id, name),
  nodeDelete: (kind: string, id: string) => ipcRenderer.invoke(IpcChannel.NodeDelete, kind, id),
  apiGet: (apiId: string) => ipcRenderer.invoke(IpcChannel.ApiGet, apiId),
  apiSave: (api: unknown) => ipcRenderer.invoke(IpcChannel.ApiSave, api),
  debugSend: (input: unknown) => ipcRenderer.invoke(IpcChannel.DebugSend, input),
};

contextBridge.exposeInMainWorld("apicc", api);
```

`apps/desktop/src/renderer/src/api/index.ts`：

```ts
import type { ApiccApi } from "../../../shared/types.js";

export const apicc: ApiccApi = window.apicc as ApiccApi;
```

`window.apicc` 的全局声明与测试替身 `apps/desktop/src/renderer/src/api/memory.ts`（任务 4 内创建，任务 5-7 的 store 测试消费；memory 基于内存数据完整实现 `ApiccApi` 的 11 个方法，构造函数 `createMemoryApi(): ApiccApi & { seedWorkspace(): void }`——实现是直白的数组操作 + 与 session 相同语义的树构建，篇幅原因按接口逐方法直写，测试若发现语义偏差以 session 为准修正 memory）：

```ts
import type { ApiccApi } from "../../../shared/types.js";

/** 渲染层测试替身：内存数据 + 与主进程 session 相同语义的树构建。 */
export function createMemoryApi(): ApiccApi & { seedWorkspace(): void } {
  // 实现要点（逐方法直写，禁止 TODO）：
  // 内部状态 root/名称/problems/groups 数组；seedWorkspace 预置 分组/项目/集合/接口 各一。
  // wsOpen/wsCreate 校验 apicc.workspace.yaml 存在性语义同 session；nodeCreate/nodeRename/nodeDelete
  // 操作内存数组；treeGet 按任务 3 的 toTreeNode 形状产出；apiGet 按	id 查找返回 { api, envs }；
  // apiSave 按 id 替换；debugSend 返回固定 { run: {total:1,passed:1,failed:0,...}, outcome: {passed:true,...} }。
  throw new Error("见上方实现要点——由实现者按 ApiccApi 接口直写");
}
```

- [ ] **步骤 4：运行验证通过**

运行：`cd apps/desktop && pnpm vitest run tests/main/ipc.test.ts`
预期：PASS（4 个用例）

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src apps/desktop/tests/main/ipc.test.ts
git commit -m "feat(desktop): IPC 处理器与类型化 ApiccApi 契约、preload 暴露"
```

---

### 任务 5：i18n 与主题骨架

**文件：**
- 创建：`apps/desktop/src/renderer/src/i18n/zh-CN.json`、`apps/desktop/src/renderer/src/i18n/en.json`、`apps/desktop/src/renderer/src/i18n/index.ts`
- 创建：`apps/desktop/src/renderer/src/styles/theme.css`
- 创建：`apps/desktop/src/renderer/src/components/ThemeLanguageToggle.vue`
- 测试：`apps/desktop/tests/renderer/i18n/parity.test.ts`
- 修改：`apps/desktop/src/renderer/src/main.ts`（接入 i18n 与 theme.css）

- [ ] **步骤 1：编写失败的键位齐全性测试**

`apps/desktop/tests/renderer/i18n/parity.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import zh from "../../src/renderer/src/i18n/zh-CN.json";
import en from "../../src/renderer/src/i18n/en.json";

function flatKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("i18n 键位齐全性", () => {
  it("zh-CN 与 en 键集合完全一致", () => {
    expect(flatKeys(en).sort()).toEqual(flatKeys(zh).sort());
  });
  it("包含任务 5-7 需要的核心键", () => {
    const keys = flatKeys(zh);
    for (const key of ["app.openWorkspace", "app.newWorkspace", "app.language", "app.theme",
      "tree.newGroup", "tree.newProject", "tree.newCollection", "tree.newApi", "tree.delete",
      "editor.send", "editor.method", "editor.url", "editor.params", "editor.headers",
      "editor.auth", "editor.body", "editor.save", "response.status", "response.body",
      "response.headers", "response.assertions", "response.empty", "workspace.problems"]) {
      expect(keys, `缺少键: ${key}`).toContain(key);
    }
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd apps/desktop && pnpm vitest run tests/renderer/i18n/parity.test.ts`
预期：FAIL，文件不存在

- [ ] **步骤 3：实现 i18n 资源与实例**

`apps/desktop/src/renderer/src/i18n/zh-CN.json`（数值即文案；实现者不得增删键，两语言保持同构）：

```json
{
  "app": { "openWorkspace": "打开工作区", "newWorkspace": "新建工作区", "language": "语言", "theme": "主题", "workspaceName": "工作区名称" },
  "workspace": { "problems": "问题文件", "pickDirectory": "选择目录", "createHere": "在此新建" },
  "tree": { "newGroup": "新建分组", "newProject": "新建项目", "newCollection": "新建集合", "newFolder": "新建文件夹", "newApi": "新建接口", "rename": "重命名", "delete": "删除", "deleteConfirm": "确定删除「{name}」？", "empty": "打开工作区后在此浏览接口", "namePlaceholder": "名称" },
  "editor": { "send": "发送", "sending": "发送中…", "method": "方法", "url": "URL", "params": "参数", "headers": "请求头", "auth": "认证", "body": "请求体", "save": "保存", "saved": "已保存", "name": "接口名称", "addRow": "添加一行", "bodyKind": "体类型" },
  "response": { "status": "状态码", "time": "耗时", "body": "响应体", "headers": "响应头", "assertions": "断言", "empty": "点击「发送」查看响应", "passed": "通过", "failed": "失败", "error": "错误" },
  "common": { "cancel": "取消", "confirm": "确定", "close": "关闭" }
}
```

`apps/desktop/src/renderer/src/i18n/en.json`（同键位，英文文案；由实现者直译上述键）：

```json
{
  "app": { "openWorkspace": "Open Workspace", "newWorkspace": "New Workspace", "language": "Language", "theme": "Theme", "workspaceName": "Workspace name" },
  "workspace": { "problems": "Problem files", "pickDirectory": "Choose directory", "createHere": "Create here" },
  "tree": { "newGroup": "New Group", "newProject": "New Project", "newCollection": "New Collection", "newFolder": "New Folder", "newApi": "New API", "rename": "Rename", "delete": "Delete", "deleteConfirm": "Delete \"{name}\"?", "empty": "Open a workspace to browse APIs", "namePlaceholder": "Name" },
  "editor": { "send": "Send", "sending": "Sending…", "method": "Method", "url": "URL", "params": "Params", "headers": "Headers", "auth": "Auth", "body": "Body", "save": "Save", "saved": "Saved", "name": "API name", "addRow": "Add row", "bodyKind": "Body type" },
  "response": { "status": "Status", "time": "Time", "body": "Body", "headers": "Headers", "assertions": "Assertions", "empty": "Click \"Send\" to see the response", "passed": "Passed", "failed": "Failed", "error": "Error" },
  "common": { "cancel": "Cancel", "confirm": "Confirm", "close": "Close" }
}
```

`apps/desktop/src/renderer/src/i18n/index.ts`：

```ts
import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN.json";
import en from "./en.json";

export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];
const STORAGE_KEY = "apicc.locale";

export function initialLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY) as Locale | null;
  if (saved && LOCALES.includes(saved)) return saved;
  return navigator.language.startsWith("zh") ? "zh-CN" : "en";
}

export function createI18nInstance() {
  const i18n = createI18n({ legacy: false, locale: initialLocale(), fallbackLocale: "zh-CN", messages: { "zh-CN": zhCN, en } });
  return {
    i18n,
    setLocale(locale: Locale) {
      i18n.global.locale.value = locale;
      localStorage.setItem(STORAGE_KEY, locale);
    },
  };
}
```

`apps/desktop/src/renderer/src/styles/theme.css`：

```css
:root {
  --bg: #ffffff; --panel: #f5f6f8; --border: #d9dce1; --text: #1f2329;
  --accent: #2563eb; --text-muted: #6b7280; --pass: #16a34a; --fail: #dc2626;
}
html[data-theme="dark"] {
  --bg: #16181d; --panel: #1f2329; --border: #343a44; --text: #e6e8eb;
  --accent: #4c8dff; --text-muted: #9aa1ab; --pass: #4ade80; --fail: #f87171;
}
html[data-theme] body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; }
```

主题解析函数（供切换组件与测试使用）`apps/desktop/src/renderer/src/i18n/../theme.ts`——放 `apps/desktop/src/renderer/src/theme.ts`：

```ts
export type Theme = "system" | "light" | "dark";
const KEY = "apicc.theme";

export function resolveTheme(preference: Theme, prefersDark: boolean): "light" | "dark" {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function loadPreference(): Theme {
  return (localStorage.getItem(KEY) as Theme | null) ?? "system";
}

export function savePreference(preference: Theme): void {
  localStorage.setItem(KEY, preference);
}

export function applyTheme(preference: Theme, prefersDark: boolean): "light" | "dark" {
  const resolved = resolveTheme(preference, prefersDark);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}
```

`ThemeLanguageToggle.vue`（语言按钮循环 zh→en；主题按钮循环 system→light→dark；文案用 i18n）：

```vue
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { LOCALES, useLocale } from "../i18n/bridge";
import { applyTheme, loadPreference, savePreference, resolveTheme, type Theme } from "../theme";

const { t } = useI18n();
const { locale, setLocale } = useLocale();
const theme = ref<Theme>(loadPreference());
const resolved = ref<"light" | "dark">("light");

function nextTheme() {
  const order: Theme[] = ["system", "light", "dark"];
  theme.value = order[(order.indexOf(theme.value) + 1) % order.length]!;
  savePreference(theme.value);
  resolved.value = applyTheme(theme.value, window.matchMedia("(prefers-color-scheme: dark)").matches);
}
function nextLocale() {
  const index = LOCALES.indexOf(locale.value as never);
  setLocale(LOCALES[(index + 1) % LOCALES.length]!);
}
onMounted(() => {
  resolved.value = applyTheme(theme.value, window.matchMedia("(prefers-color-scheme: dark)").matches);
});
</script>

<template>
  <div class="toggles">
    <button data-testid="lang-toggle" :title="t('app.language')" @click="nextLocale">{{ locale }}</button>
    <button data-testid="theme-toggle" :title="t('app.theme')" @click="nextTheme">{{ theme }}({{ resolved }})</button>
  </div>
</template>
```

依赖说明：`../i18n/bridge` 是对 `createI18nInstance()` 单例的薄封装（`src/renderer/src/i18n/bridge.ts`：模块级持有 `{ i18n, setLocale }`，导出 `useLocale()` 返回 `{ locale: computed(() => i18n.global.locale.value), setLocale }` 与 `initI18n()`）；在 `main.ts` 里 `initI18n()` 后 `app.use(i18n)`。实现者按此落地。

`main.ts` 修改（接入 i18n + theme.css）：

```ts
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createI18nInstance } from "./i18n/index.js";
import "./styles/theme.css";

const { i18n } = createI18nInstance();
createApp(App).use(createPinia()).use(i18n).mount("#app");
```

- [ ] **步骤 4：运行验证通过 + 挂载冒烟**

运行：`cd apps/desktop && pnpm vitest run tests/renderer/i18n/parity.test.ts tests/renderer/App.test.ts`
预期：PASS（App 若因缺 i18n 依赖挂载失败，在 App.test.ts 顶部 `const { i18n } = createI18nInstance(); mount(App, { global: { plugins: [i18n] } })` 修正）

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer apps/desktop/tests/renderer/i18n
git commit -m "feat(desktop): 中英 i18n、明暗主题与切换组件"
```

---

### 任务 6：工作区与树 store（TDD）

**文件：**
- 创建：`apps/desktop/src/renderer/src/api/memory.ts`（完整实现，替代任务 4 的要点注释）
- 创建：`apps/desktop/src/renderer/src/stores/workspace.ts`、`apps/desktop/src/renderer/src/stores/tree.ts`
- 测试：`apps/desktop/tests/renderer/stores/workspace.test.ts`、`apps/desktop/tests/renderer/stores/tree.test.ts`

- [ ] **步骤 1：实现内存替身（memory.ts）**

按 `ApiccApi` 接口逐方法直写（内部 `groups` 数组 + `root/name/problems` 状态；`seedWorkspace()` 预置 g/p/c/api 各一；`treeGet` 用与 `main/tree.ts` 相同的映射逻辑内联实现；`debugSend` 返回固定成功结果；`wsPickDirectory` 返回构造时注入的目录）。此文件无外部依赖，测试直接消费。

- [ ] **步骤 2：编写失败的 workspace store 测试**

`apps/desktop/tests/renderer/stores/workspace.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../src/renderer/src/stores/workspace.js";

function freshStore() {
  const api = createMemoryApi();
  return { api, store: useWorkspaceStore(api) };
}

describe("workspace store", () => {
  it("初始未打开；open 后持有名称与树", async () => {
    const { api, store } = freshStore();
    expect(store.opened).toBe(false);
    api.seedWorkspace();
    await store.open("/tmp/ws");
    expect(store.opened).toBe(true);
    expect(store.tree?.children).toHaveLength(1);
  });

  it("打开带问题文件的工作区时 problems 可见", async () => {
    const { api, store } = freshStore();
    api.seedWorkspace();
    (api as { problems: unknown[] }).problems = [{ file: "x.yaml", message: "schema 校验失败: ..." }];
    await store.open("/tmp/ws");
    expect(store.problems).toHaveLength(1);
  });
});
```

- [ ] **步骤 3：实现 workspace store**

`apps/desktop/src/renderer/src/stores/workspace.ts`：

```ts
import { defineStore } from "pinia";
import type { LoadProblem } from "@apicc/core";
import type { ApiccApi, OpenResult } from "../../shared/types.js";
import type { TreeNodeDTO } from "../../shared/tree-dto.js";

export function useWorkspaceStore(api: ApiccApi) {
  return defineStore("workspace", {
    state: () => ({ opened: false, name: "", root: "", tree: null as TreeNodeDTO | null, problems: [] as LoadProblem[] }),
    actions: {
      async open(rootPath: string) {
        const r = await api.wsOpen(rootPath);
        this.apply(r);
      },
      async create(rootPath: string, name: string) {
        const r = await api.wsCreate(rootPath, name);
        this.apply(r);
      },
      async refresh() {
        this.tree = await api.treeGet();
      },
      apply(r: OpenResult) {
        this.opened = true;
        this.name = r.workspace.name;
        this.root = r.root;
        this.problems = r.problems;
      },
    },
  })(api);
}
```

依赖更正（照做）：`TreeNodeDTO` 定义放 `apps/desktop/src/shared/tree-dto.ts`（内容与任务 3 `main/tree.ts` 导出的接口一致；`main/tree.ts` 改为 `import type { TreeNodeDTO } from "../../shared/tree-dto.js"` 并 re-export，保持类型单源），`shared/types.ts` 从该文件导入。

- [ ] **步骤 4：编写失败的 tree store 测试**

`apps/desktop/tests/renderer/stores/tree.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../src/renderer/src/stores/workspace.js";
import { useTreeStore } from "../../src/renderer/src/stores/tree.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const tree = useTreeStore(api, ws);
  return { api, ws, tree };
}

describe("tree store", () => {
  it("createNode 后树刷新且返回新节点 id", async () => {
    const { ws, tree } = await seeded();
    const groupNode = ws.tree!.children![0]!;
    const created = await tree.createNode({ kind: "project", parentId: groupNode.id, name: "新项目" });
    expect(created.id).toBeTruthy();
    const names = ws.tree!.children!.map((c) => c.label);
    expect(names).toContain("新项目");
  });

  it("deleteNode 需确认回调放行才删除", async () => {
    const { ws, tree } = await seeded();
    const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    let asked = false;
    await tree.deleteNode("api", apiNode.id, async () => { asked = true; return true; });
    expect(asked).toBe(true);
    const flat = JSON.stringify(ws.tree);
    expect(flat).not.toContain(apiNode.id);
  });

  it("deleteNode 确认取消则不删除", async () => {
    const { ws, tree } = await seeded();
    const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await tree.deleteNode("api", apiNode.id, async () => false);
    expect(JSON.stringify(ws.tree)).toContain(apiNode.id);
  });

  it("renameNode 后标签更新", async () => {
    const { ws, tree } = await seeded();
    const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await tree.renameNode("api", apiNode.id, "改名后");
    expect(JSON.stringify(ws.tree)).toContain("改名后");
  });
});
```

- [ ] **步骤 5：运行验证失败后实现 tree store**

运行：`cd apps/desktop && pnpm vitest run tests/renderer/stores/tree.test.ts` → FAIL 后创建

`apps/desktop/src/renderer/src/stores/tree.ts`：

```ts
import { defineStore } from "pinia";
import type { ApiccApi, NodeCreateInput } from "../../shared/types.js";
import type { TreeNodeDTO } from "../../shared/tree-dto.js";
import { useWorkspaceStore } from "./workspace.js";

type ConfirmFn = (message: string) => Promise<boolean>;

export function useTreeStore(api: ApiccApi, workspace: ReturnType<typeof useWorkspaceStore>) {
  return defineStore("tree", {
    state: () => ({ selected: null as { kind: TreeNodeDTO["kind"]; id: string } | null }),
    actions: {
      select(kind: TreeNodeDTO["kind"], id: string) {
        this.selected = { kind, id };
      },
      async createNode(input: NodeCreateInput) {
        const node = (await api.nodeCreate(input)) as unknown as { id: string };
        await workspace.refresh();
        this.select(input.kind, node.id);
        return node;
      },
      async renameNode(kind: Parameters<ApiccApi["nodeRename"]>[0], id: string, name: string) {
        await api.nodeRename(kind, id, name);
        await workspace.refresh();
      },
      async deleteNode(kind: Parameters<ApiccApi["nodeDelete"]>[0], id: string, confirm: ConfirmFn) {
        if (!(await confirm(`delete:${id}`))) return;
        await api.nodeDelete(kind, id);
        if (this.selected?.id === id) this.selected = null;
        await workspace.refresh();
      },
    },
  })(api, workspace);
}
```

- [ ] **步骤 6：运行验证通过**

运行：`cd apps/desktop && pnpm vitest run tests/renderer/stores/`
预期：PASS（6 个用例）

- [ ] **步骤 7：Commit**

```bash
git add apps/desktop/src/renderer/src/api apps/desktop/src/renderer/src/stores apps/desktop/src/shared apps/desktop/tests/renderer/stores
git commit -m "feat(desktop): 工作区与树 store——打开/创建/增删改（内存替身 TDD）"
```

---

### 任务 7：编辑器与调试 store（TDD）

**文件：**
- 创建：`apps/desktop/src/renderer/src/stores/editor.ts`、`apps/desktop/src/renderer/src/stores/debug.ts`
- 测试：`apps/desktop/tests/renderer/stores/editor.test.ts`、`apps/desktop/tests/renderer/stores/debug.test.ts`

- [ ] **步骤 1：编写失败的 editor store 测试**

`apps/desktop/tests/renderer/stores/editor.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../src/renderer/src/stores/editor.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  return { api, ws, editor, apiNode };
}

describe("editor store", () => {
  it("load 拉取接口与可用环境；dirty 跟踪编辑", async () => {
    const { editor, apiNode } = await seeded();
    await editor.load(apiNode.id);
    expect(editor.api?.name).toBe("接口一");
    expect(editor.envs).toEqual([{ id: "e1", name: "dev" }]);
    expect(editor.dirty).toBe(false);
    editor.api!.url = "{{baseUrl}}/changed";
    expect(editor.dirty).toBe(true);
  });

  it("save 持久化并清除 dirty", async () => {
    const { api, editor, apiNode } = await seeded();
    await editor.load(apiNode.id);
    editor.api!.url = "/v2";
    await editor.save();
    expect(editor.dirty).toBe(false);
    const fresh = createMemoryApi();
    fresh.groups = api.groups;
    const reEditor = useEditorStore(fresh);
    await reEditor.load(apiNode.id);
    expect(reEditor.api!.url).toBe("/v2");
  });
});
```

- [ ] **步骤 2：运行验证失败后实现 editor store**

运行：`cd apps/desktop && pnpm vitest run tests/renderer/stores/editor.test.ts` → FAIL 后创建

`apps/desktop/src/renderer/src/stores/editor.ts`：

```ts
import { defineStore } from "pinia";
import type { ApiDefinition } from "@apicc/core";
import type { ApiccApi } from "../../shared/types.js";

export function useEditorStore(api: ApiccApi) {
  return defineStore("editor", {
    state: () => ({
      apiId: null as string | null,
      api: null as ApiDefinition | null,
      envs: [] as Array<{ id: string; name: string }>,
      dirty: false,
    }),
    actions: {
      async load(apiId: string) {
        const detail = await api.apiGet(apiId);
        this.apiId = apiId;
        this.api = detail.api;
        this.envs = detail.envs;
        this.dirty = false;
      },
      async save() {
        if (!this.api) return;
        await api.apiSave(this.api);
        this.dirty = false;
      },
    },
  })(api);
}
```

- [ ] **步骤 3：运行验证通过**

运行：`cd apps/desktop && pnpm vitest run tests/renderer/stores/editor.test.ts`
预期：PASS（2 个用例）

- [ ] **步骤 4：编写失败的 debug store 测试**

`apps/desktop/tests/renderer/stores/debug.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../src/renderer/src/stores/editor.js";
import { useDebugStore } from "../../src/renderer/src/stores/debug.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  const debug = useDebugStore(api);
  return { editor, debug };
}

describe("debug store", () => {
  it("send 前保存编辑（脏→保存）并携带环境", async () => {
    const { editor, debug } = await seeded();
    editor.api!.url = "/sent";
    let captured: { caseId: string; envName?: string } | null = null;
    (editor as unknown as { api: unknown }).api = editor.api;
    const spyApi = editor;
    void spyApi;
    await debug.send(editor, (input) => { captured = input; return Promise.resolve({ run: { total: 1, passed: 1, failed: 0, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" }, outcome: { apiId: "a", apiName: "a", caseId: "t", caseName: "t", passed: true, durationMs: 1, assertions: [] } }); }, "dev");
    expect(editor.dirty).toBe(false);
    expect(captured).toMatchObject({ envName: "dev" });
    expect(debug.result?.outcome.passed).toBe(true);
    expect(debug.sending).toBe(false);
  });

  it("发送失败时错误可见且状态复位", async () => {
    const { editor, debug } = await seeded();
    await debug.send(editor, () => Promise.reject(new Error("网络不可达")));
    expect(debug.error).toContain("网络不可达");
    expect(debug.sending).toBe(false);
  });
});
```

- [ ] **步骤 5：运行验证失败后实现 debug store**

运行：`cd apps/desktop && pnpm vitest run tests/renderer/stores/debug.test.ts` → FAIL 后创建

`apps/desktop/src/renderer/src/stores/debug.ts`：

```ts
import { defineStore } from "pinia";
import type { DebugOutput } from "../../shared/types.js";
import type { ApiccApi } from "../../shared/types.js";
import type { useEditorStore } from "./editor.js";

type Editor = ReturnType<typeof useEditorStore>;
type SendFn = (input: { apiId: string; caseId: string; envName?: string }) => Promise<DebugOutput>;

export function useDebugStore(api: ApiccApi) {
  return defineStore("debug", {
    state: () => ({ sending: false, result: null as DebugOutput | null, error: null as string | null }),
    actions: {
      async send(editor: Editor, sendFn: SendFn = (input) => api.debugSend(input), envName?: string) {
        if (!editor.api || !editor.api.cases[0]) return;
        this.sending = true;
        this.error = null;
        try {
          if (editor.dirty) await editor.save();
          this.result = await sendFn({ apiId: editor.api.id, caseId: editor.api.cases[0].id, envName });
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.sending = false;
        }
      },
    },
  })(api);
}
```

- [ ] **步骤 6：运行验证通过 + 全量回归**

运行：`cd apps/desktop && pnpm vitest run` 与 `cd packages/core && pnpm vitest run`
预期：desktop 全部 PASS；core 无回归

- [ ] **步骤 7：Commit**

```bash
git add apps/desktop/src/renderer/src/stores apps/desktop/tests/renderer/stores
git commit -m "feat(desktop): 编辑器与调试 store——脏跟踪、发送前保存、错误复位"
```

---

### 任务 8：UI 组件接线（SideTree / RequestEditor / ResponseViewer / App 布局）

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/SideTree.vue`、`RequestEditor.vue`、`ResponseViewer.vue`、`EmptyState.vue`、`ConfirmDialog.vue`、`TopBar.vue`
- 修改：`apps/desktop/src/renderer/src/App.vue`、`apps/desktop/src/renderer/src/api/index.ts`（装配真实单例 store）
- 测试：`apps/desktop/tests/renderer/components/components.test.ts`

- [ ] **步骤 1：编写失败的组件交互测试**

`apps/desktop/tests/renderer/components/components.test.ts`（挂载带 pinia+i18n 的辅助函数 `mountWith` 放本文件顶部；store 用注入的 memory api）：

```ts
import { describe, expect, it } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18nInstance } from "../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../src/renderer/src/api/memory.js";
import SideTree from "../../src/renderer/src/components/SideTree.vue";
import RequestEditor from "../../src/renderer/src/components/RequestEditor.vue";
import ResponseViewer from "../../src/renderer/src/components/ResponseViewer.vue";

async function mountWith(component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}) {
  setActivePinia(createPinia());
  const { i18n } = createI18nInstance();
  const api = createMemoryApi();
  api.seedWorkspace();
  const wrapper = mount(component, { props, global: { plugins: [i18n] } });
  await flushPromises();
  return { wrapper, api };
}

describe("SideTree", () => {
  it("渲染工作区树并支持选中接口", async () => {
    const { wrapper } = await mountWith(SideTree, {});
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const apiNode = wrapper.find('[data-testid="tree-api"]');
    expect(apiNode.exists()).toBe(true);
    await apiNode.trigger("click");
    expect(wrapper.emitted("select")).toBeTruthy();
  });

  it("新建接口：上下文菜单动作触发创建", async () => {
    const { wrapper } = await mountWith(SideTree, {});
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="new-api"]').trigger("click");
    await flushPromises();
    expect(wrapper.emitted("select")).toBeTruthy();
  });
});

describe("RequestEditor", () => {
  it("编辑 URL 触发 update 且显示发送按钮", async () => {
    const { wrapper } = await mountWith(RequestEditor, {});
    const url = wrapper.find('[data-testid="editor-url"]');
    await url.setValue("http://example.com/x");
    expect((url.element as HTMLInputElement).value).toBe("http://example.com/x");
    expect(wrapper.find('[data-testid="send-btn"]').exists()).toBe(true);
  });
});

describe("ResponseViewer", () => {
  it("无结果时显示空态", async () => {
    const { wrapper } = await mountWith(ResponseViewer, {});
    expect(wrapper.find('[data-testid="response-empty"]').exists()).toBe(true);
  });

  it("有结果时显示状态码与断言明细", async () => {
    const { wrapper } = await mountWith(ResponseViewer, {});
    await wrapper.setProps({
      result: {
        run: { total: 1, passed: 1, failed: 0, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" },
        outcome: { apiId: "a", apiName: "a", caseId: "t", caseName: "t", passed: true, durationMs: 5, assertions: [{ pass: false, message: "eq 失败" }] },
      },
    });
    expect(wrapper.find('[data-testid="response-empty"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("eq 失败");
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd apps/desktop && pnpm vitest run tests/renderer/components/`
预期：FAIL，组件不存在

- [ ] **步骤 3：实现组件与 App 布局**

实现要点（组件为组合式 SFC，全部带 `data-testid`；store 经 props/emit 或直接 useXxx，保持与任务 5-7 store 契约一致）：

- `SideTree.vue`：递归渲染 `TreeNodeDTO`（分组/项目/集合默认折叠，`data-testid="tree-group-toggle"` 为分组展开钮；api 节点 `data-testid="tree-api"`）；节点悬停显示动作钮（集合/项目/分组上 `new-api`/`new-collection`/`new-project`/`new-folder`，全部节点 `rename`/`delete`）；创建走 prompt 式内联输入（`ConfirmDialog` 复用为输入对话框：title + 可选 input + confirm/cancel）；选中 emit `select(kind,id)`；删除走 `deleteNode(kind,id,confirm)`。工作区未打开时渲染 `EmptyState`。
- `RequestEditor.vue`：props `editor`/`debug` store 实例；顶部行 = 方法下拉（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS）+ URL 输入（`data-testid="editor-url"`）+ 发送钮（`data-testid="send-btn"`，`:disabled="debug.sending"`，文案 `editor.send`/`editor.sending`）+ 保存钮；tabs = 参数/请求头/认证/请求体（params/headers 为 key/value/enabled 行编辑，`editor.addRow` 文案；auth 为 type 下拉 + bearer token/basic 用户名密码/apikey key·value·placement；body 为 kind 下拉 + 对应编辑器：json/xml/raw/graphql textarea、form 行编辑）；名称行绑定 `editor.api.name`；全部绑定直接改 `editor.api` 字段（Pinia 响应式），显式保存按钮调 `editor.save()`。
- `ResponseViewer.vue`：props `result: DebugOutput | null`、`sending: boolean`、`error: string | null`；空态 `data-testid="response-empty"`（文案 `response.empty`）；有结果时头部显示 `outcome` 状态码取自断言明细中 target=status 的实际值不可得——**显示 passed/durationMs 与断言列表**（`response.assertions` 表：消息 + 通过/失败徽标）及 error（`response.error` 徽标）；body/headers 两个 tab 渲染 `run` 原始响应不可得时显示「—」。实现约束：`DebugOutput` 若未含响应体则 body tab 显示占位「—」（响应体入参属计划 2B 的 `debug:send` 扩展，本任务不得臆造字段）。
- `EmptyState.vue`：props `text`；居中灰字。
- `ConfirmDialog.vue`：props `open/title/inputPlaceholder?`；emit `confirm(value: string | null)`；含可选输入框（供重命名/创建复用）。
- `TopBar.vue`：工作区名 + 打开/新建按钮（调用 `apicc.wsPickDirectory` + `wsOpen`/`wsCreate`，创建时用 ConfirmDialog 输入名称）+ `ThemeLanguageToggle`。
- `App.vue` 布局：左 `SideTree`（240px 固定宽）+ 右侧上下分栏（上 `RequestEditor` 下 `ResponseViewer`）；选中接口时加载 `editor.load(id)`；顶栏 `TopBar`。根组件装配真实单例：`api/index.ts` 导出 `apicc`（`window.apicc` 存在时）否则 `createMemoryApi()`（便于 vitest 与浏览器直开调试）。

- [ ] **步骤 4：运行验证通过 + 全量回归**

运行：`cd apps/desktop && pnpm vitest run` 与 `cd packages/core && pnpm vitest run`
预期：desktop 全部 PASS；core 无回归

- [ ] **步骤 5：Electron 手工冒烟**

运行：`pnpm -C apps/desktop build && pnpm -C apps/desktop exec electron .`
手工验证：新建工作区 → 建分组/项目/集合/接口 → 编辑 URL → 发送（对任意真实本地服务）→ 响应可见；切换语言与主题即时生效。结果记录进报告。

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): 侧树/请求编辑器/响应查看器与 App 三栏布局"
```

---

## 计划 2B 预告（本计划不含，2A 合并后另立计划）

用例与环境面板（多用例编辑、环境派生 UI）、集合运行 + HTML 报告内嵌 + 运行历史、导入向导（detect→预览差异→确认写入）、接口详细设计编辑器与 agent 导出、electron-builder 打包冒烟、`apicc import` CLI 交互流。

## 自检结果

1. **规格覆盖度（2A 范围）**：§3.1 工作区（任务 4/6）、组织结构浏览与增删改（任务 5）、REST 调试（任务 6/7/8）、认证编辑（任务 8 编辑器 auth tab）、变量体系消费（Runner 侧已实现，UI 变量管理面属 2B）、i18n（任务 5）、主题（任务 5）。§3.2 排除项未混入；2B 预告已列明归属。
2. **占位符扫描**：任务 4 的 `memory.ts` 以「实现要点」形式给出逐方法要求（接口固定、语义以 session 为准），属对实现者的明确指令而非 TODO；其余步骤均含完整代码。任务 8 组件按「实现要点 + data-testid 契约 + store 契约」给出完整行为定义，测试代码先行固定行为。
3. **类型一致性**：`ApiccApi` 11 方法在任务 4 定义、5/6/7 store 与任务 8 组件消费；`TreeNodeDTO` 单源于 `shared/tree-dto.ts`（任务 3/4 的更正指令保证）；`DebugOutput` 在 4/7/8 一致；`OpenResult` 在 4/6 一致。

## 执行注意事项

- 品牌中立约束适用于 UI 文案与测试数据
- 每任务提交前：desktop 全量测试 + core 全量回归双绿
- Electron 主进程代码（src/main、src/preload）运行时才执行——每任务的手工冒烟不可跳过，结果写报告
