// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；store 按组合根约定一次性装配后
// 经 props 注入被测组件（组件内部禁止重复调用工厂）。antd message 传送门渲染于
// document.body，导出成功文案用 body 级文本断言。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { Input as AInput } from "ant-design-vue";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import type { ApiLocator } from "../../../src/shared/locations.js";
import type { ComponentAsset, ModelAsset } from "@apicc/core";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDesignStore } from "../../../src/renderer/src/stores/design.js";
import DesignPanel from "../../../src/renderer/src/components/DesignPanel.vue";

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

/** 显式装配辅助（组合根约定的测试形态）：editor 加载接口后创建 design store 注入组件。 */
async function mountDesignPanel(
  props: Record<string, unknown> = {},
  prepareAssets?: (api: ReturnType<typeof createMemoryApi>, locator: ApiLocator) => Promise<{ models: ModelAsset[]; components: ComponentAsset[] }>,
) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open(await api.wsPickDirectory());
  const group = workspace.tree!.children.find((node) => node.kind === "group" && node.children.some((child) =>
    child.kind === "project" && child.children.some((item) => item.kind === "collection" && item.children.some((apiItem) => apiItem.kind === "api"))));
  if (!group || group.kind !== "group") throw new Error("Memory workspace is missing the seeded project group");
  const project = group.children.find((node) => node.kind === "project" && node.children.some((item) => item.kind === "collection" && item.children.some((apiItem) => apiItem.kind === "api")));
  if (!project || project.kind !== "project") throw new Error("Memory group is missing the seeded project");
  const collection = project.children.find((node) => node.kind === "collection");
  if (!collection || collection.kind !== "collection") throw new Error("Memory project is missing the seeded collection");
  const apiNode = collection.children.find((node) => node.kind === "api");
  if (!apiNode || apiNode.kind !== "api") throw new Error("Memory collection is missing the seeded API");
  const assets = await prepareAssets?.(api, apiNode.locator);
  const editor = useEditorStore(api, () => ({ root: workspace.root, readOnly: workspace.readOnly }));
  await editor.load(apiNode.locator);
  const design = useDesignStore(api, editor);
  const { i18n } = createI18nInstance();
  const wrapper = mount(DesignPanel, {
    props: { editor, design, workspace, ...(assets ? { assets } : {}), ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, editor, design };
}

async function clickTeleported(testId: string): Promise<void> {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`Expected teleported ${testId} button`);
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
}

describe("DesignPanel", () => {
  it("未加载接口时渲染空态", async () => {
    const api = createMemoryApi();
    const workspace = useWorkspaceStore(api);
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const design = useDesignStore(api, editor);
    const { i18n } = createI18nInstance();
    const wrapper = mount(DesignPanel, { props: { editor, design, workspace }, global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="design-content"]').exists()).toBe(false);
  });

  it("挂载即水合当前接口设计；编辑置 dirty；保存写回并持久化", async () => {
    const { wrapper, editor, design } = await mountDesignPanel();
    // memory 预置接口未编写 design → 水合为空串
    expect(design.content).toBe("");
    await wrapper.find('[data-testid="design-content"]').setValue("校验约定：金额必须大于 0");
    expect(design.dirty).toBe(true);
    const save = editor.save.bind(editor);
    let savePromise: ReturnType<typeof save> | null = null;
    editor.save = () => (savePromise = save());
    await wrapper.find('[data-testid="design-save"]').trigger("click");
    expect(savePromise).not.toBeNull();
    await savePromise;
    await flushPromises();
    expect(design.dirty).toBe(false);
    expect(editor.api!.documentation).toBe("校验约定：金额必须大于 0");
    expect(wrapper.find('[data-testid="design-saved"]').exists()).toBe(true);
    await wrapper.find('[data-testid="design-content"]').setValue("后续编辑尚未保存");
    expect(wrapper.find('[data-testid="design-saved"]').exists()).toBe(false);
  });

  it("automatically previews the initial document view and refreshes after an edit", async () => {
    const { wrapper, api, design } = await mountDesignPanel();
    expect(design.previewStatus).toBe("ready");

    let previewCalls = 0;
    const preview = api.designPreview.bind(api);
    api.designPreview = async (input) => {
      previewCalls += 1;
      return preview(input);
    };
    vi.useFakeTimers();
    try {
      await wrapper.get('[data-testid="design-content"]').setValue("same-session edit");
      expect(design.previewStatus).toBe("idle");
      await vi.advanceTimersByTimeAsync(180);
      await flushPromises();
      expect(previewCalls).toBe(1);
      expect(design.previewStatus).toBe("ready");
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  it("hides a previous saved indicator when the next save fails", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, editor } = await mountDesignPanel({ reportError: (error: unknown) => errors.push(error) });
    const save = editor.save.bind(editor);
    let savePromise: ReturnType<typeof save> | null = null;
    editor.save = () => (savePromise = save());
    await wrapper.get('[data-testid="design-content"]').setValue("first saved value");
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    expect(savePromise).not.toBeNull();
    await savePromise;
    await flushPromises();
    expect(errors).toEqual([]);
    expect(wrapper.find('[data-testid="design-saved"]').exists()).toBe(true);

    api.apiSave = async () => { throw new Error("synthetic save failure"); };
    await wrapper.get('[data-testid="design-content"]').setValue("failed save value");
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect(wrapper.find('[data-testid="design-saved"]').exists()).toBe(false);
  });

  it("契约视图编辑当前接口并通过原保存链路持久化，不发送调试请求", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, editor } = await mountDesignPanel({ reportError: (error: unknown) => errors.push(error) });
    const sessionKey = editor.activeKey!;
    const sessionGeneration = editor.sessions[sessionKey]!.generation;
    const editorActions: string[] = [];
    editor.$onAction(({ name }) => { editorActions.push(name); });
    let sends = 0;
    let saves = 0;
    const submittedNames: string[] = [];
    const originalSave = api.apiSave.bind(api);
    api.apiSave = (...args) => { saves += 1; submittedNames.push(args[1].contract.metadata.name); return originalSave(...args); };
    const editorSave = editor.save.bind(editor);
    let savePromise: ReturnType<typeof editorSave> | null = null;
    editor.save = () => (savePromise = editorSave());
    api.debugSend = async () => {
      sends += 1;
      throw new Error("design must not send a debug request");
    };

    await wrapper.get('[data-testid="design-contract-tab"]').trigger("click");
    await wrapper.get('[data-testid="design-api-name"]').setValue("契约视图更新的名称");
    expect(editor.api!.contract.metadata.name).toBe("契约视图更新的名称");
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    expect(savePromise).not.toBeNull();
    await savePromise;
    await flushPromises();

    expect(errors).toEqual([]);
    expect(saves).toBe(1);
    expect(editorActions).toContain("save");
    expect(submittedNames).toEqual(["契约视图更新的名称"]);
    expect(editor.activeKey).toBe(sessionKey);
    expect(editor.sessions[sessionKey]!.generation).toBe(sessionGeneration);
    expect(editor.api!.contract.metadata.name).toBe("契约视图更新的名称");
    expect(editor.api).toEqual(JSON.parse(editor.snapshot));
    expect(editor.dirty).toBe(false);
    expect(sends).toBe(0);
  });

  it("无效 JSON 在切换预览后仍保留原文，并阻止预览与保存旧对象", async () => {
    const { wrapper, api, editor, design } = await mountDesignPanel();
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("The seeded API must use HTTP");
    request.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
    editor.api!.contract.responses = [{
      kind: "inline", id: "00000000-0000-4000-8000-000000000091", status: "200", description: "",
      headers: {}, content: { "application/json": { examples: [{ kind: "inline", id: "00000000-0000-4000-8000-000000000092", name: "ok", value: { ok: true } }] } },
    }];
    let previewCalls = 0;
    let saveCalls = 0;
    api.designPreview = async () => {
      previewCalls += 1;
      throw new Error("invalid editor text must not be previewed as the old object");
    };
    api.apiSave = async () => {
      saveCalls += 1;
      throw new Error("invalid editor text must not save the old object");
    };

    await wrapper.get('[data-testid="design-contract-tab"]').trigger("click");
    await wrapper.get('[data-testid="schema-default"]').setValue("not-json");
    expect(wrapper.get('[data-testid="schema-default"]').attributes("aria-invalid")).toBe("true");
    expect(wrapper.find('[data-testid="schema-annotation-error-default"]').exists()).toBe(true);
    await wrapper.get('[data-testid="response-example-0-0"]').setValue("not-response-json");
    expect(wrapper.get('[data-testid="response-example-0-0"]').attributes("aria-invalid")).toBe("true");

    await wrapper.get('[data-testid="design-document-tab"]').trigger("click");
    await flushPromises();
    expect(design.previewStatus).toBe("invalid");
    expect(previewCalls).toBe(0);

    await wrapper.get('[data-testid="design-contract-tab"]').trigger("click");
    expect((wrapper.get('[data-testid="schema-default"]').element as HTMLTextAreaElement).value).toBe("not-json");
    expect(wrapper.find('[data-testid="schema-annotation-error-default"]').exists()).toBe(true);
    expect((wrapper.get('[data-testid="response-example-0-0"]').element as HTMLTextAreaElement).value).toBe("not-response-json");
    expect(wrapper.get('[data-testid="response-example-0-0"]').attributes("aria-invalid")).toBe("true");
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    await flushPromises();
    expect(saveCalls).toBe(0);
    expect((editor.api!.contract.request as Extract<typeof request, { protocol: "http" }>).body).toMatchObject({
      kind: "json",
      schema: { kind: "scalar", type: "string" },
    });
  });

  it("删除 schema variant 后清除被删 owner，并把仍存在 variant 的原文/错误迁到新索引", async () => {
    const saveErrors: unknown[] = [];
    const { wrapper, api, editor, design } = await mountDesignPanel({ reportError: (error: unknown) => saveErrors.push(error) });
    const originalDesignSave = design.save.bind(design);
    let designSavePromise: Promise<void> | null = null;
    design.save = () => (designSavePromise = originalDesignSave());
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("The seeded API must use HTTP");
    const submittedBodies: unknown[] = [];
    const apiSave = api.apiSave.bind(api);
    let apiSavePromise: ReturnType<typeof apiSave> | null = null;
    api.apiSave = (locator, asset, revision) => {
      submittedBodies.push(asset.contract.request);
      return (apiSavePromise = apiSave(locator, asset, revision));
    };
    request.body = {
      kind: "json",
      content: "{}",
      schema: { kind: "oneOf", variants: [
        { kind: "scalar", type: "string" },
        { kind: "scalar", type: "string" },
      ] },
    };

    await wrapper.get('[data-testid="design-contract-tab"]').trigger("click");
    const defaults = wrapper.findAll('[data-testid="schema-default"]');
    expect(defaults).toHaveLength(3);
    await defaults[0]!.setValue("first-invalid");
    await defaults[1]!.setValue("second-invalid");

    const removeVariant = wrapper.findAll(".schema-editor > .nested > .property > .row > button");
    expect(removeVariant).toHaveLength(2);
    await removeVariant[0]!.trigger("click");

    const remainingDefaults = wrapper.findAll('[data-testid="schema-default"]');
    expect(remainingDefaults).toHaveLength(2);
    expect((remainingDefaults[0]!.element as HTMLTextAreaElement).value).toBe("second-invalid");
    expect(remainingDefaults[0]!.attributes("aria-invalid")).toBe("true");
    expect(design.hasInvalidControls).toBe(true);

    await remainingDefaults[0]!.setValue('"42"');
    expect(design.hasInvalidControls).toBe(false);
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    expect(apiSavePromise).not.toBeNull();
    await apiSavePromise;
    expect(designSavePromise).not.toBeNull();
    await designSavePromise;
    await flushPromises();
    expect(design.dirty).toBe(false);
    expect(design.activeControlDrafts).toEqual({});
    expect(submittedBodies).toHaveLength(1);
    expect(submittedBodies[0]).toMatchObject({ body: { kind: "json" } });
    const saved = await api.apiGet(editor.locator!);
    expect(saveErrors).toEqual([]);
    if (saved.api.contract.request.protocol !== "http" || saved.api.contract.request.body.kind !== "json") {
      throw new Error("Saved request body did not remain JSON");
    }
    expect(saved.api.contract.request.body.schema).toEqual({
      kind: "oneOf",
      variants: [{ kind: "scalar", type: "string", default: "42" }],
    });

    const correctedDefault = wrapper.get('[data-testid="schema-default"]');
    const apiSaveGate = (() => {
      let release: (() => void) | null = null;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      return { promise, release: () => release?.() };
    })();
    let pendingApiSave: ReturnType<typeof apiSave> | null = null;
    api.apiSave = (locator, asset, revision) => {
      pendingApiSave = apiSaveGate.promise.then(() => apiSave(locator, asset, revision));
      return pendingApiSave;
    };
    designSavePromise = null;
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    expect(pendingApiSave).not.toBeNull();
    expect(designSavePromise).not.toBeNull();
    await correctedDefault.setValue("invalid-after-save-start");
    const inFlightDraftPath = Object.keys(design.activeControlDrafts)[0];
    if (!inFlightDraftPath) throw new Error("Expected new raw input during the in-flight save");
    apiSaveGate.release();
    await pendingApiSave;
    await designSavePromise;
    expect(design.activeControlDrafts[inFlightDraftPath]).toMatchObject({ value: "invalid-after-save-start", error: expect.any(String) });
    expect(design.hasInvalidControls).toBe(true);
    expect(design.dirty).toBe(true);
  });

  it("删除有非法原文的 variant 后，干净 variant 不继承被删实例的本地错误", async () => {
    const { wrapper, api, editor, design } = await mountDesignPanel();
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("The seeded API must use HTTP");
    request.body = {
      kind: "json", content: "{}",
      schema: { kind: "oneOf", variants: [
        { kind: "scalar", type: "string" },
        { kind: "scalar", type: "string" },
      ] },
    };

    await wrapper.get('[data-testid="design-contract-tab"]').trigger("click");
    const defaults = wrapper.findAll('[data-testid="schema-default"]');
    await defaults[0]!.setValue("removed-variant-invalid-json");
    expect(defaults[0]!.attributes("aria-invalid")).toBe("true");
    expect(design.hasInvalidControls).toBe(true);

    await wrapper.findAll(".schema-editor > .nested > .property > .row > button")[0]!.trigger("click");
    const remainingDefaults = wrapper.findAll('[data-testid="schema-default"]');
    expect(remainingDefaults).toHaveLength(2);
    expect((remainingDefaults[0]!.element as HTMLTextAreaElement).value).toBe("");
    expect(remainingDefaults[0]!.attributes("aria-invalid")).toBeUndefined();
    expect(wrapper.find('[data-testid="schema-annotation-error-default"]').exists()).toBe(false);
    expect(design.hasInvalidControls).toBe(false);

    const apiSave = api.apiSave.bind(api);
    let savedPromise: ReturnType<typeof apiSave> | null = null;
    api.apiSave = (...args) => (savedPromise = apiSave(...args));
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    expect(savedPromise).not.toBeNull();
    await savedPromise;
    await flushPromises();
    const saved = await api.apiGet(editor.locator!);
    if (saved.api.contract.request.protocol !== "http" || saved.api.contract.request.body.kind !== "json") {
      throw new Error("The remaining clean variant should remain a JSON body");
    }
    expect(saved.api.contract.request.body.schema).toEqual({
      kind: "oneOf", variants: [{ kind: "scalar", type: "string" }],
    });
  });

  it("删除相似 header/media 点号前缀后仍保留存活 owner，并在 A→B→A 阻止保存", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, editor, design } = await mountDesignPanel({ reportError: (error: unknown) => errors.push(error) });
    const firstLocator = editor.locator!;
    editor.api!.contract.responses = [{
      kind: "inline", id: "00000000-0000-4000-8000-000000000091", status: "200", description: "",
      headers: { X: "", "X.Trace": "" }, content: {
        "application/json": { schema: { kind: "scalar", type: "string" }, examples: [] },
        "application/json.foo": { schema: { kind: "scalar", type: "string" }, examples: [] },
      },
    }];
    let saves = 0;
    const originalSave = api.apiSave.bind(api);
    api.apiSave = (...args) => { saves += 1; return originalSave(...args); };

    await wrapper.get('[data-testid="design-contract-tab"]').trigger("click");
    const schemaDefaults = wrapper.findAll('[data-testid="schema-default"]');
    expect(schemaDefaults).toHaveLength(2);
    await schemaDefaults[1]!.setValue("invalid-media-json");
    expect(design.hasInvalidControls).toBe(true);
    await wrapper.findAll(".media header button")[0]!.trigger("click");
    expect(design.hasInvalidControls).toBe(true);
    expect(wrapper.get('[data-testid="schema-default"]').attributes("aria-invalid")).toBe("true");

    await wrapper.get('[data-testid="response-header-name-0-1"]').setValue(" ");
    expect(wrapper.find('[data-testid="response-header-error"]').exists()).toBe(true);
    await wrapper.get('[data-testid="response-header-remove-0-0"]').trigger("click");
    const remainingHeader = wrapper.get('[data-testid="response-header-name-0-0"]');
    expect((remainingHeader.element as HTMLInputElement).value).toBe(" ");
    expect(remainingHeader.attributes("aria-invalid")).toBe("true");
    expect(design.hasInvalidControls).toBe(true);

    const created = await api.nodeCreate({
      kind: "api",
      parent: {
        workspaceId: firstLocator.workspaceId,
        groupId: firstLocator.groupId,
        projectId: firstLocator.projectId,
        collectionId: firstLocator.collectionId,
        ...(firstLocator.folderIds.length > 0 ? { folderIds: [...firstLocator.folderIds] } : {}),
      },
      api: { name: "Second response draft API" },
    });
    if (created.kind !== "api") throw new Error("Expected a second API for the session-switch check");
    await editor.load(created.locator);
    await flushPromises();
    await editor.load(firstLocator);
    await flushPromises();

    const restoredHeader = wrapper.get('[data-testid="response-header-name-0-0"]');
    expect((restoredHeader.element as HTMLInputElement).value).toBe(" ");
    expect(restoredHeader.attributes("aria-invalid")).toBe("true");
    expect((wrapper.get('[data-testid="schema-default"]').element as HTMLTextAreaElement).value).toBe("invalid-media-json");
    expect(wrapper.get('[data-testid="schema-default"]').attributes("aria-invalid")).toBe("true");
    expect(design.hasInvalidControls).toBe(true);
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    await flushPromises();
    expect(saves).toBe(0);
    expect(editor.api!.contract.responses[0]).toMatchObject({ headers: { "X.Trace": "" }, content: { "application/json.foo": { schema: { kind: "scalar", type: "string" } } } });
    expect(errors).toHaveLength(1);
  });

  it("正式参数与 Body 结构字段经保存后可重开", async () => {
    let modelId = "";
    let queryComponentId = "";
    const savePromises: Array<ReturnType<ReturnType<typeof createMemoryApi>["apiSave"]>> = [];
    const { wrapper, api, editor } = await mountDesignPanel({}, async (api, locator) => {
      const projectLocator = { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
      const model = await api.modelCreate(projectLocator, {
        name: "CursorModel", description: "", schema: { kind: "scalar", type: "integer" },
      });
      modelId = model.id;
      const queryComponent = await api.componentCreate(projectLocator, {
        name: "Query cursor", description: "", kind: "parameter",
        definition: { location: "query", name: "cursor", schema: { kind: "modelRef", modelId }, required: true, description: "Reusable cursor" },
      });
      queryComponentId = queryComponent.id;
      const headerComponent = await api.componentCreate(projectLocator, {
        name: "Header trace", description: "", kind: "parameter",
        definition: { location: "header", name: "X-Trace", schema: { kind: "scalar", type: "string" }, required: false, description: "Trace header" },
      });
      if (queryComponent.kind !== "parameter" || headerComponent.kind !== "parameter") throw new Error("Expected parameter components from the project asset fixture");
      return { models: [model], components: [queryComponent, headerComponent] };
    });
    const originalSave = api.apiSave.bind(api);
    api.apiSave = (...args) => {
      const promise = originalSave(...args);
      savePromises.push(promise);
      return promise;
    };
    const locator = editor.locator!;
    const root = editor.sessions[editor.activeKey!]!.root;
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("The seeded API must use HTTP");
    request.query = [];

    await wrapper.get('[data-testid="design-contract-tab"]').trigger("click");
    await wrapper.get('[data-testid="design-add-parameter-query"]').trigger("click");
    const componentBinding = wrapper.get('[data-testid="design-parameter-component-query-0"]');
    const offeredComponents = componentBinding.findAll("option").map((option) => option.text());
    expect(offeredComponents).toContain("Query cursor");
    expect(offeredComponents).not.toContain("Header trace");
    await componentBinding.setValue(queryComponentId);
    expect(editor.api!.contract.request.protocol === "http" && editor.api!.contract.request.query[0]).toMatchObject({
      kind: "componentRef", componentId: queryComponentId,
    });
    await componentBinding.setValue("");

    const query = editor.api!.contract.request;
    if (query.protocol !== "http" || query.query[0]?.kind !== "inline") throw new Error("Parameter did not switch back to inline");
    expect(query.query[0]).toMatchObject({ name: "cursor", description: "Reusable cursor", required: true });
    expect(query.query[0]!.schema).toEqual({ kind: "modelRef", modelId });
    await wrapper.get('[data-testid="design-parameter-name-query-0"]').setValue("cursor-id");
    await wrapper.get('[data-testid="design-parameter-description-query-0"]').setValue("Cursor identifier");
    await wrapper.get('[data-testid="design-parameter-enabled-query-0"]').setValue(false);

    await wrapper.get('[data-testid="design-body-kind"]').setValue("multipart");
    await wrapper.get('[data-testid="design-body-add-entry"]').trigger("click");
    await wrapper.get('[data-testid="design-body-entry-kind-0"]').setValue("file");
    await wrapper.get('[data-testid="design-body-entry-name-0"]').setValue("attachment");
    await wrapper.get('[data-testid="design-body-entry-path-0"]').setValue("C:/fixtures/report.csv");
    await wrapper.get('[data-testid="design-body-entry-filename-0"]').setValue("report.csv");
    await wrapper.get('[data-testid="design-body-entry-content-type-0"]').setValue("text/csv");
    await wrapper.get('[data-testid="design-body-entry-enabled-0"]').setValue(false);
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    expect(savePromises).toHaveLength(1);
    await savePromises[0];
    await flushPromises();
    const multipartSaved = await api.apiGet(locator);
    expect(multipartSaved.api.contract.request).toMatchObject({
      protocol: "http",
      query: [{ kind: "inline", name: "cursor-id", schema: { kind: "modelRef", modelId }, description: "Cursor identifier", enabled: false }],
      body: { kind: "multipart", entries: [{ kind: "file", name: "attachment", file: { path: "C:/fixtures/report.csv" }, filename: "report.csv", contentType: "text/csv", enabled: false }] },
    });

    await wrapper.get('[data-testid="design-body-kind"]').setValue("graphql");
    await wrapper.get('[data-testid="design-graphql-operation-name"]').setValue("UpdateCursor");
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    expect(savePromises).toHaveLength(2);
    await savePromises[1];
    await flushPromises();
    expect((await api.apiGet(locator)).api.contract.request).toMatchObject({
      protocol: "http", body: { kind: "graphql", operationName: "UpdateCursor" },
    });

    const reopened = useEditorStore(api, () => ({ root, readOnly: false }));
    await reopened.load(locator);
    expect(reopened.api!.contract.request).toMatchObject({
      protocol: "http",
      query: [{ kind: "inline", name: "cursor-id", schema: { kind: "modelRef", modelId }, description: "Cursor identifier", enabled: false }],
      body: { kind: "graphql", operationName: "UpdateCursor" },
    });
  });

  it("只读模式禁用设计编辑和保存，并拒绝直接的 textarea 更新事件", async () => {
    const { wrapper, editor, design } = await mountDesignPanel({ readOnly: true });
    const initial = design.content;
    expect((wrapper.get('[data-testid="design-content"]').element as HTMLTextAreaElement).disabled).toBe(true);
    expect((wrapper.get('[data-testid="design-save"]').element as HTMLButtonElement).disabled).toBe(true);
    const textarea = wrapper.findAllComponents(AInput.TextArea)
      .find((component) => component.attributes("data-testid") === "design-content");
    if (!textarea) throw new Error("Design textarea component missing");
    textarea.vm.$emit("update:value", "must not enter a readonly draft");
    expect(design.content).toBe(initial);
    expect(design.dirty).toBe(false);
    expect(editor.api!.documentation).toBe(initial);
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    await flushPromises();
    expect(editor.api!.documentation).toBe(initial);
    expect(wrapper.find('[data-testid="design-saved"]').exists()).toBe(false);

    await wrapper.get('[data-testid="design-contract-tab"]').trigger("click");
    expect((wrapper.get('[data-testid="design-api-name"]').element as HTMLInputElement).disabled).toBe(true);
    const nameInput = wrapper.findAllComponents(AInput).find((component) => component.attributes("data-testid") === "design-api-name");
    if (!nameInput) throw new Error("Contract name input component missing");
    nameInput.vm.$emit("update:value", "readonly mutation");
    expect(editor.api!.contract.metadata.name).not.toBe("readonly mutation");
  });

  it("导出对话框按所选格式与范围导出项目文档并显示保存路径", async () => {
    const { wrapper, api, editor, design } = await mountDesignPanel();
    let received: unknown;
    let exportPromise: Promise<string> | undefined;
    const original = api.designExport.bind(api);
    api.designExport = async (input) => {
      received = input;
      return original(input);
    };
    await wrapper.find('[data-testid="design-export"]').trigger("click");
    await flushPromises();
    const htmlRadio = document.body.querySelector('input[type="radio"][value="html"]');
    if (!(htmlRadio instanceof HTMLInputElement)) throw new Error("HTML export format option is missing");
    htmlRadio.click();
    await flushPromises();
    const originalExport = design.exportDocument.bind(design);
    design.exportDocument = (...args) => (exportPromise = originalExport(...args));
    await clickTeleported("design-export-saved");
    await exportPromise;
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0)); // antd message 传送门渲染一帧
    expect(received).toMatchObject({
      sourceRoot: editor.sessions[editor.activeKey!]!.root,
      locator: editor.locator,
      format: "html",
      scope: { kind: "project" },
    });
    expect(document.body.textContent).toContain("已导出");
    expect(document.body.textContent).toContain("示例项目.html");
  });

  it("valid dirty document offers save-first and exports the newly saved snapshot", async () => {
    const { wrapper, api, design } = await mountDesignPanel();
    design.setContent("saved-before-export-document");
    let savePromise: Promise<void> | undefined;
    let exportPromise: Promise<string> | undefined;
    const originalSave = design.save.bind(design);
    const originalExport = design.exportDocument.bind(design);
    design.save = () => (savePromise = originalSave());
    design.exportDocument = (...args) => (exportPromise = originalExport(...args));

    await wrapper.get('[data-testid="design-export"]').trigger("click");
    await flushPromises();
    expect(document.body.querySelector('[data-testid="design-export-save-first"]')).not.toBeNull();
    await clickTeleported("design-export-save-first");
    await savePromise;
    await exportPromise;

    expect(design.dirty).toBe(false);
    expect(api.designExportCalls).toHaveLength(1);
    expect(api.designExportCalls[0]!.content).toContain("saved-before-export-document");
  });

  it("raw-only invalid draft is dirty, suppresses save-first, and exports only saved content", async () => {
    const { wrapper, api, design } = await mountDesignPanel();
    let saves = 0;
    const originalSave = api.apiSave.bind(api);
    api.apiSave = (...args) => { saves += 1; return originalSave(...args); };
    const rawOnlyValue = "raw-only-invalid-secret-draft";
    design.setControlDraft("contract.request.body.schema.default", rawOnlyValue, "Invalid JSON");
    expect(design.dirty).toBe(true);
    expect(design.hasInvalidControls).toBe(true);

    await wrapper.get('[data-testid="design-export"]').trigger("click");
    await flushPromises();
    expect(document.body.querySelector('[data-testid="design-export-save-first"]')).toBeNull();
    expect(document.body.textContent).toContain("导出已保存版本");
    let exportPromise: Promise<string> | undefined;
    const originalExport = design.exportDocument.bind(design);
    design.exportDocument = (...args) => (exportPromise = originalExport(...args));
    await clickTeleported("design-export-saved");
    await exportPromise;

    expect(saves).toBe(0);
    expect(api.designExportCalls).toHaveLength(1);
    expect(api.designExportCalls[0]!.content).not.toContain(rawOnlyValue);
    expect(design.dirty).toBe(true);
  });

  it("取消范围导出对话框不会生成或写入文档", async () => {
    const { wrapper, api } = await mountDesignPanel();
    await wrapper.get('[data-testid="design-export"]').trigger("click");
    await flushPromises();
    await clickTeleported("design-export-cancel");
    expect(api.designExportCalls).toHaveLength(0);
  });

  it("同 locator 的编辑器代次变化后拒绝旧导出弹窗", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, editor } = await mountDesignPanel({ reportError: (error: unknown) => errors.push(error) });
    await wrapper.get('[data-testid="design-export"]').trigger("click");
    await flushPromises();
    const session = editor.sessions[editor.activeKey!]!;
    session.generation += 1;
    await flushPromises();
    await clickTeleported("design-export-saved");

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("当前接口已变化，请为新选择重新打开导出对话框。");
    expect(api.designExportCalls).toHaveLength(0);
  });

  it("切换请求片段语言不改契约、不触发调试发送或读取凭据", async () => {
    let modelId = "";
    const { wrapper, api, editor, design } = await mountDesignPanel({}, async (api, locator) => {
      const projectLocator = { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
      const model = await api.modelCreate(projectLocator, {
        name: "Document model", description: "", schema: { kind: "scalar", type: "string" },
      });
      modelId = model.id;
      return { models: [model], components: [] };
    });
    const currentRequest = () => {
      const request = editor.sessions[editor.activeKey!]!.api.contract.request;
      if (request.protocol !== "http") throw new Error("The seeded API must use HTTP");
      return request;
    };
    currentRequest().query = [{
      kind: "inline", id: "40000000-0000-4000-8000-000000000001", name: "filter",
      schema: { kind: "modelRef", modelId }, required: false, enabled: true, description: "", value: "active",
    }];
    currentRequest().body = {
      kind: "json", content: '{"filter":"active"}', schema: { kind: "modelRef", modelId },
    };

    await wrapper.get('[data-testid="design-document-tab"]').trigger("click");
    await flushPromises();
    expect(design.previewStatus).toBe("ready");
    const readableDocument = wrapper.get('[data-testid="design-readable-document"]');
    expect(readableDocument.find('[data-testid="document-parameter-schema"]').text()).toContain("modelRef");
    expect(readableDocument.find('[data-testid="document-body-schema"]').text()).toContain("modelRef");
    expect(readableDocument.findAll(`a[href="#model-${modelId}"]`).length).toBeGreaterThanOrEqual(2);

    for (const kind of ["xml", "text"] as const) {
      currentRequest().body = { kind, content: "synthetic body", schema: { kind: "modelRef", modelId } };
      await design.preview();
      await flushPromises();
      expect(wrapper.get('[data-testid="design-readable-document"] [data-testid="document-body-schema"]').text()).toContain("modelRef");
    }
    currentRequest().body = { kind: "graphql", query: "mutation UpdateCursor { updateCursor }", operationName: "UpdateCursor" };
    expect(currentRequest().body).toMatchObject({ kind: "graphql", operationName: "UpdateCursor" });
    await design.preview();
    await flushPromises();
    expect(wrapper.get('[data-testid="design-readable-document"]').text()).toContain("UpdateCursor");
    currentRequest().body = {
      kind: "multipart",
      entries: [{ kind: "file", id: "40000000-0000-4000-8000-000000000002", name: "attachment", file: { path: "C:/synthetic/report.json" }, filename: "report.json", contentType: "application/json", enabled: true }],
    };
    await design.preview();
    await flushPromises();
    expect(wrapper.get('[data-testid="design-readable-document"]').text()).toContain("application/json");
    currentRequest().body = { kind: "json", content: '{"filter":"active"}', schema: { kind: "modelRef", modelId } };
    await design.preview();
    await flushPromises();

    const contractBefore = JSON.stringify(editor.api!.contract);
    const sessionKey = editor.activeKey!;
    const sessionGeneration = editor.sessions[sessionKey]!.generation;
    const editorDirtyBefore = editor.dirty;
    const designDirtyBefore = design.dirty;
    let credentialReads = 0;
    let sends = 0;
    api.credentialStatus = async () => {
      credentialReads += 1;
      throw new Error("snippet generation must not inspect credentials");
    };
    api.debugSend = async () => {
      sends += 1;
      throw new Error("snippet generation must not send a request");
    };

    expect(design.previewStatus).toBe("ready");
    expect(readableDocument.text()).toContain("示例接口");
    expect(readableDocument.text()).toContain("接口信息");
    expect(wrapper.get('[data-testid="snippet-language"]').element).toBeInstanceOf(HTMLSelectElement);
    expect((wrapper.get('[data-testid="snippet-language"]').element as HTMLSelectElement).value).toBe("curl-posix");
    expect(wrapper.find('[data-testid="snippet-copy"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="snippet-code"]').text()).toContain("curl");

    await wrapper.get('[data-testid="snippet-language"]').setValue("powershell");
    expect(wrapper.get('[data-testid="snippet-code"]').text()).toContain("Invoke-RestMethod");
    expect(JSON.stringify(editor.api!.contract)).toBe(contractBefore);
    expect(editor.sessions[sessionKey]!.generation).toBe(sessionGeneration);
    expect(editor.dirty).toBe(editorDirtyBefore);
    expect(design.dirty).toBe(designDirtyBefore);
    expect(credentialReads).toBe(0);
    expect(sends).toBe(0);
  });

  it("导出链路拒绝时经 reportError 上报（不静默吞没）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, design } = await mountDesignPanel({ reportError: (e: unknown) => { errors.push(e); } });
    api.designExport = async () => { throw new Error("导出失败（测试注入）"); };
    let exportPromise: Promise<string> | undefined;
    const originalExport = design.exportDocument.bind(design);
    design.exportDocument = (...args) => (exportPromise = originalExport(...args));
    await wrapper.find('[data-testid="design-export"]').trigger("click");
    await flushPromises();
    await clickTeleported("design-export-saved");
    await exportPromise?.catch(() => "");
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("导出失败（测试注入）");
  });
});
