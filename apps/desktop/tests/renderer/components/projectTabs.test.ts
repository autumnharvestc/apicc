// @vitest-environment jsdom
// 计划 C 任务 5：ProjectTabs 组件——渲染/激活高亮/滚动箭头（仅溢出）/关签确认两分支/离线禁用态。
// 装配约定同 components.test.ts：tabs store 由 createTabsStore(deps) 真实构造后经 props 注入
// （组件内零工厂调用）；deps 全内存 stub（不发 IPC）。关签 dirty 判定走 store 的
// projectHasDrafts（聚合该项目全部草稿源），本文件钉住「非活跃槽脏也拦截」与
// workflowDesign 归属过滤。a-modal（ConfirmDialog）传送门内容用 body 作用域查询
// （expectBody/bodyHas，先例同 App.test.ts / onlineWorkspace.test.ts）。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import ProjectTabs from "../../../src/renderer/src/components/ProjectTabs.vue";
import {
  createEvictProjectSessions,
  createTabsStore,
  type TabsStoreDeps,
  type WorkspaceRef,
} from "../../../src/renderer/src/stores/tabs.js";
import type { EditorSession } from "../../../src/renderer/src/stores/editor.js";
import type { OnlineSession } from "../../../src/renderer/src/stores/online.js";
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

const LOCAL_REF: WorkspaceRef = { kind: "local", dir: "/tmp/ws-local" };
const ONLINE_REF: WorkspaceRef = { kind: "online", workspaceId: "ws-1", name: "在线一" };
const P1 = { id: "p-1", name: "项目一" };
const P2 = { id: "p-2", name: "项目二" };

/** 本地树夹具：项目一（接口甲/乙 + 工作流 wf-1）、项目二（接口丙）——projectHasDrafts 收集与归属过滤的取数面。 */
const TREE: TreeNodeDTO = {
  id: "root",
  kind: "root",
  label: "工作区",
  children: [
    {
      id: "g-1",
      kind: "group",
      label: "分组",
      children: [
        {
          id: "p-1",
          kind: "project",
          label: "项目一",
          workflows: [{ id: "wf-1", name: "流一", status: "draft" }],
          children: [
            {
              id: "c-1",
              kind: "collection",
              label: "集合",
              children: [
                { id: "a-1", kind: "api", label: "接口甲" },
                { id: "a-2", kind: "api", label: "接口乙" },
              ],
            },
          ],
        },
        {
          id: "p-2",
          kind: "project",
          label: "项目二",
          children: [
            {
              id: "c-2",
              kind: "collection",
              label: "集合二",
              children: [{ id: "a-3", kind: "api", label: "接口丙" }],
            },
          ],
        },
      ],
    },
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
function cleanSession(apiId: string): EditorSession {
  const api = { id: apiId, name: `接口-${apiId}` } as EditorSession["api"];
  return { api, envs: [], snapshot: JSON.stringify(api) };
}

/** 脏会话槽：缓冲相对快照有未保存修改。 */
function dirtySession(apiId: string): EditorSession {
  const session = cleanSession(apiId);
  session.api!.name = "未保存的改名";
  return session;
}

/** deps 内存 stub：含关签 dirty 判定的三个聚合源（editor 会话表 / 在线缓冲表 / workflowDesign 单会话）。 */
function makeDeps() {
  const storage = memStorage();
  const workspace = {
    opened: false,
    root: "/tmp/ws-local",
    tree: TREE as TreeNodeDTO | null,
    open: vi.fn(async (dir: string) => {
      workspace.opened = true;
      workspace.root = dir;
    }),
  };
  const tree = { select: vi.fn(async () => {}) };
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
  const editor = { sessions: {} as Record<string, EditorSession>, evictProject: vi.fn() };
  const workflowDesign = { dirty: false, workflowId: null as string | null };
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
  return { deps, storage, workspace, tree, online, editor, workflowDesign, evictProjectSessions };
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
    expect(tree.select).toHaveBeenCalledWith("project", "p-1");
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
    expect(tabs.tabs.map((t) => t.projectId)).toEqual(["p-2"]);
    expect(evictProjectSessions).toHaveBeenCalledWith(LOCAL_REF, "p-1");
    expect(bodyHas("dialog-confirm")).toBe(false);
  });

  it("非活跃槽脏也拦截：活跃编辑槽干净、同项目非活跃槽脏 → 弹「未保存的修改将丢弃」；取消保留、确认后关签驱逐", async () => {
    const { deps, evictProjectSessions } = makeDeps();
    deps.editor!.sessions["a-1"] = dirtySession("a-1"); // 项目一非活跃槽：脏
    deps.editor!.sessions["a-2"] = cleanSession("a-2"); // 项目一活跃槽：干净
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
    expect(tabs.tabs.map((t) => t.projectId)).toEqual(["p-2"]);
    expect(evictProjectSessions).toHaveBeenCalledWith(LOCAL_REF, "p-1");
  });

  it("workflowDesign 草稿归属过滤：活跃工作流属于该项目才拦截；不属于则直关", async () => {
    const { deps, workflowDesign } = makeDeps();
    workflowDesign.dirty = true;
    workflowDesign.workflowId = "wf-1"; // 属于项目一（tree workflows 摘要）
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
    expect(tabs.tabs.map((t) => t.projectId)).toEqual(["p-1"]);
    expect(bodyHas("dialog-confirm")).toBe(false);
  });

  it("在线签：`<projectId>/` 前缀缓冲槽任一 dirty 拦截（其他前缀不牵连）", async () => {
    const { deps, workspace, editor, online } = makeDeps();
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
    deps.evictProjectSessions = createEvictProjectSessions({ workspace, editor, online: deps.online as never });
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
