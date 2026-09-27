import { describe, expect, it, vi } from "vitest";
import { createVariableResolver } from "../../src/variables/resolver.js";
import { executeCase, type CaseExecutionDeps } from "../../src/runner/caseExecutor.js";
import type { ApiDefinition, TestCase } from "../../src/domain/model.js";
import type { ExecutableRequest, ExecutionResponse, ProtocolClient, ScriptEngine } from "../../src/plugin/types.js";

const api: ApiDefinition = {
  id: "api-1", name: "orders", version: "1", deprecated: false, method: "GET",
  url: "https://example.test/orders/{{orderId}}", headers: [], query: [],
  auth: { type: "bearer", token: "{{token}}", placement: "header" },
  cases: [],
};

const testCase: TestCase = {
  id: "case-1", name: "order", scope: "base", parameters: { orderId: "from-parameter" },
  preScript: "pm.request.headers['X-Prepared'] = pm.variables.get('prepared');",
  postScript: "pm.variables.set('nextToken', 'next'); pm.assert(pm.response.status === 200, 'status');",
  assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }],
};

const response: ExecutionResponse = { status: 200, headers: { "content-type": "application/json" }, bodyText: '{"ok":true}', timeMs: 3 };

function input(globals: Record<string, unknown> = {}) {
  return {
    api,
    testCase,
    row: { orderId: "42" },
    rowIndex: 0,
    isDataDriven: true,
    resolver: createVariableResolver({ layers: [{ prepared: "yes", token: "token-from-script" }] }),
    envVars: {},
    globals,
    persisted: new Map<string, string>(),
    persistedSnapshot: {} as Record<string, string>,
  };
}

function deps(client: ProtocolClient, beforeSend?: CaseExecutionDeps["beforeSend"]): CaseExecutionDeps {
  const scriptEngine: ScriptEngine = {
    language: "javascript",
    run(code, ctx) {
      if (code.includes("X-Prepared")) ctx.pm.request.headers["X-Prepared"] = ctx.pm.variables.get("prepared") ?? "";
      if (code.includes("nextToken")) ctx.pm.variables.set("nextToken", "next");
      if (code.includes("pm.assert")) ctx.pm.assert(ctx.pm.response?.status === 200, "status");
    },
  };
  return {
    resolveProtocol: () => client,
    resolveAuth: () => ({ type: "bearer", apply(request, auth, getVar) { request.headers.Authorization = `Bearer ${getVar(auth.token!.slice(2, -2))}`; } }),
    resolveAssert: () => ({ op: "eq", evaluate(actual, expected) { return { pass: String(actual) === expected, message: "status" }; } }),
    scriptEngine,
    timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    beforeSend,
  };
}

describe("executeCase", () => {
  it("executes final request with row, scripts, auth, assertions and persists variables", async () => {
    let seen: ExecutableRequest | undefined;
    const client: ProtocolClient = {
      name: "test", canHandle: () => true,
      async execute(request) { seen = request; return response; },
    };
    const state = input();
    const result = await executeCase(state, deps(client));

    expect(seen?.url).toContain("/orders/42");
    expect(seen?.headers.Authorization).toBe("Bearer token-from-script");
    expect(seen?.headers["X-Prepared"]).toBe("yes");
    expect(result.outcome.passed).toBe(true);
    expect(result.response?.status).toBe(200);
    expect(result.requestTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.scriptTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.iterationTimeMs).toBeGreaterThanOrEqual(result.requestTimeMs);
    expect(state.persisted.get("nextToken")).toBe("next");
    expect(result.failureKind).toBeUndefined();
  });

  it("passes final request to beforeSend and does not execute when hook rejects", async () => {
    const execute = vi.fn(async () => response);
    const client: ProtocolClient = { name: "test", canHandle: () => true, execute };
    let seen: ExecutableRequest | undefined;
    const result = await executeCase(input(), deps(client, (request) => {
      seen = request;
      throw new Error("origin rejected");
    }));
    expect(seen?.url).toContain("/orders/42");
    expect(seen?.headers.Authorization).toBe("Bearer token-from-script");
    expect(execute).not.toHaveBeenCalled();
    expect(result.outcome.passed).toBe(false);
    expect(result.failureKind).toBe("config");
  });

  it("keeps globals isolated for concurrent executions", async () => {
    const seen: string[] = [];
    const client: ProtocolClient = {
      name: "test", canHandle: () => true,
      async execute(request) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(request.headers["X-Global"]!);
        return response;
      },
    };
    const a = input({ headers: [{ key: "X-Global", value: "A", enabled: true }] });
    const b = input({ headers: [{ key: "X-Global", value: "B", enabled: true }] });
    await Promise.all([executeCase(a, deps(client)), executeCase(b, deps(client))]);
    expect(seen.sort()).toEqual(["A", "B"]);
  });

  it("classifies script, transport, HTTP and assertion failures", async () => {
    const failingScript: CaseExecutionDeps = {
      ...deps({ name: "test", canHandle: () => true, execute: async () => response }),
      scriptEngine: { language: "javascript", run() { throw new Error("script boom"); } },
    };
    const scriptResult = await executeCase({ ...input(), testCase: { ...testCase, preScript: "throw new Error('x')" } }, failingScript);
    expect(scriptResult.failureKind).toBe("script");

    const transport = await executeCase(input(), deps({
      name: "test", canHandle: () => true, async execute() { throw new Error("network down"); },
    }));
    expect(transport.failureKind).toBe("transport");

    const http = await executeCase(input(), deps({
      name: "test", canHandle: () => true, async execute() { return { ...response, status: 503 }; },
    }));
    expect(http.failureKind).toBe("http");

    const assertion = await executeCase({ ...input(), testCase: { ...testCase, assertions: [{ id: "bad", target: "status", op: "eq", expected: "201" }] } }, deps({
      name: "test", canHandle: () => true, async execute() { return response; },
    }));
    expect(assertion.failureKind).toBe("assertion");
  });
});
