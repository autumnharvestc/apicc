import { describe, expect, it } from "vitest";
import { classifyAssetMutation } from "../../src/collaboration/mutation.js";
import { decodeContractProjectFiles, encodeContractProjectFiles } from "../../src/storage/contractFiles.js";
import { documentProject } from "./fixtures.js";

const files = (project: ReturnType<typeof documentProject>) => encodeContractProjectFiles(project).files;
describe("script-sensitive mutation of fixed decoded assets", () => {
  // Break caught: looking only at current API scripts misses inherited or deleted script-bearing material.
  it.each(["collection", "ancestor-folder", "case", "legacy-condition", "subflow-condition", "deleted-ancestor"])("finds actual %s script changes", async (kind) => {
    const before = documentProject(); const after = structuredClone(before);
    const folder = after.collections[0]!.folders[0]!.folders[0]!;
    if (kind === "collection") after.collections[0]!.preOperations.push({ id: "module-script", type: "script", content: "pm.test('new',()=>true)" });
    if (kind === "ancestor-folder") folder.preOperations[0]!.content += "\npm.test('new',()=>true)";
    if (kind === "case") folder.apis[0]!.cases[0]!.postOperations.push({ id: "new-case-hook", type: "script", content: "pm.test('new',()=>true)" });
    if (kind === "legacy-condition") {
      before.workflows[0]!.edges.push({ id: "edge", from: "a", to: "b", condition: "true" });
      after.workflows[0]!.edges.push({ id: "edge", from: "a", to: "b", condition: "false" });
    }
    if (kind === "subflow-condition") {
      before.workflows = [{ id: "root", name: "root", status: "enabled", executionVersion: 2,
        nodes: [{ id: "call", kind: "subflow", workflowId: "child", inputs: {}, outputs: {} }], edges: [], inputs: {}, outputs: {}, limits: { maxConcurrency: 4, timeoutMs: 300000 } },
        { id: "child", name: "child", status: "enabled", nodes: [{ id: "a", kind: "noop" }, { id: "b", kind: "noop" }], edges: [{ id: "child-js", from: "a", to: "b", condition: "true" }] }];
      after.workflows = structuredClone(before.workflows);
      const child = after.workflows[1]!;
      if (child.executionVersion === 2) throw new Error("legacy child fixture required");
      child.edges[0]!.condition = "false";
    }
    if (kind === "deleted-ancestor") after.collections[0]!.folders = [];
    const beforeFiles = files(before); const afterFiles = files(after);
    for (const snapshot of [beforeFiles, afterFiles]) {
      const decoded = await decodeContractProjectFiles(snapshot);
      expect(decoded.project, JSON.stringify(decoded.problems)).toBeDefined();
      expect(decoded.readOnly, JSON.stringify(decoded.problems)).toBe(false);
    }
    const result = await classifyAssetMutation(beforeFiles, afterFiles);
    expect.soft(result.scriptChanged).toBe(true);
    expect.soft(result.locations.length).toBeGreaterThan(0);
    expect.soft(result.locations.join(" ")).not.toMatch(/(?:[A-Za-z]:\\|\/home\/|\.ya?ml)/);
  });
  it("does not treat metadata edits, equivalent hooks, or ordering as script changes", async () => {
    const before = documentProject(); const after = structuredClone(before);
    after.name = "renamed project"; after.collections[0]!.name = "renamed module";
    after.models.reverse(); after.collections[0]!.apis[0]!.contract.metadata.description = "ordinary metadata";
    expect(await classifyAssetMutation(files(before), files(after))).toEqual({ scriptChanged: false, locations: [] });
  });
  it("keeps changing an existing child reference outside script-edit classification", async () => {
    const before = documentProject();
    before.workflows = [{ id: "root", name: "root", status: "enabled", executionVersion: 2,
      nodes: [{ id: "call", kind: "subflow", workflowId: "child-a", inputs: {}, outputs: {} }], edges: [], inputs: {}, outputs: {}, limits: { maxConcurrency: 4, timeoutMs: 300000 } },
      ...["child-a", "child-b"].map((id) => ({ id, name: id, status: "enabled" as const, nodes: [{ id: "a", kind: "noop" as const }, { id: "b", kind: "noop" as const }], edges: [{ id: "condition", from: "a", to: "b", condition: "true" }] }))];
    const after = structuredClone(before); const node = after.workflows[0]!.nodes[0]!;
    if (node.kind !== "subflow") throw new Error("subflow fixture required");
    node.workflowId = "child-b";
    for (const project of [before, after]) expect((await decodeContractProjectFiles(files(project))).readOnly).toBe(false);
    expect(await classifyAssetMutation(files(before), files(after))).toEqual({ scriptChanged: false, locations: [] });
  });
  it.each(["before", "after"])("rejects invalid %s fixed files instead of guessing safe", async (which) => {
    const valid = files(documentProject());
    await expect(classifyAssetMutation(which === "before" ? new Map() : valid, which === "after" ? new Map() : valid)).rejects.toThrow("PUBLICATION_SOURCE_INVALID");
  });
  it("classifies a server-authorized empty initial project and still decodes the complete candidate", async () => {
    const initial = documentProject();
    const scripted = files(initial);
    initial.collections = [];
    initial.workflows = [];
    const ordinary = files(initial);
    const before = new Map<string, string>();
    const allowed = { initialContractProjectId: initial.id };
    await expect(classifyAssetMutation(before, ordinary, allowed)).resolves.toEqual({ scriptChanged: false, locations: [] });
    await expect(classifyAssetMutation(before, scripted, allowed)).resolves.toMatchObject({ scriptChanged: true });
    await expect(classifyAssetMutation(before, new Map(), allowed)).rejects.toThrow("PUBLICATION_SOURCE_INVALID");
    await expect(classifyAssetMutation(before, ordinary, { initialContractProjectId: "10000000-0000-4000-8000-000000000999" })).rejects.toThrow("PUBLICATION_SOURCE_INVALID");
    await expect(classifyAssetMutation(ordinary, scripted, allowed)).rejects.toThrow("PUBLICATION_SOURCE_INVALID");
    await expect(classifyAssetMutation(new Map([["legacy.json", "{}"]]), ordinary, allowed)).rejects.toThrow("PUBLICATION_SOURCE_INVALID");
  });
});
