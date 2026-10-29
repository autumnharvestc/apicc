import { join } from "node:path";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
  type PluginRegistry,
  type GeneratorMetricsCollector,
  CurrentStressReportSchema,
  StressSafetyError,
  type StressReport,
  StressPlanSchema, compileStressPlan, bindPreparedStressExecution, createExecutionEvidenceCollector, createPreparedStressHost, createStressRequestGate, createStressAccumulator, runStressPlan,
  type StressClock,
} from "@apicc/core";
import { resolveSnapshotEnvironment, findSnapshotApi, workspaceRunsDir, prepareDesktopTestData } from "./executionContext.js";
import type { DebugCredentialHost, PreparedDesktopExecutionRun } from "./credentialHost.js";
import { createExecutionOutputBoundary, persistExecutionJson } from "./executionOutput.js";
import { writeStressRunScope } from "./runs.js";
import type { createSession } from "./session.js";
import type { StressRunInput, StressRunOutput, LegacyStressRunInput, StressPlanRunInput, AnyStressRunOutput, StressPlanRunOutput, StressStopInput, StressProgressDTO } from "../shared/types.js";
import { stressTargetIdentity } from "../shared/types.js";

type Session = ReturnType<typeof createSession>;
export type ManagedProtocolClient = ProtocolClient & { close(): Promise<void> };

export interface StressControllerDeps {
  registry?: () => Promise<PluginRegistry>;
  createManagedClient?: (workerId: number, connectionMode: "pooled" | "fresh") => ManagedProtocolClient;
  createGeneratorCollector?: () => GeneratorMetricsCollector;
  writeReport?: (path: string, content: string) => void;
  writeReportScope?: typeof writeStressRunScope;
  onProgress?: (progress: StressProgressDTO, owner?: object) => void;
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
  let active: { controller: AbortController; finished: Promise<AnyStressRunOutput>; runId: string; root: string; projectLocator: StressStopInput["projectLocator"]; owner?: object } | null = null;
  let generation = 0;
  const progress = (runId: string, root: string, projectLocator: StressStopInput["projectLocator"], owner?: object, correlation?: Pick<StressProgressDTO, "invocationId" | "target" | "sourceRoot">) => {
    const capturedGeneration = ++generation; let last = -Infinity, timer: ReturnType<typeof setTimeout> | undefined;
    let pending: import("@apicc/core").StressProgress | undefined, disposed = false;
    const emit = () => {
      timer = undefined; const value = pending; pending = undefined; if (!value) return;
      last = performance.now();
      try { deps.onProgress?.({ ...value, runId, root, projectLocator: { ...projectLocator }, generation: capturedGeneration, ...correlation }, owner); } catch { /* UI transport failure cannot alter execution facts. */ }
    };
    const dispose = () => { disposed = true; if (timer) clearTimeout(timer); timer = undefined; pending = undefined; };
    return Object.assign((value: import("@apicc/core").StressProgress) => {
      if (disposed) return;
      pending = value;
      // Core finished covers resources, but the host still owes persistence and its active slot.
      if (value.state === "finished") { if (timer) clearTimeout(timer); timer = undefined; return; }
      if (performance.now() - last >= 250) { if (timer) clearTimeout(timer); emit(); }
      else timer ??= setTimeout(emit, Math.ceil(250 - (performance.now() - last)));
    }, {
      finish() {
        // A terminal boundary flush is exempt from the regular <=4Hz cumulative stream.
        // Never delay the real completion reply merely to wait for a UI timer.
        if (timer) clearTimeout(timer); emit(); dispose();
      },
      dispose,
    });
  };

  function clearActive(controller: AbortController): void {
    if (active?.controller === controller) active = null;
  }

  function persist(root: string, projectLocator: StressStopInput["projectLocator"], apiId: string, report: StressReport, boundary: ReturnType<typeof createExecutionOutputBoundary>): StressRunOutput {
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
    let saved = !persisted.warning;
    if (saved) { try { (deps.writeReportScope ?? writeStressRunScope)(root, file, projectLocator); } catch { console.warn("压测报告归属旁证落盘失败；安全内存报告已保留"); saved = false; } }
    return {
      ok: true,
      report: persisted.value,
      ...(saved ? { file } : {}),
    };
  }

  function runLegacy(input: LegacyStressRunInput, owner?: object): Promise<StressRunOutput> {
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
    const runId = randomUUID(), projectLocator = { workspaceId: captured.locator.workspaceId, groupId: captured.locator.groupId, projectId: captured.locator.projectId };
    const onProgress = progress(runId, root, projectLocator, owner);
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
      prepared = await prepareDesktopTestData(prepared, [{ asset: api, testCase }], root, env?.id);
      const boundary = createExecutionOutputBoundary(prepared.markers);
      if (controller.signal.aborted) throw new Error("压测准备已取消");

      const registry = await (deps.registry?.() ?? Promise.resolve(createDefaultRegistry()));
      const policy = snapshot.project.stressPolicy;
      let safetyFailure: StressSafetyError | undefined;
      const runner = new StressRunner({
        runId, onProgress,
        evidenceIdentity: { projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, environmentId: env?.id, dataDigest: prepared.run.preparedTestData?.digest },
        evidenceMarkers: prepared.markers,
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
        createWorker: async (workerId, context) => {
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
              resolveSdkProtocol: (request) => registry.getSdkProtocol(request),
              resolveAuth: (type) => registry.getAuth(type) ?? builtinAuthProviders.find((provider) => provider.type === type),
              resolveAssert: (op) => registry.getAssert(op),
              scriptEngine: registry.getScriptEngine("javascript")!,
              workspaceRoot: root,
              requestGate: context?.requestGate,
              httpSession,
              createManagedClient: () => deps.createManagedClient
                ? deps.createManagedClient(workerId, captured.connectionMode ?? "pooled")
                : createHttpClient({ connectionMode: captured.connectionMode }),
            }, {
              workerId,
              runId,
              concurrency: captured.concurrency,
              maxRps: policy?.maxRps,
              confirmedTargetOrigins: captured.confirmedTargetOrigins,
            });
            return {
              gateManaged: workerSession.gateManaged,
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
        return persist(root, projectLocator, api.contract.id, report, boundary);
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
    }).then(output => { onProgress.finish(); return output; }).finally(() => { onProgress.dispose(); clearActive(controller); });
    active = { controller, finished, runId, root, projectLocator, owner };
    return finished;
  }

  function runPlan(input: StressPlanRunInput, owner?: object): Promise<StressPlanRunOutput> {
    if (active) return Promise.reject(new Error("已有压测进行中"));
    const projectLocator = structuredClone(input.projectLocator), plan = StressPlanSchema.parse(input.plan), confirmedTargetOrigins = [...(input.confirmedTargetOrigins ?? [])];
    const located = session.locateProject(projectLocator); if (!located || !session.root) throw new Error("未找到压测项目");
    const root = realpathSync(session.root);
    if (realpathSync(input.root) !== root) throw new Error("压测调用 root 不属于当前工作区");
    const snapshot = createProjectSnapshot(located.project), compiled = compileStressPlan(snapshot, plan);
    const controller = new AbortController(), runId = randomUUID(), onProgress = progress(runId, root, projectLocator, owner, { invocationId: input.invocationId, sourceRoot: input.root, target: stressTargetIdentity(plan.target) });
    const finished = Promise.resolve().then(async (): Promise<StressPlanRunOutput> => {
      const selections = compiled.targets.flatMap((target) => [...target.requests]);
      let prepared = await credentials.prepareRunForRequests(projectLocator, snapshot, selections, { workspaceRoot: root, environmentId: plan.environmentId, signal: controller.signal });
      prepared = await prepareDesktopTestData(prepared, selections, root, plan.environmentId);
      const execution = bindPreparedStressExecution(compiled, prepared.run);
      const evidence = createExecutionEvidenceCollector({ projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, environmentId: plan.environmentId, dataDigest: prepared.run.preparedTestData?.digest }, prepared.markers, { maxSamples: 20 });
      const registry = await (deps.registry?.() ?? Promise.resolve(createDefaultRegistry()));
      const clock: StressClock = { now: () => performance.now(), wallNow: () => Date.now(), sleep(ms, signal) { return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.min(2147000000, Math.max(1, ms))); signal?.addEventListener("abort", abort, { once: true });
      }); } };
      const gate = createStressRequestGate({ clock, maxConcurrency: compiled.schedule.effective.maxRequestConcurrency, maxRps: compiled.schedule.effective.maxRps ?? undefined, authorizeRequest() {} });
      const host = createPreparedStressHost(execution, { registry, evidence, workspaceRoot: root,
        ...(deps.createManagedClient ? { createManagedClient: (id: string) => deps.createManagedClient!(Number(id), plan.connectionMode) } : {}) }, { confirmedTargetOrigins });
      try {
        const report = await runStressPlan(execution, { ...host, runId, clock, gate, metrics: createStressAccumulator(compiled.metricPlan, runId), evidence, signal: controller.signal, onProgress });
        const rejected = gate.audit?.().targetOrigins.find((target) => target.confirmation === "rejected");
        if (rejected) {
          const code = (["invalid_target_origin", "target_confirmation_required", "target_denied", "concurrency_policy_exceeded", "max_rps_policy_exceeded", "invalid_stress_policy"] as const).find((value) => value === rejected.policy);
          if (code) throw new StressSafetyError(code, "压测目标需要本次确认或被项目策略拒绝", rejected.origin);
        }
        const file = `stress-plan-${runId}.json`, boundary = createExecutionOutputBoundary(evidence.markers());
        const persisted = persistExecutionJson(join(workspaceRunsDir(root), file), report, boundary, () => "压测报告落盘失败", deps.writeReport);
        let saved = !persisted.warning;
        if (saved) { try { (deps.writeReportScope ?? writeStressRunScope)(root, file, projectLocator); } catch { console.warn("压测报告归属旁证落盘失败；安全内存报告已保留"); saved = false; } }
        return { ok: true, kind: "plan", runId, report: persisted.value, ...(saved ? { file } : {}) };
      } catch (error) {
        const boundary = createExecutionOutputBoundary(evidence.markers());
        if (error instanceof StressSafetyError) throw new StressSafetyError(error.code, boundary.text(error.message), error.targetOrigin && boundary.text(error.targetOrigin));
        throw boundary.error(error);
      }
    }).then(output => { onProgress.finish(); return output; }).finally(() => { onProgress.dispose(); clearActive(controller); });
    active = { controller, finished, runId, root, projectLocator, owner };
    onProgress({ runId, state: "preparing", phase: null, stageId: null, atMs: 0, activeVus: 0, startedIterations: 0, completedIterations: 0, droppedIterations: 0,
      requests: { started: 0, completed: 0, eligibleCompleted: 0, failed: 0 }, completeness: { execution: { complete: true, reasons: [] }, metrics: { complete: true, reasons: [] }, load: { complete: true, reasons: [] } } });
    return finished;
  }
  function run(input: LegacyStressRunInput, owner?: object): Promise<StressRunOutput>;
  function run(input: StressPlanRunInput, owner?: object): Promise<StressPlanRunOutput>;
  function run(input: StressRunInput, owner?: object): Promise<AnyStressRunOutput>;
  function run(input: StressRunInput, owner?: object): Promise<AnyStressRunOutput> { return "kind" in input ? runPlan(input, owner) : runLegacy(input, owner); }

  async function stop(input?: StressStopInput, owner?: object): Promise<AnyStressRunOutput> {
    if (!active) throw new Error("没有进行中的压测");
    if (active.owner !== owner || input && (active.runId !== input.runId || active.root !== input.root || active.projectLocator.workspaceId !== input.projectLocator.workspaceId || active.projectLocator.groupId !== input.projectLocator.groupId || active.projectLocator.projectId !== input.projectLocator.projectId)) throw new Error("压测运行身份不匹配");
    active.controller.abort();
    return active.finished;
  }

  function abortActive(): void {
    active?.controller.abort();
  }

  return { run, stop, abortActive };
}
