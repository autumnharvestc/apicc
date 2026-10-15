import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { WorkflowRunner, StressSafetyError, createHttpSession, findProjectApi, createProjectSnapshot, createDebugHistoryOwnerKey, createDebugReplayInvocation, restoreDebugHistoryExchange, renderContractMarkdown, resolveExecutionEnvironment, selectEffectiveCases, validateWorkflowStructure, getSourceApiRevision, type Importer, type PluginRegistry, type RunResult, type WorkflowRunResult, type ApiAsset, type Environment, type Workflow, type WorkflowStatus, type DebugHistoryRecord, type DebugInvocation, type CredentialRequestSelection } from "@apicc/core";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { IpcChannel, type IpcChannelName } from "../shared/channels.js";
import { StressRunResultSchema, type ApiDetail, type ContainerSaveInput, type ContainerTarget, type DebugInput, type DebugOutput, type DebugHistoryReplayResult, type DebugHistoryRestoreResult, type DebugFileReference, type EnvCreateInput, type ImportApplyInput, type ImportPreviewInput, type NodeCreateInput, type NodeCreatedDTO, type OpenResult, type RunCollectionInput, type RunSummaryDTO, type StressRunInput, type StressRunOutput, type StressRunResult, type StressRunSummaryDTO, type WfCreateInput, type WfImpactInput, type WfRunInput, type ProjectGlobalSettings, type WorkflowSummary } from "../shared/types.js";
import { parseIpcArgs, type IpcArgsMap, type IpcResultMap } from "../shared/ipc-contract.js";
import type { ApiLocator, ApiParentLocator, CaseLocator, CollectionLocator, ComponentLocator, EnvironmentLocator, FolderLocator, GroupLocator, ModelLocator, ProjectLocator, WorkflowLocator, WorkspaceLocator } from "../shared/locations.js";
import { localTreeNodeKey } from "../shared/tree-dto.js";
import type { OnlineFilesBatchInput, OnlineProjectMappingInput, OnlineWorkspaceOpenInput } from "../shared/online/types.js";
import type { ApiTestCase, ComponentAsset, DebugFieldState, ModelAsset } from "@apicc/core";
import { createOnlineSession, type OnlineSession } from "./online/session.js";
import { scanDirFiles, writeFiles } from "./online/migrate.js";
import type { OnlineClient } from "./online/client.js";
import type { TokenStore } from "./online/tokenStore.js";
import { runCollection, sendDebug, workspaceRunsDir } from "./debug.js";
import { createDebugController } from "./debugController.js";
import { createDesktopDebugHistoryStore } from "./debugHistory.js";
import { listRuns, readRun } from "./runs.js";
import { createStressController } from "./stress.js";
import type { createSession } from "./session.js";
import { toTreeNode } from "./tree.js";
import type { AiKeyStore } from "./ai/config.js";
import { runAiSuggest, runAiTestConfig, type AiRuntimeDeps } from "./ai/suggest.js";
import type { AiKeyStatus, AiSaveConfigInput, AiSuggestInput, AiTestConfigInput } from "../shared/ai/contract.js";
import { createPluginsRuntime, type PluginsRuntime, type PluginsRuntimeOptions } from "./plugins/runtime.js";
import type { PluginsListResult } from "../shared/plugins/contract.js";
import { createDesktopCredentialHost, type DesktopCredentialHostOptions, type PreparedDesktopExecutionRun } from "./credentials.js";
import { createExecutionOutputBoundary, persistExecutionJson } from "./executionOutput.js";
import type { CredentialPutInput, CredentialRefInput } from "../shared/credentials.js";

type Session = ReturnType<typeof createSession>;
type IsUnion<Value, Whole = Value> = Value extends Whole ? ([Whole] extends [Value] ? false : true) : never;
type HandleArgs<Channel extends IpcChannelName> = IsUnion<Channel> extends true ? unknown[] : IpcArgsMap[Channel];

// IPC argument schemas and channel/result maps are centralized in shared/ipc-contract.ts.


/**
 * 工作流运行（M2-B 任务 1，仿 CLI run-workflow）：draft 直接拒绝（UI 对 draft 禁用运行
 * 按钮，此为护栏）；envName 传给 WorkflowRunner 按名解析（未命中抛「未找到环境: xxx」）；
 * 结果固定落盘 .apicc/runs/workflow-<id>-<uuid>.json（生成物隔离，规格 §6/§8）。
 * registry 由调用方注入插件运行时的 registry（M7-B 任务 2：插件贡献在运行频道可选）。
 */
async function runWorkflow(
  session: Session,
  input: WfRunInput,
  registrySource: PluginRegistry | (() => Promise<PluginRegistry>),
  credentials: Pick<ReturnType<typeof createDesktopCredentialHost>, "prepareRunForRequests">,
): Promise<WorkflowRunResult> {
  const captured = {
    locator: { ...input.locator },
    envName: input.envName ?? undefined,
    strict: input.strict ?? true,
  };
  const loc = session.locateWorkflow(captured.locator);
  if (!loc) throw new Error(`未找到工作流: ${JSON.stringify(captured.locator)}`);
  if (loc.workflow.status === "draft") throw new Error("工作流为草稿，请先发布启用");
  const root = session.root!;
  const snapshot = createProjectSnapshot(loc.project);
  const workflow = snapshot.project.workflows.find((candidate) => candidate.id === captured.locator.workflowId);
  if (!workflow) throw new Error(`未找到工作流: ${JSON.stringify(captured.locator)}`);
  const structuralErrors = validateWorkflowStructure(workflow).filter((issue) => issue.level === "error");
  if (structuralErrors.length > 0) throw new Error(structuralErrors.map((issue) => issue.message).join("; "));
  const env = captured.envName
    ? snapshot.project.environments.find((candidate) => candidate.name === captured.envName)
    : undefined;
  if (captured.envName && !env) throw new Error(`未找到环境: ${captured.envName}`);
  const requestReferences = workflow.nodes.filter((node) => node.kind === "request").map((node) => {
    const location = node.apiId ? findProjectApi(snapshot.project, node.apiId) : undefined;
    const api = location?.api;
    const caseDef = api?.cases.find((candidate) => candidate.id === node.caseId);
    const effectiveCase = api && caseDef
      ? selectEffectiveCases(
        api.cases,
        resolveExecutionEnvironment(snapshot.project, location!.collection.id, env?.id).chain,
        caseDef.id,
      )[0]
      : undefined;
    return { location, api, caseDef, effectiveCase };
  });
  const hasMissingReference = requestReferences.some(({ location, api, caseDef }) => !location || !api || !caseDef);
  const credentialSelections: CredentialRequestSelection[] = captured.strict && hasMissingReference
    ? []
    : [...new Map(requestReferences.flatMap(({ api, effectiveCase }) =>
      api && effectiveCase ? [[`${api.contract.id}\0${effectiveCase.id}\0${effectiveCase.scope}`, { asset: api, testCase: effectiveCase }] as const] : [])).values()];
  let prepared: PreparedDesktopExecutionRun;
  const scope = {
    workspaceId: captured.locator.workspaceId,
    groupId: captured.locator.groupId,
    projectId: captured.locator.projectId,
  };
  try {
    prepared = await credentials.prepareRunForRequests(scope, snapshot, credentialSelections);
  } catch (error) {
    throw createExecutionOutputBoundary([]).error(error);
  }
  const boundary = createExecutionOutputBoundary(prepared.markers);
  const httpSession = createHttpSession();
  try {
    const registry = typeof registrySource === "function" ? await registrySource() : registrySource;
    const runner = new WorkflowRunner({ registry, failFast: false, strict: captured.strict, workspaceRoot: root, httpSession });
    const result = await runner.run(prepared.run, workflow.id, env ? { environmentId: env.id } : {});
    const file = `workflow-${result.workflowId}-${randomUUID()}.json`;
    const path = join(workspaceRunsDir(root), file);
    const persisted = persistExecutionJson(
      path,
      result,
      boundary,
      (error) => `工作流报告落盘失败（${path}）: ${error instanceof Error ? error.message : String(error)}`,
    );
    return boundary.value(persisted.warning
      ? { ...persisted.value, warnings: [...persisted.value.warnings, persisted.warning] }
      : persisted.value);
  } catch (error) {
    throw boundary.error(error);
  } finally {
    await httpSession.close();
  }
}

export interface OnlineIpcDeps {
  /** client 工厂（生产 = createOnlineClient + globalThis.fetch，测试 = 假 fetch）。 */
  createClient: (baseUrl: string, hooks: { onUnauthorized: () => void }) => OnlineClient;
  /** token 安全存储（生产 = userData 目录 + electron safeStorage）。 */
  tokenStore: TokenStore;
}

export interface AiIpcDeps extends AiRuntimeDeps {
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
  /** User-selected file metadata; the renderer never reads this path or its bytes. */
  pickDebugFile?: () => Promise<DebugFileReference | null>;
  /** 导入器列表（任务 7）：默认取内置注册中心的全部导入器，测试注入固定 importer 替身。 */
  importers?: Importer[];
  /** 在线依赖（M3-B 任务 1）：省略时 online:* 频道抛「在线功能未配置」可读错误。 */
  online?: OnlineIpcDeps;
  /** AI 依赖（M6-C 任务 1）：省略时 ai:* 频道抛「AI 功能未配置」可读错误。 */
  ai?: AiIpcDeps;
  /**
   * 插件运行时（M7-B 任务 2，规格 §2 D4/D8）：homeDir + loadPlugins 注入面（与 CLI
   * deps.pluginsHomeDir / deps.loadPlugins 对齐口径）。**省略 = 零加载零扰动**（既有桌面
   * 测试不读真实 HOME）；生产由 main.ts 显式传入启用（main 进程建 registry 时装载用户级
   * 清单）。运行频道（debug/集合/工作流）与 plugins:list、import:preview 探测共用其 registry。
   */
  plugins?: PluginsRuntimeOptions;
  credentials?: DesktopCredentialHostOptions;
  /** Lazy factory prevents unrelated IPC/debug tests from reading or creating app-data history. */
  debugHistory?: () => ReturnType<typeof createDesktopDebugHistoryStore>;
}

export function createIpcDeps(options: IpcDepsOptions) {
  const { session, pickDirectory, saveFile } = options;
  const pickDebugFile = options.pickDebugFile ?? (async (): Promise<DebugFileReference | null> => {
    const { dialog } = await import("electron");
    const choice = await dialog.showOpenDialog({ properties: ["openFile"] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const path = choice.filePaths[0];
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("所选路径不是普通文件");
    return { path, name: basename(path), size: metadata.size };
  });
  // 插件运行时（M7-B 任务 2）：未配置 = loadPlugins:false（零加载零扰动）；summary/registry
  // memoized 装载，运行频道与 plugins:list、导入探测共用同一 registry。
  const pluginsRuntime = createPluginsRuntime(options.plugins ?? { loadPlugins: false });
  // 导入探测（任务 7）：显式注入优先（既有测试替身）；未注入时改走插件运行时 registry
  // （内置 + 插件贡献导入器参与探测，T1 去留口径的 T2 落地——组合期固定内置清单的硬编码消除）。
  const injectedImporters = options.importers;
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
  const credentials = createDesktopCredentialHost(session, options.credentials);
  const stress = createStressController(session, {}, credentials);
  let debugHistoryStore: ReturnType<typeof createDesktopDebugHistoryStore> | undefined;
  function requireDebugHistory(): ReturnType<typeof createDesktopDebugHistoryStore> {
    if (debugHistoryStore) return debugHistoryStore;
    if (!options.debugHistory) throw new Error("本机调试历史未配置");
    debugHistoryStore = options.debugHistory();
    return debugHistoryStore;
  }
  const debugHistoryAppender = options.debugHistory
    ? { append: (result: import("@apicc/core").DebugResult, appendOptions: { ownerKey: string; parentHistoryId?: string }) => requireDebugHistory().append(result, appendOptions) }
    : undefined;
  const debug = createDebugController(session, () => pluginsRuntime.registry(), credentials, debugHistoryAppender);
  const watchedDebugOwners = new WeakSet<object>();

  function ownerFromEvent(event: unknown): object | undefined {
    if (typeof event !== "object" || event === null) return undefined;
    const sender = (event as { sender?: unknown }).sender;
    return typeof sender === "object" && sender !== null ? sender : undefined;
  }

  function watchOwner(owner: object | undefined): void {
    if (!owner || watchedDebugOwners.has(owner)) return;
    watchedDebugOwners.add(owner);
    const sender = owner as {
      once?: (event: string, listener: () => void) => unknown;
      on?: (event: string, listener: () => void) => unknown;
    };
    const cleanup = () => debug.clearOwner(owner);
    if (typeof sender.once === "function") sender.once("destroyed", cleanup);
    if (typeof sender.on === "function") sender.on("render-process-gone", cleanup);
  }

  function requireOwner(owner: object | undefined): object {
    if (!owner) throw new TypeError("A renderer IPC sender is required to own a debug run.");
    return owner;
  }

  async function requireHistoryRecord(historyId: string): Promise<DebugHistoryRecord> {
    const loaded = await requireDebugHistory().get(historyId);
    if (!loaded.record) {
      const detail = loaded.diagnostics.map((item) => item.message).join(" ");
      throw new Error(detail || "未找到调试历史记录");
    }
    return loaded.record;
  }

  function ownerKeyForInvocation(invocation: DebugInvocation): string {
    const root = session.root;
    if (!root) throw new Error("尚未打开工作区");
    return createDebugHistoryOwnerKey(realpathSync(root), invocation.mode === "case" ? invocation.case : invocation.locator);
  }

  async function requireHistoryOwner(historyId: string, ownerKey: string): Promise<void> {
    const owned = await requireDebugHistory().getOwned(historyId, ownerKey);
    if (!owned.record) throw new Error("这条调试历史属于其他工作区或接口，当前不能重放。");
  }

  async function createNode(input: NodeCreateInput): Promise<NodeCreatedDTO> {
    switch (input.kind) {
      case "group": {
        const g = await session.createGroup(input.parent, input.name);
        const locator = { ...input.parent, groupId: g.id };
        return { kind: "group", source: "local", id: g.id, key: localTreeNodeKey({ source: "local", kind: "group", locator }), locator, label: g.name };
      }
      case "project": {
        const p = await session.createProject(input.parent, input.name);
        const locator = { ...input.parent, projectId: p.id };
        return { kind: "project", source: "local", id: p.id, key: localTreeNodeKey({ source: "local", kind: "project", locator }), locator, label: p.name };
      }
      case "collection": {
        const c = await session.createCollection(input.parent, input.name);
        const locator = { ...input.parent, collectionId: c.id };
        return { kind: "collection", source: "local", id: c.id, key: localTreeNodeKey({ source: "local", kind: "collection", locator }), locator, label: c.name };
      }
      case "folder": {
        const f = await session.createFolder(input.parent, input.name);
        const locator = { ...input.parent, folderIds: [...(input.parent.folderIds ?? []), f.id] };
        return { kind: "folder", source: "local", id: f.id, key: localTreeNodeKey({ source: "local", kind: "folder", locator }), locator, label: f.name };
      }
      case "api": {
        const api = await session.createApi(input.parent, input.api);
        const locator: ApiLocator = { ...input.parent, folderIds: input.parent.folderIds ?? [], apiId: api.contract.id };
        return {
          kind: "api", source: "local", id: api.contract.id,
          key: localTreeNodeKey({ source: "local", kind: "api", locator }), locator,
          label: api.contract.metadata.name, protocol: api.contract.request.protocol,
          ...(api.contract.request.protocol === "http" || api.contract.request.protocol === "soap" ? { method: api.contract.request.method } : {}),
        };
      }
    }
  }

  function findApiByLocator(locator: ApiLocator): { api: ApiAsset; context: ReturnType<typeof createProjectSnapshot>["context"] } | undefined {
    const located = session.locateApi(locator);
    if (!located) return undefined;
    const snapshot = createProjectSnapshot(located.project);
    return { api: structuredClone(located.api), context: snapshot.context };
  }

  async function dispatch(channel: IpcChannelName, rawArgs: unknown[], owner?: object): Promise<unknown> {
    const a = parseIpcArgs(channel, rawArgs) as unknown[];
    switch (channel) {
      case IpcChannel.WsOpen: {
        // 工作区切换清理点（M2-D3 任务 1）：活动压测先 abort，部分报告由其收尾异步落回原工作区。
        // 计划 C 任务 2：裁定 E 互斥退役——本地打开不再关闭在线会话（本地 1 + 在线 N 并存驻留）。
        stress.abortActive();
        if (owner) debug.clearOwner(owner);
        const r = await session.open(a[0] as string);
        return r satisfies OpenResult;
      }
      case IpcChannel.WsCreate: {
        // 同上：压测清理链保留；在线会话原样驻留（并存，互斥退役）。
        stress.abortActive();
        if (owner) debug.clearOwner(owner);
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
        return toTreeNode(ws) satisfies IpcResultMap[typeof IpcChannel.TreeGet];
      }
      case IpcChannel.NodeCreate: {
        return await createNode(a[0] as NodeCreateInput) satisfies IpcResultMap[typeof IpcChannel.NodeCreate];
      }
      case IpcChannel.NodeRename: {
        const [node, name] = a as [Parameters<Session["renameNode"]>[0], string];
        await session.renameNode(node, name);
        return undefined satisfies IpcResultMap[typeof IpcChannel.NodeRename];
      }
      case IpcChannel.NodeDelete: {
        await session.deleteNode(a[0] as Parameters<Session["deleteNode"]>[0]);
        return undefined satisfies IpcResultMap[typeof IpcChannel.NodeDelete];
      }
      case IpcChannel.EnvCreate: {
        const input = a[0] as EnvCreateInput;
        return await session.createEnvironment(input.locator, {
          name: input.name,
          extends: input.extends ?? undefined,
          variables: input.variables,
          baseUrls: input.baseUrls,
        }) satisfies IpcResultMap[typeof IpcChannel.EnvCreate];
      }
      case IpcChannel.EnvVarsSave: {
        const [locator, variables] = a as [EnvironmentLocator, Record<string, string>];
        return await session.setEnvironmentVariables(locator, variables) satisfies IpcResultMap[typeof IpcChannel.EnvVarsSave];
      }
      case IpcChannel.EnvBaseUrlsSave: {
        const [locator, baseUrls] = a as [EnvironmentLocator, Record<string, string>];
        return await session.setEnvironmentBaseUrls(locator, baseUrls) satisfies IpcResultMap[typeof IpcChannel.EnvBaseUrlsSave];
      }
      case IpcChannel.GlobalsSave: {
        const [locator, globals] = a as [ProjectLocator, ProjectGlobalSettings];
        return await session.setProjectGlobals(locator, globals) satisfies IpcResultMap[typeof IpcChannel.GlobalsSave];
      }
      case IpcChannel.GlobalsGet: {
        return session.getProjectGlobals(a[0] as ProjectLocator) satisfies IpcResultMap[typeof IpcChannel.GlobalsGet];
      }
      case IpcChannel.StressPolicySave: {
        return await session.setStressPolicy(a[0] as ProjectLocator, a[1] as Parameters<Session["setStressPolicy"]>[1]) satisfies IpcResultMap[typeof IpcChannel.StressPolicySave];
      }
      case IpcChannel.ContainerGet: {
        const target = a[0] as ContainerTarget;
        if (target.kind === "collection") {
          const location = session.locateCollection(target.locator);
          if (!location) throw new Error(`Collection not found at complete locator: ${JSON.stringify(target.locator)}`);
          return { kind: target.kind, locator: target.locator, name: location.collection.name, operations: session.getContainer(target.locator) } satisfies IpcResultMap[typeof IpcChannel.ContainerGet];
        }
        const location = session.locateFolder(target.locator);
        if (!location) throw new Error(`Folder not found at complete locator: ${JSON.stringify(target.locator)}`);
        return { kind: target.kind, locator: target.locator, name: location.folder.name, operations: session.getContainer(target.locator) } satisfies IpcResultMap[typeof IpcChannel.ContainerGet];
      }
      case IpcChannel.ContainerSave: {
        const input = a[0] as ContainerSaveInput;
        if (input.kind === "collection") {
          const operations = await session.saveContainer(input.locator, input.operations);
          return { kind: input.kind, locator: input.locator, operations } satisfies IpcResultMap[typeof IpcChannel.ContainerSave];
        }
        const operations = await session.saveContainer(input.locator, input.operations);
        return { kind: input.kind, locator: input.locator, operations } satisfies IpcResultMap[typeof IpcChannel.ContainerSave];
      }
      case IpcChannel.ApiGet: {
        const locator = a[0] as ApiLocator;
        const loc = session.locateApi(locator);
        if (!loc) throw new Error(`未找到接口: ${JSON.stringify(locator)}`);
        const detail: ApiDetail = {
          api: loc.api,
          locator,
          sourceApiRevision: getSourceApiRevision(loc.api),
          sourceProjectRevision: createProjectSnapshot(loc.project).definitionRevision,
          envs: loc.project.environments.map((e) => ({ id: e.id, name: e.name, locator: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId, environmentId: e.id } })),
        };
        return detail satisfies IpcResultMap[typeof IpcChannel.ApiGet];
      }
      case IpcChannel.ApiSave: {
        const [locator, api, expectedRevision] = a as [ApiLocator, ApiAsset, string];
        const draftWriteContext = session.captureDraftWriteContext();
        const candidateRequests = [api.contract.request, ...api.cases.map((testCase) => testCase.requestOverride ?? api.contract.request)];
        const knownCredentialLiterals = await credentials.getKnownCredentialLiterals(locator, candidateRequests, draftWriteContext);
        return await session.saveApi(locator, api, knownCredentialLiterals, draftWriteContext, expectedRevision) satisfies IpcResultMap[typeof IpcChannel.ApiSave];
      }
      case IpcChannel.ApiRequestDraftSave: {
        const [locator, request, expectedRevision, fields] = a as [ApiLocator, import("@apicc/core").ApiRequest, string, DebugFieldState[]];
        if (fields.some((field) => field.needsInput)) throw new Error("请先补齐调试恢复字段，再保存请求草稿。");
        const draftWriteContext = session.captureDraftWriteContext();
        const knownCredentialLiterals = await credentials.getKnownCredentialLiterals(locator, request, draftWriteContext);
        return await session.saveRequestDraft(locator, request, expectedRevision, fields, knownCredentialLiterals, draftWriteContext) satisfies IpcResultMap[typeof IpcChannel.ApiRequestDraftSave];
      }
      case IpcChannel.CaseSave: {
        const [locator, testCase, expectedRevision, fields] = a as [CaseLocator, ApiTestCase, string, DebugFieldState[]];
        if (fields.some((field) => field.needsInput)) throw new Error("请先补齐调试恢复字段，再保存用例。");
        const draftWriteContext = session.captureDraftWriteContext();
        const apiLocator: ApiLocator = {
          workspaceId: locator.workspaceId,
          groupId: locator.groupId,
          projectId: locator.projectId,
          collectionId: locator.collectionId,
          folderIds: [...locator.folderIds],
          apiId: locator.apiId,
        };
        const request = testCase.requestOverride ?? session.locateApi(apiLocator)?.api.contract.request;
        if (!request) throw new Error(`未找到接口: ${JSON.stringify(locator)}`);
        const knownCredentialLiterals = await credentials.getKnownCredentialLiterals(apiLocator, request, draftWriteContext);
        return await session.saveCase(locator, testCase, expectedRevision, knownCredentialLiterals, draftWriteContext, fields) satisfies IpcResultMap[typeof IpcChannel.CaseSave];
      }
      case IpcChannel.CaseDraftSave: {
        const [locator, testCase, expectedRevision, deletedCases, fields] = a as [CaseLocator, ApiTestCase, string, Array<{ caseId: string; scope: string }>, DebugFieldState[]];
        if (fields.some((field) => field.needsInput)) throw new Error("请先补齐调试恢复字段，再保存用例草稿。");
        const draftWriteContext = session.captureDraftWriteContext();
        const apiLocator: ApiLocator = {
          workspaceId: locator.workspaceId,
          groupId: locator.groupId,
          projectId: locator.projectId,
          collectionId: locator.collectionId,
          folderIds: [...locator.folderIds],
          apiId: locator.apiId,
        };
        const request = testCase.requestOverride ?? session.locateApi(apiLocator)?.api.contract.request;
        if (!request) throw new Error(`未找到接口: ${JSON.stringify(locator)}`);
        const knownCredentialLiterals = await credentials.getKnownCredentialLiterals(apiLocator, request, draftWriteContext);
        return await session.saveDraftCase(locator, testCase, expectedRevision, deletedCases, knownCredentialLiterals, draftWriteContext, fields) satisfies IpcResultMap[typeof IpcChannel.CaseDraftSave];
      }
      case IpcChannel.CaseDelete:
        await session.deleteCase(a[0] as CaseLocator);
        return undefined satisfies IpcResultMap[typeof IpcChannel.CaseDelete];
      case IpcChannel.ModelList:
        return session.listModels(a[0] as ProjectLocator) satisfies IpcResultMap[typeof IpcChannel.ModelList];
      case IpcChannel.ModelGet: {
        const location = session.locateModel(a[0] as ModelLocator);
        if (!location) throw new Error(`Model not found at complete locator: ${JSON.stringify(a[0])}`);
        return location.model satisfies IpcResultMap[typeof IpcChannel.ModelGet];
      }
      case IpcChannel.ModelCreate:
        return await session.createModel(a[0] as ProjectLocator, a[1] as Parameters<Session["createModel"]>[1]) satisfies IpcResultMap[typeof IpcChannel.ModelCreate];
      case IpcChannel.ModelSave:
        return await session.saveModel(a[0] as ModelLocator, a[1] as ModelAsset) satisfies IpcResultMap[typeof IpcChannel.ModelSave];
      case IpcChannel.ComponentList:
        return session.listComponents(a[0] as ProjectLocator) satisfies IpcResultMap[typeof IpcChannel.ComponentList];
      case IpcChannel.ComponentGet: {
        const location = session.locateComponent(a[0] as ComponentLocator);
        if (!location) throw new Error(`Component not found at complete locator: ${JSON.stringify(a[0])}`);
        return location.component satisfies IpcResultMap[typeof IpcChannel.ComponentGet];
      }
      case IpcChannel.ComponentCreate:
        return await session.createComponent(a[0] as ProjectLocator, a[1] as Parameters<Session["createComponent"]>[1]) satisfies IpcResultMap[typeof IpcChannel.ComponentCreate];
      case IpcChannel.ComponentSave:
        return await session.saveComponent(a[0] as ComponentLocator, a[1] as ComponentAsset) satisfies IpcResultMap[typeof IpcChannel.ComponentSave];
      case IpcChannel.AssetReferences:
        return session.referencesTo(a[0] as ProjectLocator, a[1] as string) satisfies IpcResultMap[typeof IpcChannel.AssetReferences];
      case IpcChannel.DebugSend: {
        const result = await sendDebug(session, a[0] as DebugInput, () => pluginsRuntime.registry(), credentials, debug, requireOwner(owner));
        return result satisfies DebugOutput;
      }
      case IpcChannel.DebugStart:
        return debug.start(requireOwner(owner), a[0]) satisfies IpcResultMap[typeof IpcChannel.DebugStart];
      case IpcChannel.DebugWait:
        return await debug.wait(requireOwner(owner), (a[0] as { runId: string }).runId) satisfies IpcResultMap[typeof IpcChannel.DebugWait];
      case IpcChannel.DebugCancel:
        return debug.cancel(requireOwner(owner), (a[0] as { runId: string }).runId) satisfies IpcResultMap[typeof IpcChannel.DebugCancel];
      case IpcChannel.DebugCookiesList:
        return await debug.listCookies(a[0]) satisfies IpcResultMap[typeof IpcChannel.DebugCookiesList];
      case IpcChannel.DebugCookiesClear:
        await debug.clearCookies(a[0]);
        return undefined satisfies IpcResultMap[typeof IpcChannel.DebugCookiesClear];
      case IpcChannel.DebugPickFile:
        return await pickDebugFile() satisfies IpcResultMap[typeof IpcChannel.DebugPickFile];
      case IpcChannel.DebugSaveProjected:
        return await saveFile(a[0] as string, a[1] as string) satisfies IpcResultMap[typeof IpcChannel.DebugSaveProjected];
      case IpcChannel.DebugHistoryList:
        return await requireDebugHistory().list(a[0] as Parameters<ReturnType<typeof createDesktopDebugHistoryStore>["list"]>[0]) satisfies IpcResultMap[typeof IpcChannel.DebugHistoryList];
      case IpcChannel.DebugHistoryGet:
        return await requireDebugHistory().get(a[0] as string) satisfies IpcResultMap[typeof IpcChannel.DebugHistoryGet];
      case IpcChannel.DebugHistoryDelete:
        return await requireDebugHistory().delete(a[0] as string) satisfies IpcResultMap[typeof IpcChannel.DebugHistoryDelete];
      case IpcChannel.DebugHistoryCleanup:
        return await requireDebugHistory().cleanup() satisfies IpcResultMap[typeof IpcChannel.DebugHistoryCleanup];
      case IpcChannel.DebugHistoryPreferencesGet:
        return await requireDebugHistory().getPreferences() satisfies IpcResultMap[typeof IpcChannel.DebugHistoryPreferencesGet];
      case IpcChannel.DebugHistoryPreferencesUpdate:
        return await requireDebugHistory().updatePreferences(a[0]) satisfies IpcResultMap[typeof IpcChannel.DebugHistoryPreferencesUpdate];
      case IpcChannel.DebugHistoryRestore: {
        const { historyId, exchangeOrder } = a[0] as { historyId: string; exchangeOrder: number };
        const record = await requireHistoryRecord(historyId);
        const invocation = restoreDebugHistoryExchange(record, exchangeOrder);
        const root = session.root;
        const currentOwnerIdentity = record.result.replay.mode === "case"
          ? record.result.replay.case
          : record.result.replay.locator;
        let sourceAvailable = false;
        if (root && currentOwnerIdentity) {
          const ownerKey = createDebugHistoryOwnerKey(realpathSync(root), currentOwnerIdentity);
          const owned = await requireDebugHistory().getOwned(historyId, ownerKey);
          const location = session.locateApi(invocation.locator);
          sourceAvailable = owned.record !== null && location !== undefined;
          const sourceChanged = !sourceAvailable || (location !== undefined
            && createProjectSnapshot(location.project).definitionRevision !== record.result.sourceProjectRevision);
          return { invocation, sourceChanged, sourceAvailable } satisfies IpcResultMap[typeof IpcChannel.DebugHistoryRestore];
        }
        const result: DebugHistoryRestoreResult = { invocation, sourceChanged: true, sourceAvailable: false };
        return result satisfies IpcResultMap[typeof IpcChannel.DebugHistoryRestore];
      }
      case IpcChannel.DebugHistoryReplay: {
        const historyId = a[0] as string;
        const record = await requireHistoryRecord(historyId);
        const invocation = createDebugReplayInvocation(record);
        await requireHistoryOwner(historyId, ownerKeyForInvocation(invocation));
        const started = await debug.start(requireOwner(owner), invocation);
        const result: DebugHistoryReplayResult = { ...started, locator: invocation.locator };
        return result satisfies IpcResultMap[typeof IpcChannel.DebugHistoryReplay];
      }
      // 运行频道（任务 6）：run:collection 走完整 Runner 并固定落盘 .apicc/runs；
      // runs:list/get 读历史（目录不存在/文件损坏已在 runs.ts 侧降级为 []/null）。
      // registry 注入插件运行时（M7-B 任务 2）：插件协议/认证/断言/脚本在运行频道可选。
      case IpcChannel.RunCollection: {
        const run = await runCollection(session, a[0] as RunCollectionInput, () => pluginsRuntime.registry(), credentials);
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
      // 探测清单（M7-B 任务 2）：显式注入优先（测试替身），否则插件运行时 registry
      // （内置 + 插件贡献导入器参与探测——T1 去留口径的 T2 落地）。
      case IpcChannel.ImportPreview: {
        const input = a[0] as ImportPreviewInput;
        const importers = injectedImporters ?? (await pluginsRuntime.registry()).listImporters();
        const importer = importers.find((i) => i.detect(input.fileName, input.content));
        if (!importer) throw new Error("无法识别的导入格式");
        const { project, warnings } = importer.parse(input.content);
        return { importerName: importer.name, project, warnings } satisfies IpcResultMap[typeof IpcChannel.ImportPreview];
      }
      case IpcChannel.ImportApply: {
        const input = a[0] as ImportApplyInput;
        // 轨二双模式：project=整包落库到所选分组；module=产物集合改名后并入目标项目
        // （baseUrl 进模块变量、不造环境）。同名并存（同名放开）。
        if (input.mode === "module") {
          await session.importModuleToProject(input.target, input.name, {
            project: input.project,
            ...(input.sourceEnvironmentName === undefined ? {} : { sourceEnvironmentName: input.sourceEnvironmentName }),
          });
        } else {
          await session.importProjectToGroup(input.target, input.name, { project: input.project });
        }
        return undefined satisfies IpcResultMap[typeof IpcChannel.ImportApply];
      }
      // 项目克隆/移动（轨二）：克隆=整项目深拷贝新 id 落回原分组；移动=换分组。
      case IpcChannel.ProjectClone: {
        return await session.cloneProject(a[0] as ProjectLocator) satisfies IpcResultMap[typeof IpcChannel.ProjectClone];
      }
      case IpcChannel.ProjectMove: {
        await session.moveProject(a[0] as ProjectLocator, a[1] as GroupLocator);
        return undefined satisfies IpcResultMap[typeof IpcChannel.ProjectMove];
      }
      // 详细设计导出（任务 8）：取接口 → core renderDesignMarkdown 渲染 → 注入的
      // saveFile（生产 = showSaveDialog + 写盘）落盘并返回路径（取消为空串）。
      case IpcChannel.DesignExport: {
        const locator = a[0] as ApiLocator;
        const loc = session.locateApi(locator);
        if (!loc) throw new Error(`未找到接口: ${JSON.stringify(locator)}`);
        const snapshot = createProjectSnapshot(loc.project);
        return await saveFile(`${loc.api.contract.metadata.name}.design.md`, renderContractMarkdown(loc.api, snapshot.context)) satisfies IpcResultMap[typeof IpcChannel.DesignExport];
      }
      // 工作流频道（M2-B 任务 1）：变更分支显式 save（session 变更操作不自动落盘，
      // 语义备忘同环境频道）；set-status 仅在迁移成功（errors 为空）时落盘。
      case IpcChannel.WfList: {
        const locator = a[0] as ProjectLocator;
        const project = session.locateProject(locator)?.project;
        if (!project) throw new Error(`Project not found at complete locator: ${JSON.stringify(locator)}`);
        return project.workflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          status: workflow.status,
          locator: { ...locator, workflowId: workflow.id },
        } satisfies WorkflowSummary)) satisfies IpcResultMap[typeof IpcChannel.WfList];
      }
      case IpcChannel.WfGet: {
        const locator = a[0] as WorkflowLocator;
        const loc = session.locateWorkflow(locator);
        if (!loc) throw new Error(`Workflow not found at complete locator: ${JSON.stringify(locator)}`);
        return { workflow: loc.workflow, locator } satisfies IpcResultMap[typeof IpcChannel.WfGet];
      }
      case IpcChannel.WfCreate: {
        const input = a[0] as WfCreateInput;
        return await session.createWorkflow(input.locator, input.name) satisfies IpcResultMap[typeof IpcChannel.WfCreate];
      }
      case IpcChannel.WfDelete:
        await session.deleteWorkflow(a[0] as WorkflowLocator);
        return undefined satisfies IpcResultMap[typeof IpcChannel.WfDelete];
      case IpcChannel.WfRename: {
        const [locator, name] = a as [WorkflowLocator, string];
        return await session.renameWorkflow(locator, name) satisfies IpcResultMap[typeof IpcChannel.WfRename];
      }
      case IpcChannel.WfSave: {
        const [locator, workflow] = a as [WorkflowLocator, Workflow];
        return await session.saveWorkflow(locator, workflow) satisfies IpcResultMap[typeof IpcChannel.WfSave];
      }
      case IpcChannel.WfSetStatus: {
        const [locator, next] = a as [WorkflowLocator, WorkflowStatus];
        return await session.setWorkflowStatus(locator, next) satisfies IpcResultMap[typeof IpcChannel.WfSetStatus];
      }
      case IpcChannel.WfImpact: {
        const input = a[0] as WfImpactInput;
        return session.workflowImpact(input) satisfies IpcResultMap[typeof IpcChannel.WfImpact];
      }
      case IpcChannel.WfRun: {
        return runWorkflow(session, a[0] as WfRunInput, () => pluginsRuntime.registry(), credentials);
      }
      // 压测频道（M2-D3 任务 1）：run 返回最终报告 + 落盘文件名；stop 返回中止后的
      // 部分报告（abort 语义见 stress.ts）。返回前报告已深拷贝（DataCloneError 防御）。
      case IpcChannel.StressRun: {
        try {
          const out = await stress.run(a[0] as StressRunInput);
          return StressRunResultSchema.parse(out) satisfies StressRunResult;
        } catch (error) {
          if (error instanceof StressSafetyError) {
            if (!error.targetOrigin) throw new Error("安全错误缺少目标 origin");
            return StressRunResultSchema.parse({
              ok: false,
              error: { code: error.code, message: error.message, ...(error.targetOrigin ? { targetOrigin: error.targetOrigin } : {}) },
            }) satisfies StressRunResult;
          }
          throw error;
        }
      }
      case IpcChannel.StressStop: {
        const out = await stress.stop();
        return out satisfies StressRunOutput;
      }
      case IpcChannel.CredentialPut:
        return await credentials.put(a[0] as CredentialPutInput) satisfies IpcResultMap[typeof IpcChannel.CredentialPut];
      case IpcChannel.CredentialRemove:
        return await credentials.remove(a[0] as CredentialRefInput) satisfies IpcResultMap[typeof IpcChannel.CredentialRemove];
      case IpcChannel.CredentialStatus:
        return await credentials.status(a[0] as CredentialRefInput) satisfies IpcResultMap[typeof IpcChannel.CredentialStatus];
      // 在线频道（M3-B 任务 1）：全部委派 online session（登录态串联/冲突出口转换在其内聚）。
      // login 出口不含 token（token 留 main 进程）；put/delete 的 409 转为 outcome 结果对象。
      case IpcChannel.OnlineRegister: {
        return requireOnline().register(a[0] as Parameters<OnlineSession["register"]>[0]);
      }
      case IpcChannel.OnlineLogin: {
        return requireOnline().login(a[0] as Parameters<OnlineSession["login"]>[0]);
      }
      case IpcChannel.OnlineAuthConfig: {
        if (!options.online) throw new Error("在线功能未配置");
        const client = options.online.createClient(a[0] as string, { onUnauthorized: () => undefined });
        return client.authConfig();
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
      // 在线工作区/迁移频道（M3-B 任务 3）：打开前 abort 活动压测（与 ws:open 同一清理链）。
      // 计划 C 任务 1 会话表化：树取回失败仅当表空才回滚（防误关
      // 其他驻留工作区；表非空时半开工作区留表，可显式激活后重试视图）。
      case IpcChannel.OnlineWorkspaceOpen: {
        stress.abortActive();
        const input = a[0] as OnlineWorkspaceOpenInput;
        const sessionOnline = requireOnline();
        const tableWasEmpty = sessionOnline.residentIds.length === 0;
        sessionOnline.openWorkspace(input);
        try {
          return await sessionOnline.getTreeView(input.workspaceId);
        } catch (e) {
          if (tableWasEmpty) sessionOnline.closeWorkspace(input.workspaceId);
          throw e;
        }
      }
      // 计划 C 任务 1 会话表化：activate 显式切换活跃驻留工作区；close 载荷可带 workspaceId
      // （出表指定工作区），无参关活跃。
      case IpcChannel.OnlineWorkspaceActivate:
        requireOnline().activateWorkspace((a[0] as { workspaceId: string }).workspaceId);
        return undefined;
      case IpcChannel.OnlineWorkspaceClose:
        requireOnline().closeWorkspace((a[0] as { workspaceId?: string } | undefined)?.workspaceId);
        return undefined;
      case IpcChannel.OnlineTreeView:
        return requireOnline().getTreeView((a[0] as { workspaceId: string }).workspaceId);
      case IpcChannel.OnlineMigrateScan:
        return { files: scanDirFiles((a[0] as { dir: string }).dir) };
      case IpcChannel.OnlineMigrateWrite: {
        const input = a[0] as { dir: string; files: Array<{ path: string; content: string }> };
        return { written: writeFiles(input.dir, input.files) };
      }
      // 迁移映射桥 + 组清单（计划 C 任务 2）：委派 online session（映射行级三态换算在渲染层编排）。
      case IpcChannel.OnlineProjectMapping:
        return requireOnline().projectMapping(a[0] as OnlineProjectMappingInput);
      case IpcChannel.OnlineGroupsList:
        return requireOnline().listGroups((a[0] as { workspaceId: string }).workspaceId);
      // AI 频道（M6-C 任务 2 真链路，规格 §2 D1/D2/D4）：save/get 只落 key（baseUrl/model
      // 由渲染层 localStorage 持久化）；出口恒 { hasKey }（key 明文永不回传渲染层，裁定②）；
      // apiKey 省略/空串 = 保持既有。suggest 委派 main/ai/suggest.ts 真链路（core provider +
      // suggestCases；key 缺失 → 可读错误指引配置对话框，且不发请求）；test-config 轻量探测。
      case IpcChannel.AiSaveConfig: {
        const input = a[0] as AiSaveConfigInput;
        if (input.apiKey) requireAi().keyStore.save(input.apiKey);
        return { hasKey: requireAi().keyStore.load() !== null } satisfies AiKeyStatus;
      }
      case IpcChannel.AiGetConfig:
        return { hasKey: requireAi().keyStore.load() !== null } satisfies AiKeyStatus;
      case IpcChannel.AiSuggest: {
        const input = a[0] as AiSuggestInput;
        return runAiSuggest(requireAi(), input, findApiByLocator);
      }
      case IpcChannel.AiTestConfig:
        return runAiTestConfig(requireAi(), a[0] as AiTestConfigInput);
      // 插件频道（M7-B 任务 2 真实现，规格 §2 D3/D5/D8）：main 经 core loadUserPlugins
      // 装载用户级清单（homeDir 注入 / loadPlugins:false 关闭通道），返回混合 loaded/failed
      // 清单 + registry 导入器枚举。出口经 structuredClone 快照化（DataCloneError 防御 +
      // memoized 状态不被渲染层改动污染）。
      case IpcChannel.PluginsList:
        return structuredClone(await pluginsRuntime.summary()) satisfies PluginsListResult;
      default:
        throw new Error(`未知频道: ${channel}`);
    }
  }

  async function handle<Channel extends IpcChannelName>(
    channel: Channel,
    event: unknown,
    ...args: HandleArgs<NoInfer<Channel>>
  ): Promise<IpcResultMap[Channel]> {
    const owner = ownerFromEvent(event);
    watchOwner(owner);
    return await dispatch(channel, args, owner) as IpcResultMap[Channel];
  }

  return { handle, pluginsRuntime };
}
