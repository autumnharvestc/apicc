import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  fileStorage,
  type ApiDefinition,
  type CaseOutcome,
  type Collection,
  type Folder,
  type Group,
  type LoadProblem,
  type Project,
  type RunResult,
  type Workspace,
} from "@apicc/core";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";
import type { ApiDetail, ApiccApi, DebugInput, DebugOutput, NodeCreateInput, OpenResult } from "../../../shared/types.js";

const WORKSPACE_FILE = "apicc.workspace.yaml";

/**
 * 渲染层测试替身：内存数据 + 与主进程 session 相同语义的树构建与落盘时机。
 * 持久化复用 @apicc/core 的 fileStorage（与 session 同一适配器），保证
 * wsOpen/wsCreate 的 apicc.workspace.yaml 存在性校验、validate 重读等语义一致；
 * debugSend 不走真实网络，固定返回成功结果。测试经 options.root 注入工作区目录。
 */
export function createMemoryApi(options?: { root?: string }): ApiccApi & { seedWorkspace(): void } {
  let root = options?.root ?? "/tmp/apicc-memory";
  let workspace: Workspace | null = null;
  let problems: LoadProblem[] = [];

  function ensureOpen(): Workspace {
    if (!workspace) throw new Error("尚未打开工作区");
    return workspace;
  }

  async function save(): Promise<void> {
    await fileStorage.save(root, ensureOpen());
  }

  interface ApiLocation { api: ApiDefinition; collection: Collection; project: Project; folder: Folder | null }

  function locateApi(apiId: string): ApiLocation | undefined {
    const ws = ensureOpen();
    for (const g of ws.groups) {
      for (const p of g.projects) {
        for (const c of p.collections) {
          const api = c.apis.find((a) => a.id === apiId);
          if (api) return { api, collection: c, project: p, folder: null };
          for (const f of c.folders) {
            const fApi = f.apis.find((a) => a.id === apiId);
            if (fApi) return { api: fApi, collection: c, project: p, folder: f };
          }
        }
      }
    }
    return undefined;
  }

  function toTreeNodeDTO(ws: Workspace): TreeNodeDTO {
    return {
      kind: "root",
      id: ws.id,
      label: ws.name,
      children: ws.groups.map((g) => ({
        kind: "group" as const, id: g.id, label: g.name,
        children: g.projects.map((p) => ({
          kind: "project" as const, id: p.id, label: p.name,
          envs: p.environments.map((e) => ({ id: e.id, name: e.name })),
          children: p.collections.map((c) => ({
            kind: "collection" as const, id: c.id, label: c.name,
            children: [
              ...c.apis.map((a) => ({ kind: "api" as const, id: a.id, label: a.name, method: a.method })),
              ...c.folders.map((f) => ({
                kind: "folder" as const, id: f.id, label: f.name,
                children: f.apis.map((a) => ({ kind: "api" as const, id: a.id, label: a.name, method: a.method })),
              })),
            ],
          })),
        })),
      })),
    };
  }

  function createApiDefinition(name: string, method: string, url: string): ApiDefinition {
    return {
      id: randomUUID(), name, version: "1.0.0", deprecated: false,
      method: method as ApiDefinition["method"], url, headers: [], query: [],
      cases: [{ id: randomUUID(), name: "冒烟", scope: "base", parameters: {}, assertions: [] }],
    };
  }

  return {
    async wsOpen(rootPath: string): Promise<OpenResult> {
      if (!existsSync(join(rootPath, WORKSPACE_FILE))) {
        throw new Error(`工作区根目录缺少 ${WORKSPACE_FILE}: ${rootPath}`);
      }
      const loaded = await fileStorage.load(rootPath);
      root = rootPath;
      workspace = loaded.workspace;
      problems = loaded.problems as LoadProblem[];
      return { workspace: { id: workspace.id, name: workspace.name }, problems, root: rootPath };
    },

    async wsCreate(rootPath: string, name: string): Promise<OpenResult> {
      if (existsSync(join(rootPath, WORKSPACE_FILE))) throw new Error("目录已是工作区");
      mkdirSync(rootPath, { recursive: true });
      const ws: Workspace = { id: randomUUID(), name, variables: {}, groups: [] };
      await fileStorage.save(rootPath, ws);
      root = rootPath;
      workspace = ws;
      problems = [];
      return { workspace: { id: ws.id, name: ws.name }, problems: [], root: rootPath };
    },

    async wsPickDirectory(): Promise<string> {
      return root;
    },

    async wsValidate(): Promise<LoadProblem[]> {
      ensureOpen();
      return (await fileStorage.load(root)).problems;
    },

    async treeGet(): Promise<TreeNodeDTO> {
      return toTreeNodeDTO(ensureOpen());
    },

    async nodeCreate(input: NodeCreateInput): Promise<TreeNodeDTO & { id: string }> {
      const ws = ensureOpen();
      if (input.kind === "group") {
        const g: Group = { id: randomUUID(), name: input.name, projects: [] };
        ws.groups.push(g);
        await save();
        return { kind: "group", id: g.id, label: g.name };
      }
      if (input.kind === "project") {
        const g = ws.groups.find((x) => x.id === input.parentId);
        if (!g) throw new Error(`未找到分组: ${input.parentId}`);
        const p: Project = { id: randomUUID(), name: input.name, variables: {}, environments: [], collections: [] };
        g.projects.push(p);
        await save();
        return { kind: "project", id: p.id, label: p.name };
      }
      if (input.kind === "collection") {
        const p = ws.groups.flatMap((g) => g.projects).find((x) => x.id === input.parentId);
        if (!p) throw new Error(`未找到项目: ${input.parentId}`);
        const c: Collection = { id: randomUUID(), name: input.name, variables: {}, folders: [], apis: [] };
        p.collections.push(c);
        await save();
        return { kind: "collection", id: c.id, label: c.name };
      }
      if (input.kind === "folder") {
        const c = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === input.parentId);
        if (!c) throw new Error(`未找到集合: ${input.parentId}`);
        const f: Folder = { id: randomUUID(), name: input.name, apis: [] };
        c.folders.push(f);
        await save();
        return { kind: "folder", id: f.id, label: f.name };
      }
      const c = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === input.parentId);
      if (!c) throw new Error(`未找到集合: ${input.parentId}`);
      const api = createApiDefinition(input.name, input.method ?? "GET", input.url ?? "/");
      c.apis.push(api);
      await save();
      return { kind: "api", id: api.id, label: api.name, method: api.method };
    },

    async nodeRename(kind: "group" | "project" | "collection" | "folder" | "api" | "environment", id: string, name: string): Promise<void> {
      const ws = ensureOpen();
      if (kind === "group") { const n = ws.groups.find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; await save(); return; }
      if (kind === "project") { const n = ws.groups.flatMap((g) => g.projects).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; await save(); return; }
      if (kind === "collection") { const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; await save(); return; }
      if (kind === "folder") { const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).flatMap((c) => c.folders).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; await save(); return; }
      if (kind === "environment") { const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.environments).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; await save(); return; }
      const loc = locateApi(id);
      if (!loc) throw new Error(`未找到: ${id}`);
      loc.api.name = name;
      await save();
    },

    async nodeDelete(kind: "group" | "project" | "collection" | "folder" | "api" | "environment", id: string): Promise<void> {
      const ws = ensureOpen();
      const removeFrom = <T>(list: T[], pred: (x: T) => boolean): boolean => {
        const index = list.findIndex(pred);
        if (index >= 0) list.splice(index, 1);
        return index >= 0;
      };
      if (kind === "group") { removeFrom(ws.groups, (x) => x.id === id); await save(); return; }
      for (const g of ws.groups) {
        if (kind === "project" && removeFrom(g.projects, (x) => x.id === id)) { await save(); return; }
        for (const p of g.projects) {
          if (kind === "environment" && removeFrom(p.environments, (x) => x.id === id)) { await save(); return; }
          for (const c of p.collections) {
            if (kind === "collection" && removeFrom(p.collections, (x) => x.id === id)) { await save(); return; }
            if (kind === "folder" && removeFrom(c.folders, (x) => x.id === id)) { await save(); return; }
            if (kind === "api") {
              if (removeFrom(c.apis, (x) => x.id === id)) { await save(); return; }
              for (const f of c.folders) if (removeFrom(f.apis, (x) => x.id === id)) { await save(); return; }
            }
          }
        }
      }
      throw new Error(`未找到: ${id}`);
    },

    async apiGet(apiId: string): Promise<ApiDetail> {
      const loc = locateApi(apiId);
      if (!loc) throw new Error(`未找到接口: ${apiId}`);
      return {
        api: loc.api,
        envs: loc.project.environments.map((e) => ({ id: e.id, name: e.name })),
      };
    },

    async apiSave(api: ApiDefinition): Promise<void> {
      const loc = locateApi(api.id);
      if (!loc) throw new Error(`未找到接口: ${api.id}`);
      const list = loc.folder ? loc.folder.apis : loc.collection.apis;
      const index = list.findIndex((a) => a.id === api.id);
      list[index] = api;
      await save();
    },

    async debugSend(input: DebugInput): Promise<DebugOutput> {
      const loc = locateApi(input.apiId);
      const outcome: CaseOutcome = {
        apiId: input.apiId,
        apiName: loc?.api.name ?? "",
        caseId: input.caseId,
        caseName: loc?.api.cases.find((c) => c.id === input.caseId)?.name ?? "",
        passed: true,
        durationMs: 0,
        assertions: [],
      };
      const run: RunResult = {
        collectionId: loc?.collection.id ?? "",
        collectionName: loc?.collection.name ?? "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        total: 1,
        passed: 1,
        failed: 0,
        cases: [outcome],
      };
      return { run, outcome };
    },

    /** 预置 分组/项目/集合/接口 各一（未打开工作区时先在内存中初始化默认工作区），并落盘。 */
    seedWorkspace(): void {
      let ws = workspace;
      if (!ws) {
        ws = { id: randomUUID(), name: "内存工作区", variables: {}, groups: [] };
        workspace = ws;
        problems = [];
      }
      const g: Group = { id: randomUUID(), name: "示例分组", projects: [] };
      const p: Project = { id: randomUUID(), name: "示例项目", variables: {}, environments: [], collections: [] };
      const c: Collection = { id: randomUUID(), name: "示例集合", variables: {}, folders: [], apis: [] };
      const api = createApiDefinition("示例接口", "GET", "/");
      c.apis.push(api);
      p.collections.push(c);
      g.projects.push(p);
      ws.groups.push(g);
      void save();
    },
  };
}
