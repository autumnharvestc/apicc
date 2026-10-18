// @vitest-environment jsdom
// 计划 C 任务 3：tabs store——项目签注册表、激活编排、持久化与恢复。
// deps 全内存 stub（不发 IPC）：workspace.open / online.activateWorkspace / online.selectNode
// 以可控行为替身注入（结构化 Pick 类型，无需真实 Pinia store）。用例清单钉住简报动作面：
// ①成签去重（同 ref+project 仅激活）②切换编排顺序（在线 activate→项目选中）
// ③离线标记（任务 2 审查裁定的分歧防御 + activate 失败 + 本地 open 失败）
// ④关签驱逐钩子被调与相邻激活（不变量 3）⑤持久化往返（apicc.projectTabs）
// ⑥恢复重建（失败签标记离线可再激活）⑦形状守卫（损坏 JSON 降级空表，照 online.ts readPersisted 先例）。
import { describe, expect, it, vi } from "vitest";
import type { TreeNodeDTO } from "../../../src/shared/tree-dto.js";
import type { LocalProjectTreeNodeDTO, LocalRootTreeNodeDTO } from "../../../src/shared/tree-dto.js";
import type { ProjectLocator, WorkflowLocator, WorkspaceLocator } from "../../../src/shared/locations.js";
import type { OnlineSession } from "../../../src/renderer/src/stores/online.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useWorkflowDesignStore } from "../../../src/renderer/src/stores/workflowDesign.js";
import { apiSessionKey } from "../../../src/renderer/src/stores/localIdentity.js";
import {
  STORAGE_KEY,
  createEvictProjectSessions,
  createTabsStore,
  readPersistedTabs,
  type ProjectTab,
  type TabsStoreDeps,
  type WorkspaceRef,
} from "../../../src/renderer/src/stores/tabs.js";

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
const P1 = { id: "p-1", name: "项目一" };
const P2 = { id: "p-2", name: "项目二" };
const P3 = { id: "p-3", name: "项目三" };

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const SHARED_PROJECT_ID = "10000000-0000-4000-8000-000000000004";
const PROJECT_A: ProjectLocator = {
  workspaceId: WORKSPACE_ID,
  groupId: "10000000-0000-4000-8000-000000000002",
  projectId: SHARED_PROJECT_ID,
};
const PROJECT_B: ProjectLocator = {
  workspaceId: WORKSPACE_ID,
  groupId: "10000000-0000-4000-8000-000000000003",
  projectId: SHARED_PROJECT_ID,
};
const FULL_LOCAL_REF = { kind: "local", dir: "/tmp/ws-full" } as const satisfies WorkspaceRef;
const LOCAL_PROJECTS: Record<string, ProjectLocator> = {
  "p-1": { workspaceId: "20000000-0000-4000-8000-000000000001", groupId: "20000000-0000-4000-8000-000000000002", projectId: "20000000-0000-4000-8000-000000000011" },
  "p-2": { workspaceId: "20000000-0000-4000-8000-000000000001", groupId: "20000000-0000-4000-8000-000000000002", projectId: "20000000-0000-4000-8000-000000000012" },
  "p-3": { workspaceId: "20000000-0000-4000-8000-000000000001", groupId: "20000000-0000-4000-8000-000000000002", projectId: "20000000-0000-4000-8000-000000000013" },
};

function localLocator(id: string): ProjectLocator {
  const locator = LOCAL_PROJECTS[id];
  if (!locator) throw new Error(`No local project locator fixture for ${id}`);
  return locator;
}

function persistedLocal(project: { id: string; name: string }, workspaceRef: Extract<WorkspaceRef, { kind: "local" }> = LOCAL_REF) {
  return { workspaceRef, projectLocator: localLocator(project.id), projectName: project.name };
}

async function openTab(tabs: ReturnType<typeof createTabsStore>, ref: WorkspaceRef, project: { id: string; name: string }): Promise<void> {
  if (ref.kind === "local") await tabs.openProjectTab(ref, { locator: localLocator(project.id), name: project.name });
  else await tabs.openProjectTab(ref, project);
}

function tabProjectId(tab: ProjectTab): string {
  return "projectLocator" in tab ? tab.projectLocator.projectId : tab.projectId;
}

function localProjectNode(locator: ProjectLocator, label: string): LocalProjectTreeNodeDTO {
  return {
    source: "local", kind: "project", id: locator.projectId,
    key: JSON.stringify(["local", "project", locator.workspaceId, locator.groupId, locator.projectId]),
    label, locator, envs: [], workflows: [], children: [],
  };
}

function stubLocalTree(): LocalRootTreeNodeDTO {
  const projects = [P1, P2, P3].map((project) => localProjectNode(localLocator(project.id), project.name));
  const groupId = "20000000-0000-4000-8000-000000000002";
  return {
    source: "local", kind: "root", id: "20000000-0000-4000-8000-000000000001",
    key: JSON.stringify(["local", "root", "20000000-0000-4000-8000-000000000001"]), label: "workspace",
    locator: { workspaceId: "20000000-0000-4000-8000-000000000001" },
    children: [{ source: "local", kind: "group", id: groupId, key: "group", label: "group",
      locator: { workspaceId: "20000000-0000-4000-8000-000000000001", groupId }, children: projects }],
  };
}

function fullLocatorDeps() {
  const storage = memStorage();
  const projectA = localProjectNode(PROJECT_A, "A");
  const projectB = localProjectNode(PROJECT_B, "B");
  const treeRoot: LocalRootTreeNodeDTO = {
    source: "local", kind: "root", id: WORKSPACE_ID,
    key: JSON.stringify(["local", "root", WORKSPACE_ID]), label: "workspace",
    locator: { workspaceId: WORKSPACE_ID } satisfies WorkspaceLocator,
    children: [
      { source: "local", kind: "group", id: PROJECT_A.groupId, key: "group-a", label: "A", locator: { workspaceId: WORKSPACE_ID, groupId: PROJECT_A.groupId }, children: [projectA] },
      { source: "local", kind: "group", id: PROJECT_B.groupId, key: "group-b", label: "B", locator: { workspaceId: WORKSPACE_ID, groupId: PROJECT_B.groupId }, children: [projectB] },
    ],
  };
  const workspace = { opened: true, root: FULL_LOCAL_REF.dir, tree: treeRoot, open: vi.fn(async () => undefined) };
  const tree = { select: vi.fn((_node: LocalProjectTreeNodeDTO) => undefined) };
  const online = {
    sessions: {} as TabsStoreDeps["online"]["sessions"], activeWorkspaceId: null as string | null, error: null as string | null,
    activateWorkspace: vi.fn(async () => undefined), selectNode: vi.fn(async () => undefined),
  };
  const deps: TabsStoreDeps = { workspace, tree, online, storage };
  return { deps, storage, tree, projectA, projectB };
}

describe("local project tabs use full project locators", () => {
  it("keeps same project id in different groups distinct and persists each complete locator", async () => {
    const { deps, storage, tree, projectA, projectB } = fullLocatorDeps();
    const tabs = createTabsStore(deps);

    await tabs.openProjectTab(FULL_LOCAL_REF, { locator: PROJECT_A, name: "A" });
    await tabs.openProjectTab(FULL_LOCAL_REF, { locator: PROJECT_B, name: "B" });

    expect(tabs.tabs).toHaveLength(2);
    expect(tabs.tabs.map((tab) => "projectLocator" in tab ? tab.projectLocator : null)).toEqual([PROJECT_A, PROJECT_B]);
    expect(tree.select).toHaveBeenLastCalledWith(projectB);
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      tabs: [
        { workspaceRef: FULL_LOCAL_REF, projectLocator: PROJECT_A, projectName: "A" },
        { workspaceRef: FULL_LOCAL_REF, projectLocator: PROJECT_B, projectName: "B" },
      ],
      activeIndex: 1,
    });
  });

  it("I08: explicit B reactivation and closing pending non-active A both converge backend, workspace, and tabs", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const workspace = useWorkspaceStore(api);
    const rootB = "/tmp/task10b-i08-b";
    const rootA = "/tmp/task10b-i08-a";
    await workspace.open(rootB);
    const project = workspace.tree!.children.flatMap((group) => group.children ?? []).find((node) => node.kind === "project");
    if (!project || project.kind !== "project") throw new Error("Memory workspace is missing its project");

    const openCalls: string[] = [];
    const realOpen = api.wsOpen.bind(api);
    let releaseExplicitA!: () => void;
    let releaseClosingA!: () => void;
    const explicitGate = new Promise<void>((resolve) => { releaseExplicitA = resolve; });
    const closingGate = new Promise<void>((resolve) => { releaseClosingA = resolve; });
    let aOpenCount = 0;
    api.wsOpen = async (rootPath) => {
      openCalls.push(rootPath);
      if (rootPath === rootA) await (aOpenCount++ === 0 ? explicitGate : closingGate);
      return realOpen(rootPath);
    };

    const selected: LocalProjectTreeNodeDTO[] = [];
    const online = {
      sessions: {}, activeWorkspaceId: null, error: null,
      activateWorkspace: async () => {}, selectNode: async () => {}, evictProjectBuffers: () => {},
    } as unknown as TabsStoreDeps["online"];
    const tabs = createTabsStore({
      workspace,
      tree: { select: (node) => { selected.push(node); } },
      online,
      storage: memStorage(),
    });

    await tabs.openProjectTab({ kind: "local", dir: rootB }, { locator: project.locator, name: project.label });
    let explicitOpeningA: Promise<void> | undefined;
    let restoringB: Promise<void> | undefined;
    let closingOpeningA: Promise<void> | undefined;
    let closingA: Promise<void> | undefined;
    try {
      explicitOpeningA = tabs.openProjectTab({ kind: "local", dir: rootA }, { locator: project.locator, name: project.label });
      await vi.waitFor(() => expect(openCalls).toEqual([rootA]));
      // B is still the active tab/root, but the older A wsOpen has already crossed the bridge.
      restoringB = tabs.activateTab("tab-1");
      releaseExplicitA();
      await Promise.all([explicitOpeningA, restoringB]);

      // Re-enter A while B remains active, then close this non-active tab during its real wsOpen.
      closingOpeningA = tabs.activateTab("tab-2");
      await vi.waitFor(() => expect(openCalls).toEqual([rootA, rootB, rootA]));
      closingA = tabs.closeTab("tab-2");
      expect(tabs.tabs.map((tab) => tab.tabId)).toEqual(["tab-1"]);
      releaseClosingA();
      await Promise.all([closingOpeningA, closingA]);

      expect(openCalls).toEqual([rootA, rootB, rootA, rootB]);
      expect(await api.wsPickDirectory()).toBe(rootB);
      expect(workspace.root).toBe(rootB);
      expect(tabs.activeTabId).toBe("tab-1");
      expect(selected[selected.length - 1]?.locator).toEqual(project.locator);
    } finally {
      releaseExplicitA();
      releaseClosingA();
      await explicitOpeningA?.catch(() => undefined);
      await restoringB?.catch(() => undefined);
      await closingOpeningA?.catch(() => undefined);
      await closingA?.catch(() => undefined);
    }
  });
});

/** 在线会话表桩条目：tabs store 只读其存在性（分歧防御），形状按 OnlineSession 补齐。 */
function sessionStub(id: string): OnlineSession {
  return {
    workspace: { id, name: "在线一", myRole: "OWNER" },
    tree: null,
    projects: [],
    buffers: {},
    activeEditorPath: null,
  };
}

/** deps 内存 stub：log 钉编排顺序；openFails/activateFails 注入可控行为（不发 IPC）。 */
function makeDeps() {
  const storage = memStorage();
  const log: string[] = [];
  const openCurrentResults: boolean[] = [];
  const workspace = {
    opened: false,
    root: "",
    tree: stubLocalTree() as LocalRootTreeNodeDTO | null, // 本地签激活按完整 locator 查真实形状的 fixture tree
    openFails: false,
    open: vi.fn(async (dir: string, isCurrent: () => boolean = () => true) => {
      log.push(`ws.open:${dir}`);
      if (workspace.openFails) throw new Error(`工作区根目录缺少 apicc.workspace.yaml: ${dir}`);
      const current = isCurrent();
      openCurrentResults.push(current);
      if (!current) return;
      workspace.opened = true;
      workspace.root = dir;
    }),
  };
  const tree = {
    select: vi.fn((node: LocalProjectTreeNodeDTO) => {
      log.push(`tree.select:project:${node.locator.projectId}`);
    }),
  };
  const online = {
    sessions: {} as TabsStoreDeps["online"]["sessions"],
    activeWorkspaceId: null as string | null,
    error: null as string | null,
    activateFails: false,
    activateWorkspace: vi.fn(async (workspaceId: string) => {
      log.push(`online.activate:${workspaceId}`);
      if (online.activateFails || !online.sessions[workspaceId]) {
        online.error = online.activateFails ? "token 验证失败" : "尚未打开在线工作区";
        return;
      }
      online.error = null;
      online.activeWorkspaceId = workspaceId;
    }),
    selectNode: vi.fn(async (kind: TreeNodeDTO["kind"], id: string) => {
      log.push(`online.selectNode:${kind}:${id}`);
    }),
  };
  const evictions: Array<{ workspaceRef: WorkspaceRef; projectId: string }> = [];
  const activatedTabs: ProjectTab[] = [];
  const deps: TabsStoreDeps = {
    workspace,
    tree,
    online,
    evictProjectSessions: (tab) => {
      const projectId = "projectLocator" in tab ? tab.projectLocator.projectId : tab.projectId;
      const workspaceRef = tab.workspaceRef;
      evictions.push({ workspaceRef, projectId });
    },
    onProjectActivated: (tab) => {
      activatedTabs.push(tab);
    },
    storage,
  };
  return { deps, storage, log, evictions, activatedTabs, openCurrentResults, workspace, tree, online };
}

describe("成签注册表（openProjectTab，不变量 1：项目选中即成签）", () => {
  it("新项目成签置活跃：tab-<自增> 运行期唯一；本地项目选中走 tree.select（App.vue:367-370 先例）", async () => {
    const { deps, tree } = makeDeps();
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    expect(tabs.tabs).toEqual([
      { tabId: "tab-1", ...persistedLocal(P1) },
    ]);
    expect(tabs.activeTabId).toBe("tab-1");
    expect(tabs.activeTab && tabProjectId(tabs.activeTab)).toBe(localLocator("p-1").projectId);
    expect(tree.select).toHaveBeenCalledWith(expect.objectContaining({ locator: localLocator("p-1") }));
    await openTab(tabs, LOCAL_REF, P2);
    expect(tabs.tabs.map((t) => t.tabId)).toEqual(["tab-1", "tab-2"]);
    expect(tabs.activeTabId).toBe("tab-2");
  });

  it("同 workspaceRef+projectId 重复成签去重：仅激活既有签（已活跃时不重跑选中——草稿零扰动，不变量 2）", async () => {
    const { deps, log } = makeDeps();
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    expect(log).toEqual(["ws.open:/tmp/ws-local", `tree.select:project:${localLocator("p-1").projectId}`]); // 首开含目录兜底重开
    log.length = 0;
    await openTab(tabs, LOCAL_REF, P1);
    expect(tabs.tabs).toHaveLength(1); // 去重：不重签
    expect(tabs.activeTabId).toBe("tab-1"); // 仅激活
    expect(log).toEqual([]); // 已活跃：no-op
  });

  it("同项目不同 ref 各成一签（本地与在线并存，去重键 = workspaceRef+projectId）", async () => {
    const { deps, online } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1");
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    await openTab(tabs, ONLINE_REF, P1);
    expect(tabs.tabs.map((t) => t.workspaceRef.kind)).toEqual(["local", "online"]);
    expect(tabs.tabs).toHaveLength(2);
  });
});

describe("激活编排（activateTab）", () => {
  it("并发激活按最新意图收敛，较早确认迟到不能重新选择旧签", async () => {
    const ctx = makeDeps();
    const gates: Array<{ resolve: (value: boolean) => void }> = [];
    ctx.deps.workflowDesign = { dirty: false, locator: { ...localLocator("p-1"), workflowId: "30000000-0000-4000-8000-000000000001" } };
    const tabs = createTabsStore(ctx.deps);
    await openTab(tabs, LOCAL_REF, P1);
    await openTab(tabs, LOCAL_REF, P2);
    await openTab(tabs, LOCAL_REF, P3);
    // 回到 P1，再从同一脏工作流并发切 P2/P3，模拟确认对话框交错。
    await tabs.activateTab("tab-1");
    ctx.deps.workflowDesign = { dirty: true, locator: { ...localLocator("p-1"), workflowId: "30000000-0000-4000-8000-000000000001" } };
    ctx.deps.confirmWorkflowDraft = vi.fn(() => new Promise<boolean>((resolve) => gates.push({ resolve })));
    const older = tabs.activateTab("tab-2");
    const newer = tabs.activateTab("tab-3");
    expect(gates).toHaveLength(2);
    gates[1]!.resolve(true);
    await newer;
    gates[0]!.resolve(true);
    await older;
    expect(tabs.activeTabId).toBe("tab-3");
    expect(ctx.tree.select).toHaveBeenLastCalledWith(expect.objectContaining({ locator: localLocator("p-3") }));
  });

  it("在线签且工作区未活跃：先 activateWorkspace 再 selectNode 项目节点（顺序钉住）", async () => {
    const { deps, online, log } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1");
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(ONLINE_REF, P1);
    expect(log).toEqual(["online.activate:ws-1", "online.selectNode:project:p-1"]);
    expect(online.activeWorkspaceId).toBe("ws-1");
    expect(tabs.activeTabId).toBe("tab-1");
    expect(tabs.offlineTabIds).toEqual([]);
    expect(tabs.error).toBeNull();
  });

  it("在线签且工作区已活跃：不重复 activate，仅项目选中", async () => {
    const { deps, online, log } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1");
    online.activeWorkspaceId = "ws-1";
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(ONLINE_REF, P1);
    expect(log).toEqual(["online.selectNode:project:p-1"]);
    expect(tabs.activeTabId).toBe("tab-1");
  });

  it("分歧防御（任务 2 审查裁定接线点）：渲染层会话表无此工作区 → 不调 activate、标记离线、error 上屏、不切换", async () => {
    const { deps, storage, online, log } = makeDeps(); // sessions 为空（main/渲染层分歧场景）
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(ONLINE_REF, P1);
    expect(log).toEqual([]); // tabs 层直接拦截，不发起 activateWorkspace
    expect(tabs.tabs).toHaveLength(1); // 签保留（离线禁用态可再激活）
    expect(tabs.offlineTabIds).toEqual(["tab-1"]);
    expect(tabs.activeTabId).toBeNull(); // 不切换
    expect(tabs.error).toContain("离线");
    expect(online.activeWorkspaceId).toBeNull();
    // 成签即落盘：首激活失败的签也驻留持久层（activeIndex null），重启可恢复后再激活
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({
      tabs: [{ workspaceRef: ONLINE_REF, projectId: "p-1", projectName: "项目一" }],
      activeIndex: null,
    });
  });

  it("activateWorkspace 失败（token 验证失败）→ 标记离线、error 上屏、不切换", async () => {
    const { deps, online } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1");
    online.activateFails = true;
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(ONLINE_REF, P1);
    expect(online.activeWorkspaceId).toBeNull();
    expect(tabs.activeTabId).toBeNull();
    expect(tabs.offlineTabIds).toEqual(["tab-1"]);
    expect(tabs.error).toBe("token 验证失败");
  });

  it("离线签可再激活：会话表补上后 activateTab 成功 → 移出 offlineTabIds 并置活跃", async () => {
    const { deps, online } = makeDeps();
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(ONLINE_REF, P1); // 会话表为空 → 离线
    expect(tabs.offlineTabIds).toEqual(["tab-1"]);
    online.sessions["ws-1"] = sessionStub("ws-1");
    await tabs.activateTab("tab-1");
    expect(tabs.activeTabId).toBe("tab-1");
    expect(tabs.offlineTabIds).toEqual([]);
    expect(tabs.error).toBeNull();
  });

  it("本地签：单例已打开同目录 → 不重开（驻留，不变量 4）；未打开 → workspace.open 兜底", async () => {
    const { deps, workspace } = makeDeps();
    workspace.opened = true;
    workspace.root = LOCAL_REF.dir;
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    expect(workspace.open).not.toHaveBeenCalled();
    expect(tabs.activeTabId).toBe("tab-1");
    const fresh = makeDeps(); // 未打开场景：兜底重开目录
    const tabs2 = createTabsStore(fresh.deps);
    await openTab(tabs2, LOCAL_REF, P1);
    expect(fresh.workspace.open).toHaveBeenCalledWith(LOCAL_REF.dir, expect.any(Function));
    expect(fresh.openCurrentResults).toEqual([true]);
    expect(tabs2.activeTabId).toBe("tab-1");
  });

  it("本地签 open 失败（目录失效）→ 标记离线、不切换", async () => {
    const { deps, workspace } = makeDeps();
    workspace.openFails = true;
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    expect(tabs.offlineTabIds).toEqual(["tab-1"]);
    expect(tabs.activeTabId).toBeNull();
    expect(tabs.error).toContain("apicc.workspace.yaml");
  });
});

describe("主页与项目页签导航（selectedPage + retained context）", () => {
  it("回主页保留项目上下文和页签；重新点同签恢复项目页且不重开工作区", async () => {
    const { deps, storage, workspace } = makeDeps();
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    const tabId = tabs.tabs[0]!.tabId;
    const openCount = workspace.open.mock.calls.length;

    tabs.activateHome();

    expect(tabs.selectedPage).toEqual({ kind: "home" });
    expect(tabs.contextTabId).toBe(tabId);
    expect(tabs.activeTabId).toBeNull();
    expect(tabs.activeTab).toBeNull();
    expect(tabs.tabs).toHaveLength(1);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toMatchObject({ activeIndex: null });

    await tabs.activateTab(tabId);

    expect(tabs.selectedPage).toEqual({ kind: "project", tabId });
    expect(tabs.contextTabId).toBe(tabId);
    expect(tabs.activeTabId).toBe(tabId);
    expect(workspace.open).toHaveBeenCalledTimes(openCount);
  });

  it("关闭主页上的后台签（含保留上下文签）不离开主页", async () => {
    const { deps } = makeDeps();
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    await openTab(tabs, LOCAL_REF, P2);
    tabs.activateHome();

    await tabs.closeTab("tab-1");
    expect(tabs.selectedPage).toEqual({ kind: "home" });
    expect(tabs.tabs.map(tabProjectId)).toEqual([localLocator("p-2").projectId]);
    expect(tabs.contextTabId).toBe("tab-2");

    await tabs.closeTab("tab-2");
    expect(tabs.selectedPage).toEqual({ kind: "home" });
    expect(tabs.contextTabId).toBeNull();
    expect(tabs.tabs).toHaveLength(0);
  });

  it("主页关闭后台签时，待完成的另一签激活完成后仍停留主页", async () => {
    const { deps, workspace } = makeDeps();
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    await openTab(tabs, LOCAL_REF, P2);
    await tabs.activateTab("tab-1");
    tabs.activateHome();

    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
    let restoreStarted = false;
    const pagesDuringRestore: string[] = [];
    deps.onProjectActivated = async (tab, isCurrent) => {
      if (tab.tabId !== "tab-1") return;
      restoreStarted = true;
      pagesDuringRestore.push(tabs.selectedPage.kind);
      await restoreGate;
      if (isCurrent()) pagesDuringRestore.push(tabs.selectedPage.kind);
    };

    let pendingOpen = true;
    Object.assign(workspace, { hasPendingOpen: () => pendingOpen });
    const releases: Array<() => void> = [];
    workspace.open = vi.fn((dir: string, isCurrent: () => boolean = () => true) => new Promise<void>((resolve) => {
      releases.push(() => {
        if (isCurrent()) {
          workspace.root = dir;
          workspace.opened = true;
          pendingOpen = false;
        }
        resolve();
      });
    }));

    const activatingBackground = tabs.activateTab("tab-2");
    await vi.waitFor(() => expect(workspace.open).toHaveBeenCalledTimes(1));
    const closingBackground = tabs.closeTab("tab-2");
    await vi.waitFor(() => expect(workspace.open).toHaveBeenCalledTimes(2));
    releases.forEach((release) => release());
    await vi.waitFor(() => expect(restoreStarted).toBe(true));

    expect(tabs.selectedPage).toEqual({ kind: "home" });
    expect(pagesDuringRestore).toEqual(["home"]);

    releaseRestore();
    await Promise.all([activatingBackground, closingBackground]);

    expect(tabs.tabs.map(tabProjectId)).toEqual([localLocator("p-1").projectId]);
    expect(tabs.contextTabId).toBe("tab-1");
    expect(tabs.selectedPage).toEqual({ kind: "home" });
    expect(pagesDuringRestore).toEqual(["home", "home"]);
  });

  it("主页意图使迟到的项目激活失效", async () => {
    const { deps, workspace } = makeDeps();
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    const tabId = tabs.tabs[0]!.tabId;
    tabs.activateHome();

    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    workspace.opened = false;
    workspace.open = vi.fn(async (dir: string) => {
      await openGate;
      workspace.opened = true;
      workspace.root = dir;
    });
    const activation = tabs.activateTab(tabId);
    await vi.waitFor(() => expect(workspace.open).toHaveBeenCalledTimes(1));
    tabs.activateHome();
    releaseOpen();
    await activation;

    expect(tabs.selectedPage).toEqual({ kind: "home" });
    expect(tabs.contextTabId).toBe(tabId);
    expect(tabs.activeTabId).toBeNull();
  });
});

describe("关签（closeTab，不变量 3：关签=项目关闭，dirty 确认由调用方负责）", () => {
  it("驱逐钩子按 (workspaceRef, projectId) 被调；签出表并跟随持久化；非活跃签关闭不动活跃", async () => {
    const { deps, evictions, storage } = makeDeps();
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    await openTab(tabs, LOCAL_REF, P2); // active = tab-2
    await tabs.closeTab("tab-1");
    expect(evictions).toEqual([{ workspaceRef: LOCAL_REF, projectId: localLocator("p-1").projectId }]);
    expect(tabs.tabs.map((t) => t.tabId)).toEqual(["tab-2"]);
    expect(tabs.activeTabId).toBe("tab-2");
    const persisted = JSON.parse(storage.getItem(STORAGE_KEY)!);
    expect(persisted.tabs).toEqual([persistedLocal(P2)]);
  });

  it("关非活跃签不动活跃；关活跃尾签回左邻（Math.min 尾分支）；签全关 → null（回主页）", async () => {
    const { deps } = makeDeps();
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1); // tab-1
    await openTab(tabs, LOCAL_REF, P2); // tab-2
    await openTab(tabs, LOCAL_REF, P3); // tab-3（活跃）
    await tabs.closeTab("tab-2");
    expect(tabs.activeTabId).toBe("tab-3"); // 非活跃签关闭：不动活跃（相邻切换分支不执行）
    await tabs.closeTab("tab-3");
    expect(tabs.activeTabId).toBe("tab-1"); // 关活跃尾签：回左邻
    await tabs.closeTab("tab-1");
    expect(tabs.activeTabId).toBeNull(); // 无签回主页
    expect(tabs.tabs).toEqual([]);
  });

  it("关活跃首签 → 右邻接任（Math.min 右邻分支，closeTab JSDoc 承诺的相邻切换主路径）", async () => {
    const { deps } = makeDeps();
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1); // tab-1（活跃）
    await openTab(tabs, LOCAL_REF, P2); // tab-2
    await tabs.closeTab("tab-1");
    expect(tabs.activeTabId).toBe("tab-2"); // 右邻接任
    expect(tabs.tabs.map((t) => t.tabId)).toEqual(["tab-2"]);
  });

  it("关活跃签且相邻激活失败 → activeTabId 置 null（回主页）+ error 上屏，离线相邻签保留", async () => {
    const WS2_REF: WorkspaceRef = { kind: "online", workspaceId: "ws-2", name: "在线二" };
    const { deps, online, evictions } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1"); // 仅 ws-1 驻留（ws-2 分歧缺席）
    const tabs = createTabsStore(deps);
    await openTab(tabs, { kind: "online", workspaceId: "ws-1", name: "在线一" }, P1); // tab-1 活跃
    await tabs.openProjectTab(WS2_REF, P2); // tab-2 分歧 → 离线，活跃仍是 tab-1
    expect(tabs.activeTabId).toBe("tab-1");
    await tabs.closeTab("tab-1"); // 关活跃首签 → 相邻 tab-2 激活失败（分歧）→ 活跃落 null
    expect(tabs.activeTabId).toBeNull();
    expect(tabs.error).toContain("离线");
    expect(tabs.tabs.map((t) => t.tabId)).toEqual(["tab-2"]); // 离线签保留（禁用态可再激活）
    expect(evictions).toEqual([{ workspaceRef: { kind: "online", workspaceId: "ws-1", name: "在线一" }, projectId: "p-1" }]);
  });

  it("相邻激活切走工作区上下文：活跃在线签关闭后本地相邻签接任（本地项目选中被重跑）", async () => {
    const { deps, online, log } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1");
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1); // tab-1（本地上下文就位）
    await tabs.openProjectTab(ONLINE_REF, P2); // tab-2（活跃，在线上下文）
    log.length = 0;
    await tabs.closeTab("tab-2");
    expect(tabs.activeTabId).toBe("tab-1");
    expect(log).toEqual([`tree.select:project:${localLocator("p-1").projectId}`]); // 本地签接任：不重开目录，仅项目选中
    expect(online.activeWorkspaceId).toBe("ws-1"); // 在线会话驻留不被动（不变量 4）
  });
});

describe("持久化与恢复（localStorage apicc.projectTabs）", () => {
  it("persist：本地保存完整 projectLocator、在线保存 projectId（只记签结构，草稿/离线态不落盘）", async () => {
    const { deps, storage, online } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1");
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    await tabs.openProjectTab(ONLINE_REF, P2); // active = tab-2
    tabs.persist();
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({
      tabs: [
        persistedLocal(P1),
        { workspaceRef: ONLINE_REF, projectId: "p-2", projectName: "项目二" },
      ],
      activeIndex: 1,
    });
  });

  it("恢复往返：新 store restore 重建签结构（tabId 重生成）+ 活跃位跟随 + 活跃签走完整编排（钩子只对活跃签）", async () => {
    const { deps, storage, workspace, tree, online, activatedTabs, openCurrentResults } = makeDeps();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          persistedLocal(P1),
          { workspaceRef: ONLINE_REF, projectId: "p-2", projectName: "项目二" },
        ],
        activeIndex: 1,
      }),
    );
    online.sessions["ws-1"] = sessionStub("ws-1");
    const tabs = createTabsStore(deps);
    await tabs.restore();
    expect(tabs.tabs.map((tab) => [tab.tabId, tabProjectId(tab), tab.projectName])).toEqual([
      ["tab-1", localLocator("p-1").projectId, "项目一"],
      ["tab-2", "p-2", "项目二"],
    ]);
    expect(tabs.activeTabId).toBe("tab-2"); // activeIndex=1
    expect(workspace.open).toHaveBeenCalledTimes(1); // 非活跃本地签重建：重开目录（工作区驻留）
    expect(workspace.open).toHaveBeenCalledWith(LOCAL_REF.dir, expect.any(Function));
    expect(openCurrentResults).toEqual([true]);
    expect(online.activeWorkspaceId).toBe("ws-1"); // 活跃签在线工作区已激活
    expect(online.selectNode).toHaveBeenCalledWith("project", "p-2");
    expect(tree.select).not.toHaveBeenCalled(); // 活跃签是在线：本地树选中不跑
    expect(activatedTabs.map(tabProjectId)).toEqual(["p-2"]); // onProjectActivated 钩子只对活跃签
  });

  it("恢复重建失败→离线态：本地 open 失败与在线 activate 失败各自标记离线；活跃位落空 → null（回主页）", async () => {
    const { deps, storage, workspace } = makeDeps();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          persistedLocal(P1),
          { workspaceRef: ONLINE_REF, projectId: "p-2", projectName: "项目二" },
        ],
        activeIndex: 1,
      }),
    );
    workspace.openFails = true; // 本地目录失效（online.sessions 空 → 在线 activate 失败）
    const tabs = createTabsStore(deps);
    await tabs.restore();
    expect(tabs.tabs).toHaveLength(2); // 签保留（禁用态可再激活）
    expect(tabs.offlineTabIds).toEqual(["tab-1", "tab-2"]);
    expect(tabs.activeTabId).toBeNull(); // 活跃签恢复失败 → 回主页
  });

  it("形状守卫：损坏 JSON 降级空签表（不抛）；空存储 restore no-op", async () => {
    const { deps, storage } = makeDeps();
    storage.setItem(STORAGE_KEY, "{{{not-json");
    expect(readPersistedTabs(storage)).toEqual({ tabs: [], activeIndex: null });
    const tabs = createTabsStore(deps);
    await tabs.restore();
    expect(tabs.tabs).toEqual([]);
    expect(tabs.activeTabId).toBeNull();
    const fresh = makeDeps(); // 空存储：restore 无签无活跃
    const tabs2 = createTabsStore(fresh.deps);
    await tabs2.restore();
    expect(tabs2.tabs).toEqual([]);
    expect(tabs2.activeTabId).toBeNull();
  });

  it("形状守卫：字段缺失/类型不符逐条过滤、重复签去重、activeIndex 越界复位 null", async () => {
    const { deps, storage } = makeDeps();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          "junk",
          { workspaceRef: { kind: "alien" }, projectId: "p-1", projectName: "x" },
          { workspaceRef: LOCAL_REF, projectId: 42, projectName: "项目一" },
          { workspaceRef: ONLINE_REF, projectId: "p-2", projectName: "项目二" },
          { workspaceRef: ONLINE_REF, projectId: "p-2", projectName: "项目二" }, // 重复签
        ],
        activeIndex: 9,
      }),
    );
    expect(readPersistedTabs(storage)).toEqual({
      tabs: [{ workspaceRef: ONLINE_REF, projectId: "p-2", projectName: "项目二" }],
      activeIndex: null,
    });
    const tabs = createTabsStore(deps);
    await tabs.restore();
    expect(tabs.tabs.map(tabProjectId)).toEqual(["p-2"]);
    expect(tabs.activeTabId).toBeNull();
  });
});

// —— 计划 C 任务 4：关签驱逐真实实现（createEvictProjectSessions，deps 装配体）——
// 本地 ref：按完整 ProjectLocator + root 驱逐 editor 会话槽；在线 ref：按 projectId 前缀
// 驱逐驻留会话缓冲槽；实现内部不抛（任务 3 钩子防护口径：closeTab 调用方不 try/catch）。
describe("关签驱逐真实实现（计划 C 任务 4：createEvictProjectSessions）", () => {
  /** 真实 store 上下文：种子项目（含接口A）+ 第二项目（接口B），供跨项目驱逐隔离验证。 */
  async function localContext() {
    const api = createMemoryApi();
    api.seedWorkspace();
    const workspace = useWorkspaceStore(api);
    await workspace.open("/tmp/ws");
    const groupNode = workspace.tree!.children.find((node) => node.kind === "group" && node.children.some((child) => child.kind === "project" && child.children.some((item) => item.kind === "collection")));
    if (!groupNode || groupNode.kind !== "group") throw new Error("Memory workspace is missing the seeded project group");
    const projectNode = groupNode.children.find((node) => node.kind === "project" && node.children.some((item) => item.kind === "collection"));
    if (!projectNode || projectNode.kind !== "project") throw new Error("Memory group is missing the seeded project");
    const collectionNode = projectNode.children.find((node) => node.kind === "collection");
    if (!collectionNode || collectionNode.kind !== "collection") throw new Error("Memory project is missing the seeded collection");
    const apiA = collectionNode.children.find((node) => node.kind === "api");
    if (!apiA || apiA.kind !== "api") throw new Error("Memory collection is missing the seeded API");
    const project2 = await api.nodeCreate({ kind: "project", parent: groupNode.locator, name: "项目二" });
    if (project2.kind !== "project") throw new Error("Memory project creation did not return a project node");
    const collection2 = await api.nodeCreate({ kind: "collection", parent: project2.locator, name: "集合乙" });
    if (collection2.kind !== "collection") throw new Error("Memory collection creation did not return a collection node");
    const apiB = await api.nodeCreate({ kind: "api", parent: collection2.locator, api: { name: "接口B" } });
    if (apiB.kind !== "api") throw new Error("Memory API creation did not return an API node");
    await workspace.refresh();
    const context = () => ({ root: workspace.root, readOnly: workspace.readOnly });
    const editor = useEditorStore(api, context);
    const online = createOnlineStoreStub();
    return { api, workspace, editor, online, projectNode, collectionNode, apiA, apiB };
  }

  /** 在线驱逐只路由不实现（真实现归 online store，已由 online-workspace.test 钉住）。 */
  function createOnlineStoreStub() {
    const calls: Array<[string, string]> = [];
    return {
      calls,
      evictProjectBuffers: (workspaceId: string, projectId: string) => {
        calls.push([workspaceId, projectId]);
      },
    };
  }

  it("本地 ref：按完整 ProjectLocator 驱逐一个项目；其他项目会话驻留、活跃不受牵连", async () => {
    const ctx = await localContext();
    await ctx.editor.load(ctx.apiA.locator);
    await ctx.editor.load(ctx.apiB.locator);
    ctx.editor.api!.contract.request.baseUrl = "/draft-b"; // 活跃在接口B（项目二）
    const evict = createEvictProjectSessions({ editor: ctx.editor, online: ctx.online });
    const root = ctx.workspace.root;
    evict({ tabId: "tab-project-a", workspaceRef: { kind: "local", dir: root }, projectLocator: ctx.projectNode.locator, projectName: ctx.projectNode.label });
    expect(ctx.editor.sessions[apiSessionKey(root, ctx.apiA.locator)]).toBeUndefined(); // 项目一槽被逐
    expect(ctx.editor.sessions[apiSessionKey(root, ctx.apiB.locator)]).toBeDefined(); // 项目二会话驻留
    expect(ctx.editor.locator).toEqual(ctx.apiB.locator); // 活跃不在驱逐集合 → 不动
  });

  it("在线 ref：路由到 online.evictProjectBuffers(workspaceId, projectId)", async () => {
    const ctx = await localContext();
    const evict = createEvictProjectSessions({ editor: ctx.editor, online: ctx.online });
    evict({ tabId: "tab-online", workspaceRef: { kind: "online", workspaceId: "ws-9", name: "在线九" }, projectId: "p-9", projectName: "项目九" });
    expect(ctx.online.calls).toEqual([["ws-9", "p-9"]]);
  });

  it("I06: close evicts only the workflow session owned by the closed root and project", async () => {
    const ctx = await localContext();
    const rootA = ctx.workspace.root;
    const workflow = await ctx.api.wfCreate({ locator: ctx.projectNode.locator, name: "关签归属流" });
    const workflowLocator: WorkflowLocator = { ...ctx.projectNode.locator, workflowId: workflow.id };
    const workflowDesign = useWorkflowDesignStore(ctx.api, () => ({ root: ctx.workspace.root, readOnly: ctx.workspace.readOnly }));

    const tabs = createTabsStore({
      workspace: ctx.workspace,
      tree: { select: () => undefined },
      online: {
        sessions: {}, activeWorkspaceId: null, error: null,
        activateWorkspace: async () => {}, selectNode: async () => {}, evictProjectBuffers: () => {},
      } as unknown as TabsStoreDeps["online"],
      workflowDesign,
      evictProjectSessions: createEvictProjectSessions({ editor: ctx.editor, online: ctx.online, workflowDesign }),
      storage: memStorage(),
    });

    await tabs.openProjectTab({ kind: "local", dir: rootA }, { locator: ctx.projectNode.locator, name: ctx.projectNode.label });
    const rootB = "/tmp/task10b-i06-copy";
    await tabs.openProjectTab({ kind: "local", dir: rootB }, { locator: ctx.projectNode.locator, name: ctx.projectNode.label });
    await workflowDesign.load(rootB, workflowLocator);
    if (!workflowDesign.workflow) throw new Error("Created workflow did not load");
    workflowDesign.update({ ...workflowDesign.workflow, name: "B 草稿" });
    workflowDesign.runResult = {
      workflowId: workflow.id, workflowName: "B 草稿", status: workflow.status,
      nodeResults: [], total: 0, passed: 0, failed: 0, skipped: 0, warnings: [], startedAt: "", finishedAt: "",
    };

    await tabs.closeTab("tab-1");
    expect(workflowDesign.root).toBe(rootB);
    expect(workflowDesign.locator).toEqual(workflowLocator);
    expect(workflowDesign.dirty).toBe(true);
    expect(workflowDesign.runResult).not.toBeNull();

    await tabs.closeTab("tab-2");
    expect(workflowDesign.root).toBeNull();
    expect(workflowDesign.locator).toBeNull();
    expect(workflowDesign.workflow).toBeNull();
    expect(workflowDesign.dirty).toBe(false);
    expect(workflowDesign.runResult).toBeNull();
  });

  it("防护口径：相同 projectId 的错误 group locator 不会别名驱逐；钩子实现内部不抛", async () => {
    const ctx = await localContext();
    await ctx.editor.load(ctx.apiA.locator);
    ctx.editor.api!.contract.request.baseUrl = "/draft-a";
    const evict = createEvictProjectSessions({ editor: ctx.editor, online: ctx.online });
    const wrongGroup: ProjectLocator = { ...ctx.projectNode.locator, groupId: "30000000-0000-4000-8000-000000000003" };
    evict({ tabId: "tab-wrong-group", workspaceRef: { kind: "local", dir: ctx.workspace.root }, projectLocator: wrongGroup, projectName: "wrong group" });
    expect(ctx.editor.sessions[apiSessionKey(ctx.workspace.root, ctx.apiA.locator)]).toBeDefined();
    // 在线驱逐体抛错（替身层契约被破坏）也被吸收：closeTab 驱逐钩子不阻断关签
    const bomb = { evictProjectBuffers: () => { throw new Error("替身契约破坏"); } };
    const evictBomb = createEvictProjectSessions({ editor: ctx.editor, online: bomb });
    expect(() => evictBomb({ tabId: "tab-bomb", workspaceRef: { kind: "online", workspaceId: "ws-9", name: "在线九" }, projectId: "p-1", projectName: "项目一" })).not.toThrow();
  });
});

// —— 任务 5 审查重要 1（裁定修法：元数据驱动）：跨目录本地签的关签 dirty 判定与驱逐
// 不再依赖「当前树恰好还开着该项目」——槽归属在建槽时写入（projectId 元数据），
// 开目录 B 后目录 A 项目的草稿签关签仍拦截、驱逐仍生效。
describe("关签判定与驱逐的元数据语义（任务 5 审查重要 1：跨目录本地签）", () => {
  /** 真实 store 上下文：目录 A 种子项目 PA（接口甲）+ 注入归属解析器的 editor。 */
  async function localContextA() {
    const api = createMemoryApi();
    api.seedWorkspace();
    const workspace = useWorkspaceStore(api);
    await workspace.open("/tmp/ws-a");
    const group = workspace.tree!.children.find((node) => node.kind === "group" && node.children.some((child) => child.kind === "project" && child.children.some((item) => item.kind === "collection")));
    if (!group || group.kind !== "group") throw new Error("Memory workspace is missing the seeded project group");
    const projectA = group.children.find((node) => node.kind === "project" && node.children.some((item) => item.kind === "collection"));
    if (!projectA || projectA.kind !== "project") throw new Error("Memory group is missing the seeded project");
    const collection = projectA.children.find((node) => node.kind === "collection");
    if (!collection || collection.kind !== "collection") throw new Error("Memory project is missing the seeded collection");
    const apiA = collection.children.find((node) => node.kind === "api");
    if (!apiA || apiA.kind !== "api") throw new Error("Memory collection is missing the seeded API");
    const context = () => ({ root: workspace.root, readOnly: workspace.readOnly });
    const editor = useEditorStore(api, context);
    const tree = { select: vi.fn((_node: LocalProjectTreeNodeDTO) => {}) };
    const online = {
      sessions: {} as TabsStoreDeps["online"]["sessions"],
      activeWorkspaceId: null as string | null,
      error: null as string | null,
      activateWorkspace: vi.fn(async () => {}),
      selectNode: vi.fn(async () => {}),
      evictProjectBuffers: vi.fn(),
    };
    return { api, workspace, editor, tree, online, projectA, apiA };
  }

  it("跨目录本地签：目录 A 项目 PA 有草稿 → 开目录 B（当前树已不含 PA）→ projectHasDrafts(tab-PA) 仍为 true，确认驱逐后 PA 会话消失", async () => {
    const ctx = await localContextA();
    await ctx.editor.load(ctx.apiA.locator);
    ctx.editor.api!.contract.request.baseUrl = "/draft-a"; // PA 草稿
    const deps: TabsStoreDeps = {
      workspace: ctx.workspace,
      tree: ctx.tree,
      online: ctx.online,
      editor: ctx.editor,
      evictProjectSessions: createEvictProjectSessions({ editor: ctx.editor, online: ctx.online }),
      storage: memStorage(),
    };
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab({ kind: "local", dir: "/tmp/ws-a" }, { locator: ctx.projectA.locator, name: ctx.projectA.label });
    // 切到目录 B 后当前树已不含 A；dirty 判定/驱逐必须使用 tab 保留的 root+locator。
    ctx.workspace.root = "/tmp/ws-b";
    ctx.workspace.tree = { source: "local", kind: "root", id: "root-b", key: "root-b", label: "目录B工作区", locator: { workspaceId: "40000000-0000-4000-8000-000000000001" }, children: [] };
    // 修复前：按当前树 findProjectNode(PA) → null → 不弹确认直关、驱逐 no-op（脏会话滞留）
    expect(tabs.projectHasDrafts(tabs.activeTabId!)).toBe(true);
    await tabs.closeTab(tabs.activeTabId!); // 组件层确认后的关签
    expect(tabs.tabs).toHaveLength(0);
    expect(Object.values(ctx.editor.sessions).some((session) => session.locator.apiId === ctx.apiA.locator.apiId)).toBe(false); // PA 草稿槽已被驱逐
    expect(ctx.editor.locator).toBeNull();
  });

  it("不同 group 的同 projectId locator 不会把别处草稿算入或驱逐", async () => {
    const ctx = await localContextA();
    await ctx.editor.load(ctx.apiA.locator);
    ctx.editor.api!.contract.request.baseUrl = "/draft-a";
    const wrongGroup: ProjectLocator = { ...ctx.projectA.locator, groupId: "50000000-0000-4000-8000-000000000003" };
    expect(ctx.editor.isProjectDirty(wrongGroup, "/tmp/ws-a")).toBe(false);
    const before = Object.keys(ctx.editor.sessions);
    ctx.editor.evictProject(wrongGroup, "/tmp/ws-a");
    expect(Object.keys(ctx.editor.sessions)).toEqual(before);
  });
});

// —— 计划 C 任务 6：工作区级关闭 + 切签工作流草稿确认 ——

/** 带工作流摘要的本地树夹具：项目一（p-1）持 wf-1，项目二（p-2）无工作流。 */
const WF_LOCATOR: WorkflowLocator = { ...localLocator("p-1"), workflowId: "30000000-0000-4000-8000-000000000001" };
const WF_TREE: LocalRootTreeNodeDTO = {
  source: "local", kind: "root", id: localLocator("p-1").workspaceId,
  key: JSON.stringify(["local", "root", localLocator("p-1").workspaceId]), label: "工作区",
  locator: { workspaceId: localLocator("p-1").workspaceId },
  children: [{
    source: "local", kind: "group", id: localLocator("p-1").groupId,
    key: JSON.stringify(["local", "group", localLocator("p-1").workspaceId, localLocator("p-1").groupId]), label: "分组",
    locator: { workspaceId: localLocator("p-1").workspaceId, groupId: localLocator("p-1").groupId },
    children: [
      { ...localProjectNode(localLocator("p-1"), "项目一"), workflows: [{
        source: "local", id: WF_LOCATOR.workflowId, key: JSON.stringify(["local", "workflow", WF_LOCATOR.workspaceId, WF_LOCATOR.groupId, WF_LOCATOR.projectId, WF_LOCATOR.workflowId]),
        name: "流一", status: "draft", locator: WF_LOCATOR,
      }] },
      localProjectNode(localLocator("p-2"), "项目二"),
    ],
  }],
};

describe("工作区级关闭（closeWorkspaceTabs，任务 6，不变量 4）", () => {
  it("关该工作区全部签并逐签驱逐；其他工作区与本地签保留；签级无 dirty 确认入口（工作区级已确认）", async () => {
    const { deps, evictions } = makeDeps();
    deps.online.sessions["ws-1"] = sessionStub("ws-1");
    deps.online.sessions["ws-2"] = sessionStub("ws-2");
    deps.online.activeWorkspaceId = "ws-1";
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(ONLINE_REF, P1); // tab-1 ws-1
    await tabs.openProjectTab(ONLINE_REF, P2); // tab-2 ws-1
    await tabs.openProjectTab({ kind: "online", workspaceId: "ws-2", name: "在线二" }, P3); // tab-3
    await openTab(tabs, LOCAL_REF, P1); // tab-4 本地（活跃）
    await tabs.closeWorkspaceTabs(ONLINE_REF);
    // ws-1 两签出表（驱逐按 (ref, projectId) 逐签落地），ws-2 与本地签不动，活跃不受牵连
    expect(tabs.tabs.map((tab) => `${tab.workspaceRef.kind}:${tabProjectId(tab)}`)).toEqual(["online:p-3", `local:${localLocator("p-1").projectId}`]);
    expect(evictions.filter((e) => e.workspaceRef.kind === "online" && e.workspaceRef.workspaceId === "ws-1")).toHaveLength(2);
    expect(tabs.activeTabId).toBe("tab-4");
  });

  it("关的是活跃签所在工作区：活跃迁移到相邻驻留签；全部签随工作区清空时回主页", async () => {
    const { deps } = makeDeps();
    deps.online.sessions["ws-1"] = sessionStub("ws-1");
    deps.online.activeWorkspaceId = "ws-1";
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(ONLINE_REF, P1); // tab-1
    await tabs.openProjectTab(ONLINE_REF, P2); // tab-2（活跃）
    await tabs.closeWorkspaceTabs(ONLINE_REF);
    expect(tabs.tabs).toHaveLength(0);
    expect(tabs.activeTabId).toBeNull(); // 无相邻签 → 回主页
  });

  it("空签工作区 no-op 不抛", async () => {
    const { deps } = makeDeps();
    const tabs = createTabsStore(deps);
    await expect(tabs.closeWorkspaceTabs(ONLINE_REF)).resolves.toBeUndefined();
    expect(tabs.activeTabId).toBeNull();
  });
});

describe("切签工作流草稿确认（任务 6，规格勘误口径：workflowDesign 单会话）", () => {
  function makeWfDeps() {
    const ctx = makeDeps();
    ctx.deps.workspace.tree = WF_TREE;
    ctx.deps.workflowDesign = { dirty: true, locator: WF_LOCATOR };
    return ctx;
  }

  it("离开签的工作流 dirty 且归属当前项目 → 确认钩子被调；false 取消不切换（项目选中未发生）", async () => {
    const { deps, tree } = makeWfDeps();
    const confirmWorkflowDraft = vi.fn(async () => false);
    deps.confirmWorkflowDraft = confirmWorkflowDraft;
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1); // tab-1（首个成签，无离开上下文）
    expect(confirmWorkflowDraft).not.toHaveBeenCalled();
    await openTab(tabs, LOCAL_REF, P2); // 成签即切：离开 p-1（wf-1 归属）→ 拦截
    expect(confirmWorkflowDraft).toHaveBeenCalledTimes(1);
    expect(tabs.tabs.map(tabProjectId)).toEqual([localLocator("p-1").projectId, localLocator("p-2").projectId]); // 签已入表，仅激活被拦
    expect(tabs.activeTabId).toBe("tab-1"); // 取消：不切换
    tree.select.mockClear();
    await tabs.activateTab("tab-2");
    expect(confirmWorkflowDraft).toHaveBeenCalledTimes(2);
    expect(tabs.activeTabId).toBe("tab-1");
    expect(tree.select).not.toHaveBeenCalled(); // 取消在编排最前：项目选中未发生
  });

  it("确认放行（true）→ 切换完成；切回持有草稿的项目签不拦截（工作流仍归属活跃项目）", async () => {
    const { deps } = makeWfDeps();
    const confirmWorkflowDraft = vi.fn(async () => true);
    deps.confirmWorkflowDraft = confirmWorkflowDraft;
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    await openTab(tabs, LOCAL_REF, P2); // 离开 p-1 → 确认放行
    expect(confirmWorkflowDraft).toHaveBeenCalledTimes(1);
    expect(tabs.activeTabId).toBe("tab-2");
    await tabs.activateTab("tab-1"); // 离开 p-2（无归属流）→ 直切；p-1 的草稿流随激活回到当前项目
    expect(confirmWorkflowDraft).toHaveBeenCalledTimes(1);
    expect(tabs.activeTabId).toBe("tab-1");
  });

  it("活跃工作流不属于离开签项目（树摘要归属过滤）→ 不牵连直切", async () => {
    const { deps } = makeWfDeps();
    deps.workflowDesign = { dirty: true, locator: { ...localLocator("p-2"), workflowId: "30000000-0000-4000-8000-000000000002" } }; // 其他项目的工作流草稿不牵连 p-1
    const confirmWorkflowDraft = vi.fn(async () => false);
    deps.confirmWorkflowDraft = confirmWorkflowDraft;
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    await openTab(tabs, LOCAL_REF, P2);
    expect(confirmWorkflowDraft).not.toHaveBeenCalled();
    expect(tabs.activeTabId).toBe("tab-2");
  });

  it("相同完整locator的复制工作区不共享workflow dirty归属", () => {
    const { deps } = makeWfDeps();
    deps.workflowDesign = { dirty: true, root: "/tmp/ws-local-copy", locator: WF_LOCATOR };
    const tabs = createTabsStore(deps);
    tabs.tabs = [{ tabId: "tab-old-root", workspaceRef: { kind: "local", dir: "/tmp/ws-local" }, projectLocator: localLocator("p-1"), projectName: "项目一" }];
    expect(tabs.leavingTabHasWorkflowDraft(tabs.tabs[0]!)).toBe(false);
    expect(tabs.projectHasDrafts("tab-old-root")).toBe(false);
  });

  it("workflowDesign 不 dirty → 不确认；确认钩子未注入 → 跳过该草稿源直切（store 单测省略面）", async () => {
    const { deps } = makeWfDeps();
    deps.workflowDesign = { dirty: false, locator: WF_LOCATOR };
    const confirmWorkflowDraft = vi.fn(async () => false);
    deps.confirmWorkflowDraft = confirmWorkflowDraft;
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    await openTab(tabs, LOCAL_REF, P2);
    expect(confirmWorkflowDraft).not.toHaveBeenCalled();
    expect(tabs.activeTabId).toBe("tab-2");

    const noHook = makeWfDeps(); // 不注入 confirmWorkflowDraft
    const tabs2 = createTabsStore(noHook.deps);
    await openTab(tabs2, LOCAL_REF, P1);
    await openTab(tabs2, LOCAL_REF, P2);
    expect(tabs2.activeTabId).toBe("tab-2");
  });
});

describe("异步项目签关闭的身份定位（Task2 I-6）", () => {
  it("B 的驱逐等待期间先关闭 A，B 返回后仍只移除 B 而不误删 C", async () => {
    const { deps } = makeDeps();
    let releaseB!: () => void;
    deps.evictProjectSessions = (tab) => tab.tabId === "tab-2"
      ? new Promise<void>((resolve) => { releaseB = resolve; })
      : undefined;
    const tabs = createTabsStore(deps);
    await openTab(tabs, LOCAL_REF, P1);
    await openTab(tabs, LOCAL_REF, P2);
    await openTab(tabs, LOCAL_REF, P3);

    const closingB = tabs.closeTab("tab-2");
    await vi.waitFor(() => expect(releaseB).toBeTypeOf("function"));
    await tabs.closeTab("tab-1");
    expect(tabs.tabs.map((tab) => tab.tabId)).toEqual(["tab-2", "tab-3"]);
    releaseB();
    await closingB;

    expect(tabs.tabs.map((tab) => tab.tabId)).toEqual(["tab-3"]);
  });
});
