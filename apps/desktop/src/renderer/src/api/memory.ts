import { existsSync, mkdtempSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderContractMarkdown,
  createProjectSnapshot,
  getSourceApiRevision,
  StressSafetyError,
  CredentialError,
  type AiSuggestedCase,
  type ApiAsset,
  type ApiRequest,
  type DebugInvocation,
  type DebugResult,
  type ApiTestCase,
  type AssetDiagnostic,
  type CaseOutcome,
  type ComponentAsset,
  type ContractCollection,
  type ContractFolder,
  type ContractGroup,
  type ContractProject,
  type ContractWorkspace,
  type Environment,
  type LoadProblem,
  type ModelAsset,
  type NodeResult,
  type ProtocolClient,
  type RunResult,
  type SecretRef,
  type SecretStore,
  type StorageAdapter,
  type StressReport,
  type Workflow,
  type WorkflowRunResult,
  type WorkflowStatus,
  type StressTargetPolicy,
  type NetworkConfiguration,
} from "@apicc/core";
import { ContractProjectSchema, emptyNetworkConfiguration, NetworkConfigurationSchema } from "@apicc/core/schema";
import { createSession } from "../../../main/session.js";
import { toTreeNode } from "../../../main/tree.js";
import { createCredentialHost } from "../../../main/credentialHost.js";
import { createStressControllerWithHost } from "../../../main/stressController.js";
import type { ApiLocator, ApiParentLocator, CollectionLocator, ComponentLocator, EnvironmentLocator, FolderLocator, GroupLocator, ModelLocator, NodeLocator, ProjectLocator, WorkflowLocator, WorkspaceLocator } from "../../../shared/locations.js";
import { localTreeNodeKey, type LocalRootTreeNodeDTO, type LocalTreeIdentity, type LocalTreeNodeDTO } from "../../../shared/tree-dto.js";
import type { ContainerSaveInput, ContainerSaveResult, ProjectGlobalSettings, WorkflowImpactEntryDTO } from "../../../shared/types.js";
import type { DesktopCredentialErrorCode } from "../../../shared/credentials.js";
import type { CredentialMutationResult, CredentialPutInput, CredentialRefInput, CredentialStatusResult } from "../../../shared/credentials.js";
import type { NetworkProfilesGetInput, NetworkProfilesResult, NetworkProfilesSaveInput, NetworkSecretImportInput, NetworkSecretImportResult } from "../../../shared/network.js";
import type { OAuthAuthorizationBeginInput, OAuthAuthorizationSessionId, OAuthAuthorizationSessionView, OAuthProfileActionInput, OAuthProfileMutationResult, OAuthProfilesGetInput, OAuthProfilesResult, OAuthProfileSaveInput, OAuthProfileUnlinkInput } from "../../../shared/oauth.js";
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
    preOperations: [],
    postOperations: [],
    assertions: [{ id: "ai-fixture-assert-1", target: "status", op: "eq", expected: "200" }],
  },
  {
    id: "ai-fixture-case-2",
    name: "AI 建议-非法参数 400",
    scope: "base",
    parameters: {},
    preOperations: [],
    assertions: [
      { id: "ai-fixture-assert-2", target: "status", op: "eq", expected: "400" },
      { id: "ai-fixture-assert-3", target: "bodyJson", op: "contains", path: "$.message", expected: "参数" },
    ],
    postOperations: [{ id: "ai-fixture-post-operation-1", type: "script", content: "console.log(\"AI 建议用例执行完毕\");" }],
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
  OnlineGroup,
  OnlineLoginInput,
  OnlineLoginOutput,
  OnlineMappingResult,
  OnlineMigrateScanResult,
  OnlineMigrateWriteInput,
  OnlineProjectMappingInput,
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
  DebugHistoryListFilter,
  DebugHistoryPreferences,
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
  StressRunResult,
  StressRunSummaryDTO,
  WfCreateInput,
  WfImpactInput,
  WfRunInput,
  WorkflowDetail,
  WorkflowSummary,
  WfSetStatusResult,
} from "../../../shared/types.js";
import { StressRunResultSchema } from "../../../shared/types.js";

const WORKSPACE_FILE = "apicc.workspace.yaml";

/**
 * 在线替身种子实体 id（path 实体化 2026-09-08：内容 path 首段=项目实体 id；2026-09-09 服务端
 * BIGINT 化后为数字字符串——树映射 PROJECT_ID_PATTERN 认数字首段；分组为管理面实体、
 * 不再有 group.yaml 内容文件）。导出供测试引用种子路径（防字面量漂移）。
 */
export const ONLINE_SEED_GROUP_ID = "301";
export const ONLINE_SEED_PROJECT_ID = "300";

/**
 * 渲染层测试替身：内存数据 + 与主进程 session 相同语义的树构建与落盘时机。
 * 持久化复用 @apicc/core 的 fileStorage（与 session 同一适配器）；内存态是唯一事实源，
 * 落盘只是为 reopen/validate 同语义做的最佳努力。wsOpen 目标目录若没有
 * apicc.workspace.yaml，则回退为直接打开当前内存工作区（路径仅作展示，不迁移落盘根）；
 * 目录确为工作区时仍从盘加载，保持与 session 一致的重开语义。
 * debugSend 不走真实网络，固定返回成功结果。测试经 options.root 注入工作区目录；
 * 默认每实例独立临时目录，可安全并行。
 * stressRun 复用主进程 controller/credential preparation；仅把传输与历史存储替换为内存实现，
 * 默认假 client 不发真实网络。
 */
type MemoryManagedClient = ProtocolClient & { close(): Promise<void> };

export function createMemoryApi(options?: { root?: string; stressClient?: MemoryManagedClient; storage?: StorageAdapter; secretStore?: SecretStore }): ApiccApi & { seedWorkspace(): void; problems: LoadProblem[]; importApplyCalls: ReadonlyArray<{ mode: "project"; groupId: string; name: string } | { mode: "module"; projectId: string; name: string }>; designExportCalls: ReadonlyArray<{ file: string; content: string }>; aiSaveConfigCalls: ReadonlyArray<AiSaveConfigInput> } {
  // 默认每实例独立临时目录（?? 短路：注入 options.root 时不会创建临时目录），
  // 避免固定共享路径的多实例互相污染与并行测试并发写。
  let root = options?.root ?? mkdtempSync(join(tmpdir(), "apicc-memory-"));
  const session = createSession({ storage: options?.storage });
  let seeded = false;
  let pendingSeed: Promise<void> | null = null;
  let problems: LoadProblem[] = [];
  // 运行历史内存样例（新→旧，与主进程 listRuns 排序一致）：runCollection 产出，
  // runsList/runsGet 读回；runSeq 保证同毫秒多次运行不重名（对齐 Runner 落盘文件名语义）。
  const runs: Array<{ file: string; result: RunResult }> = [];
  const memoryDebugInvocations = new Map<string, { invocation: DebugInvocation; startedAt: string }>();
  let runSeq = 0;
  // 压测历史（M2-D3 任务 1）：stressRun/stop 收尾产出（文件名与主进程同构 stress-<apiId>-<ts>.json）。
  const stressRuns: Array<{ file: string; report: StressReport }> = [];
  const networkProfiles = new Map<string, { revision: string; configuration: NetworkConfiguration }>();
  // 压测生命周期由正式 controller 管理；此 Promise 仅用于 renderer 替身的单活动拒绝与 stop 等待。
  let stressActive: Promise<StressRunResult> | null = null;
  let stressController: ReturnType<typeof createStressControllerWithHost> | null = null;
  // 压测 client：默认假实现（200 成功、零时延），测试可注入挂起/自定义 client，不发真实网络。
  const stressClient: MemoryManagedClient = options?.stressClient ?? {
    name: "fake",
    canHandle: () => true,
    execute: async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 0 }),
    close: async () => {},
  };
  // 导入向导（任务 7）：importApply 调用记录（供测试断言；语义对齐 session.importProject）。
  const importApplyCalls: Array<{ mode: "project"; groupId: string; name: string } | { mode: "module"; projectId: string; name: string }> = [];
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
   *  path 实体化（2026-09-08）：内容 path 首段=项目实体 UUID（<projectId>/…），与主进程
   *  onlineTreeToDto 同判据；项目/分组为管理面实体，内容清单无 group.yaml。 */
  function seedOnlineWorkspace(): void {
    if (onlineWorkspaces.length > 0) return;
    const ws: OnlineWorkspaceSummary = {
      id: `ws-online-${++onlineWorkspaceSeq}`,
      name: "示例在线空间",
      myRole: "OWNER",
      createdAt: new Date().toISOString(),
    };
    onlineWorkspaces.push(ws);
    const p = ONLINE_SEED_PROJECT_ID;
    onlineFiles.set("apicc.workspace.yaml", { content: `id: ${ws.id}\nname: ${ws.name}\n`, version: 1 });
    onlineFiles.set(`${p}/project.yaml`, { content: "id: p-online-1\nname: 示例项目\n", version: 1 });
    onlineFiles.set(`${p}/environments/dev.yaml`, { content: "id: env-online-1\nname: dev\nvariables: {}\n", version: 1 });
    onlineFiles.set(`${p}/workflows/示例流/workflow.yaml`, { content: "id: wf-online-1\nname: 示例流\nstatus: draft\nnodes: []\nedges: []\n", version: 1 });
    onlineFiles.set(`${p}/collections/示例集合/collection.yaml`, { content: "id: c-online-1\nname: 示例集合\n", version: 1 });
    onlineFiles.set(`${p}/collections/示例集合/apis/示例接口/api.yaml`, { content: "id: api-online-1\nname: 示例接口\n", version: 1 });
  }

  /** 在线替身的项目实体行（唯一数据源）：path 实体化（2026-09-08）后为实体表产出
   *  {id, name, groupId, myRole}。onlineWorkspaceView（树视图）与 onlineTreeGet（迁移取树）
   *  必须共用同一套项目身份——旧「"p-online-1" + 目录 path」行已退役，双形态会让迁移流
   *  消费到 canEdit（id 前缀匹配）认不出的项目行。 */
  function onlineProjectsRows(): OnlineTree["projects"] {
    return [{ id: ONLINE_SEED_PROJECT_ID, name: "示例项目", groupId: ONLINE_SEED_GROUP_ID, myRole: "EDITOR" as const }];
  }

  /** 在线替身的分组实体行（计划 C 任务 2）：groupId → 组名反查数据源，与项目行的 groupId 同源。 */
  function onlineGroupsRows(): OnlineGroup[] {
    return [{ id: ONLINE_SEED_GROUP_ID, name: "示例分组", isDefault: true, createdAt: new Date(0).toISOString() }];
  }

  // 计划 C 任务 1 会话表化（与 main session 同构）：open 入表激活、activate 纯切指针
  // （表中有且已登录）、close 带 id 出表/无参关活跃、出表不自动切活跃。
  type OnlineWsSession = { id: string; name: string; myRole: OnlineWorkspaceOpenInput["myRole"] };
  const onlineSessions = new Map<string, OnlineWsSession>();
  let onlineActiveId: string | null = null;

  /** 构造活跃在线工作区视图（经同一 onlineTreeToDto 映射，与 main 侧零漂移）。计划 C 任务 3
   *  分组层：同 main session.getTreeView 注入组名表——项目挂 group:<groupId> 合成组节点。 */
  function onlineWorkspaceView(): OnlineWorkspaceView {
    const ws = onlineActiveId !== null ? onlineSessions.get(onlineActiveId) : undefined;
    if (!ws) throw new Error("尚未打开在线工作区");
    if (!onlineUser) throw new Error("尚未登录在线服务器");
    const tree: OnlineTree = {
      workspaceId: ws.id,
      rootVersion: onlineFiles.size,
      files: [...onlineFiles.keys()].map(onlineTreeRow),
      // path 实体化修订 2026-09-08：projects 行 = 实体表产出（与 onlineTreeGet 同一数据源）
      projects: onlineProjectsRows(),
    };
    return {
      workspaceId: ws.id,
      name: ws.name,
      myRole: ws.myRole,
      projects: tree.projects,
      tree: onlineTreeToDto(tree, ws.name, new Map(onlineGroupsRows().map((g) => [g.id, g.name] as const))),
    };
  }

  async function ensureReady(): Promise<ContractWorkspace> {
    if (pendingSeed) await pendingSeed;
    const current = session.workspace;
    if (!current) throw new Error("尚未打开工作区");
    return current;
  }

  function currentWorkspace(): ContractWorkspace {
    const current = session.workspace;
    if (!current) throw new Error("尚未打开工作区");
    return current;
  }

  function openResult(rootPath: string): OpenResult {
    return {
      workspace: currentWorkspace(),
      problems: structuredClone(problems),
      root: rootPath,
      readOnly: session.readOnly,
      revision: session.revision ?? "",
    };
  }

  function findWorkflow(locator: WorkflowLocator): { workflow: Workflow; project: ContractProject } | undefined {
    return session.locateWorkflow(locator);
  }

function newNodeDTO<K extends Extract<NodeLocator["kind"], "group" | "project" | "collection" | "folder" | "api">>(kind: K, locator: Extract<NodeLocator, { kind: K }>["locator"], id: string, label: string): NodeCreatedDTO {
    const identity = { source: "local" as const, kind, locator } as const;
  return { ...identity, id, key: localTreeNodeKey(identity as LocalTreeIdentity), label } as NodeCreatedDTO;
  }

  function credentialKey(scope: { workspaceId: string; groupId: string; projectId: string }, ref: SecretRef): string {
    return JSON.stringify([scope.workspaceId, scope.groupId, scope.projectId, ref.id, ref.policy]);
  }

  const secretValues = new Map<string, string>();
  const secretStore: SecretStore = options?.secretStore ?? {
    async put(scope, ref, value) { secretValues.set(credentialKey(scope, ref), value); },
    async resolve(scope, ref) {
      const value = secretValues.get(credentialKey(scope, ref));
      if (value === undefined) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      return value;
    },
    async version(scope, ref) {
      if (!secretValues.has(credentialKey(scope, ref))) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      return "memory-v1";
    },
    async remove(scope, ref) {
      if (!secretValues.delete(credentialKey(scope, ref))) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
    },
    async status(scope, ref) {
      return secretValues.has(credentialKey(scope, ref)) ? "available" : "missing";
    },
  };

  // The test substitute shares the exact credential preparation and stress controller path with
  // desktop IPC, while explicitly pinning both dependencies: credentials never fall back to a
  // system provider and the injected fake transport never reaches the network. The controller's
  // report writer is intentionally a no-op; runsList/runsGet below expose only in-memory history.
  stressController = createStressControllerWithHost(session, {
    createManagedClient: () => stressClient,
    writeReport: () => {},
  }, createCredentialHost(session, () => secretStore));

  function credentialScope(locator: ProjectLocator): { workspaceId: string; groupId: string; projectId: string } {
    return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
  }

  function credentialFailure(error: unknown, refId: string, fallbackCode: DesktopCredentialErrorCode): CredentialMutationResult {
    const code = error instanceof CredentialError ? error.code : fallbackCode;
    return { ok: false, error: { code, refId, message: error instanceof Error ? error.message : String(error) } };
  }

  function credentialContextExists(locator: ProjectLocator): boolean {
    try {
      return session.locateProject(credentialScope(locator)) !== undefined;
    } catch {
      return false;
    }
  }

  function networkProfileKey(locator: ProjectLocator): string {
    return JSON.stringify([root, locator.workspaceId, locator.groupId, locator.projectId]);
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
    get importApplyCalls(): ReadonlyArray<{ mode: "project"; groupId: string; name: string } | { mode: "module"; projectId: string; name: string }> {
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
      if (pendingSeed) await pendingSeed;
      if (existsSync(join(rootPath, WORKSPACE_FILE))) {
        const view = await session.open(rootPath);
        root = rootPath;
        problems = view.problems;
        return { workspace: view.workspace, problems: view.problems, root: view.root, readOnly: view.readOnly, revision: view.revision };
      }
      // 目标目录不是工作区：内存有工作区时回退为打开内存态（替身以内存为事实源）；
      // 内存也为空时保留与 session 一致的「缺少工作区文件」错误。
      const workspace = session.workspace;
      if (!workspace) throw new Error(`工作区根目录缺少 ${WORKSPACE_FILE}: ${rootPath}`);
      root = rootPath;
      return openResult(rootPath);
    },

    async wsCreate(rootPath: string, name: string): Promise<OpenResult> {
      const view = await session.create(rootPath, name);
      root = rootPath;
      problems = view.problems;
      return { workspace: view.workspace, problems: view.problems, root: view.root, readOnly: view.readOnly, revision: view.revision };
    },

    async wsPickDirectory(): Promise<string> {
      return root;
    },

    async wsValidate(): Promise<LoadProblem[]> {
      await ensureReady();
      problems = await session.validate();
      return structuredClone(problems);
    },

    async treeGet(): Promise<LocalTreeNodeDTO> {
      await ensureReady();
      const tree = toTreeNode(currentWorkspace());
      if (tree.source !== "local" || tree.kind !== "root") throw new Error("memory tree must be a local workspace root");
      return tree;
    },

    async nodeCreate(input: NodeCreateInput): Promise<NodeCreatedDTO> {
      await ensureReady();
      if (input.kind === "group") {
        const value = await session.createGroup(input.parent, input.name);
        return newNodeDTO("group", { workspaceId: input.parent.workspaceId, groupId: value.id }, value.id, value.name);
      }
      if (input.kind === "project") {
        const value = await session.createProject(input.parent, input.name);
        return newNodeDTO("project", { ...input.parent, projectId: value.id }, value.id, value.name);
      }
      if (input.kind === "collection") {
        const value = await session.createCollection(input.parent, input.name);
        return newNodeDTO("collection", { ...input.parent, collectionId: value.id }, value.id, value.name);
      }
      if (input.kind === "folder") {
        const value = await session.createFolder(input.parent, input.name);
        return newNodeDTO("folder", { ...input.parent, folderIds: [...("folderIds" in input.parent ? input.parent.folderIds ?? [] : []), value.id] }, value.id, value.name);
      }
      const value = await session.createApi(input.parent, input.api);
      const locator: ApiLocator = { ...input.parent, folderIds: "folderIds" in input.parent ? [...(input.parent.folderIds ?? [])] : [], apiId: value.contract.id };
      const method = value.contract.request.protocol === "websocket" ? undefined : value.contract.request.method;
      const identity = { source: "local" as const, kind: "api" as const, locator };
      return { ...identity, id: value.contract.id, key: localTreeNodeKey(identity), label: value.contract.metadata.name,
        protocol: value.contract.request.protocol, ...(method === undefined ? {} : { method }) };
    },

    async nodeRename(node: NodeLocator, name: string): Promise<void> {
      await ensureReady();
      await session.renameNode(node, name);
    },

    async nodeDelete(node: NodeLocator): Promise<void> {
      await ensureReady();
      await session.deleteNode(node);
    },

    // 环境操作（任务 4）：语义对齐 session（未命中统一抛「未找到」）；与替身其余
    // node 操作一致，成功后内部落盘（替身的落盘为最佳努力），主进程侧落盘由 IPC 分支显式 save。
    async envCreate(input: EnvCreateInput): Promise<Environment> {
      await ensureReady();
      return session.createEnvironment(input.locator, {
        name: input.name,
        ...(input.extends === undefined ? {} : { extends: input.extends ?? undefined }),
        variables: input.variables,
        baseUrls: input.baseUrls,
      });
    },

    async envVarsSave(locator: EnvironmentLocator, variables: Record<string, string>): Promise<Environment> {
      await ensureReady();
      return session.setEnvironmentVariables(locator, variables);
    },

    async envBaseUrlsSave(locator: EnvironmentLocator, baseUrls: Record<string, string>): Promise<Environment> {
      await ensureReady();
      return session.setEnvironmentBaseUrls(locator, baseUrls);
    },

    async globalsSave(locator: ProjectLocator, settings: ProjectGlobalSettings): Promise<ProjectGlobalSettings> {
      await ensureReady();
      return session.setProjectGlobals(locator, settings);
    },

    async globalsGet(locator: ProjectLocator): Promise<ProjectGlobalSettings> {
      await ensureReady();
      return session.getProjectGlobals(locator);
    },

    async stressPolicySave(locator: ProjectLocator, policy: StressTargetPolicy): Promise<StressTargetPolicy> {
      await ensureReady();
      return session.setStressPolicy(locator, policy);
    },

    async containerGet(target: { kind: "collection"; locator: CollectionLocator } | { kind: "folder"; locator: FolderLocator }): Promise<import("../../../shared/types.js").ContainerDetail> {
      await ensureReady();
      if (target.kind === "collection") {
        const location = session.locateCollection(target.locator);
        if (!location) throw new Error(`Collection not found at complete locator: ${JSON.stringify(target.locator)}`);
        return { kind: "collection", locator: target.locator, name: location.collection.name, operations: session.getContainer(target.locator) };
      }
      const location = session.locateFolder(target.locator);
      if (!location) throw new Error(`Folder not found at complete locator: ${JSON.stringify(target.locator)}`);
      return { kind: "folder", locator: target.locator, name: location.folder.name, operations: session.getContainer(target.locator) };
    },

    async containerSave(input: ContainerSaveInput): Promise<ContainerSaveResult> {
      await ensureReady();
      if (input.kind === "collection") {
        const operations = await session.saveContainer(input.locator, input.operations);
        return { kind: input.kind, locator: input.locator, operations };
      }
      const operations = await session.saveContainer(input.locator, input.operations);
      return { kind: input.kind, locator: input.locator, operations };
    },

    async apiGet(locator: ApiLocator): Promise<ApiDetail> {
      await ensureReady();
      const loc = session.locateApi(locator);
      if (!loc) throw new Error(`未找到接口: ${JSON.stringify(locator)}`);
      return {
        api: loc.api,
        locator: { ...locator, folderIds: [...locator.folderIds] },
        sourceApiRevision: getSourceApiRevision(loc.api),
        sourceProjectRevision: createProjectSnapshot(loc.project).definitionRevision,
        envs: loc.project.environments.map((environment) => ({
          id: environment.id,
          name: environment.name,
          locator: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId, environmentId: environment.id },
        })),
      };
    },

    async apiCreateFromRequestDraft(input) {
      await ensureReady();
      return session.createApiFromRequestDraft(input);
    },

    async debugProjectContext(locator: ProjectLocator) {
      await ensureReady();
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
      };
    },

    async apiSave(locator: ApiLocator, api: ApiAsset, expectedSourceApiRevision: string) {
      await ensureReady();
      return session.saveApi(locator, api, [], undefined, expectedSourceApiRevision);
    },

    async apiRequestDraftSave(locator: ApiLocator, request: ApiRequest, expectedSourceApiRevision: string, fields) {
      await ensureReady();
      return session.saveRequestDraft(locator, request, expectedSourceApiRevision, fields);
    },

    async caseSave(locator, testCase, expectedSourceApiRevision: string, fields) {
      await ensureReady();
      return session.saveCase(locator, testCase, expectedSourceApiRevision, [], undefined, fields);
    },

    async caseDraftSave(locator, testCase, expectedSourceApiRevision: string, deletedCases, fields) {
      await ensureReady();
      return session.saveDraftCase(locator, testCase, expectedSourceApiRevision, deletedCases, [], undefined, fields);
    },

    async caseDelete(locator) {
      await ensureReady();
      await session.deleteCase(locator);
    },

    async modelList(locator: ProjectLocator): Promise<ModelAsset[]> {
      await ensureReady();
      return session.listModels(locator);
    },

    async modelGet(locator: ModelLocator): Promise<ModelAsset> {
      await ensureReady();
      const location = session.locateModel(locator);
      if (!location) throw new Error(`Model not found at complete locator: ${JSON.stringify(locator)}`);
      return location.model;
    },

    async modelCreate(locator: ProjectLocator, input): Promise<ModelAsset> {
      await ensureReady();
      return session.createModel(locator, input);
    },

    async modelSave(locator: ModelLocator, model: ModelAsset): Promise<ModelAsset> {
      await ensureReady();
      return session.saveModel(locator, model);
    },

    async componentList(locator: ProjectLocator): Promise<ComponentAsset[]> {
      await ensureReady();
      return session.listComponents(locator);
    },

    async componentGet(locator: ComponentLocator): Promise<ComponentAsset> {
      await ensureReady();
      const location = session.locateComponent(locator);
      if (!location) throw new Error(`Component not found at complete locator: ${JSON.stringify(locator)}`);
      return location.component;
    },

    async componentCreate(locator: ProjectLocator, input): Promise<ComponentAsset> {
      await ensureReady();
      return session.createComponent(locator, input);
    },

    async componentSave(locator: ComponentLocator, component: ComponentAsset): Promise<ComponentAsset> {
      await ensureReady();
      return session.saveComponent(locator, component);
    },

    async assetReferences(locator: ProjectLocator, assetId: string): Promise<AssetDiagnostic[]> {
      await ensureReady();
      return session.referencesTo(locator, assetId);
    },

    async credentialPut(input: CredentialPutInput): Promise<CredentialMutationResult> {
      await ensureReady();
      if (!credentialContextExists(input.locator)) return { ok: false, error: { code: "CREDENTIAL_CONTEXT_INVALID", refId: input.ref.id, message: "Credential project context is invalid." } };
      if (session.readOnly) return { ok: false, error: { code: "CREDENTIAL_READ_ONLY", refId: input.ref.id, message: "工作区处于只读模式，不能写入凭据" } };
      if (input.ref.policy !== "test-auto") return { ok: false, error: { code: "CREDENTIAL_POLICY_UNSUPPORTED", refId: input.ref.id, message: "Credential policy is not supported." } };
      try {
        await secretStore.put(credentialScope(input.locator), input.ref, input.value);
        return { ok: true };
      } catch (error) {
        return credentialFailure(error, input.ref.id, "CREDENTIAL_SAVE_FAILED");
      }
    },

    async credentialRemove(input: CredentialRefInput): Promise<CredentialMutationResult> {
      await ensureReady();
      if (!credentialContextExists(input.locator)) return { ok: false, error: { code: "CREDENTIAL_CONTEXT_INVALID", refId: input.ref.id, message: "Credential project context is invalid." } };
      if (session.readOnly) return { ok: false, error: { code: "CREDENTIAL_READ_ONLY", refId: input.ref.id, message: "工作区处于只读模式，不能写入凭据" } };
      if (input.ref.policy !== "test-auto") return { ok: false, error: { code: "CREDENTIAL_POLICY_UNSUPPORTED", refId: input.ref.id, message: "Credential policy is not supported." } };
      try {
        await secretStore.remove(credentialScope(input.locator), input.ref);
        return { ok: true };
      } catch (error) {
        return credentialFailure(error, input.ref.id, "CREDENTIAL_REMOVE_FAILED");
      }
    },

    async credentialStatus(input: CredentialRefInput): Promise<CredentialStatusResult> {
      await ensureReady();
      if (!credentialContextExists(input.locator)) return { ok: false, error: { code: "CREDENTIAL_CONTEXT_INVALID", refId: input.ref.id, message: "Credential project context is invalid." } };
      if (input.ref.policy !== "test-auto") return { ok: false, error: { code: "CREDENTIAL_POLICY_UNSUPPORTED", refId: input.ref.id, message: "Credential policy is not supported." } };
      try {
        return { ok: true, status: await secretStore.status(credentialScope(input.locator), input.ref) };
      } catch (error) {
        const code = error instanceof CredentialError ? error.code : "CREDENTIAL_READ_FAILED";
        return { ok: false, error: { code, refId: input.ref.id, message: error instanceof Error ? error.message : String(error) } };
      }
    },

    async oauthProfilesGet(_input: OAuthProfilesGetInput): Promise<OAuthProfilesResult> {
      throw new Error("OAuth profiles are unavailable in the in-memory browser API.");
    },

    async oauthProfileSave(_input: OAuthProfileSaveInput): Promise<OAuthProfileMutationResult> {
      throw new Error("OAuth profile changes are unavailable in the in-memory browser API.");
    },

    async oauthProfileUnlink(_input: OAuthProfileUnlinkInput): Promise<OAuthProfileMutationResult> {
      throw new Error("OAuth profile changes are unavailable in the in-memory browser API.");
    },

    async oauthProfileAcquire(_input: OAuthProfileActionInput): Promise<OAuthProfileMutationResult> {
      throw new Error("OAuth token acquisition is unavailable in the in-memory browser API.");
    },

    async oauthProfileRefresh(_input: OAuthProfileActionInput): Promise<OAuthProfileMutationResult> {
      throw new Error("OAuth token refresh is unavailable in the in-memory browser API.");
    },

    async oauthAuthorizeBegin(_input: OAuthAuthorizationBeginInput): Promise<OAuthAuthorizationSessionView> {
      throw new Error("OAuth authorization is unavailable in the in-memory browser API.");
    },

    async oauthAuthorizeStatus(_input: OAuthAuthorizationSessionId): Promise<OAuthAuthorizationSessionView | null> {
      throw new Error("OAuth authorization is unavailable in the in-memory browser API.");
    },

    async oauthAuthorizeWait(_input: OAuthAuthorizationSessionId): Promise<OAuthAuthorizationSessionView | null> {
      throw new Error("OAuth authorization is unavailable in the in-memory browser API.");
    },

    async oauthAuthorizeCancel(_input: OAuthAuthorizationSessionId): Promise<OAuthAuthorizationSessionView | null> {
      throw new Error("OAuth authorization is unavailable in the in-memory browser API.");
    },

    async networkProfilesGet(locator: NetworkProfilesGetInput): Promise<NetworkProfilesResult> {
      await ensureReady();
      const location = session.locateProject(locator);
      if (!location) throw new Error("Network profile project context is unavailable.");
      const key = networkProfileKey(locator);
      const current = networkProfiles.get(key) ?? { revision: "memory:0", configuration: emptyNetworkConfiguration() };
      networkProfiles.set(key, current);
      const refs = new Map<string, SecretRef>();
      for (const profile of current.configuration.profiles) {
        if (profile.kind === "proxy" && profile.passwordRef) refs.set(`${profile.passwordRef.policy}:${profile.passwordRef.id}`, profile.passwordRef);
        const tlsSettings = [...profile.targetTlsBindings.map((binding) => binding.tls), ...(profile.kind === "proxy" && profile.proxyTLS ? [profile.proxyTLS] : [])];
        for (const tls of tlsSettings) for (const ref of [tls.clientPrivateKeyRef, tls.clientKeyPassphraseRef]) {
          if (ref) refs.set(`${ref.policy}:${ref.id}`, ref);
        }
      }
      const secretStatuses = await Promise.all([...refs.values()].map(async (ref) => {
        try {
          const status = await secretStore.status(credentialScope(locator), ref);
          return { ref, status: status === "available" || status === "missing" ? status : "unavailable" as const };
        } catch {
          return { ref, status: "unavailable" as const };
        }
      }));
      return {
        revision: current.revision,
        configuration: structuredClone(current.configuration),
        environments: location.project.environments.map(({ id, name }) => ({ id, name })),
        secretStatuses,
      };
    },

    async networkProfilesSave(input: NetworkProfilesSaveInput) {
      await ensureReady();
      if (!credentialContextExists(input.locator)) throw new Error("Network profile project context is unavailable.");
      if (session.readOnly) throw new Error("Network profile settings are read-only.");
      const parsed = NetworkConfigurationSchema.safeParse(input.configuration);
      if (!parsed.success) throw new Error("Network profile configuration is invalid.");
      const key = networkProfileKey(input.locator);
      const current = networkProfiles.get(key) ?? { revision: "memory:0", configuration: emptyNetworkConfiguration() };
      if (current.revision !== input.revision) throw new Error("Network profile settings changed; reload before saving.");
      const next = {
        revision: `memory:${Number(current.revision.slice("memory:".length)) + 1}`,
        configuration: structuredClone(parsed.data),
      };
      networkProfiles.set(key, next);
      return { revision: next.revision };
    },

    async networkSecretImport(_input: NetworkSecretImportInput): Promise<NetworkSecretImportResult> {
      // The browser substitute has no native file picker. It intentionally never accepts secret bytes.
      return { outcome: "cancelled" };
    },

    async debugSend(input: DebugInput): Promise<DebugOutput> {
      await ensureReady();
      const loc = session.locateApi(input.locator);
      const outcome: CaseOutcome = {
        apiId: input.locator.apiId,
        apiName: loc?.api.contract.metadata.name ?? "",
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

    async debugStart(input: DebugInvocation) {
      await ensureReady();
      const runId = randomUUID();
      memoryDebugInvocations.set(runId, { invocation: structuredClone(input), startedAt: new Date().toISOString() });
      return { runId };
    },

    async debugWait({ runId }): Promise<DebugResult> {
      const entry = memoryDebugInvocations.get(runId);
      if (!entry) throw new Error("Debug run not found in memory UI fixture.");
      const invocation = entry.invocation;
      memoryDebugInvocations.delete(runId);
      const finishedAt = new Date().toISOString();
      const isFree = invocation.mode === "free";
      const located = isFree ? undefined : session.locateApi(invocation.locator);
      const project = isFree ? session.locateProject(invocation.project)?.project : located?.project;
      const sourceProjectRevision = project ? createProjectSnapshot(project).definitionRevision : "memory-source-project";
      const source = isFree
        ? project
          ? { sourceKind: "free" as const, project: invocation.project, draftId: invocation.draftId, draftRevision: "memory-draft-revision" }
          : { sourceKind: "unavailable" as const }
        : { sourceKind: "asset" as const, locator: invocation.locator, sourceApiRevision: located ? getSourceApiRevision(located.api) : "memory-source-api" };
      const outcome = isFree ? {
        apiName: "Free request",
        caseName: "Free request",
        passed: true,
        durationMs: 0,
        assertions: [],
      } : {
        apiId: invocation.locator.apiId,
        apiName: located?.api.contract.metadata.name ?? "API",
        ...(invocation.mode === "case" ? { caseId: invocation.case.caseId } : {}),
        caseName: invocation.mode === "case" ? located?.api.cases.find((item) => item.id === invocation.case.caseId)?.name ?? "Case" : "Request",
        passed: true,
        durationMs: 0,
        assertions: [],
      };
      const replay = invocation.mode === "free"
        ? { mode: "free" as const, sourceKind: "free" as const, project: invocation.project, draftId: invocation.draftId, request: invocation.request, requestTemplate: invocation.request, parameters: invocation.parameters, fields: invocation.fields, ...(invocation.settings ? { settings: invocation.settings } : {}), identityAvailable: Boolean(project), available: Boolean(project) }
        : invocation.mode === "request"
          ? { mode: "request" as const, sourceKind: "asset" as const, locator: invocation.locator, request: invocation.request, requestTemplate: invocation.request, parameters: invocation.parameters, fields: invocation.fields, ...(invocation.settings ? { settings: invocation.settings } : {}), identityAvailable: Boolean(located), available: true }
          : { mode: "case" as const, sourceKind: "asset" as const, case: invocation.case, parameters: {}, fields: [], ...(invocation.settings ? { settings: invocation.settings } : {}), identityAvailable: Boolean(located), available: true };
      return {
        runId,
        source,
        sourceProjectRevision,
        executionSnapshotRevision: sourceProjectRevision,
        mode: invocation.mode,
        identityAvailable: source.sourceKind !== "unavailable",
        ...(invocation.environmentId ? { environmentId: invocation.environmentId } : {}),
        startedAt: entry.startedAt,
        finishedAt,
        run: { collectionName: isFree ? "Free request" : located?.collection.name ?? "Collection", startedAt: entry.startedAt, finishedAt, total: 1, passed: 1, failed: 0 },
        outcomes: [outcome],
        exchanges: [],
        exchangeTotal: 0,
        omittedExchangeCount: 0,
        replay,
        console: [],
        warnings: ["Memory renderer fixture only; no desktop network request was made."],
      };
    },

    async debugCancel({ runId }) {
      return { status: memoryDebugInvocations.delete(runId) ? "cancelled" : "no-active" };
    },

    async debugCookiesList(_input) {
      return [];
    },

    async debugCookiesClear(_input) {},

    async debugPickFile() {
      return null;
    },

    async debugSaveProjected(defaultName: string, content: string) {
      designExportCalls.push({ file: defaultName, content });
      return "";
    },

    async debugHistoryList(_filter: DebugHistoryListFilter) {
      return { items: [], diagnostics: [] };
    },

    async debugHistoryGet(_historyId: string) {
      return { record: null, diagnostics: [] };
    },

    async debugHistoryDelete(_historyId: string) {
      return false;
    },

    async debugHistoryCleanup() {
      return { deleted: 0, diagnostics: [] };
    },

    async debugHistoryPreferencesGet() {
      return { preferences: { enabled: true, retentionDays: 30, maxRecords: 1000 }, diagnostics: [] };
    },

    async debugHistoryPreferencesUpdate(preferences: DebugHistoryPreferences) {
      return preferences;
    },

    async debugHistoryRestore(_input: Parameters<ApiccApi["debugHistoryRestore"]>[0]) {
      throw new Error("Debug history is only available in the desktop main process.");
    },

    async debugHistoryReplay(_input: Parameters<ApiccApi["debugHistoryReplay"]>[0]) {
      throw new Error("Debug history is only available in the desktop main process.");
    },

    // 集合运行（任务 6）：语义对齐 session——未命中集合抛「未找到」；不走真实网络，
    // 固定返回单用例成功结果并记入运行历史（runs list/get 的内存样例由此产出）。
    async runCollection(input: RunCollectionInput): Promise<RunResult> {
      await ensureReady();
      const location = session.locateCollection(input.locator);
      if (!location) throw new Error(`Collection not found at complete locator: ${JSON.stringify(input.locator)}`);
      const firstApi = (container: ContractCollection | ContractFolder): ApiAsset | undefined => {
        const direct = container.apis[0];
        if (direct) return direct;
        for (const folder of "folders" in container ? container.folders : []) {
          const nested = firstApi(folder);
          if (nested) return nested;
        }
        return undefined;
      };
      const collection = location.collection;
      const api = firstApi(collection);
      const outcome: CaseOutcome = {
        apiId: api?.contract.id ?? "",
        apiName: api?.contract.metadata.name ?? "",
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
        ...(input.envName == null ? {} : { envName: input.envName }),
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
        skipped: result.skipped ?? 0,
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

    // 正式 controller 负责 locator 捕获、凭据准备、worker/session、计时和确认策略；内存替身
    // 只提供假 transport 与内存历史。历史/返回报告彼此分离，避免调用方改写历史内容。
    async stressRun(input: StressRunInput): Promise<StressRunResult> {
      if (stressActive) throw new Error("已有压测进行中");
      await ensureReady();
      const controller = stressController;
      if (!controller) throw new Error("压测控制器尚未初始化");
      let finished: Promise<StressRunResult>;
      finished = (async (): Promise<StressRunResult> => {
        try {
          const output: StressRunOutput = await controller.run(input);
          const report: StressReport = structuredClone(output.report);
          const file = output.file;
          try {
            if (file) stressRuns.unshift({ file, report: structuredClone(report) });
            return StressRunResultSchema.parse({ ok: true, report, ...(file ? { file } : {}) });
          } catch (e) {
            console.warn(`压测历史记录失败（${file ?? "memory"}）: ${e instanceof Error ? e.message : String(e)}`);
            return StressRunResultSchema.parse({ ok: true, report });
          }
        } catch (error) {
          if (error instanceof StressSafetyError) {
            if (!error.targetOrigin) throw new Error("安全错误缺少目标 origin");
            return StressRunResultSchema.parse({
              ok: false,
              error: { code: error.code, message: error.message, targetOrigin: error.targetOrigin },
            });
          }
          throw error;
        }
      })().finally(() => {
        if (stressActive === finished) stressActive = null;
      });
      stressActive = finished;
      return await finished;
    },

    async stressStop(): Promise<StressRunOutput> {
      const active = stressActive;
      if (!active) throw new Error("没有进行中的压测");
      stressController?.abortActive();
      const result = await active;
      if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
      return result;
    },

    // 导入向导（任务 7）：importPreview 返回固定样例（渲染层替身不做格式探测——替身
    // 语义只钉「api.importPreview 返回结构入 store 状态」）；importApply 语义对齐
    // session 双模式（轨二：project=按分组 id 整包落库；module=集合并入目标项目、
    // baseUrl 进模块变量不造环境）并记录调用供测试断言。
    async importPreview(_input: ImportPreviewInput): Promise<ImportPreviewResult> {
      await ensureReady();
      const project = ContractProjectSchema.parse({ id: randomUUID(), name: "导入示例项目", globals: {} });
      return { importerName: "sample", project, warnings: ["示例警告"] };
    },

    async importApply(input: ImportApplyInput): Promise<void> {
      await ensureReady();
      if (input.mode === "module") {
        await session.importModuleToProject(input.target, input.name, {
          project: input.project,
          ...(input.sourceEnvironmentName === undefined ? {} : { sourceEnvironmentName: input.sourceEnvironmentName }),
        });
        importApplyCalls.push({ mode: "module", projectId: input.target.projectId, name: input.name });
        return;
      }
      await session.importProjectToGroup(input.target, input.name, { project: input.project });
      importApplyCalls.push({ mode: "project", groupId: input.target.groupId, name: input.name });
    },

    /** project:clone（轨二）：整项目深拷贝、全部实体新 id，落回原分组（名称不变）。 */
    async projectClone(locator: ProjectLocator): Promise<ContractProject> {
      await ensureReady();
      return session.cloneProject(locator);
    },

    /** project:move（轨二）：项目移入目标分组。 */
    async projectMove(source: ProjectLocator, target: GroupLocator): Promise<void> {
      await ensureReady();
      await session.moveProject(source, target);
    },

    // 详细设计导出（任务 8）：用 core renderDesignMarkdown 渲染（与主进程同一实现），
    // 记录渲染产物供测试断言；替身不落盘（主进程语义是 showSaveDialog 后写盘并返回
    // 路径），返回「工作区根/<接口名>.design.md」占位路径。
    async designExport(locator: ApiLocator): Promise<string> {
      await ensureReady();
      const loc = session.locateApi(locator);
      if (!loc) throw new Error(`未找到接口: ${JSON.stringify(locator)}`);
      const file = join(root, `${loc.api.contract.metadata.name}.design.md`);
      designExportCalls.push({ file, content: renderContractMarkdown(loc.api, createProjectSnapshot(loc.project).context) });
      return file;
    },

    // 工作流频道（M2-B 任务 1）：语义与主进程 session 一致（错误文案逐字对齐）——
    // 生命周期迁移复用 core transitionWorkflowStatus/validateEnablement（与 session 同一实现），
    // 启用校验未过返回状态不变 + errors；wf:run 不走真实网络，按实际节点生成固定成功样例。
    async wfList(locator: ProjectLocator): Promise<WorkflowSummary[]> {
      await ensureReady();
      const location = session.locateProject(locator);
      if (!location) throw new Error(`Project not found at complete locator: ${JSON.stringify(locator)}`);
      return location.project.workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        status: workflow.status,
        locator: { ...locator, workflowId: workflow.id },
      }));
    },

    async wfGet(locator: WorkflowLocator): Promise<WorkflowDetail> {
      await ensureReady();
      const loc = session.locateWorkflow(locator);
      if (!loc) throw new Error(`Workflow not found at complete locator: ${JSON.stringify(locator)}`);
      return { workflow: loc.workflow, locator };
    },

    async wfCreate(input: WfCreateInput): Promise<Workflow> {
      await ensureReady();
      return session.createWorkflow(input.locator, input.name);
    },

    async wfDelete(locator: WorkflowLocator): Promise<void> {
      await ensureReady();
      await session.deleteWorkflow(locator);
    },

    // 重命名（M2-B 收口）：语义对齐 session.renameWorkflow——同名放开（轨二）后仅改名
    // 并落盘（id 布局后盘上目录=工作流 id，改名不动目录；替身落盘为最佳努力）。
    async wfRename(locator: WorkflowLocator, name: string): Promise<Workflow> {
      await ensureReady();
      return session.renameWorkflow(locator, name);
    },

    async wfSave(locator: WorkflowLocator, workflow: Workflow): Promise<Workflow> {
      await ensureReady();
      return session.saveWorkflow(locator, workflow);
    },

    async wfSetStatus(locator: WorkflowLocator, next: WorkflowStatus): Promise<WfSetStatusResult> {
      await ensureReady();
      return session.setWorkflowStatus(locator, next);
    },

    async wfImpact(input: WfImpactInput): Promise<WorkflowImpactEntryDTO[]> {
      await ensureReady();
      return session.workflowImpact(input);
    },

    async wfRun(input: WfRunInput): Promise<WorkflowRunResult> {
      await ensureReady();
      const loc = findWorkflow(input.locator);
      if (!loc) throw new Error(`Workflow not found at complete locator: ${JSON.stringify(input.locator)}`);
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
    async authConfig(): Promise<{ allowRegistration: boolean }> {
      // 替身默认开放注册（既有注册流用例依赖）；关闭态由用例覆写本方法
      return { allowRegistration: true };
    },

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
        // path 实体化（2026-09-08）：projects 行 = 实体表产出 {id, name, groupId, myRole}，
        // 与 onlineWorkspaceView 共用 onlineProjectsRows()（迁移流消费同一套项目身份）
        projects: onlineProjectsRows(),
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
    // 因此未登录 open 直接拒绝且不残留状态）。计划 C 任务 1 会话表化：open 入表激活
    // （不覆盖其他驻留工作区）、activate 显式切换、close 带 id 出表/无参关活跃——
    // 语义与 main session 同构（错误文案逐字对齐）。——
    async onlineWorkspaceOpen(input: OnlineWorkspaceOpenInput): Promise<OnlineWorkspaceView> {
      requireOnlineUser();
      onlineSessions.set(input.workspaceId, { id: input.workspaceId, name: input.name, myRole: input.myRole });
      onlineActiveId = input.workspaceId;
      return onlineWorkspaceView();
    },

    async onlineWorkspaceActivate(workspaceId: string): Promise<void> {
      if (!onlineUser || !onlineSessions.has(workspaceId)) throw new Error("尚未打开在线工作区");
      onlineActiveId = workspaceId;
    },

    async onlineWorkspaceClose(input?: { workspaceId?: string }): Promise<void> {
      const target = input?.workspaceId ?? onlineActiveId;
      if (target === null || !onlineSessions.delete(target)) return;
      if (onlineActiveId === target) onlineActiveId = null; // 不自动切其他驻留工作区
    },

    async onlineTreeView(workspaceId: string): Promise<OnlineWorkspaceView> {
      if (!onlineUser || onlineActiveId !== workspaceId || !onlineSessions.has(workspaceId)) {
        throw new Error("尚未打开在线工作区");
      }
      return onlineWorkspaceView();
    },

    async onlineMigrateScan(dir: string): Promise<OnlineMigrateScanResult> {
      return { files: scanDirFiles(dir) };
    },

    async onlineMigrateWrite(input: OnlineMigrateWriteInput): Promise<{ written: string[] }> {
      return { written: writeFiles(input.dir, input.files) };
    },

    // 迁移映射桥替身（计划 C 任务 2，服务端同语义简化建模）：替身工作区只有种子组/项目——
    // 命中种子目录返回对应实体行（created=false 解析命中，幂等）；未知目录一律 missing:true
    //（不建模按需建实体——真服 createIfMissing 语义由真服 E2E 覆盖）；forbidden 行为真服
    // 越权语义，替身 OWNER 登录态不产出（store 侧三态换算由测试覆写桩钉住）。
    // 名称按服务端 ProjectMappingService 同语义 **trim() 后解析并回显**（审查重要 1：回显名
    // ≠ 本地原名是换算按名回查 miss 的缺陷场景锚点，替身必须同构才能复现/守卫该缺陷）。
    async onlineProjectMapping(input: OnlineProjectMappingInput): Promise<OnlineMappingResult> {
      requireOnlineUser();
      return {
        mappings: input.entries.map((entry) => {
          const group = entry.group.trim();
          const project = entry.project.trim();
          return group === "示例分组" && project === "示例项目"
            ? { group, project, groupId: ONLINE_SEED_GROUP_ID, projectId: ONLINE_SEED_PROJECT_ID, created: false }
            : { group, project, missing: true };
        }),
      };
    },

    async onlineGroupsList(_workspaceId: string): Promise<OnlineGroup[]> {
      requireOnlineUser();
      return onlineGroupsRows().map((g) => ({ ...g }));
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

    // 退出程序 dirty 拦截（计划 C 任务 6）：登记 no-op——jsdom/浏览器调试无 main 关窗
    // 询问链路，聚合 dirty 的真实计算在组合根（App.vue），preload 才是 main↔渲染层桥。
    onDirtyCheck(_handler: () => boolean): void {
      void _handler;
    },

    /** 预置 分组/项目/集合/接口 各一（未打开工作区时先在内存中初始化默认工作区），并落盘。 */
    seedWorkspace(): void {
      if (seeded || pendingSeed) return;
      seeded = true;
      pendingSeed = (async () => {
        const view = await session.create(root, "内存工作区");
        problems = [];
        const workspaceLocator: WorkspaceLocator = { workspaceId: view.workspace.id };
        // The default group is intentionally immutable in the formal session contract. Seed the
        // sample project in a separate named group instead of renaming that protected node.
        const group = await session.createGroup(workspaceLocator, "示例分组");
        const groupLocator: GroupLocator = { ...workspaceLocator, groupId: group.id };
        const project = await session.createProject(groupLocator, "示例项目");
        const projectLocator: ProjectLocator = { ...groupLocator, projectId: project.id };
        const collection = await session.createCollection(projectLocator, "示例集合");
        await session.createApi({ ...projectLocator, collectionId: collection.id }, {
          name: "示例接口", method: "GET", path: "/", baseUrl: "http://127.0.0.1",
        });
        await session.createGroup(workspaceLocator, "默认分组");
      })().catch((error: unknown) => {
        seeded = false;
        throw error;
      });
    },
  };
}
