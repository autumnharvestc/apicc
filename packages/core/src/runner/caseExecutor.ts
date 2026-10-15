import { JSONPath } from "jsonpath-plus";
import type { ApiAsset } from "../contract/model.js";
import type { DeepReadonly, ProjectAssetContextReadView } from "../assets/context.js";
import type { CredentialBindings } from "../credentials/types.js";
import type { ProjectGlobals, TestCase } from "../domain/common.js";
import type { EventBus, RunEventMap } from "../events/bus.js";
import type {
  AssertOperator, AuthProvider, ExecutableRequest, ExecutionResponse, HttpExecuteOptions,
  HttpHopObservation, PmApi, ProtocolClient, ScriptEngine,
} from "../plugin/types.js";
import type { CaseOutcome } from "../report/types.js";
import type { VariableResolver } from "../variables/resolver.js";
import type { StressSafetyTarget } from "../stress/model.js";
import { materializeRequest, type MaterializedRequest, type RuntimeAuth } from "../request/materialize.js";
import { getEffectiveCaseRequest } from "../request/effective.js";
import { assertRequestSettingsApplicable, resolveRequestSettings, type RequestSettingsOverride } from "../request/settings.js";
import { captureRequestFiles, type CapturedRequestFiles } from "../http/files.js";
import type { HttpSession } from "../http/session.js";

export type CaseFailureKind = "transport" | "http" | "script" | "assertion" | "config" | "aborted";

const CASE_FAILURE_KINDS = new Set<CaseFailureKind>(["transport", "http", "script", "assertion", "config", "aborted"]);

/** Run-scoped state for one case. Nothing here is read from CollectionRunner. */
export interface CaseExecutionInput {
  asset: DeepReadonly<ApiAsset>;
  assetContext: ProjectAssetContextReadView;
  credentialBindings: CredentialBindings;
  testCase: DeepReadonly<TestCase>;
  row?: Record<string, string>;
  rowIndex: number;
  isDataDriven: boolean;
  resolver: VariableResolver;
  envVars: Record<string, string>;
  envBaseUrl?: string;
  globals?: Partial<ProjectGlobals>;
  persisted: Map<string, string>;
  persistedSnapshot: Record<string, string>;
}

export interface CaseExecutionDeps {
  resolveProtocol(request: ExecutableRequest): ProtocolClient | undefined;
  resolveAuth(type: string): AuthProvider | undefined;
  resolveAssert(op: string): AssertOperator | undefined;
  scriptEngine: ScriptEngine;
  timeouts?: Pick<HttpExecuteOptions, "connectTimeoutMs" | "totalTimeoutMs" | "signal">;
  requestSettings?: RequestSettingsOverride;
  /** Host-supplied workspace root for capturing explicit local request files. */
  workspaceRoot?: string;
  /** Explicitly owned by the surrounding run/session; never a process-global jar. */
  httpSession?: HttpSession;
  observeHttp?: (event: HttpHopObservation) => void | Promise<void>;
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

const now = (): number => performance.now();
const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);
const isAbort = (e: unknown, signal?: AbortSignal): boolean =>
  Boolean(signal?.aborted) || (e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message)));

function emptyRequest(): ExecutableRequest {
  return { protocol: "http", method: "GET", url: "", headers: {}, query: [], auth: { kind: "none" } };
}

function mutableRequest(request: MaterializedRequest): ExecutableRequest {
  const common = {
    url: request.url,
    headers: { ...request.headers },
    query: request.query.map((parameter) => ({ ...parameter })),
    auth: { ...request.auth },
    ...(request.cookieHeaderMode === undefined ? {} : { cookieHeaderMode: request.cookieHeaderMode }),
  };
  switch (request.protocol) {
    case "http":
      return { ...common, protocol: "http", method: request.method, ...(request.body ? { body: cloneRuntimeBody(request.body) } : {}) };
    case "websocket":
      return { ...common, protocol: "websocket", ...(request.message !== undefined ? { message: request.message } : {}) };
    case "soap":
      return { ...common, protocol: "soap", method: "POST", envelope: request.envelope, ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}) };
  }
}

function cloneRuntimeBody(body: NonNullable<Extract<ExecutableRequest, { protocol: "http" }>["body"]>) {
  return body.kind === "form" ? { ...body, form: body.form.map((parameter) => ({ ...parameter })) } : { ...body };
}

function invalidRequest(message: string): Error {
  return Object.assign(new Error(message), { caseFailureKind: "config" as const, code: "CONFIG" });
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isLocalFileReference(value: unknown): value is { path: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as { path?: unknown }).path === "string";
}

function isRuntimeHttpBody(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  switch (body.kind) {
    case "json": case "xml": case "raw":
      return typeof body.content === "string";
    case "form":
      return typeof body.content === "string" && Array.isArray(body.form) && body.form.every((entry) => {
        if (typeof entry !== "object" || entry === null) return false;
        const pair = entry as Record<string, unknown>;
        return typeof pair.key === "string" && typeof pair.value === "string" && typeof pair.enabled === "boolean";
      });
    case "binary":
      return isLocalFileReference(body.file) && typeof body.contentType === "string";
    case "multipart":
      return Array.isArray(body.entries) && body.entries.every((entry) => {
        if (typeof entry !== "object" || entry === null) return false;
        const part = entry as Record<string, unknown>;
        if (typeof part.name !== "string") return false;
        if (part.kind === "text") return typeof part.value === "string";
        return part.kind === "file" && isLocalFileReference(part.file)
          && typeof part.contentType === "string"
          && (part.filename === undefined || typeof part.filename === "string");
      });
    default:
      return false;
  }
}

function isRuntimeAuth(value: unknown): value is RuntimeAuth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const auth = value as Record<string, unknown>;
  switch (auth.kind) {
    case "none":
      return hasExactKeys(auth, ["kind"]);
    case "bearer":
      return hasExactKeys(auth, ["kind", "token"]) && typeof auth.token === "string";
    case "basic":
      return hasExactKeys(auth, ["kind", "username", "password"])
        && typeof auth.username === "string" && typeof auth.password === "string";
    case "apikey":
      return hasExactKeys(auth, ["kind", "name", "placement", "value"])
        && typeof auth.name === "string"
        && (auth.placement === "header" || auth.placement === "query")
        && typeof auth.value === "string";
    default:
      return false;
  }
}

function validateExecutableRequest(request: ExecutableRequest): void {
  if (typeof request.url !== "string" || !request.url || typeof request.headers !== "object" || request.headers === null
    || !Array.isArray(request.query) || typeof request.auth !== "object" || request.auth === null) {
    throw invalidRequest("执行请求结构无效");
  }
  if (!isRuntimeAuth(request.auth)) throw invalidRequest("执行请求认证结构无效");
  if (Object.values(request.headers).some((value) => typeof value !== "string")
    || request.query.some((entry) => typeof entry.key !== "string" || typeof entry.value !== "string" || typeof entry.enabled !== "boolean")) {
    throw invalidRequest("执行请求头或查询参数结构无效");
  }
  switch (request.protocol) {
    case "http":
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method)
        || (request.body !== undefined && !isRuntimeHttpBody(request.body))) {
        throw invalidRequest("HTTP 执行请求结构无效");
      }
      return;
    case "websocket":
      if (request.message !== undefined && typeof request.message !== "string") throw invalidRequest("WebSocket message 必须是字符串");
      if ("method" in request || "body" in request || "envelope" in request || "soapAction" in request) throw invalidRequest("WebSocket 执行请求包含 HTTP/SOAP 字段");
      return;
    case "soap":
      if (request.method !== "POST" || typeof request.envelope !== "string" || (request.soapAction !== undefined && typeof request.soapAction !== "string")) {
        throw invalidRequest("SOAP 执行请求必须使用 POST 并提供 envelope");
      }
      if ("body" in request || "message" in request) throw invalidRequest("SOAP 执行请求包含 HTTP/WebSocket 字段");
      return;
    default:
      throw invalidRequest("执行请求必须包含受支持的 protocol 字段");
  }
}

function responseView(response: ExecutionResponse): NonNullable<PmApi["response"]> {
  let cachedJson: unknown;
  return {
    status: response.status,
    headers: response.headers,
    time: response.timeMs,
    ...(response.textAvailable === undefined ? {} : { textAvailable: response.textAvailable }),
    ...(response.jsonAvailable === undefined ? {} : { jsonAvailable: response.jsonAvailable }),
    text: () => {
      if (response.textAvailable === false) throw new TypeError("响应体不是可可靠解码的文本。");
      return response.bodyText;
    },
    json: () => {
      if (response.textAvailable === false) throw new TypeError("响应体不是可可靠解码的 JSON 文本。");
      if (response.jsonAvailable === false) throw new TypeError("响应体不是有效的 JSON 文本。");
      return (cachedJson ??= JSON.parse(response.bodyText));
    },
  };
}

function evaluateAssertions(
  testCase: DeepReadonly<TestCase>,
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
        if (!response) return { pass: false, message: "没有完整响应体可用于 JSON 断言。" };
        if (response.textAvailable === false) return { pass: false, message: "响应体不是可可靠解码的 JSON 文本。" };
        if (response.jsonAvailable === false) return { pass: false, message: "响应体不是有效的 JSON 文本。" };
        try { actual = JSONPath({ path: assertion.path ?? "$", json: response.json() as object })[0]; }
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
  const { asset, testCase, resolver, envVars, persisted, persistedSnapshot } = input;
  const effectiveRequest = getEffectiveCaseRequest(asset, testCase);
  const signal = deps.timeouts?.signal;
  let clientOptions: HttpExecuteOptions | undefined;
  let capturedFiles: CapturedRequestFiles | undefined;
  const contractId = asset.contract.id;
  const apiName = asset.contract.metadata.name;
  const globals = input.globals ?? {};
  // The diagnostic request is always available, even when variable resolution fails.
  // Every nested request object is owned by this invocation; scripts/plugins may mutate it.
  let request = emptyRequest();

  const pmAsserts: Array<{ pass: boolean; message: string }> = [];
  const pm: PmApi = {
    variables: {
      get: (name) => resolver.get(name),
      set: (name, value) => { persisted.set(name, value); persistedSnapshot[name] = value; resolver.setRuntime(name, value); },
    },
    environment: { get: (name) => envVars[name] },
    get request() { return request; },
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
    if (!asset.cases.some((candidate) => candidate.id === testCase.id)) {
      throw invalidRequest(`用例 ${testCase.id} 不属于接口资产 ${contractId}`);
    }
    const contract = input.assetContext.getContract(contractId);
    if (!contract) throw invalidRequest(`接口资产 ${contractId} 不在所选项目快照中`);
    assertRequestSettingsApplicable(effectiveRequest.protocol, testCase.requestSettingsOverride ?? {}, deps.requestSettings ?? {});
    const resolvedSettings = resolveRequestSettings(testCase.requestSettingsOverride, deps.requestSettings, {
      connectTimeoutMs: deps.timeouts?.connectTimeoutMs ?? 10_000,
      totalTimeoutMs: deps.timeouts?.totalTimeoutMs ?? 30_000,
    });
    clientOptions = {
      connectTimeoutMs: resolvedSettings.connectTimeoutMs,
      totalTimeoutMs: resolvedSettings.totalTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
      ...(effectiveRequest.protocol === "http" ? resolvedSettings : {}),
    };
    request = mutableRequest(materializeRequest(contract, input.assetContext, {
      resolve: (template) => resolver.resolve(template),
      envBaseUrl: input.envBaseUrl,
      globals,
      credentials: input.credentialBindings,
    }, effectiveRequest));
    if (request.protocol === "http") {
      capturedFiles = await captureRequestFiles(request, {
        workspaceRoot: deps.workspaceRoot,
        uploadLimitBytes: resolvedSettings.uploadLimitBytes,
      });
      clientOptions.runtime = {
        files: capturedFiles,
        ...(deps.httpSession === undefined ? {} : { session: deps.httpSession }),
        ...(deps.observeHttp === undefined ? {} : { observe: deps.observeHttp }),
        beforeRedirect: async (nextRequest) => {
          validateExecutableRequest(nextRequest);
          if (nextRequest.auth.kind !== "none") {
            const auth = deps.resolveAuth(nextRequest.auth.kind);
            if (!auth || auth.type !== nextRequest.auth.kind) throw invalidRequest(`无可用认证提供方: ${nextRequest.auth.kind}`);
            auth.apply(nextRequest, nextRequest.auth);
          }
          if (deps.beforeSend) await deps.beforeSend(nextRequest);
          validateExecutableRequest(nextRequest);
        },
      };
    }
    await emit("beforeCase", { apiName, caseName: testCase.name, apiId: contractId, caseId: testCase.id, row: input.isDataDriven ? input.rowIndex : undefined });
    for (const operation of testCase.preOperations) if (operation.type === "script") runScript(operation.content);
    stage = "config";
    await emit("beforeRequest", { request });

    validateExecutableRequest(request);
    const runtimeAuth = request.auth;
    if (runtimeAuth.kind !== "none") {
      const auth = deps.resolveAuth(runtimeAuth.kind);
      if (!auth || auth.type !== runtimeAuth.kind) throw invalidRequest(`无可用认证提供方: ${runtimeAuth.kind}`);
      auth.apply(request, runtimeAuth);
    }
    if (deps.beforeSend) await deps.beforeSend(request);
    validateExecutableRequest(request);
    const client = deps.resolveProtocol(request);
    if (!client) throw invalidRequest(`无可用协议客户端处理 ${request.url}`);
    stage = "request";
    requestStarted = true;
    const requestStartAt = now();
    let protocolError: unknown;
    try {
      response = await client.execute(request, clientOptions);
    } catch (e) {
      protocolError = e;
      failureKind = isAbort(e, signal) ? "aborted" : protocolFailureKind(e);
      throw e;
    } finally {
      const attemptTimeMs = now() - requestStartAt;
      const timing = protocolError as { networkStarted?: unknown; attemptTimeMs?: unknown } | null | undefined;
      const hasNetworkTiming = typeof timing === "object" && timing !== null && typeof timing.networkStarted === "boolean";
      requestTimeMs = response && Number.isFinite(response.timeMs) && response.timeMs >= 0
        ? response.timeMs
        : hasNetworkTiming
          ? timing.networkStarted && Number.isFinite(timing.attemptTimeMs) ? Number(timing.attemptTimeMs) : 0
          : attemptTimeMs;
      if (response && response.timeMs !== requestTimeMs) {
        // Normalize invalid plugin metadata without mutating its response object.
        response = { ...response, timeMs: requestTimeMs };
      }
      requestCompleted = true;
    }
    await emit("afterResponse", { status: response.status, timeMs: response.timeMs, headers: response.headers, bodyText: response.bodyText });
    pm.response = responseView(response);
    for (const operation of testCase.postOperations) if (operation.type === "script") runScript(operation.content);
  } catch (e) {
    error = errorMessage(e);
    failureKind ??= isAbort(e, signal)
      ? "aborted"
      : ((e as { caseFailureKind?: CaseFailureKind }).caseFailureKind ?? (String(stage) === "script" ? "script" : "config"));
  } finally {
    try { await capturedFiles?.close(); }
    catch (e) {
      error ??= errorMessage(e);
      failureKind ??= (e as { caseFailureKind?: CaseFailureKind }).caseFailureKind ?? "config";
    }
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
  if (error === undefined && response && response.status >= 400 && request.protocol !== "soap") {
    error = `HTTP 响应失败: ${response.status}`;
    failureKind = "http";
  }
  const assertionsPass = assertions.every((assertion) => assertion.pass);
  if (error === undefined && !assertionsPass) failureKind = "assertion";
  const iterationTimeMs = now() - started;
  const outcome: CaseOutcome = {
    apiId: contractId, apiName, caseId: testCase.id, caseName: testCase.name,
    row: input.isDataDriven ? input.rowIndex : undefined,
    passed: error === undefined && assertionsPass,
    durationMs: iterationTimeMs,
    assertions,
    error,
    failureKind,
  };
  try {
    await emit("afterCase", {
      apiName, caseName: testCase.name, apiId: contractId, caseId: testCase.id,
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
