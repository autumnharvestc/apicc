import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  builtinAuthProviders,
  sanitizeNodeName,
  buildStressRequest,
  createVariableResolver,
  fileStorage,
  mergedEnvVars,
  renderDesignMarkdown,
  StressRunner,
  transitionWorkflowStatus,
  validateEnablement,
  workflowImpact,
  type AiSuggestedCase,
  type ApiDefinition,
  type CaseOutcome,
  type Collection,
  type Environment,
  type Folder,
  type Group,
  type LoadProblem,
  type NodeResult,
  type Project,
  type ProtocolClient,
  type RunResult,
  type StressReport,
  type Workflow,
  type WorkflowImpactEntry,
  type WorkflowRunResult,
  type WorkflowStatus,
  type Workspace,
  type WorkspaceGlobals,
} from "@apicc/core";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";
import { OnlineTreeSchema, type OnlineTree } from "../../../shared/online/contract.js";
import type { AiKeyStatus, AiSaveConfigInput, AiSuggestInput, AiTestConfigInput, AiTestConfigResult } from "../../../shared/ai/contract.js";

/**
 * 渲染层测试替身的固定建议（M6-C 任务 2）：形状收敛 core AiSuggestedCase（带本地生成的
 * id——与 main 真链路 suggestCases 产物同构，供采用链路按 id 勾选/沿用）。仅替身使用；
 * main 真链路走 core suggestCases，不经此数据。
 */
export const AI_FIXTURE_SUGGESTIONS: readonly AiSuggestedCase[] = [
  {
    id: "ai-fixture-case-1",
    name: "AI 建议-正常请求 200",
    scope: "base",
    parameters: {},
    assertions: [{ id: "ai-fixture-assert-1", target: "status", op: "eq", expected: "200" }],
  },
  {
    id: "ai-fixture-case-2",
    name: "AI 建议-非法参数 400",
    scope: "base",
    parameters: {},
    assertions: [
      { id: "ai-fixture-assert-2", target: "status", op: "eq", expected: "400" },
      { id: "ai-fixture-assert-3", target: "bodyJson", op: "contains", path: "$.message", expected: "参数" },
    ],
    postScript: "console.log(\"AI 建议用例执行完毕\");",
  },
];
import { onlineTreeToDto } from "../../../main/online/session.js";
import { scanDirFiles, writeFiles } from "../../../main/online/migrate.js";
import { createPluginsListFixture } from "../../../main/plugins/fixture.js";
import type { PluginsListResult } from "../../../shared/plugins/contract.js";
import type {
  OnlineBatchResult,
  OnlineDeleteOutcome,
  OnlineFilesBatchInput,
  OnlineFileDeleteInput,
  OnlineFilePutInput,
  OnlineFilesGetInput,
  OnlineFilesResult,
  OnlineLoginInput,
  OnlineLoginOutput,
  OnlineMigrateScanResult,
  OnlineMigrateWriteInput,
  OnlinePushOutcome,
  OnlineRegisterChannelInput,
  OnlineResumeInput,
  OnlineResumeOutput,
  OnlineUser,
  OnlineWorkspaceCreateInput,
  OnlineWorkspaceCreated,
  OnlineWorkspaceOpenInput,
  OnlineWorkspaceSummary,
  OnlineWorkspaceView,
} from "../../../shared/online/types.js";
import type {
  ApiDetail,
  ApiccApi,
  DebugInput,
  DebugOutput,
  EnvCreateInput,
  ImportApplyInput,
  ImportPreviewInput,
  ImportPreviewResult,
  NodeCreateInput,
  NodeCreatedDTO,
  OpenResult,
  RunCollectionInput,
  RunSummaryDTO,
  StressReportDTO,
  StressRunInput,
  StressRunOutput,
  StressRunSummaryDTO,
  WfCreateInput,
  WfImpactInput,
  WfRunInput,
  WorkflowDetail,
  WorkflowSummary,
  WfSetStatusResult,
} from "../../../shared/types.js";

const WORKSPACE_FILE = "apicc.workspace.yaml";

/**
 * 渲染层测试替身：内存数据 + 与主进程 session 相同语义的树构建与落盘时机。
 * 持久化复用 @apicc/core 的 fileStorage（与 session 同一适配器）；内存态是唯一事实源，
 * 落盘只是为 reopen/validate 同语义做的最佳努力。wsOpen 目标目录若没有
 * apicc.workspace.yaml，则回退为直接打开当前内存工作区（路径仅作展示，不迁移落盘根）；
 * 目录确为工作区时仍从盘加载，保持与 session 一致的重开语义。
 * debugSend 不走真实网络，固定返回成功结果。测试经 options.root 注入工作区目录；
 * 默认每实例独立临时目录，可安全并行。
 * stressRun（M2-D3 任务 1）：进程内 StressRunner + 假 client 实现与主进程同构语义
 * （单活动拒绝/stop/错误文案/历史 kind 判别），client 可注入、默认不发真实网络。
 */
export function createMemoryApi(options?: { root?: string; stressClient?: ProtocolClient }): ApiccApi & { seedWorkspace(): void; problems: LoadProblem[]; importApplyCalls: ReadonlyArray<{ groupName: string; projectName: string }>; designExportCalls: ReadonlyArray<{ file: string; content: string }>; aiSaveConfigCalls: ReadonlyArray<AiSaveConfigInput> } {
  // 默认每实例独立临时目录（?? 短路：注入 options.root 时不会创建临时目录），
  // 避免固定共享路径的多实例互相污染与并行测试并发写。
  let root = options?.root ?? mkdtempSync(join(tmpdir(), "apicc-memory-"));
  let workspace: Workspace | null = null;
  let problems: LoadProblem[] = [];
  // 运行历史内存样例（新→旧，与主进程 listRuns 排序一致）：runCollection 产出，
  // runsList/runsGet 读回；runSeq 保证同毫秒多次运行不重名（对齐 Runner 落盘文件名语义）。
  const runs: Array<{ file: string; result: RunResult }> = [];
  let runSeq = 0;
  // 压测历史（M2-D3 任务 1）：stressRun/stop 收尾产出（文件名与主进程同构 stress-<apiId>-<ts>.json）。
  const stressRuns: Array<{ file: string; report: StressReport }> = [];
  // 单活动压测（与主进程 createStressController 同构）：闭包持 AbortController + 收尾 Promise。
  let stressActive: { controller: AbortController; finished: Promise<StressRunOutput> } | null = null;
  // 压测 client：默认假实现（200 成功、零时延），测试可注入挂起/自定义 client，不发真实网络。
  const stressClient: ProtocolClient = options?.stressClient ?? {
    name: "fake",
    canHandle: () => true,
    execute: async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 0 }),
  };
  /** 收尾清理：仅当仍是本次 run 时清空（防误清新活动）；独立函数避免闭包内 let 收窄问题。 */
  function clearStressActive(controller: AbortController): void {
    if (stressActive?.controller === controller) stressActive = null;
  }
  // 导入向导（任务 7）：importApply 调用记录（供测试断言；语义对齐 session.importProject）。
  const importApplyCalls: Array<{ groupName: string; projectName: string }> = [];
  // 详细设计导出（任务 8）：designExport 调用记录（供测试断言渲染产物）。
  const designExportCalls: Array<{ file: string; content: string }> = [];
  // 在线状态（M3-B 任务 1）：替身不发网络——登录态 + 内存工作区/文件版本模型，
  // 载荷形状钉在 shared/online 契约上，与主进程 online session 同构（错误文案逐字对齐）。
  let onlineUser: OnlineUser | null = null;
  let onlineExpiresAt = "";
  let onlineWorkspaceSeq = 0;
  const onlineWorkspaces: OnlineWorkspaceSummary[] = [];
  const onlineFiles = new Map<string, { content: string; version: number }>();
  // AI 状态（M6-C 任务 2）：hasKey 内存位由 aiSaveConfig（apiKey 非空）置位，与主进程
  // 「key 入安全存储」的可见出口同构——suggest/test-config 替身据此两态（未配置 → 同文案
  // 可读错误；连接探测已切独立 ai:test-config 频道，不再借道 suggest）。
  let aiHasKey = false;
  const aiSaveConfigCalls: Array<AiSaveConfigInput> = [];

  function requireOnlineUser(): OnlineUser {
    if (!onlineUser) throw new Error("尚未登录在线服务器");
    return onlineUser;
  }

  /** 与服务端同口径的内容指纹（§3.4 hash = sha-256 hex），put/batch/delete 共用。 */
  function onlineHash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  function onlineFileRow(path: string): { path: string; content: string; version: number; hash: string } {
    const stored = onlineFiles.get(path)!;
    return { path, content: stored.content, version: stored.version, hash: onlineHash(stored.content) };
  }

  /** tree 行多带 size（§3.4 files[] = path/hash/version/size），字节长按 UTF-8 计。 */
  function onlineTreeRow(path: string) {
    const row = onlineFileRow(path);
    return { path: row.path, hash: row.hash, version: row.version, size: Buffer.byteLength(row.content, "utf8") };
  }

  /** 登录成功后初始化示例在线空间（幂等）：工作区清单与文件版本内存模型的种子数据。
   *  路径按 M1 §6 目录约定（groups/<g>/projects/<p>/…），任务 3 树映射/迁移替身同构。 */
  function seedOnlineWorkspace(): void {
    if (onlineWorkspaces.length > 0) return;
    const ws: OnlineWorkspaceSummary = {
      id: `ws-online-${++onlineWorkspaceSeq}`,
      name: "示例在线空间",
      myRole: "OWNER",
      createdAt: new Date().toISOString(),
    };
    onlineWorkspaces.push(ws);
    onlineFiles.set("apicc.workspace.yaml", { content: `id: ${ws.id}\nname: ${ws.name}\n`, version: 1 });
    onlineFiles.set("groups/示例分组/group.yaml", { content: "id: g-online-1\nname: 示例分组\n", version: 1 });
    onlineFiles.set("groups/示例分组/projects/示例项目/project.yaml", { content: "id: p-online-1\nname: 示例项目\n", version: 1 });
    onlineFiles.set("groups/示例分组/projects/示例项目/environments/dev.yaml", { content: "id: env-online-1\nname: dev\nvariables: {}\n", version: 1 });
    onlineFiles.set("groups/示例分组/projects/示例项目/workflows/示例流/workflow.yaml", { content: "id: wf-online-1\nname: 示例流\nstatus: draft\nnodes: []\nedges: []\n", version: 1 });
    onlineFiles.set("groups/示例分组/projects/示例项目/collections/示例集合/collection.yaml", { content: "id: c-online-1\nname: 示例集合\n", version: 1 });
    onlineFiles.set("groups/示例分组/projects/示例项目/collections/示例集合/apis/示例接口/api.yaml", { content: "id: api-online-1\nname: 示例接口\n", version: 1 });
  }

  /** 当前在线工作区（任务 3：open/close/tree:view 同构 main session 的纯状态语义）。 */
  let onlineWs: { id: string; name: string; myRole: OnlineWorkspaceOpenInput["myRole"] } | null = null;

  /** 构造在线工作区视图（经同一 onlineTreeToDto 映射，与 main 侧零漂移）。 */
  function onlineWorkspaceView(): OnlineWorkspaceView {
    if (!onlineWs) throw new Error("尚未打开在线工作区");
    if (!onlineUser) throw new Error("尚未登录在线服务器");
    const tree: OnlineTree = {
      workspaceId: onlineWs.id,
      rootVersion: onlineFiles.size,
      files: [...onlineFiles.keys()].map(onlineTreeRow),
      // 契约修订 2026-09-03：projects.path 必填（同名项目权限判定按 path 定位）
      projects: [{ id: "p-online-1", name: "示例项目", path: "groups/示例分组/projects/示例项目", myRole: "EDITOR" as const }],
    };
    return {
      workspaceId: onlineWs.id,
      name: onlineWs.name,
      myRole: onlineWs.myRole,
      projects: tree.projects,
      tree: onlineTreeToDto(tree, onlineWs.name),
    };
  }

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

  /** 工作流定位（M2-B 任务 1）：遍历模式同 locateApi；启用校验/生命周期用 workspace 全树。 */
  function locateWorkflow(workflowId: string): { workflow: Workflow; project: Project } | undefined {
    const ws = ensureOpen();
    for (const g of ws.groups) {
      for (const p of g.projects) {
        const wf = p.workflows.find((w) => w.id === workflowId);
        if (wf) return { workflow: wf, project: p };
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
        envs: p.environments.map((e) => ({ id: e.id, name: e.name, extends: e.extends, variables: e.variables, baseUrls: e.baseUrls })),
        // 工作流摘要（M2-B 收口）：与主进程 tree.ts 同构，侧树入口数据源。
        workflows: p.workflows.map((w) => ({ id: w.id, name: w.name, status: w.status })),
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

    // designExport 调用记录读口：测试断言导出链路的渲染产物与目标文件名。
    get designExportCalls(): ReadonlyArray<{ file: string; content: string }> {
      return designExportCalls;
    },

    // aiSaveConfig 调用记录读口（M6-C 任务 1）：测试断言保存链路的载荷形状（key 留空不携字段）。
    get aiSaveConfigCalls(): ReadonlyArray<AiSaveConfigInput> {
      return aiSaveConfigCalls;
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
      const ws: Workspace = { id: randomUUID(), name, variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
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
      const name = sanitizeNodeName(input.name);
      // 与主进程 session 同契约（M9-A2）：名称净化 + 同级重名拒绝（名称即盘上目录名）。
      const sameName = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
      if (input.kind === "group") {
        if (ws.groups.some((x) => sameName(x.name, name))) throw new Error(`分组已存在: ${name}`);
        const g: Group = { id: randomUUID(), name, projects: [] };
        ws.groups.push(g);
        await save();
        return { kind: "group", id: g.id, label: g.name };
      }
      if (input.kind === "project") {
        const g = ws.groups.find((x) => x.id === input.parentId);
        if (!g) throw new Error(`未找到分组: ${input.parentId}`);
        if (g.projects.some((x) => sameName(x.name, name))) throw new Error(`项目已存在: ${name}`);
        const p: Project = { id: randomUUID(), name, variables: {}, environments: [], collections: [], workflows: [] };
        g.projects.push(p);
        await save();
        return { kind: "project", id: p.id, label: p.name };
      }
      if (input.kind === "collection") {
        const p = ws.groups.flatMap((g) => g.projects).find((x) => x.id === input.parentId);
        if (!p) throw new Error(`未找到项目: ${input.parentId}`);
        if (p.collections.some((x) => sameName(x.name, name))) throw new Error(`集合已存在: ${name}`);
        const c: Collection = { id: randomUUID(), name, variables: {}, folders: [], apis: [] };
        p.collections.push(c);
        await save();
        return { kind: "collection", id: c.id, label: c.name };
      }
      if (input.kind === "folder") {
        const c = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === input.parentId);
        if (!c) throw new Error(`未找到集合: ${input.parentId}`);
        if (c.folders.some((x) => sameName(x.name, name))) throw new Error(`文件夹已存在: ${name}`);
        const f: Folder = { id: randomUUID(), name, apis: [] };
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
      const siblings = target.folder ? target.folder.apis : target.collection.apis;
      if (siblings.some((x) => sameName(x.name, name))) throw new Error(`接口已存在: ${name}`);
      const api = createApiDefinition(name, input.method ?? "GET", input.url ?? "/");
      if (target.folder) target.folder.apis.push(api);
      else target.collection.apis.push(api);
      await save();
      return { kind: "api", id: api.id, label: api.name, method: api.method };
    },

    async nodeRename(kind: "group" | "project" | "collection" | "folder" | "api" | "environment", id: string, rawName: string): Promise<void> {
      const ws = ensureOpen();
      const name = sanitizeNodeName(rawName);
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
      const env: Environment = { id: randomUUID(), name: sanitizeNodeName(input.name), extends: input.extends, variables: {}, baseUrls: {} };
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

    async envBaseUrlsSave(envId: string, baseUrls: Record<string, string>): Promise<void> {
      const ws = ensureOpen();
      const env = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.environments).find((x) => x.id === envId);
      if (!env) throw new Error(`未找到环境: ${envId}`);
      env.baseUrls = baseUrls;
      await save();
    },

    async globalsSave(globals: WorkspaceGlobals): Promise<void> {
      const ws = ensureOpen();
      ws.globals = globals;
      await save();
    },

    async globalsGet(): Promise<WorkspaceGlobals> {
      return ensureOpen().globals;
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

    async runsList(): Promise<Array<RunSummaryDTO | StressRunSummaryDTO>> {
      const collectionRows: RunSummaryDTO[] = runs.map(({ file, result }) => ({
        kind: "collection",
        file,
        collectionName: result.collectionName,
        startedAt: result.startedAt,
        total: result.total,
        passed: result.passed,
        failed: result.failed,
      }));
      // 压测行（M2-D3 任务 1）：startedAt 由 epoch ms 格式化为 ISO，与主进程 listRuns 同口径。
      const stressRows: StressRunSummaryDTO[] = stressRuns.map(({ file, report }) => ({
        kind: "stress",
        file,
        startedAt: new Date(report.startedAt).toISOString(),
        totalRequests: report.totalRequests,
        ok: report.ok,
        failed: report.failed,
        rps: report.rps,
      }));
      return [...collectionRows, ...stressRows].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    },

    async runsGet(file: string): Promise<RunResult | StressReportDTO | null> {
      const collection = runs.find((r) => r.file === file);
      if (collection) return collection.result;
      const stress = stressRuns.find((r) => r.file === file);
      return stress ? { kind: "stress", report: structuredClone(stress.report) } : null;
    },

    // 压测（M2-D3 任务 1，与主进程 stress.ts 同构）：单活动拒绝/abort 语义/错误文案逐字对齐；
    // 历史收尾降级口径与主进程一致（异常仅告警不阻断报告返回，file 省略——内存 unshift 实际
    // 不可失败，同构其契约与降级结构）；返回前深拷贝。
    async stressRun(input: StressRunInput): Promise<StressRunOutput> {
      if (stressActive) throw new Error("已有压测进行中");
      const ws = ensureOpen();
      const loc = locateApi(input.apiId);
      if (!loc) throw new Error(`未找到接口: ${input.apiId}`);
      const api: ApiDefinition = { ...loc.api, cases: loc.api.cases.filter((c) => c.id === input.caseId) };
      if (api.cases.length === 0) throw new Error(`用例不存在: ${input.caseId}`);
      const env = input.envName ? loc.project.environments.find((e) => e.name === input.envName) : undefined;
      if (input.envName && !env) throw new Error(`未找到环境: ${input.envName}`);
      const resolver = createVariableResolver({
        layers: [mergedEnvVars(env, loc.project), loc.collection.variables, loc.project.variables, ws.variables],
      });
      const runner = new StressRunner({
        client: stressClient,
        buildRequest: () => buildStressRequest(api, resolver, builtinAuthProviders),
      });
      const controller = new AbortController();
      const finished = (async (): Promise<StressRunOutput> => {
        try {
          const report = await runner.run({
            concurrency: input.concurrency,
            maxIterations: input.maxIterations ?? undefined,
            durationMs: input.durationMs ?? undefined,
            signal: controller.signal,
          });
          const clone: StressReport = structuredClone(report);
          const file = `stress-${api.id}-${Date.now()}.json`;
          try {
            stressRuns.unshift({ file, report: structuredClone(report) });
            return { report: clone, file };
          } catch (e) {
            console.warn(`压测报告历史记录失败（${file}）: ${e instanceof Error ? e.message : String(e)}`);
            return { report: clone };
          }
        } finally {
          clearStressActive(controller);
        }
      })();
      stressActive = { controller, finished };
      return finished;
    },

    async stressStop(): Promise<StressRunOutput> {
      if (!stressActive) throw new Error("没有进行中的压测");
      stressActive.controller.abort();
      return stressActive.finished;
    },

    // 导入向导（任务 7）：importPreview 返回固定样例（渲染层替身不做格式探测——替身
    // 语义只钉「api.importPreview 返回结构入 store 状态」）；importApply 语义对齐
    // session.importProject（缺分组时建组、同分组重名拒绝）并记录调用供测试断言。
    async importPreview(_input: ImportPreviewInput): Promise<ImportPreviewResult> {
      const project: Project = {
        id: randomUUID(), name: "导入示例项目", variables: {}, environments: [], workflows: [],
        collections: [{
          id: randomUUID(), name: "导入示例集合", variables: {}, folders: [],
          apis: [createApiDefinition("导入接口", "GET", "/imported")],
        }],
      };
      return { importerName: "sample", project, warnings: ["示例警告"] };
    },

    async importApply(input: ImportApplyInput): Promise<void> {
      const ws = ensureOpen();
      const groupName = sanitizeNodeName(input.groupName);
      const project = input.project;
      project.name = sanitizeNodeName(project.name);
      project.collections = project.collections.map((c) => ({
        ...c,
        name: sanitizeNodeName(c.name),
        folders: c.folders.map((f) => ({ ...f, name: sanitizeNodeName(f.name), apis: f.apis.map((a) => ({ ...a, name: sanitizeNodeName(a.name) })) })),
        apis: c.apis.map((a) => ({ ...a, name: sanitizeNodeName(a.name) })),
      }));
      let group = ws.groups.find((x) => x.name === groupName);
      if (!group) { group = { id: randomUUID(), name: groupName, projects: [] }; ws.groups.push(group); }
      if (group.projects.some((x) => x.name === project.name)) throw new Error(`项目已存在: ${project.name}`);
      group.projects.push(project);
      importApplyCalls.push({ groupName, projectName: project.name });
      await save();
    },

    // 详细设计导出（任务 8）：用 core renderDesignMarkdown 渲染（与主进程同一实现），
    // 记录渲染产物供测试断言；替身不落盘（主进程语义是 showSaveDialog 后写盘并返回
    // 路径），返回「工作区根/<接口名>.design.md」占位路径。
    async designExport(apiId: string): Promise<string> {
      const loc = locateApi(apiId);
      if (!loc) throw new Error(`未找到接口: ${apiId}`);
      const file = join(root, `${loc.api.name}.design.md`);
      designExportCalls.push({ file, content: renderDesignMarkdown(loc.api) });
      return file;
    },

    // 工作流频道（M2-B 任务 1）：语义与主进程 session 一致（错误文案逐字对齐）——
    // 生命周期迁移复用 core transitionWorkflowStatus/validateEnablement（与 session 同一实现），
    // 启用校验未过返回状态不变 + errors；wf:run 不走真实网络，按实际节点生成固定成功样例。
    async wfList(projectId: string): Promise<WorkflowSummary[]> {
      const ws = ensureOpen();
      const project = ws.groups.flatMap((g) => g.projects).find((p) => p.id === projectId);
      if (!project) throw new Error(`未找到项目: ${projectId}`);
      return project.workflows.map((w) => ({ id: w.id, name: w.name, status: w.status }));
    },

    async wfGet(workflowId: string): Promise<WorkflowDetail> {
      const loc = locateWorkflow(workflowId);
      if (!loc) throw new Error(`未找到工作流: ${workflowId}`);
      return { workflow: loc.workflow, projectId: loc.project.id };
    },

    async wfCreate(input: WfCreateInput): Promise<Workflow> {
      const ws = ensureOpen();
      const project = ws.groups.flatMap((g) => g.projects).find((p) => p.id === input.projectId);
      if (!project) throw new Error(`未找到项目: ${input.projectId}`);
      if (project.workflows.some((w) => w.name === input.name)) throw new Error(`工作流已存在: ${input.name}`);
      const workflow: Workflow = { id: randomUUID(), name: input.name, status: "draft", nodes: [], edges: [] };
      project.workflows.push(workflow);
      await save();
      return workflow;
    },

    async wfDelete(workflowId: string): Promise<void> {
      const ws = ensureOpen();
      for (const g of ws.groups) {
        for (const p of g.projects) {
          const index = p.workflows.findIndex((w) => w.id === workflowId);
          if (index >= 0) {
            p.workflows.splice(index, 1);
            await save();
            return;
          }
        }
      }
      throw new Error(`未找到工作流: ${workflowId}`);
    },

    // 重命名（M2-B 收口）：语义对齐 session.renameWorkflow——同项目重名拒绝（与 wfCreate
    // 同文案）、改名后落盘（旧目录由 session 侧 cleanupOrphanDirs 对位清理；替身落盘为最佳努力）。
    async wfRename(workflowId: string, name: string): Promise<void> {
      const loc = locateWorkflow(workflowId);
      if (!loc) throw new Error(`未找到工作流: ${workflowId}`);
      if (loc.project.workflows.some((w) => w.id !== workflowId && w.name === name)) {
        throw new Error(`工作流已存在: ${name}`);
      }
      loc.workflow.name = name;
      await save();
    },

    async wfSave(workflow: Workflow): Promise<Workflow> {
      const loc = locateWorkflow(workflow.id);
      if (!loc) throw new Error(`未找到工作流: ${workflow.id}`);
      // 恒保持当前 status 不变（生命周期只经 wfSetStatus），与 session.saveWorkflow 同语义。
      const stored: Workflow = { ...workflow, status: loc.workflow.status };
      const index = loc.project.workflows.findIndex((w) => w.id === workflow.id);
      loc.project.workflows[index] = stored;
      await save();
      return stored;
    },

    async wfSetStatus(workflowId: string, next: WorkflowStatus): Promise<WfSetStatusResult> {
      const loc = locateWorkflow(workflowId);
      if (!loc) throw new Error(`未找到工作流: ${workflowId}`);
      const ws = ensureOpen();
      const enablement = next === "enabled" ? validateEnablement(loc.workflow, ws) : undefined;
      if (enablement && !enablement.ok) {
        return { workflow: loc.workflow, errors: enablement.errors, warnings: enablement.warnings };
      }
      // 非法迁移（draft→enabled 跳级等）由 core 守卫直接抛错（与 session 同源）。
      transitionWorkflowStatus(loc.workflow, next, enablement);
      loc.workflow.status = next;
      await save();
      return { workflow: loc.workflow, errors: [], warnings: enablement?.warnings ?? [] };
    },

    async wfImpact(input: WfImpactInput): Promise<WorkflowImpactEntry[]> {
      return workflowImpact(ensureOpen(), { caseId: input.caseId, apiId: input.apiId });
    },

    async wfRun(input: WfRunInput): Promise<WorkflowRunResult> {
      const loc = locateWorkflow(input.workflowId);
      if (!loc) throw new Error(`未找到工作流: ${input.workflowId}`);
      if (loc.workflow.status === "draft") throw new Error("工作流为草稿，请先发布启用");
      if (input.envName) {
        const env = loc.project.environments.find((e) => e.name === input.envName);
        if (!env) throw new Error(`未找到环境: ${input.envName}`);
      }
      // 固定成功样例：request 节点 → passed（合成 outcome，不发请求）、noop 节点 → noop；
      // nodeResults 按实际节点 id 生成，任务 7 运行着色可据此断言 stateClass 映射。
      const startedAt = new Date().toISOString();
      const nodeResults: NodeResult[] = loc.workflow.nodes.map((n) =>
        n.kind === "noop"
          ? { nodeId: n.id, label: n.label, kind: "noop", state: "noop" }
          : {
              nodeId: n.id, label: n.label, kind: "request", state: "passed",
              outcome: {
                apiId: n.apiId ?? "", apiName: "", caseId: n.caseId ?? "", caseName: "",
                passed: true, durationMs: 0, assertions: [],
              },
            },
      );
      return {
        workflowId: loc.workflow.id, workflowName: loc.workflow.name, status: loc.workflow.status,
        nodeResults, total: nodeResults.length, passed: nodeResults.length, failed: 0, skipped: 0,
        warnings: [], startedAt, finishedAt: startedAt,
      };
    },

    // —— 在线频道（M3-B 任务 1）：与主进程 online session 同构的替身（不发网络）——
    // login 出口剥 token（与 IPC 契约一致）；put/delete 按服务端语义返回 conflict outcome
    // （baseVersion 不匹配时带 currentVersion），供任务 2/3 UI 在替身上开发冲突分支。
    async onlineRegister(input: OnlineRegisterChannelInput): Promise<OnlineUser> {
      // 替身不做用户管理，按入参合成示例用户（形状同契约 201 载荷），不建立登录态
      return { id: "u-online-1", username: input.username, displayName: input.displayName };
    },

    async onlineLogin(input: OnlineLoginInput): Promise<OnlineLoginOutput> {
      onlineUser = { id: "u-online-1", username: input.username, displayName: "示例用户" };
      onlineExpiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString(); // 登录态 30 天（§2 D4 同口径）
      seedOnlineWorkspace();
      return { expiresAt: onlineExpiresAt, user: onlineUser };
    },

    async onlineLogout(): Promise<void> {
      onlineUser = null;
      onlineExpiresAt = "";
    },

    // 登录态恢复（任务 2 裁定 A）替身：实例内已登录（此前 onlineLogin）→ restored 携用户；
    // 否则 signed-out。main 进程的存档/清档/验活重启语义由 tests/main/online/session.test.ts
    // 钉住（替身不建模跨重启持久化），这里只同构「resume 返回可辨别结果、不抛」的出口契约。
    async onlineResume(_input: OnlineResumeInput): Promise<OnlineResumeOutput> {
      return onlineUser ? { outcome: "restored", user: onlineUser } : { outcome: "signed-out" };
    },

    async onlineMe(): Promise<OnlineUser> {
      return requireOnlineUser();
    },

    async onlineWorkspaceList(): Promise<OnlineWorkspaceSummary[]> {
      requireOnlineUser();
      return onlineWorkspaces.map((w) => ({ ...w }));
    },

    async onlineWorkspaceCreate(input: OnlineWorkspaceCreateInput): Promise<OnlineWorkspaceCreated> {
      requireOnlineUser();
      const created: OnlineWorkspaceCreated = { id: `ws-online-${++onlineWorkspaceSeq}`, name: input.name, myRole: "OWNER" };
      onlineWorkspaces.push({ ...created, createdAt: new Date().toISOString() });
      return created;
    },

    async onlineTreeGet(workspaceId: string): Promise<OnlineTree> {
      requireOnlineUser();
      const tree = {
        workspaceId,
        rootVersion: onlineFiles.size,
        files: [...onlineFiles.keys()].map(onlineTreeRow),
        // 契约修订 2026-09-03：projects.path 必填（同名项目权限判定按 path 定位）
        projects: [{ id: "p-online-1", name: "示例项目", path: "groups/示例分组/projects/示例项目", myRole: "EDITOR" as const }],
      };
      return OnlineTreeSchema.parse(tree); // 出口过契约校验（契约漂移即红）
    },

    async onlineFilesGet(input: OnlineFilesGetInput): Promise<OnlineFilesResult> {
      requireOnlineUser();
      const files: OnlineFilesResult["files"] = [];
      const missing: string[] = [];
      for (const path of input.paths) {
        if (onlineFiles.has(path)) files.push(onlineFileRow(path));
        else missing.push(path);
      }
      return { files, missing };
    },

    async onlineFilePut(input: OnlineFilePutInput): Promise<OnlinePushOutcome> {
      requireOnlineUser();
      const stored = onlineFiles.get(input.path);
      if (stored && stored.version !== input.baseVersion) {
        return { outcome: "conflict", conflict: { code: "version_conflict", currentVersion: stored.version, currentHash: onlineHash(stored.content) } };
      }
      const version = (stored?.version ?? 0) + 1;
      onlineFiles.set(input.path, { content: input.content, version });
      return { outcome: "pushed", result: { path: input.path, version, hash: onlineHash(input.content) } };
    },

    async onlineFilesBatch(input: OnlineFilesBatchInput): Promise<OnlineBatchResult> {
      requireOnlineUser();
      return {
        results: input.files.map((entry) => {
          const stored = onlineFiles.get(entry.path);
          // 文件不存在但 baseVersion>0 → conflict/currentVersion=0（任务 2 裁定 D，对齐真实
          // 服务端乐观并发语义：不存在 = 当前版本 0，任何 >0 的 baseVersion 都不匹配，
          // 与 PUT 409 同一判定，绝不盲目落盘）。
          if (!stored && entry.baseVersion > 0) {
            return { path: entry.path, status: "conflict" as const, currentVersion: 0 };
          }
          if (stored && stored.version !== entry.baseVersion) {
            return { path: entry.path, status: "conflict" as const, currentVersion: stored.version };
          }
          const version = (stored?.version ?? 0) + 1;
          onlineFiles.set(entry.path, { content: entry.content, version });
          return { path: entry.path, status: "pushed" as const, version };
        }),
      };
    },

    async onlineFileDelete(input: OnlineFileDeleteInput): Promise<OnlineDeleteOutcome> {
      requireOnlineUser();
      const stored = onlineFiles.get(input.path);
      if (!stored) throw new Error(`未找到文件: ${input.path}`);
      if (stored.version !== input.baseVersion) {
        return { outcome: "conflict", conflict: { code: "version_conflict", currentVersion: stored.version, currentHash: onlineHash(stored.content) } };
      }
      onlineFiles.delete(input.path);
      return { outcome: "deleted" };
    },

    // —— 在线工作区浏览/迁移（M3-B 任务 3，与 main IPC 面同构：open 后即取视图，
    // 因此未登录 open 直接拒绝且不残留状态）——
    async onlineWorkspaceOpen(input: OnlineWorkspaceOpenInput): Promise<OnlineWorkspaceView> {
      requireOnlineUser();
      onlineWs = { id: input.workspaceId, name: input.name, myRole: input.myRole };
      return onlineWorkspaceView();
    },

    async onlineWorkspaceClose(): Promise<void> {
      onlineWs = null;
    },

    async onlineTreeView(workspaceId: string): Promise<OnlineWorkspaceView> {
      if (!onlineWs || onlineWs.id !== workspaceId) throw new Error("尚未打开在线工作区");
      requireOnlineUser();
      return onlineWorkspaceView();
    },

    async onlineMigrateScan(dir: string): Promise<OnlineMigrateScanResult> {
      return { files: scanDirFiles(dir) };
    },

    async onlineMigrateWrite(input: OnlineMigrateWriteInput): Promise<{ written: string[] }> {
      return { written: writeFiles(input.dir, input.files) };
    },

    // —— AI 频道（M6-C 任务 2，与 main IPC 面同构的替身）——
    // key 明文不进替身内存（hasKey 布尔位足够，与「出口只含 hasKey」契约一致）；
    // apiKey 省略/空串 = 保持既有；suggest/test-config 未配置抛与 main 桩逐字相同的可读
    // 错误；建议形状收敛 core AiSuggestedCase（带 id），不发真实网络。
    async aiSaveConfig(input: AiSaveConfigInput): Promise<AiKeyStatus> {
      aiSaveConfigCalls.push({ ...input });
      if (input.apiKey) aiHasKey = true;
      return { hasKey: aiHasKey };
    },

    async aiGetConfig(): Promise<AiKeyStatus> {
      return { hasKey: aiHasKey };
    },

    async aiSuggest(_input: AiSuggestInput): Promise<AiSuggestedCase[]> {
      if (!aiHasKey) throw new Error("尚未配置 AI 密钥，请先在 AI 设置中保存配置");
      return AI_FIXTURE_SUGGESTIONS.map((s) => structuredClone(s) as AiSuggestedCase);
    },

    async aiTestConfig(_input: AiTestConfigInput): Promise<AiTestConfigResult> {
      if (!aiHasKey) throw new Error("尚未配置 AI 密钥，请先在 AI 设置中保存配置");
      return { ok: true };
    },

    // 插件频道（M7-B 任务 1）：与主进程 fixture 桩同一数据源（main/plugins/fixture.ts），
    // 出口快照拷贝——替身只做契约同构（混合 loaded/failed 清单 + 导入器枚举），不做加载语义。
    async pluginsList(): Promise<PluginsListResult> {
      return structuredClone(createPluginsListFixture());
    },

    /** 预置 分组/项目/集合/接口 各一（未打开工作区时先在内存中初始化默认工作区），并落盘。 */
    seedWorkspace(): void {
      let ws = workspace;
      if (!ws) {
        ws = { id: randomUUID(), name: "内存工作区", variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
        workspace = ws;
        problems = [];
      }
      const g: Group = { id: randomUUID(), name: "示例分组", projects: [] };
      const p: Project = { id: randomUUID(), name: "示例项目", variables: {}, environments: [], collections: [], workflows: [] };
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
