import type { JsonValue } from "../contract/schemaNode.js";
import type { ProjectExecutionRun } from "../runner/runner.js";
import { CollectionRunner, CollectionRunError } from "../runner/runner.js";
import { createEventBus } from "../events/bus.js";
import { mergedEnvVars } from "../domain/envChain.js";
import { compileWorkflowPlan, validateWorkflowRunOptions } from "./plan.js";
import { findProjectApi } from "./references.js";
import { WorkflowRunner, runSingleNode, type NodeResult, type WorkflowRunnerOptions, type WorkflowRunResult } from "./runner.js";
import { evaluateWorkflowPredicate, resolveWorkflowValue, WORKFLOW_MISSING } from "./predicate.js";
import { createWorkflowScope, type WorkflowScope } from "./scope.js";
import { createWorkflowInvocation, createWorkflowNodeIdentity, type WorkflowInvocationIdentity } from "./trace.js";
import type { DeepReadonly } from "../assets/context.js";
import type { WorkflowValue } from "./model.js";
import { validateWorkflowPlanData } from "./plan.js";
import { createHttpSession, type HttpSession } from "../http/session.js";
import { createWorkflowScheduler } from "./scheduler.js";
import { cancellationFailure, createWorkflowDeadline, recoverableWorkflowFailure, waitWorkflowDelay, workflowFailure, workflowRetryDelay, WorkflowPolicyError, type WorkflowFailure } from "./policy.js";

export type WorkflowV2RunOptions = Parameters<WorkflowRunner["run"]>[2];

/** Structured v2 execution, sharing one captured plan, budget and leaf scheduler. */
export async function runWorkflowV2(execution: ProjectExecutionRun, workflowId: string, deps: WorkflowRunnerOptions, options: WorkflowV2RunOptions = {}): Promise<WorkflowRunResult> {
  const environmentId = options.environmentId ?? deps.environmentId;
  const plan = compileWorkflowPlan(execution.snapshot, workflowId, { environmentId, allowDraft: true, strict: deps.strict });
  for (const flow of plan.workflows) for (const node of flow.nodes) {
    if (!["request", "noop", "assign", "delay", "assert", "condition", "subflow", "loop", "parallel"].includes(node.kind)) throw new Error(`v2 ${node.kind} 尚未实现 (unsupported kind ${node.kind})`);
  }
  validateWorkflowPlanData(execution.snapshot, plan, execution.preparedTestData, { preparedRowIndex: options.preparedRowIndex });
  const root = plan.workflows.find((flow) => flow.id === workflowId)!;
  if (root.executionVersion !== 2) throw new Error("Expected v2 workflow");
  validateWorkflowRunOptions(root, options);
  const trace: import("./trace.js").WorkflowTrace = { events: [], truncated: false, totalEvents: 0 };
  const emit = (event: import("./trace.js").WorkflowTraceEvent) => { trace.totalEvents++; if (trace.events.length < 20000) trace.events.push(event); else trace.truncated = true; };
  const requestFacts = { requestStarted: 0, requestCompleted: 0, httpExchanges: 0 };
  const rawOptions = options;
  options = { ...options, observeCaseExecution: async (value, identity) => {
    requestFacts.requestStarted += Number(value.requestStarted === true); requestFacts.requestCompleted += Number(value.requestCompleted === true);
    await rawOptions.observeCaseExecution?.(value, identity);
  }, observeHttp: async (event) => { if (event.type === "request") requestFacts.httpExchanges++; await (rawOptions.observeHttp ?? deps.observeHttp)?.(event); } };
  const project = execution.snapshot.project;
  const env = mergedEnvVars(project.environments.find((item) => item.id === environmentId), project);
  const suppliedSession = options.httpSession ?? deps.httpSession;
  const httpSession = suppliedSession ?? createHttpSession();
  const controller = new AbortController();
  const abort = () => controller.abort(new WorkflowPolicyError("user-abort", "user-abort", options.signal?.reason instanceof Error ? options.signal.reason.message : "Workflow user abort"));
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new WorkflowPolicyError("root-timeout", "root-timeout", "Workflow root timeout")), options.timeoutMs ?? root.limits.timeoutMs);
  const scheduler = createWorkflowScheduler({ maxConcurrency: options.maxConcurrency ?? root.limits.maxConcurrency, signal: controller.signal });
  const makeRunner = (signal: AbortSignal) => new CollectionRunner({ registry: deps.registry, bus: createEventBus(),
    timeouts: { connectTimeoutMs: 10000, totalTimeoutMs: 30000, signal }, failFast: false });
  const rootContext = { signal: controller.signal, httpSession, runner: makeRunner(controller.signal) };
  // Host-owned fork cleanup failures cannot be recovered by any ancestor OR.
  // This evidence belongs to this root only; business failures and cancellations never enter it.
  type SessionCleanupFailure = { invocation: WorkflowInvocationIdentity; branchId: string; error: unknown };
  const sessionCleanupFailures: SessionCleanupFailure[] = [];
  let visits = 0;
  const consumeVisit = () => {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Workflow aborted");
    if (++visits > 10000) {
      // The budget belongs to the root, not the branch that first exhausts it.
      // AbortController latches this first reason and reaches every active scope,
      // queued leaf and handler before another branch can publish or recover.
      const exhausted = new WorkflowPolicyError("visit-limit", "limit", "Workflow node visit limit exceeded");
      controller.abort(exhausted);
      throw exhausted;
    }
  };
  const expressions = (mapping: DeepReadonly<Record<string, WorkflowValue>>, frame: WorkflowScope) => {
    const values = new Map<string, JsonValue>();
    const context = frame.context();
    for (const [name, expression] of Object.entries(mapping)) {
      const value = resolveWorkflowValue(expression, context);
      if (value === WORKFLOW_MISSING) throw new Error(`Missing workflow value ${name}`);
      values.set(name, value as JsonValue);
    }
    return Object.fromEntries(values);
  };
  async function invoke(id: string, supplied: Readonly<Record<string, JsonValue>>, invocation: WorkflowInvocationIdentity,
    context: { signal: AbortSignal; httpSession: HttpSession; runner: CollectionRunner; error?: Readonly<Record<string, JsonValue>> } = rootContext): Promise<{ result: WorkflowRunResult; frame: WorkflowScope }> {
  const workflow = plan.workflows.find((flow) => flow.id === id)!;
  const invocationDeadline = createWorkflowDeadline(context.signal, invocation.parentInvocationId && workflow.executionVersion === 2 ? workflow.limits.timeoutMs : undefined, "invocation-timeout");
  context = { ...context, signal: invocationDeadline.signal, runner: makeRunner(invocationDeadline.signal) };
  const { signal, httpSession } = context;
  try {
  if (workflow.executionVersion !== 2) {
    const frame = createWorkflowScope({ inputs: supplied, env, error: context.error });
    const result = await new WorkflowRunner(deps).runLegacy(execution, id, { ...options, signal, httpSession }, {
      inputs: frame.context().inputs as Record<string, JsonValue>, identity: invocation,
      consumeVisit: () => { if (signal.aborted) throw signal.reason; consumeVisit(); }, runLeaf: scheduler.runLeaf,
      observeTrace: emit,
      exportValues: (vars) => frame.stage({ vars }),
    });
    return { result, frame };
  }
  const inputs = new Map<string, JsonValue>();
  for (const [name, definition] of Object.entries(workflow.inputs)) {
    const provided = Object.hasOwn(supplied, name) ? supplied[name] : definition.default;
    if (provided === undefined) { if (definition.required) throw new Error(`Missing workflow input ${name}`); }
    else inputs.set(name, provided as JsonValue);
  }
  for (const name of Object.keys(supplied)) if (!Object.hasOwn(workflow.inputs, name)) throw new Error(`Unknown workflow input ${name}`);
  const frame = createWorkflowScope({ inputs: Object.fromEntries(inputs), env, error: context.error });
  const startedAt = new Date().toISOString();
  const results = new Map<string, NodeResult>();
  const warnings: string[] = [];
  const outgoing = new Map(workflow.nodes.map((node) => [node.id, workflow.edges.filter((edge) => edge.from === node.id)]));
  const incoming = new Set(workflow.edges.map((edge) => edge.to));
  const selectedPorts = new Map<string, string>();
  let current = workflow.nodes.find((node) => !incoming.has(node.id));
  let terminalReason: "upstream-failed" | "aborted" | "fail-fast" | undefined;
    while (current) {
      const node = current;
      const identity = createWorkflowNodeIdentity(invocation);
      const result: NodeResult = { ...identity, nodeId: node.id, label: node.label, kind: node.kind, state: "passed" };
      emit({ ...identity, nodeId: node.id, type: "node-start" });
      const policyEvent = (event: import("./trace.js").WorkflowPolicyEvent) => {
        (result.policyEvents ??= []).push(event);
        emit({ ...identity, nodeId: node.id, type: event.type,
          ...("attempt" in event ? { attempt: event.attempt } : {}), ...("state" in event ? { state: event.state } : {}),
          ...("delayMs" in event ? { delayMs: event.delayMs } : {}), ...("cause" in event ? { cause: event.cause } : {}),
          ...("invocation" in event ? { childInvocation: event.invocation } : {}) });
      };
      results.set(node.id, result);
      let condition: boolean | undefined;
      const body = createWorkflowDeadline(signal, node.policy?.timeoutMs);
      const bodyFrame = frame.fork();
      const runBody = async () => {
      const frame = bodyFrame;
      const signal = body.signal;
      const context = { signal, httpSession, runner: makeRunner(signal) };
      const runner = context.runner;
      try {
        if (signal.aborted) throw signal.reason ?? new Error("Workflow aborted");
        consumeVisit();
        switch (node.kind) {
          case "parallel": {
            // Resolve all inputs before starting any branch. Each invocation creates a fresh scope.
            const supplied = node.branches.map((branch) => expressions(branch.inputs, frame));
            const controllers = node.branches.map(() => new AbortController());
            const cancel = () => controllers.forEach((branch) => branch.abort(signal.reason));
            if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
            type BranchResult = { result?: WorkflowRunResult; outputs?: Map<string, JsonValue>; error?: unknown; cleanupFailure?: SessionCleanupFailure };
            result.branches = [];
            let winner: BranchResult | undefined;
            const settled = new Set<number>();
            const loserReason = new WorkflowPolicyError("or-superseded", "or-superseded", "Workflow OR branch superseded");
            try {
              const completed = await Promise.all(node.branches.map(async (branch, index): Promise<BranchResult> => {
                const childInvocation = createWorkflowInvocation(branch.workflowId, invocation, { nodeId: node.id, branchId: branch.id });
                const branchDto: NonNullable<NodeResult["branches"]>[number] = { ...childInvocation, branchId: branch.id, state: "failed", winner: false };
                result.branches!.push(branchDto);
                emit({ ...childInvocation, nodeId: node.id, branchId: branch.id, type: "branch-start" });
                let session: HttpSession | undefined;
                let finished: BranchResult = {};
                try {
                  session = await httpSession.fork();
                  const child = await invoke(branch.workflowId, supplied[index]!, childInvocation,
                    { signal: controllers[index]!.signal, httpSession: session, runner: makeRunner(controllers[index]!.signal) });
                  finished = { result: child.result };
                  if (child.result.verdict === "passed" && !controllers[index]!.signal.aborted) {
                    const definition = plan.workflows.find((flow) => flow.id === branch.workflowId)!;
                    const exported = definition.executionVersion === 2 ? expressions(definition.outputs, child.frame) : child.frame.context().vars;
                    const outputs = new Map<string, JsonValue>();
                    for (const [name, target] of Object.entries(branch.outputs)) {
                      if (!Object.hasOwn(exported, name)) throw new Error(`Missing child output ${name}`);
                      outputs.set(target, exported[name] as JsonValue);
                    }
                    finished.outputs = outputs;
                    // Success is established by execution and complete output validation,
                    // not by how quickly the branch's session can close.
                    if (node.join === "any-success" && !winner && !signal.aborted) {
                      winner = finished;
                      branchDto.winner = true;
                      emit({ ...childInvocation, nodeId: node.id, branchId: branch.id, type: "branch-winner", state: "passed" });
                      controllers.forEach((branchController, other) => {
                        if (other !== index && !settled.has(other)) branchController.abort(loserReason);
                      });
                    }
                  }
                } catch (error) { finished.outputs = undefined; finished.error = error; }
                finally {
                  branchDto.state = controllers[index]!.signal.aborted ? "cancelled" : finished.outputs ? "passed" : "failed";
                  if (controllers[index]!.signal.aborted) branchDto.cause = cancellationFailure(controllers[index]!.signal).cause;
                  settled.add(index);
                  if (session) {
                    try { await session.close(); } catch (error) {
                      finished.cleanupFailure = { invocation: childInvocation, branchId: branch.id, error };
                      sessionCleanupFailures.push(finished.cleanupFailure);
                      branchDto.cleanupFailed = true;
                      emit({ ...childInvocation, nodeId: node.id, branchId: branch.id, type: "session-cleanup-failed", state: "failed", message: error instanceof Error ? error.message : String(error) });
                    }
                  }
                  emit({ ...childInvocation, nodeId: node.id, branchId: branch.id, type: "branch-end", state: branchDto.state, cause: branchDto.cause });
                }
                return finished;
              }));
              // Promise.all is a true drain: even an adapter ignoring AbortSignal must finish.
              result.outcomes = completed.flatMap((branch) => branch.result?.nodeResults.flatMap((child) => child.outcomes ?? []) ?? []);
              result.childInvocations = completed.flatMap((branch) => branch.result ? [branch.result] : []);
              warnings.push(...completed.flatMap((branch) => branch.result?.warnings ?? []));
              const cleanupFailures = completed.flatMap((branch) => branch.cleanupFailure ? [branch.cleanupFailure] : []);
              const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
              warnings.push(...cleanupFailures.map((failure) => `Parallel branch ${failure.branchId} session cleanup failed: ${errorText(failure.error)}`));
              const rootCleanupFailure = sessionCleanupFailures[0];
              const publish = !rootCleanupFailure && (node.join === "all" ? completed.every((branch) => branch.outputs) : !!winner?.outputs);
              if (!publish || signal.aborted) {
                result.state = "failed";
                const failed = completed.find((branch) => branch.error || !branch.outputs);
                const childFailure = failed?.result?.nodeResults.find((child) => child.state === "failed");
                result.failureKind = signal.aborted ? "aborted" : rootCleanupFailure ? "config" : childFailure?.failureKind ?? "config";
                result.error = rootCleanupFailure ? errorText(rootCleanupFailure.error)
                  : failed?.error instanceof Error ? failed.error.message : childFailure?.error ?? "Parallel workflow failed";
                if (!rootCleanupFailure && !signal.aborted) result.primaryError = childFailure?.primaryError;
              } else {
                const outputs = node.join === "all" ? completed.flatMap((branch) => [...branch.outputs!]) : [...winner!.outputs!];
                // Map construction preserves all legal own keys; stage validates the entire batch atomically.
                frame.stage({ vars: Object.fromEntries(new Map(outputs)) });
              }
            } finally { signal.removeEventListener("abort", cancel); }
            break;
          }
          case "subflow":
          case "loop": {
            const loop = node.kind === "loop" ? frame.fork() : frame;
            const outcomes: NonNullable<NodeResult["outcomes"]> = result.outcomes = [];
            const mapped = new Set<string>();
            let iteration = 0;
            const predicate = (value: Parameters<typeof evaluateWorkflowPredicate>[0]) => {
              const verdict = evaluateWorkflowPredicate(value, loop.context());
              if (verdict.kind === "error") throw new Error(verdict.message);
              return verdict.kind === "matched";
            };
            while (true) {
              if (node.kind === "loop") {
                loop.setLoop({ iteration });
                if (node.count !== undefined ? iteration >= node.count : !predicate(node.while!)) break;
                if (iteration >= node.maxIterations) throw new Error("Workflow loop maxIterations exhausted");
                emit({ ...identity, nodeId: node.id, type: "loop-iteration", iteration });
              }
              const child = await invoke(node.workflowId, expressions(node.inputs, loop), createWorkflowInvocation(node.workflowId, invocation, { nodeId: node.id, ...(node.kind === "loop" ? { iteration } : {}) }), context);
              warnings.push(...child.result.warnings);
              (result.childInvocations ??= []).push(child.result);
              outcomes.push(...child.result.nodeResults.flatMap((item) => item.outcomes ?? []));
              if (signal.aborted) {
                result.state = "failed"; result.failureKind = "aborted";
                result.error = signal.reason instanceof Error ? signal.reason.message : "Workflow aborted";
                break;
              }
              if (child.result.verdict !== "passed") {
                result.state = "failed";
                const failure = child.result.nodeResults.find((item) => item.state === "failed");
                result.error = failure?.error ?? "Child workflow failed"; result.failureKind = failure?.failureKind ?? "config";
                result.primaryError = failure?.primaryError;
                break;
              }
              const definition = plan.workflows.find((flow) => flow.id === node.workflowId)!;
              const exported = definition.executionVersion === 2 ? expressions(definition.outputs, child.frame) : child.frame.context().vars;
              const batch = new Map<string, JsonValue>();
              for (const [name, target] of Object.entries(node.outputs)) {
                if (!Object.hasOwn(exported, name)) throw new Error(`Missing child output ${name}`);
                batch.set(target, exported[name] as JsonValue);
              }
              loop.stage({ vars: Object.fromEntries(batch) });
              batch.forEach((_value, name) => mapped.add(name));
              if (node.kind === "subflow" || (node.until && predicate(node.until))) break;
              iteration++;
            }
            if (node.kind === "loop" && result.state !== "failed") frame.stage({ vars: Object.fromEntries([...mapped].map((name) => [name, loop.context().vars[name]!])) });
            break;
          }
          case "noop": result.state = "noop"; break;
          case "assign": {
            const staged = new Map<string, JsonValue>();
            const context = frame.context();
            for (const [name, expression] of Object.entries(node.assignments)) {
              const value = resolveWorkflowValue(expression, context);
              if (value === WORKFLOW_MISSING) throw new Error(`Missing assign value for ${name}`);
              staged.set(name, value as JsonValue);
            }
            frame.stage({ vars: Object.fromEntries(staged) });
            break;
          }
          case "delay": await waitWorkflowDelay(node.delayMs, signal); break;
          case "condition":
          case "assert": {
            const verdict = evaluateWorkflowPredicate(node.predicate, frame.context());
            if (verdict.kind === "error") throw new Error(verdict.message);
            if (node.kind === "condition") condition = verdict.kind === "matched";
            else if (verdict.kind === "pruned") { result.state = "failed"; result.failureKind = "assertion"; result.error = "Workflow assertion failed"; }
            break;
          }
          case "request": {
            const location = findProjectApi(project, node.apiId!)!;
            const selection = plan.selections.find((item) => item.apiId === node.apiId && item.caseId === node.caseId)!;
            const retry = node.policy?.retry;
            const outcomes: NonNullable<NodeResult["outcomes"]> = result.outcomes = [];
            result.attempts = []; result.policyEvents = [];
            for (let number = 1; number <= (retry?.maxAttempts ?? 1); number++) {
            if (number > 1) consumeVisit();
            if (signal.aborted) throw signal.reason;
            const attemptIdentity = { ...identity, attempt: number };
            policyEvent({ type: "attempt-start", attempt: number });
            result.state = "passed"; result.error = undefined; result.failureKind = undefined;
            const attempt = frame.fork();
            attempt.invalidateExtractions((selection.testCase.extractors ?? []).map((item) => item.name));
            const bridge = { extractions: attempt.extractions, get: () => attempt.runtimeVariables(),
              // The F4 kernel already resolved script/extraction ordering. Its final
              // extraction layer must remain above the accumulated script writes.
              set: (vars: Record<string, string>) => attempt.stage({ vars, extractions: Object.fromEntries(attempt.extractions.bindings) }) };
            try {
              emit({ ...attemptIdentity, nodeId: node.id, type: "leaf-wait" });
              const run = await scheduler.runLeaf(() => {
                emit({ ...attemptIdentity, nodeId: node.id, type: "leaf-start" });
                return runSingleNode(runner, execution, location, selection.testCase, environmentId, bridge, {
                workspaceRoot: options.workspaceRoot ?? deps.workspaceRoot, httpSession,
                observeHttp: options.observeHttp ?? deps.observeHttp, preparedRowIndex: options.preparedRowIndex,
                observeCaseExecution: async (value, rowIdentity) => {
                  Object.assign(value.outcome, attemptIdentity, { nodeId: node.id });
                  await options.observeCaseExecution?.(value, { ...rowIdentity, ...attemptIdentity, nodeId: node.id });
                },
              }); }, signal);
              warnings.push(...run.warnings);
              outcomes.push(...run.outcomes);
              result.outcome = run.outcomes.find((item) => !item.passed) ?? run.outcomes[0];
              if (run.outcomes.some((item) => !item.passed)) {
                result.state = "failed"; result.error = result.outcome?.error; result.failureKind = result.outcome?.failureKind;
              }
            } catch (error) {
              if (error instanceof CollectionRunError) {
                outcomes.push(...error.partialResult.cases);
                result.outcome = error.partialResult.cases.find((item) => !item.passed) ?? error.partialResult.cases[0];
                warnings.push(...(error.partialResult.warnings ?? []));
                result.failureKind = error.failureKind;
              } else { result.failureKind = "config"; }
              result.state = "failed"; result.error = error instanceof Error ? error.message : String(error);
            }
            if (signal.aborted) { const failure = cancellationFailure(signal); result.state = "failed"; result.failureKind = failure.failureKind; result.error = failure.message; }
            const failure = result.state === "failed" ? signal.aborted ? cancellationFailure(signal) : workflowFailure(result.error ?? "Request failed", result.failureKind) : undefined;
            result.attempts.push({ attempt: number, state: result.state === "failed" ? "failed" : "passed", ...(failure ? { error: failure } : {}) });
            policyEvent({ type: "attempt-end", attempt: number, state: result.state === "failed" ? "failed" : "passed" });
            if (result.state !== "failed") { attempt.commitOutputs(frame); break; }
            // Retry the complete request in a fresh private frame. Failed writes and
            // invalidations stay private until the request has finally failed.
            const kinds = outcomes.filter((item) => item.attempt === number && !item.passed).map((item) => item.failureKind ?? "config");
            if (result.failureKind) kinds.push(result.failureKind);
            const retryable = retry && number < retry.maxAttempts && !signal.aborted && kinds.length > 0
              && kinds.every((kind) => (retry.retryOn as readonly string[]).includes(kind));
            if (!retryable) { attempt.commitOutputs(frame, { failed: true }); break; }
            const delayMs = workflowRetryDelay(retry.delayMs, retry.backoff, number);
            policyEvent({ type: "retry-wait", attempt: number, delayMs });
            try { await waitWorkflowDelay(delayMs, signal); }
            catch (error) { attempt.commitOutputs(frame, { failed: true }); throw error; }
            }
            break;
          }
          default: throw new Error("Unsupported workflow node");
        }
      } catch (error) {
        result.state = "failed"; result.failureKind = signal.aborted ? "aborted" : "config";
        result.error = error instanceof Error ? error.message : String(error);
        result.primaryError = signal.aborted ? cancellationFailure(signal) : workflowFailure(error, result.failureKind);
      }
      };
      try { await runBody(); } finally { body.dispose(); }
      if (body.signal.aborted) {
        result.primaryError = cancellationFailure(body.signal);
        result.state = "failed"; result.failureKind = result.primaryError.failureKind; result.error = result.primaryError.message;
      } else if (result.state === "failed" && !result.primaryError) result.primaryError = workflowFailure(result.error ?? "Workflow node failed", result.failureKind);
      if (result.primaryError) emit({ ...identity, nodeId: node.id, type: "node-failure", cause: result.primaryError.cause, code: result.primaryError.code, failureKind: result.primaryError.failureKind, message: result.primaryError.message });
      // Final failure invalidation is visible before recovery; positive body
      // writes are never published after failure or a late cancelled response.
      bodyFrame.commitOutputs(frame, { failed: result.state === "failed" });
      const addFailure = (failure: WorkflowFailure) => {
        if (result.primaryError) (result.secondaryErrors ??= []).push(failure); else result.primaryError = failure;
      };
      const invokeHandler = async (role: "onError" | "finally", policy: { workflowId: string; timeoutMs: number }) => {
        if (signal.aborted) { policyEvent({ type: role === "onError" ? "handler-skipped" : "cleanup-skipped", cause: cancellationFailure(signal).cause }); return false; }
        const deadline = createWorkflowDeadline(signal, policy.timeoutMs, role === "onError" ? "handler-timeout" : "cleanup-timeout");
        const childIdentity = createWorkflowInvocation(policy.workflowId, invocation, { nodeId: node.id, handler: role });
        policyEvent({ type: role === "onError" ? "handler-start" : "cleanup-start", invocation: childIdentity });
        let failure: WorkflowFailure | undefined;
        try {
          const error = result.primaryError ?? result.recoveredError;
          const child = await invoke(policy.workflowId, {}, childIdentity, { ...context, signal: deadline.signal, runner: makeRunner(deadline.signal), error: error ? { ...error } : {} });
          (result.policyInvocations ??= []).push({ role, result: child.result });
          warnings.push(...child.result.warnings);
          (result.outcomes ??= []).push(...child.result.nodeResults.flatMap((item) => item.outcomes ?? []));
          if (deadline.signal.aborted) failure = cancellationFailure(deadline.signal);
          else if (child.result.verdict !== "passed") {
            const failed = child.result.nodeResults.find((item) => item.state === "failed");
            failure = workflowFailure(failed?.error ?? "Workflow handler failed", failed?.failureKind, role === "onError" ? "handler-failed" : "cleanup-failed");
          }
        } catch (error) { failure = deadline.signal.aborted ? cancellationFailure(deadline.signal) : workflowFailure(error, "config", role === "onError" ? "handler-failed" : "cleanup-failed"); }
        finally { deadline.dispose(); }
        if (failure) addFailure(failure);
        policyEvent({ type: role === "onError" ? "handler-end" : "cleanup-end", state: failure ? "failed" : "passed" });
        return !failure;
      };
      if (result.primaryError && node.policy?.onError) {
        const original = result.primaryError;
        const handled = await invokeHandler("onError", node.policy.onError);
        if (handled && node.policy.onError.mode === "recover" && recoverableWorkflowFailure(original) && !signal.aborted && !sessionCleanupFailures.length) {
          result.recoveredError = original; result.primaryError = undefined;
          policyEvent({ type: "recovered" });
        }
      }
      if (node.policy?.finally) await invokeHandler("finally", node.policy.finally);
      if (signal.aborted) {
        const cancelled = cancellationFailure(signal);
        if (result.primaryError && result.primaryError.cause !== cancelled.cause) (result.secondaryErrors ??= []).unshift(result.primaryError);
        result.primaryError = cancelled;
      }
      if (sessionCleanupFailures.length && !result.primaryError) result.primaryError = workflowFailure(sessionCleanupFailures[0]!.error, "config", "session-cleanup-failed");
      if (result.primaryError) { result.state = "failed"; result.error = result.primaryError.message; result.failureKind = result.primaryError.failureKind; }
      else if (result.recoveredError) { result.state = "passed"; result.error = undefined; result.failureKind = undefined; }
      emit({ ...identity, nodeId: node.id, type: "node-end", state: result.state, cause: result.primaryError?.cause, code: result.primaryError?.code, failureKind: result.failureKind, message: result.error });
      // previous is a logical summary only; response values require explicit extraction.
      frame.setPrevious({ nodeId: node.id, kind: node.kind, state: result.state, passed: result.state === "passed" || result.state === "noop", ...(result.failureKind ? { failureKind: result.failureKind } : {}) });
      if (condition !== undefined) selectedPorts.set(node.id, String(condition));
      if (result.state === "failed") { terminalReason = signal.aborted ? "aborted" : deps.failFast ? "fail-fast" : "upstream-failed"; break; }
      const edge = outgoing.get(node.id)?.find((candidate) => node.kind !== "condition" || candidate.port === String(condition));
      current = edge ? workflow.nodes.find((candidate) => candidate.id === edge.to) : undefined;
    }
    // Keep mutually exclusive path provenance even if the selected path failed later.
    const reachable = new Set<string>();
    const pending = workflow.nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
    while (pending.length) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const edge of outgoing.get(id) ?? []) if (!selectedPorts.has(id) || edge.port === selectedPorts.get(id)) pending.push(edge.to);
    }
    for (const node of workflow.nodes) if (!results.has(node.id)) {
      const identity = createWorkflowNodeIdentity(invocation);
      results.set(node.id, { ...identity, nodeId: node.id, label: node.label, kind: node.kind, state: "skipped", skipReason: reachable.has(node.id) ? terminalReason ?? "condition-pruned" : "condition-pruned" });
      emit({ ...identity, nodeId: node.id, type: "node-skipped", state: "skipped", cause: signal.aborted ? cancellationFailure(signal).cause : undefined });
    }
    const nodeResults = [...results.values()];
    const failed = nodeResults.filter((item) => item.state === "failed").length;
    return { frame, result: { ...invocation, workflowId: id, workflowName: workflow.name, status: workflow.status, nodeResults,
      total: nodeResults.length, passed: nodeResults.filter((item) => item.state === "passed" || item.state === "noop").length,
      failed, skipped: nodeResults.filter((item) => item.state === "skipped").length,
      verdict: signal.aborted && cancellationFailure(signal).cause === "user-abort" ? "aborted" : failed ? "failed" : "passed", warnings,
      startedAt, finishedAt: new Date().toISOString() } };
  } finally { invocationDeadline.dispose(); }
  }
  try {
    const identity = createWorkflowInvocation(workflowId);
    const result = (await invoke(workflowId, options.inputs ?? {}, options.invocationId ? { ...identity, invocationId: options.invocationId } : identity)).result;
    result.reportingMode = "workflow-invocation-v2"; result.trace = trace; result.requestFacts = requestFacts;
    return result;
  } finally {
    await scheduler.drain();
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    if (!suppliedSession) await httpSession.close();
  }
}
