// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；store 工厂每调用一次即新建
// 独立 Pinia 实例，这里按组合根约定一次性装配 editor/cases 后经 props 注入被测组件。
// 本文件补任务 5 待办：CasePanel 组件测试（挂载后添加用例、保存成功路径），
// 并钉住任务 8 新增的可选 reportError 通道（case-save 拒绝不再静默吞没）。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { Input as AInput } from "ant-design-vue";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useCasesStore } from "../../../src/renderer/src/stores/cases.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";
import CasePanel from "../../../src/renderer/src/components/CasePanel.vue";
import ExtractionEditor from "../../../src/renderer/src/components/ExtractionEditor.vue";
import AssertionEditor from "../../../src/renderer/src/components/AssertionEditor.vue";
import type { Assertion } from "@apicc/core";

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
async function mountCasePanel(props: Record<string, unknown> = {}, withDebug = false) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const group = workspace.tree!.children.find((node) => node.kind === "group" && node.children.some((child) =>
    child.kind === "project" && child.children.some((item) => item.kind === "collection" && item.children.some((apiItem) => apiItem.kind === "api"))));
  if (!group || group.kind !== "group") throw new Error("Memory workspace is missing the seeded project group");
  const project = group.children.find((node) => node.kind === "project" && node.children.some((item) => item.kind === "collection" && item.children.some((apiItem) => apiItem.kind === "api")));
  if (!project || project.kind !== "project") throw new Error("Memory group is missing the seeded project");
  const collection = project.children.find((node) => node.kind === "collection");
  if (!collection || collection.kind !== "collection") throw new Error("Memory project is missing the seeded collection");
  const apiNode = collection.children.find((node) => node.kind === "api");
  if (!apiNode || apiNode.kind !== "api") throw new Error("Memory collection is missing the seeded API");
  const editor = useEditorStore(api, () => ({ root: workspace.root, readOnly: workspace.readOnly }));
  await editor.load(apiNode.locator);
  const cases = useCasesStore(api, editor);
  const debug = withDebug ? useDebugStore(api, editor, () => ({ root: workspace.root, readOnly: workspace.readOnly })) : undefined;
  const { i18n } = createI18nInstance();
  const wrapper = mount(CasePanel, {
    props: { editor, cases, ...(debug ? { debug } : {}), ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, editor, cases, debug, workspace, apiLocator: apiNode.locator };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("CasePanel", () => {
  it("G validates typed constants and clears only hidden XML namespace parse errors", async () => {
    const row: Assertion = { id: "typed", target: "bodyText", op: "length", expected: "0" };
    const { i18n } = createI18nInstance(); const panel = mount(AssertionEditor, { props: { assertions: [row] }, global: { plugins: [i18n] } });
    const validity = () => panel.emitted("validity")!.at(-1)![0];
    const field = (id: string) => panel.findAllComponents({ name: id === "assert-target" || id === "assert-op" ? "ASelect" : "AInput" }).find(component => component.attributes("data-testid") === id)!;
    for (const expected of ["", "01", "9007199254740992"]) {
      field("assert-expected").vm.$emit("update:value", expected); await flushPromises();
      expect(validity()).not.toBe("");
    }
    field("assert-expected").vm.$emit("update:value", "{{runtimeLength}}"); await flushPromises(); expect(validity()).toBe("");
    field("assert-op").vm.$emit("update:value", "in");
    field("assert-expected").vm.$emit("update:value", ""); await flushPromises(); expect(validity()).not.toBe("");
    field("assert-op").vm.$emit("update:value", "eq");
    field("assert-expected").vm.$emit("update:value", "200");
    field("assert-target").vm.$emit("update:value", "bodyXml"); await flushPromises();
    panel.findAllComponents(AInput).at(-1)!.vm.$emit("update:value", "{"); await flushPromises(); expect(validity()).not.toBe("");
    field("assert-options").vm.$emit("update:value", "{"); await flushPromises();
    field("assert-target").vm.$emit("update:value", "status"); await flushPromises(); expect(validity()).not.toBe("");
    field("assert-options").vm.$emit("update:value", "{}"); await flushPromises();
    expect(validity()).toBe(""); expect(row.namespaces).toBeUndefined();
  });
  it.each([false, true])("saves and reopens value extraction after rejecting regex (JSON error: %s)", async withJsonError => {
    const { wrapper, editor, cases, api, apiLocator } = await mountCasePanel();
    await wrapper.get('[data-testid="extraction-add"]').trigger("click");
    const extraction = wrapper.findComponent(ExtractionEditor);
    const selects = () => extraction.findAll("select");
    await selects()[2]!.setValue("regex");
    const pattern = extraction.findAll("input").find(input => input.element.parentElement?.textContent?.includes("正则模式"));
    if (!pattern) throw new Error("Expected regex pattern field");
    await pattern.setValue("(?=unsupported)");
    expect(extraction.find('[role="alert"]').exists()).toBe(true);
    const defaultValue = extraction.findAll("input").find(input => input.element.parentElement?.textContent?.includes("缺失默认值"));
    if (!defaultValue) throw new Error("Expected default JSON field");
    if (withJsonError) await defaultValue.setValue("{");
    await selects()[2]!.setValue("value");
    expect(extraction.find('[role="alert"]').exists()).toBe(withJsonError);
    await defaultValue.setValue("false");
    expect(extraction.find('[role="alert"]').exists()).toBe(false);
    let saving: Promise<void> | undefined; const save = cases.save.bind(cases); cases.save = () => (saving = save());
    await wrapper.get('[data-testid="case-save"]').trigger("click"); await saving; await flushPromises();
    const reopened = await api.apiGet(apiLocator);
    expect(reopened.api.cases[0]!.extractors).toMatchObject([{ method: "value", defaultValue: false }]);
    expect(editor.dirty).toBe(false);
  });
  it("edits structured extraction and preserves an unknown persisted operator with a visible diagnostic", async () => {
    const { wrapper, editor, api, apiLocator, cases } = await mountCasePanel();
    let saving: Promise<void> | undefined;
    const save = cases.save.bind(cases);
    cases.save = () => (saving = save());
    editor.api!.cases[0]!.assertions.push({ id: "unknown", op: "plugin.missing", target: "bodyJson", path: "$.ok", expected: "true" });
    await flushPromises();
    expect(wrapper.find('[data-testid="assertion-unknown"]').text()).toContain("plugin.missing");
    await wrapper.find('[data-testid="extraction-add"]').trigger("click");
    await wrapper.find('[data-testid="extraction-name"]').setValue("token");
    await wrapper.find('[data-testid="extraction-sensitive"]').setValue(true);
    await wrapper.find('[data-testid="case-save"]').trigger("click");
    await saving;
    await flushPromises();
    const reopened = await api.apiGet(apiLocator);
    expect(reopened.api.cases[0]!.extractors).toMatchObject([{ name: "token", method: "value", sensitive: true, required: true }]);
    expect(reopened.api.cases[0]!.assertions).toContainEqual(expect.objectContaining({ op: "plugin.missing", path: "$.ok" }));
  });
  it("只读模式禁用本地写控件并拒绝直接输入事件，同时保留运行入口", async () => {
    const { wrapper, editor } = await mountCasePanel({ readOnly: true }, true);
    const initialName = editor.api!.cases[0]!.name;
    expect((wrapper.find('[data-testid="case-add"]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.find('[data-testid="case-name"]').element as HTMLInputElement).disabled).toBe(true);
    const nameInput = wrapper.findAllComponents(AInput).find((item) => item.attributes("data-testid") === "case-name");
    if (!nameInput) throw new Error("case name input component missing");
    await nameInput.vm.$emit("update:value", "只读改名");
    expect(editor.api!.cases[0]!.name).toBe(initialName);
    expect((wrapper.find(`[data-testid="case-run-${editor.api!.cases[0]!.id}"]`).element as HTMLButtonElement).disabled).toBe(false);
  });

  it("未加载接口时渲染空态", async () => {
    const api = createMemoryApi();
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
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

  it("保存成功路径：改名后 case-save 经 caseDraftSave 持久化并复位 dirty，不改默认请求", async () => {
    const { wrapper, api, editor, apiLocator } = await mountCasePanel();
    const defaultRequest = JSON.parse(JSON.stringify(editor.api!.contract.request));
    await wrapper.find('[data-testid="case-add"]').trigger("click");
    await wrapper.findAll('[data-testid="case-name"]')[1]!.setValue("登录用例");
    expect(editor.dirty).toBe(true);
    const fullAssetSave = vi.spyOn(api, "apiSave");
    const originalCaseDraftSave = api.caseDraftSave.bind(api);
    let savePromise: ReturnType<typeof api.caseDraftSave> | null = null;
    let savedLocator: Parameters<typeof api.caseDraftSave>[0] | null = null;
    let savedCase: Parameters<typeof api.caseDraftSave>[1] | null = null;
    api.caseDraftSave = (locator, testCase, expectedRevision, deletedCases, fields) => {
      savedLocator = locator;
      savedCase = testCase;
      savePromise = originalCaseDraftSave(locator, testCase, expectedRevision, deletedCases, fields);
      return savePromise;
    };
    await wrapper.find('[data-testid="case-save"]').trigger("click");
    if (!savePromise || !savedLocator || !savedCase) throw new Error("Case save did not invoke the real CaseDraftSave boundary");
    await savePromise;
    await flushPromises();
    expect(editor.dirty).toBe(false);
    expect(editor.api!.cases[1]!.name).toBe("登录用例");
    expect(savedLocator).toMatchObject({ ...apiLocator, caseId: editor.api!.cases[1]!.id, scope: editor.api!.cases[1]!.scope });
    expect(savedCase).toMatchObject({ name: "登录用例" });
    expect(fullAssetSave).not.toHaveBeenCalled();
    const persisted = await api.apiGet(apiLocator);
    expect(persisted.api.contract.request).toEqual(defaultRequest);
    expect(persisted.api.cases[1]!.name).toBe("登录用例");
  });

  it("保存链路拒绝时经 reportError 上报（任务 8：case-save 补错误通道）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, editor, apiLocator } = await mountCasePanel({ reportError: (e: unknown) => { errors.push(e); } });
    const defaultRequest = JSON.parse(JSON.stringify(editor.api!.contract.request));
    editor.api!.cases[0]!.name = "尚未保存的名称";
    expect(editor.dirty).toBe(true);
    const fullAssetSave = vi.spyOn(api, "apiSave");
    api.caseDraftSave = async () => { throw new Error("保存失败（测试注入）"); };
    await wrapper.find('[data-testid="case-save"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("保存失败（测试注入）");
    expect(editor.dirty).toBe(true);
    expect(fullAssetSave).not.toHaveBeenCalled();
    const persisted = await api.apiGet(apiLocator);
    expect(persisted.api.contract.request).toEqual(defaultRequest);
    expect(persisted.api.cases[0]!.name).not.toBe("尚未保存的名称");
  });

  it("applies the current debug draft only to the selected saved case and blocks pending fields", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, editor, cases, debug, workspace, apiLocator } = await mountCasePanel({ reportError: (e: unknown) => { errors.push(e); } }, true);
    if (!debug) throw new Error("Expected debug store in this case-draft fixture");
    const caseDraftSaveCalls: unknown[][] = [];
    const caseDraftSaveTasks: Promise<unknown>[] = [];
    const caseDraftSaveResults: unknown[] = [];
    const originalCaseDraftSave = api.caseDraftSave.bind(api);
    api.caseDraftSave = async (...args) => {
      caseDraftSaveCalls.push(args);
      const task = originalCaseDraftSave(...args);
      caseDraftSaveTasks.push(task);
      const result = await task;
      caseDraftSaveResults.push(result);
      return result;
    };
    const targetBefore = JSON.parse(JSON.stringify(editor.api!.cases[0]!)) as NonNullable<typeof editor.api>["cases"][number];
    const other = cases.addCase({ name: "other case", scope: "base" });
    await cases.save();
    cases.select(targetBefore.id, targetBefore.scope);
    const formalRequestBefore = await api.apiGet(apiLocator);

    const draftRequest = JSON.parse(JSON.stringify(editor.api!.contract.request)) as NonNullable<typeof editor.api>["contract"]["request"];
    draftRequest.path = "/needs-input";
    const explicitSettings = { headersTimeoutMs: 4321, followRedirects: false, maxRedirects: 1 };
    const invocation = {
      mode: "request" as const,
      locator: apiLocator,
      request: draftRequest,
      parameters: { account: "[REDACTED]", region: "qa" },
      fields: [
        { path: "request.path", status: "redacted" as const, needsInput: true },
        { path: "parameters.account", status: "redacted" as const, needsInput: true },
      ],
      settings: explicitSettings,
    };
    expect(debug.applyRestore(invocation, true, editor)).toBe(true);
    const sourceGeneration = editor.sessions[editor.activeKey!]!.generation;
    expect(debug.restoredTargetGeneration).toBe(sourceGeneration);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await wrapper.find('[data-testid="case-apply-debug-draft"]').trigger("click");
      await flushPromises();
      expect(confirmSpy).toHaveBeenCalledOnce();
      expect(confirmSpy.mock.calls[0]?.[0]).toContain(targetBefore.name);
      const target = editor.api!.cases.find((testCase) => testCase.id === targetBefore.id && testCase.scope === targetBefore.scope)!;
      expect(target).toMatchObject({
        id: targetBefore.id,
        scope: targetBefore.scope,
        name: targetBefore.name,
        assertions: targetBefore.assertions,
        preOperations: targetBefore.preOperations,
        postOperations: targetBefore.postOperations,
        requestOverride: draftRequest,
        parameters: invocation.parameters,
        requestSettingsOverride: explicitSettings,
      });
      expect(editor.api!.cases.find((testCase) => testCase.id === other.id && testCase.scope === other.scope)).toEqual(other);
      const formalBeforeSave = await api.apiGet(apiLocator);
      expect(formalBeforeSave.api.contract.request).toEqual(formalRequestBefore.api.contract.request);
      expect(formalBeforeSave.api.cases.find((testCase) => testCase.id === targetBefore.id && testCase.scope === targetBefore.scope)).toEqual(targetBefore);

      debug.repairRestoredField("request.path", "/source-repaired", editor);
      expect(target.requestOverride?.path).toBe("/needs-input");

      await wrapper.find('[data-testid="case-save"]').trigger("click");
      await flushPromises();
      const firstPendingSave = caseDraftSaveTasks.at(-1);
      if (!firstPendingSave) throw new Error("Case save did not invoke CaseDraftSave for the pending request field");
      await expect(firstPendingSave).rejects.toThrow(/complete|补齐|needs input/i);
      await flushPromises();
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toMatch(/补齐|pending|complete/i);

      await wrapper.get('[data-testid="case-request-override-json"]').setValue(JSON.stringify({ ...target.requestOverride, path: "/case-repaired" }));
      await wrapper.find('[data-testid="case-save"]').trigger("click");
      await flushPromises();
      const secondPendingSave = caseDraftSaveTasks.at(-1);
      if (!secondPendingSave) throw new Error("Case save did not invoke CaseDraftSave for the pending parameter field");
      await expect(secondPendingSave).rejects.toThrow(/complete|补齐|needs input/i);
      await flushPromises();
      expect(errors).toHaveLength(2);
      expect((errors[1] as Error).message).toMatch(/补齐|pending|complete/i);

      target.parameters.account = "case-account";
      expect(target).toMatchObject({ requestOverride: { ...draftRequest, path: "/case-repaired" }, parameters: { account: "case-account", region: "qa" }, requestSettingsOverride: explicitSettings });
      await wrapper.find('[data-testid="case-save"]').trigger("click");
      await flushPromises();
      const finalSave = caseDraftSaveTasks.at(-1);
      if (!finalSave) throw new Error("Case save did not invoke CaseDraftSave after repairing both fields");
      await expect(finalSave).resolves.toMatchObject({ testCase: { id: targetBefore.id } });
      await flushPromises();
      expect(errors).toHaveLength(2);
      expect(caseDraftSaveCalls.at(-1)?.[0]).toMatchObject({ caseId: targetBefore.id, scope: targetBefore.scope });
      expect(caseDraftSaveCalls.at(-1)?.[1]).toMatchObject({ requestOverride: { ...draftRequest, path: "/case-repaired" }, parameters: { account: "case-account", region: "qa" }, requestSettingsOverride: explicitSettings });
      expect(caseDraftSaveResults.at(-1)).toMatchObject({ testCase: { id: targetBefore.id, requestOverride: { ...draftRequest, path: "/case-repaired" }, parameters: { account: "case-account", region: "qa" }, requestSettingsOverride: explicitSettings } });
      const formalAfterSave = await api.apiGet(apiLocator);
      expect(formalAfterSave.api.contract.request).toEqual(formalRequestBefore.api.contract.request);
      expect(formalAfterSave.api.cases.find((testCase) => testCase.id === targetBefore.id && testCase.scope === targetBefore.scope)).toMatchObject({
        id: targetBefore.id,
        scope: targetBefore.scope,
        requestOverride: { ...draftRequest, path: "/case-repaired" },
        parameters: { account: "case-account", region: "qa" },
        requestSettingsOverride: explicitSettings,
      });
      expect(formalAfterSave.api.cases.find((testCase) => testCase.id === other.id && testCase.scope === other.scope)).toEqual(other);

      const projectLocator = { workspaceId: apiLocator.workspaceId, groupId: apiLocator.groupId, projectId: apiLocator.projectId };
      editor.evictProject(projectLocator, workspace.root);
      await editor.load(apiLocator);
      expect(editor.sessions[editor.activeKey!]!.generation).not.toBe(sourceGeneration);
      cases.select(targetBefore.id, targetBefore.scope);
      const reloadedTarget = editor.api!.cases.find((testCase) => testCase.id === targetBefore.id && testCase.scope === targetBefore.scope)!;
      await wrapper.find('[data-testid="case-apply-debug-draft"]').trigger("click");
      await flushPromises();
      expect(reloadedTarget.requestOverride).toEqual(formalRequestBefore.api.contract.request);
      await wrapper.find('[data-testid="case-save"]').trigger("click");
      await flushPromises();
      expect(errors).toHaveLength(2);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("captures the full case target before debugStart and refuses to wait after root changes without auto-saving", async () => {
    const { wrapper, api, editor, debug, workspace, apiLocator } = await mountCasePanel({}, true);
    if (!debug) throw new Error("Expected debug store in this case-run fixture");
    editor.api!.documentation = "dirty before run";
    const startStarted = deferred<void>();
    const startGate = deferred<void>();
    let startedInvocation: Parameters<typeof api.debugStart>[0] | null = null;
    api.debugStart = async (invocation) => {
      startedInvocation = invocation;
      startStarted.resolve();
      await startGate.promise;
      return { runId: "late-case-run" };
    };
    const debugWait = vi.spyOn(api, "debugWait");
    const debugCancel = vi.spyOn(api, "debugCancel");
    const fullAssetSave = vi.spyOn(api, "apiSave");
    const caseDraftSave = vi.spyOn(api, "caseDraftSave");
    const caseId = editor.api!.cases[0]!.id;
    const scope = editor.api!.cases[0]!.scope;
    const initialRoot = workspace.root;
    await wrapper.get(`[data-testid="case-run-${caseId}"]`).trigger("click");
    await startStarted.promise;
    if (!startedInvocation) throw new Error("Case run did not invoke DebugStart");
    expect(debug.sending).toBe(true);
    expect(startedInvocation).toMatchObject({
      mode: "case",
      locator: apiLocator,
      case: { ...apiLocator, caseId, scope },
    });
    expect(fullAssetSave).not.toHaveBeenCalled();
    expect(caseDraftSave).not.toHaveBeenCalled();
    expect(workspace.root).toBe(initialRoot);
    workspace.root = `${initialRoot}-copied`;
    startGate.resolve();
    await vi.waitFor(() => expect(debug.sending).toBe(false));
    expect(debugCancel).toHaveBeenCalledWith({ runId: "late-case-run" });
    expect(debugWait).not.toHaveBeenCalled();
    expect(debug.activeRunId).toBeNull();
    expect(debug.results).toEqual({});
    expect(editor.dirty).toBe(true);
  });
});
