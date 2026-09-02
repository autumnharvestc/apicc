import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  fileStorage,
  type ApiDefinition,
  type CaseOutcome,
  type Collection,
  type Environment,
  type Folder,
  type Group,
  type LoadProblem,
  type Project,
  type RunResult,
  type Workspace,
} from "@apicc/core";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";
import type { ApiDetail, ApiccApi, DebugInput, DebugOutput, EnvCreateInput, ImportApplyInput, ImportPreviewInput, ImportPreviewResult, NodeCreateInput, NodeCreatedDTO, OpenResult, RunCollectionInput, RunSummaryDTO } from "../../../shared/types.js";

const WORKSPACE_FILE = "apicc.workspace.yaml";

/**
 * 渲染层测试替身：内存数据 + 与主进程 session 相同语义的树构建与落盘时机。
 * 持久化复用 @apicc/core 的 fileStorage（与 session 同一适配器）；内存态是唯一事实源，
 * 落盘只是为 reopen/validate 同语义做的最佳努力。wsOpen 目标目录若没有
 * apicc.workspace.yaml，则回退为直接打开当前内存工作区（路径仅作展示，不迁移落盘根）；
 * 目录确为工作区时仍从盘加载，保持与 session 一致的重开语义。
 * debugSend 不走真实网络，固定返回成功结果。测试经 options.root 注入工作区目录；
 * 默认每实例独立临时目录，可安全并行。
 */
export function createMemoryApi(options?: { root?: string }): ApiccApi & { seedWorkspace(): void; problems: LoadProblem[]; importApplyCalls: ReadonlyArray<{ groupName: string; projectName: string }> } {
  // 默认每实例独立临时目录（?? 短路：注入 options.root 时不会创建临时目录），
  // 避免固定共享路径的多实例互相污染与并行测试并发写。
  let root = options?.root ?? mkdtempSync(join(tmpdir(), "apicc-memory-"));
  let workspace: Workspace | null = null;
  let problems: LoadProblem[] = [];
  // 运行历史内存样例（新→旧，与主进程 listRuns 排序一致）：runCollection 产出，
  // runsList/runsGet 读回；runSeq 保证同毫秒多次运行不重名（对齐 Runner 落盘文件名语义）。
  const runs: Array<{ file: string; result: RunResult }> = [];
  let runSeq = 0;
  // 导入向导（任务 7）：importApply 调用记录（供测试断言；语义对齐 session.importProject）。
  const importApplyCalls: Array<{ groupName: string; projectName: string }> = [];

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
          envs: p.environments.map((e) => ({ id: e.id, name: e.name, extends: e.extends, variables: e.variables })),
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
    // 载入问题列表读写口：测试直接赋值 api.problems 模拟「工作区带问题文件」。
    get problems(): LoadProblem[] {
      return problems;
    },
    set problems(value: LoadProblem[]) {
      problems = value;
    },

    // importApply 调用记录读口：测试断言向导 apply 链路确实落到 api 层。
    get importApplyCalls(): ReadonlyArray<{ groupName: string; projectName: string }> {
      return importApplyCalls;
    },

    async wsOpen(rootPath: string): Promise<OpenResult> {
      if (existsSync(join(rootPath, WORKSPACE_FILE))) {
        const loaded = await fileStorage.load(rootPath);
        root = rootPath;
        workspace = loaded.workspace;
        problems = loaded.problems as LoadProblem[];
        return { workspace: { id: workspace.id, name: workspace.name }, problems, root: rootPath };
      }
      // 目标目录不是工作区：内存有工作区时回退为打开内存态（替身以内存为事实源）；
      // 内存也为空时保留与 session 一致的「缺少工作区文件」错误。
      if (!workspace) throw new Error(`工作区根目录缺少 ${WORKSPACE_FILE}: ${rootPath}`);
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

    async nodeCreate(input: NodeCreateInput): Promise<NodeCreatedDTO> {
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
      // api 分支父解析与主进程 IPC 同构（宽审查 C1）：parentId 先按文件夹命中（接口挂其
      // apis），未命中再按集合解析（挂集合根）。此前只按集合解析，文件夹内新建接口必失败。
      let target: { collection: Collection; folder: Folder | null } | null = null;
      for (const g of ws.groups) {
        for (const p of g.projects) {
          for (const c of p.collections) {
            const folder = c.folders.find((f) => f.id === input.parentId);
            if (folder) { target = { collection: c, folder }; break; }
          }
          if (target) break;
        }
        if (target) break;
      }
      if (!target) {
        const c = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === input.parentId);
        if (!c) throw new Error(`未找到集合: ${input.parentId}`);
        target = { collection: c, folder: null };
      }
      const api = createApiDefinition(input.name, input.method ?? "GET", input.url ?? "/");
      if (target.folder) target.folder.apis.push(api);
      else target.collection.apis.push(api);
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
      if (kind === "group" && removeFrom(ws.groups, (x) => x.id === id)) { await save(); return; }
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

    // 环境操作（任务 4）：语义对齐 session（未命中统一抛「未找到」）；与替身其余
    // node 操作一致，成功后内部落盘（替身的落盘为最佳努力），主进程侧落盘由 IPC 分支显式 save。
    async envCreate(input: EnvCreateInput): Promise<Environment> {
      const ws = ensureOpen();
      const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === input.projectId);
      if (!project) throw new Error(`未找到项目: ${input.projectId}`);
      const env: Environment = { id: randomUUID(), name: input.name, extends: input.extends, variables: {} };
      project.environments.push(env);
      await save();
      return env;
    },

    async envVarsSave(envId: string, variables: Record<string, string>): Promise<void> {
      const ws = ensureOpen();
      const env = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.environments).find((x) => x.id === envId);
      if (!env) throw new Error(`未找到环境: ${envId}`);
      env.variables = variables;
      await save();
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

    // 集合运行（任务 6）：语义对齐 session——未命中集合抛「未找到」；不走真实网络，
    // 固定返回单用例成功结果并记入运行历史（runs list/get 的内存样例由此产出）。
    async runCollection(input: RunCollectionInput): Promise<RunResult> {
      const ws = ensureOpen();
      const collection = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === input.collectionId);
      if (!collection) throw new Error(`未找到集合: ${input.collectionId}`);
      const api = collection.apis[0] ?? collection.folders[0]?.apis[0];
      const outcome: CaseOutcome = {
        apiId: api?.id ?? "",
        apiName: api?.name ?? "",
        caseId: api?.cases[0]?.id ?? "",
        caseName: api?.cases[0]?.name ?? "",
        passed: true,
        durationMs: 0,
        assertions: [],
      };
      const startedAt = new Date().toISOString();
      const run: RunResult = {
        collectionId: collection.id,
        collectionName: collection.name,
        envName: input.envName,
        startedAt,
        finishedAt: startedAt,
        total: 1,
        passed: 1,
        failed: 0,
        cases: [outcome],
      };
      runs.unshift({ file: `run-memory-${String(++runSeq).padStart(4, "0")}.json`, result: run });
      return run;
    },

    async runsList(): Promise<RunSummaryDTO[]> {
      return runs.map(({ file, result }) => ({
        file,
        collectionName: result.collectionName,
        startedAt: result.startedAt,
        total: result.total,
        passed: result.passed,
        failed: result.failed,
      }));
    },

    async runsGet(file: string): Promise<RunResult | null> {
      return runs.find((r) => r.file === file)?.result ?? null;
    },

    // 导入向导（任务 7）：importPreview 返回固定样例（渲染层替身不做格式探测——替身
    // 语义只钉「api.importPreview 返回结构入 store 状态」）；importApply 语义对齐
    // session.importProject（缺分组时建组、同分组重名拒绝）并记录调用供测试断言。
    async importPreview(_input: ImportPreviewInput): Promise<ImportPreviewResult> {
      const project: Project = {
        id: randomUUID(), name: "导入示例项目", variables: {}, environments: [],
        collections: [{
          id: randomUUID(), name: "导入示例集合", variables: {}, folders: [],
          apis: [createApiDefinition("导入接口", "GET", "/imported")],
        }],
      };
      return { importerName: "sample", project, warnings: ["示例警告"] };
    },

    async importApply(input: ImportApplyInput): Promise<void> {
      const ws = ensureOpen();
      let group = ws.groups.find((x) => x.name === input.groupName);
      if (!group) { group = { id: randomUUID(), name: input.groupName, projects: [] }; ws.groups.push(group); }
      if (group.projects.some((x) => x.name === input.project.name)) throw new Error(`项目已存在: ${input.project.name}`);
      group.projects.push(input.project);
      importApplyCalls.push({ groupName: input.groupName, projectName: input.project.name });
      await save();
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
      // 写盘失败就地消化、保留内存态：内存数组才是替身的语义核心，落盘只是为
      // reopen/validate 同语义做的最佳努力；不用发射后不管，避免无关 unhandled rejection。
      save().catch(() => undefined);
    },
  };
}
