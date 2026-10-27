import { Buffer } from "node:buffer";
import { createCredentialOutputSanitizer, type CredentialOutputSanitizer } from "../credentials/output.js";
import { projectRequestHeader, projectResponseHeader } from "../debug/projection.js";
import type { CaseExecutionResult } from "../runner/caseExecutor.js";
import type { CaseOutcome, EvidenceIdentity, EvidencePreview, RunResult, SafeExecutionEvidence } from "./types.js";
import { reportingUnits } from "./units.js";
import { workflowToRunResult } from "../workflow/adapter.js";
import type { WorkflowRunResult } from "../workflow/runner.js";
import type { StressReport, StressSafetyTarget } from "../stress/model.js";
import { StressReportSchema, STRESS_FAILURE_KINDS } from "../stress/model.js";
import { StressReportV2Schema, type StressReportV2 } from "../stress/reportV2.js";

export type EvidenceOutputBoundary = CredentialOutputSanitizer & { businessUnavailable?: boolean };
/** Run-private marker messages share the existing report byte ceiling; never include their values in errors. */
export const PRIVATE_EVIDENCE_BYTES = 16 * 1024 * 1024;
export function privateEvidenceMarkers(input: unknown): string[] {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string") || Buffer.byteLength(JSON.stringify(input)) > PRIVATE_EVIDENCE_BYTES) throw new Error("Private evidence marker message invalid or exceeds capacity");
  return input;
}
export interface EvidenceBudget { bodyBytes: number; valueBytes: number; caseBytes: number; reportBytes: number; remaining: number }
export type EvidenceLimits = Partial<Omit<EvidenceBudget, "remaining">> & { workflowMetadataBytes?: number };
export function createEvidenceBudget(limits: Partial<Omit<EvidenceBudget, "remaining">> = {}): EvidenceBudget {
  const budget = { bodyBytes: 64 * 1024, valueBytes: 4 * 1024, caseBytes: 256 * 1024, reportBytes: 16 * 1024 * 1024, ...limits };
  for (const value of Object.values(budget)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid evidence budget");
  return { ...budget, remaining: budget.reportBytes };
}
export interface ExecutionEvidenceInput { execution: CaseExecutionResult; identity: EvidenceIdentity; mode?: "none" | "failures" | "all" }
function identityDto(input: EvidenceIdentity): EvidenceIdentity {
  const { projectId, definitionRevision, suiteRunId, entryId, suiteRow, rowIndex, nodeId, workflowId, environmentId, dataDigest, datasetId, stressRunId, vuId, iterationId, stageId } = input;
  const locator = input.locator && { collectionId: input.locator.collectionId, folderIds: [...input.locator.folderIds], apiId: input.locator.apiId, caseId: input.locator.caseId, scope: input.locator.scope };
  return { projectId, definitionRevision, suiteRunId, entryId, suiteRow, rowIndex, nodeId, workflowId, environmentId, dataDigest, datasetId, stressRunId, vuId, iterationId, stageId, locator, ...workflowIdentityDto(input) };
}
function workflowIdentityDto(input: Partial<import("../workflow/trace.js").WorkflowNodeIdentity>) {
  return { invocationId: input.invocationId, parentInvocationId: input.parentInvocationId, nodeVisitId: input.nodeVisitId, attempt: input.attempt,
    invocationPath: input.invocationPath?.map(({ workflowId, nodeId, branchId, iteration, handler }) => ({ workflowId, nodeId, branchId, iteration, handler })) };
}
function traceEventDto(event: import("../workflow/trace.js").WorkflowTraceEvent, text: (value: string) => string): import("../workflow/trace.js").WorkflowTraceEvent {
  const child = event.childInvocation;
  return { ...workflowIdentityDto(event), type: event.type, nodeId: event.nodeId, branchId: event.branchId, iteration: event.iteration,
    entryId: event.entryId, suiteRow: event.suiteRow, state: event.state, cause: event.cause, code: event.code, failureKind: event.failureKind, delayMs: event.delayMs,
    message: event.message === undefined ? undefined : text(event.message),
    childInvocation: child && { invocationId: child.invocationId, parentInvocationId: child.parentInvocationId, invocationPath: workflowIdentityDto(child).invocationPath! } };
}
function diagnosticText(value: string, boundary: EvidenceOutputBoundary, budget: EvidenceBudget): string {
  return boundedSafeText(boundary.redactText(value), budget);
}
function boundedSafeText(safe: string, budget: EvidenceBudget): string {
  const allowance = Math.max(0, Math.min(budget.valueBytes, budget.remaining - 128));
  const fullBytes = Buffer.byteLength(JSON.stringify(safe)) - 2;
  const suffix = fullBytes <= allowance ? "" : allowance >= 20 ? " [truncated/omitted]" : allowance >= 1 ? "~" : "";
  const contentAllowance = allowance - Buffer.byteLength(suffix);
  let text = ""; let used = 0;
  for (const char of safe) { const size = Buffer.byteLength(JSON.stringify(char)) - 2; if (used + size > contentAllowance) break; text += char; used += size; }
  budget.remaining = Math.max(0, budget.remaining - used - Buffer.byteLength(suffix) - 128);
  return text + suffix;
}
function redactTraceOutput(raw: RunResult["trace"], boundary: EvidenceOutputBoundary, budget: EvidenceBudget): RunResult["trace"] {
  if (!raw) return undefined;
  const safe = { events: [] as NonNullable<RunResult["trace"]>["events"], totalEvents: raw.totalEvents, truncated: raw.truncated };
  for (const event of raw.events) {
    if (safe.events.length >= 20000 || budget.remaining < 1024) { safe.truncated = true; break; }
    const dto = traceEventDto(event, boundary.redactText);
    budget.remaining = Math.max(0, budget.remaining - Buffer.byteLength(JSON.stringify(dto)) - 32);
    safe.events.push(dto);
  }
  return safe;
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
  return { ...workflowIdentityDto(raw), apiId: raw.apiId, caseId: raw.caseId, scope: raw.scope, locator: raw.locator && structuredClone(raw.locator), row: raw.row, nodeId: raw.nodeId, entryId: raw.entryId, suiteRow: raw.suiteRow,
    apiName: boundary.redactText(raw.apiName), caseName: boundary.redactText(raw.caseName), passed: raw.passed, skipped: raw.skipped, skipReason: raw.skipReason, durationMs: raw.durationMs, failureKind: raw.failureKind,
    error: raw.error === undefined ? undefined : boundary.redactText(raw.error),
    assertions: raw.assertions.map((item) => ({ pass: item.pass, kind: item.kind, code: item.code, message: boundary.redactText(item.message),
      differencePath: item.differencePath === undefined ? undefined : boundary.redactText(item.differencePath), schemaPath: item.schemaPath === undefined ? undefined : boundary.redactText(item.schemaPath) })),
    ...(raw.evidence === undefined ? {} : { evidence: structuredClone(raw.evidence) }) };
}
function redactBudgetedCaseOutput(raw: CaseOutcome, boundary: EvidenceOutputBoundary, budget: EvidenceBudget): CaseOutcome {
  const rowBudget = { ...budget, remaining: Math.min(budget.caseBytes, budget.remaining) };
  const safe = redactCaseOutput(raw, { ...boundary, redactText: (value) => boundedSafeText(boundary.redactText(value), rowBudget) });
  return enforceCaseBudget(safe, budget);
}
/** Immutable identity/facts cannot be silently clipped to fit a smaller case ceiling. */
function enforceCaseBudget(safe: CaseOutcome, budget: EvidenceBudget): CaseOutcome {
  const omitEvidence = () => { if (safe.evidence) safe.evidence = { identity: safe.evidence.identity, state: "omitted", truncated: true, bodyUnavailable: true, scriptDiagnostics: "not-collected" }; };
  if (safe.evidence && Buffer.byteLength(JSON.stringify(safe.evidence)) > budget.caseBytes) omitEvidence();
  if (safe.evidence && Buffer.byteLength(JSON.stringify(safe.evidence)) > budget.caseBytes) throw new Error("Execution case evidence identity framing exceeds capacity");
  if (Buffer.byteLength(JSON.stringify(safe)) > budget.caseBytes) {
    const marker = boundedSafeText("[omitted diagnostics: case budget]", { ...budget, remaining: budget.valueBytes + 128 });
    safe.apiName = safe.caseName = marker;
    safe.error = safe.error === undefined ? undefined : marker; safe.assertions = [];
    omitEvidence();
  }
  if (Buffer.byteLength(JSON.stringify(safe)) > budget.caseBytes) throw new Error("Execution case identity framing exceeds capacity");
  return safe;
}
function redactRunOutput(raw: RunResult, boundary: EvidenceOutputBoundary, budget: EvidenceBudget, attachments = true): RunResult {
  return { collectionId: raw.collectionId, collectionName: boundary.redactText(raw.collectionName), envName: raw.envName === undefined ? undefined : boundary.redactText(raw.envName),
    reportingMode: raw.reportingMode, workflowUnits: raw.workflowUnits?.map((unit) => ({ ...unit, error: unit.error === undefined ? undefined : boundary.redactText(unit.error) })),
    requestFacts: raw.requestFacts && { ...raw.requestFacts }, trace: attachments ? redactTraceOutput(raw.trace, boundary, budget) : undefined,
    kind: raw.kind, projectId: raw.projectId, definitionRevision: raw.definitionRevision, workflowId: raw.workflowId, startedAt: raw.startedAt, finishedAt: raw.finishedAt,
    total: raw.total, passed: raw.passed, failed: raw.failed, skipped: raw.skipped, evidenceOmitted: raw.evidenceOmitted, reportFailure: raw.reportFailure,
    executionIdentity: raw.executionIdentity && identityDto(raw.executionIdentity), reportingUnits: raw.reportingUnits && { ...raw.reportingUnits },
    cases: attachments ? raw.cases.map((item) => redactBudgetedCaseOutput(item, boundary, budget)) : [], warnings: raw.warnings?.map((item) => boundary.redactText(item)),
    suite: raw.suite && { ...structuredClone(raw.suite), entries: raw.suite.entries?.map((entry) => ({ ...structuredClone(entry), error: entry.error === undefined ? undefined : boundary.redactText(entry.error) })) },
    workflow: raw.workflow && { ...structuredClone(raw.workflow), entries: raw.workflow.entries.map((entry) => ({ ...structuredClone(entry), label: entry.label === undefined ? undefined : boundary.redactText(entry.label), error: entry.error === undefined ? undefined : boundary.redactText(entry.error) })) } };
}
function redactWorkflowOutput(raw: WorkflowRunResult, boundary: EvidenceOutputBoundary, budget: EvidenceBudget, attachments = true): WorkflowRunResult {
  const failure = (value: NonNullable<import("../workflow/runner.js").NodeResult["primaryError"]>) => ({ code: value.code, cause: value.cause, failureKind: value.failureKind, message: boundary.redactText(value.message) });
  return { ...workflowIdentityDto(raw), reportingMode: raw.reportingMode, requestFacts: raw.requestFacts && { ...raw.requestFacts }, trace: attachments ? redactTraceOutput(raw.trace, boundary, budget) : undefined, workflowId: raw.workflowId, workflowName: boundary.redactText(raw.workflowName), status: raw.status, total: raw.total, passed: raw.passed, failed: raw.failed, skipped: raw.skipped, verdict: raw.verdict,
    startedAt: raw.startedAt, finishedAt: raw.finishedAt, warnings: raw.warnings.map((item) => boundary.redactText(item)), report: attachments && raw.report ? redactRunOutput(raw.report, boundary, budget) : undefined,
    nodeResults: raw.nodeResults.map((node) => ({ ...workflowIdentityDto(node), nodeId: node.nodeId, kind: node.kind, state: node.state, skipReason: node.skipReason, failureKind: node.failureKind,
      primaryError: node.primaryError && failure(node.primaryError), secondaryErrors: node.secondaryErrors?.map(failure), recoveredError: node.recoveredError && failure(node.recoveredError),
      attempts: node.attempts?.map((attempt) => ({ attempt: attempt.attempt, state: attempt.state, error: attempt.error && failure(attempt.error) })),
      policyEvents: node.policyEvents && structuredClone(node.policyEvents), branches: node.branches && structuredClone(node.branches),
      childInvocations: node.childInvocations?.map((child) => redactWorkflowOutput(child, boundary, budget, attachments)), policyInvocations: node.policyInvocations?.map((child) => ({ role: child.role, result: redactWorkflowOutput(child.result, boundary, budget, attachments) })),
      label: node.label === undefined ? undefined : boundary.redactText(node.label), error: node.error === undefined ? undefined : boundary.redactText(node.error),
      outcomes: attachments ? node.outcomes?.map((item) => redactBudgetedCaseOutput(item, boundary, budget)) : undefined, outcome: attachments && node.outcome ? redactBudgetedCaseOutput(node.outcome, boundary, budget) : undefined })) };
}
function redactSafetyTarget<T extends { origin: string; appliedPolicy?: { trustedOrigins?: readonly string[]; deniedOrigins?: readonly string[] } }>(raw: T, boundary: EvidenceOutputBoundary): T {
  return { ...structuredClone(raw), origin: boundary.redactText(raw.origin), appliedPolicy: raw.appliedPolicy && { ...structuredClone(raw.appliedPolicy),
    trustedOrigins: raw.appliedPolicy.trustedOrigins?.map((origin) => boundary.redactText(origin)), deniedOrigins: raw.appliedPolicy.deniedOrigins?.map((origin) => boundary.redactText(origin)) } };
}
function redactStressOutput<T extends StressReport | StressReportV2>(raw: T, boundary: EvidenceOutputBoundary, budget = createEvidenceBudget(), evidenceCharged = false): T {
  // The strict existing schema supplies this protocol allowlist; all other report fields are numeric/enum/identity.
  const v2 = "formatVersion" in raw && raw.formatVersion === 2;
  const safe = (v2 ? StressReportV2Schema.parse(raw) : StressReportSchema.parse(raw)) as T;
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
    const fixedCategory = error === "other" || STRESS_FAILURE_KINDS.some((kind) => kind === error);
    const key = v2 && fixedCategory ? error : text(error);
    Object.defineProperty(safe.errorKinds, key, { value: (Object.hasOwn(safe.errorKinds, key) ? safe.errorKinds[key]! : 0) + count, enumerable: true, configurable: true, writable: true });
  }
  if (safe.verdict) safe.verdict.violations = safe.verdict.violations.map((item, index) => ({ ...item, message: text(raw.verdict!.violations[index]!.message) }));
  const redactGenerator = (generator: NonNullable<StressReport["generator"]>) => ({ ...generator, unavailableReason: generator.unavailableReason === undefined ? undefined : text(generator.unavailableReason) });
  const redactSafety = (safety: NonNullable<StressReport["safety"]>) => ({ ...safety, unavailableReason: safety.unavailableReason === undefined ? undefined : text(safety.unavailableReason), targetOrigins: safety.targetOrigins.map((target) => ({ ...target,
    origin: text(target.origin), appliedPolicy: target.appliedPolicy && { ...target.appliedPolicy, trustedOrigins: collection(target.appliedPolicy.trustedOrigins), deniedOrigins: collection(target.appliedPolicy.deniedOrigins) } })) });
  if (safe.generator) safe.generator = redactGenerator(safe.generator);
  if (safe.safety) safe.safety = redactSafety(safe.safety);
  if (safe.distributed && "perShard" in safe.distributed) safe.distributed = { ...safe.distributed, perShard: safe.distributed.perShard.map((shard) => ({ ...shard, generator: redactGenerator(shard.generator), safety: shard.safety && redactSafety(shard.safety) })),
    shardErrors: safe.distributed.shardErrors?.map((shard) => ({ ...shard, error: text(shard.error) })) };
  if (v2) {
    const report = safe as StressReportV2;
    // Inputs are business JSON; the surrounding identifiers/enums remain opaque typed metadata.
    const projectInputs = (owner: { inputs?: Record<string, import("../contract/schemaNode.js").JsonValue> }) => {
      if (boundary.businessUnavailable) delete owner.inputs;
      else if (owner.inputs) owner.inputs = boundary.redactValue(owner.inputs);
    };
    if (report.target.kind === "workflow") projectInputs(report.target);
    if (report.plan.target.kind === "workflow") projectInputs(report.plan.target);
    for (const role of ["setup", "vuSetup", "vuTeardown", "teardown"] as const) {
      const step = report.plan.lifecycle?.[role]; if (step) projectInputs(step);
    }
  }
  if (Buffer.byteLength(JSON.stringify(safe)) > budget.reportBytes) throw new Error("Merged evidence report exceeds capacity");
  return safe;
}

/** Final host persistence/IPC/worker boundary, preserving fixed keys and already projected evidence. */
export function redactExecutionOutput<T>(value: T, boundary: EvidenceOutputBoundary, limits: Partial<Omit<EvidenceBudget, "remaining">> = {}): T {
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    if ((Array.isArray(raw.cases) && typeof raw.collectionId === "string") || (Array.isArray(raw.nodeResults) && typeof raw.workflowId === "string")) {
      const budget = createEvidenceBudget(limits);
      const bounded = { ...boundary, redactText: (text: string) => diagnosticText(text, boundary, budget) };
      const safe = Array.isArray(raw.cases) ? redactRunOutput(value as unknown as RunResult, bounded, budget) : redactWorkflowOutput(value as unknown as WorkflowRunResult, bounded, budget);
      // This is the actual final DTO, including repeated nested aliases and structural framing.
      if (Buffer.byteLength(JSON.stringify(safe)) > budget.reportBytes) throw new Error("Execution output exceeds capacity");
      return safe as T;
    }
    if (typeof raw.totalRequests === "number" && typeof raw.concurrency === "number") return redactStressOutput(value as unknown as StressReport | StressReportV2, boundary, createEvidenceBudget(limits)) as T;
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
export function createExecutionEvidenceCollector(base: EvidenceIdentity, markers: readonly string[], options: { mode?: ExecutionEvidenceInput["mode"]; maxSamples?: number; privateMarkers?: boolean; limits?: EvidenceLimits } = {}) {
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
    ...Object.fromEntries(["stressRunId", "vuId", "iterationId", "stageId"].filter((key) => outcome.evidence?.identity && Object.hasOwn(outcome.evidence.identity, key)).map((key) => [key, outcome.evidence!.identity[key as "stressRunId" | "vuId" | "iterationId" | "stageId"]])),
    ...Object.fromEntries(Object.entries(workflowIdentityDto(outcome)).filter(([, value]) => value !== undefined)),
    workflowId: outcome.invocationPath?.at(-1)?.workflowId ?? context.invocationPath?.at(-1)?.workflowId ?? context.workflowId ?? base.workflowId,
    locator: outcome.locator ?? context.locator ?? base.locator, rowIndex: outcome.row ?? context.rowIndex ?? base.rowIndex,
    nodeId: outcome.nodeId ?? context.nodeId ?? base.nodeId, entryId: outcome.entryId ?? context.entryId ?? base.entryId ?? outcome.nodeId ?? context.nodeId, suiteRow: outcome.suiteRow ?? context.suiteRow ?? base.suiteRow });
  const keyFor = (outcome: CaseOutcome, identity: EvidenceIdentity): string => JSON.stringify([
    identity.locator && [identity.locator.collectionId, identity.locator.folderIds, identity.locator.apiId, identity.locator.caseId, identity.locator.scope],
    outcome.apiId, outcome.caseId, outcome.scope ?? identity.locator?.scope, identity.entryId, identity.suiteRow, outcome.row, identity.rowIndex ?? 0, identity.nodeId,
    identity.invocationId, identity.parentInvocationId, identity.invocationPath, identity.nodeVisitId, identity.attempt,
    identity.stressRunId, identity.vuId, identity.iterationId, identity.stageId,
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
  function projectRun(raw: RunResult, limits: Partial<Omit<EvidenceBudget, "remaining">> = {}, sharedBudget?: EvidenceBudget): RunResult {
    const sanitizer = boundary(); const budget = sharedBudget ?? createEvidenceBudget({ ...options.limits, ...limits });
    let activeBudget = budget;
    const safe = redactRunOutput(raw, { ...sanitizer, redactText: (value) => diagnosticText(value, sanitizer, budget) }, budget, false);
    const cursors = new Map<string, number>();
    const suiteEntries = new Map(raw.suite?.entries?.map((entry) => [JSON.stringify([entry.entryId, entry.suiteRow]), entry]));
    // Legacy messages and script diagnostics consume the same report budget as evidence.
    const text = (value: string): string => diagnosticText(value, sanitizer, activeBudget);
    if (raw.trace) {
      safe.trace = { events: [], totalEvents: raw.trace.totalEvents, truncated: raw.trace.truncated };
      for (const event of raw.trace.events) {
        if (safe.trace.events.length >= 20000 || budget.remaining < 1024) { safe.trace.truncated = true; safe.evidenceOmitted = true; break; }
        const dto = traceEventDto(event, text);
        budget.remaining = Math.max(0, budget.remaining - Buffer.byteLength(JSON.stringify(dto)) - 32); safe.trace.events.push(dto);
      }
    }
    safe.projectId = base.projectId; safe.definitionRevision = base.definitionRevision;
    safe.executionIdentity = identityDto({ ...base, ...workflowIdentityDto(raw.executionIdentity ?? {}) });
    safe.kind = raw.suite ? "suite" : raw.workflowId ? "workflow" : raw.kind ?? "collection";
    if (safe.workflow) safe.workflow.entries = safe.workflow.entries.map((entry) => ({ ...entry, suiteRow: entry.suiteRow ?? base.suiteRow,
      ...(entry.skipReason === undefined ? {} : { skipReason: entry.skipReason }) }));
    safe.cases = raw.cases.map((outcome) => {
      const allowance = Math.min(budget.caseBytes, budget.remaining); const rowBudget = { ...budget, remaining: allowance };
      activeBudget = rowBudget;
      const identity = identityFor(outcome); const key = keyFor(outcome, identity); const cursor = cursors.get(key) ?? 0;
      const matching = byIdentity.get(key)?.[cursor]; cursors.set(key, cursor + 1);
      const projected = redactCaseOutput({ ...outcome, apiName: "", caseName: "", error: undefined, assertions: [], evidence: undefined }, sanitizer);
      projected.apiName = text(outcome.apiName); projected.caseName = text(outcome.caseName);
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
      return enforceCaseBudget(projected, budget);
    });
    safe.reportingUnits = reportingUnits(safe).summary;
    if (options.limits?.workflowMetadataBytes !== undefined) {
      const metadataBytes = () => Buffer.byteLength(JSON.stringify({ workflow: safe.workflow, workflowUnits: safe.workflowUnits, trace: safe.trace }));
      while (safe.trace?.events.length && metadataBytes() > options.limits.workflowMetadataBytes) { safe.trace.events.pop(); safe.trace.truncated = true; safe.evidenceOmitted = true; }
      if (metadataBytes() > options.limits.workflowMetadataBytes && safe.workflow) {
        const marker = boundedSafeText("[omitted metadata: budget]", { ...budget, remaining: budget.valueBytes + 128 });
        safe.workflow.entries = safe.workflow.entries.map(entry => ({ ...entry, label: entry.label === undefined ? undefined : marker, error: entry.error === undefined ? undefined : marker }));
      }
      if (metadataBytes() > options.limits.workflowMetadataBytes) throw new Error("Workflow metadata identity framing exceeds capacity");
    }
    // Structural framing also counts. Keep exact identities/facts if attachments exceed the ceiling.
    if (Buffer.byteLength(JSON.stringify(safe)) > budget.reportBytes) {
      safe.evidenceOmitted = true;
      const marker = boundedSafeText("[omitted diagnostics: report budget]", { ...budget, remaining: budget.valueBytes + 128 });
      for (const row of safe.cases) {
        row.evidence = { identity: row.evidence!.identity, state: "omitted", truncated: true, bodyUnavailable: true, scriptDiagnostics: "not-collected" };
        row.apiName = row.caseName = marker; row.error = row.error === undefined ? undefined : marker; row.assertions = [];
        enforceCaseBudget(row, budget);
      }
      safe.warnings = [marker];
      if (safe.trace) safe.trace = { ...safe.trace, events: [], truncated: true };
    }
    if (Buffer.byteLength(JSON.stringify(safe)) > budget.reportBytes) throw new Error("Evidence report identity framing exceeds capacity");
    return safe;
  }
  /** Capacity failure keeps real aggregates and primary failure facts; attachments may be omitted. */
  function projectRunFailure(raw: RunResult): RunResult {
    const failure = { ...raw, reportFailure: true, evidenceOmitted: true, reportingUnits: { ...reportingUnits(raw).summary } };
    try { return projectRun(failure); } catch { /* reduce aliases/attachments, never raise selected ceilings */ }
    const firstCase = raw.cases.find(row => !row.passed && !row.skipped);
    const firstNode = raw.workflow?.entries.find(entry => entry.status === "failed");
    const firstEntry = raw.suite?.entries?.find(entry => entry.status === "failed" || entry.status === "aborted");
    const primary = firstNode?.error ?? firstCase?.error ?? firstEntry?.error;
    const classification = firstNode?.failureKind ?? firstCase?.failureKind;
    const warnings = [...(raw.warnings ?? []), ...(primary ? [`${classification ? `${classification}: ` : ""}${primary}`] : [])];
    const compact: RunResult = { ...failure, cases: [], trace: undefined, workflowUnits: undefined, warnings,
      workflow: raw.workflow && { ...raw.workflow, entries: firstNode ? [{ ...firstNode, label: undefined }] : [] },
      suite: raw.suite && { ...raw.suite, entries: firstEntry ? [{ ...firstEntry }] : [] } };
    try { return projectRun(compact); } catch { /* minimal framing may only fit aggregates plus bounded primary diagnostics */ }
    return projectRun({ ...compact, workflow: compact.workflow && { ...compact.workflow, entries: [] }, suite: compact.suite && { ...compact.suite, entries: [] } });
  }
  function projectWorkflow(raw: WorkflowRunResult): WorkflowRunResult {
    const configured = options.limits !== undefined;
    const shared = createEvidenceBudget(options.limits);
    // The legacy singular outcome aliases the first row in IPC. Reserve both copies.
    const report = configured ? projectRun(workflowToRunResult(raw), {}, shared) : projectRun(workflowToRunResult(raw), { caseBytes: 128 * 1024, reportBytes: 4 * 1024 * 1024 });
    // Node metadata and its aliases share the other half of the same 16 MiB ceiling.
    const metadataLimit = options.limits?.workflowMetadataBytes ?? 4 * 1024 * 1024;
    const framing = configured ? Buffer.byteLength(JSON.stringify(redactWorkflowOutput(raw, { redactText: () => "", redactValue: value => value }, shared, false))) : 0;
    if (configured && framing > metadataLimit) throw new Error("Workflow metadata identity framing exceeds capacity");
    const metadataBudget = configured ? { ...shared, remaining: Math.min(shared.remaining, metadataLimit - framing) } : createEvidenceBudget({ reportBytes: 4 * 1024 * 1024 });
    const sanitizer = boundary();
    const safe = redactWorkflowOutput(raw, { ...sanitizer, redactText: (value) => diagnosticText(value, sanitizer, metadataBudget) }, metadataBudget, false);
    if (!configured) safe.warnings = report.warnings ?? [];
    safe.report = report;
    const entries = new Map(report.workflow?.entries.map((entry) => [entry.entryId, entry]));
    const rows = new Map<string, CaseOutcome[]>();
    const key = (item: { nodeId?: string; nodeVisitId?: string; invocationId?: string }) => JSON.stringify([item.invocationId, item.nodeVisitId, item.nodeId]);
    for (const item of report.cases) { const group = rows.get(key(item)); if (group) group.push(item); else rows.set(key(item), [item]); }
    const attach = (flow: WorkflowRunResult) => {
      for (const node of flow.nodeResults) {
        node.outcomes = rows.get(key(node)) ?? []; node.outcome = raw.invocationId ? undefined : node.outcomes[0];
        if (!raw.invocationId && !configured) node.error = entries.get(node.nodeId)?.error;
        node.childInvocations?.forEach(attach); node.policyInvocations?.forEach((child) => attach(child.result));
      }
    };
    if (configured && Buffer.byteLength(JSON.stringify({ ...safe, report: undefined })) > metadataLimit) throw new Error("Workflow metadata exceeds capacity");
    attach(safe); safe.trace = report.trace;
    if (configured && safe.trace) {
      const metadata = (flow: WorkflowRunResult): unknown => ({ ...flow, report: undefined, nodeResults: flow.nodeResults.map(node => ({ ...node, outcome: undefined, outcomes: undefined, childInvocations: node.childInvocations?.map(metadata), policyInvocations: node.policyInvocations?.map(child => ({ role: child.role, result: metadata(child.result) })) })) });
      const metadataBytes = () => Buffer.byteLength(JSON.stringify(metadata(safe)));
      while (safe.trace.events.length && metadataBytes() > metadataLimit) { safe.trace.events.pop(); safe.trace.truncated = true; report.evidenceOmitted = true; }
      if (metadataBytes() > metadataLimit) { safe.trace = undefined; report.trace = undefined; report.evidenceOmitted = true; }
    }
    if (Buffer.byteLength(JSON.stringify(safe)) > shared.reportBytes) {
      // The report is canonical. Drop duplicate row aliases before abandoning real facts.
      const omitAliases = (flow: WorkflowRunResult) => { for (const node of flow.nodeResults) { node.outcomes = undefined; node.outcome = undefined; node.childInvocations?.forEach(omitAliases); node.policyInvocations?.forEach(child => omitAliases(child.result)); } };
      omitAliases(safe); report.evidenceOmitted = true;
    }
    if (Buffer.byteLength(JSON.stringify(safe)) > shared.reportBytes) throw new Error("Workflow evidence report exceeds capacity");
    return safe;
  }
  function projectStressReport<T extends StressReport | StressReportV2>(raw: T, retainedEvidence = false): T {
    const budget = createEvidenceBudget(options.limits); const sanitizer = boundary();
    const failureEvidence = retainedEvidence ? raw.failureEvidence : records.map((record) => projectExecutionEvidence({ ...record, mode: "all" }, sanitizer, budget));
    if (retainedEvidence) budget.remaining = Math.max(0, budget.remaining - Buffer.byteLength(JSON.stringify(failureEvidence ?? [])));
    return redactStressOutput({ ...raw, failureEvidence }, sanitizer, budget, true);
  }
  return { observe, addMarkers, projectRun, projectRunFailure, projectWorkflow, projectStressReport, boundary,
    markers: () => { assertMarkersComplete(); if (cookiesUnavailable) throw new Error("Evidence marker set unavailable: Set-Cookie boundaries unavailable"); return [...sensitive]; },
    projectSamples: () => { const budget = createEvidenceBudget(options.limits); const safe = boundary(); return records.map((record) => projectExecutionEvidence({ ...record, mode: "all" }, safe, budget)); } };
}
