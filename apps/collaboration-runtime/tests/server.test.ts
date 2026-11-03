import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { startCollaborationRuntime } from "../src/server.js";
import { AssetMutationResultSchema } from "@apicc/core/collaboration/shared";
import { digestJson } from "../src/protocol.js";
import { CompiledMockPlanSchema, SharedMockPolicySchema } from "@apicc/core/collaboration/shared";
import { evaluateMock, validateSharedMock } from "@apicc/core/collaboration";
import { handleOperation } from "../src/handlers.js";
import { RequestSchema } from "../src/protocol.js";
import { archiveInput, policy as projectionPolicy, stressReport } from "../../../packages/core/tests/collaboration/fixtures.js";
import { readFile, appendFile } from "node:fs/promises";
import { channel } from 'node:diagnostics_channel';

const secret = "synthetic-secret-0123456789abcdef";
const digest = (text: string) => digestJson(JSON.parse(text));
const health = () => ({ protocolVersion: 1, operation: "health", requestId: "synthetic-1", inputDigest: digest("{}"), deadlineEpochMs: Date.now() + 5000, outputBudgetBytes: 4096, payload: {} });
const open: Awaited<ReturnType<typeof startCollaborationRuntime>>[] = [];
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { for (const runtime of open.splice(0)) await runtime.close(); });
async function setup(maxWireBytes?: number) {
  let entered = 0;
  const runtime = await startCollaborationRuntime({ secret, port: 0, maxWireBytes, handler: async () => { entered++; return { ready: true }; } });
  open.push(runtime);
  return { runtime, entered: () => entered };
}
async function rpc(url: string, body: unknown, key = secret, path = "/rpc", method = "POST") {
  return fetch(new URL(path, url), { method, headers: { "X-Apicc-Collaboration-Key": key }, ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
}
describe("real loopback RPC admission", () => {
  it('configured bytes reserve both bounded wire directions before an admitted body and release after completion', async () => {
    const started=barrier(), release=barrier(); let entered=0;
    const runtime=await startCollaborationRuntime({secret,port:0,maxWireBytes:1048576,inFlightBytes:2097152,handler:async()=>{entered++;if(entered===1){started.resolve();await release.promise;}return {ready:true};}});open.push(runtime);
    const pending=rpc(runtime.url,health());await started.promise;
    try { expect.soft((await rpc(runtime.url,health())).status).toBe(429); expect.soft(entered).toBe(1); }
    finally { release.resolve();await (await pending).text(); }
    expect((await rpc(runtime.url,health())).status).toBe(200);
  });
  it('zero byte capacity rejects valid authentication and protocol without silently widening', async () => {
    let entered=0;const runtime=await startCollaborationRuntime({secret,port:0,inFlightBytes:0,handler:async()=>{entered++;return {ready:true};}});open.push(runtime);
    expect.soft((await rpc(runtime.url,health())).status).toBe(429);expect(entered).toBe(0);
  });
  it('caller cancellation holds the byte reservation until the owned handler actually settles', async () => {
    const started=barrier(), aborted=barrier(), release=barrier();let entered=0;
    const runtime=await startCollaborationRuntime({secret,port:0,maxWireBytes:1048576,inFlightBytes:2097152,handler:async(_input,signal)=>{entered++;if(entered===1){started.resolve();signal.addEventListener('abort',()=>aborted.resolve(),{once:true});await release.promise;}return {ready:true};}});open.push(runtime);
    const controller=new AbortController();const pending=fetch(runtime.url+'/rpc',{method:'POST',headers:{'X-Apicc-Collaboration-Key':secret},body:JSON.stringify(health()),signal:controller.signal}).catch(()=>undefined);await started.promise;controller.abort();await aborted.promise;
    try {expect.soft((await rpc(runtime.url,health())).status).toBe(429);expect.soft(entered).toBe(1);}
    finally {release.resolve();await pending;}
    // The gate is released by settlement plus response close, not by caller intent alone.
    for(let i=0;i<100;i++){const response=await rpc(runtime.url,health());if(response.status===200)return;await new Promise(done=>setTimeout(done,10));}
    expect.fail('reservation was not collected');
  });
  it('an exceptional handler releases its byte reservation after the real error response', async () => {
    let entered=0;const runtime=await startCollaborationRuntime({secret,port:0,maxWireBytes:1048576,inFlightBytes:2097152,handler:async()=>{if(++entered===1)throw Error('synthetic');return {ready:true};}});open.push(runtime);
    const failed=await rpc(runtime.url,health());expect(failed.status).toBe(500);await failed.text();expect((await rpc(runtime.url,health())).status).toBe(200);
  });
  it('response ownership follows actual finish or close, including reached backpressure', async () => {
    const output={scriptChanged:false,locations:['x'.repeat(24*1048576)]};expect(AssetMutationResultSchema.safeParse(output).success).toBe(true);
    const runtime=await startCollaborationRuntime({secret,port:0,maxWireBytes:32*1048576,inFlightBytes:64*1048576,handler:async(input)=> (input as {operation:string}).operation==='health'?{ready:true}:output});open.push(runtime);
    const payload={beforeFiles:[],afterFiles:[]};const body={...health(),operation:'classify-asset-mutation',payload,inputDigest:digestJson(payload),outputBudgetBytes:32*1048576};
    let actual: import('node:http').ServerResponse|undefined;
    const started=channel('http.server.request.start');
    const observe=(value: unknown)=>{const message=value as {response:import('node:http').ServerResponse,socket:import('node:net').Socket};if(!actual&&message.socket.localPort===Number(new URL(runtime.url).port))actual=message.response;};
    started.subscribe(observe);
    const response=await new Promise<import('node:http').IncomingMessage>((done,reject)=>{const req=request(runtime.url+'/rpc',{method:'POST',headers:{'X-Apicc-Collaboration-Key':secret}},value=>{value.pause();done(value);});req.on('error',reject);req.end(JSON.stringify(body));});
    try {
      expect(response.statusCode).toBe(200);expect(actual).toBeDefined();
      // OS buffering may finish a paused client's response. That is a real release boundary.
      const finished=actual!.writableFinished;
      const next=await rpc(runtime.url,health());expect(next.status).toBe(finished?200:429);
      console.log(`F7F_WIRE_TRANSPORT ${JSON.stringify({finishedBeforeProbe:finished,observedAdmission:next.status,bytes:24*1048576})}`);
      if(process.env.APICC_F7F_RESOURCE_EVIDENCE) await appendFile(process.env.APICC_F7F_RESOURCE_EVIDENCE,JSON.stringify({finishedBeforeProbe:finished,observedAdmission:next.status,bytes:24*1048576})+'\n');
    } finally {started.unsubscribe(observe);response.destroy();}
    for(let i=0;i<100;i++){const next=await rpc(runtime.url,health());if(next.status===200)return;await new Promise(done=>setTimeout(done,10));}
    expect.fail('response close did not collect its reservation');
  });
  it("stop cancels and awaits actual handler settlement before resolving", async () => {
    const started=barrier(), aborted=barrier(), release=barrier();let settled=false;
    const runtime=await startCollaborationRuntime({secret,port:0,handler:async (_input,signal)=>{started.resolve();signal.addEventListener("abort",()=>aborted.resolve(),{once:true});await release.promise;settled=true;return {ready:true};}});
    const pending=rpc(runtime.url,health()).catch(()=>undefined);await started.promise;
    let stopped=false;const stopping=runtime.close().then(()=>{stopped=true;});
    try{await aborted.promise;await new Promise(resolve=>setTimeout(resolve,20));expect.soft(settled).toBe(false);expect.soft(stopped).toBe(false);}finally{release.resolve();await stopping;await pending;}
    expect(settled).toBe(true);
  });
  it("rejects wrong secret before entering handler without leaking secret", async () => {
    const { runtime, entered } = await setup();
    const response = await rpc(runtime.url, "{}", "wrong");
    expect.soft(response.status).toBe(401);
    expect.soft(await response.text()).not.toContain(secret);
    expect(entered()).toBe(0);
  });
  it("authenticates without waiting for unfinished body", async () => {
    const { runtime, entered } = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(new URL("/rpc", runtime.url), { method: "POST", headers: { "X-Apicc-Collaboration-Key": "wrong", "Content-Length": "999999" } }, response => { response.resume(); resolve(response.statusCode!); req.destroy(); });
      req.on("error", reject); req.flushHeaders();
    });
    expect.soft(status).toBe(401); expect(entered()).toBe(0);
  });
  it.each([
    ["path", "/other", "POST", 404], ["method", "/rpc", "GET", 405],
  ])("rejects wrong %s", async (_name, path, method, expected) => {
    const { runtime, entered } = await setup();
    const response = await rpc(runtime.url, health(), secret, path, method);
    expect.soft(response.status).toBe(expected); expect(entered()).toBe(0);
  });
  it.each([
    ["operation", { operation: "eval" }, 400, "RPC_INVALID_REQUEST"],
    ["version", { protocolVersion: 2 }, 400, "RPC_INVALID_REQUEST"],
    ["strict envelope", { extra: true }, 400, "RPC_INVALID_REQUEST"],
    ["strict payload", { payload: { url: "http://forbidden.invalid" }, inputDigest: digest('{"url":"http://forbidden.invalid"}') }, 400, "RPC_INVALID_REQUEST"],
    ["digest", { inputDigest: "0".repeat(64) }, 400, "RPC_INPUT_DIGEST_MISMATCH"],
    ["deadline", { deadlineEpochMs: 1 }, 408, "RPC_DEADLINE_EXCEEDED"],
    ["output budget", { outputBudgetBytes: 0 }, 400, "RPC_INVALID_REQUEST"],
  ])("rejects invalid %s after valid authentication", async (_name, patch, expected, code) => {
    const { runtime, entered } = await setup();
    const response = await rpc(runtime.url, { ...health(), ...patch });
    expect.soft(response.status).toBe(expected);
    expect.soft(await response.json()).toMatchObject({ code, retryable: false });
    expect(entered()).toBe(0);
  });
  it("bounds actual chunked bytes before handler dispatch", async () => {
    const { runtime, entered } = await setup(1024 * 1024);
    const response = await rpc(runtime.url, JSON.stringify({ ...health(), padding: "x".repeat(1024 * 1024) }));
    expect.soft(response.status).toBe(413); expect(entered()).toBe(0);
  });
  it("bounds real transfer-encoding chunked bytes with no Content-Length", async () => {
    const { runtime, entered } = await setup(1024 * 1024);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(new URL("/rpc", runtime.url), { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret, "Transfer-Encoding": "chunked" } }, response => { response.resume(); resolve(response.statusCode!); });
      req.on("error", reject);
      req.write(" ".repeat(600_000)); req.write(" ".repeat(600_000)); req.end(JSON.stringify(health()));
    });
    expect.soft(status).toBe(413); expect(entered()).toBe(0);
  });
  it("accepts a complete legal chunked health as streaming prerequisite", async () => {
    const { runtime, entered } = await setup();
    const text = JSON.stringify(health());
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(new URL("/rpc", runtime.url), { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret, "Transfer-Encoding": "chunked" } }, response => { response.resume(); resolve(response.statusCode!); });
      req.on("error", reject); req.write(text.slice(0, 20)); req.end(text.slice(20));
    });
    expect(status).toBe(200); expect(entered()).toBe(1);
  });
  it("valid health prerequisite reaches real handler", async () => {
    const { runtime, entered } = await setup();
    expect((await rpc(runtime.url, health())).status).toBe(200); expect(entered()).toBe(1);
  });
  it("binds actual output and request identities in a sized envelope", async () => {
    const { runtime } = await setup(); const input = health();
    const response = await rpc(runtime.url, input); const text = await response.text(); const body = JSON.parse(text);
    expect.soft(body).toMatchObject({ protocolVersion: 1, operation: "health", requestId: "synthetic-1", inputDigest: input.inputDigest, payload: { ready: true } });
    expect.soft(body.coreBuildIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect.soft(body.outputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect.soft(body.outputBytes).toBe(Buffer.byteLength(JSON.stringify({ ready: true })));
    expect(body.wireBytes).toBe(Buffer.byteLength(text));
  });
  it("enforces actual enveloped output budget", async () => {
    const { runtime } = await setup();
    expect((await rpc(runtime.url, { ...health(), outputBudgetBytes: 1 })).status).toBe(413);
  });
  it("enforces actual serialized output message bytes", async () => {
    const output = { scriptChanged: false, locations: ["x".repeat(1024 * 1024)] };
    expect(AssetMutationResultSchema.safeParse(output).success).toBe(true);
    const runtime = await startCollaborationRuntime({ secret, port: 0, maxWireBytes: 1024 * 1024, handler: async () => output }); open.push(runtime);
    const payload = { beforeFiles: [], afterFiles: [] };
    expect((await rpc(runtime.url, { ...health(), operation: "classify-asset-mutation", payload, inputDigest: digest(JSON.stringify(payload)), outputBudgetBytes: 2 * 1024 * 1024 })).status).toBe(413);
  });
  it("deadline denies late success and holds admission until actual handler settlement", async () => {
    let entered = 0; const started = barrier(), release = barrier(), settled = barrier();
    const runtime = await startCollaborationRuntime({ secret, port: 0, maxInFlight: 1, handler: async () => { entered++; if (entered === 1) { started.resolve(); await release.promise; settled.resolve(); } return { ready: true }; } }); open.push(runtime);
    const first = rpc(runtime.url, { ...health(), deadlineEpochMs: Date.now() + 250 });
    try {
      await started.promise;
      const result = await Promise.race([first, new Promise<undefined>(resolve => setTimeout(resolve, 400))]);
      expect.soft(result?.status).toBe(408);
      expect.soft((await rpc(runtime.url, health())).status).toBe(429);
    } finally { release.resolve(); }
    await settled.promise; await first;
    expect.soft((await rpc(runtime.url, health())).status).toBe(200); expect(entered).toBe(2);
  });
  it("disconnect cancels ownership but releases admission only after actual settle", async () => {
    let entered = 0; let firstSignal: AbortSignal | undefined;
    const started = barrier(), release = barrier(), settled = barrier();
    const runtime = await startCollaborationRuntime({ secret, port: 0, maxInFlight: 1, handler: async (_input, signal) => { entered++; if (entered === 1) { firstSignal = signal; started.resolve(); await release.promise; settled.resolve(); } return { ready: true }; } }); open.push(runtime);
    const abort = new AbortController();
    const first = fetch(new URL("/rpc", runtime.url), { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret }, body: JSON.stringify(health()), signal: abort.signal }).catch(() => undefined);
    try {
      await started.promise; abort.abort(); await first;
      expect.soft((await rpc(runtime.url, health())).status).toBe(429);
      expect.soft(firstSignal?.aborted).toBe(true);
    } finally { release.resolve(); }
    await settled.promise;
    expect.soft((await rpc(runtime.url, health())).status).toBe(200); expect(entered).toBe(2);
  });
  it("rejects malformed Core output before returning success", async () => {
    const runtime = await startCollaborationRuntime({ secret, port: 0, handler: async () => ({ ready: false }) }); open.push(runtime);
    const response = await rpc(runtime.url, health());
    expect.soft(response.status).toBe(500); expect(await response.json()).toMatchObject({ code: "RPC_INVALID_OUTPUT", retryable: false });
  });
  it("maps unexpected handler errors without emitting source or stack", async () => {
    const runtime = await startCollaborationRuntime({ secret, port: 0, handler: async () => { throw new Error("synthetic-private-source"); } }); open.push(runtime);
    const response = await fetch(new URL("/rpc", runtime.url), { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret }, body: JSON.stringify(health()), signal: AbortSignal.timeout(300) }).catch(() => undefined);
    expect.soft(response?.status).toBe(500); if (response) expect(await response.text()).not.toContain("synthetic-private-source");
  });
  it("awaits actual Core Mock delay before returning success", async () => {
    const plan = CompiledMockPlanSchema.parse({ sourceProjectRevision: "r1", routes: [{ contractId: "api", method: "GET", pathTemplate: "/items", segments: [{ kind: "literal", value: "" }, { kind: "literal", value: "items" }], rules: [{ id: "rule", contractId: "api", responseBindingId: "response", conditions: [], status: 201, mediaType: "text/plain", headers: {}, body: [111, 107], delayMs: 120 }] }] });
    const policy = SharedMockPolicySchema.parse({ maxResponseBytes: 1024, maxDelayMs: 30000, requestDeadlineMs: 35000, extraSensitiveHeaders: [], extraSensitiveQuery: [], extraSensitiveFields: [], extraSensitivePointers: [] });
    const input = { method: "GET", target: "/items", headers: {}, body: [] };
    expect(validateSharedMock(plan, policy)).toEqual([]);
    expect(evaluateMock(plan, { ...input, body: new Uint8Array() })).toMatchObject({ status: 201, delayMs: 120 });
    const runtime = await startCollaborationRuntime({ secret, port: 0 }); open.push(runtime);
    const payload = { plan, policy, input }; const start = performance.now();
    const response = await rpc(runtime.url, { ...health(), operation: "respond-mock", inputDigest: digestJson(payload), payload });
    expect.soft(response.status).toBe(200);
    expect.soft(await response.json()).toMatchObject({ payload: { status: 201, body: [111,107] } });
    expect(performance.now() - start).toBeGreaterThanOrEqual(100);
  });
  it("strictly rejects malformed UTF8 instead of replacing bytes inside request identity", async () => {
    const { runtime, entered } = await setup();
    const text = JSON.stringify({ ...health(), requestId: "BAD_BYTE" });
    const bytes = Buffer.from(text.replace("BAD_BYTE", "\u0001"));
    bytes[bytes.indexOf(1)] = 255;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(new URL("/rpc", runtime.url), { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret, "Content-Length": bytes.length } }, response => { response.resume(); resolve(response.statusCode!); });
      req.on("error", reject); req.end(bytes);
    });
    expect.soft(status).toBe(400); expect(entered()).toBe(0);
  });
  it("cancels a reached actual Core Mock delay without a late success or replay", async () => {
    const plan = CompiledMockPlanSchema.parse({ sourceProjectRevision: "r1", routes: [{ contractId: "api", method: "GET", pathTemplate: "/items", segments: [{ kind: "literal", value: "" }, { kind: "literal", value: "items" }], rules: [{ id: "rule", contractId: "api", responseBindingId: "response", conditions: [], status: 201, mediaType: "text/plain", headers: {}, body: [111,107], delayMs: 600 }] }] });
    const policy = SharedMockPolicySchema.parse({ maxResponseBytes: 1024, maxDelayMs: 30000, requestDeadlineMs: 35000, extraSensitiveHeaders: [], extraSensitiveQuery: [], extraSensitiveFields: [], extraSensitivePointers: [] });
    const input = { method: "GET", target: "/items", headers: {}, body: [] };
    expect(validateSharedMock(plan, policy)).toEqual([]);
    expect(evaluateMock(plan, { ...input, body: new Uint8Array() })).toMatchObject({ status: 201, delayMs: 600 });
    const started = barrier(); let calls = 0;
    const runtime = await startCollaborationRuntime({ secret, port: 0, maxInFlight: 1, handler: async value => {
      const request = value as { operation: string; payload: unknown };
      const result = await handleOperation(request.operation, request.payload);
      if (request.operation === "respond-mock") { calls++; started.resolve(); }
      return result;
    } }); open.push(runtime);
    const payload = { plan, policy, input };
    const pending = rpc(runtime.url, { ...health(), operation: "respond-mock", payload, inputDigest: digestJson(payload), deadlineEpochMs: Date.now() + 200 });
    await started.promise;
    const response = await pending;
    expect.soft(response.status).toBe(408); expect.soft(await response.json()).toMatchObject({ code: "RPC_DEADLINE_EXCEEDED" });
    expect.soft((await rpc(runtime.url, health())).status).toBe(200); expect(calls).toBe(1);
  });
  it("fresh listener loses cache and accepts only an explicit fixed plan reload", async () => {
    const plan = CompiledMockPlanSchema.parse({ sourceProjectRevision: "fixed-r1", routes: [] });
    const policy = SharedMockPolicySchema.parse({ maxResponseBytes: 1024, maxDelayMs: 30000, requestDeadlineMs: 35000, extraSensitiveHeaders: [], extraSensitiveQuery: [], extraSensitiveFields: [], extraSensitivePointers: [] });
    const input = { method: "GET", target: "/items", headers: {}, body: [] }; const planDigest = digestJson(plan);
    expect(validateSharedMock(plan, policy)).toEqual([]);
    const invoke = (url: string, payload: unknown, requestId: string) => rpc(url, { ...health(), requestId, operation: "respond-mock", payload, inputDigest: digestJson(payload) });
    const original = await startCollaborationRuntime({ secret, port: 0 });
    try {
      expect((await invoke(original.url, { plan, policy, input }, "before-restart")).status).toBe(200);
    } finally { await original.close(); }
    const restarted = await startCollaborationRuntime({ secret, port: 0 }); open.push(restarted);
    const missing = await invoke(restarted.url, { planDigest, policy, input }, "after-restart");
    expect.soft(missing.status).toBe(503); expect.soft(await missing.json()).toMatchObject({ code: "RPC_PLAN_UNAVAILABLE", requestId: "after-restart" });
    const reloaded = await invoke(restarted.url, { plan, planDigest, policy, input }, "explicit-reload");
    expect.soft(reloaded.status).toBe(200); expect.soft(await reloaded.json()).toMatchObject({ requestId: "explicit-reload", payload: { status: 404 } });
    const cached = await invoke(restarted.url, { planDigest, policy, input }, "new-cache-call");
    expect.soft(cached.status).toBe(200); expect(await cached.json()).toMatchObject({ requestId: "new-cache-call", payload: { status: 404 } });
  });
  it("binds the received payload digest before legitimate Core wire defaults are applied", async () => {
    const body = stressReport(); delete (body.caseRows.failures as { extraction?: number }).extraction;
    const payload = JSON.parse(JSON.stringify({ input: { ...archiveInput(), report: { format: "stress", body } }, policy: projectionPolicy }));
    const envelope = { ...health(), operation: "project-report", payload, inputDigest: digestJson(payload), outputBudgetBytes: 1_048_576 };
    const parsed = RequestSchema.safeParse(envelope); expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("wire fixture must validate");
    expect(JSON.stringify(parsed.data.payload)).not.toBe(JSON.stringify(payload));
    expect(await handleOperation("project-report", payload)).toMatchObject({ kind: "report" });
    const runtime = await startCollaborationRuntime({ secret, port: 0 }); open.push(runtime);
    const response = await rpc(runtime.url, envelope);
    expect.soft(response.status).toBe(200); expect(await response.json()).toMatchObject({ inputDigest: envelope.inputDigest, payload: { kind: "report" } });
  });
  it.each(["body", "baseline"])("T4-I1 real RPC rejects legacy %s shard error extras before dispatch", async at => {
    const fixtures = JSON.parse(await readFile(new URL("../../../server/src/test/resources/collaboration-runtime-fixtures.json", import.meta.url), "utf8"));
    const valid = fixtures.find((fixture: { name: string }) => fixture.name === `legacy-${at}-valid`).request;
    const invalid = fixtures.find((fixture: { name: string }) => fixture.name === `legacy-${at}-extra`).request;
    expect(RequestSchema.safeParse(valid).success).toBe(true);
    expect(await handleOperation(valid.operation, valid.payload)).toMatchObject({ kind: "report" });
    let entered = 0;
    const runtime = await startCollaborationRuntime({ secret, port: 0, handler: async value => {
      entered++; const input = value as { operation: string; payload: unknown }; return handleOperation(input.operation, input.payload);
    } }); open.push(runtime);
    expect((await rpc(runtime.url, valid)).status).toBe(200); expect(entered).toBe(1);
    const response = await rpc(runtime.url, invalid);
    expect.soft(response.status).toBe(400); expect.soft(await response.json()).toMatchObject({ code: "RPC_INVALID_REQUEST" }); expect(entered).toBe(1);
  });
});
