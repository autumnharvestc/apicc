// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
//
// M6-C 任务 2（规格 §2 D2/D4）：ai store 更新——建议形状收敛 core AiSuggestedCase
// （带本地 ULID id，勾选/采用按 id），连接测试切 ai:test-config 轻量探测，配置面
// （localStorage 键 apicc.ai.config + IPC hasKey）沿用任务 1 裁定。采用仍**不自动
// 保存**（裁定③：AI 产出永不静默落盘）；关闭丢弃零落盘。
import { describe, expect, it, vi } from "vitest";
import { createMemoryApi, AI_FIXTURE_SUGGESTIONS } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { createAiStore, AI_CONFIG_STORAGE_KEY } from "../../../src/renderer/src/stores/ai.js";
import type { LocalTreeNodeDTO } from "../../../src/shared/tree-dto.js";

function firstApiNode(node: LocalTreeNodeDTO): Extract<LocalTreeNodeDTO, { kind: "api" }> | undefined {
  if (node.kind === "api") return node;
  if ("children" in node && node.children) {
    for (const child of node.children) {
      const match = firstApiNode(child);
      if (match) return match;
    }
  }
  return undefined;
}

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree && firstApiNode(ws.tree);
  if (!apiNode) throw new Error("fixture must contain an API in its workspace tree");
  const editor = useEditorStore(api, () => ({ root: ws.root, readOnly: ws.readOnly }));
  await editor.load(apiNode.locator);
  const storage = memStorage();
  const getContext = () => ({ root: ws.root, readOnly: ws.readOnly });
  const ai = createAiStore({ api, editor, storage, getContext });
  return { api, ws, editor, ai, storage };
}

/** 预存配置（密钥入替身 → 建议桩/测试探测进入可用态）。 */
async function withConfig(ctx: Awaited<ReturnType<typeof seeded>>) {
  const saved = await ctx.ai.saveConfig({ baseUrl: "https://api.example.com/v1", model: "gpt-test", apiKey: "sk-1" });
  expect(saved).toBe(true);
  return ctx;
}

describe("ai store：配置（D2，沿用任务 1）", () => {
  it("init：读注入 storage 的 baseUrl/model + IPC hasKey；storage 损坏降级空白 + warn 不抛", async () => {
    const { api, editor, ai, storage } = await seeded();
    storage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify({ baseUrl: "https://s", model: "m-1" }));
    await ai.init();
    expect(ai.baseUrl).toBe("https://s");
    expect(ai.model).toBe("m-1");
    expect(ai.hasKey).toBe(false); // memory 替身默认无 key
    expect(ai.error).toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fresh = createAiStore({ api, editor, storage });
    storage.setItem(AI_CONFIG_STORAGE_KEY, "not-json{");
    await fresh.init();
    expect(fresh.baseUrl).toBe("");
    expect(fresh.model).toBe("");
    expect(warn).toHaveBeenCalled();
  });

  it("saveConfig：载荷经 IPC（key 非空才携带）、状态更新、localStorage 持久化、hasKey 同步", async () => {
    const { api, ai, storage } = await seeded();
    const sent: unknown[] = [];
    const original = api.aiSaveConfig.bind(api);
    api.aiSaveConfig = async (input) => {
      sent.push(input);
      return original(input);
    };
    const ok = await ai.saveConfig({ baseUrl: "https://a", model: "m", apiKey: "sk-9" });
    expect(ok).toBe(true);
    expect(sent).toEqual([{ baseUrl: "https://a", model: "m", apiKey: "sk-9" }]);
    expect(ai.baseUrl).toBe("https://a");
    expect(ai.model).toBe("m");
    expect(ai.hasKey).toBe(true);
    expect(JSON.parse(storage.getItem(AI_CONFIG_STORAGE_KEY)!)).toEqual({ baseUrl: "https://a", model: "m" });

    // key 留空 = 保持既有：载荷不含 apiKey 字段
    sent.length = 0;
    await ai.saveConfig({ baseUrl: "https://b", model: "m2" });
    expect(sent).toEqual([{ baseUrl: "https://b", model: "m2" }]);
    expect(ai.hasKey).toBe(true);
  });

  it("saveConfig 失败：error 上屏、返回 false、状态与持久化不变", async () => {
    const { api, ai, storage } = await seeded();
    api.aiSaveConfig = async () => {
      throw new Error("存储不可用");
    };
    const ok = await ai.saveConfig({ baseUrl: "https://a", model: "m", apiKey: "k" });
    expect(ok).toBe(false);
    expect(ai.error).toBe("存储不可用");
    expect(ai.baseUrl).toBe("");
    expect(storage.getItem(AI_CONFIG_STORAGE_KEY)).toBeNull();
  });
});

describe("ai store：连接测试（ai:test-config 轻量探测，任务 2）", () => {
  it("未保存 baseUrl/model → 本地护栏直接失败（不发 IPC），可读错误指引配置对话框", async () => {
    const { api, ai } = await seeded();
    let testCalls = 0;
    api.aiTestConfig = async (input) => {
      testCalls += 1;
      void input;
      return { ok: true };
    };
    await ai.testConnection();
    expect(ai.testResult).toBe("failure");
    expect(ai.error).toContain("尚未配置 AI");
    expect(testCalls).toBe(0);
  });

  it("已保存配置 → ai:test-config 携 baseUrl/model（key 留 main），resolve → success", async () => {
    const ctx = await withConfig(await seeded());
    const sent: unknown[] = [];
    const original = ctx.api.aiTestConfig.bind(ctx.api);
    ctx.api.aiTestConfig = async (input) => {
      sent.push(input);
      return original(input);
    };
    await ctx.ai.testConnection();
    expect(ctx.ai.testResult).toBe("success");
    expect(ctx.ai.error).toBeNull();
    expect(sent).toEqual([{ baseUrl: "https://api.example.com/v1", model: "gpt-test" }]);
  });

  it("端点失败 → failure + 可读 error（provider 归一化文案原样上屏）", async () => {
    const ctx = await withConfig(await seeded());
    ctx.api.aiTestConfig = async () => {
      throw new Error("AI provider 请求失败（http）: HTTP 500");
    };
    await ctx.ai.testConnection();
    expect(ctx.ai.testResult).toBe("failure");
    expect(ctx.ai.error).toContain("AI provider 请求失败");
  });
});

describe("ai store：建议拉取（main 真链路的渲染出口，任务 2）", () => {
  it("已配置 → 建议（core AiSuggestedCase 形状：带 id）、抽屉打开、默认未勾选", async () => {
    const ctx = await withConfig(await seeded());
    const sent: unknown[] = [];
    const original = ctx.api.aiSuggest.bind(ctx.api);
    ctx.api.aiSuggest = async (input) => { sent.push(input); return original(input); };
    await ctx.ai.fetchSuggestions();
    expect(ctx.ai.suggestions).toHaveLength(2);
    expect(ctx.ai.suggestions!.map((s) => s.id)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.id));
    expect(ctx.ai.drawerOpen).toBe(true);
    expect(ctx.ai.selectedIds).toEqual([]);
    expect(ctx.ai.error).toBeNull();
    expect(sent).toEqual([{ locator: ctx.editor.locator, baseUrl: "https://api.example.com/v1", model: "gpt-test" }]);
  });

  it("请求期间切换接口：迟到的建议不会覆盖或采用到新接口", async () => {
    const ctx = await withConfig(await seeded());
    const requestedLocator = ctx.editor.locator!;
    const created = await ctx.api.nodeCreate({
      kind: "api",
      parent: {
        workspaceId: requestedLocator.workspaceId,
        groupId: requestedLocator.groupId,
        projectId: requestedLocator.projectId,
        collectionId: requestedLocator.collectionId,
        ...(requestedLocator.folderIds.length ? { folderIds: [...requestedLocator.folderIds] } : {}),
      },
      api: { name: "迟到结果目标接口", method: "GET", path: "/other", baseUrl: "http://127.0.0.1" },
    });
    if (created.kind !== "api") throw new Error("fixture must create an API node");
    let releaseApiSwitch!: () => void;
    let releaseRootSwitch!: () => void;
    const apiSwitchGate = new Promise<void>((resolve) => { releaseApiSwitch = resolve; });
    const rootSwitchGate = new Promise<void>((resolve) => { releaseRootSwitch = resolve; });
    const received: unknown[] = [];
    let callCount = 0;
    ctx.api.aiSuggest = async (input) => {
      received.push(input);
      callCount += 1;
      await (callCount === 1 ? apiSwitchGate : rootSwitchGate);
      return AI_FIXTURE_SUGGESTIONS.map((suggestion) => ({ ...suggestion }));
    };

    const pendingApiSwitch = ctx.ai.fetchSuggestions();
    await ctx.editor.load(created.locator);
    releaseApiSwitch();
    await pendingApiSwitch;

    expect(received[0]).toMatchObject({ locator: requestedLocator });
    expect(ctx.editor.locator).toEqual(created.locator);
    expect(ctx.ai.suggestions).toBeNull();
    expect(ctx.ai.drawerOpen).toBe(false);
    expect(ctx.ai.suggestLoading).toBe(false);
    expect(ctx.ai.adopt()).toBe(0);

    await ctx.editor.load(requestedLocator);
    const pendingRootSwitch = ctx.ai.fetchSuggestions();
    const nextRoot = await ctx.api.wsOpen("/tmp/ws-root-switch");
    ctx.ws.apply(nextRoot);
    releaseRootSwitch();
    await pendingRootSwitch;
    expect(received[1]).toMatchObject({ locator: requestedLocator });
    expect(ctx.ws.root).toBe("/tmp/ws-root-switch");
    expect(ctx.ai.suggestions).toBeNull();
    expect(ctx.ai.drawerOpen).toBe(false);
    expect(ctx.ai.suggestLoading).toBe(false);
  });

  it("未配置 → error 上屏、建议保持空、抽屉不打开", async () => {
    const { ai } = await seeded();
    await ai.fetchSuggestions();
    expect(ai.error).toContain("尚未配置");
    expect(ai.suggestions).toBeNull();
    expect(ai.drawerOpen).toBe(false);
  });
});

describe("ai store：勾选采用与丢弃（裁定③④，沿用任务 1 语义）", () => {
  it("adopt：勾选并入 editor.api.cases（沿用 core 本地 id），列表清空、抽屉关闭、**不触发保存**", async () => {
    const ctx = await withConfig(await seeded());
    await ctx.ai.fetchSuggestions();
    const before = ctx.editor.api!.cases.length;
    let saveCalls = 0;
    const original = ctx.api.apiSave.bind(ctx.api);
    ctx.api.apiSave = async (locator, asset, revision) => {
      saveCalls += 1;
      return original(locator, asset, revision);
    };
    ctx.ai.toggleSelect(ctx.ai.suggestions![0]!.id);
    const beforeReadOnlyAdopt = JSON.parse(JSON.stringify(ctx.editor.api!.cases)) as unknown;
    ctx.ws.readOnly = true;
    expect(ctx.ai.adopt()).toBe(0);
    expect(JSON.parse(JSON.stringify(ctx.editor.api!.cases))).toEqual(beforeReadOnlyAdopt);
    expect(ctx.editor.dirty).toBe(false);
    ctx.ws.readOnly = false;
    ctx.ai.toggleSelect(ctx.ai.suggestions![1]!.id);
    const count = ctx.ai.adopt();
    expect(count).toBe(2);
    expect(ctx.editor.api!.cases.length).toBe(before + 2);
    const adopted = ctx.editor.api!.cases.slice(before);
    expect(adopted.map((c) => c.name)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.name));
    // id 沿用 core 本地生成的 ULID 契约（不再二次生成）
    expect(adopted.map((c) => c.id)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.id));
    for (const c of adopted) {
      expect(c.assertions.length).toBeGreaterThan(0);
      for (const a of c.assertions) expect(a.id).toBeTruthy();
    }
    // 正式 AiSuggestedCase 的 pre/post operations 与断言完整进入新用例。
    expect(adopted.map((c) => c.preOperations)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.preOperations));
    expect(adopted.map((c) => c.postOperations)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.postOperations));
    // 列表清空 + 抽屉关闭
    expect(ctx.ai.suggestions).toBeNull();
    expect(ctx.ai.selectedIds).toEqual([]);
    expect(ctx.ai.drawerOpen).toBe(false);
    // 裁定③：采用本身不落盘——保存由用户显式触发（dirty 已点亮，等待既有保存链路）
    expect(saveCalls).toBe(0);
    expect(ctx.editor.dirty).toBe(true);
  });

  it("adopt：只采用勾选的子集；未勾选时 adopt 为空操作", async () => {
    const ctx = await withConfig(await seeded());
    await ctx.ai.fetchSuggestions();
    const before = ctx.editor.api!.cases.length;
    expect(ctx.ai.adopt()).toBe(0); // 未勾选
    expect(ctx.editor.api!.cases.length).toBe(before);
    ctx.ai.toggleSelect(ctx.ai.suggestions![1]!.id);
    expect(ctx.ai.selectedIds).toEqual([ctx.ai.suggestions![1]!.id]);
    const count = ctx.ai.adopt();
    expect(count).toBe(1);
    expect(ctx.editor.api!.cases.length).toBe(before + 1);
    expect(ctx.editor.api!.cases[before]!.name).toBe(AI_FIXTURE_SUGGESTIONS[1]!.name);
  });

  it("dismissSuggestions：关闭即丢弃（零落盘）——建议与勾选清空、抽屉关闭、editor 不动", async () => {
    const ctx = await withConfig(await seeded());
    await ctx.ai.fetchSuggestions();
    ctx.ai.toggleSelect(ctx.ai.suggestions![0]!.id);
    const casesBefore = JSON.parse(JSON.stringify(ctx.editor.api!.cases)) as unknown;
    ctx.ai.dismissSuggestions();
    expect(ctx.ai.suggestions).toBeNull();
    expect(ctx.ai.selectedIds).toEqual([]);
    expect(ctx.ai.drawerOpen).toBe(false);
    expect(ctx.editor.dirty).toBe(false);
    expect(JSON.parse(JSON.stringify(ctx.editor.api!.cases))).toEqual(casesBefore);
  });

  it("adopt：未加载接口（editor.api 为空）时为空操作", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const ai = createAiStore({ api, editor, storage: memStorage() });
    expect(ai.adopt()).toBe(0);
  });
});
