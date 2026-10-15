import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVariableResolver } from "../../src/variables/resolver.js";
import { createEventBus } from "../../src/events/bus.js";
import { executeCase, type CaseExecutionDeps, type CaseExecutionInput } from "../../src/runner/caseExecutor.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ApiAsset, RequestBody } from "../../src/contract/model.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import type { ProjectGlobals, TestCase } from "../../src/domain/common.js";
import type { ExecutableRequest, ExecutionResponse, ProtocolClient, ScriptEngine } from "../../src/plugin/types.js";
import { builtinAuthProviders } from "../../src/http/auth.js";
import { createHttpClient } from "../../src/http/client.js";
import { jsScriptEngine } from "../../src/sandbox/jsEngine.js";

const testCase: TestCase = {
  id: "case-1", name: "order", scope: "base", parameters: { orderId: "from-parameter" },
  preOperations: [{ id: "pre", type: "script", content: "pm.request.headers['X-Prepared'] = pm.variables.get('prepared');" }],
  postOperations: [{ id: "post", type: "script", content: "pm.variables.set('nextToken', 'next'); pm.assert(pm.response.status === 200, 'status');" }],
  assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }],
};

const response: ExecutionResponse = { status: 200, headers: { "content-type": "application/json" }, bodyText: '{"ok":true}', timeMs: 3 };

function input(options: {
  globals?: Partial<ProjectGlobals>;
  request?: { baseUrl?: string; protocol?: "http" | "soap"; envelope?: string; method?: "GET" | "POST"; body?: RequestBody };
  testCase?: TestCase;
} = {}): CaseExecutionInput {
  const selectedCase = options.testCase ?? testCase;
  const contractId = "10000000-0000-4000-8000-000000000001";
  const secretId = "credential-ref";
  const asset: ApiAsset = {
    contract: {
      formatVersion: 1,
      id: contractId,
      metadata: { name: "orders", description: "", tags: [], version: "1", status: "draft" },
      request: options.request?.protocol === "soap"
        ? {
          protocol: "soap", method: "POST", baseUrl: options.request.baseUrl ?? "https://example.test", path: "/orders/{{orderId}}",
          pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "bearer", token: { id: secretId, policy: "test-auto" } },
          envelope: options.request.envelope ?? "<Envelope>{{orderId}}</Envelope>",
        }
        : {
          protocol: "http", method: options.request?.method ?? "GET", baseUrl: options.request?.baseUrl ?? "https://example.test", path: "/orders/{{orderId}}",
          pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "bearer", token: { id: secretId, policy: "test-auto" } },
          body: options.request?.body ?? { kind: "none" },
        },
      responses: [],
    },
    cases: [selectedCase],
    documentation: "",
  };
  const globals: ProjectGlobals = {
    query: [], headers: [], cookies: [], body: [], ...options.globals,
  };
  const project: ContractProject = {
    id: "10000000-0000-4000-8000-000000000002", name: "project", variables: { token: "unused" }, globals,
    environments: [], workflows: [], stressPolicy: { trustedOrigins: [], deniedOrigins: [] }, models: [], components: [],
    collections: [{
      id: "10000000-0000-4000-8000-000000000003", name: "collection", variables: {}, preOperations: [], postOperations: [],
      folders: [], apis: [asset],
    }],
  };
  const snapshot = createProjectSnapshot(project);
  const frozenAsset = snapshot.project.collections[0]!.apis[0]!;
  const frozenCase = frozenAsset.cases[0]!;
  return {
    asset: frozenAsset,
    assetContext: snapshot.context,
    credentialBindings: {
      resolve(ref: { id: string }) { if (ref.id !== secretId) throw new Error("unexpected credential ref"); return "token-from-script"; },
      versions: { [secretId]: "v1" },
    },
    testCase: frozenCase,
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
      if (code === "delete-envelope" && ctx.pm.request.protocol === "soap") Object.assign(ctx.pm.request, { envelope: undefined });
    },
  };
  return {
    resolveProtocol: () => client,
    resolveAuth: () => ({ type: "bearer", apply(request, auth) { if (auth.kind === "bearer") request.headers.Authorization = `Bearer ${auth.token}`; } }),
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

  it("executes the selected case's complete request override", async () => {
    let seenUrl = "";
    const client: ProtocolClient = {
      name: "test",
      canHandle: () => true,
      async execute(request) { seenUrl = request.url; return response; },
    };
    const state = input();
    state.testCase = {
      ...state.testCase,
      requestOverride: { ...state.asset.contract.request, path: "/case-only/{{orderId}}" },
    };

    const result = await executeCase(state, deps(client));

    expect(seenUrl).toBe("https://example.test/case-only/42");
    expect(state.asset.contract.request.path).toBe("/orders/{{orderId}}");
    expect(result.outcome.passed).toBe(true);
  });

  it("bodyJson neq 不能把无效 JSON 响应解释为 undefined 并通过", async () => {
    const client: ProtocolClient = {
      name: "test", canHandle: () => true,
      async execute() { return { ...response, bodyText: "not json", textAvailable: true, jsonAvailable: false }; },
    };
    const state = input({ testCase: {
      ...testCase,
      assertions: [{ id: "body", target: "bodyJson", path: "$.value", op: "neq", expected: "present" }],
    } });
    const executionDeps = deps(client);
    executionDeps.resolveAssert = (op) => ({ op, evaluate(actual, expected) {
      const pass = op === "neq" ? String(actual) !== expected : String(actual) === expected;
      return { pass, message: `expected ${op} ${expected}` };
    } });

    const result = await executeCase(state, executionDeps);

    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.assertions[0]?.message).toContain("JSON");
  });

  it("keeps case settings above legacy runner defaults and explicit settings above both while preserving signal", async () => {
    let seenOptions: Record<string, unknown> | undefined;
    const client: ProtocolClient = {
      name: "test",
      canHandle: () => true,
      async execute(_request, options) { seenOptions = options as unknown as Record<string, unknown>; return response; },
    };
    const state = input({ testCase: { ...testCase, requestSettingsOverride: {
      connectTimeoutMs: 200,
      headersTimeoutMs: 1500,
      totalTimeoutMs: 4000,
    } } });
    const signal = new AbortController().signal;

    await executeCase(state, {
      ...deps(client),
      timeouts: { connectTimeoutMs: 1000, totalTimeoutMs: 5000, signal },
      requestSettings: { headersTimeoutMs: 700, followRedirects: true },
    });

    expect(seenOptions).toMatchObject({
      connectTimeoutMs: 200,
      headersTimeoutMs: 700,
      bodyTimeoutMs: 30_000,
      totalTimeoutMs: 4000,
      followRedirects: true,
      maxRedirects: 10,
      uploadLimitBytes: 64 * 1024 * 1024,
      responseLimitBytes: 32 * 1024 * 1024,
      signal,
    });
    expect(seenOptions?.requestSettings).toBeUndefined();
    expect(seenOptions?.runtime).toMatchObject({ files: { get: expect.any(Function), close: expect.any(Function) }, beforeRedirect: expect.any(Function) });
  });

  it("真实 CaseExecutor 将用例传输设置交给 HTTP 客户端并完成文件 307 重发", async () => {
    const root = await mkdtemp(join(tmpdir(), "apicc-case-http-"));
    const fileBytes = Buffer.from([0, 7, 128, 255]);
    await writeFile(join(root, "payload.bin"), fileBytes);
    const arrivals: Array<{ path: string; method: string; body: Buffer }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      arrivals.push({ path: request.url ?? "", method: request.method ?? "", body: Buffer.concat(chunks) });
      if (arrivals.length === 1) {
        response.writeHead(307, { location: "/redirected" });
        response.end();
      } else {
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("done");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = createHttpClient();
    try {
      const state = input({ request: {
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        method: "POST",
        body: { kind: "binary", file: { path: "payload.bin" }, contentType: "application/octet-stream" },
      } });
      state.testCase = { ...state.testCase, requestSettingsOverride: {
        headersTimeoutMs: 2000, bodyTimeoutMs: 2000, followRedirects: true,
        maxRedirects: 2, uploadLimitBytes: fileBytes.length * 2, responseLimitBytes: 8,
      } };
      const result = await executeCase(state, {
        ...deps(client),
        workspaceRoot: root,
      });

      expect(result.outcome.passed).toBe(true);
      expect(result.response?.bodyText).toBe("done");
      expect(arrivals.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
        { path: "/orders/42", method: "POST", body: fileBytes },
        { path: "/redirected", method: "POST", body: fileBytes },
      ]);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("HTTP 请求体准备在 network start 前失败时 requestTimeMs 为 0", async () => {
    const client = createHttpClient();
    try {
      const state = input({ request: {
        method: "POST",
        body: { kind: "multipart", entries: [{ kind: "text", id: "10000000-0000-4000-8000-000000000004", name: "tag", value: "x", enabled: true }] },
      } });
      state.testCase = { ...state.testCase, preOperations: [], postOperations: [], assertions: [] };
      const result = await executeCase(state, deps(client, (request) => {
        request.headers["Content-Type"] = "application/json";
      }));

      expect(result).toMatchObject({ requestStarted: true, requestCompleted: true, requestTimeMs: 0 });
      expect(result.response).toBeUndefined();
      expect(result.outcome.error).toContain("conflicting Content-Type");
    } finally {
      await client.close();
    }
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
    const a = input({ globals: { headers: [{ key: "X-Global", value: "A", enabled: true }] } });
    const b = input({ globals: { headers: [{ key: "X-Global", value: "B", enabled: true }] } });
    await Promise.all([executeCase(a, deps(client)), executeCase(b, deps(client))]);
    expect(seen.sort()).toEqual(["A", "B"]);
  });

  it("classifies script, transport, HTTP and assertion failures", async () => {
    const failingScript: CaseExecutionDeps = {
      ...deps({ name: "test", canHandle: () => true, execute: async () => response }),
      scriptEngine: { language: "javascript", run() { throw new Error("script boom"); } },
    };
    const scriptResult = await executeCase(input({ testCase: { ...testCase, preOperations: [{ id: "throw", type: "script", content: "throw new Error('x')" }] } }), failingScript);
    expect(scriptResult.failureKind).toBe("script");

    const transport = await executeCase(input(), deps({
      name: "test", canHandle: () => true, async execute() { throw new Error("network down"); },
    }));
    expect(transport.failureKind).toBe("transport");

    const http = await executeCase(input(), deps({
      name: "test", canHandle: () => true, async execute() { return { ...response, status: 503 }; },
    }));
    expect(http.failureKind).toBe("http");

    const assertion = await executeCase(input({ testCase: { ...testCase, assertions: [{ id: "bad", target: "status", op: "eq", expected: "201" }] } }), deps({
      name: "test", canHandle: () => true, async execute() { return response; },
    }));
    expect(assertion.failureKind).toBe("assertion");
  });

  it("clones auth for concurrent executions of one shared API", async () => {
    const base = input();
    const seen: string[] = [];
    const client: ProtocolClient = {
      name: "test", canHandle: () => true,
      async execute(request) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        seen.push(request.headers.Authorization ?? "missing");
        return response;
      },
    };
    const engine: ScriptEngine = {
      language: "javascript",
      run(code, ctx) { if (ctx.pm.request.auth.kind === "bearer") ctx.pm.request.auth.token = code; },
    };
    const make = (token: string) => ({
      ...base,
      testCase: { ...base.testCase, preOperations: [{ id: `token-${token}`, type: "script" as const, content: token }] },
      resolver: createVariableResolver({ layers: [{ prepared: "yes" }] }),
      persisted: new Map<string, string>(),
      persistedSnapshot: {} as Record<string, string>,
    });
    const makeDeps = (): CaseExecutionDeps => ({
      ...deps(client), scriptEngine: engine,
      resolveAuth: () => ({ type: "bearer", apply(request, auth) { if (auth.kind === "bearer") request.headers.Authorization = auth.token; } }),
    });
    await Promise.all([executeCase(make("A"), makeDeps()), executeCase(make("B"), makeDeps())]);
    expect(seen.sort()).toEqual(["A", "B"]);
    expect(base.asset.contract.request.auth).toMatchObject({ kind: "bearer", token: { id: "credential-ref" } });
  });

  it("returns a config outcome when request construction fails", async () => {
    const state = input({ request: { baseUrl: "{{loop}}" } });
    state.resolver = createVariableResolver({ layers: [{ loop: "{{loop}}" }] });
    const execute = vi.fn(async () => response);
    const result = await executeCase(state, deps({ name: "test", canHandle: () => true, execute }));
    expect(result.outcome.passed).toBe(false);
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toContain("变量循环引用");
    expect(result.request.url).toBe("");
    expect(execute).not.toHaveBeenCalled();
  });

  it("emits afterCase once for construction errors", async () => {
    const bus = createEventBus();
    let afterCaseCount = 0;
    bus.on("afterCase", () => { afterCaseCount += 1; });
    const state = input({ request: { baseUrl: "{{loop}}" } });
    state.resolver = createVariableResolver({ layers: [{ loop: "{{loop}}" }] });
    const result = await executeCase(state, { ...deps({ name: "test", canHandle: () => true, execute: async () => response }), bus });
    expect(result.failureKind).toBe("config");
    expect(afterCaseCount).toBe(1);
  });

  it("classifies unknown and throwing assertion operators as config errors", async () => {
    const validInput = input();
    const unknown = await executeCase({
      ...validInput,
      testCase: { ...validInput.testCase, assertions: [{ id: "unknown", target: "status", op: "missing" as never, expected: "200" }] },
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
    const result = await executeCase(input({
      request: { protocol: "soap" },
      testCase: { ...testCase, preOperations: [{ id: "remove-envelope", type: "script", content: "delete-envelope" }] },
    }), {
      ...deps({ name: "soap", canHandle: () => true, execute }),
    });
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toContain("envelope");
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies missing credential bindings as config before protocol dispatch", async () => {
    const client: ProtocolClient = { name: "test", canHandle: () => true, execute: vi.fn(async () => response) };
    const resolveProtocol = vi.fn(() => client);
    const state = input();
    state.credentialBindings = {
      resolve() { throw new Error("credential binding missing"); },
      versions: {},
    };
    const result = await executeCase(state, { ...deps(client), resolveProtocol });
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toContain("credential binding missing");
    expect(result.requestStarted).toBe(false);
    expect(resolveProtocol).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["missing bearer token", { kind: "bearer" }],
    ["bearer token object", { kind: "bearer", token: { id: "credential-ref", policy: "test-auto" } }],
    ["basic password object", { kind: "basic", username: "user", password: { value: "secret" } }],
    ["apikey name object", { kind: "apikey", name: { value: "X-Key" }, placement: "header", value: "secret" }],
    ["apikey illegal placement", { kind: "apikey", name: "X-Key", placement: "body", value: "secret" }],
    ["unknown auth kind", { kind: "custom", token: "secret" }],
  ] as const)("rejects malformed %s auth before resolving a protocol client", async (_label, invalidAuth) => {
    const client: ProtocolClient = { name: "test", canHandle: () => true, execute: vi.fn(async () => response) };
    const resolveProtocol = vi.fn(() => client);
    const resolveAuth = vi.fn((kind: string) => builtinAuthProviders.find((provider) => provider.type === kind));
    const script = `pm.request.auth = ${JSON.stringify(invalidAuth)};`;
    const state = input({ testCase: { ...testCase, preOperations: [{ id: "mutate-auth", type: "script", content: script }] } });
    const result = await executeCase(state, { ...deps(client), resolveProtocol, resolveAuth, scriptEngine: jsScriptEngine });

    expect(result.failureKind).toBe("config");
    expect(result.requestStarted).toBe(false);
    expect(result.requestCompleted).toBe(false);
    expect(resolveAuth).not.toHaveBeenCalled();
    expect(resolveProtocol).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("rejects malformed RuntimeAuth introduced by final beforeSend before protocol dispatch", async () => {
    const client: ProtocolClient = { name: "test", canHandle: () => true, execute: vi.fn(async () => response) };
    const resolveProtocol = vi.fn(() => client);
    const resolveAuth = vi.fn((kind: string) => builtinAuthProviders.find((provider) => provider.type === kind));
    const result = await executeCase(input(), {
      ...deps(client),
      resolveProtocol,
      resolveAuth,
      scriptEngine: jsScriptEngine,
      beforeSend(request) {
        Reflect.set(request, "auth", { kind: "bearer", token: { id: "credential-ref", policy: "test-auto" } });
      },
    });

    expect(result.failureKind).toBe("config");
    expect(result.requestStarted).toBe(false);
    expect(result.requestCompleted).toBe(false);
    expect(resolveProtocol).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("allows scripts to read and replace ordinary RuntimeAuth strings before built-in auth application", async () => {
    let seen: ExecutableRequest | undefined;
    const client: ProtocolClient = {
      name: "test", canHandle: () => true,
      async execute(request) { seen = request; return response; },
    };
    const state = input({ testCase: { ...testCase, preOperations: [{
      id: "replace-bearer-string", type: "script",
      content: 'pm.request.headers["X-Script-Auth"] = pm.request.auth.token; pm.request.auth.token = "script-token";',
    }] } });
    const resolveAuth = (kind: string) => builtinAuthProviders.find((provider) => provider.type === kind);
    const result = await executeCase(state, { ...deps(client), resolveAuth, scriptEngine: jsScriptEngine });

    expect(result.outcome.passed).toBe(true);
    expect(seen?.headers["X-Script-Auth"]).toBe("token-from-script");
    expect(seen?.headers.Authorization).toBe("Bearer script-token");
    expect(result.requestStarted).toBe(true);
    expect(result.requestCompleted).toBe(true);
  });

  it("rejects a runtime request that no longer matches its protocol variant before dispatch", async () => {
    const client: ProtocolClient = { name: "test", canHandle: () => true, execute: vi.fn(async () => response) };
    const resolveProtocol = vi.fn(() => client);
    const state = input({ testCase: { ...testCase, preOperations: [{ id: "corrupt", type: "script", content: "corrupt" }] } });
    const result = await executeCase(state, {
      ...deps(client),
      resolveProtocol,
      scriptEngine: {
        language: "javascript",
        run(_code, ctx) {
          Reflect.set(ctx.pm.request, "protocol", "websocket");
          Reflect.set(ctx.pm.request, "method", "GET");
        },
      },
    });
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toContain("WebSocket 执行请求包含 HTTP/SOAP 字段");
    expect(resolveProtocol).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("captures a binary request file before scripts and closes its handle after execute", async () => {
    const root = await mkdtemp(join(tmpdir(), "apicc-case-file-"));
    const bytes = Buffer.from([0, 2, 64, 128, 255]);
    await writeFile(join(root, "payload.bin"), bytes);
    let captured: import("../../src/http/files.js").CapturedFile | undefined;
    const client: ProtocolClient = {
      name: "test", canHandle: () => true,
      async execute(request, options) {
        if (request.protocol !== "http" || request.body?.kind !== "binary") throw new Error("expected binary runtime body");
        captured = options.runtime?.files?.get(request.body.file);
        const chunks: Buffer[] = [];
        for await (const chunk of captured!.openStream()) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(bytes);
        return response;
      },
    };
    try {
      const result = await executeCase(input({ request: { body: { kind: "binary", file: { path: "payload.bin" }, contentType: "application/octet-stream" } } }), {
        ...deps(client), workspaceRoot: root,
      });
      expect(result.outcome.passed).toBe(true);
      expect(captured).toBeDefined();
      expect(() => captured!.openStream()).toThrow(expect.objectContaining({ code: "FILE_SOURCE_NOT_REPLAYABLE" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    const result = await executeCase(input({ request: { protocol: "soap", envelope: "<Envelope/>" } }), {
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
      ...input({ testCase: { ...testCase, preOperations: [{ id: "pre", type: "script", content: "pre" }], postOperations: [{ id: "post", type: "script", content: "post" }] } }),
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
      const result = await executeCase(input({ testCase: {
        ...testCase, preOperations: [{ id: "pre", type: "script", content: "pre" }], postOperations: [{ id: "post", type: "script", content: "post" }],
        assertions: [{ id: "time", target: "responseTime", op: "eq", expected: String(protocolTime) }],
      } }), {
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
      const result = await executeCase(input({ testCase: {
        ...testCase, preOperations: [], postOperations: [{ id: "post", type: "script", content: "post" }],
        assertions: [{ id: "time", target: "responseTime", op: "eq", expected: "41" }],
      } }), {
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
      const result = await executeCase(input({ testCase: {
        ...testCase, preOperations: [], postOperations: [], assertions: [],
      } }), deps({ name: "failed-attempt", canHandle: () => true, async execute() {
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
