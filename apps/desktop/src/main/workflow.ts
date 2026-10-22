import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { compileWorkflowPlan, workflowPlanRequests, validateWorkflowRunOptions, createExecutionEvidenceCollector, createHttpSession, createProjectSnapshot, WorkflowRunner, type PluginRegistry, type WorkflowRunResult } from "@apicc/core";
import type { createSession } from "./session.js";
import type { DebugCredentialHost } from "./credentialHost.js";
import { prepareDesktopTestData } from "./executionContext.js";
import { createExecutionOutputBoundary, persistExecutionJson } from "./executionOutput.js";
import type { WfRunInput, WfCancelInput } from "../shared/types.js";

/** A run remains owned and cancellable until the real runner/session drain has finished. */
export function createWorkflowController(session: ReturnType<typeof createSession>, registrySource: () => Promise<PluginRegistry>, credentials: DebugCredentialHost,
  storage?: { persist(path: string, result: import("@apicc/core").RunResult): { warning?: string } }) {
  const defaultOwner = {};
  const active = new Map<string, { owner: object; input: WfRunInput; context: ReturnType<typeof session.captureDraftWriteContext>; abort: AbortController }>();
  async function run(raw: WfRunInput, owner = defaultOwner): Promise<WorkflowRunResult> {
    const input = structuredClone(raw); const id = input.invocationId ?? randomUUID();
    const context = session.captureDraftWriteContext();
    if (input.root !== undefined && input.root !== context.root) throw new Error("Workflow workspace context changed");
    const found = session.locateWorkflow(input.locator);
    if (!found) throw new Error(`未找到工作流: ${JSON.stringify(input.locator)}`);
    if (found.workflow.status === "draft") throw new Error("工作流为草稿，请先发布启用");
    if (active.has(id)) throw new Error("Workflow invocation already active");
    const abort = new AbortController(); active.set(id, { owner, input, context, abort });
    let output = createExecutionOutputBoundary([]);
    let evidence: ReturnType<typeof createExecutionEvidenceCollector> | undefined;
    let httpSession: ReturnType<typeof createHttpSession> | undefined;
    try {
      const snapshot = createProjectSnapshot(found.project); const workflow = snapshot.project.workflows.find((flow) => flow.id === input.locator.workflowId)!;
      validateWorkflowRunOptions(workflow, { inputs: input.inputs });
      const env = input.envName ? snapshot.project.environments.find((candidate) => candidate.name === input.envName) : undefined;
      if (input.envName && !env) throw new Error(`未找到环境: ${input.envName}`);
      const plan = compileWorkflowPlan(snapshot, workflow.id, { environmentId: env?.id, ...(workflow.executionVersion === 2 ? {} : { legacyRootReferenceMode: "report" as const }) });
      const selected = workflowPlanRequests(snapshot, plan);
      const selections = (input.strict ?? true) && plan.referenceDiagnostics.some((item) => item.logicalMissing) ? [] : selected;
      const { workspaceId, groupId, projectId } = input.locator;
      const prepared = await credentials.prepareRunForRequests({ workspaceId, groupId, projectId }, snapshot, selections, { workspaceRoot: context.root, environmentId: env?.id, signal: abort.signal });
      output = createExecutionOutputBoundary(prepared.markers);
      const withData = await prepareDesktopTestData(prepared, selections, context.root, env?.id);
      session.assertDraftWriteContext(context);
      evidence = createExecutionEvidenceCollector({ projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, workflowId: workflow.id, environmentId: env?.id, dataDigest: withData.run.preparedTestData?.digest }, prepared.markers);
      httpSession = createHttpSession(); const registry = await registrySource();
      session.assertDraftWriteContext(context);
      const rawResult = await new WorkflowRunner({ registry, failFast: false, strict: input.strict ?? true }).run(withData.run, workflow.id, {
        workspaceRoot: context.root, environmentId: env?.id, httpSession, signal: abort.signal, inputs: input.inputs, invocationId: id,
        observeCaseExecution: (execution, identity) => evidence!.observe(execution, { ...identity, entryId: identity.nodeId }),
      });
      // Close the owner session before final output, with every started child already drained.
      await httpSession.close(); httpSession = undefined;
      const result = evidence.projectWorkflow(rawResult);
      output = createExecutionOutputBoundary(evidence.markers());
      const path = join(context.root, ".apicc", "runs", `workflow-${result.workflowId}-${randomUUID()}.json`);
      const persisted = storage ? storage.persist(path, result.report!) : persistExecutionJson(path, result.report!, output, () => "工作流安全 JSON 报告保存失败");
      const { report: _report, ...dto } = result;
      return output.value(persisted.warning ? { ...dto, warnings: [...dto.warnings, persisted.warning] } : dto);
    } catch (error) {
      if (evidence) throw new Error(evidence.boundary().redactText(error instanceof Error ? error.message : String(error)));
      throw output.error(error);
    } finally { try { await httpSession?.close(); } finally { active.delete(id); } }
  }
  async function cancel(input: WfCancelInput, owner = defaultOwner): Promise<boolean> {
    const running = active.get(input.invocationId);
    if (!running || running.owner !== owner || running.context.root !== input.root || JSON.stringify(running.input.locator) !== JSON.stringify(input.locator)) return false;
    try {
      const current = session.captureDraftWriteContext();
      if (current.root !== running.context.root || current.generation !== running.context.generation) return false;
    } catch { return false; }
    running.abort.abort(); return true;
  }
  function clearOwner(owner: object) { for (const running of active.values()) if (running.owner === owner) running.abort.abort(); }
  function abortActive() { for (const running of active.values()) running.abort.abort(); }
  return { run, cancel, clearOwner, abortActive };
}
