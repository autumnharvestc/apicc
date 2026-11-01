import { describe, expect, it } from "vitest";
import { createAiInvocationHost } from "../../src/ai/invocation.js";
import { credentials, resolved } from "./invocation.fixture.js";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
describe("AI auxiliary shared resources", () => {
  it("queues behind the same business slot; cancelled queued discovery never sends", async () => {
    const entered = deferred<void>(), release = deferred<void>(), calls: { url: string; init?: RequestInit }[] = [];
    const config = resolved();
    const host = createAiInvocationHost({ credentials, fetch: async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ data: [{ id: "one" }] }); } });
    const business = host.run({ resolved: config, signal: new AbortController().signal }, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const abort = new AbortController(); let auxiliaryEntered = false;
    const queued = host.runAuxiliary({ connection: config.connection, protection: config.protection, signal: abort.signal, timeoutMs: 1000 }, async s => { auxiliaryEntered = true; return s.request(); }).catch(error => error);
    await Promise.resolve(); expect(auxiliaryEntered).toBe(false); abort.abort();
    const outcome = await queued;
    release.resolve(); await business;
    expect(outcome).toMatchObject({ code: "cancelled" }); expect(calls).toEqual([]);
    const text = await host.runAuxiliary({ connection: config.connection, protection: config.protection, signal: new AbortController().signal, timeoutMs: 1000 }, s => s.request());
    expect(JSON.parse(text)).toEqual({ data: [{ id: "one" }] });
    expect(calls).toHaveLength(1); expect(calls[0]!.url).toBe("https://example.com/gateway/v1/models");
    expect(calls[0]!.init).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: "Bearer test-secret" } });
  });
  it("shares retained body buffer with business calls and releases it on read cancellation", async () => {
    const held = deferred<void>(); let reads = 0, cancelled = false;
    const config = resolved(); config.protection.hostConcurrency = 2; config.protection.hostPayloadBufferBytes = 12;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { if (++reads === 1) controller.enqueue(new TextEncoder().encode("12345678")); else held.resolve(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    let calls = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => ++calls === 1 ? new Response(body) : new Response("12345678") });
    const abort = new AbortController();
    const auxiliary = host.runAuxiliary({ connection: config.connection, protection: config.protection, signal: abort.signal, timeoutMs: 1000 }, s => s.request()).catch(error => error);
    await Promise.race([held.promise, auxiliary.then(error => { throw error; })]);
    const business = await host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke({ kind: "initial", messages: [{ role: "user", content: "JSON" }], outputSchema: {} })).catch(error => error);
    expect(business).toMatchObject({ code: "payload-limit" });
    abort.abort(); expect(await auxiliary).toMatchObject({ code: "cancelled" }); expect(cancelled).toBe(true);
  });
});
