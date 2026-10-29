import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import type { ArrivalPolicy } from "./arrivalPolicy.js";
import type { ProjectExecutionRun } from "../runner/runner.js";
import { compileWorkflowPlan, validateWorkflowPlanData, validateWorkflowRunOptions, workflowPlanRequests, type CompiledWorkflowPlan, type WorkflowPlanRequestSelection } from "../workflow/plan.js";
import type { PreparedCaseSelection } from "../testing/dataModel.js";
import { StressPlanSchema, StressMetricBudgetsSchema, type StressLifecycleRole, type StressMetricPlan, type StressPlan, type StressSchedule } from "./plan.js";
import { z } from "zod";
import { findProjectApi } from "../workflow/references.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../domain/executionSelection.js";
import { getEffectiveCaseRequest } from "../request/effective.js";
import { bindPreparedTestData, preparedCaseKey, readPreparedCaseData } from "../testing/data.js";
import { collectCredentialRefsForRequests, selectCredentialRequests } from "../credentials/output.js";
import { normalizeStressOrigin, normalizeStressPolicy } from "./safety.js";
import type { JsonValue } from "../contract/schemaNode.js";
import type { ExecutableRequest } from "../plugin/types.js";
import type { CaseExecutionLocator } from "../runner/caseExecutor.js";
import type { createExecutionEvidenceCollector } from "../report/evidence.js";
import type { StressFailureKind, StressThresholds, StressSafetyTarget } from "./model.js";
import type { StressPhase } from "./plan.js";
import type { StressReportV2, StressCompleteness, StressCompletenessReason, StressLifecycleSummary, StressLoadSummary } from "./reportV2.js";

export interface CompiledStressTarget {
  readonly role: "target" | StressLifecycleRole;
  readonly workflowId?: string;
  readonly requests: readonly WorkflowPlanRequestSelection[];
  readonly dataSelections: readonly PreparedCaseSelection[];
}
export interface CompiledStressPlan {
  readonly projectId: string; readonly definitionRevision: string;
  readonly plan: DeepReadonly<StressPlan>; readonly targets: readonly CompiledStressTarget[];
  readonly workflowPlans: readonly CompiledWorkflowPlan[];
  readonly schedule: StressSchedule; readonly metricPlan: StressMetricPlan;
}
export interface PreparedStressExecution { readonly compiled: CompiledStressPlan; readonly run: ProjectExecutionRun }
const owners = new WeakMap<CompiledStressPlan, ProjectSnapshot>();
const preparedOwners = new WeakSet<PreparedStressExecution>();
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export interface StressCompileOptions {
  limits?: { maxVus: number; maxRequestConcurrency: number; maxRps: number };
  evidenceLimits?: import("../report/evidence.js").EvidenceLimits;
  evidenceMaxSamples?: number;
  numericMemoryBytes?: number;
}
/** Pure preflight over a single immutable snapshot; no capture, I/O, clock, or run identity. */
export function compileStressPlan(snapshot: ProjectSnapshot, input: StressPlan, options: StressCompileOptions = {}): CompiledStressPlan {
  const plan = StressPlanSchema.parse(input);
  const budgets = StressMetricBudgetsSchema.parse({ memory: { maxNumericBytes: options.numericMemoryBytes ?? 67108864 },
    evidence: { maxSamples: options.evidenceMaxSamples ?? 20, bodyBytes: 65536, valueBytes: 4096, caseBytes: 262144, reportBytes: 16777216, ...options.evidenceLimits } });
  const limits = options.limits === undefined ? undefined : z.object({ maxVus: z.number().int().min(1).max(1000),
    maxRequestConcurrency: z.number().int().min(1).max(1000), maxRps: z.number().finite().positive() }).strict().parse(options.limits);
  if (limits && (plan.maxVus > limits.maxVus || (plan.maxRequestConcurrency ?? 0) > limits.maxRequestConcurrency || (plan.maxRps ?? 0) > limits.maxRps)) throw new Error("Stress plan exceeds host capacity limits");
  const targets: CompiledStressTarget[] = []; const workflowPlans: CompiledWorkflowPlan[] = [];
  const addWorkflow = (role: CompiledStressTarget["role"], workflowId: string) => {
    const compiled = compileWorkflowPlan(snapshot, workflowId, { environmentId: plan.environmentId });
    workflowPlanRequests(snapshot, compiled);
    workflowPlans.push(compiled);
    const requests = compiled.selections;
    targets.push({ role, workflowId, requests, dataSelections: requests.map((selection) => ({ locator: {
      collectionId: selection.collectionId, folderIds: [...selection.folderIds], apiId: selection.apiId, caseId: selection.caseId, scope: selection.scope,
    } })) });
    return compiled;
  };
  let rootParallelism = 1;
  if (plan.target.kind === "case") {
    const target = plan.target; const location = findProjectApi(snapshot.project, target.apiId);
    if (!location || location.collection.id !== target.collectionId) throw new Error("Stress case target is outside the project collection");
    const environment = resolveExecutionEnvironment(snapshot.project, location.collection.id, plan.environmentId);
    const cases = selectEffectiveCases(location.api.cases, environment.chain, target.caseId);
    if (cases.length !== 1) throw new Error("Stress case target is missing or ambiguous");
    const selected = cases[0]!;
    const selection: WorkflowPlanRequestSelection = { asset: location.api, testCase: selected, collectionId: location.collection.id,
      folderIds: location.folders.map((folder) => folder.id), apiId: target.apiId, caseId: selected.id, scope: selected.scope };
    targets.push({ role: "target", requests: [selection], dataSelections: [{ locator: {
      collectionId: selection.collectionId, folderIds: [...selection.folderIds], apiId: selection.apiId, caseId: selection.caseId, scope: selection.scope,
    } }] });
  } else {
    const compiled = addWorkflow("target", plan.target.workflowId);
    const root = compiled.workflows.find((workflow) => workflow.id === compiled.rootWorkflowId)!;
    rootParallelism = root.executionVersion === 2 ? root.limits.maxConcurrency : 1;
  }
  for (const role of ["setup", "vuSetup", "vuTeardown", "teardown"] as const) {
    const step = plan.lifecycle?.[role];
    if (!step) continue;
    const compiled = addWorkflow(role, step.workflowId);
    const workflow = compiled.workflows.find((item) => item.id === step.workflowId)!;
    validateWorkflowRunOptions(workflow, step.inputs === undefined ? {} : { inputs: step.inputs });
    if ("outputs" in step && step.outputs) {
      const mapping = step.outputs;
      if (workflow.executionVersion !== 2 || Object.keys(mapping).some((key) => !Object.hasOwn(workflow.outputs, key))) throw new Error("Lifecycle output mapping references an undeclared output");
      if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) throw new Error("Lifecycle output mapping has duplicate input destinations");
    }
  }
  if (plan.target.kind === "workflow") {
    const root = workflowPlans[0]!.workflows.find((workflow) => workflow.id === workflowPlans[0]!.rootWorkflowId)!;
    const mappings = [plan.lifecycle?.setup?.outputs ?? {}, plan.lifecycle?.vuSetup?.outputs ?? {}];
    const supplied = { ...(plan.target.inputs ?? {}) };
    for (const mapping of mappings) for (const destination of Object.values(mapping)) {
      if (root.executionVersion !== 2 || !Object.hasOwn(root.inputs, destination)) throw new Error("Lifecycle mapping targets an undeclared workflow input");
      supplied[destination] = null; // Presence only: actual mapped values are checked before VU initialization.
    }
    validateWorkflowRunOptions(root, root.executionVersion === 2 ? { inputs: supplied } : plan.target.inputs === undefined ? {} : { inputs: plan.target.inputs });
  }
  const snapshotPolicy = snapshot.project.stressPolicy;
  const policy = normalizeStressPolicy({ ...snapshotPolicy, trustedOrigins: [...(snapshotPolicy.trustedOrigins ?? [])], deniedOrigins: [...(snapshotPolicy.deniedOrigins ?? [])] });
  const defaultConcurrency = Math.min(1000, plan.maxVus * rootParallelism);
  if (plan.maxRequestConcurrency !== undefined && policy.maxConcurrency !== undefined && plan.maxRequestConcurrency > policy.maxConcurrency) throw new Error("Stress request concurrency exceeds project policy");
  if (plan.maxRps !== undefined && policy.maxRps !== undefined && plan.maxRps > policy.maxRps) throw new Error("Stress maxRps exceeds project policy");
  for (const target of targets) for (const selection of target.requests) {
    const request = getEffectiveCaseRequest(selection.asset, selection.testCase);
    if (request.protocol !== "http") throw new Error("Stress scenarios require HTTP throughout the target and lifecycle closure");
    // Scripts/variables may change the final URL; the request gate reauthorizes every real hop.
    const selectedBaseUrl = resolveExecutionEnvironment(snapshot.project, selection.collectionId, plan.environmentId).baseUrl ?? request.baseUrl;
    if (!selectedBaseUrl.includes("{{")) {
      const origin = normalizeStressOrigin(selectedBaseUrl);
      if (policy.deniedOrigins?.includes(origin)) throw new Error("Stress target denied by project policy");
    }
  }
  const nodes = new Map<string, { workflowId: string; nodeId: string; key: string }>();
  for (const compiled of workflowPlans) for (const workflow of compiled.workflows) for (const node of workflow.nodes) {
    const key = JSON.stringify([workflow.id, node.id]); nodes.set(key, { workflowId: workflow.id, nodeId: node.id, key });
  }
  const metricPlan: StressMetricPlan = {
    stableNodeKeys: [...nodes.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0).slice(0, 512),
    histogram: { minValueMs: 0.001, gamma: 1.01, bucketCount: 4608, exactLimit: 256 },
    timeline: { initialBucketWidthMs: 1000, maxBuckets: 120 }, node: { maxKeys: 512, otherKey: "other" }, error: { maxKeys: 128, otherKey: "other" },
    ...budgets,
  };
  const schedule: StressSchedule = {
    load: plan.load, durationMs: plan.load.kind === "stages" ? plan.load.stages.reduce((sum, stage) => sum + stage.durationMs, 0) : plan.termination.durationMs ?? null,
    maxIterations: plan.termination.maxIterations ?? null, maxVus: plan.maxVus,
    warmupMs: plan.warmupMs, thinkTimeMs: plan.thinkTimeMs, pacingMs: plan.pacingMs, gracefulStopMs: plan.gracefulStopMs, metricPlan,
    requested: { maxRequestConcurrency: plan.maxRequestConcurrency ?? null, maxRps: plan.maxRps ?? null },
    effective: { maxRequestConcurrency: Math.min(plan.maxRequestConcurrency ?? defaultConcurrency, policy.maxConcurrency ?? 1000, limits?.maxRequestConcurrency ?? 1000),
      maxRps: plan.maxRps ?? (policy.maxRps === undefined ? limits?.maxRps ?? null : Math.min(policy.maxRps, limits?.maxRps ?? Infinity)) },
  };
  const compiled: CompiledStressPlan = freeze({ projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, plan, targets, workflowPlans, schedule, metricPlan });
  owners.set(compiled, snapshot); return compiled;
}
/** Bind only after the host has prepared the entire fixed closure against the original snapshot object. */
export function bindPreparedStressExecution(compiled: CompiledStressPlan, input: ProjectExecutionRun): PreparedStressExecution {
  const snapshot = owners.get(compiled);
  if (!snapshot) throw new Error("Compiled stress plan has no compiler owner");
  if (input.snapshot !== snapshot || snapshot.project.id !== compiled.projectId || snapshot.definitionRevision !== compiled.definitionRevision) throw new Error("Stress plan snapshot ownership mismatch");
  if (!input.preparedTestData) throw new Error("Stress execution requires prepared data for its fixed closure");
  const preparedTestData = bindPreparedTestData(snapshot, input.preparedTestData);
  const expected = new Set(compiled.targets.flatMap((target) => target.dataSelections.map((selection) => preparedCaseKey(selection.locator))));
  if (preparedTestData.selections.length !== expected.size || preparedTestData.selections.some((selection) => !expected.has(selection.key))) throw new Error("Prepared data does not match the fixed stress selection closure");
  for (const target of compiled.targets) for (const selection of target.dataSelections) readPreparedCaseData(snapshot, preparedTestData, selection.locator);
  for (const plan of compiled.workflowPlans) validateWorkflowPlanData(snapshot, plan, preparedTestData);
  const requests = selectCredentialRequests(snapshot, compiled.targets.flatMap((target) => [...target.requests]));
  for (const ref of collectCredentialRefsForRequests(snapshot.project, requests)) input.credentialBindings.resolve(ref);
  const run: ProjectExecutionRun = Object.freeze({ snapshot, credentialBindings: input.credentialBindings,
    ...(input.network === undefined ? {} : { network: input.network }), preparedTestData });
  const prepared = Object.freeze({ compiled, run }); preparedOwners.add(prepared); return prepared;
}
/** Runtime entrypoints reject caller-fabricated prepared handles before starting any work. */
export function assertPreparedStressExecution(prepared: PreparedStressExecution): void {
  if (!preparedOwners.has(prepared) || owners.get(prepared.compiled) !== prepared.run.snapshot) throw new Error("Prepared stress execution owner mismatch");
}

export interface StressIterationContext {
  readonly runId: string; readonly vuId: string; readonly iterationId: string; readonly stageId: string | null;
  readonly phase: StressPhase; readonly scheduledOffsetMs: number; readonly signal: AbortSignal;
  /** Legacy opaque admission stops when the launch window closes; real in-flight hops drain normally. */
  readonly admissionSignal?: AbortSignal;
  /** Local host function; remote proxies must explicitly map each event's clock/phase. */
  readonly observation?: () => { readonly phase: StressPhase; readonly atMs: number };
  /** Numeric side channel: metric failures stop the run without entering business assertions. */
  readonly observe?: (event: StressMetricEvent) => void;
}
export interface StressIterationResult { readonly state: "passed" | "failed" | "aborted"; readonly durationMs: number }
interface StressMetricEventIdentity {
  readonly phase: StressPhase; readonly stageId: string | null; readonly atMs: number;
  readonly vuId?: string; readonly iterationId?: string;
}
/** Only numbers, qualification flags and stable identities; raw execution is never a metric payload. */
export type StressMetricEvent = StressMetricEventIdentity & (
  | { readonly kind: "case"; readonly ok: boolean; readonly status: number;
      readonly requestStarted: boolean; readonly requestCompleted: boolean; readonly failureKind: StressFailureKind | null;
      readonly requestTimeMs: number; readonly scriptTimeMs: number; readonly iterationTimeMs: number;
      readonly locator: DeepReadonly<CaseExecutionLocator>; readonly nodeKey: string | null }
  | { readonly kind: "http"; readonly started: number; readonly completed: number; readonly nodeKey: string | null }
  | { readonly kind: "node"; readonly nodeKey: string; readonly state: "passed" | "failed" | "aborted" | "skipped" | "noop"; readonly durationMs: number }
  | { readonly kind: "iteration"; readonly started: number; readonly passed: number; readonly failed: number; readonly aborted: number; readonly dropped: number;
      readonly durationMs: number | null; readonly startDelayMs: number | null }
);
export type StressStopReason = "duration" | "iteration-budget" | "user" | "root-abort" | "drain-timeout" | "setup-failed" | "execution-failed";
export interface StressVuSession {
  execute(context: StressIterationContext): Promise<StressIterationResult>;
  close(options: { readonly reason: StressStopReason; readonly signal: AbortSignal; readonly allowNetworkCleanup: boolean }): Promise<void>;
}
export interface StressClock { now(): number; wallNow(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface StressRequestGateOptions {
  readonly maxConcurrency: number; readonly maxRps?: number; readonly clock: StressClock;
  readonly authorizeRequest: (finalRequest: ExecutableRequest) => void | Promise<void>;
}
export interface StressRequestGate {
  enter(request: ExecutableRequest, signal: AbortSignal): Promise<() => void>;
  beforeRedirect(request: ExecutableRequest, signal: AbortSignal): Promise<void>;
  readonly recordTarget?: (target: StressSafetyTarget) => void;
  readonly audit?: () => { readonly targetOrigins: readonly StressSafetyTarget[]; readonly incomplete: boolean; readonly policyLimitedMs: number; readonly policyWaiting?: boolean };
}
export interface StressLifecycleResult {
  readonly state: "passed" | "failed" | "aborted";
  readonly durationMs: number; readonly outputs: Readonly<Record<string, JsonValue>>; readonly failureKind?: StressFailureKind;
}
export interface StressProgress {
  readonly runId: string; readonly state: "preparing" | "ready" | "running" | "stopping" | "finished";
  readonly phase: StressPhase | null; readonly stageId: string | null; readonly atMs: number;
  readonly activeVus: number; readonly startedIterations: number; readonly completedIterations: number; readonly droppedIterations: number;
  readonly requests: StressReportV2["requests"];
  readonly completeness: StressCompleteness;
}
export interface StressExecutionDeps {
  readonly runId: string;
  readonly createVu: (vuId: string, initialInputs: Readonly<Record<string, JsonValue>>, host?: StressVuHostContext) => Promise<StressVuSession>;
  readonly runLifecycle?: (role: StressLifecycleRole, inputs: Readonly<Record<string, JsonValue>>, signal: AbortSignal, host?: StressLifecycleHostContext) => Promise<StressLifecycleResult>;
  /** Local run-owner disposal; awaited before finished on every scheduler exit. */
  readonly closeRun?: () => Promise<void>;
  readonly gate: StressRequestGate; readonly clock: StressClock; readonly metrics: StressAccumulator;
  readonly evidence: ReturnType<typeof createExecutionEvidenceCollector>; readonly signal: AbortSignal;
  readonly onProgress?: (progress: StressProgress) => void;
  readonly timelineUncertaintyMs?: () => number;
  /** Run-local internal admission seam; not a saved plan, worker message or public flag. */
  readonly arrivalPolicy?: ArrivalPolicy;
  readonly execution?: StressHostExecutionConfig;
}
/** Host wiring only; never stored in the pure schedule or serialized to a worker. */
export interface StressHostExecutionConfig {
  readonly targetInputs?: Readonly<Record<string, JsonValue>>;
  readonly lifecycle?: DeepReadonly<StressPlan["lifecycle"]>;
  readonly thresholds?: Readonly<StressThresholds>;
  readonly validateTargetInputs?: (inputs: Readonly<Record<string, JsonValue>>) => void;
}
export interface StressLifecycleHostContext {
  readonly runId: string; readonly signal: AbortSignal;
  readonly gate: StressRequestGate; readonly clock: StressClock;
  readonly observation: () => { readonly phase: StressPhase; readonly atMs: number };
  /** Classify an already observed timestamp on the coordinator's monotonic axis. */
  readonly observationAt?: (atMs: number) => { readonly phase: StressPhase; readonly atMs: number };
  readonly observe: (event: StressMetricEvent) => void;
}
export interface StressVuHostContext extends StressLifecycleHostContext {
  readonly vuId: string;
  /** Exact scheduler capture on this clock axis; never reconstructed using later reads. */
  readonly runStart?: number;
  readonly lifecycle: DeepReadonly<StressPlan["lifecycle"]>;
  /** Called before factory rejection, and retained by the session for teardown.
   * Returns only explicitly mapped initial inputs; outputs are consumed immediately. */
  readonly reportLifecycle: (role: "vuSetup" | "vuTeardown", result: StressLifecycleResult) => Readonly<Record<string, JsonValue>>;
}
export interface StressHistogramSnapshot {
  readonly count: number; readonly sum: number; readonly min: number | null; readonly max: number | null;
  readonly zero: number; readonly underflow: number; readonly overflow: number;
  readonly exact: readonly number[] | null; readonly buckets: readonly number[];
}
export interface StressObservationCounts {
  readonly caseRows: { readonly total: number; readonly ok: number; readonly failed: number; readonly failures: readonly number[] };
  /** Fixed STRESS_FAILURE_KINDS order, restricted to eligible completed requests. */
  readonly eligibleFailureCounts: readonly number[];
  readonly requests: { readonly started: number; readonly completed: number; readonly eligibleCompleted: number; readonly failed: number };
  readonly httpExchanges: { readonly started: number; readonly completed: number };
  readonly statusCounts: readonly { readonly key: string; readonly count: number }[];
  /** Bounded machine keys: failureKind, actual HTTP-failure/status joint key HTTP_n, or other. */
  readonly errorCounts: readonly { readonly key: string; readonly count: number }[];
}
export interface StressObservationSnapshot extends StressObservationCounts {
  readonly requestLatency: StressHistogramSnapshot; readonly scriptLatency: StressHistogramSnapshot; readonly caseLatency: StressHistogramSnapshot;
}
/** Host-only bounded numeric merge state. Workers use observations scope; coordinator owns iteration/load counts. */
export interface StressAggregateSnapshot {
  readonly formatVersion: 1; readonly runId: string; readonly sourceId: string; readonly sequence: number;
  readonly histogramVersion: 1; readonly metricPlan: StressMetricPlan;
  readonly scope: "all" | "observations"; readonly observations: StressObservationSnapshot;
  readonly iterations: { readonly planned: number; readonly started: number; readonly passed: number; readonly failed: number; readonly aborted: number; readonly dropped: number;
    readonly latency: StressHistogramSnapshot; readonly startDelay: StressHistogramSnapshot } | null;
  readonly phases: readonly { readonly phase: StressPhase; readonly stageId: string | null; readonly observations: StressObservationCounts;
    readonly firstObservedOffsetMs: number | null; readonly lastObservedOffsetMs: number | null;
    readonly requestLatency: StressHistogramSnapshot }[];
  readonly timeline: { readonly bucketWidthMs: number; readonly buckets: readonly { readonly startOffsetMs: number;
    readonly observations: StressObservationCounts; readonly requestLatency: StressHistogramSnapshot;
    readonly sources: readonly { readonly phase: StressPhase; readonly stageId: string | null; readonly observations: StressObservationCounts }[] }[] };
  readonly nodes: readonly { readonly key: string; readonly visits: number; readonly passed: number; readonly failed: number; readonly aborted: number; readonly skipped: number;
    readonly observations: StressObservationCounts; readonly requestLatency: StressHistogramSnapshot; readonly nodeLatency: StressHistogramSnapshot }[];
  readonly numericBytes: number; readonly incompleteReasons: readonly StressCompletenessReason[];
}
export interface StressFinishContext {
  readonly startedAt: number; readonly finishedAt: number;
  readonly measurementStartOffsetMs: number | null; readonly measurementEndOffsetMs: number | null;
  readonly stopReason: StressStopReason; readonly plannedIterations: number;
  readonly load: DeepReadonly<StressLoadSummary>; readonly lifecycle: readonly DeepReadonly<StressLifecycleSummary>[];
  readonly completeness: DeepReadonly<StressCompleteness>; readonly thresholds?: Readonly<StressThresholds>;
  readonly phaseWindows?: readonly { readonly phase: StressPhase; readonly stageId: string | null; readonly startOffsetMs: number; readonly endOffsetMs: number }[];
  /** E supplies the maximum real worker anchor uncertainty; omission is for local execution only. */
  readonly timelineUncertaintyMs?: number;
}
export type StressMetricsSummary = DeepReadonly<Pick<StressReportV2,
  "totalRequests" | "ok" | "failed" | "durationMs" | "rps" | "latency" | "statusDist" | "errorKinds" | "startedAt" | "finishedAt" |
  "failures" | "eligibleFailureCounts" | "scriptLatency" | "iterationLatency" | "verdict" | "iterations" | "caseRows" | "requests" |
  "httpExchanges" | "phases" | "timeline" | "nodes" | "load" | "statistics" | "lifecycle" | "completeness">>;
export interface StressAccumulator {
  observe(event: StressMetricEvent): void;
  /** Bounded read-only numbers; does not finish or consume final-snapshot sequence. */
  readProgress(): { requests: { started: number; completed: number; eligibleCompleted: number; failed: number }; incompleteReasons: readonly StressCompletenessReason[] };
  snapshot(): StressAggregateSnapshot;
  merge(snapshot: StressAggregateSnapshot): void;
  finish(context: StressFinishContext): StressMetricsSummary;
}
