// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileStorage } from "@apicc/core";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useCasesStore } from "../../../src/renderer/src/stores/cases.js";
import { contractAssetFixture } from "../helpers/contract-assets.js";

async function seeded(root = mkdtempSync(join(tmpdir(), "apicc-case-seeded-")), readOnly = false) {
  const api = createMemoryApi({ root });
  const fixture = await contractAssetFixture(api, root);
  const editor = useEditorStore(api, () => ({ root, readOnly }));
  await editor.load(fixture.apiLocator);
  return { api, fixture, editor, cases: useCasesStore(api, editor) };
}

describe("cases store", () => {
  it("creates a complete base case and selects its physical identity", async () => {
    const { editor, cases } = await seeded();
    const before = editor.api!.cases.length;
    const created = cases.addCase({ name: "新用例", scope: "base" });
    expect(editor.api!.cases.length).toBe(before + 1);
    expect(cases.selectedCase).toEqual({ caseId: created.id, scope: "base" });
    expect(created).toMatchObject({ preOperations: [], postOperations: [] });
    expect(editor.dirty).toBe(true);
  });

  it("removes only matching (case id, scope) and protects the final physical case", async () => {
    const { editor, cases } = await seeded();
    const only = editor.api!.cases[0]!;
    expect(cases.removeCase(only.id, only.scope)).toBe(false);
    const sameIdA = { ...only, id: "shared-case-id", scope: "variant-a" };
    const sameIdB = { ...only, id: "shared-case-id", scope: "variant-b" };
    editor.api!.cases.push(sameIdA, sameIdB);
    cases.select(sameIdA.id, sameIdA.scope);
    expect(cases.removeCase(sameIdA.id, sameIdA.scope)).toBe(true);
    expect(editor.api!.cases).toContainEqual(sameIdB);
    expect(editor.api!.cases).not.toContainEqual(sameIdA);
  });

  it("save persists the ApiAsset case and formal operation arrays across reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-cases-"));
    const { api, fixture, editor, cases } = await seeded(root);
    const created = cases.addCase({ name: "持久", scope: "base" });
    await cases.save();
    expect(editor.dirty).toBe(false);

    const fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    const detail = await fresh.apiGet(fixture.apiLocator);
    expect(detail.api.cases).toContainEqual(created);
    expect(detail.api.cases.find((item) => item.id === created.id)).toMatchObject({ preOperations: [], postOperations: [] });
    expect(api).not.toBe(fresh);
  });

  it("save commits a staged physical-case deletion together with the selected case draft", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-case-delete-"));
    const { api, fixture, editor, cases } = await seeded(root);
    const removed = editor.api!.cases[0]!;
    cases.addCase({ name: "保留候选用例", scope: "base" });
    cases.select(removed.id, removed.scope);
    expect(cases.removeCase(removed.id, removed.scope)).toBe(true);
    await cases.save();

    const fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    const reopened = await fresh.apiGet(fixture.apiLocator);
    expect(reopened.api.cases).not.toContainEqual(removed);
    expect(reopened.api.cases).toHaveLength(editor.api!.cases.length);
    expect(api).not.toBe(fresh);
  });

  it("persists a scope edit as a new physical case and removes the old scope file", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-case-scope-"));
    const { api, fixture, editor, cases } = await seeded(root);
    const original = { ...editor.api!.cases[0]! };
    const other = cases.addCase({ name: "另一个待保存用例", scope: "base" });
    const workflow = await api.wfCreate({ locator: fixture.projectLocator, name: "保留迁移用例的工作流引用" });
    await api.wfSave({ ...fixture.projectLocator, workflowId: workflow.id }, {
      ...workflow,
      nodes: [{ id: "request-node", kind: "request", apiId: fixture.apiNode.id, caseId: original.id, label: "迁移中的请求" }],
    });
    expect(cases.changeScope(original.id, original.scope, "dev")).toBe(true);
    expect(cases.selectedCase).toEqual({ caseId: original.id, scope: "dev" });
    expect(Object.values(cases.pendingDeletes)).toMatchObject([[
      { kind: "scope-migration", caseId: original.id, scope: original.scope, replacementScope: "dev" },
    ]]);
    cases.select(other.id, other.scope);
    await cases.save();

    let fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    let reopened = await fresh.apiGet(fixture.apiLocator);
    expect(reopened.api.cases).toContainEqual(original);
    expect(reopened.api.cases).toContainEqual(other);
    expect(reopened.api.cases).not.toContainEqual({ ...original, scope: "dev" });
    expect(Object.values(cases.pendingDeletes)).toMatchObject([[
      { kind: "scope-migration", caseId: original.id, scope: original.scope, replacementScope: "dev" },
    ]]);

    cases.select(original.id, "dev");
    await cases.save();
    fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    reopened = await fresh.apiGet(fixture.apiLocator);
    expect(reopened.api.cases).not.toContainEqual(original);
    expect(reopened.api.cases).toContainEqual({ ...original, scope: "dev" });
    expect(reopened.api.cases).toContainEqual(other);

    expect(cases.changeScope(other.id, other.scope, "stage")).toBe(true);
    await editor.save();
    editor.evictProject(fixture.projectLocator, root);
    await editor.load(fixture.apiLocator);
    cases.select(original.id, "dev");
    await cases.save();

    fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    reopened = await fresh.apiGet(fixture.apiLocator);
    expect(reopened.api.cases).not.toContainEqual(original);
    expect(reopened.api.cases).toContainEqual({ ...original, scope: "dev" });
    expect(reopened.api.cases).toContainEqual({ ...other, scope: "stage" });
    expect(api).not.toBe(fresh);
  });

  it("refuses to remove the last logical case referenced by a workflow and exposes its caller", async () => {
    const { api, fixture, editor, cases } = await seeded();
    const referenced = editor.api!.cases[0]!;
    cases.addCase({ name: "仍保留的其他逻辑用例", scope: "base" });
    const workflow = await api.wfCreate({ locator: fixture.projectLocator, name: "引用用例的工作流" });
    const workflowLocator = { ...fixture.projectLocator, workflowId: workflow.id };
    await api.wfSave(workflowLocator, {
      ...workflow,
      nodes: [{ id: "request-node", kind: "request", apiId: fixture.apiNode.id, caseId: referenced.id, label: "仍引用的请求" }],
    });

    await expect(api.nodeDelete({ kind: "api", locator: fixture.apiLocator }))
      .rejects.toThrow(/Cannot delete referenced API\/case; workflow callers remain/);
    expect((await api.apiGet(fixture.apiLocator)).api.cases).toContainEqual(referenced);
    expect(await api.wfImpact(fixture.apiLocator)).toContainEqual({
      workflowId: workflow.id,
      workflowName: "引用用例的工作流",
      status: "draft",
      nodeId: "request-node",
      nodeLabel: "仍引用的请求",
    });

    expect(cases.removeCase(referenced.id, referenced.scope)).toBe(true);
    await expect(cases.save()).rejects.toThrow(/Cannot delete referenced API\/case; workflow callers remain/);

    expect(editor.dirty).toBe(true);
    expect((await api.apiGet(fixture.apiLocator)).api.cases).toContainEqual(referenced);
    expect(await api.wfImpact({ ...fixture.apiLocator, caseId: referenced.id })).toContainEqual({
      workflowId: workflow.id,
      workflowName: "引用用例的工作流",
      status: "draft",
      nodeId: "request-node",
      nodeLabel: "仍引用的请求",
    });
  });

  it("keeps pending fields across scope migration until the case itself is repaired", async () => {
    const { api, fixture, editor, cases } = await seeded();
    const target = editor.api!.cases[0]!;
    const original = JSON.parse(JSON.stringify(target));
    target.requestOverride = JSON.parse(JSON.stringify(editor.api!.contract.request));
    target.requestOverride!.path = "/pending-scope";
    target.parameters = { account: "[REDACTED]" };
    cases.setPendingRestoreFields({ caseId: target.id, scope: target.scope }, [
      { path: "request.path", status: "redacted", needsInput: true },
      { path: "parameters.account", status: "redacted", needsInput: true },
    ], { "request.path": '"/pending-scope"', "parameters.account": '"[REDACTED]"' });
    editor.api!.cases.push({ ...original, scope: "occupied" });
    expect(() => cases.changeScope(target.id, target.scope, "occupied")).toThrow(/已存在 scope/);
    expect(target.scope).toBe(original.scope);
    expect(cases.changeScope(target.id, target.scope, "dev")).toBe(true);
    const writes = vi.spyOn(fileStorage, "save");
    try {
      await expect(cases.save()).rejects.toThrow(/补齐|pending|complete/i);
      expect(writes).not.toHaveBeenCalled();
      expect((await api.apiGet(fixture.apiLocator)).api.cases).toEqual([original]);
      target.requestOverride!.path = "/repaired-scope";
      await expect(cases.save()).rejects.toThrow(/补齐|pending|complete/i);
      expect(writes).not.toHaveBeenCalled();
      target.parameters.account = "repaired-account";
      await cases.save();
      const reopened = await api.apiGet(fixture.apiLocator);
      expect(reopened.api.cases).toHaveLength(1);
      expect(reopened.api.cases[0]).toMatchObject({
        id: target.id, scope: "dev", requestOverride: { path: "/repaired-scope" }, parameters: { account: "repaired-account" },
      });
    } finally {
      writes.mockRestore();
    }
  });

  it("keeps newly applied pending fields when an older safe save completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-case-save-ack-"));
    const { api, fixture, editor, cases } = await seeded(root);
    const saveDraft = api.caseDraftSave.bind(api);
    for (const reload of [false, true]) {
      const target = editor.api!.cases[0]!;
      const identity = { caseId: target.id, scope: target.scope };
      cases.select(identity.caseId, identity.scope);
      // The submitted safe draft consumes a repaired record; a later apply replaces it.
      target.parameters.account = "safe-account";
      cases.setPendingRestoreFields(identity, [
        { path: "parameters.account", status: "redacted", needsInput: true },
      ], { "parameters.account": '"old-placeholder"' });
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      api.caseDraftSave = async (...args) => {
        const saved = await saveDraft(...args);
        started();
        await gate;
        return saved;
      };
      const generation = editor.sessions[editor.activeKey!]!.generation;
      const saving = cases.save();
      await entered;
      if (reload) {
        editor.evictProject(fixture.projectLocator, root);
        await editor.load(fixture.apiLocator);
        expect(editor.sessions[editor.activeKey!]!.generation).not.toBe(generation);
      }
      const current = editor.api!.cases[0]!;
      current.parameters.account = "[REDACTED]";
      cases.setPendingRestoreFields(identity, [
        { path: "parameters.account", status: "redacted", needsInput: true },
      ], { "parameters.account": '"[REDACTED]"' });
      release();
      await saving;
      api.caseDraftSave = saveDraft;
      expect(current.parameters.account).toBe("[REDACTED]");
      const writes = vi.spyOn(fileStorage, "save");
      try {
        await expect(cases.save()).rejects.toThrow(/补齐|pending|complete/i);
        expect(writes).not.toHaveBeenCalled();
      } finally {
        writes.mockRestore();
      }
      expect((await api.apiGet(fixture.apiLocator)).api.cases[0]!.parameters.account).toBe("safe-account");
      current.parameters.account = "repaired-account";
      await cases.save();
      expect((await api.apiGet(fixture.apiLocator)).api.cases[0]!.parameters.account).toBe("repaired-account");
    }
  });

  it("rejects writes while the editor context is read-only", async () => {
    const { cases } = await seeded(undefined, true);
    expect(() => cases.addCase({ name: "blocked", scope: "base" })).toThrow(/只读/);
  });
});
