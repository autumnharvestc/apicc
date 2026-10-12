// @vitest-environment jsdom
// 计划 C 任务 5：ProjectTabs 组件——渲染/激活高亮/滚动箭头（仅溢出）/关签确认两分支/离线禁用态。
// 装配约定同 components.test.ts：tabs store 由 createTabsStore(deps) 真实构造后经 props 注入
// （组件内零工厂调用）；deps 全内存 stub（不发 IPC）。关签 dirty 判定走 store 的
// projectHasDrafts（聚合该项目全部草稿源），本文件钉住「非活跃槽脏也拦截」与
// workflowDesign 归属过滤。a-modal（ConfirmDialog）传送门内容用 body 作用域查询
// （expectBody/bodyHas，先例同 App.test.ts / onlineWorkspace.test.ts）。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import type { ApiAsset } from "@apicc/core";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import ProjectTabs from "../../../src/renderer/src/components/ProjectTabs.vue";
import {
  createEvictProjectSessions,
  createTabsStore,
  type ProjectTab,
  type TabsStoreDeps,
  type WorkspaceRef,
} from "../../../src/renderer/src/stores/tabs.js";
import type { EditorSession } from "../../../src/renderer/src/stores/editor.js";
import type { OnlineSession } from "../../../src/renderer/src/stores/online.js";
import type { LocalProjectTreeNodeDTO, LocalRootTreeNodeDTO } from "../../../src/shared/tree-dto.js";
import type { ProjectLocator, WorkflowLocator } from "../../../src/shared/locations.js";

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
  // 溢出检测挂 ResizeObserver（jsdom 未实现，与 App.test.ts 同款 stub）
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
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

function projectIdOf(tab: ProjectTab): string {
  return "projectLocator" in tab ? tab.projectLocator.projectId : tab.projectId;
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

const LOCAL_REF = { kind: "local", dir: "/tmp/ws-local" } as const satisfies WorkspaceRef;
const ONLINE_REF = { kind: "online", workspaceId: "ws-1", name: "在线一" } as const satisfies WorkspaceRef;
const PROJECT_1: ProjectLocator = { workspaceId: "20000000-0000-4000-8000-000000000001", groupId: "20000000-0000-4000-8000-000000000002", projectId: "20000000-0000-4000-8000-000000000011" };
const PROJECT_2: ProjectLocator = { ...PROJECT_1, projectId: "20000000-0000-4000-8000-000000000012" };
const PROJECT_1_OTHER_GROUP: ProjectLocator = { ...PROJECT_1, groupId: "20000000-0000-4000-8000-000000000003" };
const P1 = { id: "p-1", name: "项目一", locator: PROJECT_1 };
const P2 = { id: "p-2", name: "项目二", locator: PROJECT_2 };

/** 本地树夹具：项目一（接口甲/乙 + 工作流 wf-1）、项目二（接口丙）——projectHasDrafts 收集与归属过滤的取数面。 */
const TREE: LocalRootTreeNodeDTO = {
  source: "local", id: PROJECT_1.workspaceId, key: "local:root", kind: "root",
  locator: { workspaceId: PROJECT_1.workspaceId }, label: "工作区",
  children: [
    {
      source: "local", id: PROJECT_1.groupId, key: "local:group:1", kind: "group",
      locator: { workspaceId: PROJECT_1.workspaceId, groupId: PROJECT_1.groupId }, label: "分组",
      children: [
        { source: "local", id: P1.id, key: "local:project:1", kind: "project", locator: PROJECT_1,
          label: P1.name, envs: [], workflows: [{ source: "local", id: "wf-1", key: "local:workflow:1", name: "流一", status: "draft", locator: { ...PROJECT_1, workflowId: "wf-1" } }], children: [] },
        { source: "local", id: P2.id, key: "local:project:2", kind: "project", locator: PROJECT_2, label: P2.name, envs: [], workflows: [], children: [] },
      ],
    },
    { source: "local", id: PROJECT_1_OTHER_GROUP.groupId, key: "local:group:2", kind: "group",
      locator: { workspaceId: PROJECT_1_OTHER_GROUP.workspaceId, groupId: PROJECT_1_OTHER_GROUP.groupId }, label: "第二分组",
      children: [{ source: "local", id: "p-1-other", key: "local:project:1-other", kind: "project",
        locator: PROJECT_1_OTHER_GROUP, label: "同 ID 不同分组", envs: [], workflows: [], children: [] }] },
  ],
};

function sessionStub(id: string): OnlineSession {
  return {
    workspace: { id, name: "在线一", myRole: "OWNER" },
    tree: null,
    projects: [],
    buffers: {},
    activeEditorPath: null,
  };
}

/** 干净会话槽：api 与快照一致。 */
function cleanSession(apiId: string, project: ProjectLocator = PROJECT_1): EditorSession {
  const locator = { ...project, collectionId: "30000000-0000-4000-8000-000000000001", folderIds: [], apiId };
  const api: ApiAsset = {
    contract: {
      formatVersion: 1, id: apiId,
      metadata: { name: `接口-${apiId}`, description: "", tags: [], version: "1.0.0", status: "draft" },
      request: { protocol: "http", method: "GET", baseUrl: "", path: "/", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } },
      responses: [],
    },
    cases: [], documentation: "",
  };
  return { root: LOCAL_REF.dir, locator, api, envs: [], snapshot: JSON.stringify(api), protocolDrafts: {}, generation: 1 };
}

/** 脏会话槽：缓冲相对快照有未保存修改。 */
function dirtySession(apiId: string, project: ProjectLocator = PROJECT_1): EditorSession {
  const session = cleanSession(apiId, project);
  session.api.contract.metadata.name = "未保存的改名";
  return session;
}

/** deps 内存 stub：含关签 dirty 判定的三个聚合源（editor 会话表 / 在线缓冲表 / workflowDesign 单会话）。 */
function makeDeps() {
  const storage = memStorage();
  const workspace = {
    opened: false,
    root: "/tmp/ws-local",
    tree: TREE,
    open: vi.fn(async (dir: string) => {
      workspace.opened = true;
      workspace.root = dir;
    }),
  };
  const tree = { select: vi.fn(async (_node: LocalProjectTreeNodeDTO) => {}) };
  const online = {
    sessions: {} as TabsStoreDeps["online"]["sessions"],
    activeWorkspaceId: null as string | null,
    error: null as string | null,
    activateWorkspace: vi.fn(async (workspaceId: string) => {
      if (!online.sessions[workspaceId]) {
        online.error = "尚未打开在线工作区";
        return;
      }
      online.error = null;
      online.activeWorkspaceId = workspaceId;
    }),
    selectNode: vi.fn(async () => {}),
    evictProjectBuffers: (workspaceId: string, projectId: string) => {
      const session = online.sessions[workspaceId];
      if (!session) return;
      for (const path of Object.keys(session.buffers)) {
        if (path.startsWith(`${projectId}/`)) delete session.buffers[path];
      }
    },
  };
  const editorSessions = {} as Record<string, EditorSession>;
  const editor = {
    sessions: editorSessions,
    evictProject: vi.fn(),
    isProjectDirty: (locator: ProjectLocator, root: string) => Object.values(editorSessions).some((session) =>
      session.root === root && session.locator.workspaceId === locator.workspaceId
      && session.locator.groupId === locator.groupId && session.locator.projectId === locator.projectId
      && JSON.stringify(session.api) !== session.snapshot),
  };
  const workflowDesign = { dirty: false, locator: null as WorkflowLocator | null };
  const evictProjectSessions = vi.fn();
  const deps: TabsStoreDeps = {
    workspace,
    tree,
    online,
    editor,
    workflowDesign,
    evictProjectSessions,
    storage,
  };
  return { deps, storage, workspace, tree, online, editor, editorSessions, workflowDesign, evictProjectSessions };
}

async function mountTabs(deps: TabsStoreDeps) {
  const tabs = createTabsStore(deps);
  const { i18n } = createI18nInstance();
  const wrapper = mount(ProjectTabs, { props: { tabs }, global: { plugins: [i18n] } });
  await flushPromises();
  return { wrapper, tabs };
}

describe("ProjectTabs 渲染与激活（计划 C 任务 5）", () => {
  it("空签表不渲染签条；成签后逐签渲染项目名与关闭钮", async () => {
    const { deps } = makeDeps();
    const { wrapper, tabs } = await mountTabs(deps);
    expect(wrapper.find('[data-testid="project-tabs"]').exists()).toBe(false);
    await tabs.openProjectTab(LOCAL_REF, P1);
    await tabs.openProjectTab(LOCAL_REF, P2);
    await flushPromises();
    expect(wrapper.find('[data-testid="project-tabs"]').exists()).toBe(true);
    const items = wrapper.findAll(".tab-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.text()).toContain("项目一");
    expect(items[1]!.text()).toContain("项目二");
    expect(wrapper.find('[data-testid="project-tab-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tab-close-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tab-close-1"]').exists()).toBe(true);
  });

  it("激活高亮：活跃签 active 类 + data-active；点另一签走 activateTab 编排（本地项目选中）并迁移高亮", async () => {
    const { deps, tree } = makeDeps();
    const { wrapper, tabs } = await mountTabs(deps);
    await tabs.openProjectTab(LOCAL_REF, P1); // tab-1
    await tabs.openProjectTab(LOCAL_REF, P2); // tab-2（活跃）
    await flushPromises();
    expect(wrapper.find('[data-testid="project-tab-1"]').classes()).toContain("active");
    expect(wrapper.find('[data-testid="project-tab-1"]').attributes("data-active")).toBe("true");
    expect(wrapper.find('[data-testid="project-tab-0"]').classes()).not.toContain("active");
    tree.select.mockClear();
    await wrapper.find('[data-testid="project-tab-0"]').trigger("click");
    await flushPromises();
    expect(tabs.activeTabId).toBe("tab-1");
    expect(tree.select).toHaveBeenCalledWith(expect.objectContaining({ kind: "project", locator: PROJECT_1 }));
    expect(wrapper.find('[data-testid="project-tab-0"]').classes()).toContain("active");
    expect(wrapper.find('[data-testid="project-tab-1"]').attributes("data-active")).toBe("false");
  });
});

describe("ProjectTabs 关签（dirty 确认两分支，不变量 3）", () => {
  it("无草稿：点 × 直关不弹确认，签出表且驱逐钩子按 (workspaceRef, projectId) 被调", async () => {
    const { deps, evictProjectSessions } = makeDeps(); // editor 无任何会话槽 → 无草稿
    const { wrapper, tabs } = await mountTabs(deps);
    await tabs.openProjectTab(LOCAL_REF, P1);
    await tabs.openProjectTab(LOCAL_REF, P2); // 活跃 tab-2
    await flushPromises();
    await wrapper.find('[data-testid="tab-close-0"]').trigger("click");
    await flushPromises();
    expect(tabs.tabs.map(projectIdOf)).toEqual([PROJECT_2.projectId]);
    expect(evictProjectSessions).toHaveBeenCalledWith(expect.objectContaining({ projectLocator: PROJECT_1 }));
    expect(bodyHas("dialog-confirm")).toBe(false);
  });

  it("非活跃槽脏也拦截：活跃编辑槽干净、同项目非活跃槽脏 → 弹「未保存的修改将丢弃」；取消保留、确认后关签驱逐", async () => {
    const { deps, editorSessions, evictProjectSessions } = makeDeps();
    editorSessions["a-1"] = dirtySession("a-1", PROJECT_1); // 项目一非活跃槽：脏（完整 locator 归属）
    editorSessions["a-2"] = cleanSession("a-2", PROJECT_1); // 项目一活跃槽：干净
    const { wrapper, tabs } = await mountTabs(deps);
    await tabs.openProjectTab(LOCAL_REF, P1); // tab-1（项目一，非活跃签）
    await tabs.openProjectTab(LOCAL_REF, P2); // tab-2（活跃）
    await flushPromises();
    await wrapper.find('[data-testid="tab-close-0"]').trigger("click");
    await flushPromises();
    expect(tabs.tabs).toHaveLength(2); // 确认前不关
    // a-modal 传送门渲染于 body：ok/cancel 按钮经 okButtonProps/cancelButtonProps 保留 testid
    expect(bodyHas("dialog-confirm")).toBe(true);
    expect(document.body.textContent).toContain("未保存的修改将丢弃");
    // 取消：签保留、活跃不受影响
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    expect(tabs.tabs).toHaveLength(2);
    expect(tabs.activeTabId).toBe("tab-2");
    expect(bodyHas("dialog-confirm")).toBe(false);
    // 再点 × 并确认丢弃：关签 + 驱逐
    await wrapper.find('[data-testid="tab-close-0"]').trigger("click");
    await flushPromises();
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect(tabs.tabs.map(projectIdOf)).toEqual([PROJECT_2.projectId]);
    expect(evictProjectSessions).toHaveBeenCalledWith(expect.objectContaining({ projectLocator: PROJECT_1 }));
  });

  it("workflowDesign 草稿归属过滤：活跃工作流属于该项目才拦截；不属于则直关", async () => {
    const { deps, workflowDesign } = makeDeps();
    workflowDesign.dirty = true;
    workflowDesign.locator = { ...PROJECT_1, workflowId: "wf-1" }; // 属于项目一（tree workflows 摘要）
    const { wrapper, tabs } = await mountTabs(deps);
    await tabs.openProjectTab(LOCAL_REF, P1); // tab-1
    await tabs.openProjectTab(LOCAL_REF, P2); // tab-2（活跃）
    await flushPromises();
    await wrapper.find('[data-testid="tab-close-0"]').trigger("click");
    await flushPromises();
    expect(bodyHas("dialog-confirm")).toBe(true); // 归属 p-1 → 拦截
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    // 同一草稿流不属于项目二：p-2 无任何草稿 → 直关
    await wrapper.find('[data-testid="tab-close-1"]').trigger("click");
    await flushPromises();
    expect(tabs.tabs.map(projectIdOf)).toEqual([PROJECT_1.projectId]);
    expect(bodyHas("dialog-confirm")).toBe(false);
  });

  it("同 projectId 不同 group 的脏槽不串扰：关闭另一定位的签不触发确认", async () => {
    const { deps, editorSessions } = makeDeps();
    editorSessions["a-x"] = dirtySession("a-x", PROJECT_1);
    const { wrapper, tabs } = await mountTabs(deps);
    await tabs.openProjectTab(LOCAL_REF, P1);
    await tabs.openProjectTab(LOCAL_REF, { id: "p-1-other", name: "同 ID 不同分组", locator: PROJECT_1_OTHER_GROUP });
    await flushPromises();
    await wrapper.find('[data-testid="tab-close-1"]').trigger("click");
    await flushPromises();
    expect(tabs.tabs).toHaveLength(1);
    expect(bodyHas("dialog-confirm")).toBe(false);
  });

  it("在线签：`<projectId>/` 前缀缓冲槽任一 dirty 拦截（其他前缀不牵连）", async () => {
    const { deps, editor, online } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1");
    online.activeWorkspaceId = "ws-1";
    online.sessions["ws-1"].buffers["p-1/collections/c/apis/a/api.yaml"] = {
      path: "p-1/collections/c/apis/a/api.yaml",
      kind: "api",
      api: { id: "a", name: "改过的接口" } as never,
      raw: "",
      problems: [],
      version: 2,
      snapshot: JSON.stringify({ id: "a", name: "原接口" }),
      loading: false,
    };
    online.sessions["ws-1"].buffers["p-2/other.yaml"] = {
      path: "p-2/other.yaml",
      kind: "file",
      api: null,
      raw: "",
      problems: [],
      version: 1,
      snapshot: "",
      loading: false,
    };
    // 真实驱逐组装（与 App 组合根同款）：在线签驱逐按前缀删缓冲槽
    deps.evictProjectSessions = createEvictProjectSessions({ editor, online });
    const { wrapper, tabs } = await mountTabs(deps);
    await tabs.openProjectTab(ONLINE_REF, P1); // tab-1（在线项目一，缓冲脏）
    await flushPromises();
    await wrapper.find('[data-testid="tab-close-0"]').trigger("click");
    await flushPromises();
    expect(bodyHas("dialog-confirm")).toBe(true);
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect(tabs.tabs).toHaveLength(0);
    expect(online.sessions["ws-1"].buffers["p-1/collections/c/apis/a/api.yaml"]).toBeUndefined(); // 该项目前缀槽被逐
    expect(online.sessions["ws-1"].buffers["p-2/other.yaml"]).toBeDefined(); // 其他项目前缀不牵连
  });
});

describe("ProjectTabs 离线签（禁用态可再激活）", () => {
  it("离线签渲染禁用态；点按重试激活（仍失败不切换）；× 直关离线签", async () => {
    const { deps } = makeDeps(); // online.sessions 空 → 在线签必离线（分歧防御口径）
    const { wrapper, tabs } = await mountTabs(deps);
    await tabs.openProjectTab(ONLINE_REF, P1);
    await flushPromises();
    const tab = wrapper.find('[data-testid="project-tab-0"]');
    expect(tab.classes()).toContain("offline");
    expect(tab.attributes("data-offline")).toBe("true");
    await tab.trigger("click"); // 重试激活
    await flushPromises();
    expect(tabs.activeTabId).toBeNull(); // 重试失败：不切换
    expect(tabs.error).toContain("离线");
    // 离线签无草稿 → × 直关（会话表空，无缓冲可逐）
    await wrapper.find('[data-testid="tab-close-0"]').trigger("click");
    await flushPromises();
    expect(tabs.tabs).toHaveLength(0);
  });
});

describe("ProjectTabs 溢出滚动箭头（仅溢出时显示）", () => {
  it("不溢出无箭头；桩化 scrollWidth/clientWidth 后出现两侧低对比箭头，点箭头横向滚动", async () => {
    const { deps } = makeDeps();
    const { wrapper, tabs } = await mountTabs(deps);
    await tabs.openProjectTab(LOCAL_REF, P1);
    await flushPromises();
    expect(wrapper.find('[data-testid="tabs-arrow-left"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="tabs-arrow-right"]').exists()).toBe(false);
    // jsdom 无布局：桩化滚动容器的宽度读数后触发 resize 重判溢出
    const scrollerEl = wrapper.find('[data-testid="project-tabs-scroll"]').element as HTMLElement;
    Object.defineProperty(scrollerEl, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(scrollerEl, "clientWidth", { value: 300, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await flushPromises();
    expect(wrapper.find('[data-testid="tabs-arrow-left"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tabs-arrow-right"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tabs-arrow-right"]').classes()).toContain("tabs-arrow");
    await wrapper.find('[data-testid="tabs-arrow-right"]').trigger("click");
    const scroller = wrapper.find('[data-testid="project-tabs-scroll"]').element as HTMLElement;
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    await wrapper.find('[data-testid="tabs-arrow-left"]').trigger("click");
    expect(scroller.scrollLeft).toBe(0);
  });
});
