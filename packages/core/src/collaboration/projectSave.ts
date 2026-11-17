import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import { createProjectAssetContext } from "../assets/context.js";
import { ApiAssetSchema, ApiRequestSchema, ApiTestCaseSchema, type ApiAsset, type ApiRequest, type ApiTestCase } from "../contract/model.js";
import { ContractProjectSchema, type ContractCollection, type ContractFolder, type ContractProject } from "../contract/workspace.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../domain/executionSelection.js";
import { findProjectApi } from "../workflow/references.js";
import { WorkflowSchema } from "../workflow/model.js";

export const ProjectApiTargetSchema = z.object({ collectionId: z.string().uuid(), folderIds: z.array(z.string().uuid()), apiId: z.string().uuid() }).strict();
export type ProjectApiTarget = z.infer<typeof ProjectApiTargetSchema>;
const stamp = z.string().regex(/^[a-f0-9]{64}$/);
export const PhysicalCaseSchema = z.object({ caseId: z.string().min(1), scope: z.string().min(1) }).strict();
const CaseDeletion = PhysicalCaseSchema.extend({ baseline: ApiTestCaseSchema }).strict();
export const ProjectSaveOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api"), target: ProjectApiTargetSchema, baseline: ApiAssetSchema, submitted: ApiAssetSchema, dependencies: stamp }).strict(),
  z.object({ kind: z.literal("case"), target: ProjectApiTargetSchema, baselineRequest: ApiRequestSchema, baseline: ApiTestCaseSchema.nullable(),
    submitted: ApiTestCaseSchema, deletes: z.array(CaseDeletion), dependencies: stamp }).strict(),
  z.object({ kind: z.literal("workflow-create"), workflow: WorkflowSchema }).strict(),
]);
export type ProjectSaveOperation = z.infer<typeof ProjectSaveOperationSchema>;
export type ProjectSaveIntent = { [Kind in ProjectSaveOperation["kind"]]: Omit<Extract<ProjectSaveOperation, { kind: Kind }>, "dependencies"> }[ProjectSaveOperation["kind"]];

export const ProjectSaveConflictSchema = z.object({
  reason: z.enum(["same-field", "dependency-changed", "target-deleted", "identity-changed", "unsupported-change"]),
  area: z.enum(["api", "metadata", "request", "responses", "documentation", "case", "workflow"]),
  field: z.string().optional(),
  physicalCase: PhysicalCaseSchema.optional(),
}).strict();
export type ProjectSaveConflict = z.infer<typeof ProjectSaveConflictSchema>;
export type ProjectSaveDecision = { status: "ready"; project: ContractProject; changed: boolean }
  | { status: "conflict"; conflict: ProjectSaveConflict };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, entry]) => [name, canonical(entry)]));
  return value;
}

export function sameProjectSaveValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fingerprint = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(canonical(value)))));
const caseKey = (item: ApiTestCase) => JSON.stringify([item.id, item.scope]);
const physicalKey = (item: { caseId: string; scope: string }) => JSON.stringify([item.caseId, item.scope]);
const identityOf = (item: ApiTestCase) => ({ caseId: item.id, scope: item.scope });

function findTarget(project: ContractProject, target: ProjectApiTarget) {
  const [collection, duplicate] = project.collections.filter(item => item.id === target.collectionId);
  if (!collection || duplicate) return;
  let container: ContractCollection | ContractFolder = collection;
  const folders: ContractFolder[] = [];
  for (const id of target.folderIds) {
    const matches: ContractFolder[] = container.folders.filter(item => item.id === id);
    if (matches.length !== 1) return;
    const folder = matches[0]!;
    folders.push(folder);
    container = folder;
  }
  const index = container.apis.findIndex(item => item.contract.id === target.apiId);
  if (index < 0 || container.apis.filter(item => item.contract.id === target.apiId).length !== 1) return;
  return { asset: container.apis[index]!, index, container, collection, folders };
}

export function findProjectSaveApi(project: ContractProject, target: ProjectApiTarget): ApiAsset | undefined {
  return findTarget(project, target)?.asset;
}

function assetReferences(project: ContractProject, asset: ApiAsset): unknown {
  const closure = createProjectAssetContext({ projectId: project.id, assets: [clone(asset)], models: clone(project.models),
    components: clone(project.components), datasets: clone(project.datasets ?? []) }).dependencyClosure(asset.contract.id);
  const byId = <T extends { id: string }>(values: T[]) => values.sort((left, right) => left.id.localeCompare(right.id));
  return [byId(closure.models), byId(closure.components), byId(closure.datasets ?? [])];
}

const referenceFreeRequest = ApiRequestSchema.parse({
  protocol: "http", method: "GET", path: "/", baseUrl: "", pathParams: [], query: [], headers: [], cookies: [],
  auth: { kind: "none" }, body: { kind: "none" },
});

/** Freeze only definitions this edit actually uses. A project version is not a draft baseline. */
export function projectSaveDependencies(project: ContractProject, operation: ProjectSaveIntent): string {
  if (operation.kind === "workflow-create") return fingerprint([]);
  const current = findTarget(project, operation.target);
  if (!current) return fingerprint(null);
  if (operation.kind === "api") {
    const { baseline, submitted } = operation;
    if (baseline.contract.metadata.status !== submitted.contract.metadata.status && submitted.contract.metadata.status === "published") {
      return fingerprint(assetReferences(project, submitted));
    }
    const relevantRequest = !sameProjectSaveValue(baseline.contract.request, submitted.contract.request);
    const relevantResponses = !sameProjectSaveValue(baseline.contract.responses, submitted.contract.responses);
    if (!relevantRequest && !relevantResponses) return fingerprint([]);
    const narrow = (asset: ApiAsset): ApiAsset => ({ ...asset, cases: [], contract: {
      ...asset.contract, request: relevantRequest ? asset.contract.request : referenceFreeRequest,
      responses: relevantResponses ? asset.contract.responses : [],
    } });
    return fingerprint([assetReferences(project, narrow(baseline)), assetReferences(project, narrow(submitted))]);
  }
  const cases = [operation.baseline, operation.submitted, ...operation.deletes.map(item => item.baseline)].filter(item => item !== null);
  // Compare affected scopes using the captured variants. An unrelated variant in
  // a newer project is a distinct write unit, even when it shares the same ID.
  const candidates = [...new Map(cases.map(item => [caseKey(item), item])).values()];
  const environments = project.environments.flatMap(environment => {
    const resolved = resolveExecutionEnvironment(project, current.collection.id, environment.id);
    const effective = selectEffectiveCases(candidates, resolved.chain).map(caseKey);
    return effective.length ? [{ id: environment.id, chain: resolved.chain, variables: resolved.variables, effective: effective.sort() }] : [];
  }).sort((left, right) => left.id.localeCompare(right.id));
  return fingerprint([
    cases.map(testCase => assetReferences(project, { ...current.asset, contract: { ...current.asset.contract,
      request: testCase.requestOverride ?? operation.baselineRequest, responses: [] }, cases: [testCase] })),
    environments,
    project.variables, project.globals, current.collection.variables,
    [current.collection, ...current.folders].map(item => [item.preOperations, item.postOperations]),
  ]);
}

type Conflict = ProjectSaveConflict;
function refuse(reason: Conflict["reason"], area: Conflict["area"], field?: string, physicalCase?: Conflict["physicalCase"]): ProjectSaveDecision {
  return { status: "conflict", conflict: { reason, area, ...(field ? { field } : {}), ...(physicalCase ? { physicalCase } : {}) } };
}

class FieldConflict extends Error {
  constructor(readonly area: Conflict["area"], readonly field: string, readonly physicalCase?: Conflict["physicalCase"]) { super(field); }
}

function mergeValue<T>(baseline: T, submitted: T, current: T, area: Conflict["area"], field: string, physicalCase?: Conflict["physicalCase"], confirmed = false): T {
  if (sameProjectSaveValue(baseline, submitted)) return current;
  if (confirmed || sameProjectSaveValue(current, submitted) || sameProjectSaveValue(current, baseline)) return submitted;
  throw new FieldConflict(area, field, physicalCase);
}

const parameterFields = new Set(["pathParams", "query", "headers", "cookies"]);
function mergeFields<T extends object>(baseline: T, submitted: T, current: T, area: Conflict["area"], physicalCase?: Conflict["physicalCase"], confirmed = false): T {
  const base = baseline as Record<string, unknown>, mine = submitted as Record<string, unknown>, remote = current as Record<string, unknown>;
  const fields = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(remote)]);
  const result: Array<[string, unknown]> = [];
  for (const field of fields) {
    const [before, after, latest] = [base[field], mine[field], remote[field]];
    const ids = (values: unknown[]) => values.map(item => (item as { id?: string }).id);
    let value: unknown;
    if (area === "request" && parameterFields.has(field) && Array.isArray(before) && Array.isArray(after) && Array.isArray(latest)
      && sameProjectSaveValue(ids(before), ids(after)) && sameProjectSaveValue(ids(before), ids(latest))) {
      value = before.map((row, index) => mergeValue(row, after[index], latest[index], area, field, undefined, confirmed));
    } else value = mergeValue(before, after, latest, area, field, physicalCase, confirmed);
    if (value !== undefined) result.push([field, value]);
  }
  return Object.fromEntries(result) as T;
}

function mergeRequest(baseline: ApiRequest, submitted: ApiRequest, current: ApiRequest, confirmed: boolean): ApiRequest {
  if (baseline.protocol !== submitted.protocol || baseline.protocol !== current.protocol) {
    return mergeValue(baseline, submitted, current, "request", "protocol", undefined, confirmed);
  }
  return mergeFields(baseline, submitted, current, "request", undefined, confirmed);
}

function inheritingCases(api: ApiAsset) {
  return api.cases.filter(item => !item.requestOverride).slice().sort((left, right) => caseKey(left).localeCompare(caseKey(right)));
}

/** Project only the declared write unit(s), whether into a latest server copy
 * for submission or an already applied client copy after confirmation. */
export function applyProjectSave(project: ContractProject, operation: ProjectSaveOperation, options: { projection?: boolean } = {}): ProjectSaveDecision {
  const next = clone(project);
  const confirmed = options.projection === true;
  if (operation.kind === "workflow-create") {
    const workflow = operation.workflow;
    if (workflow.status !== "draft" || workflow.nodes.length || workflow.edges.length) return refuse("unsupported-change", "workflow");
    const found = next.workflows.find(item => item.id === workflow.id);
    if (found) return sameProjectSaveValue(found, workflow) ? { status: "ready", project, changed: false } : refuse("identity-changed", "workflow");
    next.workflows.push(clone(workflow));
    return { status: "ready", project: ContractProjectSchema.parse(next), changed: true };
  }
  const found = findTarget(next, operation.target);
  if (!found) return refuse(findProjectApi(project, operation.target.apiId) ? "identity-changed" : "target-deleted", "api");
  const latest = found.asset;
  if (!confirmed && projectSaveDependencies(project, operation) !== operation.dependencies) {
    return refuse("dependency-changed", operation.kind === "case" ? "case" : "api", undefined,
      operation.kind === "case" ? identityOf(operation.submitted) : undefined);
  }
  try {
    if (operation.kind === "api") {
      const { baseline, submitted } = operation;
      if (baseline.contract.id !== operation.target.apiId || submitted.contract.id !== operation.target.apiId) return refuse("identity-changed", "api");
      if (!sameProjectSaveValue(baseline.cases, submitted.cases)) return refuse("unsupported-change", "case");
      const { metadata: baseMetadata, request: baseRequest, responses: baseResponses, ...baseRest } = baseline.contract;
      const { metadata, request, responses, ...rest } = submitted.contract;
      const { metadata: oldMetadata, request: oldRequest, responses: oldResponses, ...oldRest } = latest.contract;
      const mergedRequest = mergeRequest(baseRequest, request, oldRequest, confirmed);
      const requestChanged = !sameProjectSaveValue(mergedRequest, oldRequest);
      if (!confirmed && requestChanged && !sameProjectSaveValue(inheritingCases(baseline), inheritingCases(latest))) {
        return refuse("dependency-changed", "request");
      }
      if (!confirmed && requestChanged && latest.cases.some(item => item.requestOverride && item.requestOverride.protocol !== mergedRequest.protocol)) {
        return refuse("dependency-changed", "request", "protocol");
      }
      found.container.apis[found.index] = ApiAssetSchema.parse({ ...latest, contract: {
        ...mergeFields(baseRest, rest, oldRest, "api", undefined, confirmed),
        metadata: mergeFields(baseMetadata, metadata, oldMetadata, "metadata", undefined, confirmed),
        request: mergedRequest, responses: mergeValue(baseResponses, responses, oldResponses, "responses", "responses", undefined, confirmed),
      }, documentation: mergeValue(baseline.documentation, submitted.documentation, latest.documentation, "documentation", "documentation", undefined, confirmed) });
    } else {
      const target = identityOf(operation.submitted);
      const targetKey = physicalKey(target);
      const deletes = new Set(operation.deletes.map(physicalKey));
      if (deletes.size !== operation.deletes.length || deletes.has(targetKey)
        || (operation.baseline && caseKey(operation.baseline) !== targetKey)
        || operation.deletes.some(item => caseKey(item.baseline) !== physicalKey(item))) return refuse("identity-changed", "case", undefined, target);
      const old = latest.cases.find(item => caseKey(item) === targetKey);
      if (!confirmed && operation.baseline && !old) return refuse("target-deleted", "case", undefined, target);
      const dependsOnDefault = !operation.submitted.requestOverride || (operation.baseline && !operation.baseline.requestOverride)
        || operation.deletes.some(item => !item.baseline.requestOverride);
      if (!confirmed && ((dependsOnDefault && !sameProjectSaveValue(operation.baselineRequest, latest.contract.request))
        || (operation.submitted.requestOverride && operation.submitted.requestOverride.protocol !== latest.contract.request.protocol))) {
        return refuse("dependency-changed", "request", undefined, target);
      }
      for (const deletion of operation.deletes) {
        const existing = latest.cases.find(item => caseKey(item) === physicalKey(deletion));
        if (!confirmed && existing && !sameProjectSaveValue(deletion.baseline, existing)) return refuse("same-field", "case", "delete", identityOf(existing));
      }
      const stored = old && operation.baseline
        ? mergeFields(operation.baseline, operation.submitted, old, "case", target, confirmed)
        : mergeValue(undefined, operation.submitted, old, "case", "case", target, confirmed)!;
      latest.cases = latest.cases.filter(item => !deletes.has(caseKey(item)));
      const index = latest.cases.findIndex(item => caseKey(item) === targetKey);
      if (index < 0) latest.cases.push(stored); else latest.cases[index] = stored;
    }
    const output = ContractProjectSchema.parse(next);
    return { status: "ready", project: output, changed: !sameProjectSaveValue(project, output) };
  } catch (error) {
    if (!(error instanceof FieldConflict)) throw error;
    return refuse("same-field", error.area, error.field, error.physicalCase);
  }
}
