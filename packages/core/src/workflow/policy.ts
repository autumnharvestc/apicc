import type { CaseFailureKind } from "../runner/caseExecutor.js";

/** Internal execution diagnostics. Public report projection belongs to the reporting layer. */
export type WorkflowFailureCause = "failure" | "user-abort" | "root-timeout" | "ancestor-cancel" | "or-superseded"
  | "node-timeout" | "handler-timeout" | "cleanup-timeout" | "invocation-timeout" | "limit";
export interface WorkflowFailure {
  readonly code: string;
  readonly cause: WorkflowFailureCause;
  readonly message: string;
  readonly failureKind: CaseFailureKind;
}
export class WorkflowPolicyError extends Error {
  constructor(readonly code: string, readonly cause: WorkflowFailureCause, message: string) { super(message); }
}
export function workflowFailure(error: unknown, kind: CaseFailureKind = "config", code = "node-failed"): WorkflowFailure {
  return Object.freeze({ code: error instanceof WorkflowPolicyError ? error.code : code,
    cause: error instanceof WorkflowPolicyError ? error.cause : "failure", message: error instanceof Error ? error.message : String(error), failureKind: kind });
}
export function cancellationFailure(signal: AbortSignal): WorkflowFailure {
  const reason = signal.reason;
  const cause = reason instanceof WorkflowPolicyError ? reason.cause : "ancestor-cancel";
  const timeout = ["root-timeout", "node-timeout", "handler-timeout", "cleanup-timeout", "invocation-timeout"].includes(cause);
  return Object.freeze({ code: reason instanceof WorkflowPolicyError ? reason.code : "ancestor-cancel", cause,
    message: reason instanceof Error ? reason.message : "Workflow cancelled", failureKind: cause === "limit" ? "config" : timeout ? "transport" : "aborted" });
}
/** Links to a still-live parent and owns only its timer/listener, never its parent's lifetime. */
export function createWorkflowDeadline(parent: AbortSignal, timeoutMs?: number, cause: WorkflowFailureCause = "node-timeout") {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  if (parent.aborted) cancel(); else parent.addEventListener("abort", cancel, { once: true });
  const timer = !controller.signal.aborted && timeoutMs !== undefined
    ? setTimeout(() => controller.abort(new WorkflowPolicyError(cause, cause, `Workflow ${cause}`)), timeoutMs) : undefined;
  return { signal: controller.signal, dispose() { if (timer !== undefined) clearTimeout(timer); parent.removeEventListener("abort", cancel); } };
}
export function workflowRetryDelay(delayMs: number, backoff: "fixed" | "exponential", failedAttempt: number): number {
  return Math.min(30000, delayMs * (backoff === "exponential" ? 2 ** (failedAttempt - 1) : 1));
}
export function recoverableWorkflowFailure(failure: WorkflowFailure): boolean {
  return failure.failureKind !== "config" && failure.failureKind !== "aborted" && failure.cause !== "limit" && failure.cause !== "root-timeout";
}
export function waitWorkflowDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
