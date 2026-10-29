import { z } from "zod";
import { StressPhaseSchema } from "./reportV2.js";
import { JsonValueSchema, StringRecordSchema } from "../contract/schemaNode.js";
import type { ExecutableRequest } from "../plugin/types.js";
import { StressSafetySchema } from "./model.js";
import { HttpMethodSchema, KeyValuePairSchema } from "../domain/primitives.js";
import { PRIVATE_EVIDENCE_BYTES } from "../report/evidence.js";
import type { StressClock } from "./execution.js";

/** Merge the private marker source into the run-owned union. */
export function mergeStressWorkerMarkers(target: Set<string>, values: Iterable<string>): void {
  let bytes = 2;
  for (const marker of target) { bytes += Buffer.byteLength(JSON.stringify(marker)) + 1; if (bytes > PRIVATE_EVIDENCE_BYTES) throw new Error("Private evidence union exceeds capacity"); }
  for (const marker of values) if (!target.has(marker)) {
    bytes += Buffer.byteLength(JSON.stringify(marker)) + 1;
    if (bytes > PRIVATE_EVIDENCE_BYTES) throw new Error("Private evidence union exceeds capacity");
    target.add(marker);
  }
}

export const STRESS_WORKER_PROTOCOL_VERSION = 3;
export const STRESS_WORKER_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const STRESS_WORKER_PENDING_BYTES = 1024 * 1024;
const id = z.string().min(1).max(256), n = z.number().finite().nonnegative();
export const StressClockDomainSchema = z.object({ id, basis: z.string().regex(/^\d+$/), precision: id, resolutionMs: n.positive(), uncertaintyMs: n }).strict()
  .refine(value => value.uncertaintyMs >= value.resolutionMs);
export type StressClockDomain = z.infer<typeof StressClockDomainSchema>;
/** Trusted host capability authenticates the actual clock and transport, never a wire flag. */
export type StressClockDomainBinding = (clock: StressClock, channel: StressWorkerChannel) => StressClockDomain | undefined;
export function sameStressClockDomain(left: StressClockDomain, right: StressClockDomain): boolean {
  return left.id === right.id && left.basis === right.basis && left.precision === right.precision;
}
const inputs = StringRecordSchema(JsonValueSchema);
const auth = z.discriminatedUnion("kind", [z.object({ kind: z.literal("none") }).strict(), z.object({ kind: z.literal("bearer"), token: z.string() }).strict(),
  z.object({ kind: z.literal("basic"), username: z.string(), password: z.string() }).strict(), z.object({ kind: z.literal("apikey"), name: z.string(), placement: z.enum(["header", "query"]), value: z.string() }).strict()]);
const file = z.object({ path: z.string() }).strict();
const body = z.union([z.object({ kind: z.enum(["json", "xml", "raw"]), content: z.string() }).strict(), z.object({ kind: z.literal("form"), content: z.string(), form: z.array(KeyValuePairSchema) }).strict(),
  z.object({ kind: z.literal("binary"), file, contentType: z.string() }).strict(), z.object({ kind: z.literal("multipart"), entries: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), name: z.string(), value: z.string(), enabled: z.boolean().optional() }).strict(),
    z.object({ kind: z.literal("file"), name: z.string(), file, filename: z.string().optional(), contentType: z.string(), enabled: z.boolean().optional() }).strict(),
  ])) }).strict()]);
const commonRequest = { url: z.string().max(65536), headers: z.record(z.string(), z.string()), query: z.array(KeyValuePairSchema), auth, cookieHeaderMode: z.enum(["none", "explicit", "parameters"]).optional() };
const request = z.discriminatedUnion("protocol", [z.object({ ...commonRequest, protocol: z.literal("http"), method: HttpMethodSchema, body: body.optional() }).strict(),
  z.object({ ...commonRequest, protocol: z.literal("websocket"), message: z.string().optional() }).strict(), z.object({ ...commonRequest, protocol: z.literal("soap"), method: z.literal("POST"), envelope: z.string(), soapAction: z.string().optional() }).strict()]);
export const StressWorkerCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prepare"), configuration: z.unknown() }).strict(),
  z.object({ type: z.literal("clock") }).strict(),
  z.object({ type: z.literal("progress") }).strict(),
  z.object({ type: z.literal("start"), coordinatorNow: n, workerNow: n, uncertaintyMs: n, clockDomain: StressClockDomainSchema.optional() }).strict(),
  z.object({ type: z.literal("create"), vuId: id, inputs, runStart: n }).strict(),
  z.object({ type: z.literal("execute"), vuId: id, iterationId: id, stageId: z.string().nullable(), phase: StressPhaseSchema, scheduledOffsetMs: n }).strict(),
  z.object({ type: z.literal("close"), vuId: id, reason: z.enum(["duration", "iteration-budget", "user", "root-abort", "drain-timeout", "setup-failed", "execution-failed"]), allowNetworkCleanup: z.boolean() }).strict(),
  z.object({ type: z.literal("phase-at"), vuId: id, iterationId: id.nullable(), stageId: z.string().nullable(), atMs: n }).strict(),
  z.object({ type: z.literal("request-permit"), vuId: id, iterationId: id.nullable(), requestId: id, redirect: z.boolean(), request }).strict(),
  z.object({ type: z.literal("release"), vuId: id, requestId: id, leaseId: id }).strict(),
  z.object({ type: z.literal("record-target"), vuId: id, target: StressSafetySchema.shape.targetOrigins.element }).strict(),
  z.object({ type: z.literal("stop") }).strict(),
  z.object({ type: z.literal("drain") }).strict(),
  z.object({ type: z.literal("marker-ready") }).strict(),
  z.object({ type: z.literal("marker-union"), markers: z.array(z.string()) }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
]);
export type StressWorkerCommand = z.infer<typeof StressWorkerCommandSchema>;
export interface StressWorkerChannel {
  send(message: unknown): void | Promise<void>;
  subscribe(listener: (message: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
  /** Parent marks the requested shutdown and observes actual process completion. */
  waitForExit?(): Promise<{ code: number | null; signal: string | null }>;
  /** Worker disconnects only after its shutdown response was flushed. */
  finish?(): Promise<void>;
}
const envelope = { protocolVersion: z.literal(3), runId: id, workerId: id };
const frameSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("request"), id, command: StressWorkerCommandSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("response"), id, ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ...envelope, kind: z.literal("failure"), id, code: z.enum(["worker-failed", "plugin_runtime_mismatch"]) }).strict(),
]);
const CHUNK_UNITS = 16384;
const MAX_CHUNKS = Math.ceil(STRESS_WORKER_SNAPSHOT_BYTES / CHUNK_UNITS);
const chunkSchema = z.object({ ...envelope, kind: z.literal("chunk"), transferId: id, index: n.int(), total: n.int().positive().max(MAX_CHUNKS), bytes: n.int().positive().max(STRESS_WORKER_SNAPSHOT_BYTES), data: z.string().max(CHUNK_UNITS) }).strict();
export interface StressWorkerPeer {
  request(command: StressWorkerCommand): Promise<unknown>;
  shutdown(): Promise<{ code: number | null; signal: string | null }>;
  close(): Promise<void>;
  readonly failed: boolean;
}
/** Dedicated private IPC. Public stdout is never parsed as a v3 control channel. */
export function createStressWorkerPeer(channel: StressWorkerChannel, identity: { runId: string; workerId: string },
  handle: (command: StressWorkerCommand) => Promise<unknown>, onFailure: () => void = () => {}): StressWorkerPeer {
  let serial = 0, transferSerial = 0, lastRequest = 0, failed = false, shutdownAcknowledged = false, shutdownComplete = false;
  const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; shutdown: boolean }>();
  const transfers = new Map<string, { next: number; total: number; bytes: number; actual: number; chunks: string[] }>();
  let transferBytes = 0;
  const failure = () => {
    if (failed) return; failed = true;
    for (const pending of waiting.values()) pending.reject(new Error("worker-failed")); waiting.clear(); transfers.clear(); transferBytes = 0; onFailure();
  };
  let sendTail: Promise<void> = Promise.resolve();
  const send = (value: unknown): Promise<void> => {
    const frame = sendTail.then(async () => {
      if (failed) throw new Error("worker-failed");
      const text = JSON.stringify(value), bytes = Buffer.byteLength(text);
      if (bytes > STRESS_WORKER_SNAPSHOT_BYTES) throw new Error("snapshot-invalid");
      // Serialize whole frames in enqueue order while retaining per-chunk IPC flush/backpressure.
      const total = Math.ceil(text.length / CHUNK_UNITS), transferId = `${++transferSerial}`;
      for (let index = 0; index < total; index++) await channel.send({ ...identity, protocolVersion: 3, kind: "chunk", transferId, index, total, bytes, data: text.slice(index * CHUNK_UNITS, (index + 1) * CHUNK_UNITS) });
    });
    sendTail = frame.catch(failure);
    return frame;
  };
  const dispatch = (raw: unknown) => {
    const frame = frameSchema.parse(raw);
    if (frame.runId !== identity.runId || frame.workerId !== identity.workerId) throw new Error("worker-incompatible");
    if (frame.kind === "request") {
      const ordinal = Number(frame.id);
      if (!Number.isSafeInteger(ordinal) || ordinal <= lastRequest) throw new Error("worker-incompatible");
      lastRequest = ordinal;
      void Promise.resolve().then(() => handle(frame.command)).then(async (value) => {
        if (failed) return;
        await send({ ...identity, protocolVersion: 3, kind: "response", id: frame.id, ok: true, value });
        if (frame.command.type === "shutdown") { shutdownAcknowledged = true; await channel.finish?.(); shutdownComplete = true; }
      }, async (error: unknown) => {
        const code = frame.command.type === "prepare" && (error as { code?: unknown } | null)?.code === "plugin_runtime_mismatch" ? "plugin_runtime_mismatch" : "worker-failed";
        if (!failed) await send({ ...identity, protocolVersion: 3, kind: "failure", id: frame.id, code });
      }).catch(failure);
    } else {
      const pending = waiting.get(frame.id); if (!pending) throw new Error("worker-incompatible");
      if (frame.kind === "failure") { waiting.delete(frame.id); pending.reject(Object.assign(new Error(frame.code), { code: frame.code })); } else {
        if (pending.shutdown) { z.object({ type: z.literal("shutdown") }).strict().parse(frame.value); shutdownAcknowledged = true; }
        waiting.delete(frame.id);
        pending.resolve(frame.value);
      }
    }
  };
  const unsubscribe = channel.subscribe((raw) => {
    if (failed) return;
    try {
      const frame = chunkSchema.parse(raw);
      if (frame.runId !== identity.runId || frame.workerId !== identity.workerId) throw new Error("worker-incompatible");
      let transfer = transfers.get(frame.transferId);
      if (!transfer) {
        if (frame.index !== 0 || transfers.size >= 128 || transferBytes + frame.bytes > STRESS_WORKER_SNAPSHOT_BYTES) throw new Error("snapshot-invalid");
        transfer = { next: 0, total: frame.total, bytes: frame.bytes, actual: 0, chunks: [] }; transfers.set(frame.transferId, transfer); transferBytes += frame.bytes;
      }
      if (frame.index !== transfer.next || frame.total !== transfer.total || frame.bytes !== transfer.bytes) throw new Error("snapshot-invalid");
      transfer.next++; transfer.chunks.push(frame.data); transfer.actual += Buffer.byteLength(frame.data);
      // Surrogate pairs can span chunks; only the fully reconstructed UTF-8 length is authoritative.
      if (transfer.actual > transfer.bytes + transfer.total * 4) throw new Error("snapshot-invalid");
      if (transfer.next === transfer.total) {
        transfers.delete(frame.transferId); transferBytes -= transfer.bytes;
        const text = transfer.chunks.join(""); if (Buffer.byteLength(text) !== transfer.bytes) throw new Error("snapshot-invalid"); dispatch(JSON.parse(text));
      }
    } catch { failure(); }
  });
  const unclose = channel.onClose(() => { if (!shutdownAcknowledged) failure(); });
  return { get failed() { return failed; }, request(command) {
    if (failed || waiting.size >= 32000) return Promise.reject(new Error("worker-failed"));
    return new Promise((resolve, reject) => {
      const requestId = `${++serial}`; waiting.set(requestId, { resolve, reject, shutdown: command.type === "shutdown" });
      try { void send({ ...identity, protocolVersion: 3, kind: "request", id: requestId, command: StressWorkerCommandSchema.parse(command) }).catch(failure); }
      catch { failure(); }
    });
  }, async shutdown() {
    if (failed || shutdownComplete || !channel.waitForExit) throw new Error("worker-failed");
    const exit = channel.waitForExit();
    try {
      await this.request({ type: "shutdown" });
      const result = await exit;
      if (failed || result.code !== 0 || result.signal !== null) throw new Error("worker-failed");
      shutdownComplete = true; return result;
    } catch (error) { failure(); throw error; }
  }, async close() { unsubscribe(); unclose(); if (!shutdownComplete) failure(); await channel.close(); } };
}

/** Gate authorization depends on the final target, never a fabricated probe URL. */
export function stressWorkerRequest(request: ExecutableRequest): Extract<StressWorkerCommand, { type: "request-permit" }>["request"] {
  return request;
}
