import type { JsonValue } from "../contract/schemaNode.js";
import type { ExecutionResponse } from "../plugin/types.js";
import { AssertionValueError, selectResponseValue, validateResponseSelector } from "../assert/selection.js";
import { compileRegex, type CompiledRegex } from "../assert/regex.js";
import { ExtractionListSchema, type ExtractionDefinition, type ResponseSelector } from "./model.js";

export interface ExtractionOutcome {
  id: string;
  name: string;
  selector: ResponseSelector;
  status: "extracted" | "defaulted" | "absent" | "failed" | "notExecuted";
  pass: boolean;
  published: boolean;
  sensitive: boolean;
  code: string;
  message: string;
  kind?: "config" | "extraction";
  value?: JsonValue;
}
export interface ExtractionBinding { value: JsonValue; text: string; sensitive: boolean }
type NormalizedExtraction = ReturnType<typeof ExtractionListSchema.parse>[number];
export interface PreparedExtractions {
  definitions: readonly ExtractionDefinition[];
  entries: Array<{ definition: NormalizedExtraction; regex?: CompiledRegex }>;
}
/** Owned by one collection/workflow run or one virtual user, never authoring state. */
export interface ExtractionRuntimeState {
  bindings: Map<string, ExtractionBinding>;
  prepared: WeakMap<readonly ExtractionDefinition[], PreparedExtractions>;
}
export interface ExtractionBatchResult {
  outcomes: ExtractionOutcome[];
  committed: boolean;
  failureKind?: "config" | "extraction";
}
export function createExtractionRuntimeState(): ExtractionRuntimeState {
  return { bindings: new Map(), prepared: new WeakMap() };
}
export function prepareExtractions(definitions: readonly ExtractionDefinition[]): PreparedExtractions {
  const parsed = ExtractionListSchema.safeParse(structuredClone(definitions));
  if (!parsed.success) throw new AssertionValueError("EXTRACTION_CONFIG", parsed.error.message);
  return { definitions, entries: parsed.data.map((definition) => {
    validateResponseSelector(definition.selector);
    return { definition, ...(definition.method === "regex" ? { regex: compileRegex(definition.pattern, definition.flags) } : {}) };
  }) };
}
const sensitive = (definition: ExtractionDefinition): boolean => definition.sensitive === true
  || definition.selector.target === "cookie"
  || (definition.selector.target === "header" && ["authorization", "cookie", "set-cookie"].includes(definition.selector.headerName?.toLowerCase() ?? ""));
const textValue = (value: JsonValue): string => typeof value === "string" ? value : JSON.stringify(value);
export function extractionVariables(state: ExtractionRuntimeState): Record<string, string> {
  return Object.fromEntries([...state.bindings].map(([name, binding]) => [name, binding.text]));
}
/** Clear only this batch's extraction layer; ordinary script/config values remain lower layers. */
export function clearExtractionTargets(definitions: readonly ExtractionDefinition[], state: ExtractionRuntimeState): void {
  for (const definition of definitions) state.bindings.delete(definition.name);
}
export function skippedExtractions(definitions: readonly ExtractionDefinition[], state: ExtractionRuntimeState): ExtractionOutcome[] {
  clearExtractionTargets(definitions, state);
  return definitions.map((definition) => ({ id: definition.id, name: definition.name,
    selector: { ...definition.selector, match: definition.selector.match ?? "first" } as ResponseSelector,
    status: "notExecuted", pass: false, published: false, sensitive: sensitive(definition), code: "EXTRACTION_NOT_EXECUTED",
    message: "Extraction was not executed because an earlier stage failed" }));
}
/** Pure response evaluation and atomic in-memory publication; no host callbacks. */
export function evaluateExtractions(definitions: readonly ExtractionDefinition[], response: ExecutionResponse, state: ExtractionRuntimeState): ExtractionBatchResult {
  let prepared: PreparedExtractions;
  try {
    prepared = state.prepared.get(definitions) ?? prepareExtractions(definitions);
    state.prepared.set(definitions, prepared);
  } catch (error) {
    clearExtractionTargets(definitions, state);
    const detail = error instanceof AssertionValueError ? error : new AssertionValueError("EXTRACTION_CONFIG", String(error));
    return { committed: false, failureKind: "config", outcomes: definitions.map((definition) => ({
      id: definition.id, name: definition.name, selector: { ...definition.selector, match: definition.selector.match ?? "first" } as ResponseSelector,
      status: "failed", pass: false, published: false, sensitive: sensitive(definition), kind: "config", code: detail.code, message: detail.message,
    })) };
  }
  const staged = new Map<string, ExtractionBinding>();
  const outcomes: ExtractionOutcome[] = prepared.entries.map(({ definition, regex }) => {
    const base = { id: definition.id, name: definition.name, selector: definition.selector, sensitive: sensitive(definition), published: false };
    try {
      if (!response) throw new AssertionValueError("RESPONSE_MISSING", "Response is unavailable", "assertion");
      const selected = selectResponseValue(definition.selector, response);
      let value = selected.value;
      let found = selected.found;
      if (found && definition.method === "regex") {
        if (typeof value !== "string") throw new AssertionValueError("EXTRACTION_TYPE", "Regex extraction requires a text value", "assertion");
        value = regex!.capture(value, definition.group, definition.regexMatch);
        found = value !== undefined;
      }
      let status: "extracted" | "defaulted" = "extracted";
      if (!found) {
        if (definition.required) return { ...base, status: "failed", pass: false, kind: "extraction", code: "EXTRACTION_MISSING", message: "Required extraction value is absent" };
        if (definition.defaultValue === undefined) return { ...base, status: "absent", pass: true, code: "EXTRACTION_ABSENT", message: "Optional extraction value is absent" };
        value = definition.defaultValue!;
        status = "defaulted";
      }
      staged.set(definition.name, { value: value!, text: textValue(value!), sensitive: base.sensitive });
      return { ...base, status, pass: true, value, code: status === "defaulted" ? "EXTRACTION_DEFAULTED" : "EXTRACTION_PASSED", message: "Extraction value staged" };
    } catch (error) {
      const detail = error instanceof AssertionValueError ? error : new AssertionValueError("EXTRACTION_CONFIG", String(error));
      return { ...base, status: "failed", pass: false, kind: detail.kind === "config" ? "config" : "extraction", code: detail.code, message: detail.message };
    }
  });
  clearExtractionTargets(definitions, state);
  const failed = outcomes.filter((outcome) => !outcome.pass);
  if (failed.length) return { outcomes, committed: false, failureKind: failed.some((outcome) => outcome.kind === "config") ? "config" : "extraction" };
  for (const [name, binding] of staged) state.bindings.set(name, binding);
  return { outcomes: outcomes.map((outcome) => ({ ...outcome, published: outcome.status === "extracted" || outcome.status === "defaulted" })), committed: true };
}
