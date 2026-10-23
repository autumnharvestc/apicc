import { z } from "zod";
import type { ReadonlyJsonValue, ReportViewV1, RequestViewV1, ResponseViewV1 } from "@apicc/plugin-sdk";
import type { ExecutableRequest, ExecutionResponse, HttpExecuteOptions, ReporterOutputOptions } from "./types.js";
import type { LocalFileReference } from "../contract/request.js";
import { HttpMethodSchema } from "../domain/primitives.js";
import { JsonValueSchema } from "../contract/schemaNode.js";
import { reportingUnits } from "../report/units.js";
import { redactExecutionOutput } from "../report/evidence.js";
import type { RunResult } from "../report/types.js";

export function contributionInvalid(message: string, cause?: unknown): Error & { code: "contribution_invalid"; caseFailureKind: "config" } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "contribution_invalid" as const, caseFailureKind: "config" as const,
  });
}

export function freezeDto<T>(value: T): T {
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const item of Object.values(value)) freezeDto(item);
    Object.freeze(value);
  }
  return value;
}

/** Omit absent optional host fields, then validate and detach the JSON tree. */
export function jsonView(value: unknown): ReadonlyJsonValue {
  const ancestors = new Set<object>();
  const withoutAbsent = (item: unknown): unknown => {
    if (item && typeof item === "object") {
      if (ancestors.has(item)) throw new TypeError("SDK JSON views require a finite tree");
      if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError("SDK JSON views require plain objects");
      ancestors.add(item);
      try {
        return Array.isArray(item) ? item.map(withoutAbsent)
          : Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).map(([k, v]) => [k, withoutAbsent(v)]));
      } finally { ancestors.delete(item); }
    }
    return item;
  };
  return freezeDto(structuredClone(JsonValueSchema.parse(withoutAbsent(value))));
}

const pair = z.object({ key: z.string(), value: z.string() }).strict();
const headers = z.record(z.string(), z.string());
const fileView = z.object({ fileRef: z.string(), filename: z.string().optional(), sizeBytes: z.number().finite().nonnegative().optional() }).strict();
const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["json", "xml", "raw"]), content: z.string() }).strict(),
  z.object({ kind: z.literal("form"), form: z.array(pair) }).strict(),
  z.object({ kind: z.literal("binary"), file: fileView, contentType: z.string() }).strict(),
  z.object({ kind: z.literal("multipart"), entries: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), name: z.string(), value: z.string() }).strict(),
    z.object({ kind: z.literal("file"), name: z.string(), file: fileView, filename: z.string().optional(), contentType: z.string() }).strict(),
  ])) }).strict(),
]);
const common = { url: z.string(), headers, query: z.array(pair) };
const requestViewSchema = z.discriminatedUnion("protocol", [
  z.object({ ...common, protocol: z.literal("http"), method: HttpMethodSchema, body: body.optional() }).strict(),
  z.object({ ...common, protocol: z.literal("websocket"), message: z.string().optional() }).strict(),
  z.object({ ...common, protocol: z.literal("soap"), method: z.literal("POST"), envelope: z.string(), soapAction: z.string().optional() }).strict(),
]);
export const authPatchSchema = z.object({ headers: headers.optional(), query: z.array(pair).optional() }).strict();

/** A request-scoped codec; only original captured file identities can round-trip. */
export function requestViews(original: ExecutableRequest, options?: HttpExecuteOptions) {
  const references = new Map<string, LocalFileReference>();
  const toFile = (reference: LocalFileReference) => {
    const captured = options?.runtime?.files?.get(reference);
    if (options && !captured) throw contributionInvalid("SDK request file was not captured by this execution");
    const fileRef = crypto.randomUUID();
    references.set(fileRef, reference);
    return { fileRef, ...(captured ? { filename: captured.filename, sizeBytes: captured.size } : {}) };
  };
  const base = { url: original.url, headers: { ...original.headers }, query: original.query.filter(p => p.enabled !== false).map(({ key, value }) => ({ key, value })) };
  let view: RequestViewV1;
  if (original.protocol === "http") {
    const source = original.body;
    let projected: z.infer<typeof body> | undefined;
    if (source?.kind === "binary") projected = { kind: "binary", file: toFile(source.file), contentType: source.contentType };
    else if (source?.kind === "multipart") projected = { kind: "multipart", entries: source.entries.filter(e => e.enabled !== false).map(e => e.kind === "text"
      ? { kind: "text", name: e.name, value: e.value }
      : { kind: "file", name: e.name, file: toFile(e.file), contentType: e.contentType, ...(e.filename === undefined ? {} : { filename: e.filename }) }) };
    else if (source?.kind === "form") projected = { kind: "form", form: source.form.filter(p => p.enabled !== false).map(({ key, value }) => ({ key, value })) };
    else if (source) projected = { kind: source.kind, content: source.content };
    view = { ...base, protocol: "http", method: original.method, ...(projected ? { body: projected } : {}) };
  } else if (original.protocol === "websocket") view = { ...base, protocol: "websocket", ...(original.message === undefined ? {} : { message: original.message }) };
  else view = { ...base, protocol: "soap", method: "POST", envelope: original.envelope, ...(original.soapAction === undefined ? {} : { soapAction: original.soapAction }) };
  const restoreFile = (file: { fileRef: string }): LocalFileReference => {
    const reference = references.get(file.fileRef);
    if (!reference) throw contributionInvalid("SDK transport file ref does not belong to this execution");
    return reference;
  };
  return {
    view: freezeDto(view),
    restore(input: RequestViewV1): ExecutableRequest {
      const checked = requestViewSchema.safeParse(input);
      if (!checked.success) throw contributionInvalid("SDK transport request does not match the request contract", checked.error);
      const parsed = checked.data;
      if (parsed.protocol !== original.protocol) throw contributionInvalid("SDK transport cannot switch protocol kind");
      const shared = { url: parsed.url, headers: { ...parsed.headers }, query: parsed.query.map(p => ({ ...p, enabled: true })), auth: structuredClone(original.auth), cookieHeaderMode: original.cookieHeaderMode };
      if (parsed.protocol !== "http") return { ...shared, ...parsed, query: shared.query };
      const b = parsed.body;
      const restoredBody = b?.kind === "binary" ? { ...b, file: restoreFile(b.file) }
        : b?.kind === "multipart" ? { ...b, entries: b.entries.map(e => e.kind === "file" ? { ...e, file: restoreFile(e.file) } : { ...e }) }
        : b?.kind === "form" ? { ...b, content: "", form: b.form.map(p => ({ ...p, enabled: true })) } : b;
      return { ...shared, protocol: "http", method: parsed.method, ...(restoredBody ? { body: restoredBody } : {}) };
    },
  };
}

export function responseView(response: ExecutionResponse): ResponseViewV1 {
  return freezeDto({ status: response.status, headers: { ...response.headers }, bodyText: response.bodyText, timeMs: response.timeMs,
    ...(response.bodyBytes === undefined ? {} : { bodyBytes: new Uint8Array(response.bodyBytes) }),
    ...(response.rawHeaders === undefined ? {} : { rawHeaders: response.rawHeaders.map(([k, v]) => [k, v] as const) }),
    ...Object.fromEntries((["textAvailable", "jsonAvailable", "encodedBytes", "decodedBytes", "declaredLength"] as const).filter(k => response[k] !== undefined).map(k => [k, response[k]])) });
}

export function reportView(raw: RunResult, output?: ReporterOutputOptions): Readonly<ReportViewV1> {
  if (!output?.boundary && !output?.alreadyProjected) throw new Error("SDK reporter requires the current run output boundary or an already projected result");
  const result = output.boundary ? redactExecutionOutput(raw, output.boundary) : structuredClone(raw);
  const units = reportingUnits(result);
  return freezeDto({ formatVersion: 1, kind: result.kind ?? (result.suite ? "suite" : result.workflow ? "workflow" : "collection"), title: result.collectionName,
    startedAt: result.startedAt, finishedAt: result.finishedAt,
    rows: { total: result.total, passed: result.passed, failed: result.failed, skipped: result.skipped ?? 0 },
    ...(result.reportingMode ? { logical: { total: units.summary.total, passed: units.summary.passed, failed: units.summary.failed, skipped: units.summary.skipped } } : {}),
    ...(result.requestFacts ? { requestFacts: { started: result.requestFacts.requestStarted, completed: result.requestFacts.requestCompleted, httpExchanges: result.requestFacts.httpExchanges } } : {}),
    cases: result.cases.map(c => jsonView(c) as import("@apicc/plugin-sdk").ReadonlyJsonObject),
    diagnostics: [...(result.warnings ?? []), ...units.diagnostics.map(d => d.error ?? d.status)],
    details: jsonView({ reportingMode: result.reportingMode, workflowUnits: result.workflowUnits, workflow: result.workflow, suite: result.suite, reportFailure: result.reportFailure }) as import("@apicc/plugin-sdk").ReadonlyJsonObject });
}
