import { assertPreparedExecution, type PreparedExecution } from "./prepare.js";

/** Shared admission uses the actual compiled duration; lifecycle/iteration time remains bounded by the parent. */
export function assertStressExecutionDeadline(prepared: PreparedExecution, remainingMs: number): void {
  assertPreparedExecution(prepared);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new Error("Execution deadline expired");
  if (prepared.target.kind !== "stress") return;
  const schedule = prepared.stressPlan!.schedule;
  const required = schedule.warmupMs + (schedule.durationMs ?? 0) + schedule.gracefulStopMs;
  if (required > remainingMs) throw new Error("Compiled stress schedule exceeds the remaining execution deadline");
}
