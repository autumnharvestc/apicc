// @vitest-environment jsdom
// 计划 C 任务 6（不变量 4：工作区级关闭唯一入口=退出在线工作区按钮，新增确认弹窗）：
// exitOnline 直接 closeWorkspace 改为确认 Modal——列出该工作区受影响签（项目名 + 草稿态，
// tabs store 的 projectHasDrafts 统计），确认后先 tabs.closeWorkspaceTabs（关其全部签+驱逐
// 各项目会话，无签级 dirty 确认——工作区级关闭本身已确认）再 online.closeWorkspace(wsId)；
// 取消不动。装配约定同 projectTabs.test.ts：tabs store 由 createTabsStore(deps) 真实构造
// 后经 props 注入，deps 全内存 stub（不发 IPC）；a-modal（ConfirmDialog）传送门内容用
// body 作用域查询（expectBody/bodyHas）。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import type { ApiccApi } from "../../../src/shared/types.js";
import TopBar from "../../../src/renderer/src/components/TopBar.vue";
import type { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import type { useTreeStore } from "../../../src/renderer/src/stores/tree.js";
import type { createOnlineStore } from "../../../src/renderer/src/stores/online.js";
import { createPluginsStore } from "../../../src/renderer/src/stores/plugins.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import type { OnlineSession } from "../../../src/renderer/src/stores/online.js";
import {
  createEvictProjectSessions,
  createTabsStore,
  type ProjectTab,
  type TabsStoreDeps,
  type WorkspaceRef,
} from "../../../src/renderer/src/stores/tabs.js";
import type { LocalRootTreeNodeDTO } from "../../../src/shared/tree-dto.js";
import type { ProjectLocator, WorkflowLocator } from "../../../src/shared/locations.js";
import type { EditorSession } from "../../../src/renderer/src/stores/editor.js";
import { defineComponent, h } from "vue";
import { createAiStore } from "../../../src/renderer/src/stores/ai.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import AiConfigDialog from "../../../src/renderer/src/components/AiConfigDialog.vue";
import { createSafeAiSettingsFixture } from "../fixtures/aiSettings.js";

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

const ONLINE_REF_WS1: WorkspaceRef = { kind: "online", workspaceId: "ws-1", name: "在线一" };
const P1 = { id: "p-1", name: "项目一" };
const P2 = { id: "p-2", name: "项目二" };
const P3 = { id: "p-3", name: "本地项目", locator: { workspaceId: "20000000-0000-4000-8000-000000000001", groupId: "20000000-0000-4000-8000-000000000002", projectId: "20000000-0000-4000-8000-000000000013" } satisfies ProjectLocator };

function projectIdOf(tab: ProjectTab): string {
  return "projectLocator" in tab ? tab.projectLocator.projectId : tab.projectId;
}

function sessionStub(id: string): OnlineSession {
  return {
    workspace: { id, name: "在线一", myRole: "OWNER" },
    tree: null,
    projects: [],
    buffers: {},
    activeEditorPath: null,
  };
}

/** 脏缓冲槽：api 相对快照有未保存修改（判定先例同 online store editorDirty）。 */
function dirtyBuffer(path: string): OnlineSession["buffers"][string] {
  return {
    path,
    kind: "api",
    api: { id: "a-1", name: "改过的接口" } as never,
    raw: "",
    problems: [],
    version: 2,
    snapshot: JSON.stringify({ id: "a-1", name: "原接口" }),
    loading: false,
  };
}

/** 装配夹具：真实 tabs store + TopBar 全 props stub（online 会话表含 ws-1/ws-2 驻留）。 */
function makeFixture() {
  const storage = memStorage();
  const onlineSessions: Record<string, OnlineSession> = {
    "ws-1": sessionStub("ws-1"),
    "ws-2": sessionStub("ws-2"),
  };
  const online = {
    sessions: onlineSessions,
    activeWorkspaceId: "ws-1" as string | null,
    error: null as string | null,
    activateWorkspace: vi.fn(async (workspaceId: string) => {
      online.activeWorkspaceId = workspaceId;
    }),
    selectNode: vi.fn(async () => {}),
    evictProjectBuffers: (workspaceId: string, projectId: string) => {
      const session = onlineSessions[workspaceId];
      if (!session) return;
      for (const path of Object.keys(session.buffers)) {
        if (path.startsWith(`${projectId}/`)) delete session.buffers[path];
      }
    },
    // —— TopBar 模板面 ——
    activeWorkspace: { id: "ws-1", name: "在线一", myRole: "OWNER" as const },
    loggedIn: true,
    user: { displayName: "示例用户" },
    activeName: "团队服务器",
    dialogOpen: false,
    migrateDialogOpen: false,
    closeWorkspace: vi.fn(async () => {}),
  };
  const workspace = {
    opened: true,
    name: "本地工作区",
    problems: [],
    root: "/tmp/ws-local",
    tree: null as LocalRootTreeNodeDTO | null,
    open: vi.fn(async () => {}),
  };
  const tree = { selected: null, select: vi.fn(async () => {}) };
  const editor = { sessions: {} as Record<string, EditorSession>, evictProject: vi.fn(), isProjectDirty: () => false };
  const workflowDesign = { dirty: false, locator: null as WorkflowLocator | null };
  const deps: TabsStoreDeps = {
    workspace,
    tree,
    online,
    editor,
    workflowDesign,
    evictProjectSessions: createEvictProjectSessions({ editor, online }),
    storage,
  };
  const tabs = createTabsStore(deps);
  const topbarOnline = online as unknown as ReturnType<typeof createOnlineStore>;
  return { deps, storage, online, onlineSessions, workspace, tree, editor, workflowDesign, tabs, topbarOnline };
}

async function mountTopBar(fixture: ReturnType<typeof makeFixture>) {
  const { i18n } = createI18nInstance();
  const plugins = createPluginsStore({ api: createMemoryApi() });
  const wrapper = mount(TopBar, {
    props: {
      workspace: fixture.workspace as unknown as ReturnType<typeof useWorkspaceStore>,
      tree: fixture.tree as unknown as ReturnType<typeof useTreeStore>,
      api: {} as ApiccApi,
      online: fixture.topbarOnline,
      plugins,
      tabs: fixture.tabs,
      reportError: vi.fn(),
    },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return wrapper;
}

/** 夹具签表：ws-1 两签（项目一带脏缓冲）+ 本地一签——退出 ws-1 只应牵连前两签。 */
async function seedTabs(fixture: ReturnType<typeof makeFixture>) {
  fixture.onlineSessions["ws-1"].buffers["p-1/collections/c/apis/a/api.yaml"] =
    dirtyBuffer("p-1/collections/c/apis/a/api.yaml");
  await fixture.tabs.openProjectTab(ONLINE_REF_WS1, P1); // tab-1（在线项目一，缓冲脏）
  await fixture.tabs.openProjectTab(ONLINE_REF_WS1, P2); // tab-2
  await fixture.tabs.openProjectTab({ kind: "local", dir: "/tmp/ws-local" }, { locator: P3.locator, name: P3.name }); // tab-3
  await flushPromises();
}

describe("TopBar network settings scope", () => {
  it("opens execution cache settings from Home while signed out and shows the local cache limits", async () => {
    const fixture = makeFixture();
    Object.assign(fixture.online, { loggedIn: false, activeWorkspace: null, execution: {
      cachePreferences: { maxInactiveContexts: 20, inactiveTtlMinutes: 30, maxInactivePayloadMiB: 64 },
      cacheUsage: { currentContexts: 0, protectedContexts: 2, inactiveContexts: 3, inactivePayloadBytes: 1572864, overLimit: true },
      cachePreferenceDiagnostic: null, setCachePreferences: vi.fn(),
    } });
    fixture.workspace.opened = false; await fixture.tabs.activateHome();
    const wrapper = await mountTopBar(fixture);
    await wrapper.get('[data-testid="settings-toggle"]').trigger("click"); await flushPromises();
    const drawer = new DOMWrapper(document.body).find('.ant-drawer-body');
    expect(drawer.exists()).toBe(true);
    expect(drawer.text()).toContain("在线执行缓存");
    const settings = expectBody("execution-cache-settings");
    expect(settings.text()).toContain("非活动上下文上限");
    expect(settings.text()).toContain("空闲保留期");
    expect(settings.text()).toContain("非活动结果载荷预算");
    expect(settings.text()).toContain("只释放可安全清理的非活动内存");
    expect((expectBody("execution-cache-max-contexts").element as HTMLInputElement).value).toBe("20");
    expect((expectBody("execution-cache-ttl").element as HTMLInputElement).value).toBe("30");
    expect((expectBody("execution-cache-max-payload").element as HTMLInputElement).value).toBe("64");
    expect(settings.find('pre').exists()).toBe(false);
    expect(bodyFind("network-settings")).toBeNull();
  });
  it("shows network settings only for the active local project tab, not Home or an online tab", async () => {
    const fixture = makeFixture();
    await seedTabs(fixture);
    fixture.workspace.tree = {
      source: "local", kind: "root", id: P3.locator.workspaceId, key: "root", label: "本地工作区",
      locator: { workspaceId: P3.locator.workspaceId },
      children: [{
        source: "local", kind: "group", id: P3.locator.groupId, key: "group", label: "本地分组",
        locator: { workspaceId: P3.locator.workspaceId, groupId: P3.locator.groupId },
        children: [{
          source: "local", kind: "project", id: P3.locator.projectId, key: "project", label: P3.name,
          locator: P3.locator, envs: [], workflows: [], children: [],
        }],
      }],
    };
    const localTab = fixture.tabs.tabs.find((tab) => tab.workspaceRef.kind === "local");
    if (!localTab) throw new Error("Fixture is missing a local project tab");
    await fixture.tabs.activateTab(localTab.tabId);
    const wrapper = await mountTopBar(fixture);
    await wrapper.find('[data-testid="settings-toggle"]').trigger("click");
    await flushPromises();
    expect(bodyFind("network-settings")).not.toBeNull();

    await fixture.tabs.activateHome();
    await flushPromises();
    expect(bodyFind("network-settings")).toBeNull();
    const onlineTab = fixture.tabs.tabs.find((tab) => tab.workspaceRef.kind === "online");
    if (!onlineTab) throw new Error("Fixture is missing an online project tab");
    await fixture.tabs.activateTab(onlineTab.tabId);
    await flushPromises();
    expect(bodyFind("network-settings")).toBeNull();
  });
});

describe("F7e T10 application AI settings", () => {
  // Catches accidentally gating personal settings on a local project, or opening a second AI store/dialog.
  it.each(["Home", "local", "online", "more"] as const)("%s opens the shared AI management dialog from application settings", async (location) => {
    const fixture = makeFixture();
    await seedTabs(fixture);
    if (location === "Home" || location === "more") await fixture.tabs.activateHome();
    else {
      const tab = fixture.tabs.tabs.find((value) => value.workspaceRef.kind === location);
      if (!tab) throw new Error(`Missing ${location} fixture tab`);
      await fixture.tabs.activateTab(tab.tabId);
    }
    const { api } = createSafeAiSettingsFixture();
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const ai = createAiStore({ api, editor, storage: memStorage(), getContext: () => ({ root: "", readOnly: false }) });
    await ai.init();
    const plugins = createPluginsStore({ api });
    const { i18n } = createI18nInstance();
    const harness = defineComponent({ setup: () => () => [
      h(TopBar, {
        workspace: fixture.workspace as unknown as ReturnType<typeof useWorkspaceStore>,
        tree: fixture.tree as unknown as ReturnType<typeof useTreeStore>,
        api, online: fixture.topbarOnline, plugins, tabs: fixture.tabs, reportError: vi.fn(), ai,
      }),
      h(AiConfigDialog, { ai }),
    ] });
    const wrapper = mount(harness, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(ai.configDialogOpen).toBe(false);
    if (location === "more") {
      await wrapper.get('[data-testid="topbar-more"]').trigger("click");
      await flushPromises();
      await expectBody("more-settings").trigger("click");
    } else await wrapper.get('[data-testid="settings-toggle"]').trigger("click");
    await flushPromises();
    const drawer = new DOMWrapper(document.body).find(".ant-drawer-body");
    expect(drawer.exists(), "application settings drawer must be mounted before checking its actions").toBe(true);
    expect(drawer.text()).toContain("AI 与模型");
    const entry = drawer.findAll("button").find((button) => button.text().includes("AI 与模型"));
    expect(entry, "settings must offer a visible AI management action").toBeDefined();
    await entry!.trigger("click");
    await flushPromises();
    expect(ai.configDialogOpen).toBe(true);
    expect(document.body.querySelectorAll('[data-testid="ai-config-body"]')).toHaveLength(1);
    expect(expectBody("ai-config-body").text()).toContain("个人主连接");
    await expectBody("ai-config-close").trigger("click");
    await flushPromises();
    expect(ai.configDialogOpen).toBe(false);
    expect(bodyFind("ai-config-body")).toBeNull();
  });
});

describe("TopBar 退出在线工作区确认（计划 C 任务 6，不变量 4）", () => {
  it("点击退出 → 确认弹窗列出该工作区签与草稿态；取消不动（会话与签表原样）", async () => {
    const fixture = makeFixture();
    await seedTabs(fixture);
    const wrapper = await mountTopBar(fixture);
    await wrapper.find('[data-testid="online-exit"]').trigger("click");
    await flushPromises();
    // 确认前不关闭：弹窗列出 ws-1 的两个签，项目一标注草稿
    expect(fixture.topbarOnline.closeWorkspace).not.toHaveBeenCalled();
    expect(fixture.tabs.tabs).toHaveLength(3);
    expect(expectBody("online-exit-impact").exists()).toBe(true);
    expect(expectBody("online-exit-tab-0").text()).toContain("项目一");
    expect(expectBody("online-exit-tab-0").find('[data-testid="online-exit-draft"]').exists()).toBe(true);
    expect(expectBody("online-exit-tab-1").text()).toContain("项目二");
    expect(expectBody("online-exit-tab-1").find('[data-testid="online-exit-draft"]').exists()).toBe(false);
    // 取消：签表与会话原样，弹窗关闭
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    expect(fixture.tabs.tabs).toHaveLength(3);
    expect(fixture.topbarOnline.closeWorkspace).not.toHaveBeenCalled();
    expect(fixture.online.activeWorkspaceId).toBe("ws-1");
    expect(bodyFind("online-exit-impact")).toBeNull();
  });

  it("确认 → 先关该工作区全部签（逐签驱逐会话）再 closeWorkspace(wsId)；其他工作区与本地签保留", async () => {
    const fixture = makeFixture();
    await seedTabs(fixture);
    const wrapper = await mountTopBar(fixture);
    await wrapper.find('[data-testid="online-exit"]').trigger("click");
    await flushPromises();
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    // ws-1 全部签关闭（含脏签——工作区级关闭已确认，签级不再拦截），本地签保留
    expect(fixture.tabs.tabs.map(projectIdOf)).toEqual([P3.locator.projectId]);
    // 驱逐真实落地：ws-1 会话的 p-1 前缀脏缓冲被逐
    expect(fixture.onlineSessions["ws-1"].buffers["p-1/collections/c/apis/a/api.yaml"]).toBeUndefined();
    // 工作区会话出表（带 id），其他驻留工作区不受影响
    expect(fixture.topbarOnline.closeWorkspace).toHaveBeenCalledTimes(1);
    expect(fixture.topbarOnline.closeWorkspace).toHaveBeenCalledWith("ws-1");
    expect(fixture.onlineSessions["ws-2"]).toBeDefined();
    expect(bodyFind("online-exit-impact")).toBeNull();
  });

  it("无签工作区也确认：弹窗呈现空签文案；确认仅关工作区会话", async () => {
    const fixture = makeFixture();
    const wrapper = await mountTopBar(fixture);
    await wrapper.find('[data-testid="online-exit"]').trigger("click");
    await flushPromises();
    expect(expectBody("online-exit-impact").text()).toContain("没有打开的项目签");
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect(fixture.topbarOnline.closeWorkspace).toHaveBeenCalledWith("ws-1");
    expect(fixture.tabs.tabs).toHaveLength(0);
  });
});
