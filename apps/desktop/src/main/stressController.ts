import { join } from "node:path";
import {
  builtinAuthProviders,
  createDefaultRegistry,
  createHttpClient,
  createHttpSession,
  createProjectSnapshot,
  createStressCaseSession,
  resolveExecutionEnvironment,
  selectEffectiveCases,
  StressRunner,
  validateStressRunOptions,
  type ProtocolClient,
  type GeneratorMetricsCollector,
  CurrentStressReportSchema,
  StressSafetyError,
  type StressReport,
} from "@apicc/core";
import { resolveSnapshotEnvironment, findSnapshotApi, workspaceRunsDir } from "./executionContext.js";
import type { DebugCredentialHost, PreparedDesktopExecutionRun } from "./credentialHost.js";
import { createExecutionOutputBoundary, persistExecutionJson } from "./executionOutput.js";
import type { createSession } from "./session.js";
import type { StressRunInput, StressRunOutput } from "../shared/types.js";

type Session = ReturnType<typeof createSession>;
export type ManagedProtocolClient = ProtocolClient & { close(): Promise<void> };

export interface StressControllerDeps {
  createManagedClient?: (workerId: number, connectionMode: "pooled" | "fresh") => ManagedProtocolClient;
  createGeneratorCollector?: () => GeneratorMetricsCollector;
  writeReport?: (path: string, content: string) => void;
}

/**
 * Injected stress-controller body. This module has no production credential-host default;
 * callers must supply the host so renderer memory does not import system credential assembly.
 */
export function createStressControllerWithHost(
  session: Session,
  deps: StressControllerDeps,
  credentials: DebugCredentialHost,
) {
  let active: { controller: AbortController; finished: Promise<StressRunOutput> } | null = null;

  function clearActive(controller: AbortController): void {
    if (active?.controller === controller) active = null;
  }

  function persist(root: string, apiId: string, report: StressReport, boundary: ReturnType<typeof createExecutionOutputBoundary>): StressRunOutput {
    const runsDir = workspaceRunsDir(root);
    const file = `stress-${apiId}-${Date.now()}.json`;
    const path = join(runsDir, file);
    const persisted = persistExecutionJson(
      path,
      report,
      boundary,
      (error) => `压测报告落盘失败（${path}）: ${error instanceof Error ? error.message : String(error)}`,
      deps.writeReport,
    );
    return {
      ok: true,
      report: persisted.value,
      ...(persisted.warning ? {} : { file }),
    };
  }

  function run(input: StressRunInput): Promise<StressRunOutput> {
    if (active) return Promise.reject(new Error("已有压测进行中"));
    const captured = {
      locator: { ...input.locator, folderIds: [...input.locator.folderIds] },
      caseId: input.caseId,
      envName: input.envName ?? undefined,
      concurrency: input.concurrency,
      maxIterations: input.maxIterations ?? undefined,
      durationMs: input.durationMs ?? undefined,
      thresholds: input.thresholds === undefined ? undefined : structuredClone(input.thresholds),
      connectionMode: input.connectionMode,
      confirmedTargetOrigins: input.confirmedTargetOrigins === undefined ? undefined : [...input.confirmedTargetOrigins],
    };
    validateStressRunOptions({
      concurrency: captured.concurrency,
      ...(captured.maxIterations !== undefined ? { maxIterations: captured.maxIterations } : {}),
      ...(captured.durationMs !== undefined ? { durationMs: captured.durationMs } : {}),
    });
    const loc = session.locateApi(captured.locator);
    if (!loc) throw new Error(`未找到接口: ${JSON.stringify(captured.locator)}`);
    const root = session.root!;
    const snapshot = createProjectSnapshot(loc.project);
    const api = findSnapshotApi(snapshot, captured.locator);
    const collection = snapshot.project.collections.find((candidate) => candidate.id === captured.locator.collectionId);
    if (!collection) throw new Error(`未找到集合: ${captured.locator.collectionId}`);
    const env = resolveSnapshotEnvironment(snapshot.project, captured.envName);
    const environment = resolveExecutionEnvironment(snapshot.project, collection.id, env?.id);
    if (!api.cases.some((candidate) => candidate.id === captured.caseId)) throw new Error(`用例不存在: ${captured.caseId}`);
    const testCase = selectEffectiveCases(api.cases, environment.chain, captured.caseId)[0];
    if (!testCase) {
      const why = env ? `当前环境「${env.name}」的继承链不含该 scope` : "未选择环境";
      throw new Error(`用例「${captured.caseId}」不适用于当前压测环境（${why}）`);
    }
    if (api.contract.request.protocol !== "http") {
      throw new Error("桌面压测面板当前仅支持 HTTP 接口（WS/SOAP 压测请使用 CLI run-stress）");
    }

    const controller = new AbortController();
    const finished = Promise.resolve().then(async (): Promise<StressRunOutput> => {
      let prepared: PreparedDesktopExecutionRun;
      try {
        prepared = await credentials.prepareRunForRequests({
          workspaceId: captured.locator.workspaceId,
          groupId: captured.locator.groupId,
          projectId: captured.locator.projectId,
        }, snapshot, [{ asset: api, testCase }], {
          workspaceRoot: root,
          ...(env === undefined ? {} : { environmentId: env.id }),
          signal: controller.signal,
        });
      } catch (error) {
        throw createExecutionOutputBoundary([]).error(error);
      }
      const boundary = createExecutionOutputBoundary(prepared.markers);
      if (controller.signal.aborted) throw new Error("压测准备已取消");

      const registry = createDefaultRegistry();
      const policy = snapshot.project.stressPolicy;
      let safetyFailure: StressSafetyError | undefined;
      const runner = new StressRunner({
        createGeneratorCollector: deps.createGeneratorCollector,
        onSample: (sample) => {
          const target = sample.safety;
          if (!safetyFailure && target?.confirmation === "rejected" && target.policy !== "none") {
            safetyFailure = new StressSafetyError(
              target.policy as ConstructorParameters<typeof StressSafetyError>[0],
              sample.error ?? `目标安全策略拒绝: ${target.origin}`,
              target.origin,
            );
            controller.abort();
          }
        },
        createWorker: async (workerId) => {
          const httpSession = createHttpSession();
          try {
            const workerSession = createStressCaseSession({
              run: prepared.run,
              collectionId: collection.id,
              apiId: api.contract.id,
              caseId: testCase.id,
              ...(env ? { environmentId: env.id } : {}),
            }, {
              resolveProtocol: (request) => registry.getProtocol(request),
              resolveAuth: (type) => registry.getAuth(type) ?? builtinAuthProviders.find((provider) => provider.type === type),
              resolveAssert: (op) => registry.getAssert(op),
              scriptEngine: registry.getScriptEngine("javascript")!,
              workspaceRoot: root,
              httpSession,
              createManagedClient: () => deps.createManagedClient
                ? deps.createManagedClient(workerId, captured.connectionMode ?? "pooled")
                : createHttpClient({ connectionMode: captured.connectionMode }),
            }, {
              workerId,
              concurrency: captured.concurrency,
              maxRps: policy?.maxRps,
              confirmedTargetOrigins: captured.confirmedTargetOrigins,
            });
            return {
              execute: (signal) => workerSession.execute(signal),
              async close() {
                try { await workerSession.close(); }
                finally { await httpSession.close(); }
              },
            };
          } catch (error) {
            await httpSession.close();
            throw error;
          }
        },
      });

      try {
        const report = CurrentStressReportSchema.parse(await runner.run({
          concurrency: captured.concurrency,
          maxIterations: captured.maxIterations,
          durationMs: captured.durationMs,
          signal: controller.signal,
          thresholds: captured.thresholds,
          maxRps: policy?.maxRps,
          connectionMode: captured.connectionMode,
          safetyRun: {
            requestedConcurrency: captured.concurrency,
            effectiveConcurrency: captured.concurrency,
            requestedMaxRps: null,
            effectiveMaxRps: policy?.maxRps ?? null,
            connectionMode: captured.connectionMode ?? "pooled",
          },
        }));
        if (safetyFailure) throw safetyFailure;
        return persist(root, api.contract.id, report, boundary);
      } catch (error) {
        if (error instanceof StressSafetyError) {
          throw new StressSafetyError(
            error.code,
            boundary.text(error.message),
            error.targetOrigin === undefined ? undefined : boundary.text(error.targetOrigin),
          );
        }
        throw boundary.error(error);
      }
    }).finally(() => clearActive(controller));
    active = { controller, finished };
    return finished;
  }

  async function stop(): Promise<StressRunOutput> {
    if (!active) throw new Error("没有进行中的压测");
    active.controller.abort();
    return active.finished;
  }

  function abortActive(): void {
    active?.controller.abort();
  }

  return { run, stop, abortActive };
}
