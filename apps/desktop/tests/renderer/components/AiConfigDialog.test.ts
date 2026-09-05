// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境。
//
// M6-C 任务 1（规格 §2 D2/D4）：AiConfigDialog 组件测试——baseUrl/model/key 三字段、
// 表单校验先行（url/model 必填）、保存调 store（组件内零工厂调用：store 经 props 注入）、
// key 留空 = 保持既有（不携 apiKey）、连接测试两态上屏（fixture 阶段经 ai:suggest 桩）、
// hasKey 徽标、关闭卸载。antd 适配沿用 OnlineLoginDialog.test.ts 约定：a-modal 传送门
// 渲染到 document.body → body 作用域查询。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { createAiStore } from "../../../src/renderer/src/stores/ai.js";
import AiConfigDialog from "../../../src/renderer/src/components/AiConfigDialog.vue";

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

async function mountDialog({ open = true }: { open?: boolean } = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  const ai = createAiStore({ api, editor, storage: memStorage() });
  ai.configDialogOpen = open;
  const { i18n } = createI18nInstance();
  const wrapper = mount(AiConfigDialog, { props: { ai }, global: { plugins: [i18n] } });
  await flushPromises();
  return { wrapper, api, ai };
}

describe("AiConfigDialog", () => {
  it("configDialogOpen=false 不渲染；true 渲染 baseUrl/model/key 三字段（key 为密码框）", async () => {
    const { ai } = await mountDialog({ open: false });
    expect(bodyHas("ai-config-body")).toBe(false);
    ai.configDialogOpen = true;
    await flushPromises();
    expect(document.body.textContent).toContain("AI 配置");
    expect(bodyHas("ai-config-body")).toBe(true);
    expect(bodyHas("ai-config-baseurl")).toBe(true);
    expect(bodyHas("ai-config-model")).toBe(true);
    expect(bodyHas("ai-config-key")).toBe(true);
    expect(bodyHas("ai-has-key")).toBe(false); // 默认无 key：徽标不显示
  });

  it("表单校验先行：baseUrl/model 为空 → ai-form-error 且保存不发起", async () => {
    const { api, ai } = await mountDialog();
    let saveCalls = 0;
    api.aiSaveConfig = async (input) => {
      saveCalls += 1;
      void input;
      return { hasKey: false };
    };
    await expectBody("ai-config-save").trigger("click");
    expect(expectBody("ai-form-error").text()).toContain("API 地址");
    await expectBody("ai-config-baseurl").setValue("https://a");
    await expectBody("ai-config-save").trigger("click");
    expect(expectBody("ai-form-error").text()).toContain("模型");
    expect(saveCalls).toBe(0);
    expect(ai.hasKey).toBe(false);
  });

  it("保存：调 store 携带三字段；key 留空 = 保持既有（载荷不含 apiKey）；成功提示 + hasKey 徽标", async () => {
    const { api, ai } = await mountDialog();
    const sent: unknown[] = [];
    const original = api.aiSaveConfig.bind(api);
    api.aiSaveConfig = async (input) => {
      sent.push(JSON.parse(JSON.stringify(input)));
      return original(input);
    };
    await expectBody("ai-config-baseurl").setValue("https://api.example.com/v1");
    await expectBody("ai-config-model").setValue("gpt-test");
    await expectBody("ai-config-key").setValue("sk-dialog-1");
    await expectBody("ai-config-save").trigger("click");
    await flushPromises();
    expect(sent).toEqual([{ baseUrl: "https://api.example.com/v1", model: "gpt-test", apiKey: "sk-dialog-1" }]);
    expect(expectBody("ai-saved").text()).toContain("已保存");
    expect(bodyHas("ai-has-key")).toBe(true);
    // 保存成功后 key 输入清空（不在表单残留凭据）
    expect((expectBody("ai-config-key").element as HTMLInputElement).value).toBe("");
    // key 留空再保存：载荷不含 apiKey
    sent.length = 0;
    await expectBody("ai-config-model").setValue("gpt-test-2");
    await expectBody("ai-config-save").trigger("click");
    await flushPromises();
    expect(sent).toEqual([{ baseUrl: "https://api.example.com/v1", model: "gpt-test-2" }]);
  });

  it("连接测试：未配置 → 失败告警（ai-test-fail 携可读错误）；保存后 → 成功告警（ai-test-ok）", async () => {
    const { ai } = await mountDialog();
    await expectBody("ai-config-test").trigger("click");
    await flushPromises();
    expect(ai.testResult).toBe("failure");
    expect(expectBody("ai-test-fail").text()).toContain("尚未配置 AI");
    expect(bodyHas("ai-test-ok")).toBe(false);

    await expectBody("ai-config-baseurl").setValue("https://a");
    await expectBody("ai-config-model").setValue("m");
    await expectBody("ai-config-key").setValue("sk-x");
    await expectBody("ai-config-save").trigger("click");
    await flushPromises();
    await expectBody("ai-config-test").trigger("click");
    await flushPromises();
    expect(ai.testResult).toBe("success");
    expect(expectBody("ai-test-ok").text()).toContain("连接成功");
    expect(bodyHas("ai-test-fail")).toBe(false);
  });

  it("关闭按钮：置 configDialogOpen=false 卸载对话框", async () => {
    const { ai } = await mountDialog();
    await expectBody("ai-config-close").trigger("click");
    await flushPromises();
    expect(ai.configDialogOpen).toBe(false);
    expect(bodyHas("ai-config-body")).toBe(false);
  });

  it("重新打开重置本地表单：key 输入不跨会话残留，baseUrl/model 回填 store 配置", async () => {
    const { ai } = await mountDialog();
    await expectBody("ai-config-baseurl").setValue("https://a");
    await expectBody("ai-config-model").setValue("m");
    await expectBody("ai-config-key").setValue("sk-residual");
    await expectBody("ai-config-save").trigger("click");
    await flushPromises();
    await expectBody("ai-config-close").trigger("click");
    ai.configDialogOpen = true;
    await flushPromises();
    expect((expectBody("ai-config-key").element as HTMLInputElement).value).toBe("");
    expect((expectBody("ai-config-baseurl").element as HTMLInputElement).value).toBe("https://a");
    expect((expectBody("ai-config-model").element as HTMLInputElement).value).toBe("m");
    // 保存提示/测试结果不跨会话残留
    expect(bodyHas("ai-saved")).toBe(false);
  });
});
