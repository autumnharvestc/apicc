// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境。
//
// M6-C 任务 1（规格 §2 D4）：AiSuggestionsDrawer 组件测试——建议抽屉显隐、只读预览
// （name/scope/断言数 + 「AI 生成」来源标注，裁定④）、勾选联动 store、采用按钮门控
// （未勾选禁用；采用并入 editor.api.cases 且不自动落盘）、关闭即丢弃（零落盘）。
// antd Drawer 传送门渲染到 document.body → body 作用域查询。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { createAiStore } from "../../../src/renderer/src/stores/ai.js";
import { AI_FIXTURE_SUGGESTIONS } from "../../../src/shared/ai/contract.js";
import AiSuggestionsDrawer from "../../../src/renderer/src/components/AiSuggestionsDrawer.vue";

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
  if (!w) throw new Error(`document.body 中找不到 [data-testid="${testid}"]（Drawer 传送门未渲染？）`);
  return w;
}

function bodyFindAll(testid: string): DOMWrapper<Element>[] {
  return [...document.body.querySelectorAll(`[data-testid="${testid}"]`)].map((el) => new DOMWrapper(el));
}

function bodyHas(testid: string): boolean {
  return bodyFind(testid) !== null;
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

/** 装配：已加载接口的 editor + ai store；可预取固定建议并打开抽屉。 */
async function mountDrawer({ suggestions = false, open = true }: { suggestions?: boolean; open?: boolean } = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  const ai = createAiStore({ api, editor, storage: memStorage() });
  if (suggestions) {
    ai.suggestions = AI_FIXTURE_SUGGESTIONS.map((s) => ({ ...s, key: `row-${s.name}` }));
    ai.drawerOpen = open;
  } else {
    ai.drawerOpen = open;
  }
  const { i18n } = createI18nInstance();
  const wrapper = mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [i18n] } });
  await flushPromises();
  return { wrapper, api, editor, ai };
}

describe("AiSuggestionsDrawer", () => {
  it("drawerOpen=false 不渲染；打开显示标题 + 「AI 生成」来源标注（裁定④）", async () => {
    const { ai } = await mountDrawer({ open: false });
    expect(bodyHas("ai-suggestions-drawer")).toBe(false);
    ai.drawerOpen = true;
    await flushPromises();
    expect(document.body.textContent).toContain("AI 建议用例");
    expect(expectBody("ai-source-tag").text()).toContain("AI 生成");
  });

  it("只读预览：两条建议各显 name/scope/断言数（无编辑入口）", async () => {
    await mountDrawer({ suggestions: true });
    const items = bodyFindAll("ai-suggest-item");
    expect(items).toHaveLength(2);
    expect(document.body.textContent).toContain(AI_FIXTURE_SUGGESTIONS[0]!.name);
    expect(document.body.textContent).toContain(AI_FIXTURE_SUGGESTIONS[1]!.name);
    expect(items[0]!.text()).toContain("base");
    expect(items[0]!.find('[data-testid="ai-suggest-assertions"]').text()).toContain(
      String(AI_FIXTURE_SUGGESTIONS[0]!.assertions.length),
    );
    // 只读：预览区不提供任何文本输入
    expect(document.body.querySelectorAll("input[type=text], textarea").length).toBe(0);
  });

  it("勾选联动 store：勾选 → selectedIds 记录；再勾 → 累积；取消 → 移除", async () => {
    const { ai } = await mountDrawer({ suggestions: true });
    // antd 4 Checkbox 的 data-testid 经属性透传落在内部 <input> 上：直接 setValue
    const checks = bodyFindAll("ai-suggest-check");
    expect(checks).toHaveLength(2);
    await checks[0]!.setValue(true);
    expect(ai.selectedIds).toEqual([ai.suggestions![0]!.key]);
    await checks[1]!.setValue(true);
    expect(ai.selectedIds).toHaveLength(2);
    await checks[0]!.setValue(false);
    expect(ai.selectedIds).toEqual([ai.suggestions![1]!.key]);
  });

  it("采用门控：未勾选禁用；勾选后可用，点击采用并入 editor.api.cases 且不自动保存（裁定③）", async () => {
    const { api, editor, ai } = await mountDrawer({ suggestions: true });
    const before = editor.api!.cases.length;
    expect(expectBody("ai-adopt-btn").attributes("disabled")).toBeDefined();
    let saveCalls = 0;
    const original = api.apiSave.bind(api);
    api.apiSave = async (input) => {
      saveCalls += 1;
      return original(input);
    };
    const checks = bodyFindAll("ai-suggest-check");
    await checks[1]!.setValue(true);
    expect(expectBody("ai-adopt-btn").attributes("disabled")).toBeUndefined();
    await expectBody("ai-adopt-btn").trigger("click");
    await flushPromises();
    expect(editor.api!.cases.length).toBe(before + 1);
    expect(editor.api!.cases[before]!.name).toBe(AI_FIXTURE_SUGGESTIONS[1]!.name);
    expect(saveCalls).toBe(0); // 采用不落盘：保存由用户显式触发
    expect(editor.dirty).toBe(true);
    // 采用后列表清空、抽屉关闭
    expect(ai.suggestions).toBeNull();
    expect(ai.drawerOpen).toBe(false);
  });

  it("关闭抽屉（close 按钮）→ 丢弃建议（零落盘）：suggestions 清空、editor 不动", async () => {
    const { editor, ai } = await mountDrawer({ suggestions: true });
    const casesBefore = JSON.parse(JSON.stringify(editor.api!.cases)) as unknown;
    const closeBtn = document.body.querySelector(".ant-drawer-close");
    expect(closeBtn).not.toBeNull();
    await new DOMWrapper(closeBtn!).trigger("click");
    await flushPromises();
    expect(ai.drawerOpen).toBe(false);
    expect(ai.suggestions).toBeNull();
    expect(editor.dirty).toBe(false);
    expect(JSON.parse(JSON.stringify(editor.api!.cases))).toEqual(casesBefore);
  });

  it("无建议：空态文案（提示先配置）", async () => {
    await mountDrawer({ open: true });
    expect(expectBody("ai-suggestions-empty").text()).toContain("暂无建议");
  });
});
