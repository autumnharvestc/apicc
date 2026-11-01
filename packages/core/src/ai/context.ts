import type { ProjectSnapshot } from "../assets/snapshot.js";
import type { ProjectAssetContextReadView } from "../assets/context.js";
import type { CaseExecutionLocator } from "../runner/caseExecutor.js";
import type { RunResult } from "../report/types.js";
import type { DebugResult } from "../debug/model.js";
import type { AiChatMessage } from "./types.js";
import { ApiContractSchema, type ApiContract, type ApiAsset } from "../contract/model.js";
import type { DeepReadonly } from "../assets/context.js";
import { contractAiView, safeAiValue, redactAiText, assertionAiView } from "./contractView.js";
import { AiCaseWireOutputSchema, AiAssertionWireOutputSchema } from "./types.js";
import { z } from "zod";
import { buildAiBusinessMessages } from "./prompt.js";
import type { ReadableStressReport } from "../stress/reportV2.js";
import type { StressComparison } from "../stress/compare.js";
import { AiAnalysisOutputSchema, projectAiReport } from "./analysis.js";
import { projectAssertionContext, type AiAssertionContext } from "./assertions.js";

interface AiSourceIdentity {
  bindingId: string;
  projectId: string;
  definitionRevision: string;
  editRevision: number;
}
/** Host-created stable opaque identities, never access tokens or API keys. */
export type AiSourceBinding = AiSourceIdentity & (
  | { kind: "local"; rootIdentity: string }
  | { kind: "online"; serverIdentity: string; memberIdentity: string; workspaceId: string; groupId: string; serverProjectId: string; projectVersion: string }
);

interface AiContextBase {
  snapshot: ProjectSnapshot;
  context: ProjectAssetContextReadView;
  source: AiSourceBinding;
  bodySelection: readonly string[];
  maxContextBytes?: number;
  currentDraft?: { locator: AiApiLocator; contract: ApiContract; documentation?: string; editRevision: number };
}

export interface AiApiLocator {
  collectionId: string; folderIds: readonly string[]; apiId: string;
  caseId?: string; scope?: string;
}
export type AiReadableReport = RunResult | ReadableStressReport | DebugResult;

export type AiBusinessRequest = { instruction?: string; limit?: number; candidateCount?: number } & (
  | { purpose: "case-suggestion"; target: AiApiLocator }
  | { purpose: "assertion-suggestion"; target: CaseExecutionLocator; basis: { kind: "contract" } | { kind: "observation"; reportId: string; report: RunResult; caseIndex: number } }
  | { purpose: "report-analysis"; reportId: string; report: AiReadableReport; evidenceSelection?: readonly string[]; comparison?: { baselineReportId: string; baseline: ReadableStressReport; judgment: StressComparison } }
);
export type AiContextInput = AiContextBase & AiBusinessRequest;

interface AiEvidenceItem<Purpose extends AiContextInput["purpose"]> {
  purpose: Purpose;
  id: string;
  kind: string;
  location: string;
  state: "collected" | "not-collected" | "omitted" | "legacy";
  value: unknown;
  truncated?: boolean;
}
export type AiEvidence = AiEvidenceItem<"case-suggestion"> | AiEvidenceItem<"assertion-suggestion"> | AiEvidenceItem<"report-analysis">;

/** Selectable safe fields only; values and body text stay in the captured source. */
export interface AiSafeChoice { id: string; kind: string; location: string; state: AiEvidence["state"]; truncated?: boolean }
export interface AiBodyChoice { location: string; kind: "request" | "response" | "contract-request"; available: true }
export interface AiContextChoices { source: AiSourceSummary; evidence: readonly AiSafeChoice[]; bodies: readonly AiBodyChoice[] }
export function inspectAiContextChoices(input: AiContextInput): AiContextChoices {
  const projected = projectAiContext(input);
  return { source: projected.source, evidence: projected.evidence.map(({ id, kind, location, state, truncated }) => ({ id, kind, location, state, ...(truncated === undefined ? {} : { truncated }) })), bodies: projected.bodyChoices };
}

export interface AiContextPreview {
  purpose: AiContextInput["purpose"];
  messages: readonly AiChatMessage[];
  outputSchema: unknown;
  bytes: number;
  evidence: readonly AiEvidence[];
  source: AiSourceSummary;
  included: readonly string[];
  omitted: readonly { item: string; reason: string }[];
  redaction: { strategy: "heuristic"; limitations: readonly string[] };
  assertionContext?: AiAssertionContext;
  limit?: number;
  evidenceSelection?: { selected: number; total: number; omitted: number };
}

export interface AiSourceSummary {
  bindingId: string;
  kind: AiSourceBinding["kind"];
  projectId: string;
  definitionRevision: string;
  editRevision: number;
  unsaved: boolean;
  target?: AiApiLocator;
  projectVersion?: string;
  observation?: { reportId: string; caseIndex: number; definitionRevision: string | null };
  report?: { reportId: string; definitionRevision: string | null; formatVersion: number | null; startedAt: string | number; finishedAt: string | number; summary: unknown };
  comparison?: { baseline: NonNullable<AiSourceSummary["report"]>; candidate: NonNullable<AiSourceSummary["report"]> };
}

/** Host-side comparison of captured identities; no filesystem or account lookup. */
export function sameAiSourceBinding(left: AiSourceBinding, right: AiSourceBinding): boolean {
  const fields = ["kind", "bindingId", "projectId", "definitionRevision", "editRevision", "rootIdentity", "serverIdentity", "memberIdentity", "workspaceId", "groupId", "serverProjectId", "projectVersion"] as const;
  return fields.every(field => (left as unknown as Record<string, unknown>)[field] === (right as unknown as Record<string, unknown>)[field]);
}

function sameLocator(left: AiApiLocator, right: AiApiLocator): boolean {
  return left.collectionId === right.collectionId && left.apiId === right.apiId && left.caseId === right.caseId && left.scope === right.scope
    && Array.isArray(left.folderIds) && left.folderIds.length === right.folderIds.length && left.folderIds.every((id, index) => id === right.folderIds[index]);
}

function currentAsset(input: AiContextInput, target: AiApiLocator): DeepReadonly<ApiAsset> {
  const collection = input.snapshot.project.collections.find(item => item.id === target.collectionId);
  let container: DeepReadonly<{ folders: import("../contract/workspace.js").ContractFolder[]; apis: ApiAsset[] }> | undefined = collection;
  for (const id of target.folderIds) container = container?.folders.find(item => item.id === id);
  const asset = container?.apis.find(item => item.contract.id === target.apiId);
  if (!asset || ((target.caseId !== undefined || target.scope !== undefined) && !asset.cases.some(item => item.id === target.caseId && item.scope === target.scope))) throw new Error("target-not-found");
  return asset;
}

/** UTF-8 bound without splitting a code point. */
export function boundedAiText(value: string, bytes = 4096): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= bytes) return { text: value, truncated: false };
  let end = bytes;
  while ((encoded[end]! & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(encoded.subarray(0, end)), truncated: true };
}

function projectAiContext(input: AiContextInput) {
  if (input.source.projectId !== input.snapshot.project.id || input.source.definitionRevision !== input.snapshot.definitionRevision) throw new Error("source-binding-mismatch");
  if (input.context !== input.snapshot.context) throw new Error("snapshot-context-mismatch");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) throw new Error("limit 须为 1–50 的整数");
  if (input.candidateCount !== undefined && (!Number.isInteger(input.candidateCount) || input.candidateCount < 1 || input.candidateCount > 50)) throw new Error("candidate-count-invalid");
  const candidateCount = input.candidateCount ?? (input.purpose === "assertion-suggestion" ? 10 : 5);
  const limit = input.purpose === "report-analysis" ? undefined : Math.min(input.limit ?? candidateCount, input.candidateCount ?? 50);
  const evidence: AiEvidence[] = [];
  const bodyChoices: AiBodyChoice[] = [];
  const included: string[] = [];
  const omitted = [{ item: "scripts", reason: "default-omitted" }, { item: "dataset-rows", reason: "default-omitted" }, { item: "secrets-attachments-absolute-paths", reason: "not-authorized" }];
  if (limit !== undefined && input.limit !== undefined && limit < input.limit) omitted.push({ item: "candidate-limit", reason: "candidate-count-budget" });
  let evidenceSelection: AiContextPreview["evidenceSelection"];
  let view: unknown;
  let assertionContext: AiAssertionContext | undefined;
  const observedBodySelections = new Set<string>();
  let source: AiContextPreview["source"] = {
    bindingId: input.source.bindingId, kind: input.source.kind, projectId: input.source.projectId,
    definitionRevision: input.source.definitionRevision, editRevision: input.source.editRevision, unsaved: false,
    ...(input.source.kind === "online" ? { projectVersion: input.source.projectVersion } : {}),
  };
  if (input.purpose !== "report-analysis") {
    const selected = currentAsset(input, input.target);
    let asset = selected;
    let context = input.context;
    if (input.currentDraft) {
      const draft = input.currentDraft;
      const parsed = ApiContractSchema.safeParse(draft.contract);
      if (!sameLocator(draft.locator, input.target) || draft.editRevision !== input.source.editRevision || !parsed.success || parsed.data.id !== selected.contract.id) throw new Error("draft-invalid");
      asset = { ...selected, contract: parsed.data, documentation: draft.documentation ?? selected.documentation };
      context = { ...context, getContract: id => id === selected.contract.id ? parsed.data : input.context.getContract(id) };
      source = { ...source, unsaved: true };
    }
    source.target = structuredClone(input.target);
    const contract = contractAiView(asset, context, { includeBodies: false });
    assertionContext = projectAssertionContext(contract, input.purpose === "assertion-suggestion" ? input.basis.kind : "contract");
    if (input.purpose === "case-suggestion" || input.basis.kind === "contract") evidence.push({ purpose: input.purpose, id: `contract:${asset.contract.id}`, kind: "contract", location: "contract", state: "collected", value: contract });
    if (input.purpose === "assertion-suggestion" && input.basis.kind === "observation") {
        const basis = input.basis;
        const row = basis.report.cases[basis.caseIndex];
        if (!row || row.apiId !== input.target.apiId || row.caseId !== input.target.caseId) throw new Error("evidence-target-mismatch");
        const identityLocator = row.evidence?.identity.locator;
        if (!row.locator && !identityLocator) throw new Error("evidence-locator-unavailable");
        if ([row.locator, identityLocator].some(locator => locator && !sameLocator(locator, input.target))) throw new Error("evidence-target-mismatch");
        if (row.evidence?.state !== "collected" || !row.evidence.response) throw new Error("evidence-unavailable");
        const reportSelections = input.bodySelection.filter(selection => selection !== "contract:request-body");
        if (reportSelections.some(selection => !selection.startsWith(`cases[${basis.caseIndex}].evidence.`))) throw new Error("body-selection-unavailable");
        const projected = projectAiReport({ ...input, purpose: "report-analysis", bodySelection: reportSelections, report: basis.report, reportId: basis.reportId });
        bodyChoices.push(...projected.availableBodies.filter(location => location.startsWith(`cases[${basis.caseIndex}].evidence.`)).map(location => ({ location, kind: location.endsWith('.request.body') ? 'request' as const : 'response' as const, available: true as const })));
        reportSelections.forEach(selection => observedBodySelections.add(selection));
        source.observation = { reportId: basis.reportId, caseIndex: basis.caseIndex, definitionRevision: basis.report.definitionRevision ?? null };
        evidence.push(...projected.evidence.filter(item => item.location.startsWith(`cases[${basis.caseIndex}]`)).map(item => ({ ...item, purpose: "assertion-suggestion" as const })));
        included.push(...projected.included); omitted.push(...projected.omitted);
    }
    const bodies: Record<string, unknown> = {};
    if (!(asset.contract.request.protocol === "http" && ["none", "binary"].includes(asset.contract.request.body.kind))
      && !(asset.contract.request.protocol === "websocket" && asset.contract.request.message === undefined)) bodyChoices.push({ location: 'contract:request-body', kind: 'contract-request', available: true });
    for (const selection of input.bodySelection) {
      if (observedBodySelections.has(selection)) continue;
      if (selection !== "contract:request-body") throw new Error("body-selection-unavailable");
      if ((asset.contract.request.protocol === "http" && ["none", "binary"].includes(asset.contract.request.body.kind))
        || (asset.contract.request.protocol === "websocket" && asset.contract.request.message === undefined)) throw new Error("body-selection-unavailable");
      const request = contractAiView(asset, context).request;
      const content = request.body ?? request.envelope ?? request.message;
      const bounded = boundedAiText(JSON.stringify(content));
      bodies[selection] = bounded;
      included.push(selection);
      if (bounded.truncated) omitted.push({ item: selection, reason: "truncated" });
    }
    if (!input.bodySelection.includes("contract:request-body")) omitted.push({ item: "contract:request-body", reason: "default-omitted" });
    included.push("contract", "related-models-and-components", "existing-case-names");
    const current = asset.cases.find(item => item.id === input.target.caseId && item.scope === input.target.scope);
    view = { contract, documentation: safeAiValue(asset.documentation), existingCases: safeAiValue(asset.cases.map(({ name, scope }) => ({ name, scope }))),
      ...(current ? { currentCase: safeAiValue({ name: current.name, scope: current.scope, parameters: current.parameters, assertions: current.assertions.map(assertionAiView) }) } : {}), bodies };
  }
  if (input.purpose === "report-analysis") {
    const projected = projectAiReport(input);
    bodyChoices.push(...projected.availableBodies.map(location => ({ location, kind: location.endsWith('.request.body') ? 'request' as const : 'response' as const, available: true as const })));
    evidence.push(...projected.evidence); included.push(...projected.included); omitted.push(...projected.omitted);
    source.report = projected.source;
    if (projected.comparisonSource) source.comparison = projected.comparisonSource;
    const total = evidence.length;
    if (input.evidenceSelection !== undefined) {
      const selectedIds = new Set(input.evidenceSelection);
      if ([...selectedIds].some(id => !evidence.some(item => item.id === id))) throw new Error("evidence-selection-unavailable");
      for (let index = evidence.length - 1; index >= 0; index--) if (!selectedIds.has(evidence[index]!.id)) {
        omitted.push({ item: evidence[index]!.id, reason: "not-selected" }); evidence.splice(index, 1);
      }
    }
    evidenceSelection = { selected: evidence.length, total, omitted: total - evidence.length };
    for (let index = included.length - 1; index >= 0; index--) if (projected.availableBodies.includes(included[index]!) && !evidence.some(item => item.kind === 'body' && item.location === included[index])) included.splice(index, 1);
  }
  return { evidence, included, omitted, source, view, assertionContext, limit, evidenceSelection, bodyChoices };
}

export function prepareAiContext(input: AiContextInput): AiContextPreview {
  const maxBytes = input.maxContextBytes ?? 131072;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("context-budget-invalid");
  const { evidence, included, omitted, source, view, assertionContext, limit, evidenceSelection } = projectAiContext(input);
  const outputSchema = z.toJSONSchema(input.purpose === "case-suggestion" ? AiCaseWireOutputSchema.extend({ cases: AiCaseWireOutputSchema.shape.cases.max(limit!) }) : input.purpose === "assertion-suggestion" ? AiAssertionWireOutputSchema.extend({ assertions: AiAssertionWireOutputSchema.shape.assertions.max(limit!) }) : AiAnalysisOutputSchema);
  const messages = buildAiBusinessMessages(input.purpose, { purpose: input.purpose, view, evidence, evidenceSelection, operators: assertionContext?.operators, instruction: safeAiValue(input.instruction), limit });
  const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  const bytes = new TextEncoder().encode(JSON.stringify({ messages, outputSchema, instruction: system })).byteLength;
  if (bytes > maxBytes) throw new Error("context-budget");
  const preview = { purpose: input.purpose, messages, outputSchema, bytes, evidence, source, included, omitted, ...(limit === undefined ? {} : { limit }), ...(evidenceSelection ? { evidenceSelection } : {}), ...(assertionContext ? { assertionContext } : {}), redaction: { strategy: "heuristic" as const, limitations: ["启发式脱敏不能保证发现所有用户自定义秘密。"] } };
  const freeze = (value: unknown): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(preview);
  return preview;
}
