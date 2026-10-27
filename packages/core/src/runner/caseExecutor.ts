import { compileCaseAssertions, evaluateCaseAssertions, type AssertionOutcome, type CompiledCaseAssertions } from "../assert/evaluate.js";
import { createPluginRegistry } from "../plugin/registry.js";
import { AssertionValueError } from "../assert/selection.js";
import { createExtractionRuntimeState, evaluateExtractions, extractionVariables, prepareExtractions, skippedExtractions, type ExtractionOutcome, type ExtractionRuntimeState, type PreparedExtractions } from "../testing/extraction.js";
import type { ExtractionDefinition } from "../testing/model.js";
import type { CaseReferenceLocator } from "../testing/references.js";
import type { ApiAsset } from "../contract/model.js";
import type { DeepReadonly, ProjectAssetContextReadView } from "../assets/context.js";
import type { CredentialBindings } from "../credentials/types.js";
import type { PreparedNetworkRun } from "../network/prepare.js";
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
import type { StressRequestGate } from "../stress/execution.js";
import { createHttpClient } from "../http/client.js";
import { createSoapClient } from "../protocol/soap.js";
import { wsClient } from "../protocol/websocket.js";
import { mergeTemplateFields } from "./templateFields.js";

export type CaseFailureKind = "transport" | "http" | "script" | "assertion" | "extraction" | "config" | "aborted";

const CASE_FAILURE_KINDS = new Set<CaseFailureKind>(["transport", "http", "script", "assertion", "extraction", "config", "aborted"]);

export interface CaseExecutionLocator extends CaseReferenceLocator { caseId: string; scope: string }
export interface PreparedCaseExecution {
  testCase: DeepReadonly<TestCase>;
  assertions: CompiledCaseAssertions;
  definitions: readonly ExtractionDefinition[];
  extractions?: PreparedExtractions;
  extractionError?: { code: string; message: string };
}
/** Capture literal programs once against the exact immutable owning snapshot. */
export function prepareCaseExecution(testCase: DeepReadonly<TestCase>, context: ProjectAssetContextReadView,
  contractId: string, resolveAssert: CaseExecutionDeps["resolveAssert"]): PreparedCaseExecution {
  const registry = createPluginRegistry();
  registry.getAssert = resolveAssert;
  const copied = structuredClone(testCase) as TestCase;
  const prepared: PreparedCaseExecution = { testCase, assertions: compileCaseAssertions(copied, context, registry, { contractId }), definitions: copied.extractors ?? [] };
  try { prepared.extractions = prepareExtractions(prepared.definitions); }
  catch (error) { prepared.extractionError = { code: error instanceof AssertionValueError ? error.code : "EXTRACTION_CONFIG", message: errorMessage(error) }; }
  return prepared;
}

/** Run-scoped state for one case. Nothing here is read from CollectionRunner. */
export interface CaseExecutionInput {
  asset: DeepReadonly<ApiAsset>;
  assetContext: ProjectAssetContextReadView;
  credentialBindings: CredentialBindings;
  /** Host-only immutable run context; consumed only by the built-in HTTP client. */
  network?: PreparedNetworkRun;
  testCase: DeepReadonly<TestCase>;
  locator?: CaseExecutionLocator;
  prepared?: PreparedCaseExecution;
  extractionState?: ExtractionRuntimeState;
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
  /** Borrowed from the surrounding execution owner; never closed here. */
  pluginTransport?: ProtocolClient;
  pluginRunId?: string;
  pluginVuId?: string;
  resolveProtocol(request: ExecutableRequest): ProtocolClient | undefined;
  /** Pure SDK binding preselection; absent callers still recheck the delegated first hop. */
  resolveSdkProtocol?(request: ExecutableRequest): ProtocolClient | undefined;
  resolveAuth(type: string): AuthProvider | undefined;
  resolveAssert(op: string): AssertOperator | undefined;
  scriptEngine?: ScriptEngine;
  timeouts?: Pick<HttpExecuteOptions, "connectTimeoutMs" | "totalTimeoutMs" | "signal">;
  requestSettings?: RequestSettingsOverride;
  /** Host-supplied workspace root for capturing explicit local request files. */
  workspaceRoot?: string;
  /** Explicitly owned by the surrounding run/session; never a process-global jar. */
  httpSession?: HttpSession;
  observeHttp?: (event: HttpHopObservation) => void | Promise<void>;
  bus?: EventBus;
  beforeSend?: (finalRequest: ExecutableRequest) => void | Promise<void>;
  requestGate?: StressRequestGate;
}

export interface CaseExecutionResult {
  outcome: CaseOutcome;
  /** Complete host-internal values. Project before any IPC or report persistence. */
  assertionOutcomes?: AssertionOutcome[];
  extractionOutcomes?: ExtractionOutcome[];
  extractionsCommitted?: boolean;
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
    headers: { ...response.headers },
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
  const extractionState = input.extractionState ?? createExtractionRuntimeState();
  const prepared = input.prepared ?? prepareCaseExecution(testCase, input.assetContext, asset.contract.id, deps.resolveAssert);
  const scriptWrites = new Map<string, string>();
  const restoreVariables = () => {
    resolver.clearRuntime();
    for (const [key, value] of persisted) resolver.setRuntime(key, value);
    for (const [key, value] of Object.entries(extractionVariables(extractionState))) resolver.setRuntime(key, value);
    for (const [key, value] of Object.entries(testCase.parameters)) resolver.setRuntime(key, value);
    for (const [key, value] of Object.entries(input.row ?? {})) resolver.setRuntime(key, value);
    for (const [key, value] of scriptWrites) resolver.setRuntime(key, value);
  };
  const effectiveRequest = getEffectiveCaseRequest(asset, testCase);
  const signal = deps.timeouts?.signal;
  let clientOptions: HttpExecuteOptions | undefined;
  let ownedPluginTransport: ReturnType<typeof createHttpClient> | undefined;
  let capturedFiles: CapturedRequestFiles | undefined;
  const contractId = asset.contract.id;
  const apiName = asset.contract.metadata.name;
  const globals = input.globals ?? {};
  // The diagnostic request is always available, even when variable resolution fails.
  // Every nested request object is owned by this invocation; scripts/plugins may mutate it.
  let request = emptyRequest();
  let materialized: ExecutableRequest | undefined;
  let refreshRequest: (() => void) | undefined;

  const pmAsserts: Array<{ pass: boolean; message: string }> = [];
  const pm: PmApi = {
    variables: {
      get: (name) => resolver.get(name),
      set: (name, value) => {
        persisted.set(name, value); persistedSnapshot[name] = value; resolver.setRuntime(name, value);
        scriptWrites.set(name, value); extractionState.bindings.delete(name);
        refreshRequest?.();
      },
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
    try {
      if (!deps.scriptEngine) throw new Error("缺少 javascript 脚本引擎插件");
      deps.scriptEngine.run(code, ctx);
    }
    finally { scriptTimeMs += now() - before; }
  };
  const emit = async <K extends keyof RunEventMap>(type: K, payload: RunEventMap[K]) => {
    if (deps.bus) await deps.bus.emit(type, payload);
  };

  try {
    restoreVariables();
    if (!deps.scriptEngine && [...testCase.preOperations, ...testCase.postOperations].some(operation => operation.type === "script")) throw invalidRequest("缺少 javascript 脚本引擎插件");
    if (prepared.testCase !== testCase || prepared.assertions.context !== input.assetContext || prepared.assertions.owner?.contractId !== contractId) throw invalidRequest("Prepared case does not belong to the selected snapshot and owner");
    if (prepared.assertions.diagnostics.length) throw invalidRequest("声明式断言配置无效");
    if (prepared.extractionError) throw invalidRequest("声明式提取配置无效");
    if (prepared.extractions) extractionState.prepared.set(prepared.definitions, prepared.extractions);
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
    const materialize = () => mutableRequest(materializeRequest(contract, input.assetContext, {
      resolve: (template) => resolver.resolve(template),
      envBaseUrl: input.envBaseUrl,
      globals,
      credentials: input.credentialBindings,
    }, effectiveRequest));
    request = materialize(); materialized = structuredClone(request);
    // Rebind untouched fields on pre-script variable writes; direct edits retain precedence.
    refreshRequest = () => {
      const next = materialize();
      mergeTemplateFields(request as unknown as Record<string, unknown>, materialized as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
      materialized = structuredClone(next);
    };
    if (request.protocol !== "http" && input.network?.requiresHttpAdapter) {
      throw invalidRequest("所选网络配置仅支持 HTTP 协议请求");
    }
    if (request.protocol === "http") {
      capturedFiles = await captureRequestFiles(request, {
        workspaceRoot: deps.workspaceRoot,
        uploadLimitBytes: resolvedSettings.uploadLimitBytes,
      });
      clientOptions.runtime = {
        files: capturedFiles,
        ...(input.network === undefined ? {} : { network: input.network }),
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
          if (deps.requestGate) await deps.requestGate.beforeRedirect(nextRequest, signal ?? new AbortController().signal);
        },
      };
    }
    await emit("beforeCase", { apiName, caseName: testCase.name, apiId: contractId, caseId: testCase.id, row: input.isDataDriven ? input.rowIndex : undefined });
    for (const operation of testCase.preOperations) if (operation.type === "script") runScript(operation.content);
    refreshRequest = undefined;
    stage = "config";
    await emit("beforeRequest", { request });

    validateExecutableRequest(request);
    const runtimeAuth = request.auth;
    if (runtimeAuth.kind !== "none") {
      const auth = deps.resolveAuth(runtimeAuth.kind);
      if (!auth || auth.type !== runtimeAuth.kind) throw invalidRequest(`无可用认证提供方: ${runtimeAuth.kind}`);
      auth.apply(request, runtimeAuth);
    }
    const sdkClient = deps.resolveSdkProtocol?.(request);
    if (!sdkClient) {
      if (deps.beforeSend) await deps.beforeSend(request);
      validateExecutableRequest(request);
      if (request.protocol !== "http" && input.network?.requiresHttpAdapter) {
        throw invalidRequest("所选网络配置仅支持 HTTP 协议请求");
      }
    }
    let protocolOptions = clientOptions;
    if (request.protocol !== "http" && clientOptions.runtime?.network) {
      const runtime = { ...clientOptions.runtime };
      delete runtime.network;
      protocolOptions = { ...clientOptions, runtime };
    }
    const client = sdkClient ?? deps.resolveProtocol(request);
    if (!client) throw invalidRequest(`无可用协议客户端处理 ${request.url}`);
    // Share the original gate/timing/release path between ordinary protocols and
    // the SDK's restored first hop. Nothing is admitted for the pre-rewrite URL.
    const executeAttempt = async (transport: ProtocolClient, actualRequest: ExecutableRequest, options: HttpExecuteOptions): Promise<ExecutionResponse> => {
      const release = deps.requestGate ? await deps.requestGate.enter(actualRequest, signal ?? new AbortController().signal) : undefined;
      if (deps.requestGate && signal?.aborted) { release?.(); throw new DOMException("Aborted", "AbortError"); }
      stage = "request";
      requestStarted = true;
      const requestStartAt = now();
      let protocolError: unknown, actualResponse: ExecutionResponse | undefined;
      try {
        actualResponse = await transport.execute(actualRequest, options);
        return actualResponse;
      } catch (e) {
        protocolError = e;
        failureKind = isAbort(e, signal) ? "aborted" : protocolFailureKind(e);
        throw e;
      } finally {
        const attemptTimeMs = now() - requestStartAt;
        const timing = protocolError as { networkStarted?: unknown; attemptTimeMs?: unknown } | null | undefined;
        const hasNetworkTiming = typeof timing === "object" && timing !== null && typeof timing.networkStarted === "boolean";
        requestTimeMs = actualResponse && Number.isFinite(actualResponse.timeMs) && actualResponse.timeMs >= 0
          ? actualResponse.timeMs
          : hasNetworkTiming
            ? timing.networkStarted && Number.isFinite(timing.attemptTimeMs) ? Number(timing.attemptTimeMs) : 0
            : attemptTimeMs;
        requestCompleted = true;
        release?.();
      }
    };
    if (client.sdkProtocol) {
      const transport = deps.pluginTransport ?? client.sdkTransport ?? (request.protocol === "websocket" ? wsClient
        : request.protocol === "soap" ? createSoapClient(ownedPluginTransport ??= createHttpClient())
        : (ownedPluginTransport ??= createHttpClient()));
      const checkedTransport: ProtocolClient = { name: transport.name, canHandle: next => transport.canHandle(next), async execute(next, options) {
        request = next;
        validateExecutableRequest(next);
        if (deps.beforeSend) await deps.beforeSend(next);
        validateExecutableRequest(next);
        if (next.protocol !== "http" && input.network?.requiresHttpAdapter) throw invalidRequest("所选网络配置仅支持 HTTP 协议请求");
        return executeAttempt(transport, next, options);
      } };
      protocolOptions = { ...protocolOptions, runtime: { ...protocolOptions.runtime, pluginTransport: checkedTransport,
        pluginRunId: deps.pluginRunId, pluginVuId: deps.pluginVuId } };
      response = await client.execute(request, protocolOptions);
    } else {
      response = await executeAttempt(client, request, protocolOptions);
    }
    if (response.timeMs !== requestTimeMs) response = { ...response, timeMs: requestTimeMs };
    // Each attempt owns one immutable complete response, including plugins that reuse response objects.
    response = Object.freeze({ ...response, headers: Object.freeze({ ...response.headers }),
      ...(response.rawHeaders ? { rawHeaders: Object.freeze(response.rawHeaders.map(([name, value]) => Object.freeze([name, value] as const))) } : {}),
      ...(response.bodyBytes ? { bodyBytes: new Uint8Array(response.bodyBytes) } : {}),
    });
    await emit("afterResponse", { status: response.status, timeMs: response.timeMs, headers: { ...response.headers }, bodyText: response.bodyText });
    pm.response = responseView(response);
    for (const operation of testCase.postOperations) if (operation.type === "script") runScript(operation.content);
  } catch (e) {
    error = errorMessage(e);
    failureKind ??= isAbort(e, signal)
      ? "aborted"
      : ((e as { caseFailureKind?: CaseFailureKind }).caseFailureKind ?? (String(stage) === "script" ? "script" : "config"));
  } finally {
    try { await ownedPluginTransport?.close(); }
    catch (e) { error ??= errorMessage(e); failureKind ??= "transport"; }
    try { await capturedFiles?.close(); }
    catch (e) {
      error ??= errorMessage(e);
      failureKind ??= (e as { caseFailureKind?: CaseFailureKind }).caseFailureKind ?? "config";
    }
  }

  let extractionOutcomes: ExtractionOutcome[];
  let extractionsCommitted = false;
  if (error !== undefined) {
    extractionOutcomes = skippedExtractions(prepared.definitions, extractionState);
    if (prepared.extractionError) extractionOutcomes = extractionOutcomes.map((outcome) => ({
      ...outcome, status: "failed", kind: "config", code: prepared.extractionError!.code, message: prepared.extractionError!.message,
    }));
  }
  else {
    const batch = evaluateExtractions(prepared.definitions, response!, extractionState);
    extractionOutcomes = batch.outcomes;
    extractionsCommitted = batch.committed;
    if (batch.failureKind) { failureKind = batch.failureKind; error = batch.failureKind === "config" ? "声明式提取配置无效" : "声明式提取失败"; }
  }
  restoreVariables();
  // Current publication overrides row/parameters; prior publication only belongs to the prior-runtime layer.
  if (extractionsCommitted) for (const definition of prepared.definitions) {
    const binding = extractionState.bindings.get(definition.name);
    if (binding) resolver.setRuntime(definition.name, binding.text);
  }
  const assertionOutcomes = evaluateCaseAssertions(prepared.assertions, response, resolver);
  // Operator diagnostics can embed complete actual/expected, including sensitive extraction values.
  // Until C1 projects evidence, only value-free summaries may enter the existing report fields.
  const assertions = [...assertionOutcomes.map(({ pass, selector, kind }) => ({
    pass,
    message: `${selector.target === "bodyJson" ? "JSON 断言" : "断言"}${pass ? "通过" : kind === "config" ? "配置无效" : "失败"}`,
  })), ...pmAsserts];
  if (error === undefined && assertionOutcomes.some((entry) => !entry.pass && entry.kind === "config")) {
    failureKind = "config";
    error = "声明式断言配置无效";
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
    ...(input.locator ? { locator: { ...input.locator, folderIds: [...input.locator.folderIds] } } : {}),
    scope: testCase.scope,
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
  return { outcome, assertionOutcomes, extractionOutcomes, extractionsCommitted, request, response, requestTimeMs, scriptTimeMs, iterationTimeMs, requestStarted, requestCompleted, failureKind };
}
