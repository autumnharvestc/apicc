// @vitest-environment jsdom
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { StressPlanSchema } from "@apicc/core/schema";
import type { RunResult } from "@apicc/core";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useRunStore } from "../../../src/renderer/src/stores/run.js";
import { localLaunchProps } from "../../helpers/localLaunchProps.js";
import RunView from "../../../src/renderer/src/components/RunView.vue";
import CaseEvidencePanel from "../../../src/renderer/src/components/CaseEvidencePanel.vue";
import { runReport } from '../../../../../packages/core/tests/collaboration/fixtures.js';
import { holdRealReportDigest } from '../../helpers/realReportDigest.js';

const jsdomComputedStyle = window.getComputedStyle;
beforeAll(() => {
  // Reuse App.test's exact element-style adapter for Antd pseudo-element measurement.
  window.getComputedStyle = (element) => jsdomComputedStyle.call(window, element);
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
afterAll(() => { window.getComputedStyle = jsdomComputedStyle; });

enableAutoUnmount(afterEach);

function chooseModule(wrapper: ReturnType<typeof mount>, collectionId: string) {
  return wrapper.get(`input[type="radio"][value="${collectionId}"]`).setValue(true);
}

/** 显式装配辅助（组合根约定的测试形态）：store 一次性创建，经 props 注入被测组件。 */
async function mountRunView(props: Record<string, unknown> = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open(await api.wsPickDirectory());
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
    props: { ...localLaunchProps(api, workspace), run, workspace, selectedCollectionLocator: null, reportError: () => {}, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, run, group, project, collectionNode };
}

describe("RunView", () => {
  it('T9 offers the selected current report as a digest descriptor without putting its raw result in the event', async () => {
    const { wrapper, run, collectionNode } = await mountRunView(); run.setTarget(wrapper.props("workspace").root, collectionNode.locator); run.result = runReport(); await flushPromises(); expect(wrapper.text()).toContain('2');
    const digest = holdRealReportDigest();
    try {
      await wrapper.get('[data-testid="collaboration-publish-current"]').trigger('click'); await flushPromises(); expect(digest.spy).toHaveBeenCalledTimes(1); expect(wrapper.emitted('collaboration')).toBeUndefined();
      await digest.settle(); await flushPromises(); const source = wrapper.emitted('collaboration')?.[0]?.[0] as any;
      expect(source).toEqual({ kind: 'current', project: { workspaceId: collectionNode.locator.workspaceId, groupId: collectionNode.locator.groupId, projectId: collectionNode.locator.projectId }, expectedReportDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }); expect(source.report).toBeUndefined();
    } finally { try { await digest.settle(); await flushPromises(); } finally { digest.restore(); } }
  });
  it("C1 Fix1 reserves rerun preparation synchronously and navigation awaits the captured cleanup", async () => {
    const { api, run, workspace, project, collectionNode } = await mountRunView();
    run.setTarget(workspace.root, collectionNode.locator);
    const view = await api.listTestingAssets({ root: workspace.root!, project: project.locator });
    let resolveAssets!: (value: typeof view) => void;
    api.listTestingAssets = vi.fn(() => new Promise<typeof view>((resolve) => { resolveAssets = resolve; }));
    const rerun = vi.spyOn(api, "rerunEvidence"); const collection = vi.spyOn(api, "runCollection");
    const identity = { projectId: project.id, definitionRevision: "historical-revision" };
    const first = run.rerunEvidence(identity);
    expect(run.running).toBe(true);
    await run.rerunEvidence(identity);
    await run.runCollection(workspace.root!, collectionNode.locator);
    expect(api.listTestingAssets).toHaveBeenCalledTimes(1);
    expect(collection).not.toHaveBeenCalled();
    let navigated = false;
    const navigation = Promise.resolve(run.setTarget(workspace.root, null)).then(() => { navigated = true; });
    await flushPromises();
    expect(navigated).toBe(false);
    expect(run.running).toBe(true);
    resolveAssets(view);
    await Promise.all([first, navigation]);
    expect(rerun).not.toHaveBeenCalled();
    expect(run.running).toBe(false);
    expect(run.result).toBeNull();
    // The same captured slot also owns the host phase; cancellation does not release it early.
    await run.setTarget(workspace.root, collectionNode.locator);
    api.listTestingAssets = vi.fn(async () => view);
    let resolveRun!: (value: RunResult) => void;
    rerun.mockImplementation(() => new Promise((resolve) => { resolveRun = resolve; }));
    const cancel = vi.spyOn(api, "cancelEvidence").mockResolvedValue(true);
    const executing = run.rerunEvidence(identity); await flushPromises();
    const captured = rerun.mock.calls[0]![0];
    await run.rerunEvidence(identity); await run.runCollection(workspace.root, collectionNode.locator);
    expect(rerun).toHaveBeenCalledTimes(1); expect(collection).not.toHaveBeenCalled();
    let settled = false;
    const leaving = Promise.resolve(run.setTarget(workspace.root, null)).then(() => { settled = true; });
    await flushPromises();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(captured);
    expect(settled).toBe(false); expect(run.running).toBe(true);
    resolveRun({ collectionId: collectionNode.id, collectionName: "stale", startedAt: "start", finishedAt: "end", total: 0, passed: 0, failed: 0, cases: [] });
    await Promise.all([executing, leaving]);
    expect(run.running).toBe(false); expect(run.result).toBeNull();
  });
  it("C1 localizes historical evidence labels and copies the unchanged safe evidence DTO", async () => {
    const writeText = vi.fn(async (_value: string) => {}); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { i18n } = createI18nInstance(); i18n.global.locale.value = "zh-CN";
    const panel = mount(CaseEvidencePanel, { props: {}, global: { plugins: [i18n] } });
    expect(panel.text()).toContain("旧记录未采集");
    await panel.setProps({ evidence: { identity: { projectId: "p", definitionRevision: "r" }, state: "omitted", scriptDiagnostics: "not-collected", truncated: true } });
    expect(panel.text()).toContain("预算耗尽");
    await panel.find('[data-testid="evidence-copy"]').trigger("click");
    expect(JSON.parse(writeText.mock.calls[0]![0]!)).toMatchObject({ state: "omitted", identity: { projectId: "p" } });
    await panel.setProps({ evidence: { identity: { projectId: "p", definitionRevision: "r", rowIndex: 0 }, state: "collected", scriptDiagnostics: "not-collected", truncated: false, response: { status: 200, headers: { text: "content-type: binary", truncated: false }, body: { text: "unavailable", truncated: false, omitted: true } } } });
    expect(panel.get('[data-testid="evidence-row"] dt').text()).toBe("数据行"); expect(panel.get('[data-testid="evidence-row"] dd').text()).toBe("1"); expect.soft(panel.text()).toContain("未采集或不可用"); expect(panel.text()).toContain("content-type: binary");
    await panel.setProps({ evidence: { identity: { projectId: "p", definitionRevision: "r" }, state: "not-collected", scriptDiagnostics: "not-collected", truncated: false } });
    expect(panel.get('[data-testid="evidence-row"] dd').text()).toBe("—");
    i18n.global.locale.value = "en"; await flushPromises();
    expect.soft(panel.text()).toContain("Bodies were not collected for this record");
    expect.soft(panel.text()).toContain("Script diagnostics");
    expect.soft(panel.text()).toContain("Response body unavailable");
    expect(panel.text()).toContain("Copy safe evidence");
    expect(panel.text()).not.toContain("未采集");
    const preview = (text: string) => ({ text, truncated: false });
    const content = { identity: { projectId: "p", definitionRevision: "r" }, state: "collected" as const, scriptDiagnostics: "existing-assertions-only" as const, truncated: false,
      response: { status: 200, headers: preview("content-type: text/plain"), body: preview("用户正文") },
      extractions: ["failed", "custom-status-v9"].map(status => ({ id: preview("id"), name: preview("用户提取名"), selector: preview("$.userKey"), status, code: preview("custom-code-v9"), published: false, sensitive: false, message: preview("用户诊断原文") })) };
    await panel.setProps({ evidence: content });
    for (const locale of ["zh-CN", "en"] as const) {
      i18n.global.locale.value = locale; await flushPromises();
      expect(panel.text()).toContain(locale === "zh-CN" ? "失败" : "Failed");
      expect(panel.text()).toContain("用户正文"); expect(panel.text()).toContain("用户提取名");
      expect(panel.text()).toContain("custom-status-v9"); expect(panel.text()).toContain("custom-code-v9");
    }
    await panel.find('[data-testid="evidence-copy"]').trigger("click");
    expect(JSON.parse(writeText.mock.calls.at(-1)![0]!)).toEqual(panel.props("evidence"));
    panel.unmount();
  });
  it("未选集合时运行钮禁用；选择集合并运行后表格与汇总出现", async () => {
    const { wrapper, run, collectionNode } = await mountRunView();
    const runBtn = wrapper.find('[data-testid="run-btn"]');
    expect(runBtn.attributes("disabled")).toBeDefined();
    await chooseModule(wrapper, collectionNode.id);
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
    await chooseModule(wrapper, collectionNode.id);
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
        { apiId: "a1", apiName: "通过接口", caseId: "c1", caseName: "通过用例", row: 0, passed: true, durationMs: 5, assertions: [] },
        { apiId: "a2", apiName: "跳过接口", caseId: "c2", caseName: "跳过用例", row: 1, passed: false, skipped: true, skipReason: "upstream-failed", durationMs: 0, assertions: [] },
        { apiId: "a3", apiName: "失败接口", caseId: "c3", caseName: "失败用例", passed: false, failureKind: "config", error: "节点引用缺失", durationMs: 0, assertions: [] },
      ],
      suite: { suiteRunId: "r19", projectId: "p", definitionRevision: "r", verdict: "failed", total: 3, passed: 1, failed: 1, skipped: 1,
        entries: [
          { entryId: "first-round", kind: "case", suiteRow: 0, status: "passed" },
          { entryId: "second-round", kind: "case", suiteRow: 1, status: "skipped" },
          { entryId: "no-round", kind: "case", status: "failed" },
        ] },
    };
    api.runCollection = async () => mixed;
    await chooseModule(wrapper, collectionNode.id);
    await flushPromises();
    await wrapper.find('[data-testid="run-btn"]').trigger("click");
    await flushPromises();
    const tags = wrapper.findAll('[data-testid="run-outcome"]');
    expect(tags).toHaveLength(3);
    expect(tags.find((tag) => tag.attributes("data-state") === "skipped")?.text()).toContain("跳过");
    expect(wrapper.find('[data-testid="run-summary"]').text()).toContain("跳过 1");
    expect(wrapper.text()).toContain("upstream-failed");
    expect(wrapper.text()).toContain("config");
    expect(wrapper.findAll('[data-testid="run-table"] .ant-table-row').map(row => row.findAll('td')[3]!.text())).toEqual(["1", "2", "—"]);
    const entries = wrapper.findAll('[data-testid="run-suite-entries"] tbody tr').map(row => row.findAll('td').map(cell => cell.text()));
    expect(entries).toEqual([
      ['first-round', '1', '用例', '通过', '—'],
      ['second-round', '2', '用例', '跳过', '—'],
      ['no-round', '—', '用例', '失败', '—'],
    ]);
    expect(mixed.cases.map(row => row.row)).toEqual([0, 1, undefined]);
    expect(mixed.suite!.entries!.map(entry => entry.suiteRow)).toEqual([0, 1, undefined]);
  });

  it("限制为当前项目，跨项目切换后空模块显示零用例并禁止运行", async () => {
    const { wrapper, workspace, api, group, collectionNode } = await mountRunView();
    const second = await api.nodeCreate({kind: "project", parent: group.locator, name: "another"});
    if (second.kind !== "project") throw new Error("missing project");
    const empty = await api.nodeCreate({kind: "collection", parent: second.locator, name: collectionNode.label});
    if (empty.kind !== "collection") throw new Error("missing collection");
    await workspace.refresh(); await flushPromises();
    expect(wrapper.find(`input[value="${empty.id}"]`).exists()).toBe(false);
    await wrapper.setProps({projectLocator: second.locator}); await flushPromises();
    expect(wrapper.find(`input[value="${collectionNode.id}"]`).exists()).toBe(false);
    await chooseModule(wrapper, empty.id); await flushPromises();
    expect(wrapper.get('[data-testid="module-scope"]').text()).toContain("0 个用例");
    expect(wrapper.text()).toContain("当前环境没有可运行的用例");
    expect(wrapper.get('[data-testid="run-btn"]').attributes("disabled")).toBeDefined();
  });

  it("restores the launch search and target per local project and clears the preview without starting a run", async () => {
    const { wrapper, api, workspace, group, project, collectionNode } = await mountRunView();
    const submit = vi.spyOn(api, "runCollection");
    const second = await api.nodeCreate({kind:"project", parent:group.locator, name:project.label});
    if (second.kind !== "project") throw Error("missing project");
    await api.nodeCreate({kind:"collection",parent:second.locator,name:collectionNode.label});
    await workspace.refresh(); await flushPromises();
    const search = wrapper.get<HTMLInputElement>('[data-testid="launch-search"]');
    await search.setValue(collectionNode.label); await chooseModule(wrapper, collectionNode.id); await flushPromises();
    expect(wrapper.get(".launch-preview dl").text()).toContain("无环境");
    await wrapper.setProps({projectLocator:second.locator}); await flushPromises();
    expect(search.element.value).toBe(""); expect(wrapper.find(".launch-preview h3").exists()).toBe(false);
    await search.setValue("other search");
    await wrapper.setProps({projectLocator:project.locator}); await flushPromises();
    expect(search.element.value).toBe(collectionNode.label);
    expect(wrapper.get<HTMLInputElement>('input[type="radio"]:checked').element.value).toBe(collectionNode.id);
    await wrapper.get('[data-testid="launch-clear"]').trigger("click"); await flushPromises();
    expect(search.element.value).toBe(collectionNode.label);
    expect(wrapper.find(".launch-preview h3").exists()).toBe(false);
    expect(wrapper.find('[data-testid="module-scope"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="run-btn"]').attributes("disabled")).toBeDefined();
    expect(submit).not.toHaveBeenCalled();
  });

  it("searches and submits a physical case by the name saved in the selected environment", async () => {
    const {wrapper,api,workspace,project} = await mountRunView();
    const assets = await api.listTestingAssets({root:workspace.root!,project:project.locator});
    const locator = assets.cases[0]!.locator, edit = await api.apiGet(locator), base = edit.api.cases[0]!;
    const env = await api.envCreate({locator:project.locator,name:"集成环境"});
    edit.api.cases = [{...base,name:"基础订单",scope:"base"},{...base,name:"集成结算订单",scope:"集成环境"}];
    await api.apiSave(locator,edit.api,edit.sourceApiRevision); await workspace.refresh();
    await wrapper.setProps({environmentId:env.id}); await flushPromises();
    const submit = vi.spyOn(api,"debugStart");
    await wrapper.get('[data-testid="launch-kind"]').setValue("case");
    await wrapper.get('[data-testid="launch-search"]').setValue("集成结算");
    expect(wrapper.findAll('[data-testid="launch-target"]')).toHaveLength(1);
    await wrapper.get('[data-testid="launch-target"]').setValue(true); await flushPromises();
    expect(wrapper.get(".launch-preview h3").text()).toBe("集成结算订单");
    expect(wrapper.get(".launch-preview dl").text()).toContain("集成结算订单");
    expect(submit).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="run-btn"]').trigger("click"); await flushPromises();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0]).toMatchObject({environmentId:env.id,case:{caseId:base.id,scope:"集成环境"}});
  });

  it("uses the project environment ID for a single case even when module execution cannot resolve its name", async () => {
    const { wrapper, api, workspace, project, collectionNode } = await mountRunView();
    await api.envCreate({ locator: project.locator, name: "Same name" });
    const second = await api.envCreate({ locator: project.locator, name: "Same name" });
    await workspace.refresh();
    await wrapper.setProps({ environmentId: second.id });
    await chooseModule(wrapper, collectionNode.id);
    await flushPromises();
    const button = wrapper.get('[data-testid="run-btn"]');
    expect(button.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("同名");
    const start = vi.spyOn(api, "debugStart");
    await wrapper.get('[data-testid="launch-kind"]').setValue("case");
    await wrapper.get('[data-testid="launch-target"]').setValue(true);
    await flushPromises();
    expect(button.attributes("disabled")).toBeUndefined();
    await button.trigger("click"); await flushPromises();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toMatchObject({ mode: "case", environmentId: second.id });
  });

  it("keeps late archive and debug receipts off a different launch target", async () => {
    const { wrapper, api, collectionNode, run } = await mountRunView();
    const button = wrapper.get('[data-testid="run-btn"]'), kind = wrapper.get('[data-testid="launch-kind"]');
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const normal = api.runCollection.bind(api);
    const moduleRun = vi.spyOn(api,"runCollection").mockImplementation(async input => { await pending; return normal(input); });
    await chooseModule(wrapper, collectionNode.id); await flushPromises(); await button.trigger("click");
    await vi.waitFor(() => expect(moduleRun).toHaveBeenCalledTimes(1));
    await kind.setValue("case"); finish();
    await vi.waitFor(() => expect(run.result).toBeTruthy());
    expect(wrapper.find('[data-testid="launch-open-record"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="run-summary"]').exists()).toBe(false);
    const normalWait = api.debugWait.bind(api);
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const debugWait = vi.spyOn(api,"debugWait").mockImplementation(async input => {
      await waiting; return {...await normalWait(input), historyId:"exact-history-entry"};
    });
    await wrapper.get('[data-testid="launch-target"]').setValue(true); await flushPromises(); await button.trigger("click");
    await vi.waitFor(() => expect(debugWait).toHaveBeenCalledTimes(1));
    expect(wrapper.find('[data-testid="launch-cancel"]').exists()).toBe(true);
    await wrapper.get('[data-testid="launch-clear"]').trigger("click");
    expect(wrapper.find('[data-testid="launch-cancel"]').exists()).toBe(false);
    expect(button.attributes("disabled")).toBeDefined();
    await kind.setValue("suite"); finish(); await vi.waitFor(() => expect(run.caseRunning).toBe(false));
    expect(wrapper.find('[data-testid="launch-open-debug"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("通过 1 条");
  });

  it("keeps a finished module's archive under records when the project environment changes", async () => {
    const { wrapper, api, workspace, project, collectionNode, run } = await mountRunView();
    const added = await api.envCreate({locator:project.locator,name:"Linux"});
    await workspace.refresh(); await flushPromises();
    const submit = vi.spyOn(api,"runCollection");
    await chooseModule(wrapper,collectionNode.id); await flushPromises();
    await wrapper.get('[data-testid="run-btn"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="launch-open-record"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="run-summary"]').exists()).toBe(true);
    await wrapper.setProps({environmentId:added.id}); await flushPromises();
    expect(wrapper.find('[data-testid="launch-open-record"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="run-summary"]').exists()).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    await wrapper.get('[data-testid="runs-history-btn"]').trigger("click"); await flushPromises();
    expect(wrapper.find('.record-row').exists()).toBe(true); expect(run.result).toBeTruthy();
  });

  it("previews single cases without loading an editor, fences old scope and captures exactly one explicit start", async () => {
    const { wrapper, api, workspace, project, collectionNode } = await mountRunView();
    const editor = wrapper.props("editor"), before = editor.activeKey;
    const debugStart = vi.spyOn(api, "debugStart");
    await wrapper.get('[data-testid="launch-kind"]').setValue("case"); await flushPromises();
    await wrapper.get('[data-testid="launch-target"]').setValue(true); await flushPromises();
    expect(debugStart).toHaveBeenCalledTimes(0);
    expect(editor.activeKey).toBe(before);
    await api.envCreate({ locator: project.locator, name: "added after preview" });
    const button = wrapper.get('[data-testid="run-btn"]');
    await button.trigger("click"); await flushPromises();
    expect(debugStart).toHaveBeenCalledTimes(0); expect(wrapper.text()).toContain("请核对更新后的预览");
    await Promise.all([button.trigger("click"), button.trigger("click")]); await flushPromises();
    expect(debugStart).toHaveBeenCalledTimes(1);
    const [invocation, context] = debugStart.mock.calls[0]!;
    expect(invocation).toMatchObject({mode:"case",locator:{collectionId:collectionNode.id},case:{scope:"base"}});
    expect(context).toMatchObject({project:project.locator,root:workspace.root});
    expect(editor.activeKey).toBe(before);
  });

  it("previews and launches a saved suite while keeping another suite draft intact", async () => {
    const { wrapper, api, workspace, project } = await mountRunView();
    const testing = wrapper.props("testing");
    await testing.activate(workspace.root, project.locator);
    await testing.newSuite("Saved suite"); testing.suite!.selection = {kind:"query"}; await testing.save();
    const id = testing.suite!.id;
    await testing.newSuite("Unrelated draft");
    await workspace.refresh(); await flushPromises();
    const run = vi.spyOn(api,"runSuite").mockImplementation(async input => ({context:input.context, invocationId:input.invocationId, result:runReport(), archiveFile:"suite-run-captured.json"}));
    await wrapper.get('[data-testid="launch-kind"]').setValue("suite");
    await chooseModule(wrapper, id); await flushPromises();
    expect(wrapper.text()).toContain("1 个套件条目"); expect(run).toHaveBeenCalledTimes(0);
    await wrapper.get('[data-testid="run-btn"]').trigger("click"); await flushPromises();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({locator:{suiteId:id},overrides:{allowDraft:false},expectedDataDigest:expect.stringMatching(/^sha256:/)});
    expect(testing.suite?.name).toBe("Unrelated draft"); expect(testing.dirty).toBe(true);
    expect(wrapper.get('[data-testid="launch-open-record"]').text()).toBe("查看本次运行");
  });

  it("runs an input workflow from its saved revision, and requires fresh origin consent after switching the load-test environment", async () => {
    const { wrapper, api, workspace, project } = await mountRunView();
    const first = await api.wfCreate({locator:project.locator,name:"Checkout",executionVersion:2});
    if (first.executionVersion !== 2) throw new Error("missing workflow v2");
    const where = {...project.locator,workflowId:first.id};
    await api.wfSave(where,{...first,inputs:{customer:{required:true}},nodes:[{id:"visit",kind:"noop"}]});
    await api.wfSetStatus(where,"published"); await api.wfSetStatus(where,"enabled");
    const other = await api.wfCreate({locator:project.locator,name:"Designer"});
    const design = wrapper.props("workflowDesign");
    await design.load(workspace.root,{...project.locator,workflowId:other.id});
    design.update({...design.workflow!,name:"Unsaved designer name"});
    const plan = StressPlanSchema.parse({formatVersion:1,target:{kind:"workflow",workflowId:first.id,inputs:{customer:"saved"}},load:{kind:"constant-vus",vus:1},termination:{maxIterations:1}});
    const saved = await api.stressPlansSave(project.locator,{name:"Saved checkout plan",plan});
    const env = await api.envCreate({locator:project.locator,name:"dev"});
    await workspace.refresh(); await flushPromises();
    const submit = vi.spyOn(api,"wfRun"), kind = wrapper.get('[data-testid="launch-kind"]'), button = wrapper.get('[data-testid="run-btn"]');
    await kind.setValue("workflow"); await chooseModule(wrapper,first.id); await flushPromises();
    expect(wrapper.text()).toContain("请输入 customer"); expect(button.attributes("disabled")).toBeDefined();
    await wrapper.get('.run-inputs input').setValue('"Alice"'); await flushPromises();
    await button.trigger("click"); await vi.waitFor(() => expect(design.running).toBe(false));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0]).toMatchObject({locator:where,inputs:{customer:"Alice"},root:workspace.root,previewRevision:expect.any(String)});
    expect(design.workflow?.name).toBe("Unsaved designer name"); expect(design.dirty).toBe(true);
    await kind.setValue("stress"); await flushPromises(); await chooseModule(wrapper,saved.id); await flushPromises();
    const stress = vi.spyOn(api,"stressRun").mockResolvedValue({ok:false,error:{code:"target_confirmation_required",message:"requires consent",targetOrigin:"http://127.0.0.1:8123"}});
    await button.trigger("click"); await flushPromises();
    expect(stress).toHaveBeenCalledTimes(1); expect(wrapper.text()).toContain("http://127.0.0.1:8123");
    await wrapper.setProps({environmentId:env.id}); await flushPromises();
    expect(wrapper.text()).not.toContain("http://127.0.0.1:8123");
    await button.trigger("click"); await flushPromises();
    expect(stress).toHaveBeenCalledTimes(2);
    expect(stress.mock.calls[1]![0]).toMatchObject({kind:"plan",plan:{environmentId:env.id,target:plan.target},previewRevision:expect.any(String)});
    expect(stress.mock.calls[1]![0]).not.toHaveProperty("confirmedTargetOrigins");
    expect((await api.stressPlansGet(project.locator,saved.id))?.plan).toEqual(saved.plan);
  });

  it("运行链路拒绝时经 reportError 上报（宽审查 I1 同款收口）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, collectionNode } = await mountRunView({ reportError: (e: unknown) => { errors.push(e); } });
    api.runCollection = async () => { throw new Error("boom"); };
    await chooseModule(wrapper, collectionNode.id);
    await flushPromises();
    await wrapper.find('[data-testid="run-btn"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });
});
