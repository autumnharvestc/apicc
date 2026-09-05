// @vitest-environment jsdom
// M7-B 任务 1：插件管理视图（只读，规格 §2 D3/D5）——清单表格（名称/版本/贡献分类 tag）
// + 失败项红 tag 与原因列（裁定②）+ 空清单空态指引 docs/plugins.md（裁定③）+ 刷新。
import { describe, expect, it, beforeAll } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { createPluginsStore } from "../../../src/renderer/src/stores/plugins.js";
import PluginsView from "../../../src/renderer/src/components/PluginsView.vue";

beforeAll(() => {
  // jsdom 未实现 matchMedia；antd 组件（响应式断点）挂载需要。
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
  // 固定语言为 zh-CN，使文案断言与语言文件一致。
  localStorage.setItem("apicc.locale", "zh-CN");
});

/** 显式装配辅助（组合根约定的测试形态）：store 一次性创建，经 props 注入被测组件。 */
async function mountView(api = createMemoryApi()) {
  const plugins = createPluginsStore({ api });
  await plugins.init();
  const { i18n } = createI18nInstance();
  const wrapper = mount(PluginsView, {
    props: { plugins },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, plugins, api };
}

describe("PluginsView（M7-B 任务 1）", () => {
  it("渲染已加载插件行：名称/版本/贡献分类 tag（分类 + 计数 + 名称）", async () => {
    const { wrapper } = await mountView();
    expect(wrapper.find('[data-testid="plugins-view"]').exists()).toBe(true);
    const rows = wrapper.findAll('[data-testid="plugins-row"]');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const loadedRow = rows.find((r) => r.find('[data-testid="plugins-kind"][data-kind="loaded"]').exists())!;
    expect(loadedRow.text()).toContain("apicc-plugin-example");
    expect(loadedRow.text()).toContain("1.0.0");
    // 贡献分类 tag：分类名 + 计数 + 贡献名称明细
    const tagText = loadedRow
      .findAll('[data-testid="plugins-contrib-tag"]')
      .map((t) => t.text())
      .join("|");
    expect(tagText).toContain("报告");
    expect(tagText).toContain("example-md");
    expect(tagText).toContain("导入器");
    expect(tagText).toContain("example-csv");
  });

  it("失败项：失败红 tag（data-kind=failed）+ 原因列展示 error（裁定②）", async () => {
    const { wrapper } = await mountView();
    const failedRow = wrapper
      .findAll('[data-testid="plugins-row"]')
      .find((r) => r.find('[data-testid="plugins-kind"][data-kind="failed"]').exists())!;
    expect(failedRow).toBeDefined();
    // 行级红标钩子 + 原因列非空
    expect(failedRow.attributes("data-failed")).toBe("true");
    expect(failedRow.find('[data-testid="plugins-error"]').text().length).toBeGreaterThan(0);
  });

  it("空清单：空态指引指向 docs/plugins.md，不渲染表格（裁定③）", async () => {
    const api = createMemoryApi();
    api.pluginsList = async () => ({ plugins: [], importers: [] });
    const { wrapper } = await mountView(api);
    expect(wrapper.find('[data-testid="plugins-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="plugins-empty"]').text()).toContain("docs/plugins.md");
    expect(wrapper.find('[data-testid="plugins-table"]').exists()).toBe(false);
  });

  it("刷新按钮：重拉清单覆盖状态（诊断链路）", async () => {
    const { wrapper, plugins, api } = await mountView();
    api.pluginsList = async () => ({ plugins: [], importers: [] });
    await wrapper.find('[data-testid="plugins-refresh"]').trigger("click");
    await flushPromises();
    expect(plugins.entries).toEqual([]);
  });
});
