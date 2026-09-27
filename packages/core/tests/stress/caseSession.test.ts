import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ApiDefinition, Collection, Project, TestCase, Workspace } from "../../src/domain/model.js";
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
});
