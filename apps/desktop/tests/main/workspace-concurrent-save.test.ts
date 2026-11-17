import { describe, expect, it } from "vitest";
import { encodeContractWorkspace, fileStorage, readStableContractWorkspace } from "@apicc/core";
import { commitWritePlan } from "@apicc/core/sync";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";
import { IpcChannel } from "../../src/shared/channels.js";
import { resolveWorkspaceDirectory, sameWorkspaceDirectory } from "../../src/main/workspaceDirectory.js";
import { IDS, makeTempRoot, makeWorkspace, persistWorkspace } from "./helpers/contract-assets.js";

const { workspace, groupOne, groupTwo, projectOne, projectTwo, collectionOne, collectionTwo, sharedApi } = IDS;
const left = { workspaceId: workspace, groupId: groupOne, projectId: projectOne, collectionId: collectionOne, folderIds: [], apiId: sharedApi };
const right = { workspaceId: workspace, groupId: groupTwo, projectId: projectTwo, collectionId: collectionTwo, folderIds: [], apiId: sharedApi };
const transport = () => createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "" });

describe("local collaborative definition save", () => {
  it("saves across another local instance's unrelated project edit and keeps the other project on its applied version", async () => {
    const temporary = await makeTempRoot("apicc-collaborative-local-");
    const first = transport(), second = transport();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const opened = await first.handle(IpcChannel.WsOpen, {}, temporary.path);
      await second.handle(IpcChannel.WsOpen, {}, temporary.path);
      const local = await first.handle(IpcChannel.ApiGet, {}, left);
      const external = await second.handle(IpcChannel.ApiGet, {}, right);
      external.api.contract.metadata.name = "Edited by the second workspace";
      await second.handle(IpcChannel.ApiSave, {}, right, external.api, external.sourceApiRevision);
      await expect(first.handle(IpcChannel.ApiRequestDraftSave, {}, left, { ...local.api.contract.request, path: "/saved-by-first" }, local.sourceApiRevision, []))
        .resolves.toMatchObject({ request: { path: "/saved-by-first" } });
      expect((await first.handle(IpcChannel.ApiGet, {}, right)).api.contract.metadata.name).not.toBe(external.api.contract.metadata.name);
      const pending = await first.handle(IpcChannel.WsObserve, {}, { root: opened.root, workspaceId: workspace });
      expect(pending.changes).toEqual([expect.objectContaining({ project: { workspaceId: workspace, groupId: groupTwo, projectId: projectTwo },
        changes: [expect.objectContaining({ asset: "api", kind: "modified", name: external.api.contract.metadata.name })] })]);
      const disk = await readStableContractWorkspace(opened.root);
      expect(disk.workspace.groups[0]?.projects[0]?.collections[0]?.apis[0]?.contract.request.path).toBe("/saved-by-first");
      expect(disk.workspace.groups[1]?.projects[0]?.collections[0]?.apis[0]?.contract.metadata.name).toBe(external.api.contract.metadata.name);
      const later = structuredClone(disk.workspace);
      later.groups[1]!.projects[0]!.name = "Written after review";
      await fileStorage.save(opened.root, later, { expectedRevision: disk.revision, deletions: [] });
      await expect(first.handleTransport(IpcChannel.WsRefresh, {}, { root: opened.root, workspaceId: workspace, observedRevision: pending.revision }))
        .resolves.toMatchObject({ reason: "revision-conflict" });
      expect((await first.handle(IpcChannel.ApiGet, {}, right)).api.contract.metadata.name).not.toBe(external.api.contract.metadata.name);
      const refreshed = await first.handle(IpcChannel.WsObserve, {}, { root: opened.root, workspaceId: workspace });
      await first.handle(IpcChannel.WsRefresh, {}, { root: opened.root, workspaceId: workspace, observedRevision: refreshed.revision });
      expect((await first.handle(IpcChannel.ApiGet, {}, right)).api.contract.metadata.name).toBe(external.api.contract.metadata.name);
    } finally { await temporary.dispose(); }
  });
  it.each(["same asset", "workspace variable", "parent operations"] as const)("blocks a save after a competing %s change", async change => {
    const temporary = await makeTempRoot("apicc-collaborative-conflict-");
    const instance = transport();
    try {
      const definition = makeWorkspace();
      await persistWorkspace(temporary.path, definition);
      const opened = await instance.handle(IpcChannel.WsOpen, {}, temporary.path);
      const local = await instance.handle(IpcChannel.ApiGet, {}, left);
      if (change === "same asset") definition.groups[0]!.projects[0]!.collections[0]!.apis[0]!.contract.metadata.name = "An actual competing edit";
      if (change === "workspace variable") definition.variables.tenant = "new tenant";
      if (change === "parent operations") definition.groups[0]!.projects[0]!.collections[0]!.preOperations = [];
      const competing = await fileStorage.save(opened.root, definition, { expectedRevision: opened.revision, deletions: [] });
      await expect(instance.handleTransport(IpcChannel.ApiRequestDraftSave, {}, left, { ...local.api.contract.request, path: "/unsaved" }, local.sourceApiRevision, []))
        .resolves.toMatchObject({ reason: change === "same asset" ? "asset-changed" : "dependency-changed",
          project: { workspaceId: workspace, groupId: groupOne, projectId: projectOne } });
      expect((await readStableContractWorkspace(opened.root)).revision).toBe(competing.revision);
      expect((await instance.handle(IpcChannel.ApiGet, {}, left)).api.contract.request.path).toBe(local.api.contract.request.path);
    } finally { await temporary.dispose(); }
  });
  it("saves separate physical cases on the same API without showing the other case edit", async () => {
    const temporary = await makeTempRoot("apicc-collaborative-scoped-case-");
    const first = transport(), second = transport();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const opened = await first.handle(IpcChannel.WsOpen, {}, temporary.path);
      await second.handle(IpcChannel.WsOpen, {}, temporary.path);
      const save = async (instance: ReturnType<typeof transport>, scope: string) => {
        const source = await instance.handle(IpcChannel.ApiGet, {}, left);
        const current = source.api.cases.find(item => item.scope === scope)!;
        return instance.handle(IpcChannel.CaseDraftSave, {}, { ...left, caseId: current.id, scope },
          { ...current, name: `Saved ${scope}` }, source.sourceApiRevision, [], []);
      };
      await save(second, "green");
      await expect(save(first, "blue")).resolves.toMatchObject({ testCase: { name: "Saved blue" } });
      expect((await first.handle(IpcChannel.ApiGet, {}, left)).api.cases.map(item => item.name)).not.toContain("Saved green");
      const disk = await readStableContractWorkspace(opened.root);
      expect(disk.workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!.cases.map(item => item.name)).toEqual(expect.arrayContaining(["Saved blue", "Saved green"]));
    } finally { await temporary.dispose(); }
  });
  it("keeps a parallel workflow and split environment save scoped to their own project", async () => {
    const temporary = await makeTempRoot("apicc-collaborative-project-assets-");
    const first = transport(), second = transport();
    const project = { workspaceId: workspace, groupId: groupOne, projectId: projectOne };
    const workflow = { ...project, workflowId: IDS.workflow };
    const environment = { ...project, environmentId: IDS.environment };
    try {
      const definition = makeWorkspace();
      await persistWorkspace(temporary.path, definition);
      const opened = await first.handle(IpcChannel.WsOpen, {}, temporary.path);
      await second.handle(IpcChannel.WsOpen, {}, temporary.path);
      const other = await second.handle(IpcChannel.ApiGet, {}, right);
      other.api.contract.metadata.name = "Unapplied project B";
      await second.handle(IpcChannel.ApiSave, {}, right, other.api, other.sourceApiRevision);
      const detail = await first.handle(IpcChannel.WfGet, {}, workflow);
      await expect(first.handle(IpcChannel.WfSave, {}, workflow, { ...detail.workflow, name: "Saved project A workflow" }))
        .resolves.toMatchObject({ name: "Saved project A workflow" });
      await expect(first.handle(IpcChannel.EnvVarsSave, {}, environment, { tenant: "updated" })).resolves.toMatchObject({ variables: { tenant: "updated" } });
      await expect(first.handle(IpcChannel.EnvBaseUrlsSave, {}, environment, { [collectionOne]: "https://new.example.test" }))
        .resolves.toMatchObject({ variables: { tenant: "updated" }, baseUrls: { [collectionOne]: "https://new.example.test" } });
      expect((await first.handle(IpcChannel.ApiGet, {}, right)).api.contract.metadata.name).not.toBe(other.api.contract.metadata.name);
      const disk = await readStableContractWorkspace(opened.root);
      expect(disk.workspace.groups[0]!.projects[0]!.workflows[0]!.name).toBe("Saved project A workflow");
      expect(disk.workspace.groups[1]!.projects[0]!.collections[0]!.apis[0]!.contract.metadata.name).toBe("Unapplied project B");
    } finally { await temporary.dispose(); }
  });
  it("saves an independent dataset and protects a suite from a changed referenced dataset", async () => {
    const temporary = await makeTempRoot("apicc-collaborative-testing-assets-");
    const first = transport(), second = transport();
    const project = { workspaceId: workspace, groupId: groupOne, projectId: projectOne };
    const dataset = { formatVersion: 1 as const, id: crypto.randomUUID(), name: "Data A", columns: ["region"], rows: [{ region: "old" }] };
    const suite = { formatVersion: 1 as const, id: crypto.randomUUID(), name: "Using A", datasetId: dataset.id, environmentId: IDS.environment,
      tags: [], selection: { kind: "explicit" as const, entries: [{ id: crypto.randomUUID(), kind: "case" as const,
        collectionId: collectionOne, folderIds: [], apiId: sharedApi, caseId: IDS.sharedCase }] },
      reporters: ["html" as const], failFast: false };
    try {
      const definition = makeWorkspace();
      const leftProject = definition.groups[0]!.projects[0]!;
      leftProject.datasets = [dataset]; leftProject.suites = [suite];
      await persistWorkspace(temporary.path, definition);
      const opened = await first.handle(IpcChannel.WsOpen, {}, temporary.path);
      await second.handle(IpcChannel.WsOpen, {}, temporary.path);
      const other = await second.handle(IpcChannel.ApiGet, {}, right);
      other.api.contract.metadata.description = "Parallel project B save";
      await second.handle(IpcChannel.ApiSave, {}, right, other.api, other.sourceApiRevision);
      const before = await first.handle(IpcChannel.TestingList, {}, { root: opened.root, project });
      const accepted = await first.handle(IpcChannel.DatasetSave, {}, { context: before.context, locator: { ...project, datasetId: dataset.id },
        asset: { ...dataset, rows: [{ region: "own save" }] } });
      expect(accepted.datasets[0]?.rows).toEqual([{ region: "own save" }]);
      const disk = await readStableContractWorkspace(opened.root);
      disk.workspace.groups[0]!.projects[0]!.datasets![0]!.rows = [{ region: "external dependency" }];
      await fileStorage.save(opened.root, disk.workspace, { expectedRevision: disk.revision, deletions: [] });
      await expect(first.handleTransport(IpcChannel.SuiteSave, {}, { context: accepted.context, locator: { ...project, suiteId: suite.id },
        asset: { ...suite, name: "Still an unsaved suite" } })).resolves.toMatchObject({ reason: "dependency-changed" });
    } finally { await temporary.dispose(); }
  });
  it.each(["after-staging", "before-committed-marker"] as const)("preserves an external file changed at %s", async stage => {
    const temporary = await makeTempRoot("apicc-collaborative-race-");
    try {
      const definition = makeWorkspace();
      const original = await persistWorkspace(temporary.path, definition);
      const target = `groups/${groupOne}/projects/${projectOne}/collections/${collectionOne}/apis/${sharedApi}/api.yaml`;
      const file = join(temporary.path, target);
      const base = await readFile(file, "utf8");
      const external = base.replace("project one API", "External writer");
      const planned = base.replace("project one API", "Local writer");
      const pending = commitWritePlan(temporary.path, { files: new Map([[target, planned]]) }, {
        expectedRevision: original, deletions: [], assertDirectory: async () => undefined,
        faultInjector: async point => { if (point === stage) await writeFile(file, external); },
      });
      await expect(pending).rejects.toMatchObject({ reason: "revision-conflict" });
      expect(await readFile(file, "utf8")).toBe(external);
    } finally { await temporary.dispose(); }
  });
  it.each([false, true])("keeps replacement untouched and recovers the returned original (outside edit %s)", async edited => {
    const temporary = await makeTempRoot("apicc-collaborative-physical-");
    try {
      const path = join(temporary.path, "workspace"), replacement = join(temporary.path, "replica"), displaced = join(temporary.path, "displaced");
      const definition = makeWorkspace();
      const original = await persistWorkspace(path, definition);
      await persistWorkspace(replacement, definition);
      const fixed = await resolveWorkspaceDirectory(path);
      const target = `groups/${groupOne}/projects/${projectOne}/collections/${collectionOne}/apis/${sharedApi}/api.yaml`;
      const before = await readFile(join(path, target), "utf8");
      definition.groups[0]!.projects[0]!.collections[0]!.apis[0]!.contract.metadata.name = "Must not write into the replica";
      const planned = encodeContractWorkspace(definition).files.get(target)!;
      await expect(commitWritePlan(path, { files: new Map([[target, planned]]) }, {
        expectedRevision: original, deletions: [],
        assertDirectory: async () => {
          const current = await resolveWorkspaceDirectory(path);
          if (!sameWorkspaceDirectory(fixed, current)) throw new Error("physical directory changed");
        },
        faultInjector: async point => {
          if (point === "after-staging") { await rename(path, displaced); await rename(replacement, path); }
        },
      })).rejects.toThrow("physical directory changed");
      expect(await readFile(join(path, target), "utf8")).toBe(before);
      expect(await readFile(join(displaced, target), "utf8")).toBe(before);
      const returnedContent = edited ? before.replace("project one API", "Outside edit in the displaced directory") : before;
      if (edited) await writeFile(join(displaced, target), returnedContent);
      await rename(path, replacement);
      await rename(displaced, path);
      const restored = await readStableContractWorkspace(path);
      expect(restored.revision === original).toBe(!edited);
      expect(await readFile(join(path, target), "utf8")).toBe(returnedContent);
    } finally { await temporary.dispose(); }
  });
});
