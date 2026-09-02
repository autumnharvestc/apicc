// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；jsdom 未实现 matchMedia，antd
// 组件挂载需要（见 EnvPanel.test.ts 文件头说明）。文件选择经 input[type=file] 注入
// File 对象 + change 事件驱动（组件即以该通道读文本，Electron 渲染层同语义）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useImportWizardStore } from "../../../src/renderer/src/stores/importW.js";
import ImportWizard from "../../../src/renderer/src/components/ImportWizard.vue";

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

/** 显式装配辅助（组合根约定的测试形态）：store 一次性创建，经 props 注入被测组件。 */
async function mountWizard(props: Record<string, unknown> = {}) {
  const errors: unknown[] = [];
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const importW = useImportWizardStore(api, workspace);
  const { i18n } = createI18nInstance();
  const wrapper = mount(ImportWizard, {
    props: { importW, reportError: (e: unknown) => { errors.push(e); }, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, importW, errors };
}

/** 文件选择适配：jsdom 无法真正弹文件对话框，直接向 input[type=file] 注入 File 并派发 change。 */
async function pickFile(wrapper: Awaited<ReturnType<typeof mountWizard>>["wrapper"], fileName: string, content: string) {
  const input = wrapper.find('[data-testid="import-file-input"]').element as HTMLInputElement;
  const file = new File([content], fileName, { type: "text/yaml" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await input.dispatchEvent(new Event("change"));
  await flushPromises();
}

describe("ImportWizard", () => {
  it("三步推进：选文件进预览 → 填分组名导入 → 完成态（api 已落库、树已刷新）", async () => {
    const { wrapper, api, workspace, importW } = await mountWizard();
    // 第一步：只有文件选择，没有预览内容
    expect(wrapper.find('[data-testid="import-file-input"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-group-input"]').exists()).toBe(false);
    await pickFile(wrapper, "sample.yaml", "openapi: 3.0.0");
    // 第二步：预览树 + 警告 + 分组名输入出现
    expect(wrapper.find('[data-testid="import-preview-tree"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-warnings"]').text()).toContain("示例警告");
    expect(wrapper.find('[data-testid="import-group-input"]').exists()).toBe(true);
    // 分组名为空时导入按钮禁用
    expect(wrapper.find('[data-testid="import-apply"]').attributes("disabled")).toBeDefined();
    await wrapper.find('[data-testid="import-group-input"]').setValue("导入分组");
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    await flushPromises();
    // 第三步：完成态；apply 记录调用、工作区树已刷新出导入分组与项目
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(true);
    expect(api.importApplyCalls).toEqual([{ groupName: "导入分组", projectName: "导入示例项目" }]);
    const groupNode = workspace.tree!.children!.find((n) => n.label === "导入分组");
    expect(groupNode).toBeDefined();
    expect(groupNode!.children!.map((n) => n.label)).toContain("导入示例项目");
    expect(importW.applying).toBe(false);
  });

  it("取消：清空 preview 并向组合根发 close 事件", async () => {
    const { wrapper, importW } = await mountWizard();
    await pickFile(wrapper, "sample.yaml", "x");
    expect(importW.preview).not.toBeNull();
    await wrapper.find('[data-testid="import-cancel"]').trigger("click");
    await flushPromises();
    expect(importW.preview).toBeNull();
    expect(wrapper.emitted("close")).toHaveLength(1);
    // 回到第一步：预览内容不再展示
    expect(wrapper.find('[data-testid="import-group-input"]').exists()).toBe(false);
  });

  it("完成态点完成后关闭向导（close 事件 + 回到第一步）", async () => {
    const { wrapper } = await mountWizard();
    await pickFile(wrapper, "sample.yaml", "x");
    await wrapper.find('[data-testid="import-group-input"]').setValue("g");
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="import-finish"]').trigger("click");
    await flushPromises();
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(false);
  });

  it("apply 拒绝时经 reportError 上报且不进入完成态（可修改后重试）", async () => {
    const { wrapper, api, errors } = await mountWizard();
    api.importApply = async () => { throw new Error("项目已存在: 导入示例项目"); };
    await pickFile(wrapper, "sample.yaml", "x");
    await wrapper.find('[data-testid="import-group-input"]').setValue("g");
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("项目已存在");
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(false);
  });

  it("无法识别的格式：留在第一步并展示错误（不推进向导）", async () => {
    const { wrapper, api } = await mountWizard();
    api.importPreview = async () => { throw new Error("无法识别的导入格式"); };
    await pickFile(wrapper, "unknown.txt", "随便什么内容");
    expect(wrapper.find('[data-testid="import-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-error"]').text()).toContain("无法识别的导入格式");
    expect(wrapper.find('[data-testid="import-group-input"]').exists()).toBe(false);
  });
});
