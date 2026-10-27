import { CollectionRunError, SuiteRunner, WorkflowRunner, runDebugExecution, createHttpSession, prepareTestData, bindPreparedTestData, testDataSelectionsForRequests, collectCredentialMarkersForRequests, selectCredentialRequests, suiteToRunResult, workflowToRunResult, type CredentialBindings, type PreparedTestData, type PreparedNetworkRun, type HttpSession, type DebugResult, type RunResult, type WorkflowRunResult, type CaseOutcome } from "@apicc/core";
import { createExecutionRegistry } from "./registry.js";
import type { ExecutionRegistry } from "./registry.js";
import { assertPreparedExecution, type PreparedExecution, type DebugSessionScope } from "./prepare.js";
import { createHostOutput } from "./output.js";

export interface ExecutionMaterials { credentialBindings: CredentialBindings; preparedTestData?: PreparedTestData; network?: PreparedNetworkRun; workspaceRoot?: string; debugSession?: { scope: DebugSessionScope; session: HttpSession } }
export type InvocationOutput = { kind: "debug"; result: DebugResult } | { kind: "suite"; result: RunResult } | { kind: "workflow"; result: WorkflowRunResult } | { kind: "failure"; targetKind: PreparedExecution["target"]["kind"]; result: RunResult; error: string };
function sameSessionScope(left: DebugSessionScope, right: DebugSessionScope): boolean {
  return left.serverId === right.serverId && left.submittedByUserId === right.submittedByUserId && left.debugSessionId === right.debugSessionId
    && left.scope.workspaceId === right.scope.workspaceId && left.scope.groupId === right.scope.groupId && left.scope.projectId === right.scope.projectId;
}
/** One call owns its registry, observations and variable state. */
export type InvocationRegistryFactory = (options: { profile: PreparedExecution["profile"]; scriptTimeoutMs?: number }) => ExecutionRegistry | Promise<ExecutionRegistry>;
export async function invokeExecution(prepared: PreparedExecution, materials: ExecutionMaterials, options: { signal?: AbortSignal; registryFactory?: InvocationRegistryFactory } = {}): Promise<InvocationOutput> {
  assertPreparedExecution(prepared);
  if (materials.debugSession && (prepared.target.kind !== "debug" || !prepared.debugSessionScope || !sameSessionScope(materials.debugSession.scope, prepared.debugSessionScope))) throw new Error("Debug session scope mismatch");
  if (prepared.debugSessionScope && !materials.debugSession) throw new Error("Selected debug session is unavailable");
  if (!materials.preparedTestData && prepared.selections.some(selection => selection.testCase?.dataDriver && !("kind" in selection.testCase.dataDriver))) throw new Error("File data drivers require prepared input materials");
  const credentialBindings = materials.credentialBindings; const network = materials.network;
  const requests = selectCredentialRequests(prepared.snapshot, prepared.selections);
  const markers = [...collectCredentialMarkersForRequests(prepared.snapshot.project, requests, credentialBindings), ...(network?.outputMarkers ?? [])];
  const data = materials.preparedTestData ?? await prepareTestData(prepared.snapshot, prepared.suitePlan?.selections ?? testDataSelectionsForRequests(prepared.snapshot, prepared.selections, prepared.environmentId), { workspaceRoot: process.cwd() });
  const run = { snapshot: prepared.snapshot, credentialBindings, preparedTestData: bindPreparedTestData(prepared.snapshot, data), network };
  const output = createHostOutput({ projectId: prepared.snapshot.project.id, definitionRevision: prepared.snapshot.definitionRevision, environmentId: prepared.environmentId, dataDigest: data.digest }, markers, prepared.evidenceLimits);
  const registry = await (options.registryFactory ?? createExecutionRegistry)({ profile: prepared.profile, scriptTimeoutMs: prepared.scriptTimeoutMs });
  const observed: CaseOutcome[] = []; let started = 0; let completed = 0; let httpExchanges = 0;
  const observeHttp = (event: import("@apicc/core").HttpHopObservation) => { if (event.type === "request") httpExchanges++; };
  const observe = (execution: Parameters<typeof output.collector.observe>[0], identity: Parameters<typeof output.collector.observe>[1]) => { observed.push(execution.outcome); started += Number(execution.requestStarted === true); completed += Number(execution.requestCompleted === true); output.collector.observe(execution, identity); };
  let session: HttpSession | undefined;
  let terminalRun: RunResult | undefined;
  let terminalFailure: Pick<CollectionRunError, "message" | "failureKind"> | undefined;
  try {
    if (prepared.target.kind === "debug") {
      session = materials.debugSession?.session ?? createHttpSession();
      return { kind: "debug", result: await runDebugExecution(prepared.debugPlan!, run, { registry, signal: options.signal, workspaceRoot: materials.workspaceRoot, credentialMarkers: markers, httpSession: session, requestSettings: prepared.requestSettings, evidenceLimits: prepared.evidenceLimits, observeCaseExecution: observe, observeHttp,
        observeRunResult: (value, failure) => { terminalRun = value; terminalFailure = failure; } }) };
    }
    if (prepared.target.kind === "suite") {
      terminalRun = suiteToRunResult(await new SuiteRunner({ registry }).run(run, prepared.suitePlan!, { signal: options.signal, workspaceRoot: materials.workspaceRoot, requestSettings: prepared.requestSettings, observeCaseExecution: observe, observeHttp }));
      return { kind: "suite", result: output.projectRun(terminalRun) };
    }
    const result = await new WorkflowRunner({ registry }).run(run, prepared.target.workflowId, { environmentId: prepared.environmentId, inputs: prepared.target.inputs, signal: options.signal, workspaceRoot: materials.workspaceRoot, requestSettings: prepared.requestSettings, observeCaseExecution: observe, observeHttp });
    terminalRun = workflowToRunResult(result);
    return { kind: "workflow", result: output.projectWorkflow(result) };
  } catch (error) {
    const text = output.collector.boundary().redactText(error instanceof Error ? error.message : String(error));
    const partial: RunResult = terminalRun ?? (error instanceof CollectionRunError ? error.partialResult : { collectionId: prepared.snapshot.project.id, collectionName: "Execution failure", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), total: observed.length, passed: observed.filter(row => row.passed).length, failed: observed.filter(row => !row.passed).length, cases: observed });
    const result = output.projectFailure({ ...partial, requestFacts: partial.requestFacts ?? { requestStarted: started, requestCompleted: completed, httpExchanges }, warnings: [...(partial.warnings ?? []), text, ...(terminalFailure ? [`${terminalFailure.failureKind}: ${terminalFailure.message}`] : [])] });
    return { kind: "failure", targetKind: prepared.target.kind, error: result.warnings?.find(warning => warning === text) ?? result.warnings?.[0] ?? "Execution failed", result };
  } finally { try { if (session && !materials.debugSession) await session.close(); } finally { await registry.close(); } }
}
