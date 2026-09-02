// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；store 按组合根约定一次性装配后
// 经 props 注入被测组件（组件内部禁止重复调用工厂）。antd message 传送门渲染于
// document.body，导出成功文案用 body 级文本断言。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDesignStore } from "../../../src/renderer/src/stores/design.js";
import DesignPanel from "../../../src/renderer/src/components/DesignPanel.vue";

beforeAll(() => {
  // jsdom 未实现 matchMedia；antd 组件（响应式断点）挂载时需要。
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

/** 显式装配辅助（组合根约定的测试形态）：editor 加载接口后创建 design store 注入组件。 */
async function mountDesignPanel(props: Record<string, unknown> = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  const design = useDesignStore(api, editor);
  const { i18n } = createI18nInstance();
  const wrapper = mount(DesignPanel, {
    props: { editor, design, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, editor, design };
}

describe("DesignPanel", () => {
  it("未加载接口时渲染空态", async () => {
    const api = createMemoryApi();
    const editor = useEditorStore(api);
    const design = useDesignStore(api, editor);
    const { i18n } = createI18nInstance();
    const wrapper = mount(DesignPanel, { props: { editor, design }, global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="design-content"]').exists()).toBe(false);
  });

  it("挂载即水合当前接口设计；编辑置 dirty；保存写回并持久化", async () => {
    const { wrapper, editor, design } = await mountDesignPanel();
    // memory 预置接口未编写 design → 水合为空串
    expect(design.content).toBe("");
    await wrapper.find('[data-testid="design-content"]').setValue("校验约定：金额必须大于 0");
    expect(design.dirty).toBe(true);
    await wrapper.find('[data-testid="design-save"]').trigger("click");
    await flushPromises();
    expect(design.dirty).toBe(false);
    expect(editor.api!.design).toBe("校验约定：金额必须大于 0");
    expect(wrapper.find('[data-testid="design-saved"]').exists()).toBe(true);
  });

  it("导出 agent 设计：designExport 成功后 message 显示保存路径", async () => {
    const { wrapper, api, editor } = await mountDesignPanel();
    let calledApiId: string | null = null;
    const original = api.designExport.bind(api);
    api.designExport = async (apiId: string) => {
      calledApiId = apiId;
      return original(apiId);
    };
    await wrapper.find('[data-testid="design-export"]').trigger("click");
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0)); // antd message 传送门渲染一帧
    expect(calledApiId).toBe(editor.apiId);
    expect(document.body.textContent).toContain("已导出");
    expect(document.body.textContent).toContain("示例接口.design.md");
  });

  it("导出链路拒绝时经 reportError 上报（不静默吞没）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api } = await mountDesignPanel({ reportError: (e: unknown) => { errors.push(e); } });
    api.designExport = async () => { throw new Error("导出失败（测试注入）"); };
    await wrapper.find('[data-testid="design-export"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("导出失败（测试注入）");
  });
});
