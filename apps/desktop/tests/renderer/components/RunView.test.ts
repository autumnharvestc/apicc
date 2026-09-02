// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；a-drawer 传送门渲染于
// document.body（同 EnvPanel.test 的 a-modal 约定），抽屉内元素用 body 作用域查询；
// a-select 下拉展开在 jsdom 中不稳定，统一经组件实例 update:value 驱动（chooseSelect）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import type { RunResult } from "@apicc/core";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useRunStore } from "../../../src/renderer/src/stores/run.js";
import RunView from "../../../src/renderer/src/components/RunView.vue";

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
  // 固定语言为 zh-CN，使文案断言与语言文件一致。
  localStorage.setItem("apicc.locale", "zh-CN");
});

enableAutoUnmount(afterEach);

function bodyFind(testid: string): DOMWrapper<Element> | null {
  const el = document.body.querySelector(`[data-testid="${testid}"]`);
  return el ? new DOMWrapper(el) : null;
}

/** a-select 交互适配：经组件实例发 update:value（v-model 通道），见文件头说明。 */
function chooseSelect(wrapper: ReturnType<typeof mount>, testid: string, value: string): void {
  const select = wrapper
    .findAllComponents({ name: "ASelect" })
    .find((c) => c.attributes("data-testid") === testid);
  if (!select) throw new Error(`ASelect 未找到: ${testid}`);
  select.vm.$emit("update:value", value);
}

/** 显式装配辅助（组合根约定的测试形态）：store 一次性创建，经 props 注入被测组件。 */
async function mountRunView(props: Record<string, unknown> = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const collectionNode = workspace.tree!.children![0]!.children![0]!.children![0]!;
  const run = useRunStore(api);
  const { i18n } = createI18nInstance();
  const wrapper = mount(RunView, {
    props: { run, workspace, selectedCollectionId: null, reportError: () => {}, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, run, collectionNode };
}

describe("RunView", () => {
  it("未选集合时运行钮禁用；选择集合并运行后表格与汇总出现", async () => {
    const { wrapper, run, collectionNode } = await mountRunView();
    const runBtn = wrapper.find('[data-testid="run-btn"]');
    expect(runBtn.attributes("disabled")).toBeDefined();
    chooseSelect(wrapper, "run-collection-select", collectionNode.id);
    await flushPromises();
    expect(runBtn.attributes("disabled")).toBeUndefined();
    await runBtn.trigger("click");
    await flushPromises();
    expect(run.result).not.toBeNull();
    expect(wrapper.find('[data-testid="run-table"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="run-summary"]').text()).toContain("共 1 条");
  });

  it("失败行结果 Tag 为 failed（data-passed=false + 失败文案）", async () => {
    const { wrapper, api, collectionNode } = await mountRunView();
    // memory 的 runCollection 固定成功——注入含失败用例的结果验证失败呈现（EnvPanel 覆写 api 同款手法）
    const mixed: RunResult = {
      collectionId: collectionNode.id, collectionName: "示例集合",
      startedAt: "2026-09-02T00:00:00.000Z", finishedAt: "2026-09-02T00:00:01.000Z",
      total: 2, passed: 1, failed: 1,
      cases: [
        { apiId: "a1", apiName: "通过接口", caseId: "c1", caseName: "通过用例", passed: true, durationMs: 5, assertions: [] },
        {
          apiId: "a2", apiName: "失败接口", caseId: "c2", caseName: "失败用例", passed: false, durationMs: 7,
          assertions: [{ pass: false, message: "期望 200 实际 500" }], error: "连接失败",
        },
      ],
    };
    api.runCollection = async () => mixed;
    chooseSelect(wrapper, "run-collection-select", collectionNode.id);
    await flushPromises();
    await wrapper.find('[data-testid="run-btn"]').trigger("click");
    await flushPromises();
    const outcomes = wrapper.findAll('[data-testid="run-outcome"]');
    expect(outcomes).toHaveLength(2);
    const failedTag = outcomes.find((t) => t.attributes("data-passed") === "false");
    expect(failedTag).toBeDefined();
    expect(failedTag!.text()).toBe("失败");
    expect(wrapper.find('[data-testid="run-summary"]').text()).toContain("失败 1");
  });

  it("历史抽屉：运行后打开列出 history-row，点击读回完整结果并收起", async () => {
    const { wrapper, run, collectionNode } = await mountRunView();
    chooseSelect(wrapper, "run-collection-select", collectionNode.id);
    await flushPromises();
    await wrapper.find('[data-testid="run-btn"]').trigger("click");
    await flushPromises();
    run.result = null; // 清掉现场，验证历史回填
    await wrapper.find('[data-testid="runs-history-btn"]').trigger("click");
    await flushPromises();
    expect(run.historyOpen).toBe(true);
    const row = bodyFind("history-row");
    expect(row).not.toBeNull();
    expect(row!.text()).toContain("示例集合");
    await row!.trigger("click");
    await flushPromises();
    expect(run.historyOpen).toBe(false);
    expect(run.result).not.toBeNull();
    expect(run.result!.collectionName).toBe("示例集合");
  });

  it("运行链路拒绝时经 reportError 上报（宽审查 I1 同款收口）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, collectionNode } = await mountRunView({ reportError: (e: unknown) => { errors.push(e); } });
    api.runCollection = async () => { throw new Error("boom"); };
    chooseSelect(wrapper, "run-collection-select", collectionNode.id);
    await flushPromises();
    await wrapper.find('[data-testid="run-btn"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });
});
