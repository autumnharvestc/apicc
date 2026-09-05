import { mkdirSync, writeFileSync } from "node:fs";
import { ApiDefinitionSchema, createDefaultRegistry, ProjectSchema, renderDesignMarkdown, WorkflowRunner, WorkflowSchema, WorkflowStatusSchema, workflowImpact, type Importer, type RunResult, type WorkflowRunResult, type Workspace } from "@apicc/core";
import { z } from "zod";
import { join } from "node:path";
import { IpcChannel, type IpcChannelName } from "../shared/channels.js";
import type { ApiDetail, DebugInput, DebugOutput, EnvCreateInput, ImportApplyInput, ImportPreviewInput, NodeCreateInput, NodeCreatedDTO, OpenResult, RunCollectionInput, RunSummaryDTO, StressRunInput, StressRunOutput, StressRunSummaryDTO, WfCreateInput, WfImpactInput, WfRunInput } from "../shared/types.js";
import {
  OnlineBaseUrlSchema,
  OnlineBatchInputSchema,
  OnlineGetFilesInputSchema,
  OnlinePathSchema,
  OnlineRegisterInputSchema,
  OnlineRoleSchema,
} from "../shared/online/contract.js";
import type { OnlineFilesBatchInput, OnlineWorkspaceOpenInput } from "../shared/online/types.js";
import { createOnlineSession, type OnlineSession } from "./online/session.js";
import { scanDirFiles, writeFiles } from "./online/migrate.js";
import type { OnlineClient } from "./online/client.js";
import type { TokenStore } from "./online/tokenStore.js";
import { runCollection, sendDebug, workspaceRunsDir } from "./debug.js";
import { listRuns, readRun } from "./runs.js";
import { createStressController } from "./stress.js";
import type { createSession } from "./session.js";
import { toTreeNode, type TreeNodeDTO } from "./tree.js";
import type { AiKeyStore } from "./ai/config.js";
import { AI_FIXTURE_SUGGESTIONS } from "../shared/ai/contract.js";
import type { AiKeyStatus, AiSaveConfigInput, AiSuggestedCase } from "../shared/ai/contract.js";

type Session = ReturnType<typeof createSession>;

// —— 全频道入参 zod schema（任务 8 收口，与 shared/types.ts 字段一一对应）——
// 多参频道包 tuple；对象频道沿用 core 严格 schema 的口径（import:apply 的 project
// 多余字段 fail-fast，与导入器产物一致）；其余对象为最简 z.object。
const NodeKindSchema = z.enum(["group", "project", "collection", "folder", "api", "environment"]);
const NodeCreateInputSchema = z.object({
  kind: z.enum(["group", "project", "collection", "folder", "api"]),
  parentId: z.string().nullable(),
  name: z.string(),
  method: z.string().optional(),
  url: z.string().optional(),
});
// 可选字符串字段用 nullish（修复轮 1）：渲染层「无选中」惯例是 null（App.vue 的
// string | null computed、selectedEnvId/selectedCollectionId），optional 只认 undefined，
// store 原样透传 null 会被收口误伤。envName 的 null 由 resolveEnv 的 falsy 判断归一为
// 无环境运行；extends 的 null 在 env:create 分支显式归一为 undefined（模型 strict schema
// 拒绝 null，落盘不可带回）。
const EnvCreateInputSchema = z.object({ projectId: z.string(), name: z.string(), extends: z.string().nullish() });
const DebugInputSchema = z.object({ apiId: z.string(), caseId: z.string(), envName: z.string().nullish() });
const RunInputSchema = z.object({ collectionId: z.string(), envName: z.string().nullish() });
const ImportPreviewInputSchema = z.object({ fileName: z.string(), content: z.string() });
const ImportApplyInputSchema = z.object({ groupName: z.string(), project: ProjectSchema });
// 工作流频道（M2-B 任务 1）：wf:save 复用 core WorkflowSchema 全量校验（strict，未知字段
// fail-fast）；wf:run 的 envName 沿用 envName nullish 惯例（null 归一为无环境运行）。
const WfListInputSchema = z.object({ projectId: z.string() });
const WfGetInputSchema = z.object({ workflowId: z.string() });
const WfCreateInputSchema = z.object({ projectId: z.string(), name: z.string() });
const WfDeleteInputSchema = z.object({ workflowId: z.string() });
const WfRenameInputSchema = z.object({ workflowId: z.string(), name: z.string() });
const WfSaveInputSchema = z.object({ workflow: WorkflowSchema });
const WfSetStatusInputSchema = z.object({ workflowId: z.string(), next: WorkflowStatusSchema });
const WfImpactInputSchema = z.object({ caseId: z.string().optional(), apiId: z.string().optional() });
const WfRunInputSchema = z.object({ workflowId: z.string(), envName: z.string().nullish() });
// 压测频道（M2-D3 任务 1）：envName 沿用 nullish 惯例；maxIterations/durationMs 传 null
// （antd InputNumber 清空口径）同样放行，null 由 stress.ts 归一为 undefined（终止条件
// 二者都缺时由 StressRunner 抛「压测终止条件缺失」core 文案）。
const StressRunInputSchema = z.object({
  apiId: z.string(),
  caseId: z.string(),
  envName: z.string().nullish(),
  concurrency: z.number().int().positive(),
  maxIterations: z.number().int().positive().nullish(),
  durationMs: z.number().positive().nullish(),
});
// 在线频道（M3-B 任务 1）：复用 shared/online/contract.ts 的契约 schema（path 规则/批量上限/
// register 校验单一来源），仅叠加频道定位字段（baseUrl/workspaceId）。未登录错误的可读文案
// 由 online session 抛出（「尚未登录在线服务器」），此处只管形状。
const OnlineRegisterChannelSchema = OnlineRegisterInputSchema.extend({ baseUrl: OnlineBaseUrlSchema });
const OnlineLoginChannelSchema = z.object({ baseUrl: OnlineBaseUrlSchema, username: z.string(), password: z.string() });
const OnlineResumeChannelSchema = z.object({ baseUrl: OnlineBaseUrlSchema });
const OnlineWorkspaceIdSchema = z.object({ workspaceId: z.string().min(1) });
const OnlineFilesGetChannelSchema = OnlineGetFilesInputSchema.extend({ workspaceId: z.string().min(1) });
const OnlineFilePutChannelSchema = z.object({
  workspaceId: z.string().min(1),
  path: OnlinePathSchema,
  content: z.string(),
  baseVersion: z.number().int().nonnegative(),
});
const OnlineFilesBatchChannelSchema = OnlineBatchInputSchema.extend({ workspaceId: z.string().min(1) });
const OnlineFileDeleteChannelSchema = z.object({
  workspaceId: z.string().min(1),
  path: OnlinePathSchema,
  baseVersion: z.number().int().nonnegative(),
});
// 在线工作区/迁移频道（M3-B 任务 3）：open 携工作区摘要三元组（角色过契约枚举）；
// migrate:write 批量 ≤200（与 §3.4 批量口径一致）、路径过契约 path 规则（越界在 main 侧再兜底）。
const OnlineWorkspaceOpenChannelSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  myRole: OnlineRoleSchema,
});
// M3-C 前置对齐顺带（M3-B 终审 Minor 6）：workspaceId 定位 schema 统一复用 OnlineWorkspaceIdSchema，
// 消除 OnlineWorkspaceIdRequiredSchema 重复定义。
const OnlineMigrateScanChannelSchema = z.object({ dir: z.string().min(1) });
const OnlineMigrateWriteChannelSchema = z.object({
  dir: z.string().min(1),
  files: z.array(z.object({ path: OnlinePathSchema, content: z.string() })).min(1).max(200),
});
// AI 频道（M6-C 任务 1）：save-config 形状校验（baseUrl/model 由渲染层表单与 localStorage
// 持久化，main 只收形状；apiKey 非空才入安全存储）；suggest 入参宽松（fixture 桩不消费
// apiId，任务 2 切真 provider 时按 core 契约收紧）。
const AiSaveConfigChannelSchema = z.object({
  baseUrl: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string().optional(),
});
const AiSuggestChannelSchema = z.object({ apiId: z.string() });

/** 频道 → 入参 tuple schema 表：Record 键为全部频道名，新增频道漏配 schema 即编译错误。 */
const schemas: Record<IpcChannelName, z.ZodTypeAny> = {
  [IpcChannel.WsOpen]: z.tuple([z.string()]),
  [IpcChannel.WsCreate]: z.tuple([z.string(), z.string()]),
  [IpcChannel.WsPickDirectory]: z.tuple([]),
  [IpcChannel.WsValidate]: z.tuple([]),
  [IpcChannel.TreeGet]: z.tuple([]),
  [IpcChannel.NodeCreate]: z.tuple([NodeCreateInputSchema]),
  [IpcChannel.NodeRename]: z.tuple([NodeKindSchema, z.string(), z.string()]),
  [IpcChannel.NodeDelete]: z.tuple([NodeKindSchema, z.string()]),
  [IpcChannel.EnvCreate]: z.tuple([EnvCreateInputSchema]),
  [IpcChannel.EnvVarsSave]: z.tuple([z.string(), z.record(z.string(), z.string())]),
  [IpcChannel.ApiGet]: z.tuple([z.string()]),
  [IpcChannel.ApiSave]: z.tuple([ApiDefinitionSchema]),
  [IpcChannel.DebugSend]: z.tuple([DebugInputSchema]),
  [IpcChannel.RunCollection]: z.tuple([RunInputSchema]),
  [IpcChannel.RunsList]: z.tuple([]),
  [IpcChannel.RunsGet]: z.tuple([z.string()]),
  [IpcChannel.ImportPreview]: z.tuple([ImportPreviewInputSchema]),
  [IpcChannel.ImportApply]: z.tuple([ImportApplyInputSchema]),
  [IpcChannel.DesignExport]: z.tuple([z.string()]),
  [IpcChannel.WfList]: z.tuple([WfListInputSchema]),
  [IpcChannel.WfGet]: z.tuple([WfGetInputSchema]),
  [IpcChannel.WfCreate]: z.tuple([WfCreateInputSchema]),
  [IpcChannel.WfDelete]: z.tuple([WfDeleteInputSchema]),
  [IpcChannel.WfRename]: z.tuple([WfRenameInputSchema]),
  [IpcChannel.WfSave]: z.tuple([WfSaveInputSchema]),
  [IpcChannel.WfSetStatus]: z.tuple([WfSetStatusInputSchema]),
  [IpcChannel.WfImpact]: z.tuple([WfImpactInputSchema]),
  [IpcChannel.WfRun]: z.tuple([WfRunInputSchema]),
  [IpcChannel.StressRun]: z.tuple([StressRunInputSchema]),
  [IpcChannel.StressStop]: z.tuple([]),
  // 在线频道（M3-B 任务 1）：login/register 携 baseUrl；内容频道携 workspaceId 定位。
  [IpcChannel.OnlineRegister]: z.tuple([OnlineRegisterChannelSchema]),
  [IpcChannel.OnlineLogin]: z.tuple([OnlineLoginChannelSchema]),
  [IpcChannel.OnlineLogout]: z.tuple([]),
  [IpcChannel.OnlineResume]: z.tuple([OnlineResumeChannelSchema]),
  [IpcChannel.OnlineMe]: z.tuple([]),
  [IpcChannel.OnlineWorkspaceList]: z.tuple([]),
  [IpcChannel.OnlineWorkspaceCreate]: z.tuple([z.object({ name: z.string().min(1) })]),
  [IpcChannel.OnlineTreeGet]: z.tuple([OnlineWorkspaceIdSchema]),
  [IpcChannel.OnlineFilesGet]: z.tuple([OnlineFilesGetChannelSchema]),
  [IpcChannel.OnlineFilePut]: z.tuple([OnlineFilePutChannelSchema]),
  [IpcChannel.OnlineFilesBatch]: z.tuple([OnlineFilesBatchChannelSchema]),
  [IpcChannel.OnlineFileDelete]: z.tuple([OnlineFileDeleteChannelSchema]),
  // 在线工作区/迁移频道（M3-B 任务 3）
  [IpcChannel.OnlineWorkspaceOpen]: z.tuple([OnlineWorkspaceOpenChannelSchema]),
  [IpcChannel.OnlineWorkspaceClose]: z.tuple([]),
  [IpcChannel.OnlineTreeView]: z.tuple([OnlineWorkspaceIdSchema]),
  [IpcChannel.OnlineMigrateScan]: z.tuple([OnlineMigrateScanChannelSchema]),
  [IpcChannel.OnlineMigrateWrite]: z.tuple([OnlineMigrateWriteChannelSchema]),
  // AI 频道（M6-C 任务 1）
  [IpcChannel.AiSaveConfig]: z.tuple([AiSaveConfigChannelSchema]),
  [IpcChannel.AiGetConfig]: z.tuple([]),
  [IpcChannel.AiSuggest]: z.tuple([AiSuggestChannelSchema]),
};

/** 频道入参校验辅助：失败抛带频道名的可读错误（经组合根错误通道显示）。 */
function validateArgs<T>(channel: IpcChannelName, schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "未知错误";
    throw new Error(`[${channel}] 入参校验失败: ${where}`);
  }
  return result.data;
}

/** wf:run 的接口解析注册中心：与 debug.ts 的集合/调试运行同一默认注册中心（脚本引擎、报告器）。 */
const wfRegistry = createDefaultRegistry();

/**
 * 工作流运行（M2-B 任务 1，仿 CLI run-workflow）：draft 直接拒绝（UI 对 draft 禁用运行
 * 按钮，此为护栏）；envName 传给 WorkflowRunner 按名解析（未命中抛「未找到环境: xxx」）；
 * 结果固定落盘 .apicc/runs/workflow-<id>-<ts>.json（生成物隔离，规格 §6/§8）。
 */
async function runWorkflow(session: Session, input: WfRunInput): Promise<WorkflowRunResult> {
  const loc = session.locateWorkflow(input.workflowId);
  if (!loc) throw new Error(`未找到工作流: ${input.workflowId}`);
  if (loc.workflow.status === "draft") throw new Error("工作流为草稿，请先发布启用");
  // locateWorkflow 内 ensureOpen 已保证会话打开，root/workspace 非空（与 debug.ts 运行链路同款断言）。
  const ws = session.workspace!;
  // resolve：workspace 全树查找接口定义（含文件夹内接口，与 CLI run-workflow 同口径）。
  const findApi = (apiId: string) => {
    for (const g of ws.groups) for (const p of g.projects) for (const c of p.collections) {
      const api = c.apis.find((a) => a.id === apiId);
      if (api) return api;
      for (const f of c.folders) { const fa = f.apis.find((a) => a.id === apiId); if (fa) return fa; }
    }
    return undefined;
  };
  const runner = new WorkflowRunner({ registry: wfRegistry, resolve: findApi, envName: input.envName ?? undefined, failFast: false });
  const result = await runner.run(loc.workflow, { project: loc.project, workspace: ws });
  const runsDir = workspaceRunsDir(session.root!);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `workflow-${result.workflowId}-${Date.now()}.json`), JSON.stringify(result, null, 2));
  return result;
}

export interface OnlineIpcDeps {
  /** client 工厂（生产 = createOnlineClient + globalThis.fetch，测试 = 假 fetch）。 */
  createClient: (baseUrl: string, hooks: { onUnauthorized: () => void }) => OnlineClient;
  /** token 安全存储（生产 = userData 目录 + electron safeStorage）。 */
  tokenStore: TokenStore;
}

export interface AiIpcDeps {
  /** AI key 安全存储（生产 = userData 目录 + electron safeStorage）。 */
  keyStore: AiKeyStore;
}

export interface IpcDepsOptions {
  session: Session;
  pickDirectory: () => Promise<string>;
  /**
   * 文件保存（design:export 用，任务 8）：生产实现 = dialog.showSaveDialog + 写盘，
   * 返回保存路径（用户取消回传空串）；测试注入内存实现。
   */
  saveFile: (defaultName: string, content: string) => Promise<string>;
  /** 导入器列表（任务 7）：默认取内置注册中心的全部导入器，测试注入固定 importer 替身。 */
  importers?: Importer[];
  /** 在线依赖（M3-B 任务 1）：省略时 online:* 频道抛「在线功能未配置」可读错误。 */
  online?: OnlineIpcDeps;
  /** AI 依赖（M6-C 任务 1）：省略时 ai:* 频道抛「AI 功能未配置」可读错误。 */
  ai?: AiIpcDeps;
}

export function createIpcDeps(options: IpcDepsOptions) {
  const { session, pickDirectory, saveFile } = options;
  const importers = options.importers ?? createDefaultRegistry().listImporters();
  // 在线会话（M3-B 任务 1）：login→存 token→请求自动带头的串联体（见 online/session.ts）。
  const online: OnlineSession | null = options.online
    ? createOnlineSession({ createClient: options.online.createClient, tokenStore: options.online.tokenStore })
    : null;
  function requireOnline(): OnlineSession {
    if (!online) throw new Error("在线功能未配置");
    return online;
  }
  // AI 依赖（M6-C 任务 1）：keyStore 注入省略时 ai:* 频道给可读错误（与 requireOnline 同口径）。
  const ai: AiIpcDeps | null = options.ai ?? null;
  function requireAi(): AiIpcDeps {
    if (!ai) throw new Error("AI 功能未配置");
    return ai;
  }
  // 压测控制器（M2-D3 任务 1）：状态挂 deps 闭包（进程内单例），ws:open/ws:create 切换
  // 工作区时先 abort 活动 run（清理点；session 无 close 钩子，既有清理先例即 ipc 分支层）。
  const stress = createStressController(session);

  /**
   * api 分支父解析（宽审查 C1）：parentId 可能是文件夹 id——先在工作区中按文件夹命中
   （取其所属集合 id 作 collectionId、文件夹 id 作 folderId）；未命中再按集合 id 解析
   （folderId=null，挂集合根）。此前直接把 parentId 当集合 id 传给 createApi，
   侧树文件夹行上的「新建接口」一按就抛「未找到集合」。
   */
  function resolveApiParent(ws: Workspace | null, parentId: string): { collectionId: string; folderId: string | null } {
    if (ws) {
      for (const group of ws.groups) {
        for (const project of group.projects) {
          for (const collection of project.collections) {
            const folder = collection.folders.find((f) => f.id === parentId);
            if (folder) return { collectionId: collection.id, folderId: folder.id };
          }
        }
      }
    }
    return { collectionId: parentId, folderId: null };
  }

  // 返回统一瘦 DTO（宽审查 I2）：与 memory 替身同构，渲染层无需感知原生节点形状。
  function createNode(input: NodeCreateInput): NodeCreatedDTO {
    switch (input.kind) {
      case "group": {
        const g = session.createGroup(input.name);
        return { kind: "group", id: g.id, label: g.name };
      }
      case "project": {
        const p = session.createProject(input.parentId!, input.name);
        return { kind: "project", id: p.id, label: p.name };
      }
      case "collection": {
        const c = session.createCollection(input.parentId!, input.name);
        return { kind: "collection", id: c.id, label: c.name };
      }
      case "folder": {
        const f = session.createFolder(input.parentId!, input.name);
        return { kind: "folder", id: f.id, label: f.name };
      }
      case "api": {
        const parent = resolveApiParent(session.workspace, input.parentId!);
        const a = session.createApi(parent.collectionId, parent.folderId, {
          name: input.name,
          method: (input.method ?? "GET") as Parameters<Session["createApi"]>[2]["method"],
          url: input.url ?? "/",
        });
        return { kind: "api", id: a.id, label: a.name, method: a.method };
      }
    }
  }

  // 返回值用 any：各频道返回各自 DTO（关键形状已在分支内 satisfies 校验），
  // 测试与渲染层按频道直取属性，统一 unknown 会迫使每处断言。
  async function handle(channel: IpcChannelName, _event: unknown, ...args: unknown[]): Promise<any> {
    // 入参校验收口（任务 8）：所有频道在进入分支前统一按 tuple schema parse，
    // 形状非法即抛带频道名的可读错误，分支内不再依赖裸 as 断言兜底形状。
    const a = validateArgs(channel, schemas[channel]!, args) as unknown[];
    switch (channel) {
      case IpcChannel.WsOpen: {
        // 工作区切换清理点（M2-D3 任务 1）：活动压测先 abort，部分报告由其收尾异步落回原工作区。
        stress.abortActive();
        // 模式互斥（M3-B 任务 3，裁定 E）：打开本地目录工作区前先关闭在线工作区会话
        // （复用 ws:open 既有清理链的接线点；清在线侧不依赖本地打开成败，失败路径也保持互斥）。
        online?.closeWorkspace();
        const r = await session.open(a[0] as string);
        return r satisfies OpenResult;
      }
      case IpcChannel.WsCreate: {
        stress.abortActive();
        // 同上（裁定 E）：本地工作区创建/打开共用 ws:open 的清理链路。
        online?.closeWorkspace();
        const r = await session.create(a[0] as string, a[1] as string);
        return r satisfies OpenResult;
      }
      case IpcChannel.WsPickDirectory:
        return pickDirectory();
      case IpcChannel.WsValidate:
        return session.validate();
      case IpcChannel.TreeGet: {
        const ws = session.workspace;
        if (!ws) throw new Error("尚未打开工作区");
        return toTreeNode(ws) as TreeNodeDTO;
      }
      case IpcChannel.NodeCreate: {
        // 返回统一瘦 DTO（kind/id/label[/method]，宽审查 I2），渲染层据此定位与续操作。
        const node = createNode(a[0] as NodeCreateInput);
        await session.save();
        return node;
      }
      case IpcChannel.NodeRename: {
        const [kind, id, name] = a as [Parameters<Session["renameNode"]>[0], string, string];
        session.renameNode(kind, id, name);
        await session.save();
        return undefined;
      }
      case IpcChannel.NodeDelete: {
        const [kind, id] = a as [Parameters<Session["deleteNode"]>[0], string];
        session.deleteNode(kind, id);
        await session.save();
        return undefined;
      }
      // 环境频道（任务 4）：session 变更操作不自动落盘，两分支均显式 save（语义备忘）。
      case IpcChannel.EnvCreate: {
        const input = a[0] as EnvCreateInput;
        // extends 显式 null 归一为 undefined：模型 strict schema 拒绝 null，不可写入后落盘。
        const env = session.createEnvironment(input.projectId, { name: input.name, extends: input.extends ?? undefined });
        await session.save();
        return env;
      }
      case IpcChannel.EnvVarsSave: {
        const [envId, variables] = a as [string, Record<string, string>];
        session.setEnvironmentVariables(envId, variables);
        await session.save();
        return undefined;
      }
      case IpcChannel.ApiGet: {
        const loc = session.locateApi(a[0] as string);
        if (!loc) throw new Error(`未找到接口: ${a[0] as string}`);
        const detail: ApiDetail = {
          api: loc.api,
          envs: loc.project.environments.map((e) => ({ id: e.id, name: e.name })),
        };
        return detail;
      }
      case IpcChannel.ApiSave: {
        // saveApi 内部已落盘（替换 + save），此处不再重复 save。
        await session.saveApi(a[0] as Parameters<Session["saveApi"]>[0]);
        return undefined;
      }
      case IpcChannel.DebugSend: {
        const result = await sendDebug(session, a[0] as DebugInput);
        return result satisfies DebugOutput;
      }
      // 运行频道（任务 6）：run:collection 走完整 Runner 并固定落盘 .apicc/runs；
      // runs:list/get 读历史（目录不存在/文件损坏已在 runs.ts 侧降级为 []/null）。
      case IpcChannel.RunCollection: {
        const run = await runCollection(session, a[0] as RunCollectionInput);
        return run satisfies RunResult;
      }
      case IpcChannel.RunsList: {
        if (!session.root) throw new Error("尚未打开工作区");
        return listRuns(workspaceRunsDir(session.root)) satisfies Array<RunSummaryDTO | StressRunSummaryDTO>;
      }
      case IpcChannel.RunsGet: {
        if (!session.root) throw new Error("尚未打开工作区");
        return readRun(workspaceRunsDir(session.root), a[0] as string);
      }
      // 导入频道（任务 7）：preview 逐个 detect，命中即 parse（产物 id 均为新 UUID）；
      // apply 委派 session.importProject（缺分组建组、同分组重名拒绝），其内部显式落盘。
      case IpcChannel.ImportPreview: {
        const input = a[0] as ImportPreviewInput;
        const importer = importers.find((i) => i.detect(input.fileName, input.content));
        if (!importer) throw new Error("无法识别的导入格式");
        const { project, warnings } = importer.parse(input.content);
        return { importerName: importer.name, project, warnings };
      }
      case IpcChannel.ImportApply: {
        const input = a[0] as ImportApplyInput;
        await session.importProject(input.groupName, { project: input.project });
        return undefined;
      }
      // 详细设计导出（任务 8）：取接口 → core renderDesignMarkdown 渲染 → 注入的
      // saveFile（生产 = showSaveDialog + 写盘）落盘并返回路径（取消为空串）。
      case IpcChannel.DesignExport: {
        const apiId = a[0] as string;
        const loc = session.locateApi(apiId);
        if (!loc) throw new Error(`未找到接口: ${apiId}`);
        return saveFile(`${loc.api.name}.design.md`, renderDesignMarkdown(loc.api));
      }
      // 工作流频道（M2-B 任务 1）：变更分支显式 save（session 变更操作不自动落盘，
      // 语义备忘同环境频道）；set-status 仅在迁移成功（errors 为空）时落盘。
      case IpcChannel.WfList: {
        const input = a[0] as { projectId: string };
        const ws = session.workspace;
        if (!ws) throw new Error("尚未打开工作区");
        const project = ws.groups.flatMap((g) => g.projects).find((p) => p.id === input.projectId);
        if (!project) throw new Error(`未找到项目: ${input.projectId}`);
        return project.workflows.map((w) => ({ id: w.id, name: w.name, status: w.status }));
      }
      case IpcChannel.WfGet: {
        const input = a[0] as { workflowId: string };
        const loc = session.locateWorkflow(input.workflowId);
        if (!loc) throw new Error(`未找到工作流: ${input.workflowId}`);
        return { workflow: loc.workflow, projectId: loc.project.id };
      }
      case IpcChannel.WfCreate: {
        const input = a[0] as WfCreateInput;
        const workflow = session.createWorkflow(input.projectId, input.name);
        await session.save();
        return workflow;
      }
      case IpcChannel.WfDelete: {
        const input = a[0] as { workflowId: string };
        session.deleteWorkflow(input.workflowId);
        await session.save();
        return undefined;
      }
      case IpcChannel.WfRename: {
        // renameWorkflow 内部已落盘（改名 + save → cleanupOrphanDirs 清旧目录），不再重复 save。
        const input = a[0] as { workflowId: string; name: string };
        await session.renameWorkflow(input.workflowId, input.name);
        return undefined;
      }
      case IpcChannel.WfSave: {
        // saveWorkflow 内部已落盘（恒保持 status 替换 + save），此处不再重复 save。
        const input = a[0] as { workflow: Parameters<Session["saveWorkflow"]>[0] };
        return session.saveWorkflow(input.workflow);
      }
      case IpcChannel.WfSetStatus: {
        const input = a[0] as { workflowId: string; next: Parameters<Session["setWorkflowStatus"]>[1] };
        const result = session.setWorkflowStatus(input.workflowId, input.next);
        if (result.errors.length === 0) await session.save();
        return result;
      }
      case IpcChannel.WfImpact: {
        const input = a[0] as WfImpactInput;
        const ws = session.workspace;
        if (!ws) throw new Error("尚未打开工作区");
        return workflowImpact(ws, { caseId: input.caseId, apiId: input.apiId });
      }
      case IpcChannel.WfRun: {
        return runWorkflow(session, a[0] as WfRunInput);
      }
      // 压测频道（M2-D3 任务 1）：run 返回最终报告 + 落盘文件名；stop 返回中止后的
      // 部分报告（abort 语义见 stress.ts）。返回前报告已深拷贝（DataCloneError 防御）。
      case IpcChannel.StressRun: {
        const out = await stress.run(a[0] as StressRunInput);
        return out satisfies StressRunOutput;
      }
      case IpcChannel.StressStop: {
        const out = await stress.stop();
        return out satisfies StressRunOutput;
      }
      // 在线频道（M3-B 任务 1）：全部委派 online session（登录态串联/冲突出口转换在其内聚）。
      // login 出口不含 token（token 留 main 进程）；put/delete 的 409 转为 outcome 结果对象。
      case IpcChannel.OnlineRegister: {
        return requireOnline().register(a[0] as Parameters<OnlineSession["register"]>[0]);
      }
      case IpcChannel.OnlineLogin: {
        return requireOnline().login(a[0] as Parameters<OnlineSession["login"]>[0]);
      }
      case IpcChannel.OnlineLogout:
        await requireOnline().logout();
        return undefined;
      case IpcChannel.OnlineResume:
        return requireOnline().resume((a[0] as { baseUrl: string }).baseUrl);
      case IpcChannel.OnlineMe:
        return requireOnline().me();
      case IpcChannel.OnlineWorkspaceList:
        return requireOnline().listWorkspaces();
      case IpcChannel.OnlineWorkspaceCreate:
        return requireOnline().createWorkspace(a[0] as Parameters<OnlineSession["createWorkspace"]>[0]);
      case IpcChannel.OnlineTreeGet:
        return requireOnline().getTree((a[0] as { workspaceId: string }).workspaceId);
      case IpcChannel.OnlineFilesGet:
        return requireOnline().getFiles(a[0] as Parameters<OnlineSession["getFiles"]>[0]);
      case IpcChannel.OnlineFilePut:
        return requireOnline().putFile(a[0] as Parameters<OnlineSession["putFile"]>[0]);
      case IpcChannel.OnlineFilesBatch:
        return requireOnline().batchPush(a[0] as OnlineFilesBatchInput);
      case IpcChannel.OnlineFileDelete:
        return requireOnline().deleteFile(a[0] as Parameters<OnlineSession["deleteFile"]>[0]);
      // 在线工作区/迁移频道（M3-B 任务 3）：open 与 ws:open 同一清理链（先 abort 活动压测，
      // 裁定 E 互斥的接线点）；树取回失败不残留半开会话（closeWorkspace 后原样上抛）。
      case IpcChannel.OnlineWorkspaceOpen: {
        stress.abortActive();
        const input = a[0] as OnlineWorkspaceOpenInput;
        const sessionOnline = requireOnline();
        sessionOnline.openWorkspace(input);
        try {
          return await sessionOnline.getTreeView(input.workspaceId);
        } catch (e) {
          sessionOnline.closeWorkspace();
          throw e;
        }
      }
      case IpcChannel.OnlineWorkspaceClose:
        requireOnline().closeWorkspace();
        return undefined;
      case IpcChannel.OnlineTreeView:
        return requireOnline().getTreeView((a[0] as { workspaceId: string }).workspaceId);
      case IpcChannel.OnlineMigrateScan:
        return { files: scanDirFiles((a[0] as { dir: string }).dir) };
      case IpcChannel.OnlineMigrateWrite: {
        const input = a[0] as { dir: string; files: Array<{ path: string; content: string }> };
        return { written: writeFiles(input.dir, input.files) };
      }
      // AI 频道（M6-C 任务 1，规格 §2 D2/D4）：save/get 只落 key（baseUrl/model 由渲染层
      // localStorage 持久化）；出口恒 { hasKey }（key 明文永不回传渲染层，裁定②）；
      // apiKey 省略/空串 = 保持既有。suggest 为 fixture 桩：已存密钥返回固定两条建议
      // （深拷贝防内部引用泄漏），未配置抛可读错误（连接测试失败态同源）；任务 2 切真 provider。
      case IpcChannel.AiSaveConfig: {
        const input = a[0] as AiSaveConfigInput;
        if (input.apiKey) requireAi().keyStore.save(input.apiKey);
        return { hasKey: requireAi().keyStore.load() !== null } satisfies AiKeyStatus;
      }
      case IpcChannel.AiGetConfig:
        return { hasKey: requireAi().keyStore.load() !== null } satisfies AiKeyStatus;
      case IpcChannel.AiSuggest: {
        if (requireAi().keyStore.load() === null) {
          throw new Error("尚未配置 AI 密钥，请先在 AI 设置中保存配置");
        }
        return AI_FIXTURE_SUGGESTIONS.map((s) => structuredClone(s) as AiSuggestedCase);
      }
      default:
        throw new Error(`未知频道: ${channel}`);
    }
  }

  return { handle };
}
