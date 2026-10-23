import { spawn, type ChildProcess, type Serializable } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { privateEvidenceMarkers, PRIVATE_EVIDENCE_BYTES, type ShardOutcome, type SpawnWorker, type StressWorkerSpec } from "@apicc/core";
import type { StressWorkerChannel } from "@apicc/core";

/** v3 children speak only the dedicated private channel; even early stdout is a protocol failure. */
export function spawnLocalStressWorker(args: string[], timeoutMs: number, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): StressWorkerChannel {
  const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = new Set<(value: unknown) => void>(), closes = new Set<() => void>();
  let closed = false, diagnostics = 0, shutdownExpected = false;
  let processExited = false;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once("close", (code, signal) => { processExited = true; resolve({ code, signal }); }));
  const ended = () => { if (closed) return; closed = true; clearTimeout(timer); closes.forEach((listener) => listener()); };
  const kill = () => { child.kill(); ended(); };
  const timer = setTimeout(kill, timeoutMs);
  child.on("message", (value) => messages.forEach((listener) => listener(value)));
  child.on("error", kill); child.on("close", ended); child.on("disconnect", () => { if (!shutdownExpected) kill(); });
  child.stdout?.on("data", kill);
  child.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > PRIVATE_EVIDENCE_BYTES) kill(); });
  return {
    send(value) { return new Promise<void>((resolve, reject) => {
      if (closed || !child.connected) { reject(new Error("worker-failed")); return; }
      child.send(value as Serializable, (error) => { if (error) { kill(); reject(new Error("worker-failed")); } else resolve(); });
    }); },
    subscribe(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
    onClose(listener) { closes.add(listener); if (closed) queueMicrotask(listener); return () => { closes.delete(listener); }; },
    waitForExit() { shutdownExpected = true; return exited; },
    async close() {
      if (!processExited) child.kill();
      await exited;
    },
  };
}

export function processStressWorkerChannel(channel: NodeJS.Process = process): StressWorkerChannel {
  if (!channel.send || !channel.connected) throw new Error("Private worker channel unavailable");
  return {
    send(value) { return new Promise<void>((resolve, reject) => channel.send!(value as Serializable, (error: Error | null) => { if (error) { channel.exitCode = 1; reject(new Error("worker-failed")); } else resolve(); })); },
    subscribe(listener) { channel.on("message", listener); return () => { channel.off("message", listener); }; },
    onClose(listener) { channel.on("disconnect", listener); return () => { channel.off("disconnect", listener); }; },
    async close() { if (channel.connected) channel.disconnect?.(); },
    async finish() { if (channel.connected) channel.disconnect?.(); },
  };
}

const READY = "apicc:private-evidence-ready";
const UNION = "apicc:private-evidence-union";
const PUBLIC_OUTPUT_BYTES = 128 * 1024 * 1024; // Same ceiling as the existing prepared-data stdin message.

function readFrame(value: unknown, kind: string, shardId: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Private evidence protocol invalid");
  const frame = value as Record<string, unknown>;
  if (Object.keys(frame).length !== 3 || frame.kind !== kind || frame.shardId !== shardId
    || Buffer.byteLength(JSON.stringify(frame)) > PRIVATE_EVIDENCE_BYTES + 1024) throw new Error("Private evidence protocol invalid");
  return privateEvidenceMarkers(frame.markers);
}

/** A dedicated trusted-host IPC channel, never stdout/stderr/argv or a persisted public DTO. */
export function createWorkerEvidenceFinalizer(shardId: string, channel: NodeJS.Process = process): (markers: readonly string[]) => Promise<readonly string[]> {
  let used = false;
  return (markers) => new Promise((resolve, reject) => {
    if (used || !channel.send || !channel.connected) { reject(new Error("Private evidence channel unavailable")); return; }
    used = true;
    const cleanup = () => { channel.off("message", onMessage); channel.off("disconnect", onDisconnect); };
    const fail = () => { cleanup(); reject(new Error("Private evidence exchange failed")); };
    const onDisconnect = () => fail();
    const onMessage = (value: unknown) => {
      try { const union = readFrame(value, UNION, shardId); cleanup(); resolve(union); }
      catch { fail(); }
    };
    channel.on("message", onMessage); channel.on("disconnect", onDisconnect);
    try { channel.send!({ kind: READY, shardId, markers: privateEvidenceMarkers(markers) }, (error: Error | null) => { if (error) fail(); }); }
    catch { fail(); }
  });
}

/** Own only the child this invocation creates. Raw diagnostics are drained, never forwarded or echoed. */
export function createPrivateStressWorkerFactory(
  timeoutMs: number,
  argsFor: (spec: StressWorkerSpec) => string[],
  parse: (stdout: string, context: { shardId: string; exitCode?: number | null }) => ShardOutcome,
  spawnChild: typeof spawn = spawn,
): SpawnWorker {
  return (spec, control) => new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawnChild(process.execPath, [...argsFor(spec), "--private-evidence-ipc"], { stdio: ["pipe", "pipe", "pipe", "ipc"] }); }
    catch { reject(new Error("Worker transport startup failed")); return; }
    let settled = false; let ready = false; let unionSent = false; let stdout = ""; let outputBytes = 0; let diagnosticBytes = 0;
    const decoder = new StringDecoder("utf8");
    const cleanup = (closed: boolean) => {
      clearTimeout(timer);
      control.signal.removeEventListener("abort", onAbort);
      child.off("message", onMessage); child.off("disconnect", onDisconnect);
      child.stdout?.off("data", onOutput); child.stderr?.off("data", onDiagnostic); child.stdin?.off("error", onInputError);
      if (closed) { child.off("close", onClose); child.off("error", onError); }
    };
    const fail = (code: string) => {
      if (settled) return;
      settled = true; stdout = ""; cleanup(false);
      child.stdin?.destroy(); child.stdout?.resume(); child.stderr?.resume();
      if (child.connected) child.disconnect();
      child.kill();
      reject(new Error(`shard ${spec.shardId} worker transport failed[${code}]`));
    };
    const onAbort = () => fail("aborted");
    const onInputError = () => fail("stdin_closed");
    const onError = () => fail("process_error");
    const onDisconnect = () => { if (!unionSent) fail("private_channel_closed"); };
    const onOutput = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > PUBLIC_OUTPUT_BYTES) { fail("output_capacity"); return; }
      stdout += decoder.write(chunk);
    };
    const onDiagnostic = (chunk: Buffer) => { diagnosticBytes += chunk.length; if (diagnosticBytes > PRIVATE_EVIDENCE_BYTES) fail("diagnostic_capacity"); };
    const onMessage = (value: unknown) => {
      if (ready) { fail("private_protocol_invalid"); return; }
      let markers: string[];
      try { markers = readFrame(value, READY, spec.shardId); }
      catch { fail("private_protocol_invalid"); return; }
      ready = true;
      void Promise.resolve().then(() => control.finalizeEvidence(markers)).then((union) => {
        if (settled) return;
        try { child.send({ kind: UNION, shardId: spec.shardId, markers: privateEvidenceMarkers(union) }, (error) => { if (error) fail("private_send_failed"); else unionSent = true; }); }
        catch { fail("private_send_failed"); }
      }, () => fail("private_completion_failed"));
    };
    const onClose = (exitCode: number | null) => {
      cleanup(true);
      if (settled) return;
      settled = true;
      try {
        if (!ready || !unionSent) throw new Error("incomplete");
        stdout += decoder.end();
        const result = parse(stdout, { shardId: spec.shardId, exitCode }); stdout = ""; resolve(result);
      } catch { stdout = ""; reject(new Error(`shard ${spec.shardId} worker protocol failed[invalid_or_incomplete] exit=${exitCode}`)); }
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    child.on("message", onMessage); child.on("disconnect", onDisconnect); child.on("close", onClose); child.on("error", onError);
    child.stdout?.on("data", onOutput); child.stderr?.on("data", onDiagnostic); child.stdin?.on("error", onInputError);
    control.signal.addEventListener("abort", onAbort, { once: true });
    if (control.signal.aborted) { onAbort(); return; }
    try { child.stdin?.end(spec.preparedTestData === undefined ? "" : JSON.stringify(spec.preparedTestData)); }
    catch { fail("input_failed"); }
  });
}
