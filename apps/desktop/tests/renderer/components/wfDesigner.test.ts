// @vitest-environment jsdom
// 工作流设计器视图装配测试（M2-B 任务 4）。Vue Flow 在 jsdom 渲染受限（显式授权的
// 适配自由度）：断言以 store 缓冲 + data-testid 包裹层 + wfCanvas/wfBindings 数据层
// 为准——节点/边选中经 VueFlow 真实事件冒泡（jsdom 下可触发），画布拖拽无法模拟，
// position 写回的数据层语义在 wfCanvas.test.ts 锁定。组件内不加测试后门。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useWfListStore } from "../../../src/renderer/src/stores/wfList.js";
import { useWorkflowDesignStore } from "../../../src/renderer/src/stores/workflowDesign.js";
import { buildBindIndex, type WfBindIndex } from "../../../src/renderer/src/wf/wfBindings.js";
import { applyEdgeAdd, applyNodeUpdate } from "../../../src/renderer/src/wf/wfCanvas.js";
import type { WorkflowNode } from "@apicc/core";
import WfDesigner from "../../../src/renderer/src/components/WfDesigner.vue";
import WfPropertyPanel from "../../../src/renderer/src/components/WfPropertyPanel.vue";

beforeAll(() => {
  // jsdom 未实现的能力（antd 响应式断点 / Vue Flow 尺寸与矩阵运算）按既有先例打桩。
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
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = class {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? +scale : 1;
    }
  };
  localStorage.setItem("apicc.locale", "zh-CN");
});

enableAutoUnmount(afterEach);

/** 显式装配辅助（组合根约定的测试形态）：memory 种子 → 各 store 一次创建 → props 注入。 */
async function mountDesigner() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const project = workspace.tree!.children![0]!.children![0]!;
  const wfList = useWfListStore(api);
  await wfList.load(project.id);
  const workflowDesign = useWorkflowDesignStore(api);
  const bindIndex: WfBindIndex = await buildBindIndex(workspace.tree, project.id, (id) => api.apiGet(id));
  const errors: unknown[] = [];
  const { i18n } = createI18nInstance();
  const wrapper = mount(WfDesigner, {
    props: {
      workflowDesign,
      wfList,
      workspace,
      projectId: project.id,
      bindIndex,
      reportError: (e: unknown) => errors.push(e),
    },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, wfList, design: workflowDesign, bindIndex, errors, projectId: project.id };
}

/** 选中画布第 index 个节点（点击 WfNode 根元素，冒泡进 VueFlow nodeClick）。 */
async function selectNode(wrapper: ReturnType<typeof mount>, index: number) {
  await wrapper.findAll('[data-testid="wf-node"]')[index]!.trigger("click");
  await nextTick();
}

describe("WfDesigner 装配", () => {
  it("未选工作流 → 空态 + 工作流列表入口；无 wf-canvas", async () => {
    const { wrapper, wfList } = await mountDesigner();
    await wfList.create("已有流程"); // 列表应含已有工作流
    await flushPromises();
    expect(wrapper.find('[data-testid="wf-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="wf-canvas"]').exists()).toBe(false);
    expect(
      wrapper.findAll('[data-testid="wf-list-item"]').some((n) => n.text().includes("已有流程")),
    ).toBe(true);
  });

  it("列表点击 → load 后画布容器渲染；空流显示画布空态提示", async () => {
    const { wrapper, wfList, design } = await mountDesigner();
    const created = await wfList.create("下单流程");
    await flushPromises();
    await wrapper.findAll('[data-testid="wf-list-item"]')
      .find((n) => n.text().includes("下单流程"))!
      .trigger("click");
    await flushPromises();
    expect(design.workflowId).toBe(created.id);
    expect(design.dirty).toBe(false);
    expect(wrapper.find('[data-testid="wf-canvas"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="wf-empty"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="wf-canvas-empty"]').exists()).toBe(true); // 0 节点
  });

  it("新建表单 → wfCreate + 设计器 load（画布容器渲染）", async () => {
    const { wrapper, design } = await mountDesigner();
    await wrapper.find('[data-testid="wf-new-name"]').setValue("冒烟流");
    await wrapper.find('[data-testid="wf-new-create"]').trigger("click");
    await flushPromises();
    expect(design.workflow?.name).toBe("冒烟流");
    expect(design.workflow?.status).toBe("draft");
    expect(wrapper.find('[data-testid="wf-canvas"]').exists()).toBe(true);
  });

  it("添加请求/占位节点 → store 缓冲增长且置 dirty；画布节点 DOM 同步", async () => {
    const { wrapper, design } = await mountDesigner();
    await wrapper.props("wfList").create("流");
    await wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-testid="wf-node"]')).toHaveLength(0);

    await wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await wrapper.find('[data-testid="wf-add-noop"]').trigger("click");
    await nextTick();
    expect(design.workflow!.nodes).toHaveLength(2);
    expect(design.workflow!.nodes[0]!.kind).toBe("request");
    expect(design.workflow!.nodes[1]!.kind).toBe("noop");
    expect(design.dirty).toBe(true);
    // 画布 DOM 以 wfCanvas 变换输出为准：节点数与缓冲一致
    expect(wrapper.findAll('[data-testid="wf-node"]')).toHaveLength(2);
  });

  it("画布数据契约：request 节点 data 预注入 apiName/caseName（渲染可见）", async () => {
    const { wrapper, design, bindIndex } = await mountDesigner();
    await wrapper.props("wfList").create("流");
    await wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await flushPromises();
    // 模拟属性面板改绑：经 applyNodeUpdate 写缓冲（panel→designer 事件链路在下一用例断言）
    const apiId = [...bindIndex.apiIds][0]!;
    const caseId = [...bindIndex.caseNames.keys()][0]!;
    design.update(applyNodeUpdate(design.workflow!, design.workflow!.nodes[0]!.id, { apiId, caseId }));
    await nextTick();
    const nodeText = wrapper.findAll('[data-testid="wf-node"]')[0]!.text();
    expect(nodeText).toContain("示例接口"); // apiName 预注入（memory 种子）
    expect(nodeText).toContain("冒烟"); // caseName 预注入
  });

  it("选中节点 → 属性面板 label 编辑写回缓冲并置 dirty", async () => {
    const { wrapper, design } = await mountDesigner();
    await wrapper.props("wfList").create("流");
    await wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="wf-panel-node"]').exists()).toBe(false);

    await selectNode(wrapper, 0);
    expect(wrapper.find('[data-testid="wf-panel-node"]').exists()).toBe(true);
    const label = wrapper.find('[data-testid="wf-node-label"]');
    expect((label.element as HTMLInputElement).value).toBe(design.workflow!.nodes[0]!.label);
    await label.setValue("登录节点");
    expect(design.workflow!.nodes[0]!.label).toBe("登录节点");
    expect(design.dirty).toBe(true);
  });

  it("属性面板改绑/置空过占位事件 → 缓冲写回（级联数据来自 memory 种子）", async () => {
    const { wrapper, design, bindIndex } = await mountDesigner();
    await wrapper.props("wfList").create("流");
    await wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await flushPromises();
    // 级联 options 契约：集合→接口→用例 来自 memory 种子
    const panel = wrapper.findComponent(WfPropertyPanel);
    expect(panel.props("bindOptions")).toEqual(bindIndex.options);

    await selectNode(wrapper, 0);
    const apiId = [...bindIndex.apiIds][0]!;
    const caseId = [...bindIndex.caseNames.keys()][0]!;
    wrapper.findComponent(WfPropertyPanel).vm.$emit("node-change", { apiId, caseId } as Partial<WorkflowNode>);
    await nextTick();
    expect(design.workflow!.nodes[0]).toMatchObject({ apiId, caseId });
    expect(design.dirty).toBe(true);

    // 空过占位切换：noop 化不改绑（切回 request 保留）
    wrapper.findComponent(WfPropertyPanel).vm.$emit("node-change", { kind: "noop" });
    await nextTick();
    expect(design.workflow!.nodes[0]!.kind).toBe("noop");
    expect(design.workflow!.nodes[0]!.apiId).toBe(apiId);
  });

  it("missing 红框：未绑定/引用不在项目内 → missing class；改绑后消失", async () => {
    const { wrapper, design, bindIndex } = await mountDesigner();
    await wrapper.props("wfList").create("流");
    await wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await flushPromises();
    // 新增未绑定 request 节点：apiId 不在项目接口集合 → missing
    expect(wrapper.find('[data-testid="wf-node"].wf-node-missing').exists()).toBe(true);
    const apiId = [...bindIndex.apiIds][0]!;
    design.update(applyNodeUpdate(design.workflow!, design.workflow!.nodes[0]!.id, { apiId }));
    await nextTick();
    expect(wrapper.find('[data-testid="wf-node"].wf-node-missing').exists()).toBe(false);
  });

  it("删除选中节点 → 缓冲节点与关联边级联减少", async () => {
    const { wrapper, design } = await mountDesigner();
    await wrapper.props("wfList").create("流");
    await wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await wrapper.find('[data-testid="wf-add-noop"]').trigger("click");
    await flushPromises();
    const ids = design.workflow!.nodes.map((n) => n.id);
    design.update(applyEdgeAdd(design.workflow!, { source: ids[0]!, target: ids[1]! }));
    await nextTick();
    expect(design.workflow!.edges).toHaveLength(1);

    await selectNode(wrapper, 0);
    await wrapper.find('[data-testid="wf-node-delete"]').trigger("click");
    await nextTick();
    expect(design.workflow!.nodes).toHaveLength(1);
    expect(design.workflow!.edges).toHaveLength(0); // 级联删边
    expect(design.dirty).toBe(true);
    expect(wrapper.find('[data-testid="wf-panel-node"]').exists()).toBe(false); // 选中态清空
  });

  it("保存按钮 → api.wfSave 被调、dirty 复位；拒绝时经 reportError 上报", async () => {
    const { wrapper, api, design } = await mountDesigner();
    await wrapper.props("wfList").create("流");
    await wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await flushPromises();
    expect(design.dirty).toBe(true);

    const calls: unknown[][] = [];
    const original = api.wfSave.bind(api);
    api.wfSave = async (wf) => { calls.push([wf]); return original(wf); };
    await wrapper.find('[data-testid="wf-save"]').trigger("click");
    await flushPromises();
    expect(calls).toHaveLength(1);
    expect(design.dirty).toBe(false);

    // 保存链路拒绝 → reportError（不静默吞没）
    const errors2: unknown[] = [];
    api.wfSave = async () => { throw new Error("落盘失败（测试注入）"); };
    await wrapper.setProps({ reportError: (e: unknown) => errors2.push(e) });
    await wrapper.find('[data-testid="wf-save"]').trigger("click");
    await flushPromises();
    expect(errors2).toHaveLength(1);
    expect((errors2[0] as Error).message).toBe("落盘失败（测试注入）");
  });

  it("选中边 → 条件 textarea 显示既有值，修改写回缓冲并置 dirty", async () => {
    const { wrapper, design } = await mountDesigner();
    await wrapper.props("wfList").create("流");
    await wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await wrapper.find('[data-testid="wf-add-noop"]').trigger("click");
    await flushPromises();
    const ids = design.workflow!.nodes.map((n) => n.id);
    design.update(applyEdgeAdd(design.workflow!, { source: ids[0]!, target: ids[1]!, condition: "prev.passed" }));
    await nextTick();

    await wrapper.find('.vue-flow__edge').trigger("click");
    await nextTick();
    expect(wrapper.find('[data-testid="wf-panel-edge"]').exists()).toBe(true);
    const cond = wrapper.find('[data-testid="wf-edge-condition"]');
    expect((cond.element as HTMLTextAreaElement).value).toBe("prev.passed");
    await cond.setValue("vars.ok === true");
    expect(design.workflow!.edges[0]!.condition).toBe("vars.ok === true");
    expect(design.dirty).toBe(true);
  });
});
