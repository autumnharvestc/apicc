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
import type { createPluginsStore } from "../../../src/renderer/src/stores/plugins.js";
import type { OnlineSession } from "../../../src/renderer/src/stores/online.js";
import {
  createEvictProjectSessions,
  createTabsStore,
  type TabsStoreDeps,
  type WorkspaceRef,
} from "../../../src/renderer/src/stores/tabs.js";
import type { TreeNodeDTO } from "../../../src/shared/tree-dto.js";

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
const P3 = { id: "p-3", name: "本地项目" };

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
    tree: null as TreeNodeDTO | null,
    open: vi.fn(async () => {}),
  };
  const tree = { selected: null, select: vi.fn(async () => {}) };
  const editor = { sessions: {}, evictProject: vi.fn() };
  const workflowDesign = { dirty: false, workflowId: null as string | null };
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
  const wrapper = mount(TopBar, {
    props: {
      workspace: fixture.workspace as unknown as ReturnType<typeof useWorkspaceStore>,
      tree: fixture.tree as unknown as ReturnType<typeof useTreeStore>,
      api: {} as ApiccApi,
      online: fixture.topbarOnline,
      plugins: {} as ReturnType<typeof createPluginsStore>,
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
  await fixture.tabs.openProjectTab({ kind: "local", dir: "/tmp/ws-local" }, P3); // tab-3
  await flushPromises();
}

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
    expect(fixture.tabs.tabs.map((t) => t.projectId)).toEqual(["p-3"]);
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
