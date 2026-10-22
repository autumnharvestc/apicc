/** Structured identities; array segments avoid ambiguous string/path concatenation. */
export interface WorkflowInvocationSegment {
  readonly workflowId: string;
  readonly nodeId?: string;
  readonly branchId?: string;
  readonly iteration?: number;
  readonly handler?: "onError" | "finally";
}
export interface WorkflowInvocationIdentity {
  readonly invocationId: string;
  readonly parentInvocationId?: string;
  readonly invocationPath: readonly WorkflowInvocationSegment[];
}
export interface WorkflowNodeIdentity extends WorkflowInvocationIdentity {
  readonly nodeVisitId: string;
  readonly attempt: number;
}
export type WorkflowPolicyEvent =
  | { readonly type: "attempt-start" | "attempt-end"; readonly attempt: number; readonly state?: "passed" | "failed" }
  | { readonly type: "retry-wait"; readonly attempt: number; readonly delayMs: number }
  | { readonly type: "handler-start" | "cleanup-start"; readonly invocation: WorkflowInvocationIdentity }
  | { readonly type: "handler-end" | "cleanup-end"; readonly state: "passed" | "failed" }
  | { readonly type: "handler-skipped" | "cleanup-skipped"; readonly cause: import("./policy.js").WorkflowFailureCause }
  | { readonly type: "recovered" };
export interface WorkflowTraceEvent extends Partial<WorkflowNodeIdentity> {
  entryId?: string; suiteRow?: number;
  type: WorkflowPolicyEvent["type"] | "node-start" | "node-end" | "node-failure" | "node-skipped" | "leaf-wait" | "leaf-start" | "branch-start" | "branch-end" | "branch-winner" | "session-cleanup-failed" | "loop-iteration";
  nodeId?: string; branchId?: string; iteration?: number;
  state?: "passed" | "failed" | "noop" | "skipped" | "cancelled"; cause?: import("./policy.js").WorkflowFailureCause;
  code?: string; failureKind?: import("../runner/caseExecutor.js").CaseFailureKind;
  childInvocation?: WorkflowInvocationIdentity;
  delayMs?: number; message?: string;
}
export interface WorkflowTrace { events: WorkflowTraceEvent[]; truncated: boolean; totalEvents: number }
export function createWorkflowInvocation(workflowId: string, parent?: WorkflowInvocationIdentity, call: Omit<WorkflowInvocationSegment, "workflowId"> = {}): WorkflowInvocationIdentity {
  return Object.freeze({ invocationId: globalThis.crypto.randomUUID(), ...(parent ? { parentInvocationId: parent.invocationId } : {}),
    invocationPath: Object.freeze([...(parent?.invocationPath ?? []), Object.freeze({ workflowId, ...call })]) });
}
export function createWorkflowNodeIdentity(invocation: WorkflowInvocationIdentity, attempt = 1): WorkflowNodeIdentity {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 5) throw new Error("Invalid workflow attempt");
  return Object.freeze({ ...invocation, nodeVisitId: globalThis.crypto.randomUUID(), attempt });
}
