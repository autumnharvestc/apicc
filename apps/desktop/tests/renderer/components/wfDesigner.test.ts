// @vitest-environment jsdom
// 工作流设计器视图装配测试（M2-B 任务 4）。Vue Flow 在 jsdom 渲染受限（显式授权的
// 适配自由度）：断言以 store 缓冲 + data-testid 包裹层 + wfCanvas/wfBindings 数据层
// 为准——节点/边选中经 VueFlow 真实事件冒泡（jsdom 下可触发），画布拖拽无法模拟，
// position 写回的数据层语义在 wfCanvas.test.ts 锁定。组件内不加测试后门。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useWfListStore } from "../../../src/renderer/src/stores/wfList.js";
import { useWorkflowDesignStore } from "../../../src/renderer/src/stores/workflowDesign.js";
import { buildBindIndex, type WfBindIndex, type BindOption } from "../../../src/renderer/src/wf/wfBindings.js";
import type { WfNodeData } from "../../../src/renderer/src/wf/wfCanvas.js";
import { applyEdgeAdd, applyNodeUpdate } from "../../../src/renderer/src/wf/wfCanvas.js";
import type { WorkflowNode } from "@apicc/core";
import WfDesigner from "../../../src/renderer/src/components/WfDesigner.vue";
import WfPropertyPanel from "../../../src/renderer/src/components/WfPropertyPanel.vue";
import { Cascader as ACascader } from "ant-design-vue";

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

/** Modal 传送门渲染于 document.body：body 作用域点击（先例同 components.test.ts expectBody）。 */
async function bodyClick(testid: string) {
  const el = document.body.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`body 中找不到 [data-testid="${testid}"]`);
  await new DOMWrapper(el).trigger("click");
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
// —— 审查修复 3：设计器入口持续导航（返回列表 + 换项目卸载，dirty 走确认） ——
describe("WfDesigner 离开与切项目", () => {
  /** 载入一条工作流后的上下文（画布渲染中）。 */
  async function mountWithFlow() {
    const ctx = await mountDesigner();
    await ctx.wrapper.props("wfList").create("流程甲");
    await ctx.wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await flushPromises();
    expect(ctx.design.workflow).not.toBeNull();
    return ctx;
  }

  /** 追加第二个项目并刷新树，返回其节点。 */
  async function addProjectB(ctx: Awaited<ReturnType<typeof mountDesigner>>) {
    const groupNode = ctx.workspace.tree!.children![0]!;
    await ctx.api.nodeCreate({ kind: "project", parentId: groupNode.id, name: "项目B" });
    await ctx.workspace.refresh();
    return ctx.workspace.tree!.children![0]!.children!.find((p) => p.label === "项目B")!;
  }

  it("返回列表：非 dirty 直接卸载回空态；列表仍可见", async () => {
    const { wrapper, design } = await mountWithFlow();
    await wrapper.find('[data-testid="wf-back-to-list"]').trigger("click");
    await flushPromises();
    expect(design.workflow).toBeNull();
    expect(design.dirty).toBe(false);
    expect(wrapper.find('[data-testid="wf-empty"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="wf-list-item"]').length).toBe(1);
  });

  it("切换项目 → 非 dirty 卸载旧项目工作流回空态", async () => {
    const ctx = await mountWithFlow();
    const projectB = await addProjectB(ctx);
    await ctx.wrapper.setProps({ projectId: projectB.id });
    await flushPromises();
    expect(ctx.design.workflow).toBeNull();
    expect(ctx.wrapper.find('[data-testid="wf-empty"]').exists()).toBe(true);
  });

  it("切换项目遇 dirty → 确认对话框：取消保留，确认丢弃", async () => {
    const ctx = await mountWithFlow();
    const projectB = await addProjectB(ctx);
    await ctx.wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    expect(ctx.design.dirty).toBe(true);

    await ctx.wrapper.setProps({ projectId: projectB.id });
    await flushPromises();
    // 确认框出现（antd Modal 传送门渲染于 body；confirm-dialog testid 不透传，
    // 以 dialog-confirm 为存在性钩子——先例同 components.test.ts expectBody），缓冲未动
    expect(document.body.querySelector('[data-testid="dialog-confirm"]')).not.toBeNull();
    expect(ctx.design.workflow).not.toBeNull();

    // 取消 → 保留缓冲与画布
    await bodyClick("dialog-cancel");
    await flushPromises();
    expect(document.body.querySelector('[data-testid="dialog-confirm"]')).toBeNull();
    expect(ctx.design.workflow).not.toBeNull();

    // 再次切换 → 确认 → 卸载回空态
    await ctx.wrapper.setProps({ projectId: null });
    await flushPromises();
    await bodyClick("dialog-confirm");
    await flushPromises();
    expect(ctx.design.workflow).toBeNull();
    expect(ctx.wrapper.find('[data-testid="wf-empty"]').exists()).toBe(true);
  });
});

// —— M2-B 任务 5：生命周期按钮组（禁用矩阵随 status/dirty）+ 启用校验错误列表 + 运行门控 ——
describe("WfDesigner 生命周期与校验错误", () => {
  /** 载入一条新建工作流后的上下文（画布渲染中，status=draft）。 */
  async function mountWithFlow(name = "流程甲") {
    const ctx = await mountDesigner();
    await ctx.wrapper.props("wfList").create(name);
    await ctx.wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await flushPromises();
    expect(ctx.design.workflow).not.toBeNull();
    return ctx;
  }

  /** 经顶栏按钮推进生命周期（点击后 flush），返回设计器缓冲工作流。 */
  async function clickStatus(ctx: Awaited<ReturnType<typeof mountWithFlow>>, testid: string) {
    await ctx.wrapper.find(`[data-testid="${testid}"]`).trigger("click");
    await flushPromises();
  }

  function lifecycleButtons(ctx: Awaited<ReturnType<typeof mountWithFlow>>) {
    return {
      publish: ctx.wrapper.find('[data-testid="wf-publish"]'),
      enable: ctx.wrapper.find('[data-testid="wf-enable"]'),
      retract: ctx.wrapper.find('[data-testid="wf-retract"]'),
      run: ctx.wrapper.find('[data-testid="wf-run"]'),
    };
  }

  it("draft → 发布可用，启用/解除启用禁用；运行禁用并提示先发布", async () => {
    const ctx = await mountWithFlow();
    const btns = lifecycleButtons(ctx);
    expect(btns.publish.attributes("disabled")).toBeUndefined();
    expect(btns.enable.attributes("disabled")).toBeDefined();
    expect(btns.retract.attributes("disabled")).toBeDefined();
    expect(btns.run.attributes("disabled")).toBeDefined();
    expect(btns.run.attributes("title")).toBe("工作流为草稿，请先发布启用");
  });

  it("发布成功 → wfSetStatus(id, published)，状态 Tag 翻转，按钮矩阵随行", async () => {
    const ctx = await mountWithFlow();
    const calls: unknown[][] = [];
    const original = ctx.api.wfSetStatus.bind(ctx.api);
    ctx.api.wfSetStatus = async (id, next) => { calls.push([id, next]); return original(id, next); };

    await clickStatus(ctx, "wf-publish");
    expect(calls).toStrictEqual([[ctx.design.workflowId, "published"]]);
    expect(ctx.design.workflow!.status).toBe("published");
    expect(ctx.wrapper.find('[data-testid="wf-status"]').text()).toContain("已发布");
    const btns = lifecycleButtons(ctx);
    expect(btns.publish.attributes("disabled")).toBeDefined();
    expect(btns.enable.attributes("disabled")).toBeUndefined();
    expect(btns.retract.attributes("disabled")).toBeDefined();
    expect(btns.run.attributes("disabled")).toBeUndefined(); // 非 draft 即可运行
  });

  it("dirty → 三个生命周期按钮全部禁用并提示先保存（published 态的启用钮被 dirty 阻断）", async () => {
    const ctx = await mountWithFlow();
    // 先落盘发布（clean published），再加节点制造 dirty：此时状态本允许「启用」
    await ctx.wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await ctx.wrapper.find('[data-testid="wf-save"]').trigger("click");
    await flushPromises();
    await clickStatus(ctx, "wf-publish");
    expect(ctx.design.dirty).toBe(false);

    await ctx.wrapper.find('[data-testid="wf-add-noop"]').trigger("click");
    expect(ctx.design.dirty).toBe(true);
    const btns = lifecycleButtons(ctx);
    for (const key of ["publish", "enable", "retract"] as const) {
      expect(btns[key].attributes("disabled")).toBeDefined();
      expect(btns[key].attributes("title")).toBe("请先保存");
    }
  });

  it("启用校验失败 → wf-errors 逐条展示错误且状态不变；关闭后收起", async () => {
    const ctx = await mountWithFlow("流程乙");
    // 未绑定接口/用例的请求节点：启用校验必出「缺少接口/用例引用」错误
    await ctx.wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await ctx.wrapper.find('[data-testid="wf-save"]').trigger("click");
    await flushPromises();
    await clickStatus(ctx, "wf-publish");
    expect(ctx.wrapper.find('[data-testid="wf-errors"]').exists()).toBe(false);

    await clickStatus(ctx, "wf-enable");
    expect(ctx.design.validationErrors.length).toBeGreaterThan(0);
    const alert = ctx.wrapper.find('[data-testid="wf-errors"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain("缺少接口/用例引用");
    expect(ctx.wrapper.findAll('[data-testid="wf-error-item"]')).toHaveLength(ctx.design.validationErrors.length);
    expect(ctx.design.workflow!.status).toBe("published"); // API 层保证状态不变
    expect(ctx.wrapper.find('[data-testid="wf-status"]').text()).toContain("已发布");

    await ctx.wrapper.find('[data-testid="wf-errors-close"]').trigger("click");
    await flushPromises();
    expect(ctx.design.validationErrors).toHaveLength(0);
    expect(ctx.wrapper.find('[data-testid="wf-errors"]').exists()).toBe(false);
  });

  it("绑定节点的工作流发布→启用成功→解除启用 → Tag 依次 已发布/已启用/已发布", async () => {
    const ctx = await mountWithFlow("流程丙");
    // 一个绑定种子接口/用例的请求节点：满足启用校验（不依赖「0 节点可启用」的旧语义）
    await ctx.wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    ctx.design.update(applyNodeUpdate(ctx.design.workflow!, ctx.design.workflow!.nodes[0]!.id, {
      apiId: [...ctx.bindIndex.apiIds][0]!,
      caseId: [...ctx.bindIndex.caseNames.keys()][0]!,
    }));
    await ctx.wrapper.find('[data-testid="wf-save"]').trigger("click");
    await flushPromises();

    await clickStatus(ctx, "wf-publish");
    await clickStatus(ctx, "wf-enable");
    expect(ctx.design.workflow!.status).toBe("enabled");
    expect(ctx.wrapper.find('[data-testid="wf-status"]').text()).toContain("已启用");
    const enabled = lifecycleButtons(ctx);
    expect(enabled.retract.attributes("disabled")).toBeUndefined();
    expect(enabled.enable.attributes("disabled")).toBeDefined();

    await clickStatus(ctx, "wf-retract");
    expect(ctx.design.workflow!.status).toBe("published");
    expect(ctx.wrapper.find('[data-testid="wf-status"]').text()).toContain("已发布");
    const retracted = lifecycleButtons(ctx);
    expect(retracted.enable.attributes("disabled")).toBeUndefined();
    expect(retracted.retract.attributes("disabled")).toBeDefined();
  });

  it("空工作流（0 节点）启用被拒 → wf-errors 含「没有任何节点」且状态不变（规格 §5 第 5 条）", async () => {
    const ctx = await mountWithFlow("空流程");
    await clickStatus(ctx, "wf-publish");
    await clickStatus(ctx, "wf-enable");
    expect(ctx.design.workflow!.status).toBe("published"); // API 层保证状态不变
    expect(ctx.wrapper.find('[data-testid="wf-status"]').text()).toContain("已发布");
    expect(ctx.design.validationErrors.some((e) => /没有任何节点/.test(e))).toBe(true);
    const alert = ctx.wrapper.find('[data-testid="wf-errors"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain("没有任何节点");
  });

  it("启用失败 → 修复绑定 → 再启用成功 → wf-errors 消失（store 成功清空语义锁定）", async () => {
    const ctx = await mountWithFlow("流程丁");
    // 未绑定 request 节点：保存 → 发布 → 启用失败（errors 可见）
    await ctx.wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await ctx.wrapper.find('[data-testid="wf-save"]').trigger("click");
    await flushPromises();
    await clickStatus(ctx, "wf-publish");
    await clickStatus(ctx, "wf-enable");
    expect(ctx.design.validationErrors.length).toBeGreaterThan(0);
    expect(ctx.wrapper.find('[data-testid="wf-errors"]').exists()).toBe(true);

    // 改绑种子接口/用例 → 保存 → 再启用：成功清空 validationErrors，alert 收起
    ctx.design.update(applyNodeUpdate(ctx.design.workflow!, ctx.design.workflow!.nodes[0]!.id, {
      apiId: [...ctx.bindIndex.apiIds][0]!,
      caseId: [...ctx.bindIndex.caseNames.keys()][0]!,
    }));
    await ctx.wrapper.find('[data-testid="wf-save"]').trigger("click");
    await flushPromises();
    await clickStatus(ctx, "wf-enable");
    expect(ctx.design.workflow!.status).toBe("enabled");
    expect(ctx.design.validationErrors).toHaveLength(0);
    expect(ctx.wrapper.find('[data-testid="wf-errors"]').exists()).toBe(false);
  });

  it("set-status 在途 → 三个生命周期按钮禁用；落地后恢复矩阵", async () => {
    const ctx = await mountWithFlow();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = ctx.api.wfSetStatus.bind(ctx.api);
    ctx.api.wfSetStatus = async (id, next) => { await gate; return original(id, next); };

    await ctx.wrapper.find('[data-testid="wf-publish"]').trigger("click");
    await nextTick();
    const pending = lifecycleButtons(ctx);
    for (const key of ["publish", "enable", "retract"] as const) {
      expect(pending[key].attributes("disabled")).toBeDefined();
    }

    release();
    await flushPromises();
    expect(ctx.design.workflow!.status).toBe("published");
    expect(lifecycleButtons(ctx).enable.attributes("disabled")).toBeUndefined();
  });
});

// —— M2-B 任务 7：运行接线（wf:run）+ 画布着色（nodeStates）+ 结果抽屉 ——
describe("WfDesigner 运行接线与结果抽屉", () => {
  /** 可运行上下文：绑定请求节点 + 占位节点 → 保存 → 发布（memory wfRun 拒绝 draft）。 */
  async function mountRunnableFlow(name = "运行流") {
    const ctx = await mountDesigner();
    await ctx.wrapper.props("wfList").create(name);
    await ctx.wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await flushPromises();
    await ctx.wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await ctx.wrapper.find('[data-testid="wf-add-noop"]').trigger("click");
    ctx.design.update(applyNodeUpdate(ctx.design.workflow!, ctx.design.workflow!.nodes[0]!.id, {
      apiId: [...ctx.bindIndex.apiIds][0]!,
      caseId: [...ctx.bindIndex.caseNames.keys()][0]!,
    }));
    await ctx.wrapper.find('[data-testid="wf-save"]').trigger("click");
    await flushPromises();
    await ctx.wrapper.find('[data-testid="wf-publish"]').trigger("click");
    await flushPromises();
    expect(ctx.design.workflow!.status).toBe("published");
    return ctx;
  }

  /** 抽屉传送门渲染于 document.body：body 作用域查询（先例同 RunView.test bodyFind）。 */
  function bodyFind(testid: string): DOMWrapper<Element> | null {
    const el = document.body.querySelector(`[data-testid="${testid}"]`);
    return el ? new DOMWrapper(el) : null;
  }

  /**
   * 抽屉开合状态：a-drawer 为 Teleport 多根组件，data-testid 不透传（先例同
   * ConfirmDialog testid 不透传），以 .ant-drawer 根的 ant-drawer-open class 断言。
   */
  function drawerState(): "absent" | "open" | "closed" {
    const root = document.body.querySelector(".ant-drawer");
    if (!root) return "absent";
    return root.classList.contains("ant-drawer-open") ? "open" : "closed";
  }

  /** a-select 交互适配：经组件实例发 update:value（v-model 通道，先例同 RunView.test）。 */
  function chooseSelect(wrapper: ReturnType<typeof mount>, testid: string, value: string): void {
    const select = wrapper
      .findAllComponents({ name: "ASelect" })
      .find((c) => c.attributes("data-testid") === testid);
    if (!select) throw new Error(`ASelect 未找到: ${testid}`);
    select.vm.$emit("update:value", value);
  }

  it("运行按钮接线 design.run：api.wfRun 携带 workflowId，完成后 runResult 按节点 id 就绪", async () => {
    const ctx = await mountRunnableFlow();
    const calls: unknown[][] = [];
    const original = ctx.api.wfRun.bind(ctx.api);
    ctx.api.wfRun = async (input) => { calls.push([input]); return original(input); };
    await ctx.wrapper.find('[data-testid="wf-run"]').trigger("click");
    await flushPromises();
    expect(calls).toStrictEqual([[{ workflowId: ctx.design.workflowId, envName: undefined }]]);
    expect(ctx.design.running).toBe(false);
    expect(ctx.design.runResult).not.toBeNull();
    expect(ctx.design.runResult!.nodeResults.map((n) => n.nodeId))
      .toStrictEqual(ctx.design.workflow!.nodes.map((n) => n.id));
  });

  it("运行中 wf-run loading；running 门控下重复点击不重复发 wf:run；落地复位", async () => {
    const ctx = await mountRunnableFlow();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const original = ctx.api.wfRun.bind(ctx.api);
    ctx.api.wfRun = async (input) => { calls += 1; await gate; return original(input); };

    await ctx.wrapper.find('[data-testid="wf-run"]').trigger("click");
    await nextTick();
    expect(ctx.design.running).toBe(true);
    expect(ctx.wrapper.find('[data-testid="wf-run"]').classes()).toContain("ant-btn-loading");
    await ctx.wrapper.find('[data-testid="wf-run"]').trigger("click"); // 在途重复点击
    release();
    await flushPromises();
    expect(calls).toBe(1); // 门控吞掉第二次
    expect(ctx.design.running).toBe(false);
    expect(ctx.design.runResult).not.toBeNull();
    // 每次运行仅此一次 IPC 调用（历史落盘由 wf:run 主进程自动完成，UI 不重复写）
  });

  it("运行完成 → 画布节点按 nodeResults 着色（passed/noop）；注入 failed/skipped 同样生效", async () => {
    const ctx = await mountRunnableFlow();
    expect(ctx.wrapper.find('[data-testid="wf-node"].wf-node-passed').exists()).toBe(false); // 运行前无着色
    await ctx.wrapper.find('[data-testid="wf-run"]').trigger("click");
    await flushPromises();
    const nodes = ctx.wrapper.findAll('[data-testid="wf-node"]');
    expect(nodes[0]!.classes()).toContain("wf-node-passed"); // memory wfRun: request → passed
    expect(nodes[1]!.classes()).toContain("wf-node-noop"); // noop → noop

    // 注入 failed/skipped：着色链路 runResult → nodeStates → toFlowElements 全程重算
    const ids = ctx.design.workflow!.nodes.map((n) => n.id);
    ctx.api.wfRun = async () => ({
      workflowId: ctx.design.workflow!.id, workflowName: ctx.design.workflow!.name, status: "published",
      nodeResults: [
        { nodeId: ids[0]!, kind: "request", state: "failed", error: "期望 200 实际 500" },
        { nodeId: ids[1]!, kind: "noop", state: "skipped" },
      ],
      total: 2, passed: 0, failed: 1, skipped: 1, warnings: [], startedAt: "", finishedAt: "",
    });
    await ctx.wrapper.find('[data-testid="wf-run"]').trigger("click");
    await flushPromises();
    const after = ctx.wrapper.findAll('[data-testid="wf-node"]');
    expect(after[0]!.classes()).toContain("wf-node-failed");
    expect(after[1]!.classes()).toContain("wf-node-skipped");
  });

  it("运行完成 → 结果抽屉自动打开：节点行 label/状态/耗时；关闭后「结果」按钮可重开", async () => {
    const ctx = await mountRunnableFlow();
    expect(drawerState()).toBe("absent"); // 未运行无抽屉
    await ctx.wrapper.find('[data-testid="wf-run"]').trigger("click");
    await flushPromises();
    expect(drawerState()).toBe("open");
    const rows = document.body.querySelectorAll('[data-testid="wf-result-node"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("请求节点"); // label 列
    expect(rows[0]!.querySelector('[data-testid="wf-result-state"]')!.classList.contains("ant-tag-success"))
      .toBe(true); // passed Tag 复用 colorForState 语义（绿）
    expect(rows[1]!.querySelector('[data-testid="wf-result-state"]')!.classList.contains("ant-tag-processing"))
      .toBe(true); // noop Tag（蓝）

    // 关闭（抽屉关闭钮 emit close）→ 收起；顶栏「结果」按钮重开
    await new DOMWrapper(document.body.querySelector(".ant-drawer-close")!).trigger("click");
    await flushPromises();
    expect(drawerState()).toBe("closed");
    await ctx.wrapper.find('[data-testid="wf-results"]').trigger("click");
    await flushPromises();
    expect(drawerState()).toBe("open");
  });

  it("抽屉 warnings a-alert 置顶 + 失败行错误/耗时列；无 outcome 耗时占位 —", async () => {
    const ctx = await mountRunnableFlow();
    const ids = ctx.design.workflow!.nodes.map((n) => n.id);
    ctx.api.wfRun = async () => ({
      workflowId: ctx.design.workflow!.id, workflowName: ctx.design.workflow!.name, status: "published",
      nodeResults: [
        {
          nodeId: ids[0]!, kind: "request", state: "failed", error: "连接超时",
          outcome: { apiId: "a", apiName: "", caseId: "c", caseName: "", passed: false, durationMs: 12.4, assertions: [] },
        },
        { nodeId: ids[1]!, kind: "noop", state: "skipped" },
      ],
      total: 2, passed: 0, failed: 1, skipped: 1,
      warnings: ["结构告警（测试注入）"], startedAt: "", finishedAt: "",
    });
    await ctx.wrapper.find('[data-testid="wf-run"]').trigger("click");
    await flushPromises();
    const warnings = bodyFind("wf-result-warnings");
    expect(warnings).not.toBeNull();
    expect(warnings!.text()).toContain("结构告警（测试注入）");
    const rows = document.body.querySelectorAll('[data-testid="wf-result-node"]');
    expect(rows[0]!.textContent).toContain("连接超时");
    expect(rows[0]!.textContent).toContain("12ms"); // outcome.durationMs 取整
    expect(rows[1]!.textContent).toContain("—"); // 无 outcome 占位
  });

  it("环境选择：选项来自当前项目 envs；选中后 wfRun 携带 envName；切流重置回无环境", async () => {
    const ctx = await mountRunnableFlow();
    await ctx.api.envCreate({ projectId: ctx.projectId, name: "dev" });
    await ctx.workspace.refresh();
    await flushPromises();
    const select = ctx.wrapper.findAllComponents({ name: "ASelect" })
      .find((c) => c.attributes("data-testid") === "wf-run-env");
    expect(select!.props("options")).toStrictEqual([
      { label: "无环境", value: "" },
      { label: "dev", value: "dev" },
    ]);

    const calls: unknown[][] = [];
    const original = ctx.api.wfRun.bind(ctx.api);
    ctx.api.wfRun = async (input) => { calls.push([input]); return original(input); };
    chooseSelect(ctx.wrapper, "wf-run-env", "dev");
    await ctx.wrapper.find('[data-testid="wf-run"]').trigger("click");
    await flushPromises();
    expect(calls[0]).toStrictEqual([{ workflowId: ctx.design.workflowId, envName: "dev" }]);

    // 切走再切回（load 重置会话态）：环境选择不跨流残留
    await ctx.wrapper.find('[data-testid="wf-back-to-list"]').trigger("click");
    await flushPromises();
    await ctx.wrapper.findAll('[data-testid="wf-list-item"]')[0]!.trigger("click");
    await flushPromises();
    await ctx.wrapper.find('[data-testid="wf-run"]').trigger("click");
    await flushPromises();
    expect(calls[1]).toStrictEqual([{ workflowId: ctx.design.workflowId, envName: undefined }]);
  });

  it("运行链路拒绝 → reportError 上报；结果抽屉不自动打开", async () => {
    const ctx = await mountRunnableFlow();
    ctx.api.wfRun = async () => { throw new Error("运行失败（测试注入）"); };
    await ctx.wrapper.find('[data-testid="wf-run"]').trigger("click");
    await flushPromises();
    expect(ctx.errors).toHaveLength(1);
    expect((ctx.errors[0] as Error).message).toBe("运行失败（测试注入）");
    expect(ctx.design.running).toBe(false);
    expect(drawerState()).not.toBe("open"); // 结果抽屉不自动打开
  });
});

// —— 审查 I3：工作流列表删除入口（规格 D3；重命名显式延后，M2-C 与侧树入口同批） ——
describe("WfDesigner 工作流列表删除", () => {
  /** 空态列表含一条工作流的上下文。 */
  async function mountWithItem(name: string) {
    const ctx = await mountDesigner();
    const created = await ctx.wrapper.props("wfList").create(name);
    await flushPromises();
    return { ...ctx, created };
  }

  it("列表项「删除」动作钮 → 确认对话框；确认后 wfDelete 被调、列表项消失", async () => {
    const ctx = await mountWithItem("待删流");
    const calls: string[] = [];
    const original = ctx.api.wfDelete.bind(ctx.api);
    ctx.api.wfDelete = async (id) => { calls.push(id); return original(id); };

    const del = ctx.wrapper.findAll('[data-testid="wf-item-delete"]')
      .find((n) => n.attributes("data-id") === ctx.created.id)!;
    expect(del).toBeDefined();
    await del.trigger("click");
    // 确认框（ConfirmDialog）传送门渲染于 body：先出现且列表未动
    expect(document.body.querySelector('[data-testid="dialog-confirm"]')).not.toBeNull();
    expect(ctx.wrapper.findAll('[data-testid="wf-list-item"]').some((n) => n.text().includes("待删流"))).toBe(true);

    await bodyClick("dialog-confirm");
    await flushPromises();
    expect(calls).toStrictEqual([ctx.created.id]);
    expect(ctx.wrapper.findAll('[data-testid="wf-list-item"]').some((n) => n.text().includes("待删流"))).toBe(false);
  });

  it("删除确认取消 → 不调 wfDelete，列表项保留", async () => {
    const ctx = await mountWithItem("保留流");
    let calls = 0;
    ctx.api.wfDelete = async () => { calls += 1; };
    await ctx.wrapper.findAll('[data-testid="wf-item-delete"]')[0]!.trigger("click");
    await bodyClick("dialog-cancel");
    await flushPromises();
    expect(calls).toBe(0);
    expect(ctx.wrapper.findAll('[data-testid="wf-list-item"]').some((n) => n.text().includes("保留流"))).toBe(true);
  });

  it("删除链路拒绝 → reportError 上报且列表不动", async () => {
    const ctx = await mountWithItem("拒删流");
    ctx.api.wfDelete = async () => { throw new Error("删除失败（测试注入）"); };
    await ctx.wrapper.findAll('[data-testid="wf-item-delete"]')[0]!.trigger("click");
    await bodyClick("dialog-confirm");
    await flushPromises();
    expect(ctx.errors).toHaveLength(1);
    expect((ctx.errors[0] as Error).message).toBe("删除失败（测试注入）");
    expect(ctx.wrapper.findAll('[data-testid="wf-list-item"]')).toHaveLength(1);
  });
});

// —— 审查修复 4：属性面板级联 change → node-change 载荷映射 ——
describe("WfPropertyPanel 级联改绑映射", () => {
  const bindOptions: BindOption[] = [
    {
      value: "col1", label: "集合A",
      children: [{ value: "a1", label: "登录", children: [{ value: "c1", label: "手机号" }] }],
    },
  ];
  const nodeData: WfNodeData = {
    node: { id: "n1", kind: "request", apiId: "a1", caseId: "c1", label: "登录节点" },
    missing: false,
    stateClass: "",
  };

  async function mountPanel() {
    const { i18n } = createI18nInstance();
    return mount(WfPropertyPanel, {
      props: { nodeData, edgeData: null, bindOptions },
      global: { plugins: [i18n] },
    });
  }

  it("cascader change → node-change（path[1]→apiId、path[2]→caseId；两段=只绑接口）", async () => {
    const wrapper = await mountPanel();
    const cascader = wrapper.findComponent(ACascader);
    cascader.vm.$emit("change", ["col1", "a1", "c1"]);
    cascader.vm.$emit("change", ["col1", "a1"]);
    const events = wrapper.emitted<{ apiId?: string; caseId?: string }>("node-change")!;
    expect(events[0]).toStrictEqual([{ apiId: "a1", caseId: "c1" }]);
    expect(events[1]).toStrictEqual([{ apiId: "a1", caseId: undefined }]);
  });

  it("清空级联 → 解除绑定（apiId/caseId 均清除）", async () => {
    const wrapper = await mountPanel();
    wrapper.findComponent(ACascader).vm.$emit("change", []);
    expect(wrapper.emitted("node-change")![0]).toStrictEqual([{ apiId: undefined, caseId: undefined }]);
  });
});
