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
import { createPluginsStore } from "../../../src/renderer/src/stores/plugins.js";
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

/** 显式装配辅助（组合根约定的测试形态）：store 一次性创建，经 props 注入被测组件。
 *  apiOverride 供用例预配置替身（如 pluginsList 注入失败）后再装配。 */
async function mountWizard(props: Record<string, unknown> = {}, apiOverride?: ReturnType<typeof createMemoryApi>) {
  const errors: unknown[] = [];
  const api = apiOverride ?? createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const importW = useImportWizardStore(api, workspace);
  // M7-B 任务 1：导入格式清单改走 plugins store 动态枚举（IPC plugins:list 出口），
  // 组合根一次性创建后经 props 下传（组件内零工厂调用）。
  const plugins = createPluginsStore({ api });
  await plugins.init();
  const { i18n } = createI18nInstance();
  const wrapper = mount(ImportWizard, {
    props: { mode: "project", importW, plugins, reportError: (e: unknown) => { errors.push(e); }, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, importW, plugins, errors };
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
  it("project 模式三步推进：选文件进预览 → 选分组/项目名导入 → 完成态（整包落库、树已刷新）", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const seeded = await api.treeGet();
    const gId = seeded.children![0]!.id; // 示例分组（种子）
    const { wrapper, workspace, importW } = await mountWizard({
      mode: "project",
      groups: [{ id: gId, label: "示例分组" }],
      defaultGroupId: gId,
    }, api);
    // 第一步：只有文件选择，没有落点表单
    expect(wrapper.find('[data-testid="import-file-input"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-name-input"]').exists()).toBe(false);
    await pickFile(wrapper, "sample.yaml", "openapi: 3.0.0");
    // 第二步：预览树 + 警告 + 分组下拉（预选默认分组）+ 项目名（预填 title）
    expect(wrapper.find('[data-testid="import-preview-tree"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-warnings"]').text()).toContain("示例警告");
    expect(wrapper.find('[data-testid="import-group-select"]').exists()).toBe(true);
    expect((wrapper.find('[data-testid="import-name-input"]').element as HTMLInputElement).value).toBe("导入示例项目");
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    await flushPromises();
    // 第三步：完成态；apply 记录 project 模式调用、树已刷新出导入项目
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(true);
    expect(api.importApplyCalls).toEqual([{ mode: "project", groupId: gId, name: "导入示例项目" }]);
    const groupNode = workspace.tree!.children!.find((n) => n.id === gId);
    expect(groupNode!.children!.map((n) => n.label)).toContain("导入示例项目");
    expect(importW.applying).toBe(false);
  });

  it("project 模式无可用分组时导入按钮禁用（防无落点提交）", async () => {
    const { wrapper } = await mountWizard({ mode: "project", groups: [], defaultGroupId: null });
    await pickFile(wrapper, "sample.yaml", "x");
    expect(wrapper.find('[data-testid="import-apply"]').attributes("disabled")).toBeDefined();
  });

  it("module 模式：无落点选择，仅模块名（预填 title），并入目标项目", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const seeded = await api.treeGet();
    const pId = seeded.children![0]!.children![0]!.id; // 示例项目（种子）
    const { wrapper, workspace } = await mountWizard({ mode: "module", targetProjectId: pId }, api);
    await pickFile(wrapper, "sample.yaml", "openapi: 3.0.0");
    // module 模式不出现分组下拉
    expect(wrapper.find('[data-testid="import-group-select"]').exists()).toBe(false);
    expect((wrapper.find('[data-testid="import-name-input"]').element as HTMLInputElement).value).toBe("导入示例项目");
    await wrapper.find('[data-testid="import-name-input"]').setValue("并入模块");
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(true);
    expect(api.importApplyCalls).toEqual([{ mode: "module", projectId: pId, name: "并入模块" }]);
    const projectNode = workspace.tree!.children!.flatMap((g) => g.children!).find((p) => p.label === "示例项目");
    expect(projectNode!.children!.map((c) => c.label)).toContain("并入模块");
  });

  it("取消：清空 preview 并向组合根发 close 事件", async () => {
    const { wrapper, importW } = await mountWizard({ mode: "project", groups: [{ id: "g", label: "g" }] });
    await pickFile(wrapper, "sample.yaml", "x");
    expect(importW.preview).not.toBeNull();
    await wrapper.find('[data-testid="import-cancel"]').trigger("click");
    await flushPromises();
    expect(importW.preview).toBeNull();
    expect(wrapper.emitted("close")).toHaveLength(1);
    // 回到第一步：落点表单不再展示
    expect(wrapper.find('[data-testid="import-name-input"]').exists()).toBe(false);
  });

  it("完成态点完成后关闭向导（close 事件 + 回到第一步）", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const seeded = await api.treeGet();
    const gId = seeded.children![0]!.id;
    const { wrapper } = await mountWizard({
      mode: "project",
      groups: [{ id: gId, label: "示例分组" }],
      defaultGroupId: gId,
    }, api);
    await pickFile(wrapper, "sample.yaml", "x");
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="import-finish"]').trigger("click");
    await flushPromises();
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(false);
  });

  it("apply 拒绝时经 reportError 上报且不进入完成态（可修改后重试）", async () => {
    const { wrapper, api, errors } = await mountWizard({
      mode: "project",
      groups: [{ id: "g", label: "g" }],
      defaultGroupId: "g",
    });
    api.importApply = async () => { throw new Error("落库失败（注入）"); };
    await pickFile(wrapper, "sample.yaml", "x");
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("落库失败");
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(false);
  });

  it("无法识别的格式：留在第一步并展示错误（不推进向导）", async () => {
    const { wrapper, api } = await mountWizard({ mode: "project", groups: [{ id: "g", label: "g" }] });
    api.importPreview = async () => { throw new Error("无法识别的导入格式"); };
    await pickFile(wrapper, "unknown.txt", "随便什么内容");
    expect(wrapper.find('[data-testid="import-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-error"]').text()).toContain("无法识别的导入格式");
    expect(wrapper.find('[data-testid="import-name-input"]').exists()).toBe(false);
  });

  // M7-B 任务 1（规格 §2 D5）：导入格式清单改走 IPC 动态枚举——清单来自 plugins:list
  // 出口的 importers（内置 registry + 插件贡献），向导内零硬编码格式名。
  it("第一步展示动态枚举的导入格式：内置 + 插件贡献各一（来自 plugins:list）", async () => {
    const { wrapper } = await mountWizard({ mode: "project", groups: [{ id: "g", label: "g" }] });
    const formats = wrapper.findAll('[data-testid="import-format"]');
    const names = formats.map((f) => f.text());
    // 内置 registry 导入器
    expect(names).toContain("collection-v21");
    expect(names).toContain("openapi");
    // 插件贡献导入器（fixture：apicc-plugin-example 贡献）
    expect(names).toContain("example-csv");
  });

  it("plugins:list 拉取失败：格式清单空但不阻断文件选择链路", async () => {
    const api = createMemoryApi();
    api.pluginsList = async () => { throw new Error("清单不可用"); };
    const { wrapper } = await mountWizard({ mode: "project", groups: [{ id: "g", label: "g" }] }, api);
    expect(wrapper.findAll('[data-testid="import-format"]').length).toBe(0);
    expect(wrapper.find('[data-testid="import-file-button"]').exists()).toBe(true);
  });
});
