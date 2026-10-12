// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

  it("rejects writes while the editor context is read-only", async () => {
    const { cases } = await seeded(undefined, true);
    expect(() => cases.addCase({ name: "blocked", scope: "base" })).toThrow(/只读/);
  });
});
