import { createHash, randomUUID } from "node:crypto";
import { createTestingController } from "./testing.js";
import { createWorkflowController } from "./workflow.js";
import { stat } from "node:fs/promises";
import { StressSafetyError, buildImportMergePlan, deduplicateImportDiagnostics, normalizeImportDiagnostics, projectAssetImportDiagnostics, findProjectApi, createProjectSnapshot, buildDocumentProjection, exportOpenapi, renderDocumentHtml, renderDocumentMarkdown, createDebugHistoryOwnerKey, createDebugReplayInvocation, restoreDebugHistoryExchange, renderContractMarkdown, resolveExecutionEnvironment, selectEffectiveCases, getSourceApiRevision, type Importer, type RunResult, type ApiAsset, type Environment, type Workflow, type WorkflowStatus, type DebugHistoryRecord, type DebugInvocation, type DebugHistoryOwnerIdentity, type ContractProject } from "@apicc/core";
import { ContractProjectSchema } from "@apicc/core/schema";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { IpcChannel, type IpcChannelName } from "../shared/channels.js";
import { StressRunResultSchema, type ApiDetail, type ContainerSaveInput, type ContainerTarget, type CreateApiFromRequestDraftInput, type DebugInput, type DebugOutput, type DebugHistoryReplayResult, type DebugHistoryRestoreResult, type DebugFileReference, type EnvCreateInput, type ImportApplyInput, type ImportApplyResult, type ImportExchangeDiagnostic, type ImportPlanInput, type ImportPlanResult, type ImportPreviewInput, type ImportPreviewResult, type ImportUndoInput, type NodeCreateInput, type NodeCreatedDTO, type OpenResult, type RunCollectionInput, type RunSummaryDTO, type StressRunInput, type StressRunOutput, type StressRunResult, type StressRunSummaryDTO, type WfCreateInput, type WfImpactInput, type WfRunInput, type ProjectGlobalSettings, type WorkflowSummary } from "../shared/types.js";
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
import { previewDesignDraft } from "./designPreview.js";
import { createMockManager } from "./mockManager.js";
import type { PluginsListResult } from "../shared/plugins/contract.js";
import { createDesktopCredentialHost, type DesktopCredentialHostOptions } from "./credentials.js";
import { createExecutionOutputBoundary } from "./executionOutput.js";
import type { CredentialPutInput, CredentialRefInput } from "../shared/credentials.js";
import type { NetworkProfilesSaveInput, NetworkSecretImportInput } from "../shared/network.js";
import type { DesignExportInput, DesignPreviewInput } from "../shared/design.js";

type Session = ReturnType<typeof createSession>;
type HistorySessionContext = Pick<ReturnType<Session["captureDraftWriteContext"]>, "root" | "generation">;
type IsUnion<Value, Whole = Value> = Value extends Whole ? ([Whole] extends [Value] ? false : true) : never;
type HandleArgs<Channel extends IpcChannelName> = IsUnion<Channel> extends true ? unknown[] : IpcArgsMap[Channel];

// IPC argument schemas and channel/result maps are centralized in shared/ipc-contract.ts.


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
   * 文件保存（design:export）：生成完毕后显示原生保存对话框并原子替换目标；取消为空串。
   */
  saveFile: (
    defaultName: string,
    content: string,
    format?: DesignExportInput["format"],
    encoding?: NonNullable<DesignExportInput["encoding"]>,
  ) => Promise<string>;
  /** The native host asks for consent only after the exporter identifies semantic loss. */
  confirmLossyExport?: (diagnostics: readonly { code: string; path: string; message: string }[]) => Promise<boolean>;
  /** User-selected file metadata; the renderer never reads this path or its bytes. */
  pickDebugFile?: () => Promise<DebugFileReference | null>;
  /** Native picker stays in main; only the selected file's SecretStore outcome crosses IPC. */
  pickNetworkSecretFile?: (locale: "zh-CN" | "en") => Promise<string | null>;
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
  type SessionContext = ReturnType<Session["captureDraftWriteContext"]>;
  type Receipt = { value: unknown; committed: boolean; beforeWorkspace: NonNullable<Session["workspace"]>; context: SessionContext; addedDefinitionFiles: string[] };
  type PreviewRecord = { project: ContractProject; importerName: string; diagnostics: ImportExchangeDiagnostic[]; sourceHash: string; context: SessionContext; environmentOptions: Map<string, string> };
  type PlanRecord = { input: ImportPlanInput; previewToken: string; sourceHash: string; context: SessionContext; result: ImportPlanResult; sourceEnvironmentName?: string; applied?: ImportApplyResult };
  type UndoRecord = {
    context: SessionContext;
    workspace: NonNullable<Session["workspace"]>;
    addedDefinitionFiles: string[];
    mockAfterUndo: { kind: "stop" | "refresh"; locator: ProjectLocator };
  };
  const importPreviews = new Map<string, PreviewRecord>();
  const importPlans = new Map<string, PlanRecord>();
  const importUndos = new Map<string, UndoRecord>();
  const currentImportContext = (): SessionContext => session.captureDraftWriteContext();
  const assertImportContext = (expected: SessionContext): void => {
    const current = currentImportContext();
    if (current.root !== expected.root || current.revision !== expected.revision || current.generation !== expected.generation) {
      throw new Error("导入预览已过期：工作区上下文已更改，请重新预览。");
    }
  };
  const redactImportText = (value: string): string => value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var|etc)\/)[^\s"'<>]*/g, "[local path]");
  const importTree = (project: ContractProject): ImportPreviewResult["tree"] => project.collections.map((collection) => {
    const apis: ImportPreviewResult["tree"][number]["apis"] = [];
    const visit = (folder: ContractProject["collections"][number]["folders"][number], prefix: string): void => {
      const path = `${prefix}/${folder.name}`;
      for (const asset of folder.apis) {
        const request = asset.contract.request;
        apis.push({ id: asset.contract.id, name: redactImportText(asset.contract.metadata.name), method: request.protocol === "websocket" ? "WS" : request.method, path: redactImportText(request.path) });
      }
      folder.folders.forEach((child) => visit(child, path));
    };
    for (const asset of collection.apis) {
      const request = asset.contract.request;
      apis.push({ id: asset.contract.id, name: redactImportText(asset.contract.metadata.name), method: request.protocol === "websocket" ? "WS" : request.method, path: redactImportText(request.path) });
    }
    collection.folders.forEach((folder) => visit(folder, collection.name));
    return { id: collection.id, name: redactImportText(collection.name), apis };
  });
  const confirmLossyExport = options.confirmLossyExport ?? (async () => false);
  const pickDebugFile = options.pickDebugFile ?? (async (): Promise<DebugFileReference | null> => {
    const { dialog } = await import("electron");
    const choice = await dialog.showOpenDialog({ properties: ["openFile"] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const path = choice.filePaths[0];
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("所选路径不是普通文件");
    return { path, name: basename(path), size: metadata.size };
  });
  const pickNetworkSecretFile = options.pickNetworkSecretFile ?? (async (locale: "zh-CN" | "en"): Promise<string | null> => {
    const { dialog } = await import("electron");
    const choice = await dialog.showOpenDialog({
      title: locale === "zh-CN" ? "导入网络秘密文件" : "Import network secret",
      properties: ["openFile"],
      filters: [{ name: locale === "zh-CN" ? "证书或密钥文件" : "Certificate or key material", extensions: ["pem", "key", "crt", "cer", "txt"] }],
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const path = choice.filePaths[0];
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("The selected path is not a regular file.");
    return path;
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
  const mockManager = createMockManager({ session });
  async function refreshSavedMock(locator: ProjectLocator, context?: { root: string; generation: number }): Promise<void> {
    try {
      if (context) {
        const current = session.captureDraftWriteContext();
        if (current.root !== context.root || current.generation !== context.generation) return;
      }
      await mockManager.saved(locator, context);
    } catch {
      // A save has already committed. Context changes and Mock diagnostics must not turn it into a reported save failure.
    }
  }
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
  const testing = createTestingController(session, () => pluginsRuntime.registry(), credentials);
  const workflowRuns = createWorkflowController(session, () => pluginsRuntime.registry(), credentials);
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
    const cleanup = () => {
      debug.clearOwner(owner);
      testing.clearOwner(owner);
      workflowRuns.clearOwner(owner);
      credentials.closeOAuthOwner(owner);
    };
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

  function captureHistorySessionContext(): HistorySessionContext | undefined {
    try {
      const context = session.captureDraftWriteContext();
      return { root: context.root, generation: context.generation };
    } catch {
      return undefined;
    }
  }

  function assertHistorySessionContext(context: HistorySessionContext): void {
    const current = session.captureDraftWriteContext();
    if (current.root !== context.root || current.generation !== context.generation) {
      throw new Error("工作区上下文已更改，拒绝继续读取或重放调试历史。");
    }
  }

  function sameProject(left: ProjectLocator, right: ProjectLocator): boolean {
    return left.workspaceId === right.workspaceId
      && left.groupId === right.groupId
      && left.projectId === right.projectId;
  }

  function assertHistoryProjectContext(
    record: DebugHistoryRecord,
    invocation: DebugInvocation,
    project: ProjectLocator | undefined,
  ): void {
    if (invocation.mode === "free") {
      const recordedProject = record.formatVersion === 2 && record.result.source.sourceKind === "free"
        ? record.result.source.project
        : undefined;
      if (!project) throw new Error("Free 请求历史需要当前选中的项目上下文。");
      if (!recordedProject || !sameProject(project, recordedProject) || !sameProject(project, invocation.project)) {
        throw new Error("所选项目与 Free 请求历史来源不匹配，拒绝恢复或重放。");
      }
      return;
    }

    if (project) {
      const recordedProject = invocation.mode === "case" ? invocation.case : invocation.locator;
      if (!sameProject(project, recordedProject)) {
        throw new Error("所选项目与资产调试历史来源不匹配，拒绝恢复或重放。");
      }
    }
  }

  function ownerKeyForInvocation(invocation: DebugInvocation, root = session.root): string {
    if (!root) throw new Error("尚未打开工作区");
    const identity: DebugHistoryOwnerIdentity = invocation.mode === "free"
      ? { sourceKind: "free", project: invocation.project, draftId: invocation.draftId }
      : invocation.mode === "case"
        ? { sourceKind: "asset", mode: "case", case: invocation.case }
        : { sourceKind: "asset", mode: "request", locator: invocation.locator };
    return createDebugHistoryOwnerKey(realpathSync(root), identity);
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
      case IpcChannel.EvidenceInspect: return testing.inspectEvidence(a[0] as Parameters<typeof testing.inspectEvidence>[0]);
      case IpcChannel.EvidenceRerun: return testing.rerunEvidence(a[0] as Parameters<typeof testing.rerunEvidence>[0], requireOwner(owner));
      case IpcChannel.EvidenceCancel: return testing.cancelEvidence(a[0] as Parameters<typeof testing.cancelEvidence>[0], requireOwner(owner));
      case IpcChannel.TestingList: return testing.listTestingAssets(a[0] as Parameters<typeof testing.listTestingAssets>[0]);
      case IpcChannel.AssertionOperators: return testing.assertionOperators();
      case IpcChannel.DatasetSave: return testing.saveDataset(a[0] as Parameters<typeof testing.saveDataset>[0]);
      case IpcChannel.SuiteSave: return testing.saveSuite(a[0] as Parameters<typeof testing.saveSuite>[0]);
      case IpcChannel.TestingDelete: return testing.deleteTestingAsset(a[0] as Parameters<typeof testing.deleteTestingAsset>[0]);
      case IpcChannel.DatasetImport: return testing.importDataset(a[0] as Parameters<typeof testing.importDataset>[0]);
      case IpcChannel.DatasetExport: return testing.exportDataset(a[0] as Parameters<typeof testing.exportDataset>[0]);
      case IpcChannel.SuitePreview: return testing.previewSuite(a[0] as Parameters<typeof testing.previewSuite>[0]);
      case IpcChannel.SuiteRun: return testing.runSuite(a[0] as Parameters<typeof testing.runSuite>[0], requireOwner(owner));
      case IpcChannel.SuiteCancel: return testing.cancelSuite(a[0] as Parameters<typeof testing.cancelSuite>[0], requireOwner(owner));
      case IpcChannel.WsOpen: {
        workflowRuns.abortActive();
        testing.abortActive();
        // 工作区切换清理点（M2-D3 任务 1）：活动压测先 abort，部分报告由其收尾异步落回原工作区。
        // 计划 C 任务 2：裁定 E 互斥退役——本地打开不再关闭在线会话（本地 1 + 在线 N 并存驻留）。
        stress.abortActive();
        const r = await mockManager.transitionWorkspace(async () => {
          if (owner) debug.clearOwner(owner);
          return session.open(a[0] as string);
        });
        return r satisfies OpenResult;
      }
      case IpcChannel.WsCreate: {
        workflowRuns.abortActive();
        testing.abortActive();
        // 同上：压测清理链保留；在线会话原样驻留（并存，互斥退役）。
        stress.abortActive();
        const r = await mockManager.transitionWorkspace(async () => {
          if (owner) debug.clearOwner(owner);
          return session.create(a[0] as string, a[1] as string);
        });
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
        const node = a[0] as Parameters<Session["deleteNode"]>[0];
        const context = session.captureDraftWriteContext();
        const workspace = session.workspace;
        const removedProjects = node.kind === "group"
          ? workspace?.groups.find((group) => group.id === node.locator.groupId)?.projects.map((project) => ({
            workspaceId: node.locator.workspaceId,
            groupId: node.locator.groupId,
            projectId: project.id,
          })) ?? []
          : node.kind === "project" ? [node.locator] : [];
        const affectedProject = node.kind === "project" || node.kind === "group"
          ? null
          : {
            workspaceId: node.locator.workspaceId,
            groupId: node.locator.groupId,
            projectId: node.locator.projectId,
          };
        await session.deleteNode(node);
        if (removedProjects.length) {
          await Promise.all(removedProjects.map((locator) => mockManager.stopProject(context.root, locator)));
        } else if (affectedProject) {
          await refreshSavedMock(affectedProject, context);
        }
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
      case IpcChannel.ApiCreateFromRequestDraft: {
        const input = a[0] as CreateApiFromRequestDraftInput;
        if (input.fields.some((field) => field.needsInput)) throw new Error("请先补齐调试恢复字段，再保存请求草稿。");
        const draftWriteContext = session.captureDraftWriteContext();
        const knownCredentialLiterals = await credentials.getKnownCredentialLiteralsForProject(input.project, input.request, draftWriteContext);
        const result = await session.createApiFromRequestDraft(input, knownCredentialLiterals, draftWriteContext);
        await refreshSavedMock(input.project, draftWriteContext);
        return result satisfies IpcResultMap[typeof IpcChannel.ApiCreateFromRequestDraft];
      }
      case IpcChannel.DebugProjectContext: {
        requireOwner(owner);
        const locator = a[0] as ProjectLocator;
        const location = session.locateProject(locator);
        if (!location) throw new Error(`未找到项目: ${JSON.stringify(locator)}`);
        return {
          project: { ...locator },
          sourceProjectRevision: createProjectSnapshot(location.project).definitionRevision,
          envs: location.project.environments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            locator: { ...locator, environmentId: environment.id },
          })),
        } satisfies IpcResultMap[typeof IpcChannel.DebugProjectContext];
      }
      case IpcChannel.ApiSave: {
        const [locator, api, expectedRevision] = a as [ApiLocator, ApiAsset, string];
        const draftWriteContext = session.captureDraftWriteContext();
        const candidateRequests = [api.contract.request, ...api.cases.map((testCase) => testCase.requestOverride ?? api.contract.request)];
        const knownCredentialLiterals = await credentials.getKnownCredentialLiterals(locator, candidateRequests, draftWriteContext);
        const result = await session.saveApi(locator, api, knownCredentialLiterals, draftWriteContext, expectedRevision);
        await refreshSavedMock({ workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId }, draftWriteContext);
        return result satisfies IpcResultMap[typeof IpcChannel.ApiSave];
      }
      case IpcChannel.ApiRequestDraftSave: {
        const [locator, request, expectedRevision, fields] = a as [ApiLocator, import("@apicc/core").ApiRequest, string, DebugFieldState[]];
        if (fields.some((field) => field.needsInput)) throw new Error("请先补齐调试恢复字段，再保存请求草稿。");
        const draftWriteContext = session.captureDraftWriteContext();
        const knownCredentialLiterals = await credentials.getKnownCredentialLiterals(locator, request, draftWriteContext);
        const result = await session.saveRequestDraft(locator, request, expectedRevision, fields, knownCredentialLiterals, draftWriteContext);
        await refreshSavedMock({ workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId }, draftWriteContext);
        return result satisfies IpcResultMap[typeof IpcChannel.ApiRequestDraftSave];
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
      case IpcChannel.CaseDelete: {
        await session.deleteCase(a[0] as CaseLocator);
        return undefined satisfies IpcResultMap[typeof IpcChannel.CaseDelete];
      }
      case IpcChannel.ModelList:
        return session.listModels(a[0] as ProjectLocator) satisfies IpcResultMap[typeof IpcChannel.ModelList];
      case IpcChannel.ModelGet: {
        const location = session.locateModel(a[0] as ModelLocator);
        if (!location) throw new Error(`Model not found at complete locator: ${JSON.stringify(a[0])}`);
        return location.model satisfies IpcResultMap[typeof IpcChannel.ModelGet];
      }
      case IpcChannel.ModelCreate: {
        const locator = a[0] as ProjectLocator;
        const context = session.captureDraftWriteContext();
        const result = await session.createModel(locator, a[1] as Parameters<Session["createModel"]>[1]);
        await refreshSavedMock(locator, context);
        return result satisfies IpcResultMap[typeof IpcChannel.ModelCreate];
      }
      case IpcChannel.ModelSave:
      {
        const locator = a[0] as ModelLocator;
        const context = session.captureDraftWriteContext();
        const result = await session.saveModel(locator, a[1] as ModelAsset);
        await refreshSavedMock({ workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId }, context);
        return result satisfies IpcResultMap[typeof IpcChannel.ModelSave];
      }
      case IpcChannel.ComponentList:
        return session.listComponents(a[0] as ProjectLocator) satisfies IpcResultMap[typeof IpcChannel.ComponentList];
      case IpcChannel.ComponentGet: {
        const location = session.locateComponent(a[0] as ComponentLocator);
        if (!location) throw new Error(`Component not found at complete locator: ${JSON.stringify(a[0])}`);
        return location.component satisfies IpcResultMap[typeof IpcChannel.ComponentGet];
      }
      case IpcChannel.ComponentCreate: {
        const locator = a[0] as ProjectLocator;
        const context = session.captureDraftWriteContext();
        const result = await session.createComponent(locator, a[1] as Parameters<Session["createComponent"]>[1]);
        await refreshSavedMock(locator, context);
        return result satisfies IpcResultMap[typeof IpcChannel.ComponentCreate];
      }
      case IpcChannel.ComponentSave:
      {
        const locator = a[0] as ComponentLocator;
        const context = session.captureDraftWriteContext();
        const result = await session.saveComponent(locator, a[1] as ComponentAsset);
        await refreshSavedMock({ workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId }, context);
        return result satisfies IpcResultMap[typeof IpcChannel.ComponentSave];
      }
      case IpcChannel.MockGet:
        return mockManager.get(a[0] as ProjectLocator) satisfies IpcResultMap[typeof IpcChannel.MockGet];
      case IpcChannel.MockConfigSave: {
        const input = a[0] as import("../shared/mock.js").MockConfigSaveInput;
        const context = session.captureDraftWriteContext();
        await session.saveMockConfig(input.locator, input.config, input.sourceProjectRevision, context);
        await refreshSavedMock(input.locator, context);
        return mockManager.get(input.locator) satisfies IpcResultMap[typeof IpcChannel.MockConfigSave];
      }
      case IpcChannel.MockStart: {
        const input = a[0] as import("../shared/mock.js").MockStartInput;
        return await mockManager.start(input.locator, input.port ?? 0, input.sourceProjectRevision) satisfies IpcResultMap[typeof IpcChannel.MockStart];
      }
      case IpcChannel.MockStop: {
        const input = a[0] as import("../shared/mock.js").MockControlInput;
        return await mockManager.stop(input.locator) satisfies IpcResultMap[typeof IpcChannel.MockStop];
      }
      case IpcChannel.MockReload: {
        const input = a[0] as import("../shared/mock.js").MockControlInput;
        return await mockManager.reload(input.locator, input.sourceProjectRevision) satisfies IpcResultMap[typeof IpcChannel.MockReload];
      }
      case IpcChannel.MockProjectClose: {
        const input = a[0] as import("../shared/mock.js").MockProjectCloseInput;
        await mockManager.stopProject(input.root, input.locator);
        return undefined satisfies IpcResultMap[typeof IpcChannel.MockProjectClose];
      }
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
        const { historyId, exchangeOrder, project: callerProject } = a[0] as {
          historyId: string;
          exchangeOrder: number;
          project?: ProjectLocator;
        };
        const historyContext = captureHistorySessionContext();
        const record = await requireHistoryRecord(historyId);
        if (historyContext) assertHistorySessionContext(historyContext);
        const invocation = restoreDebugHistoryExchange(record, exchangeOrder);
        assertHistoryProjectContext(record, invocation, callerProject);
        const root = historyContext?.root;
        const currentOwnerIdentity: DebugHistoryOwnerIdentity | undefined = record.formatVersion === 1
          ? record.result.mode === "case" && record.result.replay.mode === "case" && record.result.replay.case
            ? { sourceKind: "asset", mode: "case", case: record.result.replay.case }
            : record.result.replay.mode === "request" && record.result.replay.locator
              ? { sourceKind: "asset", mode: "request", locator: record.result.replay.locator }
              : undefined
          : record.result.source.sourceKind === "free"
            ? { sourceKind: "free", project: record.result.source.project, draftId: record.result.source.draftId }
            : record.result.source.sourceKind === "asset"
              ? record.result.mode === "case" && record.result.replay.mode === "case" && record.result.replay.case
                ? { sourceKind: "asset", mode: "case", case: record.result.replay.case }
                : record.result.replay.mode === "request" && record.result.replay.locator
                  ? { sourceKind: "asset", mode: "request", locator: record.result.replay.locator }
                  : undefined
              : undefined;
        let sourceAvailable = false;
        if (root && currentOwnerIdentity) {
          const ownerKey = createDebugHistoryOwnerKey(realpathSync(root), currentOwnerIdentity);
          const owned = await requireDebugHistory().getOwned(historyId, ownerKey);
          if (historyContext) assertHistorySessionContext(historyContext);
          const project = invocation.mode === "free"
            ? session.locateProject(callerProject!)?.project
            : session.locateApi(invocation.locator)?.project;
          sourceAvailable = owned.record !== null && project !== undefined;
          const sourceChanged = !sourceAvailable || (project !== undefined
            && createProjectSnapshot(project).definitionRevision !== record.result.sourceProjectRevision);
          return { invocation, sourceChanged, sourceAvailable } satisfies IpcResultMap[typeof IpcChannel.DebugHistoryRestore];
        }
        const result: DebugHistoryRestoreResult = { invocation, sourceChanged: true, sourceAvailable: false };
        return result satisfies IpcResultMap[typeof IpcChannel.DebugHistoryRestore];
      }
      case IpcChannel.DebugHistoryReplay: {
        const input = a[0] as string | { historyId: string; project: ProjectLocator };
        const historyId = typeof input === "string" ? input : input.historyId;
        const callerProject = typeof input === "string" ? undefined : input.project;
        const historyContext = captureHistorySessionContext();
        if (!historyContext) throw new Error("尚未打开工作区，不能重放调试历史。");
        const record = await requireHistoryRecord(historyId);
        assertHistorySessionContext(historyContext);
        const invocation = createDebugReplayInvocation(record);
        assertHistoryProjectContext(record, invocation, callerProject);
        if (invocation.mode === "free" && !session.locateProject(callerProject!)?.project) {
          throw new Error("Free 请求历史来源项目已不存在，不能重放。");
        }
        await requireHistoryOwner(historyId, ownerKeyForInvocation(invocation, historyContext.root));
        assertHistorySessionContext(historyContext);
        const started = await debug.start(requireOwner(owner), invocation);
        const result: DebugHistoryReplayResult = invocation.mode === "free"
          ? { ...started, sourceKind: "free", project: invocation.project, draftId: invocation.draftId }
          : { ...started, sourceKind: "asset", locator: invocation.locator };
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
      // Import payloads stay in this host closure; renderer only receives opaque preview/plan tokens.
      case IpcChannel.ImportPreview: {
        const input = a[0] as ImportPreviewInput;
        const importers = injectedImporters ?? (await pluginsRuntime.registry()).listImporters();
        const importer = importers.find((i) => i.detect(input.fileName, input.content));
        if (!importer) throw new Error("无法识别的导入格式");
        const parsed = importer.parse(input.content);
        const project = ContractProjectSchema.parse(parsed.project);
        const token = randomUUID();
        const context = currentImportContext();
        const diagnostics = deduplicateImportDiagnostics([
          ...normalizeImportDiagnostics(parsed),
          ...projectAssetImportDiagnostics(project),
        ]);
        const sourceHash = createHash("sha256").update(input.fileName).update("\0").update(input.content).digest("hex");
        const environmentOptions = new Map<string, string>();
        const publicEnvironments = project.environments.map((environment) => {
          const optionToken = randomUUID();
          environmentOptions.set(optionToken, environment.name);
          return { optionToken, label: redactImportText(environment.name) };
        });
        importPreviews.set(token, { project, importerName: importer.name, diagnostics, sourceHash, context, environmentOptions });
        while (importPreviews.size > 12) importPreviews.delete(importPreviews.keys().next().value as string);
        return {
          token,
          importerName: importer.name,
          summary: {
            projectName: redactImportText(project.name),
            collections: project.collections.length,
            apis: importTree(project).reduce((count, collection) => count + collection.apis.length, 0),
            environments: publicEnvironments,
          },
          tree: importTree(project),
          diagnostics,
        } satisfies IpcResultMap[typeof IpcChannel.ImportPreview];
      }
      case IpcChannel.ImportPlan: {
        const input = a[0] as ImportPlanInput;
        const preview = importPreviews.get(input.previewToken);
        if (!preview) throw new Error("导入预览令牌无效或已过期，请重新预览。");
        assertImportContext(preview.context);
        let sourceEnvironmentName: string | undefined;
        if (input.mode === "module" && input.sourceEnvironmentOptionToken !== undefined) {
          sourceEnvironmentName = preview.environmentOptions.get(input.sourceEnvironmentOptionToken);
          if (sourceEnvironmentName === undefined) throw new Error("来源环境选项无效，请重新预览并选择来源环境。");
        }
        let summary: ImportPlanResult["summary"] = { added: 0, overwritten: 0, skipped: 0 };
        let entries: ImportPlanResult["entries"] = [];
        let diagnostics = [...preview.diagnostics];
        let cancelled = false;
        if (input.mode === "project") {
          if (!session.workspace?.groups.some((group) => group.id === input.target.groupId)) throw new Error("目标分组不属于当前工作区。");
          summary = { added: 1, overwritten: 0, skipped: 0 };
        } else if (input.mode === "module") {
          const target = session.locateProject(input.target);
          if (!target) throw new Error("导入目标项目不存在。");
          entries = importTree(preview.project).flatMap((collection) => collection.apis.map((api) => ({
            sourceApiId: api.id, sourceName: api.name, sourcePath: collection.name, method: api.method, path: api.path,
            status: "added" as const, targetApiIds: [],
          })));
          summary = { added: entries.length, overwritten: 0, skipped: 0 };
        } else {
          const target = session.locateCollection(input.target);
          if (!target) throw new Error("导入目标模块不存在。");
          const plan = buildImportMergePlan(target.project, preview.project, {
            targetCollectionId: input.target.collectionId,
            sourceCollectionIds: input.sourceCollectionIds,
            decisions: input.decisions,
          });
          summary = plan.summary;
          entries = plan.entries.map((entry) => ({
            ...entry,
            sourceName: redactImportText(entry.sourceName),
            sourcePath: redactImportText(entry.sourcePath),
            path: redactImportText(entry.path),
            ...(entry.targetName === undefined ? {} : { targetName: redactImportText(entry.targetName) }),
          }));
          diagnostics = deduplicateImportDiagnostics([
            ...diagnostics,
            ...normalizeImportDiagnostics({ diagnostics: plan.diagnostics }),
          ]);
          cancelled = plan.cancelled;
        }
        const token = randomUUID();
        const result: ImportPlanResult = { token, mode: input.mode, summary, entries, diagnostics, cancelled };
        importPlans.set(token, {
          input: structuredClone(input), previewToken: input.previewToken, sourceHash: preview.sourceHash, context: preview.context, result,
          ...(sourceEnvironmentName === undefined ? {} : { sourceEnvironmentName }),
        });
        while (importPlans.size > 20) importPlans.delete(importPlans.keys().next().value as string);
        return result satisfies IpcResultMap[typeof IpcChannel.ImportPlan];
      }
      case IpcChannel.ImportApply: {
        const input = a[0] as ImportApplyInput;
        const plan = importPlans.get(input.planToken);
        if (!plan) throw new Error("导入计划令牌无效或已过期，请重新预览。");
        if (plan.applied) return plan.applied;
        assertImportContext(plan.context);
        const preview = importPreviews.get(plan.previewToken);
        if (!preview || preview.sourceHash !== plan.sourceHash) throw new Error("导入来源摘要已失效，请重新预览。");
        if (plan.result.diagnostics.some((item) => item.severity === "error")) throw new Error("导入计划包含结构或引用错误，不能应用。");
        if (plan.result.diagnostics.some((item) => item.lossy) && !input.allowLossy) throw new Error("导入包含语义损失；请显式确认后再应用。");
        if (plan.result.cancelled) {
          const cancelled: ImportApplyResult = { committed: false, summary: plan.result.summary };
          plan.applied = cancelled;
          return cancelled;
        }

        let receipt: Receipt;
        let refreshLocator: ProjectLocator;
        const source = preview.project;
        if (plan.input.mode === "project") {
          receipt = await session.importProjectToGroupTransaction(plan.context, plan.input.target, plan.input.name, { project: source });
          refreshLocator = { ...plan.input.target, projectId: (receipt.value as ContractProject).id };
        } else if (plan.input.mode === "module") {
          receipt = await session.importModuleToProjectTransaction(plan.context, plan.input.target, plan.input.name, {
            project: source,
            ...(plan.sourceEnvironmentName === undefined ? {} : { sourceEnvironmentName: plan.sourceEnvironmentName }),
          });
          refreshLocator = { ...plan.input.target };
        } else {
          const decisions = { targetCollectionId: plan.input.target.collectionId, sourceCollectionIds: plan.input.sourceCollectionIds, decisions: plan.input.decisions };
          receipt = await session.mergeImportIntoCollectionTransaction(plan.context, plan.input.target, source, decisions);
          refreshLocator = { workspaceId: plan.input.target.workspaceId, groupId: plan.input.target.groupId, projectId: plan.input.target.projectId };
        }
        const applied: ImportApplyResult = {
          committed: receipt.committed,
          ...(receipt.committed ? { undoToken: randomUUID() } : {}),
          summary: plan.result.summary,
        };
        if (receipt.committed && applied.undoToken) {
          importUndos.set(applied.undoToken, {
            context: receipt.context,
            workspace: receipt.beforeWorkspace,
            addedDefinitionFiles: receipt.addedDefinitionFiles,
            mockAfterUndo: { kind: plan.input.mode === "project" ? "stop" : "refresh", locator: refreshLocator },
          });
          await refreshSavedMock(refreshLocator, { root: receipt.context.root, generation: receipt.context.generation });
        }
        plan.applied = applied;
        return applied satisfies IpcResultMap[typeof IpcChannel.ImportApply];
      }
      case IpcChannel.ImportUndo: {
        const input = a[0] as ImportUndoInput;
        const undo = importUndos.get(input.undoToken);
        if (!undo) throw new Error("撤销句柄无效或已使用；工作区可能已更改或应用已重启。");
        await session.restoreImportUndo(undo.context, undo.workspace, undo.addedDefinitionFiles);
        importUndos.delete(input.undoToken);
        try {
          if (undo.mockAfterUndo.kind === "stop") {
            await mockManager.stopProject(undo.context.root, undo.mockAfterUndo.locator);
          } else {
            await refreshSavedMock(undo.mockAfterUndo.locator, { root: undo.context.root, generation: undo.context.generation });
          }
        } catch {
          // The workspace restore is already committed and the one-use receipt is consumed.
        }
        return undefined satisfies IpcResultMap[typeof IpcChannel.ImportUndo];
      }
      // 项目克隆/移动（轨二）：克隆=整项目深拷贝新 id 落回原分组；移动=换分组。
      case IpcChannel.ProjectClone: {
        return await session.cloneProject(a[0] as ProjectLocator) satisfies IpcResultMap[typeof IpcChannel.ProjectClone];
      }
      case IpcChannel.ProjectMove: {
        await session.moveProject(a[0] as ProjectLocator, a[1] as GroupLocator);
        return undefined satisfies IpcResultMap[typeof IpcChannel.ProjectMove];
      }
      // Project-scoped design-document export: render the complete saved projection before
      // entering the injected native save boundary (production cancellation returns an empty path).
      case IpcChannel.DesignExport: {
        const input = a[0] as DesignExportInput;
        if (input.sourceRoot !== session.root) throw new Error("设计文档导出已拒绝：当前工作区根目录已变化");
        const loc = session.locateApi(input.locator);
        if (!loc) throw new Error(`未找到接口: ${JSON.stringify(input.locator)}`);
        const snapshot = createProjectSnapshot(loc.project);
        if (input.format === "openapi-3.0" || input.format === "openapi-3.1") {
          const encoding = input.encoding ?? "json";
          const result = exportOpenapi(snapshot, input.scope, {
            version: input.format === "openapi-3.0" ? "3.0" : "3.1",
            ...(input.infoVersion === undefined ? {} : { infoVersion: input.infoVersion }),
            allowLossy: false,
          });
          if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
            throw new Error("OpenAPI 导出包含结构错误；未写入输出文件");
          }
          if (result.blocked) {
            const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.lossy)
              .map(({ code, path, message }) => ({ code, path, message }));
            if (!(await confirmLossyExport(diagnostics))) return "";
          }
          let content: string;
          if (encoding === "yaml") {
            const { stringify: stringifyYaml } = await import("yaml");
            content = stringifyYaml(result.document);
          } else {
            content = `${JSON.stringify(result.document, null, 2)}\n`;
          }
          const extension = encoding === "yaml" ? "yaml" : "json";
          const savedPath = await saveFile(`${loc.project.name}.openapi.${extension}`, content, input.format, encoding);
          return savedPath satisfies IpcResultMap[typeof IpcChannel.DesignExport];
        }
        const projection = buildDocumentProjection(snapshot, input.scope);
        if (projection.apis.length === 0 || projection.diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.path.startsWith("scope."))) {
          throw new Error("文档范围没有匹配的接口或包含无效目标；未写入输出文件");
        }
        const content = input.format === "html" ? renderDocumentHtml(projection) : renderDocumentMarkdown(projection);
        const extension = input.format === "html" ? "html" : "md";
        return await saveFile(`${loc.project.name}.${extension}`, content, input.format) satisfies IpcResultMap[typeof IpcChannel.DesignExport];
      }
      case IpcChannel.DesignPreview: {
        return previewDesignDraft(session, a[0] as DesignPreviewInput) satisfies IpcResultMap[typeof IpcChannel.DesignPreview];
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
        return await session.createWorkflow(input.locator, input.name, input.executionVersion) satisfies IpcResultMap[typeof IpcChannel.WfCreate];
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
        const input = a[0] as WfRunInput;
        return workflowRuns.run(input, input.invocationId ? requireOwner(owner) : owner);
      }
      case IpcChannel.WfCancel: return workflowRuns.cancel(a[0] as import("../shared/types.js").WfCancelInput, requireOwner(owner));
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
      case IpcChannel.OAuthProfilesGet:
        return await credentials.oauthProfilesGet(a[0] as Parameters<typeof credentials.oauthProfilesGet>[0]) satisfies IpcResultMap[typeof IpcChannel.OAuthProfilesGet];
      case IpcChannel.OAuthProfileSave:
        return await credentials.oauthProfileSave(a[0] as Parameters<typeof credentials.oauthProfileSave>[0]) satisfies IpcResultMap[typeof IpcChannel.OAuthProfileSave];
      case IpcChannel.OAuthProfileUnlink:
        return await credentials.oauthProfileUnlink(a[0] as Parameters<typeof credentials.oauthProfileUnlink>[0]) satisfies IpcResultMap[typeof IpcChannel.OAuthProfileUnlink];
      case IpcChannel.OAuthProfileAcquire:
        return await credentials.oauthProfileAcquire(a[0] as Parameters<typeof credentials.oauthProfileAcquire>[0]) satisfies IpcResultMap[typeof IpcChannel.OAuthProfileAcquire];
      case IpcChannel.OAuthProfileRefresh:
        return await credentials.oauthProfileRefresh(a[0] as Parameters<typeof credentials.oauthProfileRefresh>[0]) satisfies IpcResultMap[typeof IpcChannel.OAuthProfileRefresh];
      case IpcChannel.OAuthAuthorizeBegin:
        return await credentials.oauthAuthorizationBegin(requireOwner(owner), a[0] as Parameters<typeof credentials.oauthAuthorizationBegin>[1]) satisfies IpcResultMap[typeof IpcChannel.OAuthAuthorizeBegin];
      case IpcChannel.OAuthAuthorizeStatus:
        return credentials.oauthAuthorizationStatus(requireOwner(owner), (a[0] as { sessionId: string }).sessionId) ?? null satisfies IpcResultMap[typeof IpcChannel.OAuthAuthorizeStatus];
      case IpcChannel.OAuthAuthorizeWait:
        return await credentials.oauthAuthorizationWait(requireOwner(owner), (a[0] as { sessionId: string }).sessionId) ?? null satisfies IpcResultMap[typeof IpcChannel.OAuthAuthorizeWait];
      case IpcChannel.OAuthAuthorizeCancel:
        return credentials.oauthAuthorizationCancel(requireOwner(owner), (a[0] as { sessionId: string }).sessionId) ?? null satisfies IpcResultMap[typeof IpcChannel.OAuthAuthorizeCancel];
      case IpcChannel.NetworkProfilesGet:
        return await credentials.networkProfilesGet(a[0] as ProjectLocator) satisfies IpcResultMap[typeof IpcChannel.NetworkProfilesGet];
      case IpcChannel.NetworkProfilesSave:
        return await credentials.networkProfilesSave(a[0] as NetworkProfilesSaveInput) satisfies IpcResultMap[typeof IpcChannel.NetworkProfilesSave];
      case IpcChannel.NetworkSecretImport: {
        const input = a[0] as NetworkSecretImportInput;
        try {
          const path = await pickNetworkSecretFile(input.locale ?? "en");
          if (!path) return { outcome: "cancelled" } satisfies IpcResultMap[typeof IpcChannel.NetworkSecretImport];
          return await credentials.networkSecretImportFromFile(input.locator, input.ref, path) satisfies IpcResultMap[typeof IpcChannel.NetworkSecretImport];
        } catch {
          return { outcome: "failed", message: "The selected secret file could not be saved." } satisfies IpcResultMap[typeof IpcChannel.NetworkSecretImport];
        }
      }
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

  return { handle, pluginsRuntime, stopMocks: () => mockManager.stopAll() };
}
