import { randomUUID } from "node:crypto";
import type { ProjectSnapshot } from "../assets/snapshot.js";
import { createEventBus } from "../events/bus.js";
import { createHttpSession, type HttpSession } from "../http/session.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { CaseOutcome } from "../report/types.js";
import { prepareCaseExecution } from "../runner/caseExecutor.js";
import { captureProjectExecutionRun, CollectionRunError, CollectionRunner, type ProjectExecutionRun, type RunnerOptions } from "../runner/runner.js";
import { WorkflowRunner } from "../workflow/runner.js";
import { resolveSuitePlan, suiteCaseRequests, validateSuiteData, type ResolvedSuitePlan } from "./selection.js";
import { bindPreparedTestData, readPreparedCaseData } from "./data.js";

export interface SuiteCaseOutcome extends CaseOutcome { suiteRunId: string; entryId: string; suiteRow?: number; definitionRevision: string }
export interface SuiteEntryResult {
  workflowId?: string;
  caseLocator?: import("../runner/caseExecutor.js").CaseExecutionLocator;
  entryId: string;
  kind: "case" | "workflow";
  suiteRow?: number;
  status: "passed" | "failed" | "skipped" | "aborted";
  skipReason?: "fail-fast" | "aborted";
  error?: string;
  cases: SuiteCaseOutcome[];
}
export interface SuiteRunResult {
  kind: "suite";
  suiteRunId: string;
  projectId: string;
  suiteId: string;
  suiteName: string;
  definitionRevision: string;
  environmentId?: string;
  datasetId?: string;
  dataDigest: string;
  allowDraft: boolean;
  startedAt: string;
  finishedAt: string;
  verdict: "passed" | "failed" | "aborted";
  /** Entry/outer-round counts, independent of actual case rows. */
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  entries: SuiteEntryResult[];
  cases: SuiteCaseOutcome[];
  warnings: string[];
}
export interface SuiteRunnerOptions {
  workspaceRoot?: string;
  signal?: AbortSignal;
  observeCaseExecution?: (execution: Parameters<NonNullable<RunnerOptions["observeCaseExecution"]>>[0], identity: Parameters<NonNullable<RunnerOptions["observeCaseExecution"]>>[1] & { suiteRunId: string; entryId: string; suiteRow?: number; nodeId?: string }) => void | Promise<void>;
}

/** Shared preflight for run hosts: call before credential/OAuth preparation. */
export function validateSuiteExecution(snapshot: ProjectSnapshot, plan: ResolvedSuitePlan, registry: PluginRegistry): ResolvedSuitePlan {
  const actual = resolveSuitePlan(snapshot, plan.suiteId, { environmentId: plan.environmentId, datasetId: plan.datasetId, failFast: plan.failFast, allowDraft: plan.allowDraft, reporters: plan.reporters });
  if (JSON.stringify(actual) !== JSON.stringify(plan)) throw new Error("套件计划与当前快照不匹配");
  if (!registry.getScriptEngine("javascript")) throw new Error("缺少 javascript 脚本引擎插件");
  for (const { asset, testCase } of suiteCaseRequests(snapshot, plan)) {
    const prepared = prepareCaseExecution(testCase, snapshot.context, asset.contract.id, (op) => registry.getAssert(op));
    if (prepared.assertions.diagnostics.length || prepared.extractionError) throw new Error("套件用例声明式断言或提取配置无效");
  }
  return actual;
}

export class SuiteRunner {
  constructor(private readonly deps: { registry: PluginRegistry; createSession?: () => HttpSession }) {}

  async run(run: ProjectExecutionRun, plan: ResolvedSuitePlan, options: SuiteRunnerOptions = {}): Promise<SuiteRunResult> {
    const execution = captureProjectExecutionRun(run);
    plan = validateSuiteExecution(execution.snapshot, plan, this.deps.registry);
    if (!execution.preparedTestData) throw new Error("套件运行需要已准备的数据快照");
    const data = bindPreparedTestData(execution.snapshot, execution.preparedTestData);
    const preview = validateSuiteData(plan, data);
    for (const selection of plan.selections) readPreparedCaseData(execution.snapshot, data, selection.locator);
    const suiteRunId = randomUUID(); const startedAt = new Date().toISOString();
    const entries: SuiteEntryResult[] = []; const cases: SuiteCaseOutcome[] = []; const warnings: string[] = [];
    let stopped: "fail-fast" | "aborted" | undefined;
    for (let round = 0; round < preview.outerRows; round++) {
      const suiteRow = plan.datasetId === undefined ? undefined : round;
      for (const entry of plan.entries) {
        if (options.signal?.aborted) stopped = "aborted";
        const provenance = entry.kind === "workflow" ? { workflowId: entry.workflowId } : { caseLocator: entry.cases[0]?.locator };
        if (stopped) { entries.push({ entryId: entry.id, kind: entry.kind, ...provenance, ...(suiteRow === undefined ? {} : { suiteRow }), status: "skipped", skipReason: stopped, cases: [] }); continue; }
        const result: SuiteEntryResult = { entryId: entry.id, kind: entry.kind, ...provenance, ...(suiteRow === undefined ? {} : { suiteRow }), status: "passed", cases: [] };
        const session = (this.deps.createSession ?? createHttpSession)();
        const observer = options.observeCaseExecution === undefined ? undefined : (value: Parameters<NonNullable<RunnerOptions["observeCaseExecution"]>>[0], identity: Parameters<NonNullable<RunnerOptions["observeCaseExecution"]>>[1] & { nodeId?: string }) => options.observeCaseExecution!(value, { ...identity, suiteRunId, entryId: entry.id, ...(suiteRow === undefined ? {} : { suiteRow }) });
        let actual: CaseOutcome[] = [];
        try {
          if (entry.kind === "case") {
            const locator = entry.cases[0]!.locator;
            const runner = new CollectionRunner({ registry: this.deps.registry, bus: createEventBus(), failFast: plan.failFast, timeouts: { connectTimeoutMs: 10000, totalTimeoutMs: 30000, signal: options.signal } });
            const value = await runner.run(execution, locator.collectionId, { environmentId: plan.environmentId, workspaceRoot: options.workspaceRoot, httpSession: session,
              caseSelection: { apiId: locator.apiId, caseId: locator.caseId, folderIds: locator.folderIds, scope: locator.scope }, preparedRowIndex: suiteRow, observeCaseExecution: observer });
            actual = value.cases; warnings.push(...(value.warnings ?? []));
            if (value.failed > 0) result.status = "failed";
          } else {
            const value = await new WorkflowRunner({ registry: this.deps.registry, failFast: plan.failFast }).run(execution, entry.workflowId!, { environmentId: plan.environmentId,
              workspaceRoot: options.workspaceRoot, httpSession: session, signal: options.signal, preparedRowIndex: suiteRow, observeCaseExecution: observer });
            // Noop and unvisited nodes are entry metadata, never fabricated passing case rows.
            actual = value.nodeResults.flatMap((node) => (node.outcomes ?? []).filter((outcome) => outcome.locator !== undefined).map((outcome) => ({ ...outcome, nodeId: node.nodeId })));
            warnings.push(...value.warnings);
            if (value.verdict === "failed" || value.failed > 0) {
              result.status = "failed";
              result.error = value.nodeResults.find((node) => node.state === "failed" && node.error)?.error;
            }
          }
        } catch (error) {
          if (error instanceof CollectionRunError) { actual = error.partialResult.cases; warnings.push(...(error.partialResult.warnings ?? [])); }
          result.status = options.signal?.aborted ? "aborted" : "failed";
          result.error = error instanceof Error ? error.message : String(error);
        } finally {
          try { await session.close(); } catch { warnings.push("套件条目会话关闭失败"); }
        }
        if (options.signal?.aborted || actual.some((outcome) => outcome.failureKind === "aborted")) { result.status = "aborted"; stopped = "aborted"; }
        result.cases = actual.map((outcome) => ({ ...outcome, suiteRunId, entryId: entry.id, ...(suiteRow === undefined ? {} : { suiteRow }), definitionRevision: plan.definitionRevision }));
        cases.push(...result.cases); entries.push(result);
        if (result.status === "failed" && plan.failFast) stopped = "fail-fast";
      }
    }
    const failed = entries.filter((entry) => entry.status === "failed" || entry.status === "aborted").length;
    return { kind: "suite", suiteRunId, projectId: plan.projectId, suiteId: plan.suiteId, suiteName: plan.suiteName, definitionRevision: plan.definitionRevision,
      ...(plan.environmentId === undefined ? {} : { environmentId: plan.environmentId }), ...(plan.datasetId === undefined ? {} : { datasetId: plan.datasetId }), dataDigest: data.digest, allowDraft: plan.allowDraft,
      startedAt, finishedAt: new Date().toISOString(), verdict: stopped === "aborted" ? "aborted" : failed ? "failed" : "passed",
      total: entries.length, passed: entries.filter((entry) => entry.status === "passed").length, failed, skipped: entries.filter((entry) => entry.status === "skipped").length, entries, cases, warnings };
  }
}
