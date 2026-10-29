import { readBuildIdentity } from "@apicc/execution/buildIdentity";
import { TaskEnvelopeV1Schema, AgentCommandV1Schema } from "@apicc/execution/contract";
import { executeInvocation, equal, type InvocationDTO, type StartPermit } from "./invocationContext.js";
import type { HttpSession } from "@apicc/core";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ChildLease } from "./ledger.js";
import { spawnLocalStressWorker, type NativeStressWorkerChannel, type NodeStressRunOptions } from "@apicc/execution/host";
import { fileURLToPath } from "node:url";
let generation: string | undefined; let shared = false; let heartbeat: ReturnType<typeof setInterval> | undefined;
let childLease: ChildLease | undefined;
// Keep the read transaction alive until OS exit. Never close it on disconnect/shutdown intent.
let lifetimeLease: DatabaseSync | undefined;
const calls = new Map<string, { controller: AbortController; scope: unknown }>();
const sessionRequests = new Map<string, { executionId: string; scope: unknown; resolve(value: unknown): void; reject(error: Error): void }>();
const processRegistrations = new Map<string, { resolve(): void; reject(error: Error): void }>();
const send = (message: object) => { if (process.connected) process.send?.({ generation, ...message }); };
const configure = (interval: number) => { clearInterval(heartbeat); heartbeat = setInterval(() => send({ kind: "heartbeat" }), interval); };
function remoteSession(executionId: string, scope: unknown, sessionHandle?: string): HttpSession {
  const request = (operation: string, args: unknown[]): Promise<unknown> => {
    const requestId = randomUUID(); return new Promise((resolve, reject) => { sessionRequests.set(requestId, { executionId, scope, resolve, reject }); send({ kind: "session", executionId, scope, sessionHandle, requestId, operation, args }); });
  };
  return { getCookieHeader: async url => await request("getCookieHeader", [url]) as string | undefined,
    storeResponseCookies: async (url, headers) => { await request("storeResponseCookies", [url, headers]); },
    listCookies: async () => await request("listCookies", []) as Awaited<ReturnType<HttpSession["listCookies"]>>,
    clearCookies: async () => { await request("clearCookies", []); },
    fork: async () => remoteSession(executionId, scope, await request("fork", []) as string),
    close: async () => { if (sessionHandle) await request("close", []); },
  };
}
process.on("message", async (message: { kind: string; generation: string; shared?: boolean; lease?: ChildLease; heartbeatIntervalMs: number; executionId: string; scope: unknown; dto: InvocationDTO; permit: StartPermit; requestId: string; value?: unknown; failed?: boolean }) => {
  if (!generation && message.kind === "initialize") {
    generation = message.generation; shared = message.shared === true; childLease = message.lease;
    try {
      if (!process.connected) throw new Error("Supervision unavailable");
      if (message.lease) {
        lifetimeLease = new DatabaseSync(message.lease.file, { readOnly: true }); lifetimeLease.exec("PRAGMA busy_timeout=0; BEGIN");
        const row = lifetimeLease.prepare("SELECT value FROM epoch WHERE id=1").get() as { value: string } | undefined;
        if (row?.value !== message.lease.epoch) throw new Error("Expired supervision epoch");
      }
      configure(message.heartbeatIntervalMs); const identity = await readBuildIdentity(); send({ kind: "ready", identity, nodeVersion: process.versions.node, v8Version: process.versions.v8 });
    } catch { process.exitCode = 1; process.disconnect?.(); }
    return;
  }
  if (!generation || generation !== message.generation) return;
  if (message.kind === "stress-process-registered" || message.kind === "stress-process-intent-registered") { const id = (message as unknown as { processId: string }).processId; const call = calls.get(message.executionId); if (call && equal(call.scope, message.scope)) { processRegistrations.get(id)?.resolve(); processRegistrations.delete(id); } return; }
  if (message.kind === "session-result") { const request = sessionRequests.get(message.requestId); if (request && request.executionId === message.executionId && equal(request.scope, message.scope)) { sessionRequests.delete(message.requestId); if (message.failed) request.reject(new Error("Authorized HTTP session operation failed")); else request.resolve(message.value); } return; }
  if (message.kind === "configure") { configure(message.heartbeatIntervalMs); return; }
  if (message.kind === "shutdown" && !calls.size) { clearInterval(heartbeat); process.disconnect?.(); return; }
  if (message.kind === "cancel") { const call = calls.get(message.executionId); if (call && equal(call.scope, message.scope)) call.controller.abort(new Error("Invocation cancelled")); return; }
  if (message.kind !== "invoke" || calls.has(message.executionId)) return;
  const controller = new AbortController(); calls.set(message.executionId, { controller, scope: message.scope });
  const children = new Set<NativeStressWorkerChannel>();
  let output: Awaited<ReturnType<typeof executeInvocation>> | undefined; let error: string | undefined; let reasonCode: "result-capacity-exceeded" | undefined;
  try {
    const task = TaskEnvelopeV1Schema.parse(message.dto.task); const permit = AgentCommandV1Schema.parse(message.permit);
    if (task.executionId !== message.executionId || !equal(task.scope, message.scope) || permit.kind !== "start-permit" || shared && (task.target.kind !== "debug" || task.executionProfile !== "no-script")) throw new Error("IPC invocation identity or profile mismatch");
    const workerCount = message.dto.inputs.runConfig.stress?.workerCount ?? 1;
    const stress: Omit<NodeStressRunOptions, "signal" | "confirmedTargetOrigins"> | undefined = task.target.kind === "stress" ? { onProgress: progress => send({ kind: "stress-progress", executionId: task.executionId, scope: task.scope, progress }), ...(workerCount > 1 ? { workers: {
      count: workerCount, configuration: { dto: message.dto, permit, lease: childLease }, timeoutMs: Math.max(1, (message.dto.deadlineAt ?? Date.now()) - Date.now()),
      argsFor: identity => [fileURLToPath(new URL("./stressWorkerChild.js", import.meta.url)), identity.runId, identity.workerId],
      spawnWorker: async identity => {
        const processId = `${identity.runId}/${identity.workerId}`;
        const intentRegistered = new Promise<void>((resolve, reject) => processRegistrations.set(processId, { resolve, reject }));
        const intentTimeout = setTimeout(() => processRegistrations.get(processId)?.reject(new Error("Stress spawn intent registration expired")), message.dto.appliedAgentConfig!.workerStartupTimeoutMs);
        send({ kind: "stress-process-intent", executionId: task.executionId, scope: task.scope, processId, ...identity, epoch: childLease?.epoch ?? generation });
        try { await intentRegistered; controller.signal.throwIfAborted(); }
        finally { clearTimeout(intentTimeout); processRegistrations.delete(processId); }
        const channel = spawnLocalStressWorker([`--max-old-space-size=${message.dto.appliedAgentConfig!.childMaxOldSpaceMiB}`, fileURLToPath(new URL("./stressWorkerChild.js", import.meta.url)), identity.runId, identity.workerId], Math.max(1, (message.dto.deadlineAt ?? Date.now()) - Date.now()), { env: Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "LANG", "TZ"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!])) });
        children.add(channel);
        const registration = new Promise<void>((resolve, reject) => processRegistrations.set(processId, { resolve, reject }));
        const timeout = setTimeout(() => processRegistrations.get(processId)?.reject(new Error("Stress process registration expired")), message.dto.appliedAgentConfig!.workerStartupTimeoutMs);
        channel.onClose(() => { void channel.waitForExit!().then(exit => send({ kind: "stress-process-exit", executionId: task.executionId, scope: task.scope, processId, pid: channel.pid, epoch: childLease?.epoch ?? generation, ...exit })); });
        send({ kind: "stress-process", executionId: task.executionId, scope: task.scope, processId, ...identity, pid: channel.pid, epoch: childLease?.epoch ?? generation });
        try { await registration; controller.signal.throwIfAborted(); return channel; }
        catch (error) { await channel.close(); throw error; }
        finally { clearTimeout(timeout); processRegistrations.delete(processId); }
      },
    } } : {}) } : undefined;
    output = await executeInvocation({ ...message.dto, task }, permit, await readBuildIdentity(), controller.signal, task.debugSessionId ? remoteSession(task.executionId, task.scope) : undefined, () => send({ kind: "execution-started", executionId: message.executionId, scope: message.scope }), stress);
    if (Buffer.byteLength(JSON.stringify(output)) > message.dto.inputs.policy.reportBytes) { output = undefined; error = "Projected output exceeds fixed report budget"; reasonCode = "result-capacity-exceeded"; }
  } catch { error = "Execution preparation or invocation rejected"; }
  finally { await Promise.all([...children].map(child => child.close())); calls.delete(message.executionId); for (const [id, request] of sessionRequests) if (request.executionId === message.executionId) { sessionRequests.delete(id); request.reject(new Error("Invocation session authorization ended")); } send({ kind: "done", executionId: message.executionId, scope: message.scope, output, error, reasonCode }); if (!shared) { clearInterval(heartbeat); process.disconnect?.(); } }
});
process.on("disconnect", () => {
  clearInterval(heartbeat); for (const call of calls.values()) call.controller.abort(new Error("Supervision connection lost"));
  for (const request of sessionRequests.values()) request.reject(new Error("Supervision connection lost")); sessionRequests.clear();
  for (const request of processRegistrations.values()) request.reject(new Error("Supervision connection lost")); processRegistrations.clear();
  // This is the last-resort orphan bound, independent of the dead parent's policy timers.
  if (!calls.size) process.exit(0); else setTimeout(() => process.exit(1), 1000);
});
