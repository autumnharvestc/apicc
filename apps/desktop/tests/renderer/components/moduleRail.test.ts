// @vitest-environment jsdom
// M8 布局层级改造新增组件测试：ModuleRail（图标导航栏）与 SideTree 搜索过滤。
// 装配约定同 components.test.ts：store 经 props 注入、组件内不调工厂；
// jsdom 需要 matchMedia stub（antd 响应式断点）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useTreeStore } from "../../../src/renderer/src/stores/tree.js";
import { useWorkflowDesignStore } from "../../../src/renderer/src/stores/workflowDesign.js";
import ModuleRail from "../../../src/renderer/src/components/ModuleRail.vue";
import SideTree from "../../../src/renderer/src/components/SideTree.vue";

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

function mountRail(view: string, gate: { workspaceOpened: boolean; onlineActive: boolean; apiSelected: boolean }) {
  const { i18n } = createI18nInstance();
  return mount(ModuleRail, {
    props: { view: view as never, gate },
    global: { plugins: [i18n] },
  });
}

describe("ModuleRail（M8 图标导航栏）", () => {
  it("渲染 7 个模块按钮，顺序与 SWITCH_VIEWS 一致，含语言标签", () => {
    const wrapper = mountRail("api", { workspaceOpened: true, onlineActive: false, apiSelected: false });
    const items = wrapper.findAll("button.rail-item").map((b) => b.attributes("data-testid"));
    expect(items).toEqual([
      "rail-home", "rail-api", "rail-run", "rail-wf", "rail-stress", "rail-envs", "rail-import",
    ]);
    expect(wrapper.find('[data-testid="rail-home"]').text()).toContain("主页");
    expect(wrapper.find('[data-testid="rail-api"]').text()).toContain("接口");
    expect(wrapper.find('[data-testid="rail-run"]').text()).toContain("运行");
  });

  it("选中模块带 active 类；点击向父组件发 update:view", async () => {
    const wrapper = mountRail("run", { workspaceOpened: true, onlineActive: false, apiSelected: false });
    expect(wrapper.find('[data-testid="rail-run"]').classes()).toContain("active");
    expect(wrapper.find('[data-testid="rail-api"]').classes()).not.toContain("active");
    await wrapper.find('[data-testid="rail-home"]').trigger("click");
    expect(wrapper.emitted("update:view")![0]).toEqual(["home"]);
  });

  it("门控：未打开工作区时工作区级模块禁用、主页恒可用；在线除主页外全禁用", () => {
    const closed = mountRail("api", { workspaceOpened: false, onlineActive: false, apiSelected: false });
    expect(closed.find('[data-testid="rail-run"]').attributes("disabled")).toBeDefined();
    expect(closed.find('[data-testid="rail-home"]').attributes("disabled")).toBeUndefined();
    const online = mountRail("api", { workspaceOpened: true, onlineActive: true, apiSelected: true });
    for (const v of ["api", "run", "wf", "stress", "envs", "import"]) {
      expect(online.find(`[data-testid="rail-${v}"]`).attributes("disabled")).toBeDefined();
    }
    expect(online.find('[data-testid="rail-home"]').attributes("disabled")).toBeUndefined();
  });
});

describe("SideTree 搜索过滤（M8）", () => {
  /** 种子工作区（示例分组>示例项目>示例集合>示例接口）+ 显式 filter prop 挂载侧树。 */
  async function mountTree(filter: string) {
    const api = createMemoryApi();
    api.seedWorkspace();
    const workspace = useWorkspaceStore(api);
    await workspace.open("/tmp/ws");
    const tree = useTreeStore(api, workspace);
    const workflowDesign = useWorkflowDesignStore(api);
    const { i18n } = createI18nInstance();
    const wrapper = mount(SideTree, {
      props: {
        api, workspace, tree, workflowDesign, filter,
        reportError: () => {},
      },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    return wrapper;
  }

  it("命中叶子（「接口」）：命中项与其祖先链保留", async () => {
    const wrapper = await mountTree("接口");
    // 种子仅一个接口叶（示例接口）：命中后整条祖先链可见
    expect(wrapper.findAll('[data-testid="tree-api"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("示例接口");
  });

  it("命中容器（「分组」）：自身命中保留完整子树", async () => {
    const wrapper = await mountTree("分组");
    expect(wrapper.findAll('[data-testid="tree-api"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("示例集合");
  });

  it("无命中：渲染无匹配空态", async () => {
    const wrapper = await mountTree("不存在的节点");
    expect(wrapper.text()).toContain("无匹配节点");
  });

  it("空白过滤词：不过滤（展开容器后全部可见）", async () => {
    const wrapper = await mountTree("  ");
    // 无过滤时不自动展开（保持既有折叠语义）：先点根层折叠钮展开后代容器
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    expect(wrapper.findAll('[data-testid="tree-api"]')).toHaveLength(1);
    expect(wrapper.text()).not.toContain("无匹配节点");
  });
});
