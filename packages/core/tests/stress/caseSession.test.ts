import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ApiDefinition, Collection, Folder, Project, TestCase, Workspace } from "../../src/domain/model.js";
import { createStressCaseSession, type StressCaseSessionDeps } from "../../src/stress/caseSession.js";
import type { ManagedProtocolClient } from "../../src/http/client.js";
import type { ExecutionResponse } from "../../src/plugin/types.js";

const response: ExecutionResponse = { status: 200, headers: {}, bodyText: '{"ok":true}', timeMs: 1 };

const api: ApiDefinition = {
  id: "api-1", name: "orders", version: "1.0.0", deprecated: false, method: "GET", url: "/orders/{{row}}?vu={{counter}}&row={{row}}",
  headers: [], query: [], cases: [], protocol: "http",
};

const project: Project = {
  id: "project-1", name: "project", variables: {}, environments: [], collections: [], workflows: [],
  globals: { query: [], headers: [], cookies: [], body: [] },
};
const collection: Collection = { id: "collection-1", name: "collection", variables: {}, folders: [], apis: [] };
const workspace: Workspace = { id: "workspace-1", name: "workspace", variables: {}, groups: [] };
const target = (testCase: TestCase, sourcePath?: string) => ({
  api, testCase: sourcePath ? { ...testCase, dataDriver: { sourcePath, format: "csv" as const } } : testCase,
  project, collection, workspace,
});

function deps(seen: string[], close: () => Promise<void>, created: (workerId: number) => ManagedProtocolClient): StressCaseSessionDeps {
  const client: ManagedProtocolClient = {
    name: "fake", canHandle: () => true,
    execute: vi.fn(async (request) => { seen.push(request.url); return response; }),
    close,
  };
  return {
    createManagedClient: (workerId) => { created(workerId); return client; },
    resolveProtocol: () => client,
    resolveAuth: () => undefined,
    resolveAssert: (op) => op === "eq" ? { op, evaluate: (actual, expected) => ({ pass: String(actual) === expected, message: "status" }) } : undefined,
    scriptEngine: {
      language: "javascript",
      run(code, ctx) {
        if (code === "increment") {
          const next = Number(ctx.pm.variables.get("counter") ?? "0") + 1;
          ctx.pm.variables.set("counter", String(next));
          ctx.pm.request.url = ctx.pm.request.url.replace(/vu=[^&]+/, `vu=${next}`);
        }
        if (code === "assert-row") ctx.pm.assert(ctx.pm.request.url.includes("row="), "row present");
      },
    },
    timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
  };
}

describe("createStressCaseSession", () => {
  it("隔离每个 session 的变量和数据游标，并执行完整用例语义", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-session-"));
    const dataPath = join(dir, "rows.csv");
    writeFileSync(dataPath, "row\nA\nB\n");
    const testCase: TestCase = {
      id: "case-1", name: "case", scope: "base", parameters: {},
      preScript: "increment", postScript: "assert-row",
      assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }],
    };
    const seen: string[] = [];
    const close = vi.fn(async (): Promise<void> => {});
    const created = vi.fn((_: number): ManagedProtocolClient => ({ name: "fake", canHandle: () => true, execute: async () => response, close }));
    const sessionA = createStressCaseSession(target(testCase, dataPath), deps(seen, close, created), { workerId: 0 });
    const sessionB = createStressCaseSession(target(testCase, dataPath), deps(seen, close, created), { workerId: 1 });

    expect((await sessionA.execute()).outcome.passed).toBe(true);
    expect((await sessionA.execute()).outcome.passed).toBe(true);
    expect((await sessionB.execute()).outcome.passed).toBe(true);
    expect((await sessionB.execute()).outcome.passed).toBe(true);
    expect(seen).toEqual([
      "/orders/A?vu=1&row=A", "/orders/B?vu=2&row=B",
      "/orders/A?vu=1&row=A", "/orders/B?vu=2&row=B",
    ]);
    expect(created).toHaveBeenCalledTimes(2);
    await Promise.all([sessionA.close(), sessionA.close(), sessionB.close()]);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("在发包前对最终请求执行授权，拒绝时不触发协议 I/O", async () => {
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const execute = vi.fn(async () => response);
    const managed: ManagedProtocolClient = { name: "fake", canHandle: () => true, execute, close: async () => {} };
    const baseDeps: StressCaseSessionDeps = {
      createManagedClient: () => managed,
      resolveProtocol: () => managed,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    };
    const session = createStressCaseSession(target(testCase), baseDeps, {
      workerId: 0,
      authorizeRequest(request) {
        expect(request.url).toBe("/orders/{{row}}?vu={{counter}}&row={{row}}");
        throw new Error("target rejected");
      },
    });
    const result = await session.execute();
    expect(result.outcome.passed).toBe(false);
    expect(result.failureKind).toBe("config");
    expect(execute).not.toHaveBeenCalled();
  });

  it("数据、脚本和认证改写最终 origin 后仍由 authorizeRequest 拒绝且不发包", async () => {
    const execute = vi.fn(async () => response);
    const managed: ManagedProtocolClient = { name: "http", canHandle: () => true, execute, close: async () => {} };
    const sourcePath = join(mkdtempSync(join(tmpdir(), "apicc-origin-")), "rows.csv");
    const testCase: TestCase = {
      id: "case-1", name: "case", scope: "base", parameters: {},
      dataDriver: { sourcePath, format: "csv" }, assertions: [],
      preScript: "rewrite-origin",
    };
    writeFileSync(sourcePath, "host\nforbidden.example\n");
    const session = createStressCaseSession({ ...target(testCase), api: {
      ...api, url: "https://allowed.example/{{host}}", auth: { type: "bearer", token: "{{token}}", placement: "header" },
    } }, {
      createManagedClient: () => managed,
      resolveProtocol: () => managed,
      resolveAuth: () => ({ type: "bearer", apply(request) { request.headers.Authorization = "Bearer final-token"; } }),
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run(code, ctx) { if (code === "rewrite-origin") ctx.pm.request.url = "https://forbidden.example/final"; } },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, {
      workerId: 0,
      authorizeRequest(request) {
        expect(request.url).toBe("https://forbidden.example/final");
        expect(request.headers.Authorization).toBe("Bearer final-token");
        throw new Error("target rejected");
      },
    });
    const result = await session.execute();
    expect(result.outcome.passed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("HTTP session client 不处理 WS，协议 registry fallback 仍可执行", async () => {
    const managed: ManagedProtocolClient = { name: "http", canHandle: (request) => request.protocol === "http", execute: async () => response, close: async () => {} };
    const plugin: ManagedProtocolClient = { name: "ws-plugin", canHandle: () => true, execute: async () => response, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const session = createStressCaseSession({ ...target(testCase), api: { ...api, protocol: "websocket", message: "hello" } }, {
      createManagedClient: () => managed,
      resolveProtocol: () => plugin,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0 });
    expect((await session.execute()).outcome.passed).toBe(true);
    await session.close();
  });

  it("空数据源按单行 undefined，并在创建时校验数据文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-session-empty-"));
    const dataPath = join(dir, "empty.csv");
    writeFileSync(dataPath, "row\n");
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const seen: string[] = [];
    const close = vi.fn(async () => {});
    const created = vi.fn();
    const session = createStressCaseSession(target(testCase, dataPath), deps(seen, close, created), { workerId: 0 });
    await session.execute();
    await session.execute();
    expect(seen).toHaveLength(2);
    expect(() => createStressCaseSession(target(testCase, join(dir, "missing.csv")), deps([], close, created), { workerId: 1 })).toThrow();
  });

  it("按 collection 到 folder 的外到内执行容器前置，并在 close 内到外执行后置", async () => {
    const events: string[] = [];
    const outer: Folder = {
      id: "outer", name: "outer", apis: [], folders: [],
      preOperations: [{ id: "outer-pre", type: "script", content: "outer-pre" }],
      postOperations: [{ id: "outer-post", type: "script", content: "outer-post" }],
    };
    const inner: Folder = {
      id: "inner", name: "inner", apis: [api], folders: [],
      preOperations: [{ id: "inner-pre", type: "script", content: "inner-pre" }],
      postOperations: [{ id: "inner-post", type: "script", content: "inner-post" }],
    };
    outer.folders = [inner];
    const containerCollection: Collection = {
      ...collection, folders: [outer],
      preOperations: [{ id: "collection-pre", type: "script", content: "collection-pre" }],
      postOperations: [{ id: "collection-post", type: "script", content: "collection-post" }],
    };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const seen: string[] = [];
    const close = vi.fn(async (): Promise<void> => {});
    const created = vi.fn((_: number): ManagedProtocolClient => ({ name: "fake", canHandle: () => true, execute: async (request) => { seen.push(request.url); return response; }, close }));
    const session = createStressCaseSession({ ...target(testCase), collection: containerCollection }, {
      ...deps(seen, close, created),
      scriptEngine: { language: "javascript", run(code, ctx) { events.push(code); ctx.pm.variables.set("scope", code); } },
    }, { workerId: 0 });
    await session.execute();
    await session.close();
    expect(events).toEqual(["collection-pre", "outer-pre", "inner-pre", "inner-post", "outer-post", "collection-post"]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it("每个 session 通过 factory 获取不同 managed client，HTTP 不回退共享 client", async () => {
    const clients: ManagedProtocolClient[] = [];
    const closeCounts: number[] = [];
    const factory = vi.fn((workerId: number): ManagedProtocolClient => {
      const client: ManagedProtocolClient = {
        name: `client-${workerId}`, canHandle: () => true,
        execute: async () => response,
        close: async () => { closeCounts[workerId] = (closeCounts[workerId] ?? 0) + 1; },
      };
      clients.push(client);
      return client;
    });
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const base = deps([], async () => {}, vi.fn());
    const sessionA = createStressCaseSession(target(testCase), { ...base, createManagedClient: factory }, { workerId: 0 });
    const sessionB = createStressCaseSession(target(testCase), { ...base, createManagedClient: factory }, { workerId: 1 });
    await Promise.all([sessionA.execute(), sessionB.execute()]);
    expect(clients[0]).not.toBe(clients[1]);
    await Promise.all([sessionA.close(), sessionA.close(), sessionB.close(), sessionB.close()]);
    expect(closeCounts).toEqual([1, 1]);
  });
});
