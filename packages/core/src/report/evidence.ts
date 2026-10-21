import { Buffer } from "node:buffer";
import { createCredentialOutputSanitizer, type CredentialOutputSanitizer } from "../credentials/output.js";
import { projectRequestHeader, projectResponseHeader } from "../debug/projection.js";
import type { CaseExecutionResult } from "../runner/caseExecutor.js";
import type { CaseOutcome, EvidenceIdentity, EvidencePreview, RunResult, SafeExecutionEvidence } from "./types.js";
import { reportingUnits } from "./units.js";
import { workflowToRunResult } from "../workflow/adapter.js";
import type { WorkflowRunResult } from "../workflow/runner.js";
import type { StressReport, StressSafetyTarget } from "../stress/model.js";
import { StressReportSchema } from "../stress/model.js";

export type EvidenceOutputBoundary = CredentialOutputSanitizer & { businessUnavailable?: boolean };
/** Run-private marker messages share the existing report byte ceiling; never include their values in errors. */
export const PRIVATE_EVIDENCE_BYTES = 16 * 1024 * 1024;
export function privateEvidenceMarkers(input: unknown): string[] {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string") || Buffer.byteLength(JSON.stringify(input)) > PRIVATE_EVIDENCE_BYTES) throw new Error("Private evidence marker message invalid or exceeds capacity");
  return input;
}
export interface EvidenceBudget { bodyBytes: number; valueBytes: number; caseBytes: number; reportBytes: number; remaining: number }
export function createEvidenceBudget(limits: Partial<Omit<EvidenceBudget, "remaining">> = {}): EvidenceBudget {
  const budget = { bodyBytes: 64 * 1024, valueBytes: 4 * 1024, caseBytes: 256 * 1024, reportBytes: 16 * 1024 * 1024, ...limits };
  return { ...budget, remaining: budget.reportBytes };
}
export interface ExecutionEvidenceInput { execution: CaseExecutionResult; identity: EvidenceIdentity; mode?: "none" | "failures" | "all" }
function identityDto(input: EvidenceIdentity): EvidenceIdentity {
  const { projectId, definitionRevision, suiteRunId, entryId, suiteRow, rowIndex, nodeId, workflowId, environmentId, dataDigest, datasetId } = input;
  const locator = input.locator && { collectionId: input.locator.collectionId, folderIds: [...input.locator.folderIds], apiId: input.locator.apiId, caseId: input.locator.caseId, scope: input.locator.scope };
  return { projectId, definitionRevision, suiteRunId, entryId, suiteRow, rowIndex, nodeId, workflowId, environmentId, dataDigest, datasetId, locator };
}
function diagnosticText(value: string, boundary: EvidenceOutputBoundary, budget: EvidenceBudget): string {
  const safe = boundary.redactText(value);
  const allowance = Math.max(0, Math.min(budget.valueBytes - 24, budget.remaining - 128));
  let text = ""; let used = 0;
  for (const char of safe) { const size = Buffer.byteLength(JSON.stringify(char)) - 2; if (used + size > allowance) break; text += char; used += size; }
  budget.remaining = Math.max(0, budget.remaining - used - 128);
  return text.length < safe.length ? text + " [truncated/omitted]" : text;
}
function expandMarkers(values: readonly string[]): string[] {
  return values.flatMap((value) => { let encoded = value; try { encoded = encodeURIComponent(value); } catch { /* retain the complete original marker */ }
    return [value, encoded, Buffer.from(value).toString("base64"), JSON.stringify(value).slice(1, -1)]; });
}
const UNRELIABLE_COOKIE_TEXT = "[omitted: unavailable Set-Cookie boundaries]";
function unreliableResponseCookies(execution: CaseExecutionResult): boolean {
  return Object.keys(execution.response?.headers ?? {}).some((name) => name.toLowerCase() === "set-cookie")
    && !execution.response?.rawHeaders?.some(([name]) => name.toLowerCase() === "set-cookie");
}
function executionMarkers(execution: CaseExecutionResult): string[] {
  const values = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string") { if (value) values.add(value); }
    else if (value && typeof value === "object") {
      values.add(JSON.stringify(value));
      if (Array.isArray(value)) for (const nested of value) add(nested);
      else for (const [key, nested] of Object.entries(value)) { add(key); add(nested); }
    }
    else if (value !== undefined && value !== null) values.add(String(value));
  };
  for (const extraction of execution.extractionOutcomes ?? []) if (extraction.sensitive) add(extraction.value);
  const auth = execution.request.auth;
  if (auth.kind === "bearer") { add(auth.token); add(`Bearer ${auth.token}`); }
  if (auth.kind === "basic") { add(auth.password); add(`Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`); }
  if (auth.kind === "apikey") add(auth.value);
  for (const [key, value] of Object.entries(execution.request.headers)) if (["authorization", "proxy-authorization", "cookie"].includes(key.toLowerCase())) {
    add(value); if (key.toLowerCase() === "cookie") for (const item of value.split(";")) add(item.slice(item.indexOf("=") + 1).trim());
  }
  // Only raw pairs preserve duplicate Set-Cookie boundaries (Expires itself contains commas).
  for (const [key, value] of execution.response?.rawHeaders ?? Object.entries(execution.response?.headers ?? {})) {
    const normalized = key.toLowerCase();
    if (["authorization", "proxy-authorization", "cookie", "set-cookie"].includes(normalized)) add(value);
    if (normalized === "cookie") for (const item of value.split(";")) add(item.slice(item.indexOf("=") + 1).trim());
    if (normalized === "set-cookie" && !unreliableResponseCookies(execution)) add(value.split(";")[0]?.split("=").slice(1).join("="));
  }
  return [...values];
}

/** Complete raw values are sanitized before any byte limit is applied. Host-only entry point. */
export function projectExecutionEvidence(input: ExecutionEvidenceInput, boundary: EvidenceOutputBoundary, budget: EvidenceBudget): SafeExecutionEvidence {
  const { execution: raw } = input;
  const cookiesUnavailable = unreliableResponseCookies(raw) || boundary.businessUnavailable === true;
  const local = createCredentialOutputSanitizer(expandMarkers(executionMarkers(raw))); const outer = boundary;
  boundary = { redactText: (value) => local.redactText(outer.redactText(value)), redactValue: <T>(value: T): T => local.redactValue(outer.redactValue(value)) };
  const identity = identityDto({ ...input.identity, ...(raw.outcome.locator ? { locator: raw.outcome.locator } : {}) });
  const result: SafeExecutionEvidence = { identity, state: "not-collected", scriptDiagnostics: "not-collected", truncated: false };
  if (input.mode === "none" || ((input.mode ?? "failures") === "failures" && raw.outcome.passed)) return result;
  if (budget.remaining < 512) return { ...result, state: "omitted", truncated: true };
  budget.remaining -= 512;
  let remaining = Math.max(0, budget.caseBytes - 512);
  // Charge framing/field names conservatively as well as every preview's UTF-8 bytes.
  const preview = (value: unknown, limit = budget.valueBytes, business = true): EvidencePreview => {
    const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "unavailable";
    const omittedBusiness = cookiesUnavailable && business;
    const safe = omittedBusiness ? UNRELIABLE_COOKIE_TEXT : business ? boundary.redactText(serialized) : serialized;
    const allowance = Math.max(0, Math.min(limit, remaining - 128, budget.remaining - 128));
    let text = ""; let bytes = 0; let contentBytes = 0;
    for (const char of safe) { const size = Buffer.byteLength(JSON.stringify(char)) - 2; const contentSize = Buffer.byteLength(char); if (bytes + size > allowance || contentBytes + contentSize > limit) break; text += char; bytes += size; contentBytes += contentSize; }
    const charge = Math.min(Math.min(remaining, budget.remaining), bytes + 128);
    remaining -= charge; budget.remaining -= charge;
    const truncated = text.length !== safe.length;
    if (truncated) result.truncated = true;
    return { text, truncated, ...(omittedBusiness || allowance === 0 ? { omitted: true } : {}) };
  };
  result.state = "collected";
  result.timings = { requestMs: raw.requestTimeMs, scriptMs: raw.scriptTimeMs, iterationMs: raw.iterationTimeMs };
  const request = raw.request;
  const body = request.protocol === "soap" ? request.envelope : request.protocol === "websocket" ? request.message : request.body;
  const requestBody = typeof body === "string" ? body : body && "content" in body ? body.content
    : body === undefined ? "" : undefined;
  result.request = { protocol: request.protocol, ...("method" in request ? { method: request.method } : {}), url: preview(request.url + (request.query.length ? ` query=${JSON.stringify(request.query)}` : "")),
    headers: preview(Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [boundary.redactText(name), projectRequestHeader(name, value, boundary)]))),
    body: requestBody === undefined ? { text: "unavailable", truncated: false, omitted: true } : preview(requestBody, budget.bodyBytes) };
  if (raw.response) {
    const headers: { [name: string]: string | string[] } = Object.fromEntries(Object.entries(raw.response.headers).filter(([name]) => name.toLowerCase() !== "set-cookie")
      .map(([name, value]) => [boundary.redactText(name), projectResponseHeader(name, value, boundary)]));
    const cookies = raw.response.rawHeaders?.filter(([name]) => name.toLowerCase() === "set-cookie");
    if (cookies?.length) headers["set-cookie"] = cookies.map(([name, value]) => projectResponseHeader(name, value, boundary));
    result.response = { status: raw.response.status, headers: preview(headers),
      body: raw.response.textAvailable === false ? { text: "unavailable", truncated: false, omitted: true } : preview(raw.response.bodyText, budget.bodyBytes) };
    if (raw.response.textAvailable === false || cookiesUnavailable) result.bodyUnavailable = true;
  }
  else result.bodyUnavailable = true;
  // Public selector enums are protocol metadata; all dynamic selector strings (including
  // namespace prefixes) are business content even when the surrounding preview is typed.
  const selectorText = (value: string) => cookiesUnavailable ? UNRELIABLE_COOKIE_TEXT : boundary.redactText(value);
  const selectorPreview = (selector: NonNullable<CaseExecutionResult["assertionOutcomes"]>[number]["selector"]) => preview({ target: selector.target, match: selector.match,
    ...(selector.path === undefined ? {} : { path: selectorText(selector.path) }), ...(selector.headerName === undefined ? {} : { headerName: selectorText(selector.headerName) }),
    ...(selector.cookieName === undefined ? {} : { cookieName: selectorText(selector.cookieName) }),
    ...(selector.namespaces === undefined ? {} : { namespaces: Object.fromEntries(Object.entries(selector.namespaces).map(([prefix, uri]) => [selectorText(prefix), selectorText(uri)])) }) }, budget.valueBytes, false);
  result.assertions = raw.assertionOutcomes?.flatMap((assertion) => remaining <= 1024 || budget.remaining <= 1024 ? (result.truncated = true, []) : [{ id: preview(assertion.id, budget.valueBytes, false), op: preview(assertion.op, budget.valueBytes, false), selector: selectorPreview(assertion.selector), code: preview(assertion.code, budget.valueBytes, false), pass: assertion.pass,
    message: preview(assertion.message), ...(assertion.actual === undefined ? {} : { actual: preview(assertion.actual) }), ...(assertion.expected === undefined ? {} : { expected: preview(assertion.expected) }),
    ...(assertion.differencePath === undefined ? {} : { differencePath: preview(assertion.differencePath) }), ...(assertion.schemaPath === undefined ? {} : { schemaPath: preview(assertion.schemaPath) }) }]);
  result.extractions = raw.extractionOutcomes?.flatMap((extraction) => remaining <= 1024 || budget.remaining <= 1024 ? (result.truncated = true, []) : [{ id: preview(extraction.id, budget.valueBytes, false), name: preview(extraction.name), selector: selectorPreview(extraction.selector), status: extraction.status, code: preview(extraction.code, budget.valueBytes, false),
    published: extraction.published, sensitive: extraction.sensitive, message: preview(extraction.message), ...(extraction.value === undefined ? {} : { value: preview(extraction.sensitive ? "[REDACTED]" : extraction.value) }) }]);
  result.scriptDiagnostics = raw.outcome.assertions.length ? "existing-assertions-only" : "not-collected";
  return result;
}

/** Typed execution protocols are copied by origin; only business fields use the generic sanitizer. */
function redactCaseOutput(raw: CaseOutcome, boundary: EvidenceOutputBoundary): CaseOutcome {
  return { apiId: raw.apiId, caseId: raw.caseId, scope: raw.scope, locator: raw.locator && structuredClone(raw.locator), row: raw.row, nodeId: raw.nodeId, entryId: raw.entryId, suiteRow: raw.suiteRow,
    apiName: boundary.redactText(raw.apiName), caseName: boundary.redactText(raw.caseName), passed: raw.passed, skipped: raw.skipped, skipReason: raw.skipReason, durationMs: raw.durationMs, failureKind: raw.failureKind,
    error: raw.error === undefined ? undefined : boundary.redactText(raw.error),
    assertions: raw.assertions.map((item) => ({ pass: item.pass, kind: item.kind, code: item.code, message: boundary.redactText(item.message),
      differencePath: item.differencePath === undefined ? undefined : boundary.redactText(item.differencePath), schemaPath: item.schemaPath === undefined ? undefined : boundary.redactText(item.schemaPath) })),
    ...(raw.evidence === undefined ? {} : { evidence: structuredClone(raw.evidence) }) };
}
function redactRunOutput(raw: RunResult, boundary: EvidenceOutputBoundary): RunResult {
  return { collectionId: raw.collectionId, collectionName: boundary.redactText(raw.collectionName), envName: raw.envName === undefined ? undefined : boundary.redactText(raw.envName),
    kind: raw.kind, projectId: raw.projectId, definitionRevision: raw.definitionRevision, workflowId: raw.workflowId, startedAt: raw.startedAt, finishedAt: raw.finishedAt,
    total: raw.total, passed: raw.passed, failed: raw.failed, skipped: raw.skipped, evidenceOmitted: raw.evidenceOmitted, reportFailure: raw.reportFailure,
    executionIdentity: raw.executionIdentity && identityDto(raw.executionIdentity), reportingUnits: raw.reportingUnits && { ...raw.reportingUnits },
    cases: raw.cases.map((item) => redactCaseOutput(item, boundary)), warnings: raw.warnings?.map((item) => boundary.redactText(item)),
    suite: raw.suite && { ...structuredClone(raw.suite), entries: raw.suite.entries?.map((entry) => ({ ...structuredClone(entry), error: entry.error === undefined ? undefined : boundary.redactText(entry.error) })) },
    workflow: raw.workflow && { ...structuredClone(raw.workflow), entries: raw.workflow.entries.map((entry) => ({ ...structuredClone(entry), label: entry.label === undefined ? undefined : boundary.redactText(entry.label), error: entry.error === undefined ? undefined : boundary.redactText(entry.error) })) } };
}
function redactWorkflowOutput(raw: WorkflowRunResult, boundary: EvidenceOutputBoundary): WorkflowRunResult {
  return { workflowId: raw.workflowId, workflowName: boundary.redactText(raw.workflowName), status: raw.status, total: raw.total, passed: raw.passed, failed: raw.failed, skipped: raw.skipped, verdict: raw.verdict,
    startedAt: raw.startedAt, finishedAt: raw.finishedAt, warnings: raw.warnings.map((item) => boundary.redactText(item)), report: raw.report && redactRunOutput(raw.report, boundary),
    nodeResults: raw.nodeResults.map((node) => ({ nodeId: node.nodeId, kind: node.kind, state: node.state, skipReason: node.skipReason, failureKind: node.failureKind,
      label: node.label === undefined ? undefined : boundary.redactText(node.label), error: node.error === undefined ? undefined : boundary.redactText(node.error),
      outcomes: node.outcomes?.map((item) => redactCaseOutput(item, boundary)), outcome: node.outcome && redactCaseOutput(node.outcome, boundary) })) };
}
function redactSafetyTarget<T extends { origin: string; appliedPolicy?: { trustedOrigins?: readonly string[]; deniedOrigins?: readonly string[] } }>(raw: T, boundary: EvidenceOutputBoundary): T {
  return { ...structuredClone(raw), origin: boundary.redactText(raw.origin), appliedPolicy: raw.appliedPolicy && { ...structuredClone(raw.appliedPolicy),
    trustedOrigins: raw.appliedPolicy.trustedOrigins?.map((origin) => boundary.redactText(origin)), deniedOrigins: raw.appliedPolicy.deniedOrigins?.map((origin) => boundary.redactText(origin)) } };
}
function redactStressOutput(raw: StressReport, boundary: EvidenceOutputBoundary, budget = createEvidenceBudget(), evidenceCharged = false): StressReport {
  // The strict existing schema supplies this protocol allowlist; all other report fields are numeric/enum/identity.
  const safe = StressReportSchema.parse(raw) as StressReport;
  if (!evidenceCharged) budget.remaining = Math.max(0, budget.remaining - Buffer.byteLength(JSON.stringify(safe.failureEvidence ?? [])));
  const text = (value: string) => budget.remaining < 128 ? "[omitted diagnostics: budget exhausted]" : diagnosticText(value, boundary, budget);
  const collection = (items: readonly string[] | undefined): string[] | undefined => {
    if (!items) return undefined;
    const projected: string[] = [];
    for (const value of items) { if (budget.remaining < 128) break; projected.push(text(value)); }
    if (projected.length < items.length) {
      const omitted = `[omitted diagnostics: ${items.length - projected.length} values; budget exhausted]`;
      projected.push(omitted); budget.remaining = Math.max(0, budget.remaining - Buffer.byteLength(omitted) - 2);
    }
    return projected;
  };
  safe.errorKinds = {};
  for (const [error, count] of Object.entries(raw.errorKinds)) {
    const key = text(error);
    Object.defineProperty(safe.errorKinds, key, { value: (Object.hasOwn(safe.errorKinds, key) ? safe.errorKinds[key]! : 0) + count, enumerable: true, configurable: true, writable: true });
  }
  if (safe.verdict) safe.verdict.violations = safe.verdict.violations.map((item, index) => ({ ...item, message: text(raw.verdict!.violations[index]!.message) }));
  const redactGenerator = (generator: NonNullable<StressReport["generator"]>) => ({ ...generator, unavailableReason: generator.unavailableReason === undefined ? undefined : text(generator.unavailableReason) });
  const redactSafety = (safety: NonNullable<StressReport["safety"]>) => ({ ...safety, unavailableReason: safety.unavailableReason === undefined ? undefined : text(safety.unavailableReason), targetOrigins: safety.targetOrigins.map((target) => ({ ...target,
    origin: text(target.origin), appliedPolicy: target.appliedPolicy && { ...target.appliedPolicy, trustedOrigins: collection(target.appliedPolicy.trustedOrigins), deniedOrigins: collection(target.appliedPolicy.deniedOrigins) } })) });
  if (safe.generator) safe.generator = redactGenerator(safe.generator);
  if (safe.safety) safe.safety = redactSafety(safe.safety);
  if (safe.distributed) safe.distributed = { ...safe.distributed, perShard: safe.distributed.perShard.map((shard) => ({ ...shard, generator: redactGenerator(shard.generator), safety: shard.safety && redactSafety(shard.safety) })),
    shardErrors: safe.distributed.shardErrors?.map((shard) => ({ ...shard, error: text(shard.error) })) };
  if (Buffer.byteLength(JSON.stringify(safe)) > budget.reportBytes) throw new Error("Merged evidence report exceeds capacity");
  return safe;
}

/** Final host persistence/IPC/worker boundary, preserving fixed keys and already projected evidence. */
export function redactExecutionOutput<T>(value: T, boundary: EvidenceOutputBoundary): T {
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    if (Array.isArray(raw.cases) && typeof raw.collectionId === "string") return redactRunOutput(value as unknown as RunResult, boundary) as T;
    if (Array.isArray(raw.nodeResults) && typeof raw.workflowId === "string") return redactWorkflowOutput(value as unknown as WorkflowRunResult, boundary) as T;
    if (typeof raw.totalRequests === "number" && typeof raw.concurrency === "number") return redactStressOutput(value as unknown as StressReport, boundary) as T;
    if (raw.protocolVersion === 2 && typeof raw.shardId === "string") {
      if (raw.ok === false) return { protocolVersion: 2, shardId: raw.shardId, ok: false, error: boundary.redactText(String(raw.error)) } as T;
      if (Array.isArray(raw.samples)) {
        const samples = raw.samples.map((sample) => redactExecutionOutput(sample, boundary));
        const generator = raw.generator as NonNullable<StressReport["generator"]>;
        return { protocolVersion: 2, ok: true, shardId: raw.shardId, samples, generator: { ...structuredClone(generator), unavailableReason: generator.unavailableReason === undefined ? undefined : boundary.redactText(generator.unavailableReason) }, measurementWindow: structuredClone(raw.measurementWindow), failureEvidence: structuredClone(raw.failureEvidence) } as T;
      }
    }
    if (typeof raw.status === "number" && typeof raw.ok === "boolean") {
      const metadata = Object.fromEntries(["timeMs", "requestTimeMs", "scriptTimeMs", "iterationTimeMs", "requestStarted", "requestCompleted", "status", "ok", "failureKind"].filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]));
      return { ...metadata, error: raw.error === undefined ? undefined : boundary.redactText(String(raw.error)),
        ...(raw.outcome === undefined ? {} : { outcome: redactCaseOutput(raw.outcome as CaseOutcome, boundary) }), ...(raw.safety === undefined ? {} : { safety: redactSafetyTarget(raw.safety as StressSafetyTarget, boundary) }) } as T;
    }
  }
  return boundary.redactValue(value);
}

/** Raw observations live only until the host finalizes output. No marker values enter the returned DTO. */
export function createExecutionEvidenceCollector(base: EvidenceIdentity, markers: readonly string[], options: { mode?: ExecutionEvidenceInput["mode"]; maxSamples?: number; privateMarkers?: boolean } = {}) {
  const sensitive = new Set<string>(); let markerBytes = 2; let markerFailure: string | undefined; let cookiesUnavailable = false;
  const assertMarkersComplete = () => { if (markerFailure) throw new Error(`Private evidence markers incomplete: ${markerFailure}`); };
  const addMarkers = (values: readonly string[]) => {
    assertMarkersComplete();
    for (const value of values) if (value && !sensitive.has(value)) {
      markerBytes += Buffer.byteLength(JSON.stringify(value)) + 1;
      if (options.privateMarkers && markerBytes > PRIVATE_EVIDENCE_BYTES) { markerFailure = "capacity exceeded"; sensitive.clear(); assertMarkersComplete(); }
      sensitive.add(value);
    }
  };
  addMarkers(markers);
  type Record = { execution: CaseExecutionResult; identity: EvidenceIdentity };
  const records: Record[] = [];
  const byIdentity = new Map<string, Record[]>();
  const identityFor = (outcome: CaseOutcome, context: Partial<EvidenceIdentity> = {}): EvidenceIdentity => identityDto({ ...base, ...context,
    locator: outcome.locator ?? context.locator ?? base.locator, rowIndex: outcome.row ?? context.rowIndex ?? base.rowIndex,
    nodeId: outcome.nodeId ?? context.nodeId ?? base.nodeId, entryId: outcome.entryId ?? context.entryId ?? base.entryId, suiteRow: outcome.suiteRow ?? context.suiteRow ?? base.suiteRow });
  const keyFor = (outcome: CaseOutcome, identity: EvidenceIdentity): string => JSON.stringify([
    identity.locator && [identity.locator.collectionId, identity.locator.folderIds, identity.locator.apiId, identity.locator.caseId, identity.locator.scope],
    outcome.apiId, outcome.caseId, outcome.scope ?? identity.locator?.scope, identity.entryId, identity.suiteRow, outcome.row, identity.rowIndex ?? 0, identity.nodeId,
  ]);
  const boundary = (): EvidenceOutputBoundary => {
    assertMarkersComplete(); const safe = createCredentialOutputSanitizer(expandMarkers([...sensitive]));
    // Unknown Cookie boundaries cannot yield a complete marker set. Preserve protocol/identity,
    // but explicitly omit business text rather than guessing or returning unsafe partial details.
    return cookiesUnavailable ? { ...safe, businessUnavailable: true, redactText: (value: string) => value ? UNRELIABLE_COOKIE_TEXT : value } : safe;
  };
  const observe = (execution: CaseExecutionResult, context: Partial<EvidenceIdentity> = {}): void => {
    if (unreliableResponseCookies(execution)) {
      cookiesUnavailable = true;
      if (options.privateMarkers) { markerFailure = "unavailable Set-Cookie boundaries"; sensitive.clear(); assertMarkersComplete(); }
    }
    addMarkers(executionMarkers(execution));
    if (options.maxSamples !== undefined && (execution.outcome.passed || records.length >= options.maxSamples)) return;
    const record = { execution, identity: identityFor(execution.outcome, context) };
    records.push(record);
    const key = keyFor(execution.outcome, record.identity); const bucket = byIdentity.get(key);
    if (bucket) bucket.push(record); else byIdentity.set(key, [record]);
  };
  function projectRun(raw: RunResult, limits: Partial<Omit<EvidenceBudget, "remaining">> = {}): RunResult {
    const sanitizer = boundary(); const budget = createEvidenceBudget(limits);
    let activeBudget = budget;
    const safe = redactRunOutput(raw, sanitizer);
    const cursors = new Map<string, number>();
    const suiteEntries = new Map(raw.suite?.entries?.map((entry) => [JSON.stringify([entry.entryId, entry.suiteRow]), entry]));
    // Legacy messages and script diagnostics consume the same report budget as evidence.
    const text = (value: string): string => diagnosticText(value, sanitizer, activeBudget);
    safe.projectId = base.projectId; safe.definitionRevision = base.definitionRevision;
    safe.executionIdentity = identityDto(base);
    safe.kind = raw.suite ? "suite" : raw.workflowId ? "workflow" : raw.kind ?? "collection";
    safe.warnings = raw.warnings?.flatMap((warning) => budget.remaining < 128 ? (safe.evidenceOmitted = true, []) : [text(warning)]);
    if (safe.suite?.entries) safe.suite.entries = safe.suite.entries.map((entry) => ({ ...entry, error: entry.error === undefined ? undefined : budget.remaining < 128 ? (safe.evidenceOmitted = true, undefined) : text(entry.error) }));
    if (safe.workflow) safe.workflow.entries = safe.workflow.entries.map((entry) => ({ ...entry, suiteRow: entry.suiteRow ?? base.suiteRow, error: entry.error === undefined ? undefined : budget.remaining < 128 ? (safe.evidenceOmitted = true, undefined) : text(entry.error),
      ...(entry.skipReason === undefined ? {} : { skipReason: entry.skipReason }) }));
    safe.cases = raw.cases.map((outcome) => {
      const allowance = Math.min(budget.caseBytes, budget.remaining); const rowBudget = { ...budget, remaining: allowance };
      activeBudget = rowBudget;
      const identity = identityFor(outcome); const key = keyFor(outcome, identity); const cursor = cursors.get(key) ?? 0;
      const matching = byIdentity.get(key)?.[cursor]; cursors.set(key, cursor + 1);
      const projected = redactCaseOutput(outcome, sanitizer);
      projected.entryId = identity.entryId; projected.suiteRow = identity.suiteRow; projected.nodeId = identity.nodeId;
      projected.error = outcome.error === undefined || rowBudget.remaining < 128 ? undefined : text(outcome.error);
      projected.skipReason = outcome.skipReason;
      projected.assertions = outcome.assertions.flatMap((assertion) => rowBudget.remaining < 128 ? [] : [{ pass: assertion.pass, message: text(assertion.message),
        ...(assertion.kind === undefined ? {} : { kind: assertion.kind }), ...(assertion.code === undefined ? {} : { code: assertion.code }),
        ...(assertion.differencePath === undefined ? {} : { differencePath: text(assertion.differencePath) }), ...(assertion.schemaPath === undefined ? {} : { schemaPath: text(assertion.schemaPath) }) }]);
      projected.evidence = matching ? projectExecutionEvidence({ ...matching, mode: options.mode }, sanitizer, rowBudget)
        : { identity: identityDto({ ...identity, workflowId: suiteEntries.get(JSON.stringify([identity.entryId, identity.suiteRow]))?.workflowId ?? identity.workflowId }), state: "not-collected", scriptDiagnostics: "not-collected", bodyUnavailable: true, truncated: false };
      if (projected.assertions.length !== outcome.assertions.length) projected.evidence.truncated = true;
      budget.remaining = Math.max(0, budget.remaining - (allowance - rowBudget.remaining)); activeBudget = budget;
      return projected;
    });
    safe.reportingUnits = reportingUnits(safe).summary;
    return safe;
  }
  function projectWorkflow(raw: WorkflowRunResult): WorkflowRunResult {
    // The legacy singular outcome aliases the first row in IPC. Reserve both copies.
    const report = projectRun(workflowToRunResult(raw), { caseBytes: 128 * 1024, reportBytes: 8 * 1024 * 1024 });
    const safe = redactWorkflowOutput(raw, boundary());
    safe.warnings = report.warnings ?? [];
    safe.report = report;
    const entries = new Map(report.workflow?.entries.map((entry) => [entry.entryId, entry]));
    const rows = new Map<string, CaseOutcome[]>();
    for (const item of report.cases) if (item.nodeId !== undefined) { const group = rows.get(item.nodeId); if (group) group.push(item); else rows.set(item.nodeId, [item]); }
    safe.nodeResults = safe.nodeResults.map((node) => ({ ...node,
      error: entries.get(node.nodeId)?.error,
      outcomes: rows.get(node.nodeId) ?? [],
      outcome: rows.get(node.nodeId)?.[0],
    }));
    return safe;
  }
  function projectStressReport(raw: StressReport, retainedEvidence = false): StressReport {
    const budget = createEvidenceBudget(); const sanitizer = boundary();
    const failureEvidence = retainedEvidence ? raw.failureEvidence : records.map((record) => projectExecutionEvidence({ ...record, mode: "all" }, sanitizer, budget));
    if (retainedEvidence) budget.remaining = Math.max(0, budget.remaining - Buffer.byteLength(JSON.stringify(failureEvidence ?? [])));
    return redactStressOutput({ ...raw, failureEvidence }, sanitizer, budget, true);
  }
  return { observe, addMarkers, projectRun, projectWorkflow, projectStressReport, boundary,
    markers: () => { assertMarkersComplete(); if (cookiesUnavailable) throw new Error("Evidence marker set unavailable: Set-Cookie boundaries unavailable"); return [...sensitive]; },
    projectSamples: () => { const budget = createEvidenceBudget(); const safe = boundary(); return records.map((record) => projectExecutionEvidence({ ...record, mode: "all" }, safe, budget)); } };
}
