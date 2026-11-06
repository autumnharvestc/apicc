import { createServer, type IncomingMessage } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as waitDelay } from "node:timers/promises";
import { digestJson, RequestSchema, outputSchemas, runtimeErrorCodes, type Operation } from "./protocol.js";
import { handleOperation } from "./handlers.js";
import { PlanCache } from "./cache.js";
import { runtimeLimits, type RuntimeLimits } from "./limits.js";
import { coreBuildIdentity } from "./core-identity.js";
import { createRuntimeSourceHost, type RuntimeSourceOptions } from "./sourceHost.js";

function readBody(request: IncomingMessage, maxWireBytes: number, controller: AbortController): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let receivedBytes = 0; const chunks: Buffer[] = [];
    const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", error); request.off("aborted", aborted); };
    const error = () => { cleanup(); reject(new Error("RPC_CANCELLED")); };
    const aborted = () => { controller.abort(new Error("RPC_CANCELLED")); error(); };
    const data = (chunk: Buffer) => {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxWireBytes) { controller.abort(new Error("RPC_MESSAGE_TOO_LARGE")); request.pause(); cleanup(); reject(new Error("RPC_MESSAGE_TOO_LARGE")); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, receivedBytes)); };
    request.on("data", data); request.on("end", end); request.on("error", error); request.on("aborted", aborted);
  });
}
export async function startCollaborationRuntime(options: RuntimeLimits & {
  secret: string; host?: string; port?: number; maxInFlight?: number; source?: RuntimeSourceOptions;
  handler?: (input: unknown, signal: AbortSignal) => Promise<unknown>;
}) {
  const { cacheBytes, maxWireBytes, inFlightBytes } = runtimeLimits(options);
  const identity = await coreBuildIdentity(); const cache = new PlanCache(cacheBytes, identity);
  const sourceHost = options.source ? await createRuntimeSourceHost(options.source) : undefined;
  const secretHash = createHash("sha256").update(options.secret).digest();
  let active = 0, reservedBytes = 0;
  // Conservative reservation for both bounded wire buffers. This is not exact JS heap/RSS measurement.
  const reservation = 2 * maxWireBytes;
  const controllers=new Set<AbortController>();const drained=new Set<()=>void>();let stopping:Promise<void>|undefined;
  const server = createServer(async (request, response) => {
    let requestId = ""; let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const sendError = (status: number, code: string) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, { "Content-Type": "application/json", "Connection": "close" });
      response.end(JSON.stringify({ code, requestId, retryable: false }));
    };
    const provided = request.headers["x-apicc-collaboration-key"];
    const candidate = createHash("sha256").update(typeof provided === "string" ? provided : "").digest();
    if (!timingSafeEqual(secretHash, candidate)) { sendError(401, "RPC_UNAUTHORIZED"); return; }
    if (request.url !== "/rpc") { sendError(404, "RPC_NOT_FOUND"); return; }
    if (request.method !== "POST") { sendError(405, "RPC_METHOD_NOT_ALLOWED"); return; }
    if (active >= (options.maxInFlight ?? 64) || (inFlightBytes !== undefined && reservation > inFlightBytes - reservedBytes)) { sendError(429, "RPC_BUSY"); return; }
    active++; reservedBytes += reservation;
    controllers.add(controller);
    const transportCollected = new Promise<void>(done => {
      const collect = () => { response.off('finish', collect); response.off('close', closed); done(); };
      const closed = () => { if (!response.writableFinished) controller.abort(new Error('RPC_CANCELLED')); collect(); };
      response.once('finish', collect); response.once('close', closed);
    });
    try {
      const bytes = await readBody(request, maxWireBytes, controller);
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("RPC_INVALID_REQUEST"); }
      const parsed = RequestSchema.safeParse(raw);
      if (!parsed.success) throw new Error("RPC_INVALID_REQUEST");
      const input = parsed.data; requestId = input.requestId;
      // Hash the received JSON tree; legitimate Core defaults belong to the
      // derived handler input, not to the caller's transmitted identity.
      if (digestJson((raw as { payload: unknown }).payload) !== input.inputDigest) throw new Error("RPC_INPUT_DIGEST_MISMATCH");
      if (input.deadlineEpochMs <= Date.now()) throw new Error("RPC_DEADLINE_EXCEEDED");
      const expire = () => {
        const remaining = input.deadlineEpochMs - Date.now();
        if (remaining > 0) { timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); return; }
        controller.abort(new Error("RPC_DEADLINE_EXCEEDED")); sendError(408, "RPC_DEADLINE_EXCEEDED");
      };
      expire();
      const output = options.handler ? await options.handler(input, controller.signal) : await handleOperation(input.operation, input.payload, { cache, sourceHost, signal: controller.signal, deadlineEpochMs: input.deadlineEpochMs });
      if (controller.signal.aborted || input.deadlineEpochMs <= Date.now()) throw new Error("RPC_DEADLINE_EXCEEDED");
      const checked = outputSchemas[input.operation as Operation].safeParse(output);
      if (!checked.success) throw new Error("RPC_INVALID_OUTPUT");
      const payload = checked.data;
      if (input.operation === "respond-mock" && "delayMs" in payload && payload.delayMs > 0) {
        try { await waitDelay(payload.delayMs, undefined, { signal: controller.signal }); }
        catch { throw controller.signal.reason; }
      }
      if (controller.signal.aborted || input.deadlineEpochMs <= Date.now()) throw new Error("RPC_DEADLINE_EXCEEDED");
      const envelope = { protocolVersion: 1, operation: input.operation, requestId, inputDigest: input.inputDigest,
        deadlineEpochMs: input.deadlineEpochMs, outputBudgetBytes: input.outputBudgetBytes, coreBuildIdentity: identity,
        outputDigest: digestJson(payload), outputBytes: Buffer.byteLength(JSON.stringify(payload)), wireBytes: 0, payload };
      let text = JSON.stringify(envelope);
      while (envelope.wireBytes !== Buffer.byteLength(text)) { envelope.wireBytes = Buffer.byteLength(text); text = JSON.stringify(envelope); }
      if (Buffer.byteLength(text) > maxWireBytes || Buffer.byteLength(text) > input.outputBudgetBytes) throw new Error("RPC_MESSAGE_TOO_LARGE");
      if (!response.destroyed && !response.writableEnded) { response.writeHead(200, { "Content-Type": "application/json" }); response.end(text); }
    } catch (error) {
      const reported = (error as { code?: unknown })?.code ?? (error instanceof Error ? error.message : undefined);
      const code = typeof reported === "string" && runtimeErrorCodes.has(reported) ? reported : "RPC_INTERNAL_ERROR";
      const status = code === "RPC_DEADLINE_EXCEEDED" ? 408 : code === "RPC_MESSAGE_TOO_LARGE" ? 413 : code === "SYNC_BUSY" ? 429 : code === "RPC_PLAN_UNAVAILABLE" || code === "SYNC_HOST_UNAVAILABLE" ? 503 : code === "RPC_INTERNAL_ERROR" || code === "RPC_INVALID_OUTPUT" ? 500 : 400;
      sendError(status, code);
    } finally {
      // Both execution/read settlement and actual response finish/close own the reservation.
      await transportCollected;
      if (timer) clearTimeout(timer); controllers.delete(controller); reservedBytes -= reservation; active--;
      if(active===0){for(const done of drained)done();drained.clear();}
    }
  });
  try { await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => { server.off("error", failed); resolve(); });
  }); } catch (error) { await sourceHost?.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return { url: `http://127.0.0.1:${address.port}`, sourceCapacity: () => sourceHost?.capacity() ?? { held: 0, retained: 0 }, close: () => stopping ??= (async()=>{
    const settled=active===0?Promise.resolve():new Promise<void>(resolve=>drained.add(resolve));
    for(const controller of controllers)controller.abort(new Error("RPC_CANCELLED"));
    const closed=new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
    await Promise.all([closed,settled]);
    await sourceHost?.close();
  })() };
}
