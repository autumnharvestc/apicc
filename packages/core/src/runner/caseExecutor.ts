import { JSONPath } from "jsonpath-plus";
import type { ApiDefinition, BodyContent, KeyValuePair, ProjectGlobals, TestCase } from "../domain/model.js";
import type { EventBus, RunEventMap } from "../events/bus.js";
import type {
  AssertOperator, AuthProvider, ExecutableRequest, ExecutionResponse, HttpExecuteOptions,
  PmApi, ProtocolClient, ScriptEngine,
} from "../plugin/types.js";
import type { CaseOutcome } from "../report/types.js";
import type { VariableResolver } from "../variables/resolver.js";
import type { StressSafetyTarget } from "../stress/model.js";
import { withBaseUrl } from "../variables/baseUrl.js";

export type CaseFailureKind = "transport" | "http" | "script" | "assertion" | "config" | "aborted";

const CASE_FAILURE_KINDS = new Set<CaseFailureKind>(["transport", "http", "script", "assertion", "config", "aborted"]);

/** Run-scoped state for one case. Nothing here is read from CollectionRunner. */
export interface CaseExecutionInput {
  api: ApiDefinition;
  testCase: TestCase;
  row?: Record<string, string>;
  rowIndex: number;
  isDataDriven: boolean;
  resolver: VariableResolver;
  envVars: Record<string, string>;
  globals?: Partial<ProjectGlobals>;
  persisted: Map<string, string>;
  persistedSnapshot: Record<string, string>;
}

export interface CaseExecutionDeps {
  resolveProtocol(request: ExecutableRequest): ProtocolClient | undefined;
  resolveAuth(type: string): AuthProvider | undefined;
  resolveAssert(op: string): AssertOperator | undefined;
  scriptEngine: ScriptEngine;
  timeouts?: HttpExecuteOptions;
  bus?: EventBus;
  beforeSend?: (finalRequest: ExecutableRequest) => void | Promise<void>;
}

export interface CaseExecutionResult {
  outcome: CaseOutcome;
  request: ExecutableRequest;
  response?: ExecutionResponse;
  /** Returned protocol latency, or elapsed attempt time when no valid response timing exists. */
  requestTimeMs: number;
  scriptTimeMs: number;
  iterationTimeMs: number;
  /** True only once protocol client execution is entered. */
  requestStarted?: boolean;
  /** True once an entered protocol client attempt settles (success or error). */
  requestCompleted?: boolean;
  failureKind?: CaseFailureKind;
  safety?: StressSafetyTarget;
}

const EMPTY_GLOBALS: Required<ProjectGlobals> = { query: [], headers: [], cookies: [], body: [] };

const now = (): number => performance.now();
const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);
const isAbort = (e: unknown, signal?: AbortSignal): boolean =>
  Boolean(signal?.aborted) || (e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message)));

function mergeGlobalForm(body: BodyContent | undefined, resolver: VariableResolver, globals: Partial<ProjectGlobals>): ExecutableRequest["body"] {
  if (body === undefined) return undefined;
  const form = (body.form ?? []).map((kv) => ({ ...kv, value: resolver.resolve(kv.value) }));
  if (body.kind !== "form") return { kind: body.kind, content: resolver.resolve(body.content), form };
  const existing = new Set(form.map((f) => f.key));
  const extra = (globals.body ?? EMPTY_GLOBALS.body)
    .filter((b) => b.enabled && b.key && !existing.has(b.key))
    .map((b) => ({ key: b.key, value: resolver.resolve(b.value), enabled: true }));
  return { kind: body.kind, content: resolver.resolve(body.content), form: [...form, ...extra] };
}

function injectGlobalCookie(headers: Record<string, string>, resolver: VariableResolver, globals: Partial<ProjectGlobals>): void {
  if (Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) return;
  const cookie = (globals.cookies ?? EMPTY_GLOBALS.cookies)
    .filter((c) => c.enabled && c.key)
    .map((c) => `${resolver.resolve(c.key)}=${resolver.resolve(c.value)}`)
    .join("; ");
  if (cookie) headers.Cookie = cookie;
}

function responseView(response: ExecutionResponse): NonNullable<PmApi["response"]> {
  let cachedJson: unknown;
  return {
    status: response.status,
    headers: response.headers,
    time: response.timeMs,
    text: () => response.bodyText,
    json: () => (cachedJson ??= JSON.parse(response.bodyText)),
  };
}

function evaluateAssertions(
  testCase: TestCase,
  ctx: { pm: PmApi },
  resolver: VariableResolver,
  resolveAssert: (op: string) => AssertOperator | undefined,
) {
  const response = ctx.pm.response;
  return testCase.assertions.map((assertion) => {
    const op = resolveAssert(assertion.op);
    if (!op) {
      throw Object.assign(new Error(`未知断言操作符: ${assertion.op}`), { caseFailureKind: "config" as const });
    }
    let actual: unknown;
    switch (assertion.target) {
      case "status": actual = response?.status; break;
      case "header": actual = response?.headers[(assertion.headerName ?? "").toLowerCase()]; break;
      case "responseTime": actual = response?.time; break;
      case "bodyJson":
        try { actual = response ? JSONPath({ path: assertion.path ?? "$", json: response.json() as object })[0] : undefined; }
        catch { actual = undefined; }
        break;
    }
    try {
      return op.evaluate(actual, assertion.expected === undefined ? undefined : resolver.resolve(assertion.expected));
    } catch (e) {
      throw Object.assign(new Error(errorMessage(e)), { caseFailureKind: "config" as const });
    }
  });
}

function validFailureKind(value: unknown): CaseFailureKind | undefined {
  return typeof value === "string" && CASE_FAILURE_KINDS.has(value as CaseFailureKind)
    ? value as CaseFailureKind
    : undefined;
}

function protocolFailureKind(error: unknown): CaseFailureKind {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return "transport";
  const tagged = error as { caseFailureKind?: unknown; failureKind?: unknown; code?: unknown; name?: unknown };
  const marked = validFailureKind(tagged.caseFailureKind) ?? validFailureKind(tagged.failureKind);
  if (marked) return marked;
  const code = typeof tagged.code === "string" ? tagged.code : undefined;
  if (code?.toUpperCase() === "CONFIG" || tagged.name === "ConfigurationError") return "config";
  return "transport";
}

/** Execute one case with only explicitly supplied run/session state. */
export async function executeCase(input: CaseExecutionInput, deps: CaseExecutionDeps): Promise<CaseExecutionResult> {
  const started = now();
  const timeouts: HttpExecuteOptions = deps.timeouts ?? { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 };
  const { api, testCase, resolver, envVars, persisted, persistedSnapshot } = input;
  const globals = input.globals ?? {};
  // The diagnostic request is always available, even when variable resolution fails.
  // Every nested request object is owned by this invocation; scripts/plugins may mutate it.
  const request: ExecutableRequest = {
    method: api.method,
    url: api.url,
    headers: {},
    query: [],
    auth: api.auth ? { ...api.auth } : undefined,
    protocol: api.protocol,
  };

  const pmAsserts: Array<{ pass: boolean; message: string }> = [];
  const pm: PmApi = {
    variables: {
      get: (name) => resolver.get(name),
      set: (name, value) => { persisted.set(name, value); persistedSnapshot[name] = value; resolver.setRuntime(name, value); },
    },
    environment: { get: (name) => envVars[name] },
    request,
    response: undefined,
    assert: (condition, message) => pmAsserts.push({ pass: Boolean(condition), message }),
  };
  const ctx = { pm };

  let response: ExecutionResponse | undefined;
  let requestTimeMs = 0;
  let requestStarted = false;
  let requestCompleted = false;
  let scriptTimeMs = 0;
  let error: string | undefined;
  let failureKind: CaseFailureKind | undefined;
  let stage: "config" | "script" | "request" = "config";
  const runScript = (code: string): void => {
    stage = "script";
    const before = now();
    try { deps.scriptEngine.run(code, ctx); }
    finally { scriptTimeMs += now() - before; }
  };
  const emit = async <K extends keyof RunEventMap>(type: K, payload: RunEventMap[K]) => {
    if (deps.bus) await deps.bus.emit(type, payload);
  };

  try {
    resolver.clearRuntime();
    for (const [key, value] of persisted) resolver.setRuntime(key, value);
    for (const [key, value] of Object.entries(testCase.parameters)) resolver.setRuntime(key, value);
    for (const [key, value] of Object.entries(input.row ?? {})) resolver.setRuntime(key, value);
    Object.assign(request, {
      url: withBaseUrl(resolver.resolve(api.url), resolver.get("baseUrl")),
      headers: Object.fromEntries([
        ...(globals.headers ?? EMPTY_GLOBALS.headers).filter((h) => h.enabled && h.key && !api.headers.some((a) => a.key === h.key)),
        ...api.headers.filter((h) => h.enabled),
      ].map((h: KeyValuePair) => [h.key, resolver.resolve(h.value)])),
      query: [
        ...(globals.query ?? EMPTY_GLOBALS.query)
          .filter((q) => q.enabled && q.key && !api.query.some((a) => a.key === q.key))
          .map((q) => ({ ...q, value: resolver.resolve(q.value) })),
        ...api.query.map((q) => ({ ...q, value: resolver.resolve(q.value) })),
      ],
      body: mergeGlobalForm(api.body, resolver, globals),
      message: api.message === undefined ? undefined : resolver.resolve(api.message),
      envelope: api.envelope === undefined ? undefined : resolver.resolve(api.envelope),
      soapAction: api.soapAction === undefined ? undefined : resolver.resolve(api.soapAction),
    });
    injectGlobalCookie(request.headers, resolver, globals);
    await emit("beforeCase", { apiName: api.name, caseName: testCase.name, apiId: api.id, caseId: testCase.id, row: input.isDataDriven ? input.rowIndex : undefined });
    if (testCase.preScript) runScript(testCase.preScript);
    for (const operation of testCase.preOperations ?? []) if (operation.type === "script") runScript(operation.content);
    stage = "config";
    await emit("beforeRequest", { request });

    if (request.protocol === "soap" && request.envelope === undefined) {
      throw Object.assign(new Error("soap 请求必须提供 envelope（XML 信封模板）"), { caseFailureKind: "config" as const });
    }
    if (request.auth) {
      const auth = deps.resolveAuth(request.auth.type);
      if (!auth) throw Object.assign(new Error(`无可用认证提供方: ${request.auth.type}`), { caseFailureKind: "config" });
      auth.apply(request, request.auth, (name) => resolver.get(name));
    }
    if (deps.beforeSend) await deps.beforeSend(request);
    const client = deps.resolveProtocol(request);
    if (!client) throw Object.assign(new Error(`无可用协议客户端处理 ${request.url}`), { caseFailureKind: "config" });
    stage = "request";
    requestStarted = true;
    const requestStartAt = now();
    try {
      response = await client.execute(request, timeouts);
    } catch (e) {
      failureKind = isAbort(e, timeouts.signal) ? "aborted" : protocolFailureKind(e);
      throw e;
    } finally {
      const attemptTimeMs = now() - requestStartAt;
      requestTimeMs = response && Number.isFinite(response.timeMs) && response.timeMs >= 0
        ? response.timeMs
        : attemptTimeMs;
      if (response && response.timeMs !== requestTimeMs) {
        // Normalize invalid plugin metadata without mutating its response object.
        response = { ...response, timeMs: requestTimeMs };
      }
      requestCompleted = true;
    }
    await emit("afterResponse", { status: response.status, timeMs: response.timeMs, headers: response.headers, bodyText: response.bodyText });
    pm.response = responseView(response);
    for (const operation of testCase.postOperations ?? []) if (operation.type === "script") runScript(operation.content);
    if (testCase.postScript) runScript(testCase.postScript);
  } catch (e) {
    error = errorMessage(e);
    failureKind ??= isAbort(e, timeouts.signal)
      ? "aborted"
      : ((e as { caseFailureKind?: CaseFailureKind }).caseFailureKind ?? (String(stage) === "script" ? "script" : "config"));
  }

  let assertions: Array<{ pass: boolean; message: string }> = [];
  try {
    assertions = [...evaluateAssertions(testCase, ctx, resolver, deps.resolveAssert), ...pmAsserts];
  } catch (e) {
    if (error === undefined) {
      error = errorMessage(e);
      failureKind = (e as { caseFailureKind?: CaseFailureKind }).caseFailureKind ?? "config";
    }
  }
  if (error === undefined && response && response.status >= 400 && input.api.protocol !== "soap") {
    error = `HTTP 响应失败: ${response.status}`;
    failureKind = "http";
  }
  const assertionsPass = assertions.every((assertion) => assertion.pass);
  if (error === undefined && !assertionsPass) failureKind = "assertion";
  const iterationTimeMs = now() - started;
  const outcome: CaseOutcome = {
    apiId: api.id, apiName: api.name, caseId: testCase.id, caseName: testCase.name,
    row: input.isDataDriven ? input.rowIndex : undefined,
    passed: error === undefined && assertionsPass,
    durationMs: iterationTimeMs,
    assertions,
    error,
    failureKind,
  };
  try {
    await emit("afterCase", {
      apiName: api.name, caseName: testCase.name, apiId: api.id, caseId: testCase.id,
      passed: outcome.passed, row: outcome.row, durationMs: outcome.durationMs, error,
    });
  } catch (e) {
    const msg = errorMessage(e);
    outcome.passed = false;
    outcome.error = outcome.error ? `${outcome.error}; afterCase 钩子失败: ${msg}` : `afterCase 钩子失败: ${msg}`;
    outcome.failureKind ??= "config";
    failureKind ??= outcome.failureKind;
  }
  return { outcome, request, response, requestTimeMs, scriptTimeMs, iterationTimeMs, requestStarted, requestCompleted, failureKind };
}
