import type { ApiAsset, CaseOutcome, Environment, PluginRegistry, Project, ProjectSnapshot, RunResult } from "@apicc/core";
import { CollectionRunner, createDefaultRegistry, createEventBus, createHttpSession, createProjectSnapshot, resolveExecutionEnvironment, selectEffectiveCases } from "@apicc/core";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { findSnapshotApi, resolveSnapshotEnvironment, workspaceRunsDir } from "./executionContext.js";
export { findSnapshotApi, resolveSnapshotEnvironment, workspaceRunsDir } from "./executionContext.js";
import { createExecutionOutputBoundary, persistExecutionJson } from "./executionOutput.js";
import type { createSession } from "./session.js";
import { createDesktopCredentialHost, type PreparedDesktopExecutionRun } from "./credentials.js";
import type { DebugCredentialHost } from "./credentialHost.js";
import type { DebugInput } from "../shared/types.js";
import type { ResponseSnapshot } from "../shared/types.js";
import { createDebugController } from "./debugController.js";

type Session = ReturnType<typeof createSession>;

/** 默认运行注册中心（内置；M7-B 任务 2 起运行频道由 ipc 层注入插件扩展 registry 覆盖）。 */
const defaultRegistry = createDefaultRegistry();
const timeouts = { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 };

export interface DebugResult { run: RunResult; outcome: CaseOutcome; response?: ResponseSnapshot }

type RegistrySource = PluginRegistry | (() => Promise<PluginRegistry>);

/**
 * 集合运行（任务 6）：完整集合走 CollectionRunner（前置/后置脚本、断言、数据驱动、
 * 环境继承语义与 CLI 一致），结果固定落盘到工作区 `.apicc/runs` 供历史读回。
 * registry 可注入（M7-B 任务 2）：ipc 层传插件运行时 registry（内置 + 插件贡献），
 * 缺省内置注册中心（既有测试零扰动）。
 */
export async function runCollection(
  session: Session,
  input: import("../shared/types.js").RunCollectionInput,
  registrySource: RegistrySource = defaultRegistry,
  credentials: Pick<ReturnType<typeof createDesktopCredentialHost>, "prepareRunForRequests"> = createDesktopCredentialHost(session),
): Promise<RunResult> {
  const captured = {
    locator: { ...input.locator },
    envName: input.envName ?? undefined,
  };
  const loc = session.locateCollection(captured.locator);
  if (!loc) throw new Error(`未找到集合: ${JSON.stringify(captured.locator)}`);
  const root = session.root!;
  const snapshot = createProjectSnapshot(loc.project);
  const collection = snapshot.project.collections.find((candidate) => candidate.id === captured.locator.collectionId);
  if (!collection) throw new Error(`未找到集合: ${JSON.stringify(captured.locator)}`);
  const env = resolveSnapshotEnvironment(snapshot.project, captured.envName);
  const executionEnvironment = resolveExecutionEnvironment(snapshot.project, collection.id, env?.id);
  const selectedAssets = collectCollectionApis(collection).filter((asset) =>
    selectEffectiveCases(asset.cases, executionEnvironment.chain).length > 0);
  const credentialSelections = selectedAssets.flatMap((asset) =>
    selectEffectiveCases(asset.cases, executionEnvironment.chain).map((testCase) => ({ asset, testCase })));
  let prepared: PreparedDesktopExecutionRun;
  try {
    prepared = await credentials.prepareRunForRequests({
      workspaceId: captured.locator.workspaceId,
      groupId: captured.locator.groupId,
      projectId: captured.locator.projectId,
    }, snapshot, credentialSelections, {
      workspaceRoot: root,
      ...(env === undefined ? {} : { environmentId: env.id }),
    });
  } catch (error) {
    throw createExecutionOutputBoundary([]).error(error);
  }
  const boundary = createExecutionOutputBoundary(prepared.markers);
  const httpSession = createHttpSession();
  try {
    const registry = typeof registrySource === "function" ? await registrySource() : registrySource;
    const runner = new CollectionRunner({ registry, bus: createEventBus(), timeouts, failFast: false });
    const result = await runner.run(prepared.run, collection.id, {
      ...(env ? { environmentId: env.id } : {}),
      workspaceRoot: root,
      httpSession,
    });
    const filename = `run-${collection.id}-${randomUUID()}.json`;
    const persisted = persistExecutionJson(
      join(workspaceRunsDir(root), filename),
      result,
      boundary,
      (error) => `集合运行报告落盘失败（${join(workspaceRunsDir(root), filename)}）: ${error instanceof Error ? error.message : String(error)}`,
    );
    return persisted.value;
  } catch (error) {
    throw boundary.error(error);
  } finally {
    await httpSession.close();
  }
}
function collectCollectionApis(collection: ProjectSnapshot["project"]["collections"][number]): ApiAsset[] {
  const result = [...collection.apis] as ApiAsset[];
  const visit = (folders: typeof collection.folders): void => {
    for (const folder of folders) {
      result.push(...folder.apis as ApiAsset[]);
      visit(folder.folders);
    }
  };
  visit(collection.folders);
  return result;
}

/**
 * 按环境名解析项目环境（审查修复）：envName 为 undefined/空 = 无环境运行；
 * 提供了 envName 却未命中时显式抛「未找到环境」——静默降级为无环境运行会让用户
 * 误信已按所选环境完成验证（与 session「未找到」错误契约对齐）。
 * 导出复用（M2-D3 任务 1）：stress.ts 的环境解析与此同源，不复制实现。
 */
export function resolveEnv(project: Project, envName: string | undefined): Environment | undefined {
  if (!envName) return undefined;
  const env = project.environments.find((e) => e.name === envName);
  if (!env) throw new Error(`未找到环境: ${envName}`);
  return env;
}

/** 调试 = 在原集合上通过 caseSelection 执行指定接口/用例，保留完整 Runner 语义
 * （前置/后置脚本、断言、变量解析；规格 §7.1）。registry 可注入（M7-B 任务 2）：
 * ipc 层传插件运行时 registry，缺省内置（既有测试零扰动）。 */
export async function sendDebug(
  session: Session,
  input: DebugInput,
  registrySource: RegistrySource = defaultRegistry,
  credentials: DebugCredentialHost = createDesktopCredentialHost(session),
  controller = createDebugController(session, registrySource, credentials),
  owner: object = {},
): Promise<DebugResult> {
  const capturedInput = {
    locator: { ...input.locator, folderIds: [...input.locator.folderIds] },
    caseId: input.caseId,
    envName: input.envName ?? undefined,
  };
  const loc = session.locateApi(capturedInput.locator);
  if (!loc) throw new Error(`未找到接口: ${JSON.stringify(capturedInput.locator)}`);
  const snapshot = createProjectSnapshot(loc.project);
  const asset = findSnapshotApi(snapshot, capturedInput.locator);
  const collection = snapshot.project.collections.find((candidate) => candidate.id === capturedInput.locator.collectionId)!;
  const env = resolveSnapshotEnvironment(snapshot.project, capturedInput.envName);
  const executionEnvironment = resolveExecutionEnvironment(snapshot.project, collection.id, env?.id);
  if (!asset.cases.some((candidate) => candidate.id === capturedInput.caseId)) {
    throw new Error(`用例不存在: ${capturedInput.caseId}`);
  }
  const target = selectEffectiveCases(asset.cases, executionEnvironment.chain, capturedInput.caseId)[0];
  if (!target) {
    const why = env ? `当前环境「${env.name}」的继承链不含该 scope` : "未选择环境";
    throw new Error(`用例「${capturedInput.caseId}」不适用于当前调试环境（${why}）`);
  }
  const { runId } = controller.start(owner, {
    mode: "case",
    locator: capturedInput.locator,
    ...(env === undefined ? {} : { environmentId: env.id }),
    case: { ...capturedInput.locator, caseId: target.id, scope: target.scope },
  });
  let terminalFailureKind: string | undefined;
  try {
    const result = await controller.wait(owner, runId);
    const outcomes = result.outcomes.map(toLegacyOutcome);
    const outcome = outcomes[0];
    if (!outcome) {
      terminalFailureKind = result.failureKind;
      const message = result.error ?? (result.failureKind === "aborted"
        ? "Debug execution was aborted."
        : "Debug execution ended without a case outcome.");
      const error = new Error(message);
      if (result.errorName !== undefined) error.name = result.errorName;
      throw error;
    }
    if (result.run.identityAvailable !== true || result.run.collectionId === undefined) {
      throw new Error("Debug result identity was withheld by safe projection.");
    }
    const run: RunResult = {
      collectionId: result.run.collectionId,
      collectionName: result.run.collectionName,
      ...(result.run.envName === undefined ? {} : { envName: result.run.envName }),
      startedAt: result.run.startedAt,
      finishedAt: result.run.finishedAt,
      total: result.run.total,
      passed: result.run.passed,
      failed: result.run.failed,
      ...(result.run.skipped === undefined ? {} : { skipped: result.run.skipped }),
      cases: outcomes,
      ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }),
    };
    const lastResponse = result.exchanges.slice().reverse().find((exchange) => exchange.response)?.response;
    const response: ResponseSnapshot | undefined = lastResponse === undefined ? undefined : {
      status: lastResponse.status,
      headers: Object.fromEntries(lastResponse.headers.map(([name, value]) => [name.toLowerCase(), value])),
      bodyText: lastResponse.body.kind === "text" ? lastResponse.body.text : "",
      timeMs: result.exchanges.slice().reverse().find((exchange) => exchange.response)?.durationMs ?? 0,
    };
    return { run, outcome, ...(response === undefined ? {} : { response }) };
  } catch (error) {
    const safeError = createExecutionOutputBoundary([]).error(error);
    if (terminalFailureKind !== undefined) {
      Object.defineProperty(safeError, "failureKind", {
        value: terminalFailureKind,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    throw safeError;
  }
}

function toLegacyOutcome(outcome: import("@apicc/core").DebugOutcome): CaseOutcome {
  if (!outcome.identityAvailable || outcome.apiId === undefined || outcome.caseId === undefined) {
    throw new Error("Debug result identity was withheld by safe projection.");
  }
  return {
    apiId: outcome.apiId,
    apiName: outcome.apiName,
    caseId: outcome.caseId,
    caseName: outcome.caseName,
    ...(outcome.row === undefined ? {} : { row: outcome.row }),
    passed: outcome.passed,
    ...(outcome.skipped === undefined ? {} : { skipped: outcome.skipped }),
    ...(outcome.skipReason === undefined ? {} : { skipReason: outcome.skipReason }),
    durationMs: outcome.durationMs,
    assertions: outcome.assertions,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...(outcome.failureKind === undefined ? {} : { failureKind: outcome.failureKind }),
  };
}
