// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境。
//
// M6-C 任务 1（规格 §2 D2/D4）：AiConfigDialog 组件测试——baseUrl/model/key 三字段、
// 表单校验先行（url/model 必填）、保存调 store（组件内零工厂调用：store 经 props 注入）、
// key 留空 = 保持既有（不携 apiKey）、连接测试两态上屏（fixture 阶段经 ai:suggest 桩）、
// hasKey 徽标、关闭卸载。antd 适配沿用 OnlineLoginDialog.test.ts 约定：a-modal 传送门
// 渲染到 document.body → body 作用域查询。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import type { AiProviderTemplate } from "@apicc/core";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { createAiStore } from "../../../src/renderer/src/stores/ai.js";
import AiConfigDialog from "../../../src/renderer/src/components/AiConfigDialog.vue";
import { createSafeAiSettingsFixture } from "../fixtures/aiSettings.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { withPlainArgs } from "../../../src/renderer/src/api/index.js";

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


describe("AiConfigDialog safe settings contract (migrated existing coverage)", () => {
  it("R7 starts the suggestions setup on existing case-suggestion purpose binding", async () => {
    const { ai, read, networkActions } = await mountSafeDialog({ open: false, forSuggestion: true });
    await ai.writeSettings({ operation: "preferences", expectedRevision: read().revision, bindings: [] });
    ai.configDialogOpen = true;
    await flushPromises();
    expect((expectBody("budget-layer").element as HTMLSelectElement).value).toBe("binding");
    expect((expectBody("budget-purpose").element as HTMLSelectElement).value).toBe("case-suggestion");
    await expectBody("budget-model").setValue("model-b");
    await expectBody("budget-save").trigger("click");
    await flushPromises();
    expect(read().bindings).toEqual([expect.objectContaining({ purpose: "case-suggestion", modelProfileId: "model-b" })]);
    expect(networkActions).toEqual([]);
  });

  it('P3d jumps to configuration sections without replacing drafts, saving or making network calls', async () => {
    const { ai, read, networkActions } = await mountSafeDialog();
    const before = read(), hash = location.hash;
    await expectBody('connection-name').setValue('尚未保存的连接名称');
    await expectBody('connection-key').setValue('synthetic-unsaved-key');
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrolled: Element[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable:true, value:function(this:HTMLElement){scrolled.push(this);}});
    try {
      for (const section of ['models','budgets','connections']) {
        await expectBody(`ai-jump-${section}`).trigger('click');
        expect(document.activeElement?.id).toBe(`ai-${section}-title`);
        expect(scrolled.at(-1)).toBe(document.activeElement);
      }
      expect((expectBody('connection-name').element as HTMLInputElement).value).toBe('尚未保存的连接名称');
      expect((expectBody('connection-key').element as HTMLInputElement).value).toBe('synthetic-unsaved-key');
      expect(read()).toEqual(before); expect(networkActions).toEqual([]); expect(location.hash).toBe(hash);
      expect(ai.configDialogOpen).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype,'scrollIntoView');
    }
  });
  it("configDialogOpen=false does not render; opening shows connection/model fields and a password input", async () => {
    const { ai } = await mountSafeDialog({ open: false });
    expect(bodyHas("ai-config-body")).toBe(false);
    ai.configDialogOpen = true; await flushPromises();
    expect(document.body.textContent).toContain("AI 与模型");
    expect(bodyHas("connection-url")).toBe(true);
    expect(bodyHas("model-id")).toBe(true);
    expect((expectBody("connection-key").element as HTMLInputElement).type).toBe("password");
    expect(expectBody("ai-config-body").text()).toContain("凭据可用");
  });

  it("validates required connection fields before sending a save", async () => {
    const { api, read } = await mountSafeDialog();
    const before = read();
    const sent: unknown[] = [];
    const write = api.aiSettingsWrite;
    api.aiSettingsWrite = async input => { sent.push(input); return write(input); };
    await expectBody("connection-name").setValue("");
    await expectBody("connection-url").setValue("");
    await expectBody("connection-save").trigger("click"); await flushPromises();
    expect(expectBody("ai-save-error").text()).toContain("配置无效");
    expect(sent).toEqual([]);
    expect(read()).toEqual(before);
  });

  it("saves configuration and a newly entered key separately; a later rename sends no credential and retains its status", async () => {
    const { api, ai } = await mountSafeDialog();
    const sent: unknown[] = [];
    const write = api.aiSettingsWrite;
    api.aiSettingsWrite = async input => { sent.push(input); return write(input); };
    await expectBody("connection-name").setValue("保存后重命名");
    await expectBody("connection-save").trigger("click"); await flushPromises();
    expect(sent[0]).toMatchObject({ operation: "connection", connection: { name: "保存后重命名", id: "personal-primary" } });
    await expectBody("connection-key").setValue("sk-dialog-1");
    await expectBody("credential-save").trigger("click"); await flushPromises();
    expect(sent[1]).toMatchObject({ operation: "credential", connectionId: "personal-primary", value: "sk-dialog-1", mode: "persistent" });
    expect(expectBody("ai-saved").text()).toContain("已保存");
    expect(expectBody("ai-config-body").text()).toContain("凭据可用");
    expect((expectBody("connection-key").element as HTMLInputElement).value).toBe("");
    expect(JSON.stringify(ai.$state)).not.toContain("sk-dialog-1");
    sent.length = 0;
    await expectBody("connection-name").setValue("再次重命名");
    await expectBody("connection-save").trigger("click"); await flushPromises();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ operation: "connection", connection: { name: "再次重命名" } });
    expect(JSON.stringify(sent)).not.toContain("sk-dialog-1");
    expect(expectBody("ai-config-body").text()).toContain("凭据可用");
  });

  it("shows explicit probe failure and successful retry as mutually exclusive states", async () => {
    const { api, ai } = await mountSafeDialog();
    const probe = api.aiConnectionTest;
    api.aiConnectionTest = async () => { throw new Error("AI 请求失败（http）"); };
    await expectBody("model-probe").trigger("click"); await flushPromises();
    expect(ai.testResult).toBe("failure");
    expect(expectBody("ai-save-error").text()).toContain("服务端返回错误");
    expect(bodyHas("ai-test-ok")).toBe(false);
    api.aiConnectionTest = probe;
    await expectBody("model-probe").trigger("click"); await flushPromises();
    expect(ai.testResult).toBe("success");
    expect(expectBody("ai-test-ok").text()).toContain("连接成功");
    expect(bodyHas("ai-save-error")).toBe(false);
  });

  it("close sets configDialogOpen=false and unmounts its body", async () => {
    const { ai } = await mountSafeDialog();
    await expectBody("ai-config-close").trigger("click"); await flushPromises();
    expect(ai.configDialogOpen).toBe(false);
    expect(bodyHas("ai-config-body")).toBe(false);
  });

  it("reopening clears secret drafts/notices and refills the authoritative connection", async () => {
    const { ai } = await mountSafeDialog();
    await expectBody("connection-name").setValue("重开回填");
    await expectBody("connection-save").trigger("click"); await flushPromises();
    await expectBody("connection-key").setValue("sk-residual");
    await expectBody("ai-config-close").trigger("click"); await flushPromises();
    ai.configDialogOpen = true; await flushPromises();
    expect((expectBody("connection-key").element as HTMLInputElement).value).toBe("");
    expect((expectBody("connection-name").element as HTMLInputElement).value).toBe("重开回填");
    expect((expectBody("connection-url").element as HTMLInputElement).value).toBe("https://models.example.test/gateway/v1");
    expect(bodyHas("ai-saved")).toBe(false);
  });
});
describe("F7e T10 readable personal configuration", () => {
  it.each(['zh-CN', 'en'] as const)('final C I5 saved six-request budget visibly warns about cost and waiting in %s', async locale => {
    const { ai, networkActions } = await mountSafeDialog({ locale });
    await expectBody('budget-maxRequests').setValue('6');
    await expectBody('budget-save').trigger('click'); await flushPromises();
    expect(ai.resolveSettings('model-a', 'case-suggestion').warnings).toHaveLength(1);
    const body = expectBody('ai-config-body');
    expect(body.text()).toMatch(locale === 'en' ? /cost.*wait|wait.*cost/i : /费用.*等待|等待.*费用/);
    expect(expectBody('effective-evidenceCount').text()).toBe(locale === 'en' ? '20 items' : '20 项');
    expect(networkActions).toEqual([]); expect(body.find('pre').exists()).toBe(false);
  });
  it.each(['zh-CN', 'en'] as const)('final C M6 capability labels distinguish declared capacity from usage budget in %s', async locale => {
    const { read } = await mountSafeDialog({ locale }), before = read();
    const input = expectBody('capability-maxInputTokens').element.closest('label')!.textContent ?? '';
    const output = expectBody('capability-maxOutputTokens').element.closest('label')!.textContent ?? '';
    expect.soft(input).toMatch(locale === 'en' ? /(?:maximum|max).*input.*(?:capacity|capability)/i : /最大输入.*能力/);
    expect.soft(output).toMatch(locale === 'en' ? /(?:maximum|max).*output.*(?:capacity|capability)/i : /最大输出.*能力/);
    expect.soft(input).not.toMatch(/使用预算|usage budget/i); expect.soft(output).not.toMatch(/使用预算|usage budget/i);
    const models = document.getElementById('ai-models-title')!.closest('section')!;
    expect.soft(models.textContent).not.toMatch(/输入 Token 使用预算|输出 Token 使用预算|Input token usage budget|Output token usage budget/i);
    expect(expectBody('budget-maxInputTokens').element.closest('tr')!.textContent).toMatch(/使用预算|usage budget/i);
    expect(read()).toEqual(before);
  });
  it.each(['zh-CN', 'en'] as const)('final C M8 no-auth option has a business label instead of boolean No in %s', async locale => {
    const { read, networkActions } = await mountSafeDialog({ locale }), before = read();
    const option = expectBody('connection-auth').find('option[value="none"]');
    expect(option.text()).toBe(locale === 'en' ? 'No authentication' : '无认证');
    expect(read()).toEqual(before); expect(networkActions).toEqual([]);
  });
  // Catches rendering only the obsolete flat URL/model/key form despite safe host settings being available.
  it("shows personal ownership, connections, models and separate usage/protection sections without opening raw data", async () => {
    const { api, networkActions } = createSafeAiSettingsFixture();
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const ai = createAiStore({ api, editor, storage: memStorage(), getContext: () => ({ root: "", readOnly: false }) });
    await ai.init();
    ai.configDialogOpen = true;
    const { i18n } = createI18nInstance();
    mount(AiConfigDialog, { props: { ai }, global: { plugins: [i18n] } });
    await flushPromises();
    const body = expectBody("ai-config-body");
    expect(body.text()).toContain("个人 · 当前设备");
    expect(body.text()).toContain("连接");
    expect(body.text()).toContain("个人主连接");
    expect(body.text()).toContain("凭据可用");
    expect(body.text()).toContain("模型与能力");
    expect(body.text()).toContain("manual-model-A");
    expect(body.text()).toContain("manual-model-B");
    expect(body.text()).toContain("使用预算");
    expect(body.text()).toContain("应用保护");
    expect(body.find("pre").exists()).toBe(false);
    expect(body.text()).not.toContain('"credentialState"');
    expect(networkActions).toEqual([]);
  });
});

async function mountSafeDialog(options: {
  backend?: "available" | "unavailable"; locale?: "zh-CN" | "en";
  open?: boolean;
  forSuggestion?: boolean;
  catalog?: AiProviderTemplate[]; templateSource?: { id: string; revision: number };
  legacyAvailable?: boolean;
} = {}) {
  const fixture = createSafeAiSettingsFixture(options);
  const editor = useEditorStore(fixture.api, () => ({ root: "", readOnly: false }));
  const ai = createAiStore({ api: fixture.api, editor, storage: memStorage() });
  await ai.init();
  ai.configDialogOpen = options.open ?? true;
  const { i18n, setLocale } = createI18nInstance();
  setLocale(options.locale ?? "zh-CN");
  mount(AiConfigDialog, { props: { ai, forSuggestion: options.forSuggestion }, global: { plugins: [i18n] } });
  await flushPromises();
  return { ...fixture, ai };
}

describe("F7e T10 batch2 connection writes", () => {
  // Catches a disconnected save button, client-side-only settings, or accidental credential overwrite on rename.
  it("saves a connection rename offline, retaining the bound credential and authoritative revision", async () => {
    const { read, networkActions } = await mountSafeDialog();
    await expectBody("connection-name").setValue("重命名主连接");
    await expectBody("connection-save").trigger("click");
    await flushPromises();
    expect(read().connections[0]?.name).toBe("重命名主连接");
    expect(read().connections[0]?.credentialState).toBe("available");
    expect(read().connections[0]?.revision).toBe(2);
    expect(expectBody("ai-saved").text()).toContain("已保存");
    expect(networkActions).toEqual([]);
  });
  // Catches sending the old key to an edited address, rather than requiring a separate explicit binding.
  it("changing the destination invalidates its credential and visibly asks for rebinding", async () => {
    const { read } = await mountSafeDialog();
    await expectBody("connection-url").setValue("https://different.example.test/v1");
    await expectBody("connection-save").trigger("click");
    await flushPromises();
    expect(read().connections[0]?.credentialState).toBe("missing");
    expect(expectBody("ai-config-body").text()).toContain("重新绑定凭据");
  });
  // Catches secret retention in the password field and using persistence when session-only was selected.
  it("binds a session-only credential without changing persistent revisions and clears its input", async () => {
    const { read, ai } = await mountSafeDialog({ backend: "unavailable" });
    const before = read();
    await expectBody("credential-mode").setValue("session-only");
    await expectBody("connection-key").setValue("new-session-secret");
    await expectBody("credential-save").trigger("click");
    await flushPromises();
    expect(read().connections[0]?.credentialState).toBe("session-only");
    expect(read().revision).toBe(before.revision);
    expect(read().connections[0]?.revision).toBe(before.connections[0]?.revision);
    expect((expectBody("connection-key").element as HTMLInputElement).value).toBe("");
    expect(JSON.stringify(ai.$state)).not.toContain("new-session-secret");
    await expectBody("ai-config-close").trigger("click");
    ai.configDialogOpen = true;
    await flushPromises();
    expect((expectBody("connection-key").element as HTMLInputElement).value).toBe("");
  });
  // Catches skipping the shared URL/auth schema or displaying raw validation JSON.
  it("rejects an unsafe URL with a readable field error while keeping the saved connection unchanged", async () => {
    const { read } = await mountSafeDialog();
    await expectBody("connection-url").setValue("http://public.example.test/v1");
    await expectBody("connection-save").trigger("click");
    await flushPromises();
    expect(expectBody("ai-config-body").text()).toContain("配置无效");
    expect(read().connections[0]?.baseUrl).toBe("https://models.example.test/gateway/v1");
  });
  // Uses the real Electron/Core plain-message error shape; catches leaking Chinese wrappers into English UI.
  it("presents a host revision conflict in English and preserves the edited form for retry", async () => {
    const { api } = await mountSafeDialog({ locale: "en" });
    api.aiSettingsWrite = async () => { throw new Error("Error invoking remote method 'ai:settings-write': Error: AI personal configuration: revision-conflict"); };
    await expectBody("connection-name").setValue("Retry this name");
    await expectBody("connection-save").trigger("click");
    await flushPromises();
    expect(expectBody("ai-config-body").text()).toContain("Settings changed; reload and retry");
    expect(expectBody("ai-config-body").text()).not.toContain("AI personal configuration:");
    expect((expectBody("connection-name").element as HTMLInputElement).value).toBe("Retry this name");
  });
});

describe("F7e T10 batch3 capability and budget presentation", () => {
  // Catches collapsing declared capacity into the editable usage budget, or omitting the final routed URL.
  it("shows declared capacities and complete protocol request URLs for manual models", async () => {
    await mountSafeDialog();
    const body = expectBody("ai-config-body");
    expect(body.text()).toContain("上下文窗口能力");
    expect(body.text()).toContain("131072");
    expect(body.text()).toContain("https://models.example.test/gateway/v1/chat/completions");
    expect(body.text()).toContain("https://models.example.test/gateway/v1/models");
  });
  // Catches hiding inheritance provenance and effective limits behind a raw document.
  it("shows effective budget values and source labels before expanding advanced data", async () => {
    await mountSafeDialog();
    const body = expectBody("ai-config-body");
    expect(body.text()).toContain("有效值");
    expect(body.text()).toContain("来源");
    expect(body.text()).toContain("总输出 Token 使用预算");
    expect(body.text()).toContain("输入 Token 使用预算");
    expect(body.text()).toContain("模型设置");
  });
});

describe("F7e T10 batch4 independent model budgets", () => {
  // Catches a shared mutable budget across models and resetting explicit overrides on application changes.
  it("saves model A independently, changes application defaults, and restores only A's inheritance", async () => {
    const { read } = await mountSafeDialog();
    await expectBody("budget-maxOutputTokens").setValue("4096");
    await expectBody("budget-save").trigger("click");
    await flushPromises();
    expect(read().models.find(m => m.id === "model-a")?.budgets.maxOutputTokens).toBe(4096);
    expect(read().models.find(m => m.id === "model-b")?.budgets.maxOutputTokens).toBe(32768);
    await expectBody("budget-layer").setValue("application");
    await expectBody("budget-maxOutputTokens").setValue("12288");
    await expectBody("budget-save").trigger("click");
    await flushPromises();
    expect(read().application.purposeDefaults["case-suggestion"]?.maxOutputTokens).toBe(12288);
    expect(read().models.find(m => m.id === "model-a")?.budgets.maxOutputTokens).toBe(4096);
    await expectBody("budget-layer").setValue("model");
    await expectBody("inherit-maxOutputTokens").trigger("click");
    await flushPromises();
    expect(read().models.find(m => m.id === "model-a")?.budgets.maxOutputTokens).toBeUndefined();
    expect(read().models.find(m => m.id === "model-b")?.budgets.maxOutputTokens).toBe(32768);
    expect(expectBody("effective-maxOutputTokens").text()).toContain("8192 Token");
    expect(expectBody("ai-config-body").text()).toContain("受模型限制");
  });
  // Catches deriving total tokens from request count, and losing a real zero in protection fields.
  it("changing requests from 3 to 10 retains the saved total tokens and permits queue size zero", async () => {
    const { read } = await mountSafeDialog();
    await expectBody("budget-maxRequests").setValue("10");
    await expectBody("budget-save").trigger("click");
    await flushPromises();
    expect(read().models[0]?.budgets.maxRequests).toBe(10);
    expect(read().models[0]?.budgets.totalOutputTokens).toBe(24576);
    await expectBody("protection-hostQueueSize").setValue("0");
    await expectBody("protection-save").trigger("click");
    await flushPromises();
    expect(read().application.protection.hostQueueSize).toBe(0);
  });
  // Catches silent clipping of explicit output and shared-context input overages.
  it.each([["maxOutputTokens", "8193"], ["maxInputTokens", "24577"]] as const)("rejects explicit %s overflow with a visible source and preserves saved values", async (field, value) => {
    const { read } = await mountSafeDialog({ locale: "en" });
    await expectBody(`budget-${field}`).setValue(value);
    await expectBody("budget-save").trigger("click");
    await flushPromises();
    expect(expectBody("ai-config-body").text()).toContain("Invalid configuration");
    expect(expectBody("ai-save-error").text()).toContain("Model settings");
    expect(read().models[0]?.budgets[field]).toBe(field === "maxOutputTokens" ? 8192 : undefined);
  });
  // Catches treating confirmed output-only capability as confirmed input capacity.
  it("does not expand input bytes for a model with only output capacity confirmed", async () => {
    const { api, ai, read } = await mountSafeDialog();
    const initial = await api.aiSettingsRead();
    initial.models[0]!.capabilities = { status: "confirmed", source: "output only", maxOutputTokens: 8192 };
    await api.aiSettingsWrite({ operation: "preferences", expectedRevision: initial.revision, models: initial.models });
    await ai.init(); await flushPromises();
    await expectBody("budget-maxInputBytes").setValue("524288");
    await expectBody("budget-save").trigger("click");
    await flushPromises();
    expect(expectBody("ai-save-error").text()).toContain("输入字节预算");
    expect(expectBody("ai-save-error").text()).toContain("模型设置");
    expect(read().models[0]?.budgets.maxInputBytes).toBeUndefined();
  });
  // Catches conflating declaration with usage, and automatic reinitialization on edits.
  it("saves model capability changes without rewriting its existing budgets", async () => {
    const { read } = await mountSafeDialog();
    await expectBody("capability-contextWindowTokens").setValue("65536");
    await expectBody("capability-outputIncludesReasoning").setValue("true");
    await expectBody("model-save").trigger("click");
    await flushPromises();
    expect(read().models[0]?.capabilities.contextWindowTokens).toBe(65536);
    expect(read().models[0]?.budgets).toEqual({ maxOutputTokens: 8192, totalOutputTokens: 24576 });
    expect(read().models[1]?.capabilities.contextWindowTokens).toBe(131072);
  });
  // Catches preselecting paid model names or silently omitting explicit reasoning initialization.
  it("creates a manual reasoning model with explicitly initialized budgets", async () => {
    const { read, networkActions } = await mountSafeDialog();
    await expectBody("model-new").trigger("click");
    expect((expectBody("model-id").element as HTMLInputElement).value).toBe("");
    await expectBody("model-id").setValue("user-selected-reasoner");
    await expectBody("capability-status").setValue("confirmed");
    await expectBody("capability-maxOutputTokens").setValue("65536");
    await expectBody("capability-outputIncludesReasoning").setValue("true");
    await expectBody("model-init-reasoning").setValue(true);
    await expectBody("model-save").trigger("click");
    await flushPromises();
    expect(read().models.find(m => m.modelId === "user-selected-reasoner")?.budgets).toEqual({ maxOutputTokens: 32768, totalOutputTokens: 98304 });
    expect(networkActions).toEqual([]);
  });
});

describe("F7e T10 batch5 explicit network actions", () => {
  // Catches implicit probing during open/save and broken probe/discovery buttons.
  it("only probes and discovers on explicit separate actions, while manual models remain usable after unsupported discovery", async () => {
    const { read, networkActions } = await mountSafeDialog();
    expect(networkActions).toEqual([]);
    await expectBody("model-probe").trigger("click"); await flushPromises();
    expect(expectBody("ai-config-body").text()).toContain("连接成功");
    expect(networkActions).toEqual(["test:model-a"]);
    await expectBody("model-discover").trigger("click"); await flushPromises();
    expect(expectBody("ai-config-body").text()).toContain("不支持模型发现，可手工填写模型");
    expect(networkActions).toEqual(["test:model-a", "discover:personal-primary"]);
    expect(read().models.map(m => m.modelId)).toEqual(["manual-model-A", "manual-model-B"]);
  });
  // Catches accepting a late success after a user cancels an owner-scoped operation.
  it("cancels a pending probe by its UUID and ignores its late success", async () => {
    const { api, ai } = await mountSafeDialog();
    let release!: (value: { ok: true }) => void;
    let operationId = "";
    api.aiConnectionTest = ({ operationId: id }) => { operationId = id; return new Promise(resolve => { release = resolve; }); };
    let cancelledId = "";
    api.aiCancel = async ({ operationId: id }) => { cancelledId = id; return { cancelled: true }; };
    await expectBody("model-probe").trigger("click"); await flushPromises();
    expect(ai.testing).toBe(true);
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    await expectBody("ai-operation-cancel").trigger("click"); await flushPromises();
    expect(cancelledId).toBe(operationId);
    release({ ok: true }); await flushPromises();
    expect(ai.testing).toBe(false);
    expect(expectBody("ai-config-body").text()).not.toContain("连接成功");
  });
  // Real runtime wrapper, not a translated fake host.
  it("explains a real runtime deadline error in English", async () => {
    const { api } = await mountSafeDialog({ locale: "en" });
    api.aiConnectionTest = async () => { throw new Error("Error invoking remote method 'ai:connection-test': Error: AI 请求失败（ai-deadline）"); };
    await expectBody("model-probe").trigger("click"); await flushPromises();
    expect(expectBody("ai-config-body").text()).toContain("Time limit reached");
    expect(expectBody("ai-config-body").text()).not.toContain("AI 请求失败");
  });
});

const T10_PROVIDER: AiProviderTemplate = {
  id: "vendor-demo", formatVersion: 1, revision: 1, name: "示例供应商模板",
  baseUrl: "https://models.example.test/gateway/v1", auth: { kind: "bearer" }, headers: {},
  protocols: ["openai-chat-completions", "openai-responses", "anthropic-messages"],
  defaultProtocol: "openai-chat-completions", modelDiscovery: true,
};

describe("F7e T10 batch6 catalog and connection controls", () => {
  // Catches ignoring the public catalog and omitting an explicit local reload action.
  it("shows the provider catalog and reloads it without probing or altering existing connections", async () => {
    const { read, catalogActions, networkActions } = await mountSafeDialog({ catalog: [T10_PROVIDER] });
    const before = read();
    expect(expectBody("ai-config-body").text()).toContain("供应商模板");
    expect(expectBody("ai-config-body").text()).toContain("示例供应商模板");
    await expectBody("catalog-reload").trigger("click"); await flushPromises();
    expect(catalogActions.filter(action => action.operation === "reload")).toHaveLength(2);
    expect(read()).toEqual(before);
    expect(networkActions).toEqual([]);
  });
  // Catches a supplier singleton that overwrites a user's existing connection when adding a second account.
  it("creates a second connection from the same provider with a distinct stable identity only after save", async () => {
    const { read, networkActions } = await mountSafeDialog({ catalog: [T10_PROVIDER], templateSource: { id: T10_PROVIDER.id, revision: 1 } });
    expect(expectBody("ai-config-body").text()).toContain("从模板新建连接");
    await expectBody("connection-template").setValue(T10_PROVIDER.id);
    await expectBody("connection-from-template").trigger("click"); await flushPromises();
    expect(read().connections).toHaveLength(1);
    await expectBody("connection-name").setValue("同厂商第二账号");
    await expectBody("connection-save").trigger("click"); await flushPromises();
    const connections = read().connections;
    expect(connections).toHaveLength(2);
    expect(new Set(connections.map(connection => connection.id)).size).toBe(2);
    expect(connections.map(connection => connection.templateSource?.id)).toEqual(["vendor-demo", "vendor-demo"]);
    expect(connections.find(connection => connection.id === "personal-primary")?.credentialState).toBe("available");
    expect(connections.find(connection => connection.name === "同厂商第二账号")?.credentialState).toBe("missing");
    expect(networkActions).toEqual([]);
  });
  // Catches requiring a template or discovery even when the user explicitly knows a custom endpoint.
  it("creates a manual connection without a template or automatic network operation", async () => {
    const { read, networkActions } = await mountSafeDialog();
    expect(expectBody("ai-config-body").text()).toContain("新建连接");
    await expectBody("connection-new").trigger("click"); await flushPromises();
    expect((expectBody("connection-url").element as HTMLInputElement).value).toBe("");
    await expectBody("connection-name").setValue("手工代理连接");
    await expectBody("connection-url").setValue("https://manual.example.test/tenant/api");
    await expectBody("connection-save").trigger("click"); await flushPromises();
    expect(read().connections.find(connection => connection.name === "手工代理连接")?.baseUrl).toBe("https://manual.example.test/tenant/api");
    expect(networkActions).toEqual([]);
  });
  // Catches exposing an auth selector that never changes the actual safe public connection.
  it("saves an explicit API-key audience and enabled protocol through the existing safe settings contract", async () => {
    const { read } = await mountSafeDialog();
    expect(expectBody("ai-config-body").text()).toContain("鉴权方式");
    await expectBody("connection-auth").setValue("api-key");
    await expectBody("connection-auth-header").setValue("X-Tenant-Key");
    await expectBody("connection-protocol-openai-responses").setValue(true);
    await expectBody("connection-save").trigger("click"); await flushPromises();
    expect(read().connections[0]?.auth).toEqual({ kind: "api-key", header: "X-Tenant-Key" });
    expect(read().connections[0]?.protocols).toContain("openai-responses");
    expect(read().connections[0]?.credentialState).toBe("missing");
  });
  // Catches omitting ordinary vendor headers or converting them into an unreadable JSON editor.
  it("edits non-secret headers as labelled fields and saves their actual values", async () => {
    const { read } = await mountSafeDialog();
    expect(expectBody("ai-config-body").text()).toContain("非敏感请求头");
    await expectBody("connection-header-add").trigger("click");
    await expectBody("connection-header-name-0").setValue("X-Organization");
    await expectBody("connection-header-value-0").setValue("personal-workspace");
    await expectBody("connection-save").trigger("click"); await flushPromises();
    expect(read().connections[0]?.headers).toEqual({ "X-Organization": "personal-workspace" });
    expect(expectBody("ai-config-body").find("pre").exists()).toBe(false);
  });
  // Catches applying template imports immediately and silently moving a credential-bound destination.
  // Conflict rejection is deliberately a later gate: it cannot be reached until this normal import UI exists.
  it("previews template changes from a file without adopting them into existing connections", async () => {
    const { read, catalogActions, networkActions } = await mountSafeDialog({ catalog: [T10_PROVIDER], templateSource: { id: T10_PROVIDER.id, revision: 1 } });
    expect(expectBody("ai-config-body").text()).toContain("导入模板 JSON 文件");
    const input = expectBody("catalog-import-file");
    const file = new File([JSON.stringify({ formatVersion: 1, providers: [{ ...T10_PROVIDER, revision: 2, baseUrl: "https://new.example.test/v2" }] })], "vendor-update.json", { type: "application/json" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await vi.waitFor(() => expect(expectBody("ai-config-body").text()).toContain("vendor-demo"));
    expect(expectBody("ai-config-body").text()).toContain("模板差异");
    expect(catalogActions.filter(action => action.operation === "import")).toEqual([{ operation: "import", apply: undefined, confirmConflicts: undefined }]);
    expect(read().connections[0]?.baseUrl).toBe("https://models.example.test/gateway/v1");
    expect(read().connections[0]?.credentialState).toBe("available");
    expect(networkActions).toEqual([]);
  });
});

async function previewTemplateUpdate() {
  const context = await mountSafeDialog({ catalog: [T10_PROVIDER], templateSource: { id: T10_PROVIDER.id, revision: 1 } });
  const input = expectBody("catalog-import-file");
  const nextTemplate = { ...T10_PROVIDER, revision: 2, baseUrl: "https://new.example.test/v2" };
  const file = new File([JSON.stringify({ formatVersion: 1, providers: [nextTemplate] })], "vendor-update.json", { type: "application/json" });
  Object.defineProperty(input.element, "files", { value: [file], configurable: true });
  await input.trigger("change");
  await vi.waitFor(() => expect(expectBody("ai-config-body").text()).toContain("vendor-demo"));
  return context;
}

describe("F7e T10 batch7 safeguards and explicit template adoption", () => {
  // Catches authorizing the saved destination while the user sees an unsaved replacement address.
  it("does not probe a connection while its destination edit is unsaved", async () => {
    const { networkActions } = await mountSafeDialog();
    await expectBody("connection-url").setValue("https://unsaved.example.test/v1");
    await expectBody("model-probe").trigger("click"); await flushPromises();
    expect(networkActions).toEqual([]);
    expect(expectBody("ai-config-body").text()).toContain("重新绑定凭据");
  });
  // Catches probing a saved model while previewing an edited protocol/model destination in the same form.
  it("does not probe a model while its protocol edit is unsaved", async () => {
    const { networkActions } = await mountSafeDialog();
    await expectBody("model-protocol").setValue("openai-responses");
    expect(expectBody("model-final-url").text()).toContain("/gateway/v1/responses");
    await expectBody("model-probe").trigger("click"); await flushPromises();
    expect(networkActions).toEqual([]);
  });
  // Catches a late success being presented as a result for the newly selected model.
  it("does not present a pending model A probe success after the editor switches to model B", async () => {
    const { api, ai } = await mountSafeDialog();
    let release!: (value: { ok: true }) => void;
    api.aiConnectionTest = () => new Promise(resolve => { release = resolve; });
    await expectBody("model-probe").trigger("click"); await flushPromises();
    expect(ai.testing).toBe(true);
    await expectBody("model-edit-model-b").trigger("click");
    release({ ok: true }); await flushPromises();
    expect(expectBody("ai-config-body").text()).not.toContain("连接成功");
  });
  // Existing Core rejection is a regression expectation, not newly invented renderer validation.
  // The new requirement is that the user sees a business field label, not a translated internal header key.
  it.each([
    { kind: "protected-header", field: "非敏感请求头" },
    { kind: "bound-secret-header", field: "非敏感请求头" },
    { kind: "public-no-auth", field: "鉴权方式" },
  ] as const)("keeps rejected $kind out of IPC and explains its business field", async ({ kind, field }) => {
    const { api, read } = await mountSafeDialog();
    const before = read();
    const writes: unknown[] = [];
    const write = api.aiSettingsWrite;
    api.aiSettingsWrite = async input => { writes.push(input); return write(input); };
    if (kind === "public-no-auth") await expectBody("connection-auth").setValue("none");
    else {
      if (kind === "bound-secret-header") {
        await expectBody("connection-auth").setValue("api-key");
        await expectBody("connection-auth-header").setValue("X-Tenant-Key");
      }
      await expectBody("connection-header-add").trigger("click");
      await expectBody("connection-header-name-0").setValue(kind === "protected-header" ? "Authorization" : "X-Tenant-Key");
      await expectBody("connection-header-value-0").setValue("must-not-persist");
    }
    await expectBody("connection-save").trigger("click"); await flushPromises();
    expect(writes).toEqual([]);
    expect(read()).toEqual(before);
    expect(expectBody("ai-save-error").text()).toContain("配置无效");
    expect(expectBody("ai-save-error").text()).toContain(field);
    expect(expectBody("ai-save-error").text()).not.toContain("aiSettings.fields.");
  });
  // Positive counterpart for the existing Core loopback policy; it may already pass and is labelled regression.
  it("allows explicitly opted-in HTTP loopback with no authentication", async () => {
    const { read } = await mountSafeDialog();
    await expectBody("connection-url").setValue("http://127.0.0.1:8080/custom");
    await expectBody("connection-auth").setValue("none");
    await expectBody("connection-insecure-local").setValue(true);
    await expectBody("connection-save").trigger("click"); await flushPromises();
    expect(read().connections[0]?.auth).toEqual({ kind: "none" });
    expect(read().connections[0]?.baseUrl).toBe("http://127.0.0.1:8080/custom");
  });
  // Catches losing the failed file identity and leaving the user with a generic configuration error.
  it("shows which malformed import file failed without replacing the current provider catalog", async () => {
    const { ai, catalogActions } = await mountSafeDialog({ catalog: [T10_PROVIDER] });
    const input = expectBody("catalog-import-file");
    const file = new File(["{ malformed"], "vendor-broken.json", { type: "application/json" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await vi.waitFor(() => expect(bodyHas("ai-save-error")).toBe(true));
    expect(expectBody("ai-save-error").text()).toContain("vendor-broken.json");
    expect(ai.catalog?.catalog.map(template => template.id)).toEqual(["vendor-demo"]);
    expect(catalogActions.some(action => action.operation === "import")).toBe(false);
  });
  // Apply is an explicit normal action; conflict policy remains owned by the existing host, with no new UI validator.
  it("requires explicit conflict confirmation before the host applies an imported template", async () => {
    const { read, catalogActions } = await previewTemplateUpdate();
    expect(expectBody("ai-config-body").text()).toContain("确认应用导入");
    await expectBody("catalog-import-apply").trigger("click"); await flushPromises();
    expect(expectBody("ai-save-error").text()).toContain("冲突");
    expect(read().connections[0]?.baseUrl).toBe("https://models.example.test/gateway/v1");
    await expectBody("catalog-confirm-conflicts").setValue(true);
    await expectBody("catalog-import-apply").trigger("click"); await flushPromises();
    expect(catalogActions.filter(action => action.operation === "import" && action.apply).map(action => action.confirmConflicts)).toEqual([false, true]);
    expect(read().connections[0]?.templateSource?.revision).toBe(1);
    expect(read().connections[0]?.credentialState).toBe("available");
  });
  // Catches silently moving old connections on catalog reload/apply rather than an explicit per-connection update.
  it("adopts a template change into only the selected connection after explicit update and save", async () => {
    const { api, ai, read } = await mountSafeDialog({ catalog: [T10_PROVIDER], templateSource: { id: T10_PROVIDER.id, revision: 1 } });
    await api.aiCatalogImport({ file: "vendor-update.json", document: { formatVersion: 1, providers: [{ ...T10_PROVIDER, revision: 2, baseUrl: "https://new.example.test/v2" }] }, apply: true, confirmConflicts: true });
    await ai.reloadCatalog(); await flushPromises();
    expect(read().connections[0]?.baseUrl).toBe("https://models.example.test/gateway/v1");
    expect(expectBody("ai-config-body").text()).toContain("显式采用模板更新");
    await expectBody("connection-template-update").trigger("click"); await flushPromises();
    expect(read().connections[0]?.templateSource?.revision).toBe(1);
    await expectBody("connection-save").trigger("click"); await flushPromises();
    expect(read().connections[0]?.baseUrl).toBe("https://new.example.test/v2");
    expect(read().connections[0]?.templateSource?.revision).toBe(2);
    expect(read().connections[0]?.credentialState).toBe("missing");
  });
});

describe("F7e T10 batch8 final settings lifecycle safeguards", () => {
  // Catches carrying confirmation for a different proposal/file across imports.
  it("requires fresh conflict confirmation when a new template file is previewed", async () => {
    const { ai } = await previewTemplateUpdate();
    await expectBody("catalog-confirm-conflicts").setValue(true);
    const input = expectBody("catalog-import-file");
    const next = new File([JSON.stringify({ formatVersion: 1, providers: [{ ...T10_PROVIDER, revision: 3, baseUrl: "https://third.example.test/v3" }] })], "another-update.json", { type: "application/json" });
    Object.defineProperty(input.element, "files", { value: [next], configurable: true });
    await input.trigger("change");
    await vi.waitFor(() => expect(ai.catalogPreview?.catalog.find(template => template.id === "vendor-demo")?.revision).toBe(3));
    expect((expectBody("catalog-confirm-conflicts").element as HTMLInputElement).checked).toBe(false);
  });
  // Catches applying a stale valid proposal while the file control displays a different failed import.
  it("discards the prior applicable preview when a newly selected file is malformed", async () => {
    const { ai } = await previewTemplateUpdate();
    expect(ai.catalogImportInput?.file).toBe("vendor-update.json");
    const input = expectBody("catalog-import-file");
    const bad = new File(["{ invalid"], "replacement-broken.json", { type: "application/json" });
    Object.defineProperty(input.element, "files", { value: [bad], configurable: true });
    await input.trigger("change");
    await vi.waitFor(() => expect(bodyHas("ai-save-error")).toBe(true));
    expect(ai.catalogImportInput).toBeNull();
    expect(ai.catalogPreview).toBeNull();
    expect(bodyHas("catalog-import-apply")).toBe(false);
  });
  // Catches a conflict message that asks the user to reload but supplies no actual refresh action.
  it("reloads authoritative settings after a conflict and refills the connection editor", async () => {
    const { api, read } = await mountSafeDialog({ locale: "en" });
    const { credentialState: _state, ...connection } = read().connections[0]!;
    await api.aiSettingsWrite({ operation: "connection", expectedRevision: 1, connection: { ...connection, name: "Externally renamed" } });
    await expectBody("connection-save").trigger("click"); await flushPromises();
    expect(expectBody("ai-save-error").text()).toContain("Settings changed; reload and retry");
    expect(expectBody("ai-config-body").text()).toContain("Reload settings");
    await expectBody("ai-settings-reload").trigger("click"); await flushPromises();
    expect((expectBody("connection-name").element as HTMLInputElement).value).toBe("Externally renamed");
    expect(bodyHas("ai-save-error")).toBe(false);
  });
  // Native confirmation is authoritative; the renderer sends neither an address nor a confirmation boolean.
  it("offers native legacy migration and explains a confirmation-required result without activating old settings", async () => {
    const { api, read } = await mountSafeDialog({ legacyAvailable: true });
    const before = read();
    const received: unknown[] = [];
    const write = api.aiSettingsWrite;
    api.aiSettingsWrite = async input => {
      received.push(input);
      return input.operation === "migrate-legacy" ? { status: "confirmation-required", credentialState: "missing" } : write(input);
    };
    expect(expectBody("ai-config-body").text()).toContain("确认旧地址并迁移旧配置");
    await expectBody("ai-legacy-migrate").trigger("click"); await flushPromises();
    expect(received).toEqual([{ operation: "migrate-legacy" }]);
    expect(expectBody("ai-config-body").text()).toContain("需要在系统确认窗口确认旧地址");
    expect(read()).toEqual(before);
  });
  // Use the actual product fallback, whose fixed Chinese error must not leak through English UI.
  it("explains the real missing trusted desktop host in English", async () => {
    const api = createMemoryApi();
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const ai = createAiStore({ api, editor, storage: memStorage() });
    ai.configDialogOpen = true;
    const { i18n, setLocale } = createI18nInstance(); setLocale("en");
    mount(AiConfigDialog, { props: { ai }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(expectBody("ai-save-error").text()).toContain("Trusted desktop settings host unavailable");
    expect(expectBody("ai-save-error").text()).not.toContain("需要可信桌面宿主");
  });
});

describe("F7e T10 batch9 authoritative settings race and preservation", () => {
  // Holds only the external IPC response, after the real FileReader/parser and host preview have run.
  // Catches an older preview reply taking authority over the newly selected file.
  it("retains the newer selected file when an older preview IPC reply arrives late", async () => {
    const { api, ai } = await mountSafeDialog({ catalog: [T10_PROVIDER] });
    const original = api.aiCatalogImport;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let oldPreviewStarted = false;
    api.aiCatalogImport = async input => {
      const result = await original(input);
      if (input.file === "older-selection.json") { oldPreviewStarted = true; await gate; }
      return result;
    };
    const input = expectBody("catalog-import-file");
    const older = new File([JSON.stringify({ formatVersion: 1, providers: [{ ...T10_PROVIDER, revision: 2 }] })], "older-selection.json", { type: "application/json" });
    Object.defineProperty(input.element, "files", { value: [older], configurable: true });
    await input.trigger("change");
    await vi.waitFor(() => expect(oldPreviewStarted).toBe(true));
    const newer = new File([JSON.stringify({ formatVersion: 1, providers: [{ ...T10_PROVIDER, revision: 3 }] })], "newer-selection.json", { type: "application/json" });
    Object.defineProperty(input.element, "files", { value: [newer], configurable: true });
    await input.trigger("change");
    await vi.waitFor(() => expect(ai.catalogPreview?.catalog.find(template => template.id === "vendor-demo")?.revision).toBe(3));
    release(); await flushPromises();
    expect(ai.catalogImportInput?.file).toBe("newer-selection.json");
    expect(ai.catalogPreview?.catalog.find(template => template.id === "vendor-demo")?.revision).toBe(3);
  });
  // The model capability editor and budget editor share one authoritative store, but have independent drafts.
  // Catches a capability save serializing old hidden budgets back over a completed budget save.
  it("preserves the latest saved usage budget when saving a capability from an older model editor draft", async () => {
    const { read } = await mountSafeDialog();
    await expectBody("budget-maxOutputTokens").setValue("4096");
    await expectBody("budget-save").trigger("click"); await flushPromises();
    expect(read().models.find(model => model.id === "model-a")?.budgets.maxOutputTokens).toBe(4096);
    await expectBody("capability-contextWindowTokens").setValue("65536");
    await expectBody("model-save").trigger("click"); await flushPromises();
    expect(read().models.find(model => model.id === "model-a")?.capabilities.contextWindowTokens).toBe(65536);
    expect(read().models.find(model => model.id === "model-a")?.budgets.maxOutputTokens).toBe(4096);
    expect(read().models.find(model => model.id === "model-b")?.budgets.maxOutputTokens).toBe(32768);
  });
});

describe("F7e T10 fix1 bound-purpose editing and apply proposal identity", () => {
  // Catches switching to another purpose while resolving its existing B binding against the first model A.
  it("previews the existing bound model when switching to its purpose budget", async () => {
    const { api, read } = await mountSafeDialog();
    await api.aiSettingsWrite({ operation: "preferences", expectedRevision: read().revision, bindings: [
      { purpose: "case-suggestion", modelProfileId: "model-a", budgets: {} },
      { purpose: "assertion-suggestion", modelProfileId: "model-b", budgets: { maxRequests: 4 } },
    ] });
    await expectBody("ai-settings-reload").trigger("click"); await flushPromises();
    await expectBody("budget-layer").setValue("binding");
    await expectBody("budget-purpose").setValue("assertion-suggestion"); await flushPromises();
    expect((expectBody("budget-maxRequests").element as HTMLInputElement).value).toBe("4");
    expect(expectBody("effective-maxOutputTokens").text()).toContain("32768");
    expect((expectBody("budget-model").element as HTMLSelectElement).value).toBe("model-b");
  });
  // Uses a small request-count edit so I1 cannot mask the accidental binding target overwrite.
  it("preserves an existing B binding when entering its budget layer and saving only a budget", async () => {
    const { api, read } = await mountSafeDialog();
    await api.aiSettingsWrite({ operation: "preferences", expectedRevision: read().revision, bindings: [
      { purpose: "case-suggestion", modelProfileId: "model-b", budgets: { maxRequests: 4 } },
    ] });
    await expectBody("ai-settings-reload").trigger("click"); await flushPromises();
    await expectBody("budget-layer").setValue("binding");
    await expectBody("budget-maxRequests").setValue("5");
    await expectBody("budget-save").trigger("click"); await flushPromises();
    expect(read().bindings[0]?.budgets.maxRequests).toBe(5);
    expect(read().bindings[0]?.modelProfileId).toBe("model-b");
    expect(expectBody("effective-maxOutputTokens").text()).toContain("32768");
    // Existing normal contract: a later explicit model choice is still allowed to change the binding.
    await expectBody("budget-model").setValue("model-a"); await flushPromises();
    expect((expectBody("budget-model").element as HTMLSelectElement).value).toBe("model-a");
    await expectBody("budget-save").trigger("click"); await flushPromises();
    expect(read().bindings[0]?.modelProfileId).toBe("model-a");
    expect(read().bindings[0]?.budgets.maxRequests).toBe(5);
  });
  // Only the external IPC reply is held: file reading, catalog preview and the host's real apply/conflict run.
  // Catches old successful apply clearing B's preview, or an old host conflict leaking into B's error channel.
  it.each(["success", "failure"] as const)("retains newly previewed file B after file A apply returns late %s", async outcome => {
    const { api, ai } = await previewTemplateUpdate();
    await vi.waitFor(() => expect(ai.catalogImportInput?.file).toBe("vendor-update.json"));
    // App's actual Electron API wraps every call with this existing production plain-args boundary.
    const original = withPlainArgs(api).aiCatalogImport;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let applyStarted = false;
    let applyReply: { ok: boolean; error?: unknown } | undefined;
    api.aiCatalogImport = async input => {
      if (!input.apply) return original(input);
      const reply = await original(input).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      applyReply = reply;
      applyStarted = true;
      await gate;
      if (!reply.ok) throw reply.error;
      return reply.value;
    };
    if (outcome === "success") await expectBody("catalog-confirm-conflicts").setValue(true);
    await expectBody("catalog-import-apply").trigger("click");
    await vi.waitFor(() => expect(applyStarted).toBe(true));
    expect(applyReply?.ok, String(applyReply?.error)).toBe(outcome === "success");
    const input = expectBody("catalog-import-file");
    const newer = new File([JSON.stringify({ formatVersion: 1, providers: [{ ...T10_PROVIDER, revision: 3, name: "当前文件B模板" }] })], "current-file-b.json", { type: "application/json" });
    Object.defineProperty(input.element, "files", { value: [newer], configurable: true });
    await input.trigger("change");
    await vi.waitFor(() => expect(ai.catalogImportInput?.file).toBe("current-file-b.json"));
    expect(ai.catalogPreview?.catalog.find(template => template.id === "vendor-demo")?.revision).toBe(3);
    expect(bodyHas("catalog-import-apply")).toBe(true);
    expect(bodyHas("ai-save-error")).toBe(false);
    release(); await flushPromises();
    if (outcome === "success") {
      expect(ai.catalogImportInput?.file).toBe("current-file-b.json");
      expect(ai.savedNotice).toBe(false);
    } else {
      expect(bodyHas("ai-save-error")).toBe(false);
      expect(ai.settingsIssue).toBeNull();
    }
    expect(ai.catalogPreview?.catalog.find(template => template.id === "vendor-demo")?.revision).toBe(3);
    expect(bodyHas("catalog-import-apply")).toBe(true);
  });
});
