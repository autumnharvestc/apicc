import { describe, expect, it } from "vitest";
import { parseContractOpenapi } from "../../src/import/contractOpenapi.js";
import { buildImportMergePlan } from "../../src/import/merge.js";
import type { ContractProject } from "../../src/contract/workspace.js";

function importedProject(title: string, paths: Record<string, unknown>): ContractProject {
  return parseContractOpenapi({
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    paths,
  }).project;
}

function allApis(project: ContractProject) {
  return project.collections.flatMap((collection) => collection.apis);
}

describe("buildImportMergePlan", () => {
  it("adds only selected source module APIs, skips conflicts by default, and preserves target-owned data on explicit overwrite", async () => {
    const target = importedProject("Target", {
      "/users": { get: { operationId: "localUsers", summary: "Local users" } },
      "/retired": { get: { operationId: "retired" } },
    });
    const imported = importedProject("Incoming", {
      "/users/": { get: { operationId: "incomingUsers", summary: "Incoming users" } },
      "/new": { post: { operationId: "createNew" } },
    });
    const targetApi = allApis(target)[0]!;
    const incomingApi = allApis(imported)[0]!;
    const localCase = {
      id: "00000000-0000-4000-8000-000000000101",
      name: "local regression",
      scope: "base",
      parameters: {},
      preOperations: [],
      postOperations: [],
      assertions: [],
    };
    targetApi.cases = [localCase];
    targetApi.documentation = "Target-owned notes";

    const skipped = buildImportMergePlan(target, imported, {
      targetCollectionId: target.collections[0]!.id,
      sourceCollectionIds: [imported.collections[0]!.id],
      decisions: {},
    });
    expect(skipped.summary).toEqual({ added: 1, overwritten: 0, skipped: 1 });
    expect(skipped.project.collections[0]!.apis.map((api) => api.contract.request.path)).toEqual(["/users", "/retired", "/new"]);

    const overwritten = buildImportMergePlan(target, imported, {
      targetCollectionId: target.collections[0]!.id,
      sourceCollectionIds: [imported.collections[0]!.id],
      decisions: { [incomingApi.contract.id]: { action: "overwrite", targetApiId: targetApi.contract.id } },
    });
    const applied = overwritten.project.collections[0]!.apis.find((api) => api.contract.id === targetApi.contract.id)!;
    expect(overwritten.summary).toEqual({ added: 1, overwritten: 1, skipped: 0 });
    expect(applied.contract.id).toBe(targetApi.contract.id);
    expect(applied.contract.metadata.name).toBe("incomingUsers");
    expect(applied.cases).toEqual([{
      id: "00000000-0000-4000-8000-000000000101", name: "local regression", scope: "base",
      parameters: {}, preOperations: [], postOperations: [], assertions: [], tags: [], extractors: [],
    }]);
    expect(applied.documentation).toBe("Target-owned notes");
    expect(overwritten.project.collections[0]!.apis.map((api) => api.contract.id)).not.toContain(allApis(imported)[1]?.contract.id);
  });

  it("requires an explicit target for ambiguous matches and supports rename and cancel policies", async () => {
    const target = importedProject("Target", {
      "/same": { get: { operationId: "one" } },
      "/same/": { get: { operationId: "two" } },
    });
    const imported = importedProject("Incoming", { "/same": { get: { operationId: "incoming" } } });
    const sourceApi = allApis(imported)[0]!;
    const options = {
      targetCollectionId: target.collections[0]!.id,
      sourceCollectionIds: [imported.collections[0]!.id],
    };

    const ambiguous = buildImportMergePlan(target, imported, { ...options, decisions: { [sourceApi.contract.id]: { action: "overwrite" } } });
    expect(ambiguous.summary).toEqual({ added: 0, overwritten: 0, skipped: 1 });
    expect(ambiguous.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IMPORT_MERGE_AMBIGUOUS_TARGET", severity: "error" }),
    ]));

    const renamed = buildImportMergePlan(target, imported, {
      ...options,
      decisions: { [sourceApi.contract.id]: { action: "rename", name: "Incoming copy" } },
    });
    expect(renamed.summary).toEqual({ added: 1, overwritten: 0, skipped: 0 });
    expect(renamed.project.collections[0]!.apis.at(-1)!.contract.metadata.name).toBe("Incoming copy");

    const cancelled = buildImportMergePlan(target, imported, {
      ...options,
      decisions: { [sourceApi.contract.id]: { action: "cancel" } },
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.project).toEqual(target);
  });
});
