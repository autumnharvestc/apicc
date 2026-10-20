// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useAssetsStore } from "../../../src/renderer/src/stores/assets.js";
import { useCasesStore } from "../../../src/renderer/src/stores/cases.js";
import { useDesignStore } from "../../../src/renderer/src/stores/design.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { createAiStore } from "../../../src/renderer/src/stores/ai.js";
import RequestEditor from "../../../src/renderer/src/components/RequestEditor.vue";
import CredentialEditor from "../../../src/renderer/src/components/CredentialEditor.vue";
import DesignPanel from "../../../src/renderer/src/components/DesignPanel.vue";
import CasePanel from "../../../src/renderer/src/components/CasePanel.vue";
import { contractAssetEditorFixture } from "../helpers/contract-assets.js";

const mountedWrappers: VueWrapper[] = [];
let root = "";
let fixture: Awaited<ReturnType<typeof contractAssetEditorFixture>>;

async function createEditor(current = fixture) {
  const context = { root: current.root, readOnly: false };
  const editor = useEditorStore(current.api, () => context);
  await editor.load(current.apiLocator);
  return editor;
}

async function mountRequestEditor(editor: ReturnType<typeof useEditorStore>, current = fixture, attachTo?: Element, debugOverride?: ReturnType<typeof useDebugStore>) {
  vi.spyOn(current.api, "debugPickFile").mockResolvedValue({ path: "C:/fixtures/request.json", name: "request.json", size: 42 });
  const debug = debugOverride ?? useDebugStore(current.api, editor);
  const assets = useAssetsStore(current.api, () => ({ root: current.root, readOnly: false }));
  await assets.load(current.projectLocator);
  const { i18n } = createI18nInstance();
  const wrapper = mount(RequestEditor, { attachTo, props: { editor, debug, api: current.api, assets, projectLocator: current.projectLocator }, global: { plugins: [i18n] } });
  mountedWrappers.push(wrapper);
  return wrapper;
}

async function saveEditorFromUi(wrapper: VueWrapper, editor: ReturnType<typeof useEditorStore>): Promise<void> {
  const original = editor.save.bind(editor);
  let pending: ReturnType<typeof original> | null = null;
  editor.save = () => {
    pending = original();
    return pending;
  };
  try {
    await wrapper.get('[data-testid="save-btn"]').trigger("click");
    if (!pending) throw new Error("Save button did not invoke the real editor.save action");
    await pending;
    await flushPromises();
  } finally {
    editor.save = original;
  }
}

function unmountTracked(wrapper: VueWrapper): void {
  const index = mountedWrappers.indexOf(wrapper);
  if (index >= 0) mountedWrappers.splice(index, 1);
  wrapper.unmount();
}

beforeAll(async () => {
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
  window.localStorage.setItem("apicc.locale", "zh-CN");
  root = `C:/apicc-task10b-${randomUUID()}`;
  fixture = await contractAssetEditorFixture(undefined, root);
});

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) {
    const container = wrapper.element.parentElement;
    wrapper.unmount();
    if (container?.parentElement === document.body) container.remove();
  }
  vi.restoreAllMocks();
});

describe("Contract asset editor", () => {
  it("saves a request-only draft from the dedicated editor action", async () => {
    const current = await contractAssetEditorFixture(undefined, `C:/apicc-task5-request-draft-${randomUUID()}`);
    const editor = await createEditor(current);
    const debug = useDebugStore(current.api, editor, () => ({ root: current.root, readOnly: false }));
    const wrapper = await mountRequestEditor(editor, current, undefined, debug);
    const casesBefore = JSON.parse(JSON.stringify(editor.api!.cases)) as unknown[];
    const saveDraft = vi.spyOn(editor, "saveRequestDraft");
    const saveApiDraft = vi.spyOn(current.api, "apiRequestDraftSave");
    const pathInput = wrapper.findAllComponents({ name: "AInput" })
      .find((component) => component.attributes("data-testid") === "editor-path");
    if (!pathInput) throw new Error("Request path input is missing");

    pathInput.vm.$emit("update:value", "/request-draft-only");
    await flushPromises();
    expect(editor.api!.contract.request.path).toBe("/request-draft-only");
    await wrapper.get('[data-testid="save-request-btn"]').trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));

    expect(saveDraft).toHaveBeenCalledOnce();
    expect(saveApiDraft).toHaveBeenCalledOnce();
    expect(saveApiDraft.mock.calls[0]?.[1].path).toBe("/request-draft-only");
    expect(wrapper.find('[data-testid="save-error"]').exists()).toBe(false);
    const persisted = await current.api.apiGet(current.apiLocator);
    expect(persisted.api.contract.request.path).toBe("/request-draft-only");
    expect(persisted.api.cases).toEqual(casesBefore);

    const pendingRequest = JSON.parse(JSON.stringify(editor.api!.contract.request)) as NonNullable<typeof editor.api>["contract"]["request"];
    pendingRequest.path = "/needs-input";
    expect(debug.applyRestore({
      mode: "request",
      locator: current.apiLocator,
      request: pendingRequest,
      parameters: {},
      fields: [{ path: "request.path", status: "redacted", needsInput: true }],
    }, true, editor)).toBe(true);
    await flushPromises();
    expect((wrapper.get('[data-testid="save-request-btn"]').element as HTMLButtonElement).disabled).toBe(true);
    const sourceGeneration = editor.sessions[editor.activeKey!]!.generation;
    editor.evictProject(current.projectLocator, current.root);
    await editor.load(current.apiLocator);
    expect(editor.sessions[editor.activeKey!]!.generation).not.toBe(sourceGeneration);
    await flushPromises();
    expect((wrapper.get('[data-testid="save-request-btn"]').element as HTMLButtonElement).disabled).toBe(false);
    saveDraft.mockClear();
    await wrapper.get('[data-testid="save-request-btn"]').trigger("click");
    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledOnce());
    expect(saveDraft).toHaveBeenCalledWith([]);
    await saveDraft.mock.results[0]!.value;
  });

  it("edits inline parameter schema and required at all four locations and persists them", async () => {
    const current = await contractAssetEditorFixture(undefined, `C:/apicc-task10b-parameters-${randomUUID()}`);
    const editor = await createEditor(current);
    const wrapper = await mountRequestEditor(editor, current);
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("Seed API must use HTTP for parameter editing");
    const locations = [
      { name: "path", list: request.pathParams },
      { name: "query", list: request.query },
      { name: "header", list: request.headers },
      { name: "cookie", list: request.cookies },
    ] as const;

    for (const { name, list } of locations) {
      await wrapper.get(`[data-testid="tab-${name}"]`).trigger("click");
      await flushPromises();
      const index = list.length;
      await wrapper.get(`[data-testid="add-${name}"]`).trigger("click");
      await flushPromises();
      const key = wrapper.findAll('[data-testid="kv-key"]').at(-1);
      if (!key) throw new Error(`${name}: inline parameter row did not render`);
      await key.setValue(`required_${name}`);
      await wrapper.get(`[data-testid="parameter-required-${name}-${index}"]`).setValue(true);
      await wrapper.get(`[data-testid="parameter-schema-${name}-${index}"] [data-testid="schema-scalar-type"]`).setValue("integer");
      const binding = list[index];
      expect(binding).toMatchObject({
        kind: "inline", name: `required_${name}`, required: true,
        schema: { kind: "scalar", type: "integer" },
      });
    }

    await wrapper.get('[data-testid="save-btn"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
    editor.evictProject(current.projectLocator, current.root);
    await editor.load(current.apiLocator);
    const reopened = editor.api!.contract.request;
    if (reopened.protocol !== "http") throw new Error("Saved request protocol changed");
    for (const { name, list } of [
      { name: "path", list: reopened.pathParams },
      { name: "query", list: reopened.query },
      { name: "header", list: reopened.headers },
      { name: "cookie", list: reopened.cookies },
    ]) {
      expect(list).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: "inline", name: `required_${name}`, required: true,
        schema: { kind: "scalar", type: "integer" },
      })]));
    }
  });

  it("removes urlencoded fields and creates and edits a multipart file entry through persistence", async () => {
    const current = await contractAssetEditorFixture(undefined, `C:/apicc-task10b-form-${randomUUID()}`);
    const editor = await createEditor(current);
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("Seed API must use HTTP for form editing");
    request.body = { kind: "urlencoded", fields: [
      { id: randomUUID(), name: "remove-me", value: "old", enabled: true },
      { id: randomUUID(), name: "keep-me", value: "kept", enabled: true },
    ] };
    const wrapper = await mountRequestEditor(editor, current);
    await wrapper.get('[data-testid="tab-body"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="body-remove-field-0"]').trigger("click");
    expect(request.body).toEqual({ kind: "urlencoded", fields: [expect.objectContaining({ name: "keep-me", value: "kept" })] });
    await wrapper.get('[data-testid="save-btn"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
    editor.evictProject(current.projectLocator, current.root);
    await editor.load(current.apiLocator);
    const afterUrlencodedSave = editor.api!.contract.request;
    if (afterUrlencodedSave.protocol !== "http") throw new Error("Saved request protocol changed");
    expect(afterUrlencodedSave.body).toEqual({ kind: "urlencoded", fields: [expect.objectContaining({ name: "keep-me", value: "kept" })] });

    await wrapper.get('[data-testid="tab-body"]').trigger("click");
    await flushPromises();
    await wrapper.get('input[value="multipart"]').setValue(true);
    await wrapper.get('[data-testid="body-add-field"]').trigger("click");
    await flushPromises();
    const entries = afterUrlencodedSave.body;
    if (entries.kind !== "multipart") throw new Error("Multipart editor did not create multipart body");
    const index = entries.entries.length - 1;
    await wrapper.get(`[data-testid="body-field-kind-${index}"]`).setValue("file");
    await wrapper.get(`[data-testid="body-file-pick-${index}"]`).trigger("click");
    await flushPromises();
    await wrapper.get(`[data-testid="body-file-content-type-${index}"]`).setValue("application/json");
    expect(entries.entries[index]).toMatchObject({
      kind: "file", file: { path: "C:/fixtures/request.json" }, contentType: "application/json",
    });
    await wrapper.get('[data-testid="save-btn"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
    editor.evictProject(current.projectLocator, current.root);
    await editor.load(current.apiLocator);
    const reopened = editor.api!.contract.request;
    if (reopened.protocol !== "http" || reopened.body.kind !== "multipart") throw new Error("Saved multipart request was not rehydrated");
    expect(reopened.body.entries).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "file", file: { path: "C:/fixtures/request.json" }, contentType: "application/json",
    })]));
  });

  it("edits all eight HTTP body variants through controls and saves, closes, and reopens each", async () => {
    const current = await contractAssetEditorFixture(undefined, `C:/apicc-task10b-eight-bodies-${randomUUID()}`);
    const editor = await createEditor(current);
    let wrapper = await mountRequestEditor(editor, current);
    const values: Record<string, object> = {
      none: { kind: "none" },
      json: { kind: "json", content: '{"kind":"json"}' },
      xml: { kind: "xml", content: "<body>xml</body>" },
      text: { kind: "text", content: "plain body" },
      graphql: { kind: "graphql", query: "query Task10b { item }", variables: '{"id":7}', operationName: "Task10b" },
      urlencoded: { kind: "urlencoded", fields: [expect.objectContaining({ name: "form-field", value: "saved-form" })] },
      multipart: { kind: "multipart", entries: [expect.objectContaining({ kind: "file", name: "upload", file: { path: "C:/fixtures/request.json" } })] },
      binary: { kind: "binary", file: { path: "C:/fixtures/request.json" }, contentType: "application/octet-stream" },
    };

    for (const kind of ["none", "json", "xml", "text", "graphql", "urlencoded", "multipart", "binary"] as const) {
      if (editor.api!.contract.request.protocol !== "http") throw new Error(`Expected HTTP before editing ${kind}`);
      await wrapper.get('[data-testid="tab-body"]').trigger("click");
      await wrapper.get(`input[value="${kind}"]`).setValue(true);
      await flushPromises();
      if (kind === "json" || kind === "xml" || kind === "text") {
        const content = kind === "json" ? '{"kind":"json"}' : kind === "xml" ? "<body>xml</body>" : "plain body";
        await wrapper.get('[data-testid="body-content"]').setValue(content);
      } else if (kind === "graphql") {
        await wrapper.get('[data-testid="body-graphql-query"]').setValue("query Task10b { item }");
        await wrapper.get('[data-testid="body-graphql-variables"]').setValue('{"id":7}');
        await wrapper.get('[data-testid="body-graphql-operation"]').setValue("Task10b");
      } else if (kind === "urlencoded") {
        await wrapper.get('[data-testid="body-add-field"]').trigger("click");
        await wrapper.get('[data-testid="body-field-name"]').setValue("form-field");
        await wrapper.get('[data-testid="body-field-value"]').setValue("saved-form");
      } else if (kind === "multipart") {
        await wrapper.get('[data-testid="body-add-field"]').trigger("click");
        await wrapper.get('[data-testid="body-field-name"]').setValue("upload");
        await wrapper.get('[data-testid="body-field-kind-0"]').setValue("file");
        await wrapper.get('[data-testid="body-file-pick-0"]').trigger("click");
        await flushPromises();
        await wrapper.get('[data-testid="body-file-content-type-0"]').setValue("application/octet-stream");
      } else if (kind === "binary") {
        await wrapper.get('[data-testid="body-binary-pick"]').trigger("click");
        await flushPromises();
        await wrapper.get('[data-testid="body-binary-content-type"]').setValue("application/octet-stream");
      }

      await saveEditorFromUi(wrapper, editor);
      await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
      if (editor.api!.contract.request.protocol !== "http") throw new Error(`Saved request left HTTP while checking ${kind}`);
      const expected = JSON.parse(JSON.stringify(editor.api!.contract.request.body)) as unknown;
      expect(expected).toMatchObject(values[kind]);
      unmountTracked(wrapper);
      editor.evictProject(current.projectLocator, current.root);
      await editor.load(current.apiLocator);
      const reopened = editor.api!.contract.request;
      if (reopened.protocol !== "http") throw new Error(`Reopening ${kind} changed the request protocol`);
      expect(reopened.body).toEqual(expected);
      if (kind !== "binary") wrapper = await mountRequestEditor(editor, current);
    }
  });

  it("I12: continuous response-header typing keeps stable row identity, focus, and saved values across reorder", async () => {
    const current = await contractAssetEditorFixture(undefined, `C:/apicc-task10b-response-headers-${randomUUID()}`);
    const responseAsset = current.components.find((component) => component.kind === "response");
    if (!responseAsset || responseAsset.kind !== "response") throw new Error("Response component fixture missing");
    const responseLocator = { ...current.projectLocator, componentKind: "response" as const, componentId: responseAsset.id };
    responseAsset.definition.headers = { "Content-Type": "shared/type" };
    await current.api.componentSave(responseLocator, responseAsset);
    const editor = await createEditor(current);
    editor.api!.contract.responses = [{
      kind: "inline", id: randomUUID(), status: "200", description: "ok",
      headers: { "X-Original": "one", "X-Second": "two" },
      content: { "application/json": { examples: [] } },
    }];
    const wrapper = await mountRequestEditor(editor, current, document.body);
    const firstName = wrapper.get('[data-testid="response-header-name-0-0"]');
    expect((firstName.element as HTMLInputElement).disabled).toBe(false);
    await firstName.setValue("");
    expect(wrapper.find('[data-testid="response-header-error"]').exists()).toBe(true);
    const input = firstName.element as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    for (let index = 0; index < "Content-Type".length; index += 1) {
      input.value = "Content-Type".slice(0, index + 1);
      await firstName.trigger("input");
      expect(wrapper.get('[data-testid="response-header-name-0-0"]').element).toBe(input);
      expect(document.activeElement).toBe(input);
    }
    await firstName.trigger("change");
    expect(input.value).toBe("Content-Type");

    const secondName = wrapper.get('[data-testid="response-header-name-0-1"]');
    const secondInput = secondName.element as HTMLInputElement;
    secondInput.focus();
    expect(document.activeElement).toBe(secondInput);
    for (const value of ["1", "1A"]) {
      secondInput.value = value;
      await secondName.trigger("input");
      expect(wrapper.get('[data-testid="response-header-name-0-1"]').element).toBe(secondInput);
      expect(document.activeElement).toBe(secondInput);
      expect((wrapper.get('[data-testid="response-header-name-0-0"]').element as HTMLInputElement).value)
        .toBe("Content-Type");
    }
    await secondName.trigger("change");
    expect(secondInput.value).toBe("1A");
    await wrapper.get('[data-testid="response-header-value-0-0"]').setValue("application/json");
    await secondName.setValue("content-type");
    expect(wrapper.find('[data-testid="response-header-error"]').exists()).toBe(true);
    await secondName.setValue("1A");
    await secondName.trigger("change");
    const inline = editor.api!.contract.responses[0];
    if (!inline || inline.kind !== "inline") throw new Error("Expected inline response");
    expect(inline.headers).toEqual({ "Content-Type": "application/json", "1A": "two" });

    await wrapper.get('[data-testid="save-btn"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
    editor.evictProject(current.projectLocator, current.root);
    await editor.load(current.apiLocator);
    await flushPromises();
    const response = editor.api!.contract.responses[0];
    expect(response?.kind === "inline" ? response.headers : null)
      .toEqual({ "Content-Type": "application/json", "1A": "two" });
    await wrapper.get('[data-testid="response-header-remove-0-1"]').trigger("click");
    if (!response || response.kind !== "inline") throw new Error("Expected reopened inline response");
    expect(response.headers).toEqual({ "Content-Type": "application/json" });

    await wrapper.get('[data-testid="response-header-name-0-0"]').setValue("");
    expect(wrapper.find('[data-testid="response-header-error"]').exists()).toBe(true);
    await wrapper.get('[data-testid="response-component-0"]').setValue(responseAsset.id);
    const referencedName = wrapper.get('[data-testid="response-header-name-0-0"]').element as HTMLInputElement;
    const ownerObservations = [{
      name: referencedName.value,
      value: (wrapper.get('[data-testid="response-header-value-0-0"]').element as HTMLInputElement).value,
      disabled: referencedName.disabled,
      error: wrapper.find('[data-testid="response-header-error"]').exists(),
    }];
    expect(editor.api!.contract.responses[0]).toEqual({
      kind: "componentRef", id: response.id, componentId: responseAsset.id, expectedKind: "response",
    });
    expect(await current.api.componentGet(responseLocator).then((component) =>
      component.kind === "response" ? component.definition.headers : null)).toEqual({ "Content-Type": "shared/type" });

    // Replace the binding through props, then switch a still-mounted editor to a legal same-ID response.
    editor.api!.contract.responses = [response];
    await flushPromises();
    await wrapper.get('[data-testid="response-header-name-0-0"]').setValue("");
    const second = await current.api.apiGet(current.secondApiLocator);
    second.api.contract.responses = [{
      kind: "inline", id: response.id, status: "200", description: "second owner",
      headers: { "Content-Type": "second/type" }, content: {},
    }];
    await current.api.apiSave(current.secondApiLocator, second.api, second.sourceApiRevision);
    const responseEditorElement = wrapper.get('[data-testid="response-editor"]').element;
    await editor.load(current.secondApiLocator);
    await flushPromises();
    expect(wrapper.get('[data-testid="response-editor"]').element).toBe(responseEditorElement);
    const secondOwnerName = wrapper.get('[data-testid="response-header-name-0-0"]').element as HTMLInputElement;
    ownerObservations.push({
      name: secondOwnerName.value,
      value: (wrapper.get('[data-testid="response-header-value-0-0"]').element as HTMLInputElement).value,
      disabled: secondOwnerName.disabled,
      error: wrapper.find('[data-testid="response-header-error"]').exists(),
    });
    await wrapper.get('[data-testid="response-header-name-0-0"]').setValue("");
    await editor.load(current.apiLocator);
    await flushPromises();
    const returnedName = wrapper.get('[data-testid="response-header-name-0-0"]').element as HTMLInputElement;
    ownerObservations.push({
      name: returnedName.value,
      value: (wrapper.get('[data-testid="response-header-value-0-0"]').element as HTMLInputElement).value,
      disabled: returnedName.disabled,
      error: wrapper.find('[data-testid="response-header-error"]').exists(),
    });
    expect(response.headers).toEqual({ "Content-Type": "application/json" });
    expect(second.api.contract.responses[0]).toMatchObject({ headers: { "Content-Type": "second/type" } });
    expect(ownerObservations).toEqual([
      { name: "Content-Type", value: "shared/type", disabled: true, error: false },
      { name: "Content-Type", value: "second/type", disabled: false, error: false },
      { name: "Content-Type", value: "application/json", disabled: false, error: false },
    ]);
  });

  it("keeps a referenced response read-only and saves shared response edits only in the asset owner UI", async () => {
    const current = await contractAssetEditorFixture(undefined, `C:/apicc-task10b-shared-response-${randomUUID()}`);
    const responseAsset = current.components.find((component) => component.kind === "response");
    if (!responseAsset || responseAsset.kind !== "response") throw new Error("Response component fixture missing");
    const responseLocator = { ...current.projectLocator, componentKind: "response" as const, componentId: responseAsset.id };
    const seededResponse = await current.api.componentGet(responseLocator);
    if (seededResponse.kind !== "response") throw new Error("Response fixture had wrong component kind");
    seededResponse.definition.headers = { "X-Shared": "before" };
    seededResponse.definition.content["application/json"] = { examples: [{
      kind: "inline", id: randomUUID(), name: "Shared example", value: { ok: true },
    }] };
    await current.api.componentSave(responseLocator, seededResponse);
    const second = await current.api.apiGet(current.secondApiLocator);
    second.api.contract.responses = [{ kind: "componentRef", id: randomUUID(), componentId: responseAsset.id, expectedKind: "response" }];
    await current.api.apiSave(current.secondApiLocator, second.api, second.sourceApiRevision);

    const editor = await createEditor(current);
    const wrapper = await mountRequestEditor(editor, current);
    expect(editor.api!.contract.responses[0]).toMatchObject({ kind: "componentRef", componentId: responseAsset.id });
    const exampleRow = wrapper.get('.example');
    expect((exampleRow.get("input").element as HTMLInputElement).disabled).toBe(true);
    expect((exampleRow.get("select").element as HTMLSelectElement).disabled).toBe(true);
    expect((exampleRow.get("textarea").element as HTMLTextAreaElement).disabled).toBe(true);
    expect((wrapper.get('[data-testid="response-example-add-0-application-json"]').element as HTMLButtonElement).disabled).toBe(true);

    await wrapper.get('[data-testid="assets-panel"] summary').trigger("click");
    await wrapper.get(`[data-testid="asset-component-select-response-${responseAsset.id}"]`).trigger("click");
    const definitionField = wrapper.get('[data-testid="asset-component-definition"]');
    const candidate = JSON.parse((definitionField.element as HTMLTextAreaElement).value) as {
      definition: { headers: Record<string, string>; content: Record<string, { examples: Array<{ name: string; value: unknown }> }> };
    };
    candidate.definition.headers["X-Owner-Edit"] = "through manager";
    candidate.definition.content["application/json"]!.examples[0]!.name = "Owner saved example";
    await definitionField.setValue(JSON.stringify(candidate, null, 2));
    const componentSave = vi.spyOn(current.api, "componentSave");
    await wrapper.get('[data-testid="asset-component-save"]').trigger("click");
    const componentSaveTask = componentSave.mock.results[0]?.value as Promise<unknown> | undefined;
    if (!componentSaveTask) throw new Error("Owner save did not invoke the real componentSave API");
    await componentSaveTask;
    await vi.waitFor(() => expect(wrapper.find('[data-testid="asset-feedback"]').text()).toBe("资产已保存"));
    const savedComponent = await current.api.componentGet(responseLocator);
    expect(savedComponent.kind === "response" ? savedComponent.definition.headers : null).toMatchObject({ "X-Owner-Edit": "through manager" });

    unmountTracked(wrapper);
    editor.evictProject(current.projectLocator, current.root);
    const firstReopened = await createEditor(current);
    expect(firstReopened.api!.contract.responses[0]).toMatchObject({ kind: "componentRef", componentId: responseAsset.id });
    const firstWrapper = await mountRequestEditor(firstReopened, current);
    expect(firstWrapper.text()).toContain("200 · ok");
    const firstHeaderNames = firstWrapper.findAll('[data-testid^="response-header-name-0-"]')
      .map((input) => (input.element as HTMLInputElement).value);
    const firstOwnerHeader = firstHeaderNames.indexOf("X-Owner-Edit");
    expect(firstOwnerHeader).toBeGreaterThanOrEqual(0);
    expect((firstWrapper.get(`[data-testid="response-header-value-0-${firstOwnerHeader}"]`).element as HTMLInputElement).value)
      .toBe("through manager");
    const secondEditor = await createEditor(current);
    await secondEditor.load(current.secondApiLocator);
    expect(secondEditor.api!.contract.responses[0]).toMatchObject({ kind: "componentRef", componentId: responseAsset.id });
    const secondWrapper = await mountRequestEditor(secondEditor, current);
    expect(secondWrapper.text()).toContain("200 · ok");
    const secondHeaderNames = secondWrapper.findAll('[data-testid^="response-header-name-0-"]')
      .map((input) => (input.element as HTMLInputElement).value);
    const secondOwnerHeader = secondHeaderNames.indexOf("X-Owner-Edit");
    expect(secondOwnerHeader).toBeGreaterThanOrEqual(0);
    expect((secondWrapper.get(`[data-testid="response-header-value-0-${secondOwnerHeader}"]`).element as HTMLInputElement).value)
      .toBe("through manager");
    expect(await current.api.apiGet(current.apiLocator).then((detail) => detail.api.contract.responses[0])).toMatchObject({ componentId: responseAsset.id });
    expect(await current.api.apiGet(current.secondApiLocator).then((detail) => detail.api.contract.responses[0])).toMatchObject({ componentId: responseAsset.id });
  });

  it("edits boolean and schema-valued additionalProperties and persists the nested schema", async () => {
    const current = await contractAssetEditorFixture(undefined, `C:/apicc-task10b-additional-schema-${randomUUID()}`);
    const editor = await createEditor(current);
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("Seed API must use HTTP for schema editing");
    request.body = { kind: "json", content: "{}", schema: {
      kind: "object", properties: {}, required: [], additionalProperties: false, default: false,
    } };
    const wrapper = await mountRequestEditor(editor, current);
    await wrapper.get('[data-testid="tab-body"]').trigger("click");
    await flushPromises();
    const defaultEditor = wrapper.get('[data-testid="schema-default"]');
    expect((defaultEditor.element as HTMLTextAreaElement).value).toBe("false");
    await defaultEditor.setValue('""');
    await defaultEditor.trigger("change");
    expect(request.body).toMatchObject({ kind: "json", schema: { kind: "object", default: "" } });
    await defaultEditor.setValue("");
    await defaultEditor.trigger("change");
    if (request.body.kind !== "json" || request.body.schema?.kind !== "object") throw new Error("Edited object schema was not retained");
    expect(Object.hasOwn(request.body.schema, "default")).toBe(false);
    await defaultEditor.setValue('""');
    await defaultEditor.trigger("change");

    await wrapper.get('[data-testid="schema-property-name"]').setValue("__proto__");
    await wrapper.get('[data-testid="schema-property-add"]').trigger("click");
    if (request.body.kind !== "json" || request.body.schema?.kind !== "object") throw new Error("Edited object schema was not retained");
    expect(Object.hasOwn(request.body.schema.properties, "__proto__")).toBe(true);
    expect(request.body.schema.properties["__proto__"]).toEqual({ kind: "scalar", type: "string" });

    const mode = wrapper.get('[data-testid="schema-additional-mode"]');
    await mode.setValue("true");
    expect(request.body).toMatchObject({ kind: "json", schema: { kind: "object", additionalProperties: true } });
    await mode.setValue("schema");
    await wrapper.get('[data-testid="schema-additional-schema"] [data-testid="schema-scalar-type"]').setValue("integer");
    expect(request.body).toMatchObject({ kind: "json", schema: { kind: "object", additionalProperties: { kind: "scalar", type: "integer" } } });

    await wrapper.get('[data-testid="save-btn"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
    editor.evictProject(current.projectLocator, current.root);
    await editor.load(current.apiLocator);
    const reopened = editor.api!.contract.request;
    if (reopened.protocol !== "http" || reopened.body.kind !== "json") throw new Error("Saved JSON schema was not rehydrated");
    expect(reopened.body.schema).toMatchObject({ kind: "object", additionalProperties: { kind: "scalar", type: "integer" }, default: "" });
    if (reopened.body.schema?.kind !== "object") throw new Error("Saved object schema was not rehydrated");
    expect(Object.hasOwn(reopened.body.schema.properties, "__proto__")).toBe(true);
    expect(reopened.body.schema.properties["__proto__"]).toEqual({ kind: "scalar", type: "string" });
  });

  it("resolves project model and typed component references in the mounted editor", async () => {
    const editor = await createEditor();
    const wrapper = await mountRequestEditor(editor);
    const parameter = fixture.components.find((component) => component.kind === "parameter");
    const auth = fixture.components.find((component) => component.kind === "auth");
    const response = fixture.components.find((component) => component.kind === "response");
    const example = fixture.components.find((component) => component.kind === "example");
    if (!parameter || parameter.kind !== "parameter" || !auth || auth.kind !== "auth"
      || !response || response.kind !== "response" || !example || example.kind !== "example") throw new Error("Missing fixture components");
    const queryTab = wrapper.get('[data-testid="tab-query"]');
    await queryTab.trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="parameter-component-query-0"]').text()).toContain(parameter.name);
    expect((wrapper.get('[data-testid="response-component-0"]').element as HTMLSelectElement).value).toBe(response.id);
    const modelReferences = await fixture.api.assetReferences(fixture.projectLocator, fixture.model.id);
    expect(new Set(modelReferences.map((item) => item.ownerId))).toEqual(new Set([fixture.apiLocator.apiId, fixture.secondApiLocator.apiId]));
    expect(await fixture.api.assetReferences(fixture.projectLocator, parameter.id)).toEqual(expect.arrayContaining([expect.objectContaining({ ownerId: fixture.apiLocator.apiId })]));
    expect(await fixture.api.assetReferences(fixture.projectLocator, auth.id)).toEqual(expect.arrayContaining([expect.objectContaining({ ownerId: fixture.apiLocator.apiId })]));
    expect(await fixture.api.assetReferences(fixture.projectLocator, response.id)).toEqual(expect.arrayContaining([expect.objectContaining({ ownerId: fixture.apiLocator.apiId })]));
    expect(await fixture.api.assetReferences(fixture.projectLocator, example.id)).toEqual(expect.arrayContaining([expect.objectContaining({ ownerId: fixture.secondApiLocator.apiId })]));
    await wrapper.get('[data-testid="asset-component-select-response-' + response.id + '"]').trigger("click");
    const definitionField = wrapper.get('[data-testid="asset-component-definition"]');
    const componentDefinition = JSON.parse((definitionField.element as HTMLTextAreaElement).value) as { definition: { status: string } };
    componentDefinition.definition.status = "201";
    await definitionField.setValue(JSON.stringify(componentDefinition, null, 2));
    await wrapper.get('[data-testid="asset-component-save"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="asset-feedback"]').text()).toBe("资产已保存"));
    const savedResponse = await fixture.api.componentGet({ ...fixture.projectLocator, componentKind: "response", componentId: response.id });
    expect(savedResponse.kind === "response" ? savedResponse.definition.status : "").toBe("201");
    await flushPromises();
    expect(wrapper.text()).toContain("201 · ok");
    expect(await fixture.api.assetReferences(fixture.projectLocator, response.id)).toEqual(expect.arrayContaining([expect.objectContaining({ ownerId: fixture.apiLocator.apiId })]));
    await wrapper.get('[data-testid="asset-component-delete"]').trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="asset-error"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="asset-error"]').text()).toContain("资产仍被");
    expect(wrapper.get('[data-testid="asset-error"]').text()).toContain(fixture.apiLocator.apiId);

    const body = editor.api!.contract.request;
    if (body.protocol !== "http") throw new Error("Seed API must use HTTP for model editor test");
    body.body = { kind: "json", content: "", schema: { kind: "modelRef", modelId: fixture.model.id } };
    await wrapper.get('[data-testid="tab-body"]').trigger("click");
    await flushPromises();
    const modelEditor = wrapper.find('[data-testid="schema-model-ref"]');
    expect(modelEditor.exists()).toBe(true);
    expect((modelEditor.element as HTMLSelectElement).value).toBe(fixture.model.id);
  });

  it("edits every ApiAsset metadata field in the mounted editor and persists across slot eviction and reload", async () => {
    const editor = await createEditor();
    const wrapper = await mountRequestEditor(editor);
    await flushPromises();

    const metadataName = wrapper.get('[data-testid="asset-metadata-name"]');
    expect((metadataName.element as HTMLInputElement).value).toBe(editor.api!.contract.metadata.name);
    await metadataName.setValue("订单详情 v2");
    await wrapper.get('[data-testid="asset-metadata-description"]').setValue("完整订单明细");
    await wrapper.get('[data-testid="asset-metadata-tags"]').setValue("订单, 详情, v2");
    await wrapper.get('[data-testid="asset-metadata-version"]').setValue("2.4.1");
    const status = wrapper.findAllComponents({ name: "ASelect" })
      .find((component) => component.attributes("data-testid") === "asset-metadata-status");
    if (!status) throw new Error("ApiAsset metadata status selector is missing");
    status.vm.$emit("update:value", "published");
    await saveEditorFromUi(wrapper, editor);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
    const saveError = wrapper.find('[data-testid="save-error"]');
    expect(saveError.exists() ? saveError.text() : "").toBe("");
    expect(editor.dirty).toBe(false);

    unmountTracked(wrapper);
    editor.evictProject(fixture.projectLocator, root);
    await editor.load(fixture.apiLocator);
    expect(editor.api!.contract.metadata).toMatchObject({
      name: "订单详情 v2", description: "完整订单明细", tags: ["订单", "详情", "v2"],
      version: "2.4.1", status: "published",
    });
  });

  it("creates, edits, and reopens models and all four component kinds through the mounted asset manager", async () => {
    const current = await contractAssetEditorFixture(undefined, `C:/apicc-task10b-assets-${randomUUID()}`);
    const editor = await createEditor(current);
    const wrapper = await mountRequestEditor(editor, current);
    await wrapper.get('[data-testid="assets-panel"] summary').trigger("click");

    const modelSaveApi = vi.spyOn(current.api, "modelSave");
    const modelName = wrapper.get('[data-testid="asset-model-name"]');
    await modelName.setValue("UI edited shared model");
    await wrapper.get('[data-testid="assets-panel"] [data-testid="schema-scalar-type"]').setValue("integer");
    await wrapper.get('[data-testid="asset-model-save"]').trigger("click");
    const firstModelSave = modelSaveApi.mock.results[0]?.value as Promise<unknown> | undefined;
    if (!firstModelSave) throw new Error("Model editor did not invoke the real modelSave API");
    await firstModelSave;
    await vi.waitFor(() => expect(wrapper.find('[data-testid="asset-feedback"]').text()).toBe("资产已保存"));
    const savedModel = await current.api.modelGet({ ...current.projectLocator, modelId: current.model.id });
    expect(savedModel.name).toBe("UI edited shared model");
    expect(savedModel.schema).toMatchObject({ kind: "object", properties: { id: { kind: "scalar", type: "integer" } } });
    expect(await current.api.assetReferences(current.projectLocator, current.model.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: current.apiLocator.apiId }),
      expect.objectContaining({ ownerId: current.secondApiLocator.apiId }),
    ]));

    await wrapper.get('[data-testid="asset-model-add"]').trigger("click");
    await wrapper.get('[data-testid="asset-model-name"]').setValue("UI saved model");
    modelSaveApi.mockClear();
    await wrapper.get('[data-testid="asset-model-save"]').trigger("click");
    const secondModelSave = modelSaveApi.mock.results[0]?.value as Promise<unknown> | undefined;
    if (!secondModelSave) throw new Error("New model save did not invoke the real modelSave API");
    await secondModelSave;
    await vi.waitFor(() => expect(wrapper.find('[data-testid="asset-feedback"]').text()).toBe("资产已保存"));

    const createdKinds = ["parameter", "auth", "response", "example"] as const;
    const createComponent = vi.spyOn(current.api, "componentCreate");
    const saveComponent = vi.spyOn(current.api, "componentSave");
    for (const kind of createdKinds) {
      const existing = wrapper.findAll(`button[data-testid^="asset-component-select-${kind}-"]`);
      await wrapper.get('[data-testid="asset-component-kind"]').setValue(kind);
      const addButton = wrapper.get('[data-testid="asset-component-add"]');
      expect(addButton.attributes("disabled"), `${kind}: add should be writable`).toBeUndefined();
      createComponent.mockClear();
      await addButton.trigger("click");
      expect(createComponent).toHaveBeenCalledWith(current.projectLocator, expect.objectContaining({ kind }));
      const createResult = createComponent.mock.results[0]?.value;
      expect(createResult).toBeInstanceOf(Promise);
      const created = await createResult as Awaited<ReturnType<typeof current.api.componentCreate>>;
      expect(created.kind).toBe(kind);
      await flushPromises();
      expect(createComponent, `${kind}: click should reach the API`).toHaveBeenCalledOnce();
      expect(wrapper.find('[data-testid="asset-error"]').exists() ? wrapper.get('[data-testid="asset-error"]').text() : "", kind).toBe("");
      expect(wrapper.find('[data-testid="asset-feedback"]').text(), kind).toBe("资产已创建");
      const choices = wrapper.findAll(`button[data-testid^="asset-component-select-${kind}-"]`);
      expect(choices, `${kind}: created component should appear in the list`).toHaveLength(existing.length + 1);
      await choices[choices.length - 1]!.trigger("click");
      await flushPromises();
      const definition = wrapper.get('[data-testid="asset-component-definition"]');
      const asset = JSON.parse((definition.element as HTMLTextAreaElement).value) as {
        id: string; kind: typeof kind; name: string; description: string; definition: Record<string, unknown>;
      };
      expect(wrapper.get('button[data-testid^="asset-component-select-"][aria-pressed="true"]').attributes("data-testid"), kind)
        .toBe(`asset-component-select-${asset.kind}-${asset.id}`);
      asset.name = `UI ${kind} edited`;
      if (kind === "parameter") asset.definition.name = "ui-query";
      if (kind === "response") asset.definition.status = "202";
      if (kind === "example") asset.definition.name = "ui-example";
      await definition.setValue(JSON.stringify(asset, null, 2));
      saveComponent.mockClear();
      await wrapper.get('[data-testid="asset-component-save"]').trigger("click");
      const saveTask = saveComponent.mock.results[0]?.value as Promise<unknown> | undefined;
      if (!saveTask) throw new Error(`${kind}: component save did not reach the real API`);
      await saveTask;
      await flushPromises();
      expect(wrapper.find('[data-testid="asset-error"]').exists() ? wrapper.get('[data-testid="asset-error"]').text() : "", kind).toBe("");
      await vi.waitFor(() => expect(wrapper.find('[data-testid="asset-feedback"]').text()).toBe("资产已保存"));
      const saved = await current.api.componentGet({ ...current.projectLocator, componentKind: kind, componentId: asset.id });
      expect(saved).toMatchObject({ kind, name: `UI ${kind} edited` });
      if (saved.kind === "parameter") expect(saved.definition.name).toBe("ui-query");
      if (saved.kind === "response") expect(saved.definition.status).toBe("202");
      if (saved.kind === "example") expect(saved.definition.name).toBe("ui-example");
    }

    const reopenedAssets = useAssetsStore(current.api, () => ({ root: current.root, readOnly: false }));
    await reopenedAssets.load(current.projectLocator);
    expect(reopenedAssets.models.some((item) => item.name === "UI saved model")).toBe(true);
    for (const kind of createdKinds) expect(reopenedAssets.components).toContainEqual(expect.objectContaining({ kind, name: `UI ${kind} edited` }));
  });

  it("binds credentials from a shared auth component manager without storing the value in either API", async () => {
    const current = await contractAssetEditorFixture(undefined, `C:/apicc-task10b-auth-component-${randomUUID()}`);
    const editor = await createEditor(current);
    const wrapper = await mountRequestEditor(editor, current);
    await wrapper.get('[data-testid="assets-panel"] summary').trigger("click");
    await wrapper.get('[data-testid="asset-component-kind"]').setValue("auth");
    const create = vi.spyOn(current.api, "componentCreate");
    await wrapper.get('[data-testid="asset-component-add"]').trigger("click");
    const createdPromise = create.mock.results[0]?.value as Promise<Awaited<ReturnType<typeof current.api.componentCreate>>> | undefined;
    if (!createdPromise) throw new Error("Auth component creation did not reach the API");
    const created = await createdPromise;
    if (created.kind !== "auth" || created.definition.kind !== "bearer") throw new Error("New auth component must expose a formal bearer SecretRef");
    await flushPromises();

    expect(wrapper.find('[data-testid="credential-editor"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="credential-value"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="credential-warning"]').text()).toContain("本地脚本");
    const secretValue = "synthetic-component-token";
    await wrapper.get('[data-testid="credential-value"]').setValue(secretValue);
    const failedCredentialPut = vi.spyOn(current.api, "credentialPut").mockResolvedValueOnce({
      ok: false,
      error: { code: "CREDENTIAL_SAVE_FAILED", refId: created.definition.token.id, message: "Credential vault write failed" },
    });
    await wrapper.get('[data-testid="credential-save"]').trigger("click");
    const failedPutTask = failedCredentialPut.mock.results[0]?.value as Promise<unknown> | undefined;
    if (!failedPutTask) throw new Error("Credential save did not invoke credentialPut for the failed-write case");
    await failedPutTask;
    await vi.waitFor(() => expect(wrapper.get('[data-testid="credential-error"]').text()).toContain("Credential vault write failed"));
    expect(wrapper.find('[data-testid="credential-saved"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="credential-value"]').element as HTMLInputElement).value).toBe(secretValue);
    expect(await current.api.credentialStatus({ locator: current.projectLocator, ref: created.definition.token })).toEqual({ ok: true, status: "missing" });
    failedCredentialPut.mockRestore();

    const credentialPut = vi.spyOn(current.api, "credentialPut");
    await wrapper.get('[data-testid="credential-save"]').trigger("click");
    const putTask = credentialPut.mock.results[0]?.value as Promise<unknown> | undefined;
    if (!putTask) throw new Error("Credential save did not invoke the real credentialPut API");
    await putTask;
    await vi.waitFor(() => expect(wrapper.find('[data-testid="credential-saved"]').exists()).toBe(true));
    expect(await current.api.credentialStatus({ locator: current.projectLocator, ref: created.definition.token })).toEqual({ ok: true, status: "available" });

    const originalAuth = (await current.api.apiGet(current.apiLocator)).api.contract.request.auth;
    expect(originalAuth.kind).toBe("componentRef");
    const binding = { kind: "componentRef", componentId: created.id, expectedKind: "auth" } as const;
    const firstRequest = editor.api!.contract.request;
    firstRequest.auth = binding;
    expect(editor.dirty).toBe(true);
    const failedFileSave = vi.spyOn(current.api, "apiSave").mockRejectedValueOnce(new Error("API file save failed after credential put"));
    const originalSave = editor.save.bind(editor);
    let failedSaveTask: ReturnType<typeof originalSave> | null = null;
    editor.save = () => {
      failedSaveTask = originalSave();
      return failedSaveTask;
    };
    try {
      await wrapper.get('[data-testid="save-btn"]').trigger("click");
      if (!failedSaveTask) throw new Error("API save button did not invoke the real editor.save action");
      await expect(failedSaveTask).rejects.toThrow("API file save failed after credential put");
      expect(JSON.stringify(failedFileSave.mock.calls)).not.toContain(secretValue);
    } finally {
      editor.save = originalSave;
      failedFileSave.mockRestore();
    }
    await vi.waitFor(() => expect(wrapper.get('[data-testid="save-error"]').text()).toContain("API file save failed after credential put"));
    expect(wrapper.find('[data-testid="credential-saved"]').exists()).toBe(true);
    expect(editor.dirty).toBe(true);
    const beforeFileRetry = await current.api.apiGet(current.apiLocator);
    expect(beforeFileRetry.api.contract.request.auth).toEqual(originalAuth);
    expect(beforeFileRetry.api.contract.request.auth).not.toEqual(binding);

    await saveEditorFromUi(wrapper, editor);
    expect(editor.dirty).toBe(false);
    expect(wrapper.find('[data-testid="credential-saved"]').exists()).toBe(true);
    const secondDetail = await current.api.apiGet(current.secondApiLocator);
    secondDetail.api.contract.request.auth = binding;
    await current.api.apiSave(current.secondApiLocator, secondDetail.api, secondDetail.sourceApiRevision);
    const firstSaved = await current.api.apiGet(current.apiLocator);
    const secondSaved = await current.api.apiGet(current.secondApiLocator);
    expect(firstSaved.api.contract.request.auth).toEqual(binding);
    expect(secondSaved.api.contract.request.auth).toEqual(binding);
    expect(JSON.stringify(firstSaved.api.contract.request.auth)).not.toContain(secretValue);
    expect(JSON.stringify(secondSaved.api.contract.request.auth)).not.toContain(secretValue);
    expect(JSON.stringify(await current.api.componentGet({ ...current.projectLocator, componentKind: "auth", componentId: created.id }))).not.toContain(secretValue);
    expect(JSON.stringify(editor.api)).not.toContain(secretValue);
    expect(JSON.stringify(editor.sessions)).not.toContain(secretValue);
    const storedValues = Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index) ?? "") ?? "");
    expect(storedValues.join("\n")).not.toContain(secretValue);
    const ai = createAiStore({ api: current.api, editor, storage: localStorage });
    ai.baseUrl = "https://ai.example.test";
    ai.model = "test-model";
    const aiSuggest = vi.spyOn(current.api, "aiSuggest").mockResolvedValue([]);
    await ai.fetchSuggestions();
    expect(aiSuggest).toHaveBeenCalledWith({ locator: editor.locator, baseUrl: ai.baseUrl, model: ai.model });
    expect(JSON.stringify(aiSuggest.mock.calls)).not.toContain(secretValue);
  });

  it("rehydrates design on same-key editor generation rebuild and saves only the current draft", async () => {
    const initial = await fixture.api.apiGet(fixture.apiLocator);
    initial.api.documentation = "persisted v1";
    await fixture.api.apiSave(fixture.apiLocator, initial.api, initial.sourceApiRevision);
    const editor = await createEditor();
    const design = useDesignStore(fixture.api, editor);
    const workspace = useWorkspaceStore(fixture.api);
    await workspace.open(fixture.root);
    design.load();
    const { i18n } = createI18nInstance();
    const wrapper = mount(DesignPanel, { props: { editor, design, workspace }, global: { plugins: [i18n] } });
    mountedWrappers.push(wrapper);
    await flushPromises();
    await wrapper.get('[data-testid="design-content"]').setValue("stale unsaved draft");
    expect(design.dirty).toBe(true);

    const remote = await fixture.api.apiGet(fixture.apiLocator);
    remote.api.documentation = "persisted v2";
    await fixture.api.apiSave(fixture.apiLocator, remote.api, remote.sourceApiRevision);
    const previousKey = editor.activeKey;
    const previousGeneration = editor.sessions[previousKey!].generation;
    editor.evictProject(fixture.projectLocator, root);
    await editor.load(fixture.apiLocator);
    expect(editor.activeKey).toBe(previousKey);
    expect(editor.sessions[editor.activeKey!].generation).not.toBe(previousGeneration);
    await vi.waitFor(() => {
      expect(design.content).toBe("persisted v2");
      expect((wrapper.get('[data-testid="design-content"]').element as HTMLTextAreaElement).value).toBe("persisted v2");
    });
    await wrapper.get('[data-testid="design-content"]').setValue("saved after rehydrate");
    const originalSave = design.save.bind(design);
    let saveTask: ReturnType<typeof originalSave> | null = null;
    design.save = () => {
      saveTask = originalSave();
      return saveTask;
    };
    await wrapper.get('[data-testid="design-save"]').trigger("click");
    if (!saveTask) throw new Error("Design save button did not invoke the real design.save action");
    await saveTask;
    await vi.waitFor(() => expect(wrapper.find('[data-testid="design-saved"]').exists()).toBe(true));
    design.save = originalSave;
    unmountTracked(wrapper);
    editor.evictProject(fixture.projectLocator, root);
    await editor.load(fixture.apiLocator);
    expect(editor.api!.documentation).toBe("saved after rehydrate");
  });

  it("round-trips HTTP, WebSocket, and SOAP drafts through the real editor without losing legal payloads", async () => {
    const current = await contractAssetEditorFixture(undefined, `C:/apicc-task10b-protocol-reopen-${randomUUID()}`);
    const editor = await createEditor(current);
    let wrapper = await mountRequestEditor(editor, current);
    const currentRequest = () => editor.api!.contract.request;
    const methodSelect = () => {
      const control = wrapper.findAllComponents({ name: "ASelect" })
        .find((component) => component.attributes("data-testid") === "editor-method");
      if (!control) throw new Error("HTTP method selector is missing");
      return control;
    };
    const reopen = async (protocol: "http" | "websocket" | "soap") => {
      unmountTracked(wrapper);
      editor.evictProject(current.projectLocator, current.root);
      await editor.load(current.apiLocator);
      expect(currentRequest().protocol).toBe(protocol);
      wrapper = await mountRequestEditor(editor, current);
    };

    if (currentRequest().protocol !== "http") throw new Error("Seed API must use HTTP for protocol editing");
    methodSelect().vm.$emit("update:value", "POST");
    await wrapper.get('[data-testid="editor-path"]').setValue("/task10b/http");
    await wrapper.get('[data-testid="tab-query"]').trigger("click");
    await wrapper.get('[data-testid="add-query"]').trigger("click");
    const queryRequest = currentRequest();
    if (queryRequest.protocol !== "http") throw new Error("Expected HTTP request while editing query");
    const queryIndex = queryRequest.query.length - 1;
    const queryRow = wrapper.findAll(".kv-row").find((row) => row.find(`[data-testid="parameter-required-query-${queryIndex}"]`).exists());
    if (!queryRow) throw new Error("Inline query row was not rendered");
    await queryRow.get('[data-testid="kv-key"]').setValue("q");
    await queryRow.get('[data-testid="kv-value"]').setValue("kept-query");
    await wrapper.get('[data-testid="tab-body"]').trigger("click");
    await wrapper.get('input[value="urlencoded"]').setValue(true);
    await wrapper.get('[data-testid="body-add-field"]').trigger("click");
    await wrapper.get('[data-testid="body-field-name"]').setValue("form");
    await wrapper.get('[data-testid="body-field-value"]').setValue("kept-form");

    // 连续协议切换保留 session drafts；所有协议输入均由真实控件完成。
    await wrapper.get('input[value="websocket"]').setValue(true);
    await wrapper.get('[data-testid="tab-message"]').trigger("click");
    await wrapper.get('[data-testid="editor-message"]').setValue("frame payload");
    await wrapper.get('input[value="soap"]').setValue(true);
    await wrapper.get('[data-testid="tab-envelope"]').trigger("click");
    await wrapper.get('[data-testid="editor-envelope"]').setValue("<Envelope>soap</Envelope>");
    await wrapper.get('[data-testid="editor-soap-action"]').setValue("urn:task10b");
    await wrapper.get('input[value="http"]').setValue(true);
    const restoredHttp = currentRequest();
    if (restoredHttp.protocol !== "http") throw new Error("Expected HTTP draft after protocol round trip");
    expect(restoredHttp.method).toBe("POST");
    expect(restoredHttp.path).toBe("/task10b/http");
    expect(restoredHttp.query.find((item) => item.kind === "inline" && item.name === "q")?.value).toBe("kept-query");
    expect(restoredHttp.body).toMatchObject({ kind: "urlencoded", fields: [{ name: "form", value: "kept-form" }] });
    await saveEditorFromUi(wrapper, editor);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
    await reopen("http");
    expect(currentRequest()).toMatchObject({ protocol: "http", method: "POST", path: "/task10b/http", body: { kind: "urlencoded", fields: [{ name: "form", value: "kept-form" }] } });
    if (currentRequest().protocol !== "http") throw new Error("Reopened request is not HTTP");
    expect(currentRequest().query.find((item) => item.kind === "inline" && item.name === "q")?.value).toBe("kept-query");

    await wrapper.get('input[value="websocket"]').setValue(true);
    await wrapper.get('[data-testid="tab-message"]').trigger("click");
    await wrapper.get('[data-testid="editor-message"]').setValue("saved WebSocket frame");
    await saveEditorFromUi(wrapper, editor);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
    await reopen("websocket");
    expect(currentRequest()).toMatchObject({ protocol: "websocket", message: "saved WebSocket frame", path: "/task10b/http" });

    await wrapper.get('input[value="soap"]').setValue(true);
    await wrapper.get('[data-testid="tab-envelope"]').trigger("click");
    await wrapper.get('[data-testid="editor-envelope"]').setValue("<Envelope>saved</Envelope>");
    await wrapper.get('[data-testid="editor-soap-action"]').setValue("urn:task10b:saved");
    await saveEditorFromUi(wrapper, editor);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
    await reopen("soap");
    expect(currentRequest()).toMatchObject({ protocol: "soap", method: "POST", envelope: "<Envelope>saved</Envelope>", soapAction: "urn:task10b:saved" });
  });

  it("keeps schema examples out of the request instance until the user chooses one", async () => {
    const editor = await createEditor();
    const request = editor.api!.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Seed API must use HTTP for body editing");
    request.body = {
      kind: "json",
      content: "",
      schema: {
        kind: "object",
        properties: { title: { kind: "scalar", type: "string" } },
        required: ["title"],
        additionalProperties: false,
        examples: [{ title: "示例标题" }],
      },
    };
    const wrapper = await mountRequestEditor(editor);
    await flushPromises();
    await wrapper.get('[data-testid="tab-body"]').trigger("click");
    await flushPromises();
    expect(request.body.content).toBe("");
    expect(wrapper.find('[data-testid="schema-editor"]').exists()).toBe(true);
    await wrapper.get('.body-schema [data-testid="schema-scalar-type"]').setValue("number");
    expect(request.body.schema?.kind).toBe("object");
    if (request.body.schema?.kind !== "object") throw new Error("Expected editable object schema");
    const rootSchema = wrapper.get('.body-schema > [data-testid="schema-editor"]');
    const schemaExamples = rootSchema.get(':scope > label.row > textarea[data-testid="schema-examples"]');
    await schemaExamples.setValue("[{broken json]");
    expect(rootSchema.get(':scope > label.row [data-testid="schema-annotation-error-examples"]').attributes("role")).toBe("alert");
    expect(schemaExamples.element).toHaveProperty("value", "[{broken json]");
    expect(request.body.schema.examples).toEqual([{ title: "示例标题" }]);
    await rootSchema.get(':scope > label.row > textarea[data-testid="schema-examples"]').setValue('[{"title":"valid recovery"}]');
    await flushPromises();
    expect(rootSchema.find('[data-testid="schema-annotation-error-examples"]').exists()).toBe(false);
    expect(request.body.schema.examples).toEqual([{ title: "valid recovery" }]);
    expect(request.body.schema.properties.title?.kind).toBe("scalar");
    if (request.body.schema.properties.title?.kind !== "scalar") throw new Error("Expected editable scalar property");
    expect(request.body.schema.properties.title.type).toBe("number");
    await wrapper.get('[data-testid="body-example-use-0"]').trigger("click");
    expect(request.body.content).toBe('{\n  "title": "valid recovery"\n}');
  });

  it("shows local response-header validation in the shared unscoped editor", async () => {
    const editor = await createEditor();
    editor.api!.contract.responses = [{
      kind: "inline", id: randomUUID(), status: "200", description: "OK", headers: { "X-Trace": "" },
      content: { "application/json": { examples: [] } },
    }];
    const wrapper = await mountRequestEditor(editor);
    const headerName = wrapper.get('[data-testid="response-header-name-0-0"]');
    await headerName.setValue(" ");
    expect(headerName.attributes("aria-invalid")).toBe("true");
    expect(wrapper.find('[data-testid="response-header-error"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="response-header-error"]').text()).toContain("响应头名称不能为空且不能重复。");
  });

  it("edits and persists an inline response definition through the mounted editor", async () => {
    const editor = await createEditor();
    const id = randomUUID();
    const exampleId = randomUUID();
    const exampleComponent = fixture.components.find((component) => component.kind === "example");
    if (!exampleComponent || exampleComponent.kind !== "example") throw new Error("The project fixture must contain an example component");
    editor.api!.contract.responses = [{
      kind: "inline", id, status: "200", description: "OK", headers: {},
      content: { "application/json": { schema: { kind: "scalar", type: "string" }, examples: [{ kind: "componentRef", id: exampleId, componentId: exampleComponent.id, expectedKind: "example" }] } },
    }];
    const wrapper = await mountRequestEditor(editor);
    await wrapper.get(".example select").setValue("");
    expect(editor.api!.contract.responses[0]).toMatchObject({
      kind: "inline",
      content: { "application/json": { examples: [{ kind: "inline", id: exampleId, name: "Success example", value: { ok: true } }] } },
    });
    const responseExample = wrapper.get('[data-testid="response-example-0-0"]');
    await responseExample.setValue('{invalid json');
    expect(wrapper.get('[data-testid="response-example-error"]').attributes("role")).toBe("alert");
    expect(responseExample.element).toHaveProperty("value", "{invalid json");
    expect(editor.api!.contract.responses[0]).toMatchObject({
      kind: "inline",
      content: { "application/json": { examples: [{ kind: "inline", id: exampleId, value: { ok: true } }] } },
    });
    await responseExample.setValue('{"ready":false}');
    expect(wrapper.find('[data-testid="response-example-error"]').exists()).toBe(false);
    expect(editor.api!.contract.responses[0]).toMatchObject({
      kind: "inline",
      content: { "application/json": { examples: [{ kind: "inline", id: exampleId, value: { ready: false } }] } },
    });
    await wrapper.get('[data-testid="response-status-0"]').setValue("201");
    await wrapper.get('[data-testid="save-btn"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="save-feedback"]').exists()).toBe(true));
    editor.evictProject(fixture.projectLocator, root);
    await editor.load(fixture.apiLocator);
    expect(editor.api!.contract.responses[0]).toMatchObject({
      kind: "inline", id, status: "201",
      content: { "application/json": { examples: [{ kind: "inline", id: exampleId, value: { ready: false } }] } },
    });
  });

  it("stores a credential separately from the API asset and reports its status", async () => {
    const ref = { id: randomUUID(), policy: "test-auto" };
    vi.spyOn(fixture.api, "credentialStatus")
      .mockResolvedValueOnce({ ok: true, status: "missing" })
      .mockResolvedValueOnce({ ok: true, status: "unavailable" });
    const detail = await fixture.api.apiGet(fixture.apiLocator);
    const persistedRequest = detail.api.contract.request;
    expect(persistedRequest.protocol).toBe("http");
    if (persistedRequest.protocol !== "http") throw new Error("Seed API must use HTTP for credential editing");
    persistedRequest.auth = { kind: "bearer", token: ref };
    await fixture.api.apiSave(fixture.apiLocator, detail.api, detail.sourceApiRevision);
    const editor = await createEditor();
    const request = editor.api!.contract.request;
    const wrapper = await mountRequestEditor(editor);
    expect(wrapper.get('[data-testid="credential-remove-impact"]').text()).toContain("将失去绑定");
    await wrapper.get('[data-testid="credential-value"]').setValue("synthetic-token");
    await wrapper.get('[data-testid="credential-save"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="credential-saved"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="credential-status"]').text()).toBe("凭据不可用");
    expect((wrapper.get('[data-testid="credential-value"]').element as HTMLInputElement).value).toBe("");
    expect(editor.dirty).toBe(false);
    expect(request.auth).toEqual({ kind: "bearer", token: ref });
    expect(await fixture.api.credentialStatus({ locator: fixture.projectLocator, ref })).toMatchObject({ ok: true, status: "available" });
  });

  it("isolates credential status across root and locator changes when prior reads finish late", async () => {
    type Status = Awaited<ReturnType<typeof fixture.api.credentialStatus>>;
    const deferred = () => {
      let resolve!: (value: Status) => void;
      const promise = new Promise<Status>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const status = vi.spyOn(fixture.api, "credentialStatus")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const ref = { id: randomUUID(), policy: "test-auto" };
    const { i18n } = createI18nInstance();
    const wrapper = mount(CredentialEditor, {
      props: { api: fixture.api, locator: fixture.projectLocator, auth: { kind: "bearer", token: ref }, contextKey: "root-A/api-generation-1" },
      global: { plugins: [i18n] },
    });
    mountedWrappers.push(wrapper);
    try {
      await flushPromises();
      expect(status).toHaveBeenCalledTimes(1);

    await wrapper.get('[data-testid="credential-value"]').setValue("secret-from-root-A");
    expect((wrapper.get('[data-testid="credential-value"]').element as HTMLInputElement).value).toBe("secret-from-root-A");
    await wrapper.setProps({ contextKey: "root-B/api-generation-1" });
    await flushPromises();
    expect(status).toHaveBeenCalledTimes(2);
    expect(status.mock.calls[1]?.[0].locator).toEqual(fixture.projectLocator);
    expect((wrapper.get('[data-testid="credential-value"]').element as HTMLInputElement).value).toBe("");

    await wrapper.get('[data-testid="credential-value"]').setValue("secret-from-root-B");

    const nextLocator = { ...fixture.projectLocator, projectId: `${fixture.projectLocator.projectId}-copied` };
    await wrapper.setProps({ locator: nextLocator });
    await flushPromises();
    expect(status).toHaveBeenCalledTimes(3);
    expect(status.mock.calls[2]?.[0].locator).toEqual(nextLocator);
    expect((wrapper.get('[data-testid="credential-value"]').element as HTMLInputElement).value).toBe("");

      third.resolve({ ok: true, status: "available" });
      await flushPromises();
      second.resolve({ ok: true, status: "missing" });
      await flushPromises();
      first.resolve({ ok: true, status: "missing" });
      await flushPromises();
      expect(wrapper.get('[data-testid="credential-status"]').text()).toBe("凭据可用");
    } finally {
      first.resolve({ ok: true, status: "missing" });
      second.resolve({ ok: true, status: "missing" });
      third.resolve({ ok: true, status: "available" });
      await flushPromises();
    }
  });

  it("selects and removes a logical case by id and scope instead of the first matching id", async () => {
    const editor = await createEditor();
    editor.api!.cases = [
      { id: "shared-case-id", name: "Base case", scope: "base", parameters: {}, assertions: [], preOperations: [], postOperations: [] },
      { id: "shared-case-id", name: "Dev case", scope: "dev", parameters: {}, assertions: [], preOperations: [], postOperations: [] },
    ];
    const cases = useCasesStore(fixture.api, editor);
    cases.select("shared-case-id", "dev");
    const { i18n } = createI18nInstance();
    const wrapper = mount(CasePanel, { props: { editor, cases }, global: { plugins: [i18n] } });
    mountedWrappers.push(wrapper);
    await flushPromises();
    const rows = wrapper.findAll('[data-testid="case-row"]');
    expect(rows[0]?.classes()).not.toContain("active");
    expect(rows[1]?.classes()).toContain("active");
    await wrapper.get('[data-testid="case-delete"]').trigger("click");
    expect(editor.api!.cases).toEqual([expect.objectContaining({ id: "shared-case-id", scope: "base" })]);
  });
});
