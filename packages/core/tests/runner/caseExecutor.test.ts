import { describe, expect, it, vi } from "vitest";
import { createVariableResolver } from "../../src/variables/resolver.js";
import { createEventBus } from "../../src/events/bus.js";
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
      // An immediately resolved fixture represents zero measured network time.
      async execute(request) { seen = request; return { ...response, timeMs: 0 }; },
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
    expect(result.requestStarted).toBe(true);
    expect(result.requestCompleted).toBe(true);
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
    expect(result.requestStarted).toBe(false);
    expect(result.requestCompleted).toBe(false);
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

  it("clones auth for concurrent executions of one shared API", async () => {
    const sharedApi = { ...api, auth: { type: "bearer" as const, token: "shared", placement: "header" as const } };
    const seen: string[] = [];
    const client: ProtocolClient = {
      name: "test", canHandle: () => true,
      async execute(request) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        seen.push(request.auth?.token ?? "missing");
        return response;
      },
    };
    const engine: ScriptEngine = {
      language: "javascript",
      run(code, ctx) { ctx.pm.request.auth!.token = code; },
    };
    const make = (token: string) => ({
      ...input(), api: sharedApi, testCase: { ...testCase, preScript: token },
    });
    const makeDeps = (): CaseExecutionDeps => ({
      ...deps(client), scriptEngine: engine,
      resolveAuth: () => ({ type: "bearer", apply(request, auth) { request.headers.Authorization = auth.token ?? ""; } }),
    });
    await Promise.all([executeCase(make("A"), makeDeps()), executeCase(make("B"), makeDeps())]);
    expect(seen.sort()).toEqual(["A", "B"]);
    expect(sharedApi.auth?.token).toBe("shared");
  });

  it("returns a config outcome when request construction fails", async () => {
    const state = input();
    state.api = { ...api, url: "{{loop}}/orders" };
    state.resolver = createVariableResolver({ layers: [{ loop: "{{loop}}" }] });
    const execute = vi.fn(async () => response);
    const result = await executeCase(state, deps({ name: "test", canHandle: () => true, execute }));
    expect(result.outcome.passed).toBe(false);
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toContain("变量循环引用");
    expect(result.request.url).toBe("{{loop}}/orders");
    expect(execute).not.toHaveBeenCalled();
  });

  it("emits afterCase once for construction errors", async () => {
    const bus = createEventBus();
    let afterCaseCount = 0;
    bus.on("afterCase", () => { afterCaseCount += 1; });
    const state = input();
    state.api = { ...api, url: "{{loop}}/orders" };
    state.resolver = createVariableResolver({ layers: [{ loop: "{{loop}}" }] });
    const result = await executeCase(state, { ...deps({ name: "test", canHandle: () => true, execute: async () => response }), bus });
    expect(result.failureKind).toBe("config");
    expect(afterCaseCount).toBe(1);
  });

  it("classifies unknown and throwing assertion operators as config errors", async () => {
    const unknown = await executeCase({
      ...input(), testCase: { ...testCase, assertions: [{ id: "unknown", target: "status", op: "missing" as never, expected: "200" }] },
    }, { ...deps({ name: "test", canHandle: () => true, execute: async () => response }), resolveAssert: () => undefined });
    expect(unknown.failureKind).toBe("config");
    expect(unknown.outcome.error).toContain("未知断言操作符");

    const throwing = await executeCase(input(), {
      ...deps({ name: "test", canHandle: () => true, execute: async () => response }),
      resolveAssert: () => ({ op: "eq", evaluate() { throw new Error("assert plugin exploded"); } }),
    });
    expect(throwing.failureKind).toBe("config");
    expect(throwing.outcome.error).toBe("assert plugin exploded");
  });

  it("classifies missing SOAP envelope as config without protocol I/O", async () => {
    const execute = vi.fn(async () => response);
    const result = await executeCase({ ...input(), api: { ...api, method: "POST", protocol: "soap" } }, {
      ...deps({ name: "soap", canHandle: () => true, execute }),
    });
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toContain("soap 请求必须提供 envelope");
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves a plugin's explicit configuration error classification", async () => {
    const result = await executeCase(input(), {
      ...deps({
        name: "plugin", canHandle: () => true,
        async execute() { throw Object.assign(new Error("plugin request shape invalid"), { code: "CONFIG" }); },
      }),
    });
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toBe("plugin request shape invalid");
  });

  it("keeps malformed plugin error metadata as transport", async () => {
    const numericCode = await executeCase(input(), {
      ...deps({ name: "plugin", canHandle: () => true, async execute() {
        throw Object.assign(new Error("numeric code network failure"), { code: 503 });
      } }),
    });
    expect(numericCode.failureKind).toBe("transport");

    const illegalKind = await executeCase(input(), {
      ...deps({ name: "plugin", canHandle: () => true, async execute() {
        throw Object.assign(new Error("illegal marker network failure"), { failureKind: "mystery" });
      } }),
    });
    expect(illegalKind.failureKind).toBe("transport");
  });

  it("keeps an unmarked SOAP I/O error as transport even when its message mentions envelope", async () => {
    const result = await executeCase({ ...input(), api: { ...api, method: "POST", protocol: "soap", envelope: "<Envelope/>" } }, {
      ...deps({ name: "soap", canHandle: () => true, async execute() { throw new Error("remote envelope stream reset"); } }),
    });
    expect(result.failureKind).toBe("transport");
  });

  it("keeps nullish and primitive protocol throws as transport without replacing diagnostics", async () => {
    const nullResult = await executeCase(input(), {
      ...deps({ name: "plugin", canHandle: () => true, async execute() { throw null; } }),
    });
    expect(nullResult.failureKind).toBe("transport");
    expect(nullResult.outcome.error).toBe("null");

    const undefinedResult = await executeCase(input(), {
      ...deps({ name: "plugin", canHandle: () => true, async execute() { throw undefined; } }),
    });
    expect(undefinedResult.failureKind).toBe("transport");
    expect(undefinedResult.outcome.error).toBe("undefined");

    const primitiveResult = await executeCase(input(), {
      ...deps({ name: "plugin", canHandle: () => true, async execute() { throw "wire failure"; } }),
    });
    expect(primitiveResult.failureKind).toBe("transport");
    expect(primitiveResult.outcome.error).toBe("wire failure");
  });

  it("classifies an aborted protocol execution from the signal and passes that signal to the client", async () => {
    const controller = new AbortController();
    controller.abort();
    let receivedSignal: AbortSignal | undefined;
    const result = await executeCase(input(), {
      ...deps({ name: "test", canHandle: () => true, execute: async (_request, options) => {
        receivedSignal = options.signal;
        throw new Error("cancelled by signal");
      } }),
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100, signal: controller.signal },
    });
    expect(result.failureKind).toBe("aborted");
    expect(receivedSignal).toBe(controller.signal);
    expect(result.requestStarted).toBe(true);
    expect(result.requestCompleted).toBe(true);
  });

  it("classifies an AbortError even when its signal is not aborted", async () => {
    const result = await executeCase(input(), {
      ...deps({ name: "test", canHandle: () => true, execute: async () => {
        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      } }),
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100, signal: new AbortController().signal },
    });
    expect(result.failureKind).toBe("aborted");
  });

  it("keeps protocol timing separate from pre/post script timing", async () => {
    const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const result = await executeCase({
      ...input(), testCase: { ...testCase, preScript: "pre", postScript: "post" },
    }, {
      ...deps({ name: "test", canHandle: () => true, async execute() { pause(5); return response; } }),
      scriptEngine: { language: "javascript", run(code) { pause(code === "pre" ? 4 : 6); } },
    });
    expect(result.requestTimeMs).toBe(3);
    expect(result.scriptTimeMs).toBeGreaterThanOrEqual(8);
    expect(result.iterationTimeMs).toBeGreaterThanOrEqual(result.requestTimeMs + result.scriptTimeMs - 1);
  });

  // Catch replacing a completed protocol's network duration with await/cleanup overhead, including zero.
  it.each([0, 7])("response timing uses protocol time %s across metrics, events, scripts and assertions", async (protocolTime) => {
    let clock = 0;
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const bus = createEventBus();
    let eventTime: number | undefined;
    let scriptTime: number | undefined;
    bus.on("afterResponse", (payload) => { eventTime = payload.timeMs; clock += 5; });
    try {
      const result = await executeCase({ ...input(), testCase: {
        ...testCase, preScript: "pre", postScript: "post",
        assertions: [{ id: "time", target: "responseTime", op: "eq", expected: String(protocolTime) }],
      } }, {
        ...deps({ name: "timed-protocol", canHandle: () => true, async execute() {
          clock += 41;
          return { ...response, timeMs: protocolTime };
        } }), bus,
        scriptEngine: { language: "javascript", run(code, ctx) {
          clock += code === "pre" ? 11 : 13;
          if (code === "post") scriptTime = ctx.pm.response?.time;
        } },
      });
      expect(result.requestTimeMs).toBe(protocolTime);
      expect(result.response?.timeMs).toBe(protocolTime);
      expect(eventTime).toBe(protocolTime);
      expect(scriptTime).toBe(protocolTime);
      expect(result.outcome.passed).toBe(true);
      expect(result.scriptTimeMs).toBe(24);
      expect(result.iterationTimeMs).toBe(70);
      expect(result.outcome.durationMs).toBe(70);
    } finally { clockSpy.mockRestore(); }
  });

  // Catch invalid plugin metadata reaching scripts, afterResponse and latency assertions.
  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("response timing normalizes invalid time %s to measured attempt duration", async (invalidTime) => {
    let clock = 0;
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const bus = createEventBus();
    let eventTime: number | undefined;
    let scriptTime: number | undefined;
    const protocolResponse = { ...response, timeMs: invalidTime };
    bus.on("afterResponse", (payload) => { eventTime = payload.timeMs; });
    try {
      const result = await executeCase({ ...input(), testCase: {
        ...testCase, preScript: undefined, postScript: "post",
        assertions: [{ id: "time", target: "responseTime", op: "eq", expected: "41" }],
      } }, {
        ...deps({ name: "invalid-time", canHandle: () => true, async execute() { clock += 41; return protocolResponse; } }), bus,
        scriptEngine: { language: "javascript", run(_code, ctx) { scriptTime = ctx.pm.response?.time; } },
      });
      expect(eventTime).toBe(41);
      expect(scriptTime).toBe(41);
      expect(result.response?.timeMs).toBe(41);
      expect(result.requestTimeMs).toBe(41);
      expect(result.iterationTimeMs).toBe(41);
      expect(result.outcome.passed).toBe(true);
      expect(protocolResponse.timeMs).toBe(invalidTime);
    } finally { clockSpy.mockRestore(); }
  });

  it.each(["transport", "aborted"] as const)("no-response %s retains diagnostic duration and failure classification", async (kind) => {
    let clock = 0;
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const result = await executeCase({ ...input(), testCase: {
        ...testCase, preScript: undefined, postScript: undefined, assertions: [],
      } }, deps({ name: "failed-attempt", canHandle: () => true, async execute() {
        clock += 41;
        throw Object.assign(new Error("wire failure"), { name: kind === "aborted" ? "AbortError" : "Error" });
      } }));
      expect(result).toMatchObject({ requestTimeMs: 41, iterationTimeMs: 41, requestStarted: true, requestCompleted: true, failureKind: kind });
      expect(result.response).toBeUndefined();
      expect(result.outcome).toMatchObject({ passed: false, durationMs: 41, error: "wire failure", failureKind: kind });
    } finally { clockSpy.mockRestore(); }
  });

  it("pre-request failure keeps zero network duration without claiming a sent request", async () => {
    let clock = 0;
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const result = await executeCase({ ...input(), testCase: { ...testCase, assertions: [] } }, {
        ...deps({ name: "unused", canHandle: () => true, async execute() { throw new Error("unexpected I/O"); } }),
        scriptEngine: { language: "javascript", run() { clock += 11; throw new Error("pre failure"); } },
      });
      expect(result).toMatchObject({ requestTimeMs: 0, iterationTimeMs: 11, scriptTimeMs: 11, requestStarted: false, requestCompleted: false, failureKind: "script" });
      expect(result.outcome).toMatchObject({ passed: false, durationMs: 11, error: "pre failure" });
    } finally { clockSpy.mockRestore(); }
  });
});
