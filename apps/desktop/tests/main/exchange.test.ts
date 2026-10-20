import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileStorage, listContractWorkspaceDefinitionFiles } from "@apicc/core";
import type { Importer, StorageAdapter } from "@apicc/core";
import { encodeContractWorkspace } from "../../../../packages/core/src/storage/contractFiles.js";
import { commitWritePlan } from "../../../../packages/core/src/storage/writeJournal.js";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";
import { IpcChannel } from "../../src/shared/channels.js";
import { parseContractOpenapi } from "../../../../packages/core/src/import/contractOpenapi.js";
import { createMockConfiguredProject, mockFixtureIds } from "../../../../packages/core/tests/helpers/mockFixtures.js";
import { countingStorage, IDS, makeTempRoot, makeWorkspace, persistWorkspace, uuid } from "./helpers/contract-assets.js";

describe("host-owned import exchange", () => {
  it("derives asset graph errors from plugins and rejects invalid project/module candidates inside the write queue", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const parsed = parseContractOpenapi({
        openapi: "3.0.3",
        info: { title: "Plugin project with a missing model", version: "1.0.0" },
        paths: { "/detached": { get: { operationId: "detached" } } },
      }).project;
      const api = parsed.collections[0]!.apis[0]!;
      const request = api.contract.request;
      if (request.protocol !== "http") throw new Error("OpenAPI import fixture must use an HTTP request.");
      request.body = {
        kind: "json",
        content: "{}",
        schema: { kind: "modelRef", modelId: uuid(800) },
      };
      const importer: Importer = {
        name: "untrusted-empty-diagnostics",
        detect: () => true,
        parse: () => ({ project: structuredClone(parsed), diagnostics: [], warnings: [] }),
      };
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, importers: [importer], pickDirectory: async () => "", saveFile: async () => "" });
      const preview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "untrusted.fixture", content: "empty diagnostics" });
      expect(preview.diagnostics).toContainEqual(expect.objectContaining({
        severity: "error",
        code: "ASSET_REFERENCE_MISSING",
        path: "contract.request.body.schema.modelId",
      }));
      const plan = await deps.handle(IpcChannel.ImportPlan, null, {
        previewToken: preview.token,
        mode: "project",
        target: { workspaceId: IDS.workspace, groupId: IDS.groupTwo },
        name: parsed.name,
      });
      await expect(deps.handle(IpcChannel.ImportApply, null, { planToken: plan.token, allowLossy: true }))
        .rejects.toThrow(/结构或引用错误/);

      const context = session.captureDraftWriteContext();
      await expect(session.importProjectToGroup({ workspaceId: IDS.workspace, groupId: IDS.groupTwo }, parsed.name, { project: parsed }))
        .rejects.toThrow(/ASSET_REFERENCE_MISSING/);
      await expect(session.importProjectToGroupTransaction(context, { workspaceId: IDS.workspace, groupId: IDS.groupTwo }, parsed.name, { project: parsed }))
        .rejects.toThrow(/ASSET_REFERENCE_MISSING/);
      await expect(session.importModuleToProject({ workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, parsed.name, { project: parsed }))
        .rejects.toThrow(/ASSET_REFERENCE_MISSING/);
      await expect(session.importModuleToProjectTransaction(context, { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, parsed.name, { project: parsed }))
        .rejects.toThrow(/ASSET_REFERENCE_MISSING/);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
    } finally {
      await temporary.dispose();
    }
  });

  it("deduplicates preview and merge diagnostics while redacting public plan entry text but keeping decision IDs", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const targetProject = { ...createMockConfiguredProject(), id: IDS.projectOne };
      workspace.groups[0]!.projects[0] = targetProject;
      await persistWorkspace(temporary.path, workspace);
      const source = parseContractOpenapi({
        openapi: "3.0.3",
        info: { title: "Entry redaction source", version: "1.0.0" },
        paths: { "/items/{id}": { get: { operationId: "incoming" } } },
      }).project;
      source.collections[0]!.name = "C:\\Users\\imini\\secret\\source-module";
      const sourceApi = source.collections[0]!.apis[0]!;
      sourceApi.contract.metadata.name = "Bearer synthetic-secret";
      const diagnosticMessage = "The target API is referenced by a Mock rule; overwrite would replace response bindings used by that rule.";
      const duplicateDiagnostic = {
        severity: "error" as const,
        code: "IMPORT_MERGE_MOCK_REFERENCE_PROTECTED",
        ownerId: sourceApi.contract.id,
        path: `mock/rules/${mockFixtureIds.rule}`,
        message: diagnosticMessage,
        reason: diagnosticMessage,
        lossy: false,
      };
      const importer: Importer = {
        name: "diagnostic-and-entry-source",
        detect: () => true,
        parse: () => ({
          project: structuredClone(source),
          diagnostics: [duplicateDiagnostic],
          warnings: [],
        }),
      };
      const session = createSession();
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, importers: [importer], pickDirectory: async () => "", saveFile: async () => "" });
      const preview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "source.fixture", content: "same diagnostic twice" });
      const targetLocator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      const plan = await deps.handle(IpcChannel.ImportPlan, null, {
        previewToken: preview.token,
        mode: "merge",
        target: { ...targetLocator, collectionId: targetProject.collections[0]!.id },
        sourceCollectionIds: [source.collections[0]!.id],
        decisions: { [sourceApi.contract.id]: { action: "overwrite", targetApiId: createMockConfiguredProject().collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.id } },
      });

      expect(plan.diagnostics.filter((item) => item.code === "IMPORT_MERGE_MOCK_REFERENCE_PROTECTED")).toHaveLength(1);
      expect(plan.entries).toContainEqual(expect.objectContaining({
        sourceApiId: sourceApi.contract.id,
        sourceName: "Bearer [redacted]",
        sourcePath: "[local path]",
        targetApiIds: [createMockConfiguredProject().collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.id],
      }));
      const publicEntries = JSON.stringify(plan.entries);
      expect(publicEntries).not.toContain("synthetic-secret");
      expect(publicEntries).not.toContain("C:\\Users\\imini\\secret");
    } finally {
      await temporary.dispose();
    }
  });

  it("undo restores saved Mock targets and stops a newly imported Mock project using the commit receipt", async () => {
    const temporary = await makeTempRoot();
    let deps: ReturnType<typeof createIpcDeps> | undefined;
    const runningLocators: Array<{ workspaceId: string; groupId: string; projectId: string }> = [];
    try {
      const workspace = makeWorkspace();
      workspace.groups[0]!.projects[0] = { ...createMockConfiguredProject(), id: IDS.projectOne };
      await persistWorkspace(temporary.path, workspace);
      const sourceMockProject = { ...createMockConfiguredProject(), id: uuid(901), name: "Imported Mock project" };
      const sourceModule = parseContractOpenapi({
        openapi: "3.0.3",
        info: { title: "Imported module", version: "1.0.0" },
        paths: { "/new-module-route": { get: { operationId: "newModuleRoute" } } },
      }).project;
      const importer: Importer = {
        name: "mock-undo-source",
        detect: () => true,
        parse: (content) => ({ project: structuredClone(content === "project" ? sourceMockProject : sourceModule), diagnostics: [], warnings: [] }),
      };
      const session = createSession();
      await session.open(temporary.path);
      deps = createIpcDeps({ session, importers: [importer], pickDirectory: async () => "", saveFile: async () => "" });
      const target = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      const getMock = (locator: typeof target) => deps!.handle(IpcChannel.MockGet, null, locator);
      const startMock = async (locator: typeof target) => {
        const current = await getMock(locator);
        const started = await deps!.handle(IpcChannel.MockStart, null, { locator, sourceProjectRevision: current.sourceProjectRevision, port: 0 });
        expect(started.status).toBe("running");
        runningLocators.push(locator);
        return started;
      };

      const originalServer = await startMock(target);
      const projectPreview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "project.fixture", content: "project" });
      const projectPlan = await deps.handle(IpcChannel.ImportPlan, null, {
        previewToken: projectPreview.token,
        mode: "project",
        target: { workspaceId: IDS.workspace, groupId: IDS.groupTwo },
        name: "Imported Mock project",
      });
      const projectApplied = await deps.handle(IpcChannel.ImportApply, null, { planToken: projectPlan.token, allowLossy: false });
      const importedProject = session.workspace!.groups.find((group) => group.id === IDS.groupTwo)!.projects.find((item) => item.name === "Imported Mock project")!;
      const importedLocator = { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: importedProject.id };
      const importedServer = await startMock(importedLocator);
      await expect((await fetch(`http://127.0.0.1:${importedServer.address!.port}/items/item-7`)).json()).resolves.toEqual({ id: "item-7" });
      await deps.handle(IpcChannel.ImportUndo, null, { undoToken: projectApplied.undoToken! });
      await expect(getMock(importedLocator)).rejects.toThrow(/Project not found/);
      await expect(fetch(`http://127.0.0.1:${importedServer.address!.port}/items/item-7`)).rejects.toThrow();

      const beforeModule = await getMock(target);
      const modulePreview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "module.fixture", content: "module" });
      const modulePlan = await deps.handle(IpcChannel.ImportPlan, null, {
        previewToken: modulePreview.token,
        mode: "module",
        target,
        name: "Imported module",
      });
      const moduleApplied = await deps.handle(IpcChannel.ImportApply, null, { planToken: modulePlan.token, allowLossy: false });
      const changedModuleStatus = await getMock(target);
      expect(changedModuleStatus.status).toBe("running");
      expect(changedModuleStatus.sourceProjectRevision).not.toBe(beforeModule.sourceProjectRevision);
      await deps.handle(IpcChannel.ImportUndo, null, { undoToken: moduleApplied.undoToken! });
      const restoredStatus = await getMock(target);
      expect(restoredStatus.status).toBe("running");
      expect(restoredStatus.sourceProjectRevision).toBe(beforeModule.sourceProjectRevision);
      await expect((await fetch(`http://127.0.0.1:${originalServer.address!.port}/items/item-7`)).json()).resolves.toEqual({ id: "item-7" });
    } finally {
      await Promise.all(runningLocators.map((locator) => deps?.handle(IpcChannel.MockProjectClose, null, { root: temporary.path, locator })));
      await temporary.dispose();
    }
  });

  it("rejects a renderer-supplied project that is detached from any host preview", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const rendererProject = parseContractOpenapi({
        openapi: "3.0.3",
        info: { title: "Unpreviewed project", version: "1.0.0" },
        paths: { "/detached": { get: { operationId: "detached" } } },
      }).project;

      const before = session.workspace;
      const revision = session.revision;
      const rawHandle = deps.handle.bind(deps) as unknown as (channel: string, event: object, ...args: unknown[]) => Promise<unknown>;
      await expect(rawHandle(IpcChannel.ImportApply, {}, {
        mode: "project",
        target: { workspaceId: IDS.workspace, groupId: IDS.groupOne },
        name: "Detached apply",
        project: rendererProject,
      })).rejects.toThrow();
      expect(session.workspace).toEqual(before);
      expect(session.revision).toBe(revision);
    } finally {
      await temporary.dispose();
    }
  });

  it("commits once through the host plan, restores once, and rejects stale preview/undo contexts", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const initial = session.workspace;
      const fileName = "exchange.openapi.json";
      const content = JSON.stringify({ openapi: "3.0.3", info: { title: "Exchange project", version: "1.0.0" }, paths: {} });
      const preview = await deps.handle(IpcChannel.ImportPreview, null, { fileName, content });
      expect(preview).not.toHaveProperty("project");
      expect(preview).toHaveProperty("token");
      const plan = await deps.handle(IpcChannel.ImportPlan, null, {
        previewToken: preview.token,
        mode: "project",
        target: { workspaceId: IDS.workspace, groupId: IDS.groupOne },
        name: "Exchange project",
      });
      const applied = await deps.handle(IpcChannel.ImportApply, null, { planToken: plan.token, allowLossy: false });
      expect(applied).toMatchObject({ committed: true, undoToken: expect.any(String) });
      const committedRevision = session.revision;
      expect(session.workspace!.groups[0]!.projects.some((project) => project.name === "Exchange project")).toBe(true);
      expect(await deps.handle(IpcChannel.ImportApply, null, { planToken: plan.token, allowLossy: false })).toEqual(applied);
      expect(session.revision).toBe(committedRevision);
      await deps.handle(IpcChannel.ImportUndo, null, { undoToken: applied.undoToken! });
      expect(session.workspace).toEqual(initial);

      const stalePreview = await deps.handle(IpcChannel.ImportPreview, null, { fileName, content });
      await session.createGroup({ workspaceId: IDS.workspace }, "revision moved");
      await expect(deps.handle(IpcChannel.ImportPlan, null, {
        previewToken: stalePreview.token,
        mode: "project",
        target: { workspaceId: IDS.workspace, groupId: IDS.groupOne },
        name: "stale",
      })).rejects.toThrow(/已过期/);

      const undoPreview = await deps.handle(IpcChannel.ImportPreview, null, { fileName, content });
      const undoPlan = await deps.handle(IpcChannel.ImportPlan, null, {
        previewToken: undoPreview.token,
        mode: "project",
        target: { workspaceId: IDS.workspace, groupId: IDS.groupOne },
        name: "undo guard",
      });
      const undoApplied = await deps.handle(IpcChannel.ImportApply, null, { planToken: undoPlan.token, allowLossy: false });
      await session.createGroup({ workspaceId: IDS.workspace }, "later edit");
      await expect(deps.handle(IpcChannel.ImportUndo, null, { undoToken: undoApplied.undoToken! })).rejects.toThrow(/撤销已失效/);
    } finally {
      await temporary.dispose();
    }
  });

  it("rolls the journal back on a mid-replace failure without publishing session state", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const base = fileStorage;
      let injected = false;
      const storage: StorageAdapter = {
        load: (root) => base.load(root),
        save: async (root, workspace, options) => commitWritePlan(root, encodeContractWorkspace(workspace), {
          ...options,
          faultInjector: (stage) => {
            if (!injected && stage === "after-replace") {
              injected = true;
              throw new Error("mid-replace fault");
            }
          },
        }),
      };
      const session = createSession({ storage });
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const before = session.workspace;
      const beforeRevision = session.revision;
      const beforeFiles = await Promise.all(listContractWorkspaceDefinitionFiles(session.workspace!).map(async (path) => [path, await readFile(join(temporary.path, path))] as const));
      const content = JSON.stringify({ openapi: "3.0.3", info: { title: "Rollback candidate", version: "1.0.0" }, paths: {} });
      const preview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "rollback.openapi.json", content });
      const plan = await deps.handle(IpcChannel.ImportPlan, null, {
        previewToken: preview.token,
        mode: "project",
        target: { workspaceId: IDS.workspace, groupId: IDS.groupOne },
        name: "Rollback candidate",
      });

      await expect(deps.handle(IpcChannel.ImportApply, null, { planToken: plan.token, allowLossy: false }))
        .rejects.toThrow(/Workspace write failed/);
      expect(injected).toBe(true);
      expect(session.workspace).toEqual(before);
      expect(session.revision).toBe(beforeRevision);
      const reloaded = await fileStorage.load(temporary.path);
      expect(reloaded.workspace).toEqual(before);
      expect(reloaded.revision).toBe(beforeRevision);
      for (const [path, bytes] of beforeFiles) expect(await readFile(join(temporary.path, path))).toEqual(bytes);
    } finally {
      await temporary.dispose();
    }
  });
});
