// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；store 工厂每调用一次即新建
// 独立 Pinia 实例，这里按组合根约定一次性装配 editor/cases 后经 props 注入被测组件。
// 本文件补任务 5 待办：CasePanel 组件测试（挂载后添加用例、保存成功路径），
// 并钉住任务 8 新增的可选 reportError 通道（case-save 拒绝不再静默吞没）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useCasesStore } from "../../../src/renderer/src/stores/cases.js";
import CasePanel from "../../../src/renderer/src/components/CasePanel.vue";

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

/** 显式装配辅助（组合根约定的测试形态）：editor 加载接口后创建 cases store 注入组件。 */
async function mountCasePanel(props: Record<string, unknown> = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  const cases = useCasesStore(api, editor);
  const { i18n } = createI18nInstance();
  const wrapper = mount(CasePanel, {
    props: { editor, cases, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, editor, cases };
}

describe("CasePanel", () => {
  it("未加载接口时渲染空态", async () => {
    const api = createMemoryApi();
    const editor = useEditorStore(api);
    const cases = useCasesStore(api, editor);
    const { i18n } = createI18nInstance();
    const wrapper = mount(CasePanel, { props: { editor, cases }, global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="case-add"]').exists()).toBe(false);
  });

  it("添加用例：列表新增一行且新用例即选中（任务 5 待办补课）", async () => {
    const { wrapper, editor, cases } = await mountCasePanel();
    expect(wrapper.findAll('[data-testid="case-row"]')).toHaveLength(1);
    await wrapper.find('[data-testid="case-add"]').trigger("click");
    expect(wrapper.findAll('[data-testid="case-row"]')).toHaveLength(2);
    expect(editor.api!.cases).toHaveLength(2);
    expect(cases.selectedCaseId).toBe(editor.api!.cases[1]!.id);
  });

  it("保存成功路径：改名后 case-save 委托 editor.save 持久化并复位 dirty（任务 5 待办补课）", async () => {
    const { wrapper, editor } = await mountCasePanel();
    await wrapper.find('[data-testid="case-add"]').trigger("click");
    await wrapper.findAll('[data-testid="case-name"]')[1]!.setValue("登录用例");
    expect(editor.dirty).toBe(true);
    await wrapper.find('[data-testid="case-save"]').trigger("click");
    await flushPromises();
    expect(editor.dirty).toBe(false);
    expect(editor.api!.cases[1]!.name).toBe("登录用例");
  });

  it("保存链路拒绝时经 reportError 上报（任务 8：case-save 补错误通道）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api } = await mountCasePanel({ reportError: (e: unknown) => { errors.push(e); } });
    api.apiSave = async () => { throw new Error("保存失败（测试注入）"); };
    await wrapper.find('[data-testid="case-save"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("保存失败（测试注入）");
  });
});
