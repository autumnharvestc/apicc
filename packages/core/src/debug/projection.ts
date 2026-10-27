import { Buffer } from "node:buffer";
import { createCredentialOutputSanitizer } from "../credentials/output.js";
import type { ExecutableRequest, ExecutionResponse, HttpCapturedFileMetadata, HttpHopObservation } from "../plugin/types.js";
import type { ApiRequest } from "../contract/model.js";
import type { RunResult, CaseOutcome } from "../report/types.js";
import type { CaseExecutionResult } from "../runner/caseExecutor.js";
import type { EvidenceLimits } from "../report/evidence.js";
import type {
  DebugCaseIdentity, DebugExchange, DebugExecutionIdentity, DebugFieldState, DebugInvocation,
  DebugRequest, DebugRequestBody, DebugResponse, DebugResponseBody, DebugResult, DebugRunSummary, DebugSourceCategory,
  DebugResultSource,
} from "./model.js";

const MAX_BODY_SUMMARY_BYTES = 1024 * 1024;
const MAX_CALL_BODY_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_PREVIEW_BYTES = 512 * 1024;
const MAX_EXCHANGES = 100;
const MAX_OBSERVED_MARKER_COUNT = 512;
const MAX_OBSERVED_MARKER_BYTES = 512 * 1024;
const MAX_OBSERVED_MARKER_LENGTH = 16 * 1024;

interface SummaryBudget { remaining: number; bodyBytes?: number }

interface ExchangeDraft {
  value: DebugExchange;
  startedAtMonotonic: number;
  requestMarkerGeneration?: number;
  responseMarkerGeneration?: number;
}

export interface DebugExchangeCollector {
  addMarkers(values: readonly string[]): void;
  observe(event: HttpHopObservation, identity: DebugExecutionIdentity): void;
  observeExecution(execution: CaseExecutionResult, identity: DebugExecutionIdentity): void;
  exchanges(): DebugExchange[];
  exchangeTotal(): number;
  markers(): string[];
  lateMarkersFor(exchange: DebugExchange, part: "request" | "response"): string[];
  projectionReliable(): boolean;
}

export function createDebugExchangeCollector(markers: readonly string[], limits?: EvidenceLimits): DebugExchangeCollector {
  const markerValues = new Set(markers.filter(Boolean));
  const observedMarkerValues = new Set<string>();
  const markerGenerations = new Map<string, number>();
  let markerGeneration = 0;
  let observedMarkerBytes = 0;
  let reliable = true;
  const budget: SummaryBudget = { remaining: Math.min(MAX_CALL_BODY_SUMMARY_BYTES, limits?.reportBytes ?? MAX_CALL_BODY_SUMMARY_BYTES), bodyBytes: limits?.bodyBytes };
  const drafts: ExchangeDraft[] = [];
  const byKey = new Map<string, ExchangeDraft>();
  const observedKeys = new Set<string>();
  const observedRows = new Set<string>();
  let total = 0;

  const keyFor = (identity: DebugExecutionIdentity, hopIndex: number): string =>
    JSON.stringify([identity.source, identity.rowIndex, hopIndex]);
  const rowKeyFor = (identity: DebugExecutionIdentity): string =>
    JSON.stringify([identity.source, identity.rowIndex]);

  const newDraft = (identity: DebugExecutionIdentity, hopIndex: number, order: number, startedAt: string): ExchangeDraft | undefined => {
    if (order > MAX_EXCHANGES) return undefined;
    const draft: ExchangeDraft = {
      startedAtMonotonic: performance.now(),
      value: {
        source: identity.source,
        observation: "http-hop",
        rowIndex: identity.rowIndex,
        hopIndex,
        order,
        transportState: "prepared",
        settings: identity.settings,
        intent: projectRowIntent({ parameters: identity.parameters ?? {}, fields: [...(identity.fields ?? [])], available: true }, createCurrentSanitizer(), reliable),
        startedAt,
      },
    };
    drafts.push(draft);
    byKey.set(keyFor(identity, hopIndex), draft);
    return draft;
  };

  const observe = (event: HttpHopObservation, identity: DebugExecutionIdentity): void => {
    const timestamp = new Date().toISOString();
    const key = keyFor(identity, event.hopIndex);
    observedRows.add(rowKeyFor(identity));
    let draft = byKey.get(key);
    if (event.type === "request") {
      observeRequestCredentials(event.request, addObservedMarker);
      if (!observedKeys.has(key)) {
        total += 1;
        observedKeys.add(key);
      }
      draft = newDraft(identity, event.hopIndex, total, timestamp);
      if (draft) {
        draft.requestMarkerGeneration = markerGeneration;
        const sourceCategories = new Set<DebugSourceCategory>(identity.sourceCategories ?? ["unknown"]);
        if (event.request.auth.kind === "none") sourceCategories.delete("auth");
        if (event.sessionCookieUsed === true) sourceCategories.add("session");
        if (event.sessionCookieUsed === undefined) sourceCategories.add("unknown");
        draft.value = {
          ...draft.value,
          request: projectRequest(event.request, createCurrentSanitizer(), budget, event.url, event.method, reliable,
            [...sourceCategories], event.capturedFiles),
        };
      }
      return;
    }

    if (event.type === "response") observeResponseCredentials(event.rawHeaders, addObservedMarker);
    else if (event.response !== undefined) observeResponseCredentials(event.response.rawHeaders, addObservedMarker);

    if (!draft) {
      if (!observedKeys.has(key)) {
        total += 1;
        observedKeys.add(key);
      }
      draft = newDraft(identity, event.hopIndex, total, timestamp);
    }
    if (!draft) return;
    draft.responseMarkerGeneration = markerGeneration;
    const durationMs = Math.max(0, performance.now() - draft.startedAtMonotonic);
    if (event.type === "response") {
      const sanitizer = createCurrentSanitizer();
      draft.value = {
        ...draft.value,
        transportState: "responded",
        response: projectCompleteResponse(event, sanitizer, currentMarkerBytes(), budget, reliable),
        finishedAt: timestamp,
        durationMs,
      };
      return;
    }
    const sanitizer = createCurrentSanitizer();
    draft.value = {
      ...draft.value,
      transportState: event.response !== undefined ? "headers-received" : event.networkStarted ? "entered" : "failed",
      ...(event.response === undefined ? {} : { response: projectIncompleteResponse(event.response, event.requestBody, event.requestBodyChain, sanitizer, reliable) }),
      finishedAt: timestamp,
      durationMs,
      failureStage: event.stage,
      failureCode: event.code,
    };
  };

  const observeExecution = (execution: CaseExecutionResult, identity: DebugExecutionIdentity): void => {
    if (observedRows.has(rowKeyFor(identity)) || execution.response === undefined) return;
    const response = execution.response;
    observeResponseCredentials(Object.entries(response.headers), addObservedMarker);
    const timestamp = new Date().toISOString();
    total += 1;
    const draft = newDraft(identity, 0, total, timestamp);
    if (!draft) return;
    draft.responseMarkerGeneration = markerGeneration;
    draft.value = {
      ...draft.value,
      observation: "legacy-text",
      transportState: "responded",
      response: projectLegacyResponse(response, createCurrentSanitizer(), budget, reliable),
      finishedAt: timestamp,
      durationMs: response.timeMs,
    };
  };

  return {
    observe,
    observeExecution,
    addMarkers: (values) => { for (const value of values) addObservedMarker(value); },
    exchanges: () => drafts.map((draft) => draft.value),
    exchangeTotal: () => total,
    markers: () => currentMarkerStrings(),
    lateMarkersFor: (exchange, part) => {
      const draft = drafts.find((candidate) => candidate.value === exchange);
      const generation = part === "request" ? draft?.requestMarkerGeneration : draft?.responseMarkerGeneration;
      if (generation === undefined) return [];
      const lateMarkers = [...markerGenerations].filter(([, addedAt]) => addedAt > generation).map(([marker]) => marker);
      return expandMarkerValues(lateMarkers);
    },
    projectionReliable: () => reliable,
  };

  function addObservedMarker(value: string): void {
    if (!value || observedMarkerValues.has(value) || markerValues.has(value)) return;
    const size = Buffer.byteLength(value, "utf8");
    if (value.length > MAX_OBSERVED_MARKER_LENGTH
      || observedMarkerValues.size >= MAX_OBSERVED_MARKER_COUNT
      || observedMarkerBytes + size > MAX_OBSERVED_MARKER_BYTES) {
      reliable = false;
      return;
    }
    observedMarkerValues.add(value);
    observedMarkerBytes += size;
    markerValues.add(value);
    markerGeneration += 1;
    markerGenerations.set(value, markerGeneration);
  }

  function currentMarkerStrings(): string[] {
    return expandMarkerValues([...markerValues]);
  }

  function createCurrentSanitizer(): ReturnType<typeof createCredentialOutputSanitizer> {
    return createCredentialOutputSanitizer(currentMarkerStrings());
  }

  function currentMarkerBytes(): Buffer[] {
    return currentMarkerStrings().map((marker) => Buffer.from(marker, "utf8"));
  }

  function projectCompleteResponse(
    event: Extract<HttpHopObservation, { type: "response" }>,
    textSanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
    knownBytes: readonly Buffer[],
    summaryBudget: SummaryBudget,
    markersReliable: boolean,
  ): DebugResponse {
    const rawHeaders = event.rawHeaders.map(([name, value]) => [textSanitizer.redactText(name), projectResponseHeader(name, value, textSanitizer)] as [string, string]);
    const headers = Object.entries(event.headers).map(([name, value]) => [textSanitizer.redactText(name), projectResponseHeader(name, value, textSanitizer)] as [string, string]);
    const contentType = findHeader(event.rawHeaders, "content-type");
    const body = !markersReliable
      ? { kind: "metadata" as const, omittedReason: "unreliable" as const }
      : event.textAvailable && event.bodyText !== undefined
      ? summarizeTextBody(event.bodyText, event.decodedBytes, textSanitizer, summaryBudget)
      : summarizeBinaryBody(event.bodyBytes, event.decodedBytes, knownBytes, summaryBudget);
    return {
      status: event.status,
      headers: markersReliable ? headers : headers.map(() => ["[REDACTED]", "[REDACTED]"]),
      rawHeaders: markersReliable ? rawHeaders : rawHeaders.map(() => ["[REDACTED]", "[REDACTED]"]),
      cookies: event.rawHeaders.filter(([name]) => name.toLowerCase() === "set-cookie")
        .map(([, value]) => markersReliable ? projectSetCookie(value, textSanitizer) : "[REDACTED]"),
      ...(contentType === undefined ? {} : { contentType: markersReliable ? textSanitizer.redactText(contentType) : "[REDACTED]" }),
      encodedReceivedBytes: event.encodedBytes,
      decodedReceivedBytes: event.decodedBytes,
      ...(event.declaredLength === undefined ? {} : { declaredContentLength: event.declaredLength }),
      completeLength: event.decodedBytes,
      bodyComplete: true,
      body,
      requestBody: { ...event.requestBody },
      requestBodyChain: { ...event.requestBodyChain },
    };
  }

  function projectIncompleteResponse(
    response: Extract<HttpHopObservation, { type: "failure" }>['response'] & {},
    requestBody: Extract<HttpHopObservation, { type: "failure" }>['requestBody'],
    requestBodyChain: Extract<HttpHopObservation, { type: "failure" }>['requestBodyChain'],
    textSanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
    markersReliable: boolean,
  ): DebugResponse {
    const contentType = findHeader(response.rawHeaders, "content-type");
    return {
      status: response.status,
      headers: Object.entries(response.headers).map(([name, value]) => markersReliable
        ? [textSanitizer.redactText(name), projectResponseHeader(name, value, textSanitizer)] as [string, string]
        : ["[REDACTED]", "[REDACTED]"]),
      rawHeaders: response.rawHeaders.map(([name, value]) => markersReliable
        ? [textSanitizer.redactText(name), projectResponseHeader(name, value, textSanitizer)] as [string, string]
        : ["[REDACTED]", "[REDACTED]"]),
      cookies: response.rawHeaders.filter(([name]) => name.toLowerCase() === "set-cookie")
        .map(([, value]) => markersReliable ? projectSetCookie(value, textSanitizer) : "[REDACTED]"),
      ...(contentType === undefined ? {} : { contentType: markersReliable ? textSanitizer.redactText(contentType) : "[REDACTED]" }),
      encodedReceivedBytes: response.encodedBytes,
      decodedReceivedBytes: response.decodedBytes,
      ...(response.declaredLength === undefined ? {} : { declaredContentLength: response.declaredLength }),
      bodyComplete: false,
      body: { kind: "metadata", omittedReason: "incomplete" },
      requestBody: { ...requestBody },
      requestBodyChain: { ...requestBodyChain },
    };
  }

  function projectRequest(
    request: ExecutableRequest,
    textSanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
    summaryBudget: SummaryBudget,
    finalUrl: string,
    finalMethod: string,
    markersReliable: boolean,
    sourceCategories: DebugSourceCategory[],
    capturedFiles?: readonly HttpCapturedFileMetadata[],
  ): DebugRequest {
    const cookieHeader = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "cookie")?.[1];
    let body: DebugRequestBody;
    if (!markersReliable) body = { kind: "metadata", omittedReason: "unreliable" };
    else if (request.protocol === "http") body = projectRuntimeBody(request.body, textSanitizer, summaryBudget, capturedFiles);
    else if (request.protocol === "websocket") {
      body = request.message === undefined
        ? { kind: "none" }
        : summarizeRequestTextBody(request.message, textSanitizer, summaryBudget);
    } else body = summarizeRequestTextBody(request.envelope, textSanitizer, summaryBudget);

    return {
      url: markersReliable ? textSanitizer.redactText(finalUrl) : "[REDACTED]",
      method: request.protocol === "websocket" ? "WEBSOCKET" : finalMethod,
      query: request.query.map((entry) => ({
        key: markersReliable ? textSanitizer.redactText(entry.key) : "[REDACTED]",
        value: markersReliable ? textSanitizer.redactText(entry.value) : "[REDACTED]",
        enabled: entry.enabled,
      })),
      headers: Object.entries(request.headers).map(([name, value]) => markersReliable
        ? [textSanitizer.redactText(name), projectRequestHeader(name, value, textSanitizer)]
        : ["[REDACTED]", "[REDACTED]"]),
      cookies: !markersReliable || cookieHeader === undefined ? [] : projectCookies(cookieHeader, textSanitizer),
      body,
      sourceCategories,
    };
  }

  function projectRuntimeBody(
    body: Extract<ExecutableRequest, { protocol: "http" }>['body'],
    textSanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
    summaryBudget: SummaryBudget,
    capturedFiles?: readonly HttpCapturedFileMetadata[],
  ): DebugRequestBody {
    if (!body) return { kind: "none" };
    switch (body.kind) {
      case "json":
      case "xml":
      case "raw":
        return summarizeRequestTextBody(body.content, textSanitizer, summaryBudget);
      case "form": {
        const bodyBudget: SummaryBudget = { remaining: summaryBudget.bodyBytes ?? MAX_BODY_SUMMARY_BYTES };
        return {
          kind: "form",
          fields: body.form.map((field) => {
            const key = summarizeText(field.key, textSanitizer, summaryBudget, bodyBudget);
            const value = summarizeText(field.value, textSanitizer, summaryBudget, bodyBudget);
            return { key: key.text, value: value.text, truncated: key.truncated || value.truncated };
          }),
        };
      }
      case "binary":
        return {
          kind: "binary", contentType: textSanitizer.redactText(body.contentType), source: "local-file",
          ...projectCapturedFile(capturedFiles?.find((file) => file.entryIndex === 0), textSanitizer, summaryBudget, { remaining: summaryBudget.bodyBytes ?? MAX_BODY_SUMMARY_BYTES }),
        };
      case "multipart": {
        const bodyBudget: SummaryBudget = { remaining: summaryBudget.bodyBytes ?? MAX_BODY_SUMMARY_BYTES };
        return {
          kind: "multipart",
          entries: body.entries.map((entry, entryIndex) => entry.kind === "text"
            ? (() => {
                const name = summarizeText(entry.name, textSanitizer, summaryBudget, bodyBudget);
                const value = summarizeText(entry.value, textSanitizer, summaryBudget, bodyBudget);
                return { kind: "text" as const, name: name.text, value: value.text, truncated: name.truncated || value.truncated };
              })()
            : {
                kind: "file" as const,
                name: textSanitizer.redactText(entry.name),
                ...(entry.filename === undefined ? {} : (() => {
                  const filename = summarizeFilename(entry.filename, textSanitizer, summaryBudget, bodyBudget);
                  return filename === undefined ? {} : { filename };
                })()),
                contentType: textSanitizer.redactText(entry.contentType),
                source: "local-file" as const,
                ...projectCapturedFile(capturedFiles?.find((file) => file.entryIndex === entryIndex), textSanitizer, summaryBudget, bodyBudget),
              }),
        };
      }
    }
  }

  function projectCapturedFile(
    file: HttpCapturedFileMetadata | undefined,
    textSanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
    summaryBudget: SummaryBudget,
    bodyBudget: SummaryBudget,
  ): Pick<Extract<DebugRequestBody, { kind: "binary" }>, "metadataAvailable" | "capturedFilename" | "capturedSizeBytes" | "effectiveFilename"> {
    if (!file) return {};
    if (!file.available) return { metadataAvailable: false };
    const capturedFilename = file.capturedFilename === undefined ? undefined : summarizeFilename(file.capturedFilename, textSanitizer, summaryBudget, bodyBudget);
    const effectiveFilename = file.effectiveFilename === undefined ? undefined : summarizeFilename(file.effectiveFilename, textSanitizer, summaryBudget, bodyBudget);
    return {
      metadataAvailable: true,
      ...(capturedFilename === undefined ? {} : { capturedFilename }),
      ...(file.capturedSizeBytes === undefined ? {} : { capturedSizeBytes: file.capturedSizeBytes }),
      ...(effectiveFilename === undefined ? {} : { effectiveFilename }),
    };
  }

  function summarizeRequestTextBody(
    raw: string,
    textSanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
    summaryBudget: SummaryBudget,
  ): DebugRequestBody {
    const summary = summarizeText(raw, textSanitizer, summaryBudget);
    return { kind: "text", text: summary.text, contentBytes: Buffer.byteLength(raw, "utf8"), truncated: summary.truncated };
  }

  function summarizeBinaryBody(
    bytes: Uint8Array,
    contentBytes: number,
    knownBytes: readonly Buffer[],
    summaryBudget: SummaryBudget,
  ): DebugResponseBody {
    if (bytes.byteLength > MAX_BINARY_SCAN_BYTES) {
      return { kind: "binary", contentBytes, truncated: bytes.byteLength > 0, omittedReason: "unreliable" };
    }
    const byteView = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (knownBytes.some((marker) => marker.length > 0 && byteView.indexOf(marker) !== -1)) {
      return { kind: "binary", contentBytes, truncated: bytes.byteLength > 0, omittedReason: "credential-match" };
    }
    const budgetBytes = Math.max(0, Math.min(summaryBudget.bodyBytes ?? MAX_BODY_SUMMARY_BYTES, summaryBudget.remaining));
    const previewBytes = Math.min(bytes.byteLength, MAX_BINARY_PREVIEW_BYTES, Math.floor(budgetBytes / 2));
    if (previewBytes <= 0) return { kind: "binary", contentBytes, truncated: bytes.byteLength > 0, omittedReason: "budget" };
    const previewHex = byteView.subarray(0, previewBytes).toString("hex");
    summaryBudget.remaining -= Buffer.byteLength(previewHex, "utf8");
    return {
      kind: "binary",
      contentBytes,
      previewHex,
      truncated: previewBytes < bytes.byteLength,
    };
  }
}

export function projectDebugResult(input: {
  limits?: EvidenceLimits;
  plan: {
    invocation: DebugInvocation;
    source: DebugResultSource;
    sourceProjectRevision: string;
    executionSnapshotRevision: string;
    requestTemplate?: ApiRequest;
    baseParameters?: Readonly<Record<string, string>>;
    fields?: readonly DebugFieldState[];
  };
  runId: string;
  run: RunResult;
  collector: DebugExchangeCollector;
  markers: readonly string[];
  projectionReliable?: boolean;
  startedAt: string;
  finishedAt: string;
  failureKind?: DebugResult["failureKind"];
  error?: unknown;
  errorName?: string;
}): DebugResult {
  const { plan, runId, run, collector, markers, startedAt, finishedAt } = input;
  const projectionReliable = (input.projectionReliable ?? true) && collector.projectionReliable();
  const sanitizer = createCredentialOutputSanitizer(markers);
  const markerBytes = markers.map((marker) => Buffer.from(marker, "utf8")).filter((marker) => marker.length > 0);
  const exposeAssetIdentity = plan.source.sourceKind === "asset";
  const outcomes = run.cases.map((outcome) => projectOutcome(outcome, sanitizer, projectionReliable, exposeAssetIdentity));
  const replay = projectReplay(plan, sanitizer, projectionReliable);
  const warnings = (run.warnings ?? []).map((warning) => projectionReliable ? sanitizer.redactText(warning) : "[REDACTED]");
  if ((replay.mode === "request" || replay.mode === "free") && !replay.available) warnings.push("The request replay descriptor is unavailable because credential projection would change its structure.");
  const finalBodyBudget: SummaryBudget = { remaining: Math.min(MAX_CALL_BODY_SUMMARY_BYTES, input.limits?.reportBytes ?? MAX_CALL_BODY_SUMMARY_BYTES), bodyBytes: input.limits?.bodyBytes };
  const exchanges = collector.exchanges().map((exchange) => projectFinalExchange(
    exchange,
    sanitizer,
    markerBytes,
    projectionReliable,
    collector.lateMarkersFor(exchange, "request"),
    collector.lateMarkersFor(exchange, "response"),
    finalBodyBudget,
  ));
  const safeSource = projectIdentity(plan.source, sanitizer, projectionReliable);
  const safeEnvironmentId = plan.invocation.environmentId === undefined
    ? undefined
    : projectScalarIdentity(plan.invocation.environmentId, sanitizer, projectionReliable);
  const errorText = input.error === undefined
    ? undefined
    : projectionReliable ? sanitizer.redactText(input.error instanceof Error ? input.error.message : String(input.error)) : "[REDACTED]";
  const errorName = input.errorName === undefined
    ? undefined
    : projectionReliable ? sanitizer.redactText(input.errorName) : "[REDACTED]";
  const result: DebugResult = {
    runId,
    source: safeSource ?? { sourceKind: "unavailable" },
    sourceProjectRevision: plan.sourceProjectRevision,
    executionSnapshotRevision: plan.executionSnapshotRevision,
    mode: plan.invocation.mode,
    identityAvailable: safeSource !== undefined,
    ...(safeEnvironmentId === undefined ? {} : { environmentId: safeEnvironmentId }),
    startedAt,
    finishedAt,
    run: projectRunSummary(run, sanitizer, projectionReliable, exposeAssetIdentity),
    outcomes,
    exchanges,
    exchangeTotal: collector.exchangeTotal(),
    omittedExchangeCount: Math.max(0, collector.exchangeTotal() - collector.exchanges().length),
    replay,
    console: [],
    warnings,
    ...(input.failureKind === undefined ? firstFailureKind(outcomes) : { failureKind: input.failureKind }),
    ...(errorText === undefined ? {} : { error: errorText }),
    ...(errorName === undefined ? {} : { errorName }),
  };
  return input.limits ? boundDebugResult(result, input.limits) : result;
}

/** Configured preview limits also cover the debugger's display/replay aliases. */
function boundDebugResult(result: DebugResult, limits: EvidenceLimits): DebugResult {
  const valueBytes = limits.valueBytes ?? 4096; const reportBytes = limits.reportBytes ?? 16 * 1024 * 1024;
  let remaining = reportBytes;
  const text = (value: string): string => {
    let safe = ""; let bytes = 0; const allowance = Math.min(valueBytes, Math.max(0, remaining - 128));
    for (const char of value) { const size = Buffer.byteLength(JSON.stringify(char)) - 2; if (bytes + size > allowance) break; safe += char; bytes += size; }
    remaining = Math.max(0, remaining - bytes - 128); return safe;
  };
  const pairs = (values: Array<[string, string]>) => values.map(([name, value]) => [text(name), text(value)] as [string, string]);
  result.run.collectionName = text(result.run.collectionName);
  if (result.run.envName !== undefined) result.run.envName = text(result.run.envName);
  result.run.warnings = result.run.warnings?.map(text); result.warnings = result.warnings.map(text);
  if (result.error !== undefined) result.error = text(result.error);
  for (const outcome of result.outcomes) {
    outcome.apiName = text(outcome.apiName); outcome.caseName = text(outcome.caseName);
    if (outcome.error !== undefined) outcome.error = text(outcome.error);
    outcome.assertions = outcome.assertions.map(assertion => ({ ...assertion, message: text(assertion.message) }));
    if (Buffer.byteLength(JSON.stringify(outcome)) > (limits.caseBytes ?? 256 * 1024)) {
      if (outcome.evidence) outcome.evidence = { identity: outcome.evidence.identity, state: "omitted", truncated: true, bodyUnavailable: true, scriptDiagnostics: "not-collected" };
      outcome.assertions = [];
    }
    if (outcome.evidence && Buffer.byteLength(JSON.stringify(outcome.evidence)) > (limits.caseBytes ?? 256 * 1024)) throw new Error("Debug case evidence identity framing exceeds capacity");
    if (Buffer.byteLength(JSON.stringify(outcome)) > (limits.caseBytes ?? 256 * 1024)) throw new Error("Debug case identity framing exceeds capacity");
  }
  for (const exchange of result.exchanges) {
    if (exchange.request) {
      exchange.request.url = text(exchange.request.url); exchange.request.headers = pairs(exchange.request.headers); exchange.request.cookies = pairs(exchange.request.cookies);
      exchange.request.query = exchange.request.query.map(value => ({ ...value, key: text(value.key), value: text(value.value) }));
    }
    if (exchange.response) {
      exchange.response.headers = pairs(exchange.response.headers); exchange.response.rawHeaders = exchange.response.rawHeaders && pairs(exchange.response.rawHeaders); exchange.response.cookies = exchange.response.cookies.map(text);
    }
    if (exchange.intent) {
      const parameters: Record<string, string> = {};
      for (const [key, value] of Object.entries(exchange.intent.parameters)) {
        const safeKey = text(key); const safeValue = text(value);
        if (safeKey !== key) {
          exchange.intent.fields.push({ path: "parameters", status: "truncated", needsInput: true });
          exchange.intent.available = false;
          continue;
        }
        parameters[key] = safeValue;
        if (safeValue !== value) {
          exchange.intent.fields.push({ path: `parameters.${key}`, status: "truncated", needsInput: true });
          exchange.intent.available = false;
        }
      }
      exchange.intent.parameters = parameters;
    }
  }
  const bytes = () => Buffer.byteLength(JSON.stringify(result));
  if (bytes() > reportBytes) {
    result.replay = { ...result.replay, available: false, requestTemplate: undefined, parameters: {}, fields: [{ path: "request", status: "truncated", needsInput: true }, { path: "parameters", status: "truncated", needsInput: true }] };
    if ("request" in result.replay) result.replay.request = undefined;
    result.warnings.push(text("[omitted diagnostics: report budget]"));
  }
  while (result.exchanges.length && bytes() > reportBytes) result.exchanges.pop();
  result.omittedExchangeCount = result.exchangeTotal - result.exchanges.length;
  if (bytes() > reportBytes) for (const outcome of result.outcomes) if (outcome.evidence) outcome.evidence = { identity: outcome.evidence.identity, state: "omitted", truncated: true, bodyUnavailable: true, scriptDiagnostics: "not-collected" };
  if (bytes() > reportBytes) throw new Error("Debug result identity framing exceeds capacity");
  return result;
}

function observeRequestCredentials(request: ExecutableRequest, addMarker: (value: string) => void): void {
  for (const [name, value] of Object.entries(request.headers)) observeCredentialHeader(name, value, addMarker);
}

function observeResponseCredentials(
  headers: readonly (readonly [string, string])[],
  addMarker: (value: string) => void,
): void {
  for (const [name, value] of headers) observeCredentialHeader(name, value, addMarker);
}

function observeCredentialHeader(name: string, value: string, addMarker: (value: string) => void): void {
  const normalized = name.toLowerCase();
  if (normalized === "cookie" || normalized === "set-cookie") {
    addMarker(value);
    const cookieSegments = normalized === "set-cookie" ? [value.split(";", 1)[0] ?? ""] : value.split(";");
    for (const segment of cookieSegments) {
      const equals = segment.indexOf("=");
      if (equals <= 0) continue;
      addMarker(segment.trim());
      addMarker(segment.slice(equals + 1).trim());
    }
    return;
  }

  if (!["authorization", "proxy-authorization", "www-authenticate", "proxy-authenticate", "authentication-info", "proxy-authentication-info"].includes(normalized)) return;
  addMarker(value);
  const match = /^\s*([^\s]+)\s+(.+?)\s*$/.exec(value);
  if (!match) return;
  const scheme = match[1]!;
  const payload = match[2]!;
  addMarker(payload);
  if (scheme.toLowerCase() !== "basic" || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return;
  const bytes = Buffer.from(payload, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (canonical !== payload.replace(/=+$/, "")) return;
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) return;
  addMarker(decoded);
  const separator = decoded.indexOf(":");
  if (separator >= 0) {
    addMarker(decoded.slice(0, separator));
    addMarker(decoded.slice(separator + 1));
  }
}

function projectOutcome(
  outcome: CaseOutcome,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  projectionReliable: boolean,
  exposeAssetIdentity: boolean,
): DebugResult["outcomes"][number] {
  const apiId = exposeAssetIdentity ? projectScalarIdentity(outcome.apiId, sanitizer, projectionReliable) : undefined;
  const caseId = exposeAssetIdentity ? projectScalarIdentity(outcome.caseId, sanitizer, projectionReliable) : undefined;
  let evidence = outcome.evidence;
  if (evidence && !exposeAssetIdentity) {
    // Free requests use a temporary execution asset, never a navigable persisted resource.
    const { locator: _temporaryLocator, ...identity } = evidence.identity;
    evidence = { ...evidence, identity };
  }
  return {
    ...(apiId === undefined ? {} : { apiId }),
    ...(caseId === undefined ? {} : { caseId }),
    identityAvailable: apiId !== undefined && caseId !== undefined,
    ...(evidence === undefined ? {} : { evidence }),
    apiName: projectionReliable ? sanitizer.redactText(outcome.apiName) : "[REDACTED]",
    caseName: projectionReliable ? sanitizer.redactText(outcome.caseName) : "[REDACTED]",
    ...(outcome.row === undefined ? {} : { row: outcome.row }),
    passed: outcome.passed,
    ...(outcome.skipped === undefined ? {} : { skipped: outcome.skipped }),
    ...(outcome.skipReason === undefined ? {} : { skipReason: projectionReliable ? sanitizer.redactText(outcome.skipReason) : "[REDACTED]" }),
    durationMs: outcome.durationMs,
    assertions: outcome.assertions.map((assertion) => ({ pass: assertion.pass, message: projectionReliable ? sanitizer.redactText(assertion.message) : "[REDACTED]" })),
    ...(outcome.error === undefined ? {} : { error: projectionReliable ? sanitizer.redactText(outcome.error) : "[REDACTED]" }),
    ...(outcome.failureKind === undefined ? {} : { failureKind: outcome.failureKind }),
  };
}

function projectRunSummary(
  run: RunResult,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  projectionReliable: boolean,
  exposeAssetIdentity: boolean,
): DebugRunSummary {
  const collectionId = exposeAssetIdentity ? projectScalarIdentity(run.collectionId, sanitizer, projectionReliable) : undefined;
  return {
    ...(collectionId === undefined ? {} : { collectionId }),
    identityAvailable: collectionId !== undefined,
    collectionName: projectionReliable ? sanitizer.redactText(run.collectionName) : "[REDACTED]",
    ...(run.envName === undefined ? {} : { envName: projectionReliable ? sanitizer.redactText(run.envName) : "[REDACTED]" }),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    total: run.total,
    passed: run.passed,
    failed: run.failed,
    ...(run.skipped === undefined ? {} : { skipped: run.skipped }),
    ...(run.warnings === undefined ? {} : { warnings: run.warnings.map((warning) => projectionReliable ? sanitizer.redactText(warning) : "[REDACTED]") }),
  };
}

function projectReplay(
  plan: {
    invocation: DebugInvocation;
    source: DebugResultSource;
    requestTemplate?: ApiRequest;
    baseParameters?: Readonly<Record<string, string>>;
    fields?: readonly DebugFieldState[];
  },
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  projectionReliable: boolean,
): DebugResult["replay"] {
  const { invocation } = plan;
  const isFree = invocation.mode === "free";
  const safeLocator = invocation.mode !== "free" ? projectIdentity(invocation.locator, sanitizer, projectionReliable) : undefined;
  const safeCase = invocation.mode === "case" ? projectIdentity(invocation.case, sanitizer, projectionReliable) : undefined;
  const safeProject = invocation.mode === "free" ? projectIdentity(invocation.project, sanitizer, projectionReliable) : undefined;
  const safeDraftId = invocation.mode === "free" ? projectScalarIdentity(invocation.draftId, sanitizer, projectionReliable) : undefined;
  const requestTemplate = plan.requestTemplate ?? (invocation.mode === "request" || invocation.mode === "free" ? invocation.request : undefined);
  const baseParameters = plan.baseParameters ?? (invocation.mode === "request" || invocation.mode === "free" ? invocation.parameters : {});
  const initialFields = plan.fields ?? (invocation.mode === "request" || invocation.mode === "free" ? invocation.fields : []);
  const explicitSettings = invocation.settings === undefined ? {} : { settings: invocation.settings };
  if (!projectionReliable) {
    const fields: DebugFieldState[] = [
      { path: "request", status: "redacted", needsInput: true },
      ...(invocation.mode !== "case" ? [{ path: "parameters", status: "redacted" as const, needsInput: true }] : []),
    ];
    return invocation.mode === "case"
      ? { mode: "case", sourceKind: "asset", ...(safeCase === undefined ? {} : { case: safeCase }), parameters: {}, fields, ...explicitSettings, identityAvailable: false, available: false }
      : invocation.mode === "free"
        ? { mode: "free", sourceKind: "free", ...(safeProject === undefined ? {} : { project: safeProject }), ...(safeDraftId === undefined ? {} : { draftId: safeDraftId }), parameters: {}, fields, ...explicitSettings, identityAvailable: false, available: false }
        : { mode: "request", sourceKind: "asset", ...(safeLocator === undefined ? {} : { locator: safeLocator }), parameters: {}, fields, ...explicitSettings, identityAvailable: false, available: false };
  }

  let identityConflict = false;
  const fields = new Map<string, DebugFieldState>();
  for (const field of initialFields) {
    const safePath = sanitizer.redactText(field.path);
    if (safePath !== field.path) identityConflict = true;
    const path = safePath === field.path ? field.path : safeFieldPath(field.path);
    const state = safePath === field.path ? { ...field, path } : { path, status: "redacted" as const, needsInput: true };
    fields.set(path, state);
  }
  const projectValue = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      const projected = sanitizer.redactText(value);
      if (projected !== value) addField(fields, { path, status: "redacted", needsInput: true });
      return projected;
    }
    if (Array.isArray(value)) return value.map((item, index) => projectValue(item, `${path}[${index}]`));
    if (typeof value !== "object" || value === null) return value;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (sanitizer.redactText(key) !== key) {
        identityConflict = true;
        continue;
      }
      const childPath = path ? `${path}.${key}` : key;
      if (typeof nested === "string" && isRequestStructureValue(key)) {
        if (sanitizer.redactText(nested) !== nested) identityConflict = true;
        output[key] = nested;
      } else output[key] = projectValue(nested, childPath);
    }
    return output;
  };
  const projectedRequest = requestTemplate === undefined ? undefined : projectValue(requestTemplate, "request") as unknown as ApiRequest;
  const parameters: Record<string, string> = {};
  let parameterConflict = false;
  for (const [key, value] of Object.entries(baseParameters)) {
    const safeKey = sanitizer.redactText(key);
    if (safeKey !== key) {
      identityConflict = true;
      parameterConflict = true;
      continue;
    }
    const safeValue = sanitizer.redactText(value);
    parameters[key] = safeValue;
    if (safeValue !== value) addField(fields, { path: `parameters.${key}`, status: "redacted", needsInput: true });
  }
  if (parameterConflict) addField(fields, { path: "parameters", status: "redacted", needsInput: true });
  if (identityConflict && projectedRequest !== undefined) addField(fields, { path: "request", status: "redacted", needsInput: true });
  const safeFields = [...fields.values()];
  const available = !identityConflict
    && (invocation.mode === "free" ? safeProject !== undefined && safeDraftId !== undefined : safeLocator !== undefined)
    && (invocation.mode !== "case" || safeCase !== undefined)
    && !safeFields.some((field) => field.needsInput);
  if (invocation.mode === "case") {
    return {
      mode: "case",
      sourceKind: "asset",
      ...(safeCase === undefined ? {} : { case: safeCase }),
      ...(identityConflict ? {} : projectedRequest === undefined ? {} : { requestTemplate: projectedRequest }),
      parameters: parameterConflict ? {} : parameters,
      fields: safeFields,
      ...explicitSettings,
      identityAvailable: safeCase !== undefined && safeLocator !== undefined,
      available,
    };
  }
  if (invocation.mode === "free") return {
    mode: "free",
    sourceKind: "free",
    ...(safeProject === undefined ? {} : { project: safeProject }),
    ...(safeDraftId === undefined ? {} : { draftId: safeDraftId }),
    ...(identityConflict ? {} : projectedRequest === undefined ? {} : { requestTemplate: projectedRequest }),
    parameters: parameterConflict ? {} : parameters,
    fields: safeFields,
    ...explicitSettings,
    identityAvailable: safeProject !== undefined && safeDraftId !== undefined,
    available,
  };
  return {
    mode: "request",
    sourceKind: "asset",
    ...(safeLocator === undefined ? {} : { locator: safeLocator }),
    ...(identityConflict ? {} : projectedRequest === undefined ? {} : { requestTemplate: projectedRequest }),
    parameters: parameterConflict ? {} : parameters,
    fields: safeFields,
    ...explicitSettings,
    identityAvailable: safeLocator !== undefined,
    available,
  };
}

function projectScalarIdentity(
  value: string,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  reliable: boolean,
): string | undefined {
  return reliable && sanitizer.redactText(value) === value ? value : undefined;
}

function projectIdentity<T extends object>(
  value: T,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  reliable: boolean,
): T | undefined {
  if (!reliable || identityContainsMarker(value, sanitizer)) return undefined;
  return value;
}

function identityContainsMarker(value: unknown, sanitizer: ReturnType<typeof createCredentialOutputSanitizer>): boolean {
  if (typeof value === "string") return sanitizer.redactText(value) !== value;
  if (Array.isArray(value)) return value.some((item) => identityContainsMarker(item, sanitizer));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, nested]) => sanitizer.redactText(key) !== key || identityContainsMarker(nested, sanitizer));
}

function safeFieldPath(path: string): string {
  return path === "parameters" || path.startsWith("parameters.") ? "parameters" : "request";
}

function projectFinalExchange(
  exchange: DebugExchange,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  markerBytes: readonly Buffer[],
  reliable: boolean,
  lateRequestMarkers: readonly string[],
  lateResponseMarkers: readonly string[],
  summaryBudget: SummaryBudget,
): DebugExchange {
  const safeSource = projectIdentity(exchange.source, sanitizer, reliable);
  const intent = exchange.intent === undefined ? undefined : projectRowIntent(exchange.intent, sanitizer, reliable);
  const requestBodyBudget: SummaryBudget = { remaining: summaryBudget.bodyBytes ?? MAX_BODY_SUMMARY_BYTES };
  const responseBodyBudget: SummaryBudget = { remaining: summaryBudget.bodyBytes ?? MAX_BODY_SUMMARY_BYTES };
  const request = exchange.request === undefined ? undefined : {
    ...exchange.request,
    url: reliable ? sanitizer.redactText(exchange.request.url) : "[REDACTED]",
    method: reliable ? sanitizer.redactText(exchange.request.method) : "[REDACTED]",
    query: exchange.request.query.map((entry) => reliable
      ? { ...entry, key: sanitizer.redactText(entry.key), value: sanitizer.redactText(entry.value) }
      : { ...entry, key: "[REDACTED]", value: "[REDACTED]" }),
    headers: projectFinalPairs(exchange.request.headers, sanitizer, reliable),
    cookies: exchange.request.cookies.map(([name, value]) => reliable
      ? [sanitizer.redactText(name), sanitizer.redactText(value)] as [string, string]
      : ["[REDACTED]", "[REDACTED]"] as [string, string]),
    body: projectFinalRequestBody(exchange.request.body, sanitizer, reliable, lateRequestMarkers, summaryBudget, requestBodyBudget),
  };
  const response = exchange.response === undefined ? undefined : {
    ...exchange.response,
    headers: projectFinalPairs(exchange.response.headers, sanitizer, reliable),
    ...(exchange.response.rawHeaders === undefined ? {} : { rawHeaders: projectFinalPairs(exchange.response.rawHeaders, sanitizer, reliable) }),
    cookies: exchange.response.cookies.map((cookie) => reliable ? sanitizer.redactText(cookie) : "[REDACTED]"),
    ...(exchange.response.contentType === undefined ? {} : { contentType: reliable ? sanitizer.redactText(exchange.response.contentType) : "[REDACTED]" }),
    body: projectFinalResponseBody(exchange.response.body, sanitizer, markerBytes, reliable, lateResponseMarkers, summaryBudget, responseBodyBudget),
  };
  return {
    source: safeSource ?? { sourceKind: "unavailable" },
    identityAvailable: safeSource !== undefined,
    rowIndex: exchange.rowIndex,
    hopIndex: exchange.hopIndex,
    order: exchange.order,
    transportState: exchange.transportState,
    ...(exchange.observation === undefined ? {} : { observation: exchange.observation }),
    settings: exchange.settings,
    ...(request === undefined ? {} : { request }),
    ...(response === undefined ? {} : { response }),
    ...(intent === undefined ? {} : { intent }),
    startedAt: exchange.startedAt,
    ...(exchange.finishedAt === undefined ? {} : { finishedAt: exchange.finishedAt }),
    ...(exchange.durationMs === undefined ? {} : { durationMs: exchange.durationMs }),
    ...(exchange.failureStage === undefined ? {} : { failureStage: reliable ? sanitizer.redactText(exchange.failureStage) : "[REDACTED]" }),
    ...(exchange.failureCode === undefined ? {} : { failureCode: reliable ? sanitizer.redactText(exchange.failureCode) : "[REDACTED]" }),
  };
}

function projectRowIntent(
  intent: NonNullable<DebugExchange["intent"]>,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  reliable: boolean,
): NonNullable<DebugExchange["intent"]> {
  if (!reliable) return {
    parameters: {},
    fields: [{ path: "parameters", status: "redacted", needsInput: true }],
    available: false,
  };
  const parameters: Record<string, string> = {};
  const fields = intent.fields.map((field) => sanitizer.redactText(field.path) === field.path
    ? field
    : { path: safeFieldPath(field.path), status: "redacted" as const, needsInput: true });
  let available = intent.available;
  let parameterConflict = false;
  for (const [key, value] of Object.entries(intent.parameters)) {
    if (sanitizer.redactText(key) !== key) {
      available = false;
      parameterConflict = true;
      continue;
    }
    const safeValue = sanitizer.redactText(value);
    parameters[key] = safeValue;
    if (safeValue !== value) {
      fields.push({ path: `parameters.${key}`, status: "redacted", needsInput: true });
      available = false;
    }
  }
  if (parameterConflict && !fields.some((field) => field.path === "parameters")) {
    fields.push({ path: "parameters", status: "redacted", needsInput: true });
  }
  return { parameters, fields, available: available && !fields.some((field) => field.needsInput) };
}

function projectFinalPairs(
  pairs: readonly (readonly [string, string])[],
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  reliable: boolean,
): Array<[string, string]> {
  return pairs.map(([name, value]) => reliable
    ? [sanitizer.redactText(name), sanitizer.redactText(value)]
    : ["[REDACTED]", "[REDACTED]"]);
}

function projectFinalRequestBody(
  body: DebugRequestBody,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  reliable: boolean,
  lateMarkers: readonly string[],
  summaryBudget: SummaryBudget,
  bodyBudget: SummaryBudget,
): DebugRequestBody {
  if (!reliable) return body.kind === "none" ? body : { kind: "metadata", omittedReason: "unreliable" };
  switch (body.kind) {
    case "none":
    case "metadata": return body;
    case "text": {
      if (body.truncated && lateMarkers.length > 0) return { kind: "metadata", omittedReason: "unreliable" };
      const summary = summarizeText(body.text, sanitizer, summaryBudget, bodyBudget);
      return { ...body, text: summary.text, truncated: body.truncated || summary.truncated };
    }
    case "form": {
      if (body.fields.some((field) => field.truncated) && lateMarkers.length > 0) return { kind: "metadata", omittedReason: "unreliable" };
      return {
        ...body,
        fields: body.fields.map((field) => {
          const key = summarizeText(field.key, sanitizer, summaryBudget, bodyBudget);
          const value = summarizeText(field.value, sanitizer, summaryBudget, bodyBudget);
          return { ...field, key: key.text, value: value.text, truncated: field.truncated || key.truncated || value.truncated };
        }),
      };
    }
    case "multipart": {
      if (body.entries.some((entry) => entry.kind === "text" && entry.truncated) && lateMarkers.length > 0) {
        return { kind: "metadata", omittedReason: "unreliable" };
      }
      return {
        ...body,
        entries: body.entries.map((entry) => entry.kind === "text"
          ? (() => {
              const name = summarizeText(entry.name, sanitizer, summaryBudget, bodyBudget);
              const value = summarizeText(entry.value, sanitizer, summaryBudget, bodyBudget);
              return { ...entry, name: name.text, value: value.text, truncated: entry.truncated || name.truncated || value.truncated };
            })()
          : (() => {
              const { filename, capturedFilename, effectiveFilename, ...file } = entry;
              const finalFilename = filename === undefined ? undefined : summarizeFilename(filename, sanitizer, summaryBudget, bodyBudget);
              const finalCapturedFilename = capturedFilename === undefined ? undefined : summarizeFilename(capturedFilename, sanitizer, summaryBudget, bodyBudget);
              const finalEffectiveFilename = effectiveFilename === undefined ? undefined : summarizeFilename(effectiveFilename, sanitizer, summaryBudget, bodyBudget);
              return {
                ...file,
                name: sanitizer.redactText(entry.name),
                contentType: sanitizer.redactText(entry.contentType),
                ...(finalFilename === undefined ? {} : { filename: finalFilename }),
                ...(finalCapturedFilename === undefined ? {} : { capturedFilename: finalCapturedFilename }),
                ...(finalEffectiveFilename === undefined ? {} : { effectiveFilename: finalEffectiveFilename }),
              };
            })()),
      };
    }
    case "binary": {
      const { capturedFilename, effectiveFilename, ...binary } = body;
      const finalCapturedFilename = capturedFilename === undefined ? undefined : summarizeFilename(capturedFilename, sanitizer, summaryBudget, bodyBudget);
      const finalEffectiveFilename = effectiveFilename === undefined ? undefined : summarizeFilename(effectiveFilename, sanitizer, summaryBudget, bodyBudget);
      return {
        ...binary,
        contentType: sanitizer.redactText(body.contentType),
        ...(finalCapturedFilename === undefined ? {} : { capturedFilename: finalCapturedFilename }),
        ...(finalEffectiveFilename === undefined ? {} : { effectiveFilename: finalEffectiveFilename }),
      };
    }
  }
}

function projectFinalResponseBody(
  body: DebugResponseBody,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  markerBytes: readonly Buffer[],
  reliable: boolean,
  lateMarkers: readonly string[],
  summaryBudget: SummaryBudget,
  bodyBudget: SummaryBudget,
): DebugResponseBody {
  if (!reliable) return { kind: "metadata", ...(body.kind === "metadata" && body.contentBytes !== undefined ? { contentBytes: body.contentBytes } : body.kind !== "metadata" && body.contentBytes !== undefined ? { contentBytes: body.contentBytes } : {}), omittedReason: "unreliable" };
  if (body.kind === "text") {
    if (body.truncated && lateMarkers.length > 0) return { kind: "metadata", contentBytes: body.contentBytes, omittedReason: "unreliable" };
    const summary = summarizeText(body.text, sanitizer, summaryBudget, bodyBudget);
    return { ...body, text: summary.text, truncated: body.truncated || summary.truncated };
  }
  if (body.kind !== "binary" || body.previewHex === undefined) return body;
  let preview: Buffer;
  if (!/^(?:[0-9a-f]{2})*$/i.test(body.previewHex)) return { kind: "metadata", ...(body.contentBytes === undefined ? {} : { contentBytes: body.contentBytes }), omittedReason: "unreliable" };
  preview = Buffer.from(body.previewHex, "hex");
  if (markerBytes.some((marker) => preview.indexOf(marker) !== -1)) {
    return { kind: "binary", contentBytes: body.contentBytes, truncated: body.truncated, omittedReason: "credential-match" };
  }
  if (body.truncated && lateMarkers.length > 0) {
    return { kind: "metadata", ...(body.contentBytes === undefined ? {} : { contentBytes: body.contentBytes }), omittedReason: "unreliable" };
  }
  const allowance = Math.max(0, Math.min(summaryBudget.bodyBytes ?? MAX_BODY_SUMMARY_BYTES, summaryBudget.remaining, bodyBudget.remaining));
  const availableHexLength = Math.min(body.previewHex.length, allowance);
  const previewLength = availableHexLength - (availableHexLength % 2);
  const previewHex = body.previewHex.slice(0, previewLength);
  summaryBudget.remaining -= previewHex.length;
  bodyBudget.remaining -= previewHex.length;
  if (previewLength === body.previewHex.length) return body;
  return {
    kind: "binary",
    ...(body.contentBytes === undefined ? {} : { contentBytes: body.contentBytes }),
    ...(previewHex.length === 0 ? {} : { previewHex }),
    truncated: true,
    ...(previewHex.length === 0 ? { omittedReason: "budget" as const } : {}),
  };
}

function projectLegacyResponse(
  response: ExecutionResponse,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  summaryBudget: SummaryBudget,
  reliable: boolean,
): DebugResponse {
  const entries = Object.entries(response.headers);
  const contentType = findHeader(entries, "content-type");
  const body = reliable
    ? summarizeTextBody(response.bodyText, Buffer.byteLength(response.bodyText, "utf8"), sanitizer, summaryBudget)
    : { kind: "metadata" as const, contentBytes: Buffer.byteLength(response.bodyText, "utf8"), omittedReason: "unreliable" as const };
  return {
    status: response.status,
    headers: entries.map(([name, value]) => [sanitizer.redactText(name), projectResponseHeader(name, value, sanitizer)]),
    cookies: entries.filter(([name]) => name.toLowerCase() === "set-cookie")
      .map(([, value]) => reliable ? projectSetCookie(value, sanitizer) : "[REDACTED]"),
    ...(contentType === undefined ? {} : { contentType: reliable ? sanitizer.redactText(contentType) : "[REDACTED]" }),
    body,
  };
}

function summarizeTextBody(
  raw: string,
  contentBytes: number,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  summaryBudget: SummaryBudget,
): DebugResponseBody {
  const summary = summarizeText(raw, sanitizer, summaryBudget);
  return { kind: "text", text: summary.text, contentBytes, truncated: summary.truncated };
}

function addField(fields: Map<string, DebugFieldState>, next: DebugFieldState): void {
  const current = fields.get(next.path);
  if (!current || current.status === "missing" || next.status === "redacted") fields.set(next.path, next);
}

function isRequestStructureValue(key: string): boolean {
  return ["id", "kind", "protocol", "method", "expectedKind", "componentId", "policy", "name", "key"].includes(key);
}

export function projectRequestHeader(
  name: string,
  value: string,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
): string {
  const normalized = name.toLowerCase();
  if (normalized === "cookie") return projectCookies(value, sanitizer).map(([key, item]) => `${key}=${item}`).join("; ");
  if (normalized === "authorization" || normalized === "proxy-authorization") return "[REDACTED]";
  return sanitizer.redactText(value);
}

export function projectResponseHeader(
  name: string,
  value: string,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
): string {
  const normalized = name.toLowerCase();
  if (["authorization", "proxy-authorization", "cookie"].includes(normalized)) return "[REDACTED]";
  return normalized === "set-cookie" ? projectSetCookie(value, sanitizer) : sanitizer.redactText(value);
}

function projectCookies(
  value: string,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
): Array<[string, string]> {
  return value.split(/;\s*/).filter(Boolean).map((item) => {
    const equals = item.indexOf("=");
    if (equals <= 0) return ["cookie", "[REDACTED]"];
    return [sanitizer.redactText(item.slice(0, equals).trim()), "[REDACTED]"];
  });
}

function projectSetCookie(value: string, sanitizer: ReturnType<typeof createCredentialOutputSanitizer>): string {
  const [cookie, ...attributes] = value.split(";");
  const equals = cookie?.indexOf("=") ?? -1;
  if (equals <= 0) return "[REDACTED]";
  const name = sanitizer.redactText(cookie!.slice(0, equals).trim());
  const safeAttributes = attributes.map((attribute) => sanitizer.redactText(attribute.trim())).filter(Boolean);
  return `${name}=[REDACTED]${safeAttributes.map((attribute) => `; ${attribute}`).join("")}`;
}

function expandMarkerValues(values: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const marker of values) {
    expanded.add(marker);
    expanded.add(encodeURIComponent(marker));
    expanded.add(Buffer.from(marker, "utf8").toString("base64"));
  }
  return [...expanded].filter(Boolean);
}

function findHeader(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  return headers.find(([header]) => header.toLowerCase() === name)?.[1];
}

function summarizeText(
  raw: string,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  budget: SummaryBudget,
  bodyBudget?: SummaryBudget,
): { text: string; truncated: boolean } {
  const safe = sanitizer.redactText(raw);
  const safeBytes = Buffer.byteLength(safe, "utf8");
  const allowance = Math.max(0, Math.min(budget.bodyBytes ?? MAX_BODY_SUMMARY_BYTES, budget.remaining, bodyBudget?.remaining ?? Number.POSITIVE_INFINITY));
  if (safeBytes <= allowance) {
    budget.remaining -= safeBytes;
    if (bodyBudget) bodyBudget.remaining -= safeBytes;
    return { text: safe, truncated: false };
  }
  let text = "";
  let used = 0;
  for (const character of safe) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > allowance) break;
    text += character;
    used += bytes;
  }
  budget.remaining -= used;
  if (bodyBudget) bodyBudget.remaining -= used;
  return { text, truncated: true };
}

function summarizeFilename(
  raw: string,
  sanitizer: ReturnType<typeof createCredentialOutputSanitizer>,
  budget: SummaryBudget,
  bodyBudget: SummaryBudget,
): string | undefined {
  const summary = summarizeText(raw, sanitizer, budget, bodyBudget);
  return summary.truncated ? undefined : summary.text;
}

function firstFailureKind(outcomes: DebugResult["outcomes"]): Pick<DebugResult, "failureKind"> | undefined {
  const failureKind = outcomes.find((outcome) => outcome.failureKind)?.failureKind;
  return failureKind === undefined ? undefined : { failureKind };
}
