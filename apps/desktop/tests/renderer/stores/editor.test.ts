// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isReactive, toRaw } from "vue";
import type { ApiAsset } from "@apicc/core";
import type { ApiDetail } from "../../../src/shared/types.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useCasesStore } from "../../../src/renderer/src/stores/cases.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";
import { apiSessionKey } from "../../../src/renderer/src/stores/localIdentity.js";
import { contractAssetFixture, duplicateContractProjectAcrossGroups } from "../helpers/contract-assets.js";

async function seeded(root = mkdtempSync(join(tmpdir(), "apicc-editor-seeded-")), readOnly = false) {
  const api = createMemoryApi({ root });
  const fixture = await contractAssetFixture(api, root);
  const context = { root, readOnly };
  const editor = useEditorStore(api, () => context);
  return { api, fixture, editor, context };
}

async function createSecondApi(api: ReturnType<typeof createMemoryApi>, fixture: Awaited<ReturnType<typeof contractAssetFixture>>) {
  const created = await api.nodeCreate({ kind: "api", parent: fixture.collection.locator, api: { name: "接口 B" } });
  if (created.kind !== "api") throw new Error("Expected an API node");
  return created;
}

describe("editor store", () => {
  it("loads a complete ApiAsset and tracks edits against its saved snapshot", async () => {
    const { editor, fixture } = await seeded();
    await editor.load(fixture.apiLocator);
    expect(editor.locator).toEqual(fixture.apiLocator);
    expect(editor.api?.contract.metadata.name).toBe("示例接口");
    expect(editor.envs).toEqual([]);
    expect(editor.dirty).toBe(false);
    editor.api!.contract.request.path = "/changed";
    expect(editor.dirty).toBe(true);
  });

  it("saves and reopens the same contract asset", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-editor-"));
    const { api, fixture, editor } = await seeded(root);
    await editor.load(fixture.apiLocator);
    editor.api!.contract.request.path = "/v2";
    await editor.save();
    expect(editor.dirty).toBe(false);
    const fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    expect((await fresh.apiGet(fixture.apiLocator)).api.contract.request.path).toBe("/v2");
    expect(api).not.toBe(fresh);
  });

  it("commits the exact full-save revision acknowledgement without a post-save apiGet", async () => {
    const { api, fixture, editor } = await seeded();
    await editor.load(fixture.apiLocator);
    const session = editor.sessions[editor.activeKey!]!;
    const expectedSourceApiRevision = session.sourceApiRevision;
    editor.api!.contract.request.path = "/acknowledged";
    api.apiSave = async (_locator, asset, expected) => {
      expect(expected).toBe(expectedSourceApiRevision);
      return { api: asset, sourceApiRevision: "exact-api-ack", sourceProjectRevision: "exact-project-ack" };
    };
    const apiGet = vi.spyOn(api, "apiGet");

    await editor.save();

    expect(apiGet).not.toHaveBeenCalled();
    expect(session.sourceApiRevision).toBe("exact-api-ack");
    expect(session.sourceProjectRevision).toBe("exact-project-ack");
    expect(editor.dirty).toBe(false);
  });

  it("blocks legacy full-asset save while the current request restore marker still needs input", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-editor-pending-request-"));
    const { api, fixture, editor, context } = await seeded(root);
    await editor.load(fixture.apiLocator);
    const debug = useDebugStore(api, editor, () => context);
    useCasesStore(api, editor);
    const pathPlaceholder = "/request-restore-placeholder";
    const invocation = {
      mode: "request" as const,
      locator: fixture.apiLocator,
      request: { ...editor.api!.contract.request, path: pathPlaceholder },
      parameters: {},
      fields: [{ path: "request.path", status: "redacted" as const, needsInput: true }],
    };
    expect(debug.applyRestore(invocation, true, editor)).toBe(true);

    await expect(editor.save()).rejects.toThrow(/补齐|input|needs/i);
    expect((await api.apiGet(fixture.apiLocator)).api.contract.request.path).toBe("/");

    editor.evictProject(fixture.projectLocator, fixture.root);
    await editor.load(fixture.apiLocator);
    editor.api!.contract.request.path = pathPlaceholder;
    await editor.save();
    expect((await api.apiGet(fixture.apiLocator)).api.contract.request.path).toBe(pathPlaceholder);
  });

  it("blocks legacy full-asset save while any current case restore marker still needs input", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-editor-pending-case-"));
    const { api, fixture, editor, context } = await seeded(root);
    await editor.load(fixture.apiLocator);
    const cases = useCasesStore(api, editor);
    useDebugStore(api, editor, () => context);
    const sessionKey = editor.activeKey!;
    const session = editor.sessions[sessionKey]!;
    const target = editor.api!.cases[0]!;
    const pathPlaceholder = "/case-restore-placeholder";
    const requestOverride = JSON.parse(JSON.stringify(editor.api!.contract.request)) as NonNullable<typeof target.requestOverride>;
    if (requestOverride.protocol !== "http") throw new Error("Expected HTTP case request");
    requestOverride.path = pathPlaceholder;
    target.requestOverride = requestOverride;
    cases.setPendingRestoreFields({ caseId: target.id, scope: target.scope }, [
      { path: "request.path", status: "redacted", needsInput: true },
    ], { "request.path": '"/case-restore-placeholder"' });

    await expect(editor.save()).rejects.toThrow(/补齐|input|needs/i);
    expect((await api.apiGet(fixture.apiLocator)).api.cases[0]?.requestOverride).toBeUndefined();
    expect(editor.sessions[sessionKey]?.generation).toBe(session.generation);
  });

  it("submits an ordinary object with the exact locator, not a reactive Proxy", async () => {
    const { api, fixture, editor } = await seeded();
    await editor.load(fixture.apiLocator);
    let submitted: unknown;
    let submittedLocator: unknown;
    const original = api.apiSave.bind(api);
    api.apiSave = async (locator, asset, revision) => {
      submittedLocator = locator;
      submitted = asset;
      return original(locator, asset, revision);
    };
    editor.api!.contract.metadata.description = "payload test";
    await editor.save();
    expect(isReactive(submitted)).toBe(false);
    expect(submittedLocator).toEqual(fixture.apiLocator);
    expect(submitted).toMatchObject({ contract: { metadata: { description: "payload test" } } });
  });

  it("switches only among valid HTTP, WebSocket, and SOAP request shapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-editor-protocols-"));
    const { api, fixture, editor } = await seeded(root);
    await editor.load(fixture.apiLocator);
    const http = toRaw(editor.api!).contract.request;
    if (http.protocol !== "http") throw new Error("Expected HTTP fixture");
    const shared = { baseUrl: http.baseUrl, path: http.path, pathParams: http.pathParams, query: http.query,
      headers: http.headers, cookies: http.cookies, auth: http.auth };

    editor.api!.contract.request = { protocol: "websocket", ...structuredClone(shared), message: "hello" };
    expect(editor.dirty).toBe(true);
    await editor.save();
    expect(editor.dirty).toBe(false);
    expect(editor.api!.contract.request).toMatchObject({ protocol: "websocket", message: "hello" });
    expect(editor.api!.contract.request).not.toHaveProperty("body");

    editor.api!.contract.request = { protocol: "soap", method: "POST", ...structuredClone(shared), envelope: "<Envelope/>", soapAction: "urn:test" };
    expect(editor.dirty).toBe(true);
    await editor.save();
    expect(editor.dirty).toBe(false);
    expect(editor.api!.contract.request).toMatchObject({ protocol: "soap", method: "POST", envelope: "<Envelope/>", soapAction: "urn:test" });
    expect(editor.api!.contract.request).not.toHaveProperty("message");
    expect(editor.api!.contract.request).not.toHaveProperty("body");

    const fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    expect((await fresh.apiGet(fixture.apiLocator)).api.contract.request).toEqual(editor.api!.contract.request);
    expect((editor.api as ApiAsset).contract.request.protocol).toBe("soap");
  });

  it("keeps separate drafts by root and complete locator, including same API id in another group", async () => {
    const { api, fixture, editor, context } = await seeded();
    await editor.load(fixture.apiLocator);
    editor.api!.contract.metadata.description = "root one draft";
    const firstKey = editor.activeKey!;
    const secondGroupLocator = { ...fixture.apiLocator, groupId: "22222222-2222-4222-8222-222222222222" };
    expect(apiSessionKey(fixture.root, secondGroupLocator)).not.toBe(firstKey);
    expect(apiSessionKey("C:/copied-workspace", fixture.apiLocator)).not.toBe(firstKey);

    context.root = "C:/copied-workspace";
    await editor.load(fixture.apiLocator);
    expect(editor.activeKey).not.toBe(firstKey);
    expect(editor.api?.contract.metadata.description).toBe("");
    context.root = fixture.root;
    await editor.load(fixture.apiLocator);
    expect(editor.api?.contract.metadata.description).toBe("root one draft");
    expect(editor.isProjectDirty(fixture.projectLocator, fixture.root)).toBe(true);
    editor.evictProject(fixture.projectLocator, fixture.root);
    expect(editor.isProjectDirty(fixture.projectLocator, fixture.root)).toBe(false);
    expect(editor.activeKey).toBeNull();
  });

  it("loads and saves duplicate project and API IDs by their distinct group scopes", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-editor-duplicate-scope-"));
    const api = createMemoryApi({ root });
    const fixture = await contractAssetFixture(api, root);
    const duplicateProject = await duplicateContractProjectAcrossGroups(fixture, "同ID分组");
    const duplicateApiLocator = { ...fixture.apiLocator, groupId: duplicateProject.groupId };
    const editor = useEditorStore(api, () => ({ root, readOnly: false }));

    await editor.load(fixture.apiLocator);
    expect(editor.api?.contract.metadata.description).toBe("");
    await editor.load(duplicateApiLocator);
    expect(editor.api?.contract.metadata.description).toBe("Stored in 同ID分组");
    editor.api!.documentation = "only the duplicate group";
    await editor.save();

    expect((await api.apiGet(duplicateApiLocator)).api.documentation).toBe("only the duplicate group");
    expect((await api.apiGet(fixture.apiLocator)).api.documentation).toBe("");
    await editor.load(fixture.apiLocator);
    expect(editor.api?.documentation).toBe("");
  });

  it("commits only the submitted snapshot while a same-slot edit and slot switch happen during save", async () => {
    const { api, fixture, editor } = await seeded();
    const second = await createSecondApi(api, fixture);
    await editor.load(fixture.apiLocator);
    editor.api!.contract.request.path = "/submitted";
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submitted: ApiAsset[] = [];
    api.apiSave = async (_locator, asset, revision) => { submitted.push(asset); await gate; return { api: asset, sourceApiRevision: revision, sourceProjectRevision: "project-revision" }; };
    const saving = editor.save();
    try {
      editor.api!.contract.request.path = "/edited-during-save";
      await editor.load(second.locator);
      release!();
      await saving;

      expect(submitted[0]!.contract.request.path).toBe("/submitted");
      expect(editor.api?.contract.metadata.name).toBe("接口 B");
      await editor.load(fixture.apiLocator);
      expect(editor.api!.contract.request.path).toBe("/edited-during-save");
      expect(editor.dirty).toBe(true);
      expect(editor.snapshot).toBe(JSON.stringify(submitted[0]));
    } finally {
      release!();
      await saving.catch(() => {});
    }
  });

  it("does not recreate an evicted slot after a successful late save, and failed save leaves snapshot dirty", async () => {
    const { api, fixture, editor } = await seeded();
    await editor.load(fixture.apiLocator);
    editor.api!.contract.request.path = "/before-evict";
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.apiSave = async (_locator, asset, revision) => { await gate; return { api: asset, sourceApiRevision: revision, sourceProjectRevision: "project-revision" }; };
    const saving = editor.save();
    const evictedKey = editor.activeKey!;
    try {
      editor.evictProject(fixture.projectLocator, fixture.root);
      expect(editor.sessions[evictedKey]).toBeUndefined();
      release!();
      await saving;
      expect(editor.sessions[evictedKey]).toBeUndefined();
      expect(editor.activeKey).toBeNull();
    } finally {
      release!();
      await saving.catch(() => {});
    }

    await editor.load(fixture.apiLocator);
    const snapshot = editor.snapshot;
    editor.api!.contract.request.path = "/failure";
    api.apiSave = async () => { throw new Error("storage failed"); };
    await expect(editor.save()).rejects.toThrow("storage failed");
    expect(editor.snapshot).toBe(snapshot);
    expect(editor.dirty).toBe(true);
  });

  it("does not recreate a first-load project slot evicted while apiGet is pending", async () => {
    const { api, fixture, editor } = await seeded();
    let release: () => void = () => {};
    let enter: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const originalGet = api.apiGet.bind(api);
    api.apiGet = async (locator) => {
      enter();
      await gate;
      return originalGet(locator);
    };
    const pendingKey = apiSessionKey(fixture.root, fixture.apiLocator);
    let loading: Promise<void> | undefined;
    try {
      loading = editor.load(fixture.apiLocator);
      await entered;
      editor.evictProject(fixture.projectLocator, fixture.root);
      release();
      await loading;
      expect(editor.sessions[pendingKey]).toBeUndefined();
      expect(editor.activeKey).toBeNull();
    } finally {
      release();
      await loading?.catch(() => {});
    }
  });

  it("evicting a pending project load leaves an unrelated active project intact", async () => {
    const { api, fixture, editor } = await seeded();
    const sibling = await api.nodeCreate({ kind: "project", parent: fixture.group.locator, name: "Sibling" });
    if (sibling.kind !== "project") throw new Error("Expected project creation result");
    const siblingCollection = await api.nodeCreate({ kind: "collection", parent: sibling.locator, name: "Sibling collection" });
    if (siblingCollection.kind !== "collection") throw new Error("Expected collection creation result");
    const siblingApi = await api.nodeCreate({ kind: "api", parent: siblingCollection.locator, api: { name: "Sibling API" } });
    if (siblingApi.kind !== "api") throw new Error("Expected API creation result");
    await editor.load(siblingApi.locator);
    const siblingKey = editor.activeKey!;

    let release: () => void = () => {};
    let enter: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const originalGet = api.apiGet.bind(api);
    api.apiGet = async (locator) => {
      if (locator.apiId === fixture.apiLocator.apiId) {
        enter();
        await gate;
      }
      return originalGet(locator);
    };
    const pendingKey = apiSessionKey(fixture.root, fixture.apiLocator);
    let loading: Promise<void> | undefined;
    try {
      loading = editor.load(fixture.apiLocator);
      await entered;
      expect(editor.activeKey).toBe(siblingKey);
      editor.evictProject(fixture.projectLocator, fixture.root);
      release();
      await loading;
      expect(editor.sessions[pendingKey]).toBeUndefined();
      expect(editor.sessions[siblingKey]).toBeDefined();
      expect(editor.activeKey).toBe(siblingKey);
    } finally {
      release();
      await loading?.catch(() => {});
    }
  });

  it("reloadEnvs updates the original slot even after another API becomes active", async () => {
    const { api, fixture, editor } = await seeded();
    const second = await createSecondApi(api, fixture);
    await editor.load(fixture.apiLocator);
    const originalGet = api.apiGet.bind(api);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const expectedEnv = { id: "env-a", name: "A", locator: { ...fixture.projectLocator, environmentId: "env-a" } };
    api.apiGet = async (locator) => {
      const detail = await originalGet(locator);
      if (locator.apiId === fixture.apiLocator.apiId) {
        await gate;
        return { ...detail, envs: [expectedEnv] } satisfies ApiDetail;
      }
      return detail;
    };
    const firstKey = editor.activeKey!;
    const reloading = editor.reloadEnvs();
    try {
      await editor.load(second.locator);
      const secondKey = editor.activeKey!;
      release!();
      await reloading;
      expect(editor.sessions[firstKey]!.envs).toEqual([expectedEnv]);
      expect(editor.sessions[secondKey]!.envs).toEqual([]);
      expect(editor.activeKey).toBe(secondKey);
    } finally {
      release!();
      await reloading.catch(() => {});
    }
  });

  it("rejects writes in a read-only workspace before the bridge call", async () => {
    const { api, fixture, editor } = await seeded(undefined, true);
    await editor.load(fixture.apiLocator);
    editor.api!.documentation = "draft";
    await expect(editor.save()).rejects.toThrow(/只读/);
    expect(editor.dirty).toBe(true);
    expect((await api.apiGet(fixture.apiLocator)).api.documentation).toBe("");
  });
});
