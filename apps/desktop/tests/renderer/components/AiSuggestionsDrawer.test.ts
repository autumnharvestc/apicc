// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境。
//
// M6-C 任务 1（规格 §2 D4）：AiSuggestionsDrawer 组件测试——建议抽屉显隐、只读预览
// （name/scope/断言数 + 「AI 生成」来源标注，裁定④）、勾选联动 store、采用按钮门控
// （未勾选禁用；采用并入 editor.api.cases 且不自动落盘）、关闭即丢弃（零落盘）。
// antd Drawer 传送门渲染到 document.body → body 作用域查询。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi, AI_FIXTURE_SUGGESTIONS } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { createAiStore } from "../../../src/renderer/src/stores/ai.js";
import type { LocalTreeNodeDTO } from "../../../src/shared/tree-dto.js";
import AiSuggestionsDrawer from "../../../src/renderer/src/components/AiSuggestionsDrawer.vue";
import { createAiBusinessFixture, seedAiBusinessFixture } from '../fixtures/aiBusiness.js';

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
afterEach(() => { localStorage.setItem('apicc.locale', 'zh-CN'); });

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

/** 装配：已加载接口的 editor + ai store；可预取固定建议并打开抽屉。 */
async function mountDrawer({ suggestions = false, open = true }: { suggestions?: boolean; open?: boolean } = {}) {
  const { api } = createAiBusinessFixture();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = firstApiNode(ws.tree!);
  if (!apiNode) throw new Error("Expected the API fixture to be present in the tree.");
  const editor = useEditorStore(api, () => ({ root: ws.root, readOnly: ws.readOnly }));
  await editor.load(apiNode.locator);
  const ai = createAiStore({ api, editor, storage: memStorage(), getContext: () => ({ root: ws.root, readOnly: ws.readOnly }) });
  if (suggestions) {
    // Preparation binds the existing target; completed candidates are test-only display input until confirmation is implemented.
    await ai.fetchSuggestions();
    ai.outboundPreview = null;
    ai.suggestions = structuredClone([...AI_FIXTURE_SUGGESTIONS]);
    if (!open) ai.drawerOpen = false;
  } else {
    ai.drawerOpen = open;
  }
  const { i18n } = createI18nInstance();
  const wrapper = mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [i18n] } });
  await flushPromises();
  return { wrapper, api, editor, ai, ws };
}

describe("AiSuggestionsDrawer", () => {
  it.each(['preview', 'prepare-failure', 'start-success'] as const)('final C I6 prior real settings failure cannot override a new business %s', async outcome => {
    const { api, ai } = await seedAiBusinessFixture(), ui = createI18nInstance(); ui.setLocale('en');
    api.aiConnectionTest = async () => { throw new Error('AI 请求失败（network）'); };
    await ai.testConnection('model-a'); expect(ai.settingsIssue?.code).toBe('network');
    if (outcome === 'prepare-failure') api.aiPrepareAssistance = async () => { throw new Error('context-budget'); };
    await ai.fetchSuggestions();
    if (outcome === 'start-success') await ai.confirmAssistance();
    if (outcome === 'preview') expect(ai.outboundPreview).not.toBeNull();
    if (outcome === 'start-success') expect(ai.businessResult).not.toBeNull();
    mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [ui.i18n] } }); await flushPromises();
    const alert = document.body.querySelector('[role="alert"]')?.textContent ?? '';
    if (outcome === 'prepare-failure') expect(alert).toMatch(/input|context|selection|smaller/i);
    else expect(alert).toBe('');
    expect(alert).not.toMatch(/network|invalid configuration/i);
  });
  const errors = [
    ['cancelled', /cancel/i, /取消/], ['deadline', /time|deadline/i, /期限|时限|超时/],
    ['refusal', /refus|declin/i, /拒绝/], ['incomplete', /incomplete|not complete/i, /未完成|不完整/],
    ['business-output-invalid', /invalid.*output|output.*invalid/i, /输出.*(?:无效|非法)|(?:无效|非法).*输出/],
    ['evidence-selection-too-large', /evidence.*(?:limit|budget|fewer|too many)|(?:limit|budget).*evidence/i, /证据.*(?:额度|上限|缩小|过多)/],
  ] as const;
  for (const locale of ['zh-CN', 'en'] as const) it.each(errors)('final C I6 real host %s category has a safe current business explanation in ' + locale, async (code, english, chinese) => {
    const { ai, api, started } = await seedAiBusinessFixture(); await ai.fetchSuggestions(); expect(ai.outboundPreview).not.toBeNull();
    // The ordinary IPC rejection shape is the same fixed category emitted by runtime.start.
    api.aiStart = async () => { throw new Error(`Error invoking remote method 'ai:start': Error: AI 辅助失败（${code}）`); };
    await ai.confirmAssistance();
    const ui = createI18nInstance(); ui.setLocale(locale);
    mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [ui.i18n] } }); await flushPromises();
    const alert = document.body.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toMatch(locale === 'en' ? english : chinese);
    expect(alert).not.toContain('Error invoking'); expect(alert).not.toContain('aiSettings.'); expect(started).toEqual([]);
  });
  it.each(['case', 'report'] as const)('final C I6 %s prepare normalizes the same safe code and never retains provider text', async purpose => {
    const { ai, api, editor } = await seedAiBusinessFixture(), locator = editor.locator!;
    api.aiPrepareAssistance = async () => { throw new Error("Error invoking remote method 'ai:prepare': Error: AI 辅助失败（refusal）"); };
    if (purpose === 'case') await ai.fetchSuggestions();
    else await ai.prepareReportAnalysis({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } }, report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) } });
    expect.soft(ai.error).toBe('refusal');
    api.aiPrepareAssistance = async () => { throw new Error('FINAL_C_PROVIDER_BODY sk-secret-token request {"secret":"do-not-retain"}'); };
    if (purpose === 'case') await ai.fetchSuggestions();
    else await ai.prepareReportAnalysis({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } }, report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) } });
    expect(ai.error).not.toContain('FINAL_C_PROVIDER_BODY'); expect(JSON.stringify(ai.$state)).not.toContain('sk-secret-token');
  });
  // Catches a closed UI leaving the original host operation/listener/local timer alive.
  it('T11 B6 closing the real active drawer cancels its exact operation and immediately releases progress and elapsed timer', async () => {
    const { api, ai } = await mountDrawer(); await ai.fetchSuggestions();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const cancelled: string[] = []; let unsubscribed = 0, operationId = '';
    api.onAiProgress = () => () => { unsubscribed++; };
    api.aiCancel = async input => { cancelled.push(input.operationId); return { cancelled: true }; };
    const start = api.aiStart; api.aiStart = async input => { operationId = input.operationId; const result = await start(input); await gate; return result; };
    const clearTimer = vi.spyOn(globalThis, 'clearInterval');
    const pending = ai.confirmAssistance(); await flushPromises();
    try {
      expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
      const close = document.body.querySelector('.ant-drawer-close'); expect(close).not.toBeNull();
      await new DOMWrapper(close!).trigger('click'); await flushPromises();
      expect.soft(cancelled).toEqual([operationId]);
      expect.soft(unsubscribed).toBe(1);
      expect.soft(clearTimer).toHaveBeenCalledTimes(1);
      const elapsed = ai.businessElapsedMs;
      await new Promise(resolve => setTimeout(resolve, 150));
      expect.soft(ai.businessElapsedMs).toBe(elapsed);
      release(); await pending;
      expect(ai.drawerOpen).toBe(false); expect(ai.businessResult).toBeNull(); expect(ai.suggestions).toBeNull();
      expect(unsubscribed).toBe(1);
    } finally { release(); await pending; clearTimer.mockRestore(); }
  });
  // Catches omitting elapsed time or presenting a local clock as a provider progress percentage.
  it('T11 labels elapsed time as local milliseconds while awaiting real host progress', async () => {
    const { api, ai } = await mountDrawer(); await ai.fetchSuggestions();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const start = api.aiStart;
    api.aiStart = async input => { const result = await start(input); await gate; return result; };
    const pending = ai.confirmAssistance(); await flushPromises();
    try {
      expect(document.body.textContent).toContain('本地耗时');
      expect(document.body.textContent).toContain('ms');
      expect(document.body.querySelector('[role="progressbar"]')).toBeNull();
    } finally { release(); await pending; }
  });
  // Catches true progress existing in the store while the product keeps it invisible.
  it('T11 displays the actual receiving phase attempt and bytes without a percent bar', async () => {
    const { api, ai } = await mountDrawer(); await ai.fetchSuggestions();
    let receive: ((progress: import('../../../src/shared/ai/contract.js').AiProgressDto) => void) | undefined;
    let operationId = '', release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    api.onAiProgress = listener => { receive = listener; return () => {}; };
    const start = api.aiStart; api.aiStart = async input => { operationId = input.operationId; const result = await start(input); await gate; return result; };
    const pending = ai.confirmAssistance(); await flushPromises();
    try {
      receive?.({ operationId, phase: 'receiving', attempt: 2, receivedBytes: 321 }); await flushPromises();
      expect(document.body.textContent).toContain('正在接收');
      expect(document.body.textContent).toContain('321');
      expect(document.body.textContent).toMatch(/尝试.*2/);
      expect(document.body.querySelector('[role="progressbar"]')).toBeNull();
    } finally { release(); await pending; }
  });

  // Catches cancellation being implemented internally but unavailable to the user during a request.
  it('T11 cancels the current AI operation through the visible cancel button', async () => {
    const { api, ai } = await mountDrawer(); await ai.fetchSuggestions();
    let operationId = '', release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const cancelled: string[] = [], start = api.aiStart;
    api.aiStart = async input => { operationId = input.operationId; const result = await start(input); await gate; return result; };
    api.aiCancel = async input => { cancelled.push(input.operationId); return { cancelled: true }; };
    const pending = ai.confirmAssistance(); await flushPromises();
    try {
      const button = document.body.querySelector('[data-testid="ai-cancel-operation"]');
      if (button) await new DOMWrapper(button).trigger('click');
      expect(cancelled).toEqual([operationId]);
    } finally { release(); await pending; }
  });
  // Catches a prepared preview exposing a permanently disabled confirmation with no start path.
  it('T11 confirms the displayed preview through the visible send button', async () => {
    const { api, ai } = await mountDrawer();
    let starts = 0; const start = api.aiStart;
    api.aiStart = async input => { starts++; return start(input); };
    await ai.fetchSuggestions(); await flushPromises();
    const button = document.body.querySelector('[data-testid="ai-confirm-send"]');
    if (button) await new DOMWrapper(button).trigger('click');
    await flushPromises();
    expect(starts).toBe(1);
    expect(ai.selectedIds).toEqual([]);
    expect(bodyFindAll('ai-suggest-item')).toHaveLength(2);
  });
  // Catches omitting the explicit send decision and outbound inclusion/omission facts from a prepared preview.
  it('T11 shows the outbound inclusion omission and redaction review before an explicit send decision', async () => {
    const { ai } = await mountDrawer();
    await ai.fetchSuggestions(); await flushPromises();
    const visible = document.body.textContent ?? '';
    expect(visible).toContain('确认外发');
    expect(visible).toContain('1234');
    expect(visible).toContain('manual-model-A');
    expect(visible).toContain('contract');
    expect(visible).toContain('scripts');
    expect(visible).toMatch(/脱敏/);
    expect(ai.suggestions).toBeNull();
  });

  // Catches replacing candidate business details with only counts before explicit adoption.
  it("T11 shows actual candidate parameters and keeps preview unselected without editing the API", async () => {
    const { editor, ai } = await mountDrawer({ suggestions: true });
    const original = JSON.stringify(editor.api);
    ai.suggestions![0]!.parameters = { tenant: "north", pageSize: "25" };
    await flushPromises();
    for (const detail of document.body.querySelectorAll("details")) detail.open = true;
    expect(document.body.textContent).toContain("tenant");
    expect(document.body.textContent).toContain("north");
    expect(document.body.textContent).toContain("pageSize");
    expect(document.body.textContent).toContain("25");
    expect(ai.selectedIds).toEqual([]);
    expect(JSON.stringify(editor.api)).toBe(original);
    expect(editor.dirty).toBe(false);
  });

  // Catches showing assertion totals while hiding the exact condition a user would adopt.
  it("T11 exposes the assertion target operator path and expected value", async () => {
    const { ai } = await mountDrawer({ suggestions: true });
    ai.suggestions![0]!.assertions = [{ id: "candidate-condition", target: "bodyJson", op: "eq", path: "$.customer.region", expected: "north" }];
    await flushPromises();
    for (const detail of document.body.querySelectorAll("details")) detail.open = true;
    expect(document.body.textContent).toContain("$.customer.region");
    expect(document.body.textContent).toContain("bodyJson");
    expect(document.body.textContent).toContain("eq");
    expect(document.body.textContent).toContain("north");
  });

  // Catches dropping script source or post operations under a metadata/JSON restriction.
  it("T11 makes complete pre and post scripts inspectable with a trust warning", async () => {
    const { ai } = await mountDrawer({ suggestions: true });
    ai.suggestions![0]!.preOperations = [{ id: "candidate-pre", type: "script", content: 'const tenant = "north";\nconsole.log("pre-script-end");' }];
    ai.suggestions![0]!.postOperations = [{ id: "candidate-post", type: "script", content: 'console.log("post-script-begin");\nconsole.log("post-script-end");' }];
    await flushPromises();
    for (const detail of document.body.querySelectorAll("details")) detail.open = true;
    expect(document.body.textContent).toContain('const tenant = "north";');
    expect(document.body.textContent).toContain('console.log("pre-script-end");');
    expect(document.body.textContent).toContain('console.log("post-script-begin");');
    expect(document.body.textContent).toContain('console.log("post-script-end");');
    expect(document.body.textContent).toMatch(/受信|信任/);
  });

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
    expect(items[1]!.find('[data-testid="ai-suggest-postoperations"]').text()).toContain(
      String(AI_FIXTURE_SUGGESTIONS[1]!.postOperations.length),
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
    expect(ai.selectedIds).toEqual([ai.suggestions![0]!.id]);
    await checks[1]!.setValue(true);
    expect(ai.selectedIds).toHaveLength(2);
    await checks[0]!.setValue(false);
    expect(ai.selectedIds).toEqual([ai.suggestions![1]!.id]);
  });

  it("采用门控：未勾选禁用；勾选后可用，点击采用并入 editor.api.cases 且不自动保存（裁定③）", async () => {
    const { api, editor, ai, ws } = await mountDrawer({ suggestions: true });
    const before = editor.api!.cases.length;
    expect(expectBody("ai-adopt-btn").attributes("disabled")).toBeDefined();
    let saveCalls = 0;
    const original = api.apiSave.bind(api);
    api.apiSave = async (locator, asset, revision) => {
      saveCalls += 1;
      return original(locator, asset, revision);
    };
    const checks = bodyFindAll("ai-suggest-check");
    await checks[1]!.setValue(true);
    expect(expectBody("ai-adopt-btn").attributes("disabled")).toBeUndefined();
    const beforeReadOnly = JSON.parse(JSON.stringify(editor.api!.cases)) as unknown;
    ws.readOnly = true;
    await flushPromises();
    expect(expectBody("ai-adopt-btn").attributes("disabled")).toBeDefined();
    expect(ai.adopt()).toBe(0);
    expect(JSON.parse(JSON.stringify(editor.api!.cases))).toEqual(beforeReadOnly);
    expect(editor.dirty).toBe(false);
    expect(ai.suggestions).not.toBeNull();
    ws.readOnly = false;
    await flushPromises();
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
