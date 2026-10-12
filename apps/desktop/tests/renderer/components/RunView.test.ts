// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；a-drawer 传送门渲染于
// document.body（同 EnvPanel.test 的 a-modal 约定），抽屉内元素用 body 作用域查询；
// a-select 下拉展开在 jsdom 中不稳定，统一经组件实例 update:value 驱动（chooseSelect）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import type { RunResult } from "@apicc/core";
import type { CollectionLocator } from "../../../src/shared/locations.js";
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
  const group = workspace.tree!.children.find((node) => node.kind === "group" && node.children.some((child) =>
    child.kind === "project" && child.children.some((item) => item.kind === "collection")));
  if (!group || group.kind !== "group") throw new Error("Memory workspace is missing the seeded project group");
  const project = group.children.find((node) => node.kind === "project" && node.children.some((item) => item.kind === "collection"));
  if (!project || project.kind !== "project") throw new Error("Memory group is missing the seeded project");
  const collectionNode = project.children.find((node) => node.kind === "collection");
  if (!collectionNode || collectionNode.kind !== "collection") throw new Error("Memory project is missing the seeded collection");
  const run = useRunStore(api);
  const { i18n } = createI18nInstance();
  const wrapper = mount(RunView, {
    props: { run, workspace, selectedCollectionLocator: null, reportError: () => {}, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, run, group, project, collectionNode };
}

describe("RunView", () => {
  it("未选集合时运行钮禁用；选择集合并运行后表格与汇总出现", async () => {
    const { wrapper, run, collectionNode } = await mountRunView();
    const runBtn = wrapper.find('[data-testid="run-btn"]');
    expect(runBtn.attributes("disabled")).toBeDefined();
    chooseSelect(wrapper, "run-collection-select", JSON.stringify(collectionNode.locator));
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
    chooseSelect(wrapper, "run-collection-select", JSON.stringify(collectionNode.locator));
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

  it("结果行显示 skipped、skipReason 与 failureKind，且通过行不被改写", async () => {
    const { wrapper, api, collectionNode } = await mountRunView();
    const mixed: RunResult = {
      collectionId: collectionNode.id, collectionName: "三态集合",
      startedAt: "2026-09-02T00:00:00.000Z", finishedAt: "2026-09-02T00:00:01.000Z",
      total: 3, passed: 1, failed: 1, skipped: 1,
      cases: [
        { apiId: "a1", apiName: "通过接口", caseId: "c1", caseName: "通过用例", passed: true, durationMs: 5, assertions: [] },
        { apiId: "a2", apiName: "跳过接口", caseId: "c2", caseName: "跳过用例", passed: false, skipped: true, skipReason: "upstream-failed", durationMs: 0, assertions: [] },
        { apiId: "a3", apiName: "失败接口", caseId: "c3", caseName: "失败用例", passed: false, failureKind: "config", error: "节点引用缺失", durationMs: 0, assertions: [] },
      ],
    };
    api.runCollection = async () => mixed;
    chooseSelect(wrapper, "run-collection-select", JSON.stringify(collectionNode.locator));
    await flushPromises();
    await wrapper.find('[data-testid="run-btn"]').trigger("click");
    await flushPromises();
    const tags = wrapper.findAll('[data-testid="run-outcome"]');
    expect(tags).toHaveLength(3);
    expect(tags.find((tag) => tag.attributes("data-state") === "skipped")?.text()).toContain("跳过");
    expect(wrapper.find('[data-testid="run-summary"]').text()).toContain("跳过 1");
    expect(wrapper.text()).toContain("upstream-failed");
    expect(wrapper.text()).toContain("config");
  });

  it("历史抽屉：运行后打开列出 history-row，点击读回完整结果并收起", async () => {
    const { wrapper, run, collectionNode } = await mountRunView();
    chooseSelect(wrapper, "run-collection-select", JSON.stringify(collectionNode.locator));
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

  it("跨项目切换集合：环境下拉残留的失效环境名重置回「无环境」", async () => {
    const { wrapper, api, run, workspace, group, project: projectA, collectionNode } = await mountRunView();
    // 项目 A 建环境 dev；另建项目 B 及其集合（跨项目切换场景）
    await api.envCreate({ locator: projectA.locator, name: "dev" });
    const p2 = await api.nodeCreate({ kind: "project", parent: group.locator, name: "p2" });
    if (p2.kind !== "project") throw new Error("Memory project creation did not return a project node");
    const c2 = await api.nodeCreate({ kind: "collection", parent: p2.locator, name: "c2" });
    if (c2.kind !== "collection") throw new Error("Memory collection creation did not return a collection node");
    await workspace.refresh();
    await flushPromises();
    chooseSelect(wrapper, "run-collection-select", JSON.stringify(collectionNode.locator));
    chooseSelect(wrapper, "run-env-select", "dev");
    await flushPromises();
    // 切到项目 B 的集合：残留的 dev 在项目 B 不存在（会被主进程「未找到环境」拒绝），应重置回无环境
    chooseSelect(wrapper, "run-collection-select", JSON.stringify(c2.locator));
    await flushPromises();
    const envSelect = wrapper
      .findAllComponents({ name: "ASelect" })
      .find((c) => c.attributes("data-testid") === "run-env-select")!;
    expect((envSelect.vm.$props as { value: unknown }).value).toBe("");
    // 行为面断言：运行入参不再携带残留 envName
    const captured: { current: { locator: CollectionLocator; envName?: string | null } | null } = { current: null };
    const original = api.runCollection.bind(api);
    api.runCollection = async (input) => {
      captured.current = { ...input };
      return original(input);
    };
    await wrapper.find('[data-testid="run-btn"]').trigger("click");
    await flushPromises();
    expect(captured.current?.locator).toEqual(c2.locator);
    expect(captured.current?.envName).toBeUndefined();
    expect(run.result).not.toBeNull();
  });

  it("运行链路拒绝时经 reportError 上报（宽审查 I1 同款收口）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, collectionNode } = await mountRunView({ reportError: (e: unknown) => { errors.push(e); } });
    api.runCollection = async () => { throw new Error("boom"); };
    chooseSelect(wrapper, "run-collection-select", JSON.stringify(collectionNode.locator));
    await flushPromises();
    await wrapper.find('[data-testid="run-btn"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });
});
