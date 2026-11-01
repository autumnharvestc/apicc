import type { AiContextPreview } from "./context.js";
import type { Assertion } from "../domain/common.js";
import { AssertionSchema } from "../domain/common.js";
import type { ApiAsset, ModelAsset, ResponseDefinition } from "../contract/model.js";
import type { ContractAiView } from "./contractView.js";
import { builtinAssertDescriptors, builtinAssertOperators } from "../assert/operators.js";
import { compileCaseAssertions } from "../assert/evaluate.js";
import { createReadonlyProjectAssetContext } from "../assets/context.js";
import { createPluginRegistry } from "../plugin/registry.js";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { AiAssertionWireOutputSchema, type AiWireAssertionSchema } from "./types.js";
import { stripCodeFence } from "./suggest.js";

const nextId = monotonicFactory();
export const AiAssertionOutputSchema = z.object({ assertions: z.array(z.object({
  assertion: AssertionSchema, basis: z.enum(["contract", "observation"]), reason: z.string(),
  evidenceIds: z.array(z.string()).min(1), requiresUserJudgment: z.boolean(),
}).strict()) }).strict();

export interface AiAssertionContext {
  basis: "contract" | "observation";
  contractId: string;
  responses: ResponseDefinition[];
  responseReferences: Array<{ id: string; componentId: string }>;
  models: ModelAsset[];
  operators: typeof builtinAssertDescriptors;
}

/** Only declarative response schemas and the already-selected model closure survive. */
export function projectAssertionContext(view: ContractAiView, basis: AiAssertionContext["basis"]): AiAssertionContext {
  const references = (view.responses as Array<Record<string, unknown>>).filter(item => item.unresolved === true).map(item => ({ id: item.id as string, componentId: item.componentId as string }));
  const responses = view.responses.filter(raw => !(raw as Record<string, unknown>).unresolved).map(raw => {
    const item = raw as Record<string, unknown>;
    const definition = (item.definition ?? item) as ResponseDefinition;
    return { status: definition.status, description: "", headers: {}, content: Object.fromEntries(Object.entries(definition.content ?? {}).map(([mediaType, content]) => [mediaType, { ...(content.schema ? { schema: content.schema } : {}), examples: [] }])) };
  });
  const models = (view.models as Array<Partial<ModelAsset>>).filter(item => item.schema).map(item => ({ formatVersion: 1 as const, id: item.id!, name: item.name!, description: "", schema: item.schema! }));
  return structuredClone({ basis, contractId: view.contractId, responses, responseReferences: references, models, operators: builtinAssertDescriptors }) as AiAssertionContext;
}

/** This carrier exists only for Core's schema compiler; it is never executable. */
function schemaContext(projectId: string, capability: AiAssertionContext) {
  const asset: ApiAsset = { contract: {
    formatVersion: 1, id: capability.contractId,
    metadata: { name: "Schema projection", description: "", version: "", tags: [], status: "draft" },
    request: { protocol: "http", method: "GET", baseUrl: "", path: "", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } },
    responses: [...capability.responses.map((response, index) => ({ ...response, kind: "inline" as const, id: `response-${index}` })), ...capability.responseReferences.map(reference => ({ ...reference, kind: "componentRef" as const, expectedKind: "response" as const }))],
  }, cases: [], documentation: "" };
  return createReadonlyProjectAssetContext({ projectId, assets: [asset], models: capability.models, components: [] });
}

export function validateAiAssertions(assertions: Assertion[], preview: AiContextPreview): void {
  const capability = preview.assertionContext!;
  const registry = createPluginRegistry();
  builtinAssertOperators.forEach(operator => registry.registerAssert(operator));
  const compiled = compileCaseAssertions({ id: "candidate", name: "candidate", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions }, schemaContext(preview.source.projectId, capability), registry, { contractId: capability.contractId });
  if (compiled.diagnostics.length) throw new Error("assertion-output-invalid");
}

export interface AiAssertionCandidate {
  assertion: Assertion;
  basis: "contract" | "observation";
  reason: string;
  evidenceIds: string[];
  requiresUserJudgment: boolean;
}

export function decodeAiStringEntries(entries: Array<{ name: string; value: string }>): Record<string, string> {
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error("wire-map-duplicate");
  return Object.fromEntries(entries.map(entry => [entry.name, entry.value]));
}

export function decodeAiWireAssertion(wire: z.infer<typeof AiWireAssertionSchema>): Assertion {
  return AssertionSchema.parse({
    id: nextId(), target: wire.target, op: wire.op,
    ...(wire.expected === null ? {} : { expected: wire.expected }),
    ...(wire.path === null ? {} : { path: wire.path }),
    ...(wire.headerName === null ? {} : { headerName: wire.headerName }),
    ...(wire.cookieName === null ? {} : { cookieName: wire.cookieName }),
    ...(wire.namespaces === null ? {} : { namespaces: decodeAiStringEntries(wire.namespaces) }),
    ...(wire.match === null ? {} : { match: wire.match }),
    ...(wire.optionsJson === null ? {} : { options: JSON.parse(wire.optionsJson) }),
  });
}

export function parseAiAssertionWireOutput(text: string, preview: AiContextPreview): AiAssertionCandidate[] {
  let output: unknown;
  try {
    const wire = AiAssertionWireOutputSchema.parse(JSON.parse(stripCodeFence(text)));
    output = { assertions: wire.assertions.map(candidate => ({ ...candidate, assertion: decodeAiWireAssertion(candidate.assertion) })) };
  } catch { throw new Error("assertion-output-invalid"); }
  return parseAssertionOutput(JSON.stringify(output), preview);
}

export function parseAssertionOutput(text: string, preview: AiContextPreview): AiAssertionCandidate[] {
  const raw = JSON.parse(text) as { assertions?: Array<{ assertion?: Assertion }> };
  const withIds = { ...raw, assertions: raw.assertions?.map(candidate => ({ ...candidate, assertion: candidate.assertion && { ...candidate.assertion, id: candidate.assertion.id ?? nextId() } })) };
  const parsed = AiAssertionOutputSchema.safeParse(withIds);
  if (!parsed.success) throw new Error("assertion-output-invalid");
  if (parsed.data.assertions.length > (preview.limit ?? 10)) throw new Error("assertion-output-invalid");
  validateAiAssertions(parsed.data.assertions.map(candidate => candidate.assertion), preview);
  const evidence = new Set(preview.evidence.map(item => item.id));
  return parsed.data.assertions.map(candidate => {
    if (candidate.evidenceIds.some(id => !evidence.has(id))) throw new Error("unknown-evidence");
    if (candidate.basis !== preview.assertionContext!.basis) throw new Error("assertion-basis-mismatch");
    if (candidate.basis === "observation" && !candidate.requiresUserJudgment) throw new Error("observation-requires-judgment");
    if (candidate.basis === "contract" && candidate.assertion.target === "status" && candidate.assertion.op === "eq"
      && !preview.assertionContext!.responses.some(response => response.status === candidate.assertion.expected)) throw new Error("contract-expectation-unsupported");
    return { ...candidate, assertion: { ...candidate.assertion, id: nextId() } };
  });
}
