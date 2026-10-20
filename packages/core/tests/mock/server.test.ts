import { createServer as createNetServer, request as httpRequest, ServerResponse, type IncomingMessage } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import * as core from "../../src/index.js";
import type { CompiledMockPlan } from "../../src/mock/compile.js";
import type { MockDiagnostic } from "../../src/mock/config.js";
import { createMockConfiguredProject } from "../helpers/mockFixtures.js";

type MockServerState = "starting" | "running" | "reloading" | "invalid" | "stopping" | "stopped";

interface MockServerHandle {
  readonly address: { address: string; family: string; port: number };
  readonly status: MockServerState;
  beginReload(): void;
  reload(nextPlan: CompiledMockPlan): Promise<void>;
  invalidate(diagnostics: readonly MockDiagnostic[]): void;
  logs(): readonly Record<string, unknown>[];
  stop(): Promise<void>;
}

const startMockServer = (core as unknown as {
  startMockServer?: (plan: CompiledMockPlan, options?: { port?: number; signal?: AbortSignal }) => Promise<MockServerHandle>;
}).startMockServer;

const extraRoutes = {
  headContract: "10000000-0000-4000-8000-000000000031",
  headRule: "10000000-0000-4000-8000-000000000032",
  headResponse: "10000000-0000-4000-8000-000000000033",
  headExample: "10000000-0000-4000-8000-000000000034",
  emptyContract: "10000000-0000-4000-8000-000000000041",
  emptyRule: "10000000-0000-4000-8000-000000000042",
  emptyResponse: "10000000-0000-4000-8000-000000000043",
  emptyExample: "10000000-0000-4000-8000-000000000044",
  delayedContract: "10000000-0000-4000-8000-000000000051",
  delayedRule: "10000000-0000-4000-8000-000000000052",
  delayedResponse: "10000000-0000-4000-8000-000000000053",
  delayedExample: "10000000-0000-4000-8000-000000000054",
  earlyRule: "10000000-0000-4000-8000-000000000061",
  defaultRule: "10000000-0000-4000-8000-000000000062",
} as const;

const delayedExampleValue = "d".repeat(1_048_574);

function configuredProject(): ReturnType<typeof createMockConfiguredProject> {
  const project = createMockConfiguredProject();
  const api = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
  if (api.contract.request.protocol !== "http") throw new Error("Mock fixture must use HTTP.");
  api.contract.request.method = "POST";
  api.contract.request.path = "/items/{id}";
  const primaryResponse = api.contract.responses[0]!;
  if (primaryResponse.kind !== "inline") throw new Error("Mock fixture response must be inline.");
  const primaryExample = primaryResponse.content["application/json"]!.examples[0]!;
  if (primaryExample.kind !== "inline") throw new Error("Mock fixture example must be inline.");
  primaryExample.value = { version: "primary" };
  project.mock.rules[0]!.conditions = [
    { source: "query", op: "equals", name: "view", value: "full" },
    { source: "header", op: "equals", name: "x-mock-case", value: "yes" },
    { source: "body", op: "equals", pointer: "/kind", value: "special" },
  ];

  addRoute(project, {
    contractId: extraRoutes.headContract,
    ruleId: extraRoutes.headRule,
    responseId: extraRoutes.headResponse,
    exampleId: extraRoutes.headExample,
    path: "/head",
    method: "HEAD",
    status: 200,
    delayMs: 0,
  });
  addRoute(project, {
    contractId: extraRoutes.emptyContract,
    ruleId: extraRoutes.emptyRule,
    responseId: extraRoutes.emptyResponse,
    exampleId: extraRoutes.emptyExample,
    path: "/empty",
    method: "GET",
    status: 204,
    delayMs: 0,
  });
  addRoute(project, {
    contractId: extraRoutes.delayedContract,
    ruleId: extraRoutes.delayedRule,
    responseId: extraRoutes.delayedResponse,
    exampleId: extraRoutes.delayedExample,
    path: "/delayed",
    method: "GET",
    status: 200,
    delayMs: 160,
  });
  setExampleValue(project, extraRoutes.delayedContract, delayedExampleValue);

  const bodyRule = project.mock.rules[0]!;
  const earlyRule = structuredClone(bodyRule);
  earlyRule.id = extraRoutes.earlyRule;
  earlyRule.conditions = [
    { source: "query", op: "equals", name: "view", value: "header" },
    { source: "header", op: "equals", name: "x-mock-case", value: "header-only" },
  ];
  earlyRule.status = 201;
  const defaultRule = structuredClone(bodyRule);
  defaultRule.id = extraRoutes.defaultRule;
  defaultRule.conditions = [];
  defaultRule.status = 202;
  const additionalRouteRules = project.mock.rules.slice(1);
  project.mock.rules = [earlyRule, bodyRule, defaultRule, ...additionalRouteRules];
  return project;
}

function addRoute(
  project: ReturnType<typeof createMockConfiguredProject>,
  route: { contractId: string; ruleId: string; responseId: string; exampleId: string; path: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; status: number; delayMs: number },
): void {
  const folder = project.collections[0]!.folders[0]!.folders[0]!;
  const source = folder.apis[0]!;
  const api = structuredClone(source);
  api.contract.id = route.contractId;
  if (api.contract.request.protocol !== "http") throw new Error("Mock fixture must use HTTP.");
  api.contract.request.method = route.method;
  api.contract.request.path = route.path;
  const response = api.contract.responses[0]!;
  if (response.kind !== "inline") throw new Error("Mock fixture response must be inline.");
  response.id = route.responseId;
  response.status = String(route.status);
  const example = response.content["application/json"]!.examples[0]!;
  if (example.kind !== "inline") throw new Error("Mock fixture example must be inline.");
  example.id = route.exampleId;
  example.value = { version: "delayed-old" };
  folder.apis.push(api);
  project.mock.enabledContractIds.push(route.contractId);
  project.mock.rules.push({
    ...structuredClone(project.mock.rules[0]!),
    id: route.ruleId,
    contractId: route.contractId,
    conditions: [],
    responseBindingId: route.responseId,
    source: { kind: "example", exampleBindingId: route.exampleId },
    status: route.status,
    delayMs: route.delayMs,
  });
}

function setExampleValue(project: ReturnType<typeof createMockConfiguredProject>, contractId: string, value: string): void {
  const api = project.collections[0]!.folders[0]!.folders[0]!.apis.find((candidate) => candidate.contract.id === contractId)!;
  const response = api.contract.responses[0]!;
  if (response.kind !== "inline") throw new Error("Mock fixture response must be inline.");
  const example = response.content["application/json"]!.examples[0]!;
  if (example.kind !== "inline") throw new Error("Mock fixture example must be inline.");
  example.value = value;
}

function compile(project: ReturnType<typeof createMockConfiguredProject>): CompiledMockPlan {
  const result = core.compileProjectMock(createProjectSnapshot(project));
  if (!result.ok) throw new Error(`Mock fixture failed to compile: ${result.diagnostics.map((item) => item.code).join(",")}`);
  return result.plan;
}

function baseUrl(server: MockServerHandle): string {
  return `http://127.0.0.1:${server.address.port}`;
}

async function assertPortIsReleased(port: number): Promise<void> {
  const probe = createTcpServer();
  probe.listen({ host: "127.0.0.1", port });
  await once(probe, "listening");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
}

function requestStatus(url: string, method: string, body?: Buffer, extraHeaders: Record<string, string | string[]> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method,
      agent: false,
      headers: { ...(body ? { "Content-Length": body.byteLength } : {}), ...extraHeaders },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    if (body) request.end(body);
    else request.end();
  });
}

function observeNodeDelay(delayMs: number, hold = false): { started: Promise<void>; release(): void; restore(): void } {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let resolveStarted!: () => void;
  let heldTimer: ReturnType<typeof setTimeout> | undefined;
  let heldCallback: (() => void) | undefined;
  let matched = false;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  globalThis.setTimeout = ((...args: Parameters<typeof originalSetTimeout>) => {
    const [handler, timeout, ...handlerArgs] = args;
    if (!matched && timeout === delayMs && typeof handler === "function") {
      matched = true;
      resolveStarted();
      if (hold) {
        heldTimer = originalSetTimeout(() => {}, 2_147_483_647);
        (heldTimer as NodeJS.Timeout).unref();
        heldCallback = () => { Reflect.apply(handler, undefined, handlerArgs); };
        return heldTimer;
      }
    }
    return Reflect.apply(originalSetTimeout, globalThis, args);
  }) as typeof setTimeout;
  return {
    started,
    release() {
      if (!heldTimer || !heldCallback) throw new Error("No observed Node delay is being held");
      originalClearTimeout(heldTimer);
      const callback = heldCallback;
      heldTimer = undefined;
      heldCallback = undefined;
      callback();
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      if (heldTimer) originalClearTimeout(heldTimer);
      heldTimer = undefined;
      heldCallback = undefined;
    },
  };
}

function requestIncompleteOversizedBody(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest(url, { method: "POST", agent: false, headers: { "Content-Length": "1048577" } }, (response) => {
      response.resume();
      response.once("end", () => finish(response.statusCode ?? 0));
    });
    const timer = setTimeout(() => fail(new Error("The server did not reject an incomplete oversized request body promptly.")), 1_500);
    const finish = (status: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(status);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      reject(error);
    };
    request.once("error", fail);
    request.write("x");
  });
}

describe("startMockServer", () => {
  it("serves compiled rules over HTTP and atomically reloads without logging request secrets", async () => {
    if (!startMockServer) throw new Error("startMockServer is not exported from the Node core entry.");
    const project = configuredProject();
    const oldPlan = compile(project);
    let server: MockServerHandle | undefined;
    try {
      server = await startMockServer(oldPlan, { port: 0 });
      expect(server.address.address).toBe("127.0.0.1");
      expect(server.status).toBe("running");
      const origin = baseUrl(server);

      const matched = await fetch(`${origin}/items/item-7?view=full&private=QUERY_SENTINEL`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mock-case": "yes",
          "x-private": "HEADER_SENTINEL",
          authorization: "AUTH_SENTINEL",
          cookie: "sid=COOKIE_SENTINEL",
        },
        body: JSON.stringify({ kind: "special", private: "BODY_SENTINEL" }),
      });
      expect(matched.status).toBe(200);
      expect(matched.headers.get("x-mock-fixture")).toBe("fixed");
      expect(matched.headers.get("content-length")).toBe(String(Buffer.byteLength('{"version":"primary"}')));
      expect(await matched.text()).toBe('{"version":"primary"}');

      expect(await requestStatus(`${origin}/items/item-7?view=header`, "POST", Buffer.from("{"), { "x-mock-case": "header-only" })).toBe(201);
      expect(await requestStatus(`${origin}/items/item-7?view=full`, "POST", Buffer.alloc(0), { "x-mock-case": "yes" })).toBe(202);
      const unmatched = await fetch(`${origin}/items/item-7?view=partial`, { method: "POST", body: "{}" });
      expect(unmatched.status).toBe(202);
      const unknown = await fetch(`${origin}/missing`);
      expect(unknown.status).toBe(404);

      const head = await fetch(`${origin}/head`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const empty = await fetch(`${origin}/empty`);
      expect(empty.status).toBe(204);
      expect(await empty.text()).toBe("");

      const responsePrototype = ServerResponse.prototype;
      const originalEmitDescriptor = Object.getOwnPropertyDescriptor(responsePrototype, "emit");
      const originalEmit = responsePrototype.emit;
      const finishObservations: Array<{ before: number; after: number }> = [];
      const oldDelayedLogCount = (): number => server!.logs().filter((record) => record.ruleId === extraRoutes.delayedRule && record.revision === oldPlan.sourceProjectRevision).length;
      const observedEmit = function (this: ServerResponse, eventName: string | symbol, ...args: unknown[]): boolean {
        if (eventName !== "finish" || this.statusCode !== 200 || String(this.getHeader("content-length")) !== "1048576") {
          return Reflect.apply(originalEmit, this, [eventName, ...args]) as boolean;
        }
        const before = oldDelayedLogCount();
        const emitted = Reflect.apply(originalEmit, this, [eventName, ...args]) as boolean;
        queueMicrotask(() => finishObservations.push({ before, after: oldDelayedLogCount() }));
        return emitted;
      };
      Object.defineProperty(responsePrototype, "emit", { configurable: true, writable: true, value: observedEmit });
      let oldResponseStatus = 0;
      let oldResponseBody: Buffer;
      let newPlan: CompiledMockPlan;
      const oldDelay = observeNodeDelay(160, true);
      let oldRequestSettled = false;
      const oldResponsePromise = fetch(`${origin}/delayed`).then(async (response) => {
        oldRequestSettled = true;
        oldResponseStatus = response.status;
        return Buffer.from(await response.arrayBuffer());
      }).finally(() => { oldRequestSettled = true; });
      try {
        await oldDelay.started;
        expect(oldRequestSettled).toBe(false);
        expect(oldDelayedLogCount()).toBe(0);
        server.beginReload();
        expect(server.status).toBe("reloading");
        const reloading = await fetch(`${origin}/delayed`);
        expect(reloading.status).toBe(503);

        const nextProject = structuredClone(project);
        const delayedApi = nextProject.collections[0]!.folders[0]!.folders[0]!.apis.find((api) => api.contract.id === extraRoutes.delayedContract)!;
        const delayedResponse = delayedApi.contract.responses[0]!;
        if (delayedResponse.kind !== "inline") throw new Error("Delayed fixture response must be inline.");
        const delayedExample = delayedResponse.content["application/json"]!.examples[0]!;
        if (delayedExample.kind !== "inline") throw new Error("Delayed fixture example must be inline.");
        delayedExample.value = "n".repeat(1_048_574);
        nextProject.mock.rules = nextProject.mock.rules.filter((rule) => rule.id !== extraRoutes.defaultRule);
        newPlan = compile(nextProject);
        expect(newPlan.sourceProjectRevision).not.toBe(oldPlan.sourceProjectRevision);
        await server.reload(newPlan);
        expect(server.status).toBe("running");
        oldDelay.release();
        oldDelay.restore();
        oldResponseBody = await oldResponsePromise;
      } finally {
        oldDelay.restore();
        if (originalEmitDescriptor) Object.defineProperty(responsePrototype, "emit", originalEmitDescriptor);
        else Reflect.deleteProperty(responsePrototype, "emit");
      }
      await Promise.resolve();
      expect(finishObservations).toEqual([{ before: 0, after: 1 }]);
      expect(oldResponseStatus).toBe(200);
      expect(oldResponseBody.toString("utf8")).toBe(JSON.stringify(delayedExampleValue));
      const newResponse = await fetch(`${origin}/delayed`);
      expect(await newResponse.text()).toBe(JSON.stringify("n".repeat(1_048_574)));
      const oldResponseLogs = server.logs().filter((record) => record.ruleId === extraRoutes.delayedRule && record.revision === oldPlan.sourceProjectRevision);
      expect(oldResponseLogs).toHaveLength(1);
      expect(oldResponseLogs[0]).toMatchObject({ status: 200, reason: "MATCHED" });

      server.invalidate([{ severity: "error", code: "MOCK_FIXTURE_INVALID", path: "mock", message: "fixture invalid", lossy: false }]);
      expect(server.status).toBe("invalid");
      const invalid = await fetch(`${origin}/delayed`);
      expect(invalid.status).toBe(503);
      await server.reload(newPlan);
      expect(await requestStatus(`${origin}/items/item-7?view=full`, "POST", Buffer.from("{"), { "x-mock-case": "yes" })).toBe(501);

      const priorLogs = JSON.stringify(server.logs());
      for (const secret of ["QUERY_SENTINEL", "HEADER_SENTINEL", "AUTH_SENTINEL", "COOKIE_SENTINEL", "BODY_SENTINEL"]) {
        expect(priorLogs).not.toContain(secret);
      }
      const revisions = new Set(server.logs().map((record) => record.revision));
      expect(revisions).toContain(oldPlan.sourceProjectRevision);
      expect(revisions).toContain(newPlan.sourceProjectRevision);

      for (let index = 0; index < 201; index += 1) {
        const response = await fetch(`${origin}/head`, { method: "HEAD" });
        expect(response.status).toBe(200);
      }
      expect(server.logs()).toHaveLength(200);

      const port = server.address.port;
      await server.stop();
      expect(server.status).toBe("stopped");
      await assertPortIsReleased(port);
    } finally {
      await server?.stop();
    }
  });

  it("rejects over-limit bodies and the sixty-fifth active request", async () => {
    if (!startMockServer) throw new Error("startMockServer is not exported from the Node core entry.");
    const project = createMockConfiguredProject();
    const requestApi = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    if (requestApi.contract.request.protocol !== "http") throw new Error("Mock fixture must use HTTP.");
    requestApi.contract.request.method = "POST";
    project.mock.rules[0]!.conditions = [];
    project.mock.rules[0]!.delayMs = 1_000;
    let server: MockServerHandle | undefined;
    try {
      server = await startMockServer(compile(project), { port: 0 });
      const origin = `${baseUrl(server)}/items/item-7`;
      expect(await requestStatus(origin, "POST", Buffer.alloc(1_048_577, 97))).toBe(413);
      expect(await requestIncompleteOversizedBody(origin)).toBe(413);

      const statuses = await Promise.all(Array.from({ length: 65 }, () => requestStatus(origin, "POST")));
      expect(statuses.filter((status) => status === 200)).toHaveLength(64);
      expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    } finally {
      await server?.stop();
    }
  });

  it("cancels an in-flight delay and releases its listener within five seconds", async () => {
    if (!startMockServer) throw new Error("startMockServer is not exported from the Node core entry.");
    const project = createMockConfiguredProject();
    const requestApi = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    if (requestApi.contract.request.protocol !== "http") throw new Error("Mock fixture must use HTTP.");
    requestApi.contract.request.method = "GET";
    requestApi.contract.request.path = "/slow";
    project.mock.rules[0]!.conditions = [];
    project.mock.rules[0]!.delayMs = 30_000;
    let server: MockServerHandle | undefined;
    const delay = observeNodeDelay(30_000);
    try {
      server = await startMockServer(compile(project), { port: 0 });
      const port = server.address.port;
      const pending = fetch(`${baseUrl(server)}/slow`).then((response) => response.status, () => 0);
      await delay.started;
      expect(server.logs()).toHaveLength(0);
      delay.restore();
      const stopResult = await Promise.race([
        server.stop().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_100)),
      ]);
      expect(stopResult).toBe(true);
      expect(server.status).toBe("stopped");
      expect(await pending).not.toBe(200);
      expect(server.logs()).toContainEqual(expect.objectContaining({ status: 0, reason: "CANCELLED" }));
      await assertPortIsReleased(port);
    } finally {
      delay.restore();
      await server?.stop();
    }
  });

  it("fails with a stable error when an explicitly requested port is occupied", async () => {
    if (!startMockServer) throw new Error("startMockServer is not exported from the Node core entry.");
    const blocker = createNetServer();
    blocker.listen({ host: "127.0.0.1", port: 0 });
    await once(blocker, "listening");
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(startMockServer(compile(createMockConfiguredProject()), { port })).rejects.toMatchObject({ code: "MOCK_PORT_IN_USE" });
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
    }
  });
});
