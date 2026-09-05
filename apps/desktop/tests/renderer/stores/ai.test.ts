// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
//
// M6-C 任务 1（规格 §2 D2/D4）：ai store 工厂测试——配置（baseUrl/model 入注入 storage
// 键 apicc.ai.config，key 经 IPC 入 main 安全存储、出口只含 hasKey）、连接测试两态、
// 建议拉取（fixture 桩）、勾选采用（并入 editor.api.cases，**不自动保存**——裁定③：
// AI 产出永不静默落盘，保存仍由用户显式触发）、关闭丢弃（零落盘）。
import { describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { createAiStore, AI_CONFIG_STORAGE_KEY } from "../../../src/renderer/src/stores/ai.js";
import { AI_FIXTURE_SUGGESTIONS } from "../../../src/shared/ai/contract.js";

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
  const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  const storage = memStorage();
  const ai = createAiStore({ api, editor, storage });
  return { api, editor, ai, storage };
}

/** 预存配置（密钥入替身 → 建议桩进入可用态）。 */
async function withConfig(ctx: Awaited<ReturnType<typeof seeded>>) {
  const saved = await ctx.ai.saveConfig({ baseUrl: "https://api.example.com/v1", model: "gpt-test", apiKey: "sk-1" });
  expect(saved).toBe(true);
  return ctx;
}

describe("ai store：配置（D2）", () => {
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

describe("ai store：连接测试与建议拉取（fixture 桩两态）", () => {
  it("testConnection：已配置 → success；未配置 → failure + 可读 error", async () => {
    const ctx = await seeded();
    await ctx.ai.testConnection();
    expect(ctx.ai.testResult).toBe("failure");
    expect(ctx.ai.error).toContain("尚未配置 AI 密钥");
    await withConfig(ctx);
    await ctx.ai.testConnection();
    expect(ctx.ai.testResult).toBe("success");
    expect(ctx.ai.error).toBeNull();
  });

  it("fetchSuggestions：已配置 → 固定两条建议（本地补行键）、抽屉打开、默认未勾选", async () => {
    const ctx = await withConfig(await seeded());
    await ctx.ai.fetchSuggestions();
    expect(ctx.ai.suggestions).toHaveLength(2);
    expect(ctx.ai.suggestions![0]!.name).toBe(AI_FIXTURE_SUGGESTIONS[0]!.name);
    expect(new Set(ctx.ai.suggestions!.map((s) => s.key)).size).toBe(2); // 行键唯一
    expect(ctx.ai.drawerOpen).toBe(true);
    expect(ctx.ai.selectedIds).toEqual([]);
    expect(ctx.ai.error).toBeNull();
  });

  it("fetchSuggestions：未配置 → error 上屏、建议保持空、抽屉不打开", async () => {
    const { ai } = await seeded();
    await ai.fetchSuggestions();
    expect(ai.error).toContain("尚未配置 AI 密钥");
    expect(ai.suggestions).toBeNull();
    expect(ai.drawerOpen).toBe(false);
  });
});

describe("ai store：勾选采用与丢弃（裁定③④）", () => {
  it("adopt：勾选并入 editor.api.cases（本地生成用例与断言 id），列表清空、抽屉关闭、**不触发保存**", async () => {
    const ctx = await withConfig(await seeded());
    await ctx.ai.fetchSuggestions();
    const before = ctx.editor.api!.cases.length;
    let saveCalls = 0;
    const original = ctx.api.apiSave.bind(ctx.api);
    ctx.api.apiSave = async (input) => {
      saveCalls += 1;
      return original(input);
    };
    ctx.ai.toggleSelect(ctx.ai.suggestions![0]!.key);
    ctx.ai.toggleSelect(ctx.ai.suggestions![1]!.key);
    const count = ctx.ai.adopt();
    expect(count).toBe(2);
    expect(ctx.editor.api!.cases.length).toBe(before + 2);
    const adopted = ctx.editor.api!.cases.slice(before);
    expect(adopted.map((c) => c.name)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.name));
    // 本地生成 id：用例 id 与断言 id 均非空且不重复
    for (const c of adopted) {
      expect(c.id).toBeTruthy();
      expect(c.assertions.length).toBeGreaterThan(0);
      for (const a of c.assertions) expect(a.id).toBeTruthy();
    }
    expect(new Set(adopted.map((c) => c.id)).size).toBe(2);
    // postScript 随建议携带（fixture 第二条有后置脚本）
    expect(adopted[1]!.postScript).toBe(AI_FIXTURE_SUGGESTIONS[1]!.postScript);
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
    ctx.ai.toggleSelect(ctx.ai.suggestions![1]!.key);
    expect(ctx.ai.selectedIds).toEqual([ctx.ai.suggestions![1]!.key]);
    const count = ctx.ai.adopt();
    expect(count).toBe(1);
    expect(ctx.editor.api!.cases.length).toBe(before + 1);
    expect(ctx.editor.api!.cases[before]!.name).toBe(AI_FIXTURE_SUGGESTIONS[1]!.name);
  });

  it("dismissSuggestions：关闭即丢弃（零落盘）——建议与勾选清空、抽屉关闭、editor 不动", async () => {
    const ctx = await withConfig(await seeded());
    await ctx.ai.fetchSuggestions();
    ctx.ai.toggleSelect(ctx.ai.suggestions![0]!.key);
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
    const editor = useEditorStore(api);
    const ai = createAiStore({ api, editor, storage: memStorage() });
    expect(ai.adopt()).toBe(0);
  });
});
