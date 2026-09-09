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
import type { OnlineSession } from "../../../src/renderer/src/stores/online.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
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

const LOCAL_REF: WorkspaceRef = { kind: "local", dir: "/tmp/ws-local" };
const ONLINE_REF: WorkspaceRef = { kind: "online", workspaceId: "ws-1", name: "在线一" };
const P1 = { id: "p-1", name: "项目一" };
const P2 = { id: "p-2", name: "项目二" };
const P3 = { id: "p-3", name: "项目三" };

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
  const workspace = {
    opened: false,
    root: "",
    tree: null as TreeNodeDTO | null, // 关签 dirty 判定（任务 5 projectHasDrafts）按树收集
    openFails: false,
    open: vi.fn(async (dir: string) => {
      log.push(`ws.open:${dir}`);
      if (workspace.openFails) throw new Error(`工作区根目录缺少 apicc.workspace.yaml: ${dir}`);
      workspace.opened = true;
      workspace.root = dir;
    }),
  };
  const tree = {
    select: vi.fn((kind: TreeNodeDTO["kind"], id: string) => {
      log.push(`tree.select:${kind}:${id}`);
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
    evictProjectSessions: (workspaceRef, projectId) => {
      evictions.push({ workspaceRef, projectId });
    },
    onProjectActivated: (tab) => {
      activatedTabs.push(tab);
    },
    storage,
  };
  return { deps, storage, log, evictions, activatedTabs, workspace, tree, online };
}

describe("成签注册表（openProjectTab，不变量 1：项目选中即成签）", () => {
  it("新项目成签置活跃：tab-<自增> 运行期唯一；本地项目选中走 tree.select（App.vue:367-370 先例）", async () => {
    const { deps, tree } = makeDeps();
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(LOCAL_REF, P1);
    expect(tabs.tabs).toEqual([
      { tabId: "tab-1", workspaceRef: LOCAL_REF, projectId: "p-1", projectName: "项目一" },
    ]);
    expect(tabs.activeTabId).toBe("tab-1");
    expect(tabs.activeTab?.projectId).toBe("p-1");
    expect(tree.select).toHaveBeenCalledWith("project", "p-1");
    await tabs.openProjectTab(LOCAL_REF, P2);
    expect(tabs.tabs.map((t) => t.tabId)).toEqual(["tab-1", "tab-2"]);
    expect(tabs.activeTabId).toBe("tab-2");
  });

  it("同 workspaceRef+projectId 重复成签去重：仅激活既有签（已活跃时不重跑选中——草稿零扰动，不变量 2）", async () => {
    const { deps, log } = makeDeps();
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(LOCAL_REF, P1);
    expect(log).toEqual(["ws.open:/tmp/ws-local", "tree.select:project:p-1"]); // 首开含目录兜底重开
    log.length = 0;
    await tabs.openProjectTab(LOCAL_REF, P1);
    expect(tabs.tabs).toHaveLength(1); // 去重：不重签
    expect(tabs.activeTabId).toBe("tab-1"); // 仅激活
    expect(log).toEqual([]); // 已活跃：no-op
  });

  it("同项目不同 ref 各成一签（本地与在线并存，去重键 = workspaceRef+projectId）", async () => {
    const { deps, online } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1");
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(LOCAL_REF, P1);
    await tabs.openProjectTab(ONLINE_REF, P1);
    expect(tabs.tabs.map((t) => t.workspaceRef.kind)).toEqual(["local", "online"]);
    expect(tabs.tabs).toHaveLength(2);
  });
});

describe("激活编排（activateTab）", () => {
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
    await tabs.openProjectTab(LOCAL_REF, P1);
    expect(workspace.open).not.toHaveBeenCalled();
    expect(tabs.activeTabId).toBe("tab-1");
    const fresh = makeDeps(); // 未打开场景：兜底重开目录
    const tabs2 = createTabsStore(fresh.deps);
    await tabs2.openProjectTab(LOCAL_REF, P1);
    expect(fresh.workspace.open).toHaveBeenCalledWith(LOCAL_REF.dir);
    expect(tabs2.activeTabId).toBe("tab-1");
  });

  it("本地签 open 失败（目录失效）→ 标记离线、不切换", async () => {
    const { deps, workspace } = makeDeps();
    workspace.openFails = true;
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(LOCAL_REF, P1);
    expect(tabs.offlineTabIds).toEqual(["tab-1"]);
    expect(tabs.activeTabId).toBeNull();
    expect(tabs.error).toContain("apicc.workspace.yaml");
  });
});

describe("关签（closeTab，不变量 3：关签=项目关闭，dirty 确认由调用方负责）", () => {
  it("驱逐钩子按 (workspaceRef, projectId) 被调；签出表并跟随持久化；非活跃签关闭不动活跃", async () => {
    const { deps, evictions, storage } = makeDeps();
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(LOCAL_REF, P1);
    await tabs.openProjectTab(LOCAL_REF, P2); // active = tab-2
    await tabs.closeTab("tab-1");
    expect(evictions).toEqual([{ workspaceRef: LOCAL_REF, projectId: "p-1" }]);
    expect(tabs.tabs.map((t) => t.tabId)).toEqual(["tab-2"]);
    expect(tabs.activeTabId).toBe("tab-2");
    const persisted = JSON.parse(storage.getItem(STORAGE_KEY)!);
    expect(persisted.tabs).toEqual([{ workspaceRef: LOCAL_REF, projectId: "p-2", projectName: "项目二" }]);
  });

  it("关非活跃签不动活跃；关活跃尾签回左邻（Math.min 尾分支）；签全关 → null（回主页）", async () => {
    const { deps } = makeDeps();
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(LOCAL_REF, P1); // tab-1
    await tabs.openProjectTab(LOCAL_REF, P2); // tab-2
    await tabs.openProjectTab(LOCAL_REF, P3); // tab-3（活跃）
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
    await tabs.openProjectTab(LOCAL_REF, P1); // tab-1（活跃）
    await tabs.openProjectTab(LOCAL_REF, P2); // tab-2
    await tabs.closeTab("tab-1");
    expect(tabs.activeTabId).toBe("tab-2"); // 右邻接任
    expect(tabs.tabs.map((t) => t.tabId)).toEqual(["tab-2"]);
  });

  it("关活跃签且相邻激活失败 → activeTabId 置 null（回主页）+ error 上屏，离线相邻签保留", async () => {
    const WS2_REF: WorkspaceRef = { kind: "online", workspaceId: "ws-2", name: "在线二" };
    const { deps, online, evictions } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1"); // 仅 ws-1 驻留（ws-2 分歧缺席）
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab({ kind: "online", workspaceId: "ws-1", name: "在线一" }, P1); // tab-1 活跃
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
    await tabs.openProjectTab(LOCAL_REF, P1); // tab-1（本地上下文就位）
    await tabs.openProjectTab(ONLINE_REF, P2); // tab-2（活跃，在线上下文）
    log.length = 0;
    await tabs.closeTab("tab-2");
    expect(tabs.activeTabId).toBe("tab-1");
    expect(log).toEqual(["tree.select:project:p-1"]); // 本地签接任：不重开目录，仅项目选中
    expect(online.activeWorkspaceId).toBe("ws-1"); // 在线会话驻留不被动（不变量 4）
  });
});

describe("持久化与恢复（localStorage apicc.projectTabs）", () => {
  it("persist：写入 {tabs:[{workspaceRef,projectId,projectName}], activeIndex}（只记签结构，草稿/离线态不落盘）", async () => {
    const { deps, storage, online } = makeDeps();
    online.sessions["ws-1"] = sessionStub("ws-1");
    const tabs = createTabsStore(deps);
    await tabs.openProjectTab(LOCAL_REF, P1);
    await tabs.openProjectTab(ONLINE_REF, P2); // active = tab-2
    tabs.persist();
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({
      tabs: [
        { workspaceRef: LOCAL_REF, projectId: "p-1", projectName: "项目一" },
        { workspaceRef: ONLINE_REF, projectId: "p-2", projectName: "项目二" },
      ],
      activeIndex: 1,
    });
  });

  it("恢复往返：新 store restore 重建签结构（tabId 重生成）+ 活跃位跟随 + 活跃签走完整编排（钩子只对活跃签）", async () => {
    const { deps, storage, workspace, tree, online, activatedTabs } = makeDeps();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { workspaceRef: LOCAL_REF, projectId: "p-1", projectName: "项目一" },
          { workspaceRef: ONLINE_REF, projectId: "p-2", projectName: "项目二" },
        ],
        activeIndex: 1,
      }),
    );
    online.sessions["ws-1"] = sessionStub("ws-1");
    const tabs = createTabsStore(deps);
    await tabs.restore();
    expect(tabs.tabs.map((t) => [t.tabId, t.projectId, t.projectName])).toEqual([
      ["tab-1", "p-1", "项目一"],
      ["tab-2", "p-2", "项目二"],
    ]);
    expect(tabs.activeTabId).toBe("tab-2"); // activeIndex=1
    expect(workspace.open).toHaveBeenCalledTimes(1); // 非活跃本地签重建：重开目录（工作区驻留）
    expect(workspace.open).toHaveBeenCalledWith(LOCAL_REF.dir);
    expect(online.activeWorkspaceId).toBe("ws-1"); // 活跃签在线工作区已激活
    expect(online.selectNode).toHaveBeenCalledWith("project", "p-2");
    expect(tree.select).not.toHaveBeenCalled(); // 活跃签是在线：本地树选中不跑
    expect(activatedTabs.map((t) => t.projectId)).toEqual(["p-2"]); // onProjectActivated 钩子只对活跃签
  });

  it("恢复重建失败→离线态：本地 open 失败与在线 activate 失败各自标记离线；活跃位落空 → null（回主页）", async () => {
    const { deps, storage, workspace } = makeDeps();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { workspaceRef: LOCAL_REF, projectId: "p-1", projectName: "项目一" },
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
    expect(tabs.tabs.map((t) => t.projectId)).toEqual(["p-2"]);
    expect(tabs.activeTabId).toBeNull();
  });
});

// —— 计划 C 任务 4：关签驱逐真实实现（createEvictProjectSessions，deps 装配体）——
// 本地 ref：按 tree 收集该项目 api 集合驱逐 editor 会话槽；在线 ref：按 projectId 前缀
// 驱逐驻留会话缓冲槽；实现内部不抛（任务 3 钩子防护口径：closeTab 调用方不 try/catch）。
describe("关签驱逐真实实现（计划 C 任务 4：createEvictProjectSessions）", () => {
  /** 真实 store 上下文：种子项目（含接口A）+ 第二项目（接口B），供跨项目驱逐隔离验证。 */
  async function localContext() {
    const api = createMemoryApi();
    api.seedWorkspace();
    const workspace = useWorkspaceStore(api);
    await workspace.open("/tmp/ws");
    const groupNode = workspace.tree!.children![0]!;
    const projectNode = groupNode.children![0]!;
    const collectionNode = projectNode.children![0]!;
    const project2 = await api.nodeCreate({ kind: "project", parentId: groupNode.id, name: "项目二" });
    const collection2 = await api.nodeCreate({ kind: "collection", parentId: project2.id, name: "集合乙" });
    const apiB = await api.nodeCreate({ kind: "api", parentId: collection2.id, name: "接口B" });
    await workspace.refresh(); // 驱逐收集按当前树（nodeCreate 后刷新）
    const editor = useEditorStore(api);
    const online = createOnlineStoreStub();
    return { api, workspace, editor, online, projectNode, collectionNode, apiB };
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

  it("本地 ref：按 tree 收集该项目 api 集合驱逐 editor 会话槽；其他项目会话驻留、活跃不受牵连", async () => {
    const ctx = await localContext();
    const apiA = ctx.collectionNode.children![0]!.id; // 种子项目（项目一）的接口
    await ctx.editor.load(apiA);
    await ctx.editor.load(ctx.apiB.id);
    ctx.editor.api!.url = "/draft-b"; // 活跃在接口B（项目二）
    const evict = createEvictProjectSessions({ workspace: ctx.workspace, editor: ctx.editor, online: ctx.online });
    evict({ kind: "local", dir: ctx.workspace.root }, ctx.projectNode.id);
    expect(ctx.editor.sessions[apiA]).toBeUndefined(); // 项目一槽被逐
    expect(ctx.editor.sessions[ctx.apiB.id]).toBeDefined(); // 项目二会话驻留
    expect(ctx.editor.activeApiId).toBe(ctx.apiB.id); // 活跃不在驱逐集合 → 不动
  });

  it("在线 ref：路由到 online.evictProjectBuffers(workspaceId, projectId)", async () => {
    const ctx = await localContext();
    const evict = createEvictProjectSessions({ workspace: ctx.workspace, editor: ctx.editor, online: ctx.online });
    evict({ kind: "online", workspaceId: "ws-9", name: "在线九" }, "p-9");
    expect(ctx.online.calls).toEqual([["ws-9", "p-9"]]);
  });

  it("防护口径：本地项目节点缺失（树无此 id）→ 不驱逐任何槽；钩子实现内部不抛", async () => {
    const ctx = await localContext();
    const apiA = ctx.collectionNode.children![0]!.id;
    await ctx.editor.load(apiA);
    const evict = createEvictProjectSessions({ workspace: ctx.workspace, editor: ctx.editor, online: ctx.online });
    expect(() => evict({ kind: "local", dir: "/tmp/ws" }, "不存在的项目")).not.toThrow();
    expect(ctx.editor.sessions[apiA]).toBeDefined(); // 无收集 → 不驱逐
    // 在线驱逐体抛错（替身层契约被破坏）也被吸收：closeTab 驱逐钩子不阻断关签
    const bomb = { evictProjectBuffers: () => { throw new Error("替身契约破坏"); } };
    const evictBomb = createEvictProjectSessions({ workspace: ctx.workspace, editor: ctx.editor, online: bomb });
    expect(() => evictBomb({ kind: "online", workspaceId: "ws-9", name: "在线九" }, "p-1")).not.toThrow();
  });
});
