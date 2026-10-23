import { WorkflowRunner } from "../workflow/runner.js";
import { assertPreparedWorkflowExecution, prepareWorkflowExecution, type PreparedWorkflowExecution } from "../workflow/prepared.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { createExecutionEvidenceCollector } from "../report/evidence.js";
import { JsonValueSchema, StringRecordSchema, type JsonValue } from "../contract/schemaNode.js";
import { assertPreparedStressExecution, type PreparedStressExecution, type StressExecutionDeps, type StressIterationContext, type StressIterationResult, type StressLifecycleHostContext, type StressLifecycleResult, type StressMetricEvent, type StressVuHostContext, type StressVuSession } from "./execution.js";
import { createHttpClient, type ManagedProtocolClient } from "../http/client.js";
import { createHttpSession, type HttpSession } from "../http/session.js";
import type { ExecutableRequest, ProtocolClient } from "../plugin/types.js";
import { assertStressTargetAllowed, isLoopbackStressOrigin, normalizeStressPolicy, StressSafetyError } from "./safety.js";
import { createStressCaseVuSession } from "./caseSession.js";
import { validateWorkflowRunOptions } from "../workflow/plan.js";

/** A parent run or VU owns these; a borrowing target/lifecycle never closes them. */
export interface StressSessionResources { readonly httpSession: HttpSession; readonly client: ManagedProtocolClient }
interface OwnedResources extends StressSessionResources { close(): Promise<void> }
async function createResources(createClient: () => ManagedProtocolClient | Promise<ManagedProtocolClient>): Promise<OwnedResources> {
  const httpSession = createHttpSession();
  let client: ManagedProtocolClient;
  try { client = await createClient(); } catch (error) { await httpSession.close(); throw error; }
  let closing: Promise<void> | undefined;
  return { httpSession, client, close() {
    return closing ??= (async () => {
      try { await client.close(); } finally { await httpSession.close(); }
    })();
  } };
}

export interface StressWorkflowSessionDeps {
  registry: PluginRegistry;
  evidence: ReturnType<typeof createExecutionEvidenceCollector>;
  workspaceRoot?: string;
  resources?: StressSessionResources;
  createManagedClient?: (vuId: string) => ManagedProtocolClient | Promise<ManagedProtocolClient>;
}
export interface StressWorkflowSessionOptions {
  host: StressVuHostContext;
  initialInputs: Readonly<Record<string, JsonValue>>;
  beforeSend?: (request: ExecutableRequest) => void | Promise<void>;
}

async function executeObservedWorkflow(target: PreparedWorkflowExecution, deps: StressWorkflowSessionDeps, resources: StressSessionResources,
  host: StressLifecycleHostContext, inputs: Readonly<Record<string, JsonValue>>, signal: AbortSignal,
  beforeSend?: StressWorkflowSessionOptions["beforeSend"], context?: StressIterationContext): Promise<StressLifecycleResult> {
  const runner = new WorkflowRunner({ registry: deps.registry, workspaceRoot: deps.workspaceRoot });
  const begin = host.clock.now();
  const pending = new Set<string>();
  const observe = context?.observe ?? host.observe;
  const stamp = () => ({ ...(context?.observation ?? host.observation)(), stageId: context?.stageId ?? null,
    ...("vuId" in host ? { vuId: String(host.vuId) } : {}), ...(context ? { iterationId: context.iterationId } : {}) });
  let outputs: Readonly<Record<string, JsonValue>> = {};
  const withOwner = (selected: ProtocolClient | undefined): ProtocolClient | undefined => selected?.sdkProtocol ? {
    ...selected, sdkTransport: resources.client, execute: (input, options) => selected.execute(input, { ...options,
      runtime: { ...options.runtime, pluginTransport: options.runtime?.pluginTransport ?? resources.client,
        pluginRunId: options.runtime?.pluginRunId ?? host.runId, pluginVuId: options.runtime?.pluginVuId ?? ("vuId" in host ? String(host.vuId) : undefined) } }),
  } : undefined;
  try {
    const root = target.plan.workflows.find((flow) => flow.id === target.plan.rootWorkflowId)!;
    const result = await runner.runPrepared(target, { environmentId: target.plan.environmentId, ...(root.executionVersion === 2 ? { inputs } : {}), signal,
      httpSession: resources.httpSession,
      resolveSdkProtocol: (request) => withOwner(deps.registry.getSdkProtocol(request)),
      resolveProtocol: (request) => withOwner(deps.registry.getProtocol(request)) ?? (resources.client.canHandle(request) ? resources.client : undefined),
      beforeSend, requestGate: host.gate, monotonicNow: () => host.clock.now(),
      observeOutputs: context ? undefined : (value) => { outputs = value; },
      observeHttp(event, identity) {
        const key = JSON.stringify([identity?.nodeVisitId ?? identity?.nodeId, identity?.attempt, event.hopIndex]);
        const nodeKey = JSON.stringify([identity?.workflowId ?? root.id, identity?.nodeId ?? ""]);
        if (event.type === "request") { pending.add(key); observe({ kind: "http", ...stamp(), started: 1, completed: 0, nodeKey }); }
        else if (pending.delete(key)) observe({ kind: "http", ...stamp(), started: 0, completed: 1, nodeKey });
      },
      observeCaseExecution(value, identity) {
        const workflowId = identity.invocationPath?.at(-1)?.workflowId ?? root.id;
        deps.evidence.observe(value, { ...identity, workflowId, stressRunId: host.runId,
          ...("vuId" in host ? { vuId: String(host.vuId) } : {}), ...(context ? { iterationId: context.iterationId, stageId: context.stageId } : {}) });
        observe({ kind: "case", ...stamp(), nodeKey: JSON.stringify([workflowId, identity.nodeId]), ok: value.outcome.passed, status: value.response?.status ?? 0,
          requestStarted: value.requestStarted === true, requestCompleted: value.requestCompleted === true,
          failureKind: value.outcome.passed ? null : value.failureKind ?? value.outcome.failureKind ?? "config", requestTimeMs: value.requestTimeMs,
          scriptTimeMs: value.scriptTimeMs, iterationTimeMs: value.iterationTimeMs, locator: value.outcome.locator! });
      },
      observeNodeExecution(value) { observe({ kind: "node", ...stamp(), nodeKey: JSON.stringify([value.workflowId, value.nodeId]), state: value.state, durationMs: value.durationMs }); },
    });
    const state = result.verdict ?? "failed";
    return { state, durationMs: host.clock.now() - begin, outputs: state === "passed" ? outputs : {},
      ...(state !== "passed" ? { failureKind: state === "aborted" ? "aborted" as const : result.nodeResults.find((node) => node.state === "failed")?.failureKind ?? "config" } : {}) };
  } catch (error) {
    return { state: signal.aborted ? "aborted" : "failed", durationMs: host.clock.now() - begin, outputs: {}, failureKind: signal.aborted ? "aborted" : "config" };
  }
}

export function createStressWorkflowSession(target: PreparedWorkflowExecution, deps: StressWorkflowSessionDeps, options: StressWorkflowSessionOptions): StressVuSession {
  assertPreparedWorkflowExecution(target);
  const root = target.plan.workflows.find((flow) => flow.id === target.plan.rootWorkflowId)!;
  validateWorkflowRunOptions(root, root.executionVersion === 2 ? { inputs: options.initialInputs } : Object.keys(options.initialInputs).length ? { inputs: options.initialInputs } : {});
  let owned: Promise<OwnedResources> | undefined;
  const resources = () => deps.resources ? Promise.resolve(deps.resources) : owned ??= createResources(() => deps.createManagedClient?.(options.host.vuId) ?? createHttpClient());
  let running: Promise<StressIterationResult> | undefined;
  let closing: Promise<void> | undefined;
  return {
    execute(context) {
      if (running || closing) return Promise.reject(new Error("Stress workflow VU is busy or closed"));
      running = (async () => {
        const result = await executeObservedWorkflow(target, deps, await resources(), options.host, options.initialInputs, context.signal, options.beforeSend, context);
        return { state: result.state, durationMs: result.durationMs };
      })().finally(() => { running = undefined; });
      return running;
    },
    close() { return closing ??= (async () => { await running?.catch(() => {}); if (owned) await (await owned).close(); })(); },
  };
}

export interface PreparedStressHostDeps extends Omit<StressWorkflowSessionDeps, "resources"> {}
export interface PreparedStressHostOptions {
  confirmedTargetOrigins?: string[];
  authorizeRequest?: (request: ExecutableRequest) => void | Promise<void>;
}

/** Assemble existing prepared runners under one owner per VU and one separate run owner. */
export function createPreparedStressHost(prepared: PreparedStressExecution, deps: PreparedStressHostDeps, options: PreparedStressHostOptions = {}): Pick<StressExecutionDeps, "createVu" | "runLifecycle" | "closeRun"> {
  assertPreparedStressExecution(prepared);
  const { compiled, run } = prepared;
  const handles = new Map(compiled.workflowPlans.map((plan) => [plan.rootWorkflowId,
    prepareWorkflowExecution(run, plan.rootWorkflowId, { environmentId: plan.environmentId, compiledPlan: plan })]));
  const factory = (ownerId: string) => createResources(() => deps.createManagedClient?.(ownerId) ?? createHttpClient({ connectionMode: compiled.plan.connectionMode }));
  let runOwner: Promise<OwnedResources> | undefined;
  let runClose: Promise<void> | undefined;
  const authorize = (host: StressLifecycleHostContext) => async (request: ExecutableRequest) => {
    await options.authorizeRequest?.(request);
    if (request.protocol !== "http") throw new Error("Stress workflow requires HTTP");
    const policy = { ...run.snapshot.project.stressPolicy,
      trustedOrigins: [...(run.snapshot.project.stressPolicy.trustedOrigins ?? [])], deniedOrigins: [...(run.snapshot.project.stressPolicy.deniedOrigins ?? [])] };
    try {
      const decision = assertStressTargetAllowed({ url: request.url, policy, confirmedTargetOrigins: options.confirmedTargetOrigins,
        concurrency: compiled.schedule.effective.maxRequestConcurrency, maxRps: compiled.schedule.effective.maxRps ?? undefined });
      host.gate.recordTarget?.({ origin: decision.targetOrigin, confirmation: decision.confirmation, loopback: decision.loopback,
        policy: decision.confirmation === "project-policy" ? "trusted" : decision.appliedPolicy.maxConcurrency !== undefined || decision.appliedPolicy.maxRps !== undefined ? "explicit-limited" : "none", appliedPolicy: decision.appliedPolicy });
    } catch (error) {
      if (error instanceof StressSafetyError && error.targetOrigin) host.gate.recordTarget?.({ origin: error.targetOrigin, confirmation: "rejected", policy: error.code,
        loopback: isLoopbackStressOrigin(error.targetOrigin), appliedPolicy: normalizeStressPolicy(policy) });
      throw error;
    }
  };
  const lifecycle = (workflowId: string, resources: StressSessionResources, host: StressLifecycleHostContext, inputs: Readonly<Record<string, JsonValue>>, signal: AbortSignal) => {
    const target = handles.get(workflowId);
    if (!target) throw new Error("Lifecycle workflow is outside the fixed prepared closure");
    return executeObservedWorkflow(target, deps, resources, host, inputs, signal, authorize(host));
  };
  return {
    async createVu(vuId, initialInputs, host) {
      if (!host) throw new Error("Prepared stress VU requires a host context");
      const owner = await factory(vuId);
      let session: StressVuSession | undefined;
      try {
        let inputs = initialInputs;
        const setup = compiled.plan.lifecycle?.vuSetup;
        if (setup) {
          const result = await lifecycle(setup.workflowId, owner, host, StringRecordSchema(JsonValueSchema).parse(setup.inputs ?? {}), host.signal);
          inputs = host.reportLifecycle("vuSetup", result);
          if (result.state !== "passed") throw new Error("VU setup failed");
        }
        const target = compiled.plan.target;
        if (target.kind === "workflow") {
          const handle = handles.get(target.workflowId)!;
          const workflow = handle.plan.workflows.find((flow) => flow.id === target.workflowId)!;
          validateWorkflowRunOptions(workflow, workflow.executionVersion === 2 ? { inputs } : {});
          session = createStressWorkflowSession(handle, { ...deps, resources: owner }, { host, initialInputs: inputs, beforeSend: authorize(host) });
        } else {
          const engine = deps.registry.getScriptEngine("javascript"); if (!engine) throw new Error("Missing javascript engine");
          session = createStressCaseVuSession({ run, fixedRun: true, collectionId: target.collectionId, apiId: target.apiId, caseId: target.caseId, environmentId: compiled.plan.environmentId }, {
            managedClient: owner.client, httpSession: owner.httpSession, workspaceRoot: deps.workspaceRoot, resolveProtocol: (request) => deps.registry.getProtocol(request),
            resolveSdkProtocol: (request) => deps.registry.getSdkProtocol(request),
            resolveAuth: (type) => deps.registry.getAuth(type), resolveAssert: (op) => deps.registry.getAssert(op), scriptEngine: engine,
          }, { workerId: Number(vuId), host, evidence: deps.evidence, initialInputs: inputs,
            concurrency: compiled.schedule.effective.maxRequestConcurrency, maxRps: compiled.schedule.effective.maxRps ?? undefined,
            confirmedTargetOrigins: options.confirmedTargetOrigins, authorizeRequest: authorize(host) });
        }
        const selectedSession = session;
        let closing: Promise<void> | undefined;
        return { execute: (context) => selectedSession.execute(context), close(closeOptions) { return closing ??= (async () => {
          try {
            const step = compiled.plan.lifecycle?.vuTeardown;
            if (step && closeOptions.allowNetworkCleanup && !closeOptions.signal.aborted) {
              const result = await lifecycle(step.workflowId, owner, host, StringRecordSchema(JsonValueSchema).parse(step.inputs ?? {}), closeOptions.signal);
              host.reportLifecycle("vuTeardown", result);
            }
          } finally { try { await selectedSession.close(closeOptions); } finally { await owner.close(); } }
        })(); } };
      } catch (error) { try { await session?.close({ reason: "setup-failed", signal: host.signal, allowNetworkCleanup: false }); } finally { await owner.close(); } throw error; }
    },
    async runLifecycle(role, inputs, signal, host) {
      if (!host || (role !== "setup" && role !== "teardown") || runClose) throw new Error("Invalid run lifecycle owner");
      const step = compiled.plan.lifecycle?.[role]; if (!step) throw new Error("Lifecycle step is not in the fixed plan");
      if (signal.aborted) return { state: "aborted", durationMs: 0, outputs: {}, failureKind: "aborted" };
      runOwner ??= factory("run");
      return lifecycle(step.workflowId, await runOwner, host, inputs, signal);
    },
    closeRun() { return runClose ??= (async () => { if (runOwner) await (await runOwner).close(); })(); },
  };
}
