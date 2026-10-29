import { randomUUID } from "node:crypto";
import { spawn, type Serializable } from "node:child_process";
import { PRIVATE_EVIDENCE_BYTES, createPreparedStressHost, createStressAccumulator, createStressRequestGate,
  assertStressTargetAllowed, runStressPlan, runLocalStressWorkers,
  type StressClock, type StressClockDomainBinding, type StressWorkerChannel, type PreparedStressExecution,
  type PreparedStressHostDeps, type StressRequestGate, type StressProgress } from "@apicc/core";
import { localStressClock, nativeStressClockDomain } from "./nodeStressClock.js";
export { localStressClock } from "./nodeStressClock.js";

const nativeChannels = new WeakSet<StressWorkerChannel>();
export const localStressClockDomain: StressClockDomainBinding = (clock, channel) => nativeChannels.has(channel) ? nativeStressClockDomain(clock) : undefined;

/** A child has one private IPC channel. Stdout invalidates the transport; diagnostics stay private. */
export interface NativeStressWorkerChannel extends StressWorkerChannel { readonly pid: number | undefined;onSpawn(listener:()=>void):()=>void;onExit(listener:()=>void):()=>void }
export function spawnLocalStressWorker(args: string[], timeoutMs: number, options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean } = {}): NativeStressWorkerChannel {
  const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = new Set<(value: unknown) => void>(), closes = new Set<() => void>();
  const spawns=new Set<()=>void>(),exits=new Set<()=>void>();let processSpawned=false;
  child.once('spawn',()=>{processSpawned=true;spawns.forEach(listener=>listener());});
  let closed = false, diagnostics = 0, shutdownExpected = false, processExited = false;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once("close", (code, signal) => { processExited = true;exits.forEach(listener=>listener()); resolve({ code, signal }); }));
  const ended = () => { if (closed) return; closed = true; clearTimeout(timer); closes.forEach(listener => listener()); };
  const kill = () => { child.kill(); ended(); };
  const timer = setTimeout(kill, timeoutMs);
  child.on("message", value => messages.forEach(listener => listener(value)));
  child.on("error", kill); child.on("close", ended); child.on("disconnect", () => { if (!shutdownExpected) kill(); });
  child.stdout?.on("data", kill);
  child.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > PRIVATE_EVIDENCE_BYTES) kill(); });
  const channel: NativeStressWorkerChannel = {
    get pid() { return child.pid; },
    onSpawn(listener){spawns.add(listener);if(processSpawned)queueMicrotask(listener);return()=>spawns.delete(listener);},
    onExit(listener){exits.add(listener);if(processExited)queueMicrotask(listener);return()=>exits.delete(listener);},
    send(value) { return new Promise<void>((resolve, reject) => {
      if (closed || !child.connected) { reject(new Error("worker-failed")); return; }
      child.send(value as Serializable, error => { if (error) { kill(); reject(new Error("worker-failed")); } else resolve(); });
    }); },
    subscribe(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
    onClose(listener) { closes.add(listener); if (closed) queueMicrotask(listener); return () => { closes.delete(listener); }; },
    waitForExit() { shutdownExpected = true; return exited; },
    async close() { if (!processExited) child.kill(); await exited; },
  };
  nativeChannels.add(channel); return channel;
}
export function processStressWorkerChannel(channel: NodeJS.Process = process): StressWorkerChannel {
  if (!channel.send || !channel.connected) throw new Error("Private worker channel unavailable");
  const transport: StressWorkerChannel = {
    send(value) { return new Promise<void>((resolve, reject) => channel.send!(value as Serializable, (error: Error | null) => { if (error) { channel.exitCode = 1; reject(new Error("worker-failed")); } else resolve(); })); },
    subscribe(listener) { channel.on("message", listener); return () => { channel.off("message", listener); }; },
    onClose(listener) { channel.on("disconnect", listener); return () => { channel.off("disconnect", listener); }; },
    async close() { if (channel.connected) channel.disconnect?.(); },
    async finish() { if (channel.connected) channel.disconnect?.(); },
  };
  if (channel === process) nativeChannels.add(transport); return transport;
}
export function createPlanGate(execution: PreparedStressExecution, confirmedTargetOrigins: string[], clock: StressClock): StressRequestGate {
  const { compiled, run } = execution;
  let gate: StressRequestGate;
  gate = createStressRequestGate({ clock, maxConcurrency: compiled.schedule.effective.maxRequestConcurrency, maxRps: compiled.schedule.effective.maxRps ?? undefined,
    authorizeRequest(request) {
      const policy = { ...run.snapshot.project.stressPolicy, trustedOrigins: [...(run.snapshot.project.stressPolicy.trustedOrigins ?? [])], deniedOrigins: [...(run.snapshot.project.stressPolicy.deniedOrigins ?? [])] };
      const decision = assertStressTargetAllowed({ url: request.url, policy, confirmedTargetOrigins, concurrency: compiled.schedule.effective.maxRequestConcurrency, maxRps: compiled.schedule.effective.maxRps ?? undefined });
      gate.recordTarget?.({ origin: decision.targetOrigin, confirmation: decision.confirmation, loopback: decision.loopback,
        policy: decision.confirmation === "project-policy" ? "trusted" : decision.appliedPolicy.maxConcurrency !== undefined || decision.appliedPolicy.maxRps !== undefined ? "explicit-limited" : "none", appliedPolicy: decision.appliedPolicy });
    } });
  return gate;
}
export interface NodeStressWorkers {
  count: number; configuration: unknown;
  argsFor(identity: { runId: string; workerId: string }): string[];
  timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv;
  spawnWorker?: (identity: { runId: string; workerId: string }) => Promise<StressWorkerChannel>;
}
export interface NodeStressRunOptions {
  signal: AbortSignal; confirmedTargetOrigins?: string[]; workers?: NodeStressWorkers;
  onProgress?: (progress: StressProgress) => void;
}
export class NodeStressRunError extends Error {
  constructor(message: string, readonly started: boolean, readonly requests: { started: number; completed: number }) { super(message); }
}
/** Uses the sole Core scheduler/metrics kernel. Callers own the exclusive process and fixed material leases. */
export async function runNodeStressPlan(execution: PreparedStressExecution, deps: PreparedStressHostDeps, options: NodeStressRunOptions) {
  const evidence = deps.evidence; let started = false; const requests = { started: 0, completed: 0 };
  try {
    const confirmed = options.confirmedTargetOrigins ?? [];
    const host = createPreparedStressHost(execution, deps, { confirmedTargetOrigins: confirmed });
    const runId = randomUUID(), accumulator = createStressAccumulator(execution.compiled.metricPlan, runId);
    const updateFacts = () => { const value = accumulator.readProgress().requests; requests.started = value.started; requests.completed = value.completed; };
    const metrics = { ...accumulator, observe(event: Parameters<typeof accumulator.observe>[0]) {
      if (event.kind !== "iteration") started = true;
      accumulator.observe(event); updateFacts();
    }, merge(snapshot: Parameters<typeof accumulator.merge>[0]) {
      accumulator.merge(snapshot);
      // Accepted worker snapshots also contain pre-measurement VU lifecycle observations.
      if (snapshot.phases.some(phase => phase.observations.caseRows.total > 0 || phase.observations.httpExchanges.started > 0)
        || snapshot.nodes.some(node => node.visits > 0)) started = true;
      updateFacts();
    } };
    const common = { ...host, runId, clock: localStressClock, gate: createPlanGate(execution, confirmed, localStressClock), metrics, evidence, signal: options.signal,
      onProgress(progress: StressProgress) { if (progress.state === "running") started = true; requests.started = progress.requests.started; requests.completed = progress.requests.completed; options.onProgress?.(progress); } };
    const workers = options.workers;
    return !workers || workers.count === 1 ? await runStressPlan(execution, common) : await runLocalStressWorkers(execution, { ...common, shards: workers.count,
      configuration: workers.configuration, clockDomain: localStressClockDomain,
      spawnWorker: identity => workers.spawnWorker?.(identity) ?? Promise.resolve(spawnLocalStressWorker(workers.argsFor(identity), workers.timeoutMs, { cwd: workers.cwd, env: workers.env })) });
  } catch (error) {
    throw new NodeStressRunError(evidence.boundary().redactText(error instanceof Error ? error.message : String(error)), started, requests);
  }
}
