import type { ProjectExecutionRun } from "../runner/runner.js";
import { assertWorkflowPlanOwner, compileWorkflowPlan, validateWorkflowPlanData, workflowPlanRequests, type CompiledWorkflowPlan, type WorkflowPlanOptions } from "./plan.js";
import { bindPreparedTestData } from "../testing/data.js";

export interface PreparedWorkflowExecution {
  readonly run: ProjectExecutionRun;
  readonly plan: CompiledWorkflowPlan;
}
const preparedOwners = new WeakSet<PreparedWorkflowExecution>();

/** Reuse a compiler-owned closure on exactly the same snapshot; never recapture it. */
export function prepareWorkflowExecution(run: ProjectExecutionRun, workflowId: string,
  options: WorkflowPlanOptions & { compiledPlan?: CompiledWorkflowPlan } = {}): PreparedWorkflowExecution {
  const plan = options.compiledPlan ?? compileWorkflowPlan(run.snapshot, workflowId, options);
  workflowPlanRequests(run.snapshot, plan);
  if (plan.rootWorkflowId !== workflowId || plan.environmentId !== options.environmentId) throw new Error("Prepared workflow selection mismatch");
  const preparedTestData = run.preparedTestData === undefined ? undefined : bindPreparedTestData(run.snapshot, run.preparedTestData);
  validateWorkflowPlanData(run.snapshot, plan, preparedTestData);
  const pinned = Object.freeze({ snapshot: run.snapshot, credentialBindings: run.credentialBindings,
    ...(run.network === undefined ? {} : { network: run.network }), ...(preparedTestData === undefined ? {} : { preparedTestData }) });
  const prepared = Object.freeze({ run: pinned, plan });
  preparedOwners.add(prepared);
  return prepared;
}
export function assertPreparedWorkflowExecution(prepared: PreparedWorkflowExecution): void {
  if (!preparedOwners.has(prepared)) throw new Error("Prepared workflow owner mismatch");
  assertWorkflowPlanOwner(prepared.run.snapshot, prepared.plan);
}
