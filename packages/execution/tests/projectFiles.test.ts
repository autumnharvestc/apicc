import { describe, expect, it } from "vitest";
import { encodeContractProjectFiles, decodeContractProjectFiles, ContractWorkspaceSchema, createProjectSnapshot, StressPlanSchema, WorkflowSchema } from "@apicc/core";
import { workspaceFixture } from "../../core/tests/helpers/contractFixtures.js";
import { createHash } from "node:crypto";
import { prepareProjectFiles, assertPreparedExecution } from "../src/host/prepare.js";
import { resolveEffectiveConfig } from "../src/contract/index.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function onlineAssets(project = projectFixture()) {
  const files = [...encodeContractProjectFiles(project).files].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([path, content]) => ({ path, content, version: "1", hash: hash(content), size: Buffer.byteLength(content) }));
  return { workspaceId: "11", groupId: "22", projectId: "33", format: "contract-files-v1" as const, contractProjectId: project.id,
    version: "1", manifestHash: hash(files.map(file => `${file.path}\0${file.version}\0${file.hash}\0${file.size}\n`).join("")), files };
}
function debugInput() {
  const project = projectFixture(); const collection = project.collections[0]!; const folders = collection.folders[0]!;
  const api = folders.folders[0]!.apis[0]!;
  const locator = { workspaceId: "internal-workspace", groupId: "internal-group", projectId: project.id, collectionId: collection.id, folderIds: [folders.id, folders.folders[0]!.id], apiId: api.contract.id };
  return { target: { kind: "debug" as const, invocation: { mode: "case" as const, locator, case: { ...locator, caseId: api.cases[0]!.id, scope: "base" } } }, profile: "trusted-core-script" as const };
}

function projectFixture() {
  const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  const collection = project.collections[0]!;
  collection.folders[0]!.folders[0]!.apis.push(collection.apis.pop()!);
  project.suites = [{ formatVersion: 1, id: "00000000-0000-4000-8000-000000000081", name: "Selected", tags: [], selection: { kind: "query", caseTags: [] }, failFast: false, reporters: ["html"] }];
  return project;
}

describe("project-relative contract files", () => {
  it("maps lifecycle, subflow, handler and v1-condition scripts to their real frozen sources", async () => {
    const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const collection = project.collections[0]!; const api = collection.apis[0]!;
    collection.preOperations = []; api.cases[0]!.preOperations = [];
    const condition = (id: string) => WorkflowSchema.parse({ id, name: id, status: "enabled", nodes: [{ id: "start", kind: "noop" }, { id: "end", kind: "noop" }], edges: [{ id: "condition", from: "start", to: "end", condition: "true" }] });
    project.workflows = [condition("setup-condition"), condition("handler-condition"), WorkflowSchema.parse({ id: "root", name: "root", status: "enabled", executionVersion: 2,
      nodes: [{ id: "child", kind: "subflow", workflowId: "setup-condition", policy: { finally: { workflowId: "handler-condition" } } }], edges: [] })];
    const target = { kind: "stress" as const, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: "workflow", workflowId: "root" },
      load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 }, lifecycle: { setup: { workflowId: "setup-condition" }, vuSetup: { workflowId: "root" }, vuTeardown: { workflowId: "root" }, teardown: { workflowId: "setup-condition" } } }) };
    const value = await prepareProjectFiles(onlineAssets(project), { target, profile: "trusted-core-script" });
    expect(value.scriptRequirements.map(item => item.scriptId).sort()).toEqual(["workflow/handler-condition/edge/condition", "workflow/setup-condition/edge/condition"]);
    expect(value.scriptRequirements.every(item => item.source.filePath === "project.yaml")).toBe(true);
    await expect(prepareProjectFiles(onlineAssets(project), { target, profile: "no-script" })).rejects.toThrow(/script/i);
  });
  it("freezes the real Core request limit instead of the administrative admission upper bound", async () => {
    const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    project.stressPolicy.maxConcurrency = 3; project.stressPolicy.maxRps = 9;
    const collection = project.collections[0]!; const api = collection.apis[0]!;
    const target = { kind: "stress" as const, plan: StressPlanSchema.parse({ formatVersion: 1,
      target: { kind: "case", collectionId: collection.id, apiId: api.contract.id, caseId: api.cases[0]!.id },
      load: { kind: "constant-vus", vus: 2 }, maxVus: 2, termination: { maxIterations: 2 } }) };
    const value = await prepareProjectFiles(onlineAssets(project), { target, profile: "trusted-core-script", stressConfig: { configuration: resolveEffectiveConfig(), run: { workerCount: 2 } } });
    expect(value.prepared.stressBinding).toMatchObject({ stage: "compiled-limits", requested: { maxRequestConcurrency: null, maxRps: null },
      admissionLimits: { maxRequestConcurrency: 100, maxRps: 1000 }, reservation: { jobs: 1, processes: 3, vus: 2, requestConcurrency: 2, maxRps: 9, metricMemoryBytes: 201326592 } });
    expect(value.prepared.target).toEqual(target);
  });
  it("prepares a real case stress selection from authoritative project files", async () => {
    const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const collection = project.collections[0]!; const api = collection.apis[0]!;
    const target = { kind: "stress" as const, plan: StressPlanSchema.parse({ formatVersion: 1,
      target: { kind: "case", collectionId: collection.id, apiId: api.contract.id, caseId: api.cases[0]!.id },
      load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } }) };
    const value = await prepareProjectFiles(onlineAssets(project), { target, profile: "trusted-core-script" });
    expect(value.prepared.selections).toHaveLength(1);
    expect(value.prepared.requiredCapabilities).toEqual(["protocol:http", "script:trusted-core", "stress:local-workers-v1", "task:stress"]);
    expect(value.scriptRequirements).toHaveLength(2);
  });
  it("round trips requests, separate cases, nested folders, models, environments, suites and workflows without changing identity", async () => {
    const project = projectFixture();
    const { files } = encodeContractProjectFiles(project);
    expect(files.has("project.yaml")).toBe(true);
    expect([...files.keys()].some(path => path.endsWith("/api.yaml"))).toBe(true);
    expect([...files.keys()].some(path => path.includes("/cases/") && !path.endsWith("index.yaml"))).toBe(true);
    expect([...files.keys()].every(path => !path.startsWith("groups/"))).toBe(true);
    const decoded = await decodeContractProjectFiles(files);
    expect(decoded.problems).toEqual([]);
    expect(decoded.readOnly).toBe(false);
    expect(decoded.project).toEqual(project);
    expect(createProjectSnapshot(decoded.project!).definitionRevision).toBe(createProjectSnapshot(project).definitionRevision);
  });

  it("does not resolve equal display names to a different contract identity", async () => {
    const first = projectFixture(); const second = structuredClone(first);
    second.id = "00000000-0000-4000-8000-000000000088";
    second.variables.owner = "second";
    const left = await decodeContractProjectFiles(encodeContractProjectFiles(first).files);
    const right = await decodeContractProjectFiles(encodeContractProjectFiles(second).files);
    expect(left.project?.id).toBe(first.id);
    expect(right.project?.id).toBe(second.id);
    expect(right.project?.variables.owner).toBe("second");
  });

  it("diagnoses missing metadata and incomplete asset references without rewriting source files", async () => {
    const files = encodeContractProjectFiles(projectFixture()).files;
    const api = [...files.keys()].find(path => path.endsWith("/api.yaml"))!;
    files.delete(api);
    const before = [...files];
    const decoded = await decodeContractProjectFiles(files);
    expect(decoded.problems.length).toBeGreaterThan(0);
    expect(decoded.readOnly).toBe(true);
    expect([...files]).toEqual(before);
    const legacy = await decodeContractProjectFiles(new Map([["old.yaml", "{\"legacy\":true}"]]));
    expect(legacy.project).toBeUndefined();
    expect(legacy.problems[0]?.file).toBe("project.yaml");
  });

  it("prepares the real frozen files and binds inherited and case script sources to bytes and digest", async () => {
    const assets = onlineAssets(); const before = structuredClone(assets);
    const result = await prepareProjectFiles(assets, debugInput());
    expect(() => assertPreparedExecution(result.prepared)).not.toThrow();
    expect(result.scriptRequirements).toHaveLength(2);
    for (const requirement of result.scriptRequirements) {
      const source = assets.files.find(file => file.path === requirement.source.filePath)!;
      expect(source.hash).toBe(requirement.source.fileHash);
      expect(requirement.contentHash).toBe(hash(result.prepared.scriptRequirements.find(item => item.scriptId === requirement.scriptId)!.content));
    }
    expect(result.scriptRequirements.map(item => item.source.filePath).some(path => path.endsWith("collection.yaml"))).toBe(true);
    expect(result.scriptRequirements.map(item => item.source.filePath).some(path => path.includes("/cases/"))).toBe(true);
    expect(result.scriptPlanDigest).toMatch(/^[a-f0-9]{64}$/);
    assets.files[0]!.content = "later edit";
    expect(result.assets).toEqual(before);
    expect(Object.isFrozen(result.assets.files)).toBe(true);
  });

  it("rejects an unmarked project, mismatched UUID and tampered bytes before execution", async () => {
    const assets = onlineAssets();
    await expect(prepareProjectFiles({ ...assets, format: null }, debugInput())).rejects.toThrow(/contract-files-v1/);
    await expect(prepareProjectFiles({ ...assets, contractProjectId: "00000000-0000-4000-8000-000000000099" }, debugInput())).rejects.toThrow(/identity/);
    assets.files[0]!.content = "tampered";
    await expect(prepareProjectFiles(assets, debugInput())).rejects.toThrow(/hash|bytes/);
  });

  it("keeps a verifiable empty script digest and locates v1 conditions in the actual project metadata", async () => {
    const project = projectFixture();
    project.collections[0]!.preOperations = [];
    project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.cases[0]!.preOperations = [];
    const empty = await prepareProjectFiles(onlineAssets(project), { ...debugInput(), profile: "no-script" });
    expect(empty.scriptRequirements).toEqual([]);
    expect(empty.scriptPlanDigest).toBe(hash("[]"));
    const workflowId = "00000000-0000-4000-8000-000000000092";
    project.workflows = [{ id: workflowId, name: "condition", status: "enabled", nodes: [{ id: "a", kind: "noop" }, { id: "b", kind: "noop" }], edges: [{ id: "conditional", from: "a", to: "b", condition: "true" }] }];
    const assets = onlineAssets(project);
    const condition = await prepareProjectFiles(assets, { target: { kind: "workflow", workflowId }, profile: "trusted-core-script" });
    expect(condition.scriptRequirements).toEqual([{ scriptId: `workflow/${workflowId}/edge/conditional`, contentHash: hash("true"), kind: "condition", source: { filePath: "project.yaml", fileHash: assets.files.find(file => file.path === "project.yaml")!.hash } }]);
  });
});
