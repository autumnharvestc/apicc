// @vitest-environment jsdom
// M3-B 任务 3 组件测试：OnlineApiEditor（在线接口编辑/只读/坏数据 problems/引导文案）、
// OnlineConflictDialog（裁定 C 冲突两选项）、OnlineMigrateDialog（裁定 D 进度+结果清单）、
// TopBar 模式徽标与互斥切换（裁定 E）、SideTree 在线只读装饰（file 叶/无动作钮）、
// OnlineLoginDialog 工作区列表（打开在线工作区入口，先关本地工作区）。
// antd 适配沿用既有约定：a-modal 传送门内容用 body 作用域查询（expectBody/bodyHas）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useTreeStore } from "../../../src/renderer/src/stores/tree.js";
import { createPluginsStore } from "../../../src/renderer/src/stores/plugins.js";
import HomeView from "../../../src/renderer/src/components/HomeView.vue";
import { createOnlineStore } from "../../../src/renderer/src/stores/online.js";
import OnlineApiEditor from "../../../src/renderer/src/components/OnlineApiEditor.vue";
import OnlineConflictDialog from "../../../src/renderer/src/components/OnlineConflictDialog.vue";
import OnlineMigrateDialog from "../../../src/renderer/src/components/OnlineMigrateDialog.vue";
import TopBar from "../../../src/renderer/src/components/TopBar.vue";
import SideTree from "../../../src/renderer/src/components/SideTree.vue";
import OnlineLoginDialog from "../../../src/renderer/src/components/OnlineLoginDialog.vue";
import type { ApiccApi } from "../../../src/shared/types.js";

const SERVER = "http://127.0.0.1:8080";
const API_PATH = "groups/示例分组/projects/示例项目/collections/示例集合/apis/示例接口/api.yaml";
const VALID_API_YAML = [
  "id: api-online-1",
  "name: 示例接口",
  "version: 1.0.0",
  "deprecated: false",
  "method: GET",
  'url: "/ping"',
  "headers: []",
  "query: []",
  "cases: []",
  "",
].join("\n");

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
  });
  localStorage.setItem("apicc.locale", "zh-CN");
});

enableAutoUnmount(afterEach);

function bodyFind(testid: string): DOMWrapper<Element> | null {
  const el = document.body.querySelector(`[data-testid="${testid}"]`);
  return el ? new DOMWrapper(el) : null;
}

function expectBody(testid: string): DOMWrapper<Element> {
  const w = bodyFind(testid);
  if (!w) throw new Error(`document.body 中找不到 [data-testid="${testid}"]（Modal 传送门未渲染？）`);
  return w;
}

function bodyHas(testid: string): boolean {
  return bodyFind(testid) !== null;
}

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

interface Fixture {
  api: ApiccApi;
  workspace: ReturnType<typeof useWorkspaceStore>;
  online: ReturnType<typeof createOnlineStore>;
  mount: (component: Parameters<typeof mount>[0], props?: Record<string, unknown>) => Promise<ReturnType<typeof mount>>;
}

/** 在线 store 已登录 + 已打开在线工作区的装配（各组件共享）。 */
async function fixture(): Promise<Fixture> {
  const api = createMemoryApi();
  api.seedWorkspace(); // 本地内存工作区（TopBar 本地打开/互斥用例的 wsOpen 回退语义）
  const online = createOnlineStore({ api, storage: memStorage() });
  online.addProfile(SERVER, "团队服务器");
  await online.login("alice", "password8");
  await online.refreshWorkspaces();
  await online.openWorkspace(online.workspaces[0]!);
  const workspace = useWorkspaceStore(api);
  const tree = useTreeStore(api, workspace);
  const plugins = createPluginsStore({ api });
  const { i18n } = createI18nInstance();
  const mountWith = async (component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}) =>
    mount(component, { props: { api, workspace, tree, online, plugins, reportError: () => {}, openProject: () => {}, ...props }, global: { plugins: [i18n] } });
  return { api, workspace, online, mount: mountWith };
}

/** 预置合法 api.yaml 内容（推到在线替身），返回版本 2。 */
async function seedValidApi(fixture_: Fixture) {
  await fixture_.api.onlineFilePut({ workspaceId: fixture_.online.activeWorkspace!.id, path: API_PATH, content: VALID_API_YAML, baseVersion: 1 });
}

describe("OnlineApiEditor（裁定 B：api.yaml 级编辑 / 只读 / 坏数据 problems）", () => {
  it("未选中任何文件 → 引导空态（含拉取到本地的调试边界文案）", async () => {
    const f = await fixture();
    const wrapper = await f.mount(OnlineApiEditor);
    expect(wrapper.find('[data-testid="online-guide"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("拉取");
  });

  it("EDITOR 选中接口：表单渲染、可改、保存推送（版本前移 + 已保存提示）", async () => {
    const f = await fixture();
    await seedValidApi(f);
    await f.online.selectNode("api", API_PATH);
    const wrapper = await f.mount(OnlineApiEditor);
    expect(wrapper.find('[data-testid="online-editor-name"]').exists()).toBe(true);
    expect((wrapper.find('[data-testid="online-editor-name"]').element as HTMLInputElement).value).toBe("示例接口");
    expect(wrapper.find('[data-testid="online-save-btn"]').exists()).toBe(true);
    await wrapper.find('[data-testid="online-editor-name"]').setValue("在线改名");
    expect(f.online.editorDirty).toBe(true);
    await wrapper.find('[data-testid="online-save-btn"]').trigger("click");
    await flushPromises();
    expect(f.online.conflict).toBeNull();
    expect(f.online.editorVersion).toBe(3);
    expect(f.online.editorDirty).toBe(false);
    expect(wrapper.find('[data-testid="online-saved-tip"]').exists()).toBe(true);
  });

  it("VIEWER（工作区只读）：无保存钮、输入禁用、只读徽标", async () => {
    const f = await fixture();
    await seedValidApi(f);
    f.online.activeWorkspace = { ...f.online.activeWorkspace!, myRole: "VIEWER" };
    await f.online.selectNode("api", API_PATH);
    const wrapper = await f.mount(OnlineApiEditor);
    expect(wrapper.find('[data-testid="online-save-btn"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="online-readonly-badge"]').exists()).toBe(true);
    expect((wrapper.find('[data-testid="online-editor-name"]').element as HTMLInputElement).disabled).toBe(true);
  });

  it("项目级 ACL 覆盖 VIEWER：该项目子树接口同样只读（path 实体化：按 projects.id 前缀定位）", async () => {
    const f = await fixture();
    // path 实体化（2026-09-08）：项目内 path 首段=项目实体 UUID；内存替身按 baseVersion=0 建新文件
    const pid = "0f8d3a2c-a1b2-c3d4-e5f6-0123456789ab";
    const pidPath = `${pid}/collections/示例集合/apis/示例接口/api.yaml`;
    await f.api.onlineFilePut({ workspaceId: f.online.activeWorkspace!.id, path: pidPath, content: VALID_API_YAML, baseVersion: 0 });
    f.online.projects = [{ id: pid, name: "示例项目", myRole: "VIEWER" }];
    await f.online.selectNode("api", pidPath);
    const wrapper = await f.mount(OnlineApiEditor);
    expect(wrapper.find('[data-testid="online-save-btn"]').exists()).toBe(false);
  });

  it("坏数据（校验失败）→ problems 展示原文，不崩、无表单", async () => {
    const f = await fixture();
    // 种子内容缺 url/method——M5 D2 后 method 缺省 GET（websocket 可省略的零破坏演进），
    // 缺 method 不再是校验问题，坏数据仅剩 url 必填缺失，断言随新 schema 契约更新。
    await f.online.selectNode("api", API_PATH);
    const wrapper = await f.mount(OnlineApiEditor);
    const problems = wrapper.find('[data-testid="online-problems"]');
    expect(problems.exists()).toBe(true);
    expect(problems.text()).toContain("url");
    expect(wrapper.find('[data-testid="online-raw"]').text()).toContain("api-online-1");
    expect(wrapper.find('[data-testid="online-editor-name"]').exists()).toBe(false);
  });

  it("只读配置叶（file）→ 原文只读展示", async () => {
    const f = await fixture();
    await f.online.selectNode("file", "apicc.workspace.yaml");
    const wrapper = await f.mount(OnlineApiEditor);
    expect(wrapper.find('[data-testid="online-raw"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="online-save-btn"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("ws-online-1");
  });
});

describe("OnlineConflictDialog（裁定 C：409 → 拉取覆盖我的 / 放弃）", () => {
  it("conflict 置位 → 传送门渲染服务端版本信息；放弃 → 清冲突且保留本地编辑", async () => {
    const f = await fixture();
    await seedValidApi(f);
    await f.online.selectNode("api", API_PATH);
    f.online.editorApi!.name = "我的本地编辑";
    f.online.conflict = { code: "version_conflict", currentVersion: 9, currentHash: "h9" };
    await f.mount(OnlineConflictDialog);
    expect(expectBody("online-conflict-text").text()).toContain("9");
    await expectBody("online-conflict-discard").trigger("click");
    await flushPromises();
    expect(f.online.conflict).toBeNull();
    expect(f.online.editorApi?.name).toBe("我的本地编辑"); // 放弃 = 保留缓冲
  });

  it("拉取覆盖我的 → 重取服务端最新重新渲染（丢弃本地编辑）", async () => {
    const f = await fixture();
    await seedValidApi(f);
    await f.online.selectNode("api", API_PATH);
    f.online.editorApi!.name = "我的本地编辑";
    f.online.conflict = { code: "version_conflict", currentVersion: 9, currentHash: "h9" };
    await f.mount(OnlineConflictDialog);
    await expectBody("online-conflict-pull").trigger("click");
    await flushPromises();
    expect(f.online.conflict).toBeNull();
    expect(f.online.editorApi?.name).toBe("示例接口"); // 服务端内容覆盖
    expect(f.online.editorDirty).toBe(false);
  });
});

describe("OnlineMigrateDialog（裁定 D：目录选择 + 进度 + 结果清单）", () => {
  it("拉取：选目录后执行，结果清单计数与明细上屏", async () => {
    const f = await fixture();
    f.online.migrateDialogOpen = true; // a-modal 传送门渲染前置（显隐由 store 驱动）
    const dir = mkdtempSync(join(tmpdir(), "apicc-ui-pull-"));
    try {
      f.api.wsPickDirectory = async () => dir;
      await f.mount(OnlineMigrateDialog);
      await expectBody("migrate-pull-btn").trigger("click");
      await flushPromises();
      expect(f.online.migrationResult?.direction).toBe("pull");
      expect(expectBody("migrate-result").text()).toContain("7"); // 新拉 7
      expect(bodyHas("migrate-result-list")).toBe(true);
      expect(expectBody("migrate-result-list").text()).toContain("apicc.workspace.yaml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("推送：差异 batch 执行后树刷新 + 冲突默认跳过列出", async () => {
    const f = await fixture();
    f.online.migrateDialogOpen = true;
    f.api.onlineMigrateScan = async () => ({
      files: [{ path: "groups/g/new.yaml", hash: "hn", content: "new\n" }],
    });
    f.api.onlineFilesBatch = async () => ({ results: [{ path: "groups/g/new.yaml", status: "pushed", version: 1 }] });
    await f.mount(OnlineMigrateDialog);
    await expectBody("migrate-push-btn").trigger("click");
    await flushPromises();
    expect(f.online.migrationResult?.pushed).toBe(1);
    expect(expectBody("migrate-result").text()).toContain("1");
    expect(bodyHas("migrate-progress")).toBe(false); // 结束后进度条消失
  });

  it("迁移中：按钮禁用、进度可见（进度按批次更新入 store）", async () => {
    const f = await fixture();
    f.online.migrateDialogOpen = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.api.onlineMigrateScan = async () => {
      await gate;
      return { files: [] };
    };
    await f.mount(OnlineMigrateDialog);
    const click = expectBody("migrate-pull-btn").trigger("click");
    await flushPromises();
    expect(f.online.migrating).toBe(true);
    expect(bodyHas("migrate-progress")).toBe(true);
    expect((expectBody("migrate-pull-btn").element as HTMLButtonElement).disabled).toBe(true);
    release();
    await click;
    await flushPromises();
    expect(f.online.migrating).toBe(false);
  });
});

describe("TopBar 主页入口与互斥切换（M11 取代模式徽标）", () => {
  it("主页入口恒在（无模式徽标）；在线工作区激活：名称切在线工作区名", async () => {
    const f = await fixture();
    await f.online.closeWorkspace(); // 先回到无工作区上下文（fixture 默认在线已开）
    const wrapper = await f.mount(TopBar);
    // 主页按钮恒在（M11：取代本地/在线徽标位置，模式由项目来源决定）
    expect(wrapper.find('[data-testid="topbar-home"]').exists()).toBe(true);
    await f.workspace.open("/tmp/ws");
    await flushPromises();
    expect(wrapper.find('[data-testid="topbar-home"]').exists()).toBe(true);
    // 打开在线工作区 → 顶栏名称切在线工作区名（互斥：本地已关）
    await f.online.openWorkspace(f.online.workspaces[0]!);
    await flushPromises();
    expect(wrapper.find('[data-testid="workspace-name"]').text()).toContain(f.online.activeWorkspace!.name);
    expect(wrapper.find('[data-testid="online-migrate"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="online-exit"]').exists()).toBe(true);
  });

  it("退出在线工作区 → 会话清理（store 状态清空）", async () => {
    const f = await fixture();
    const wrapper = await f.mount(TopBar);
    await wrapper.find('[data-testid="online-exit"]').trigger("click");
    await flushPromises();
    expect(f.online.activeWorkspace).toBeNull();
    expect(f.online.onlineTree).toBeNull();
    expect(f.online.editorPath).toBeNull();
  });

  it("在线激活时点「打开本地目录」→ 目录选定后再退在线并打开本地（互斥自动侧，M9-C 入口在主页）", async () => {
    const f = await fixture();
    let pickCount = 0;
    f.api.wsPickDirectory = async () => {
      pickCount += 1;
      return "/tmp/ws";
    };
    const wrapper = await f.mount(HomeView);
    await wrapper.find('[data-testid="home-open-dir"]').trigger("click");
    await flushPromises();
    expect(f.online.activeWorkspace).toBeNull(); // 在线已退
    expect(pickCount).toBe(1);
    expect(f.workspace.opened).toBe(true);
  });

  it("在线激活时点「打开本地目录」但取消目录选择 → 不切模式（不落空态，次要 4 顺修）", async () => {
    const f = await fixture();
    f.api.wsPickDirectory = async () => ""; // 用户取消
    const wrapper = await f.mount(HomeView);
    await wrapper.find('[data-testid="home-open-dir"]').trigger("click");
    await flushPromises();
    expect(f.online.activeWorkspace).not.toBeNull(); // 在线保持
    expect(f.workspace.opened).toBe(false);
  });
});

describe("SideTree 在线只读装饰（裁定 A/E）", () => {
  it("treeRoot + readonly：渲染在线树（api/file 叶），无新建/重命名/删除入口，点击发 select", async () => {
    const f = await fixture();
    const wrapper = await f.mount(SideTree, { treeRoot: f.online.onlineTree, readonly: true, emptyText: "在线空" });
    expect(wrapper.find('[data-testid="new-group"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="node-rename"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="node-delete"]').exists()).toBe(false);
    // 展开分组（递归展开后代容器）后 api/file 叶可见
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const apiBtn = wrapper.find('[data-testid="tree-api"]');
    expect(apiBtn.exists()).toBe(true);
    const fileBtn = wrapper.find('[data-testid="tree-file"]');
    expect(fileBtn.exists()).toBe(true);
    await apiBtn.trigger("click");
    expect(wrapper.emitted("select")?.[0]).toEqual(["api", API_PATH]);
  });

  it("无 treeRoot 且本地未打开 → 空态用注入文案", async () => {
    const f = await fixture();
    f.workspace.reset();
    const wrapper = await f.mount(SideTree, { treeRoot: null, readonly: true, emptyText: "在线空" });
    expect(wrapper.text()).toContain("在线空");
  });
});

describe("OnlineLoginDialog 工作区列表（打开在线工作区入口）", () => {
  it("已登录打开对话框 → 列出工作区；点「打开」→ 先关本地工作区再开在线并收起对话框", async () => {
    const f = await fixture();
    await f.online.closeWorkspace(); // 退出在线（打开钮才可用——当前工作区打开中时禁用防重复）
    // 预置本地工作区（应被互斥关闭）
    f.workspace.reset();
    await f.workspace.open("/tmp/ws");
    expect(f.workspace.opened).toBe(true);
    const { i18n } = createI18nInstance();
    f.online.dialogOpen = true;
    const wrapper = mount(OnlineLoginDialog, {
      props: { online: f.online, workspace: f.workspace },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    const list = expectBody("online-ws-list");
    expect(list.text()).toContain(f.online.workspaces[0]!.name);
    await bodyFind("online-ws-open")!.trigger("click");
    await flushPromises();
    expect(f.workspace.opened).toBe(false); // 本地先关（互斥）
    expect(f.online.activeWorkspace?.name).toBe(f.online.workspaces[0]!.name);
    expect(f.online.dialogOpen).toBe(false); // 成功后收起
  });
});
