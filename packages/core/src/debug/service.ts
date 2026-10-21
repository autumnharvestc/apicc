import { createHash, randomUUID } from "node:crypto";
import { cloneDefinitionValue } from "../assets/context.js";
import { createProjectSnapshot, type ProjectSnapshot } from "../assets/snapshot.js";
import type { ApiAsset, ApiRequest } from "../contract/model.js";
import type { ContractCollection, ContractFolder, ContractProject } from "../contract/workspace.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../domain/executionSelection.js";
import { getEffectiveCaseRequest } from "../request/effective.js";
import type { TestCase } from "../domain/common.js";
import { createEventBus } from "../events/bus.js";
import type { HttpSession } from "../http/session.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { CredentialRequestSelection } from "../credentials/output.js";
import type { ProjectExecutionRun, RunnerOptions } from "../runner/runner.js";
import { CollectionRunner, CollectionRunError } from "../runner/runner.js";
import type { RunResult } from "../report/types.js";
import { RequestSettingsOverrideSchema } from "../request/settings.js";
import {
  DebugIdentitySchema, DebugInvocationSchema, DebugProjectIdentitySchema, DebugResultSchema,
  type DebugCaseIdentity, type DebugExecutionIdentity, type DebugFieldState, type DebugIdentity, type DebugInvocation, type DebugProjectIdentity,
  type DebugResult, type DebugResultSource, type DebugSourceCategory,
} from "./model.js";
import { createDebugExchangeCollector, projectDebugResult } from "./projection.js";
import { createExecutionEvidenceCollector } from "../report/evidence.js";

type DebugAssetInvocation = Exclude<DebugInvocation, { mode: "free" }>;
type DebugFreeInvocation = Extract<DebugInvocation, { mode: "free" }>;

interface DebugExecutionPlanBase {
  readonly snapshot: ProjectSnapshot;
  readonly sourceProjectRevision: string;
  readonly executionSnapshotRevision: string;
  readonly collectionId: string;
  readonly collectionName: string;
  readonly requestTemplate: ApiRequest;
  readonly sourceCategories: readonly DebugSourceCategory[];
  readonly baseParameters: Readonly<Record<string, string>>;
  readonly fields: readonly DebugFieldState[];
  readonly environmentName?: string;
  readonly credentialSelections: readonly CredentialRequestSelection[];
  readonly caseSelection: { apiId: string; caseId: string; folderIds: readonly string[] };
}

export interface DebugAssetExecutionPlan extends DebugExecutionPlanBase {
  readonly invocation: DebugAssetInvocation;
  readonly source: Extract<DebugResultSource, { sourceKind: "asset" }>;
  readonly sourceApiRevision: string;
}

export interface DebugFreeExecutionPlan extends DebugExecutionPlanBase {
  readonly invocation: DebugFreeInvocation;
  readonly source: Extract<DebugResultSource, { sourceKind: "free" }>;
  readonly draftRevision: string;
}

export type DebugExecutionPlan = DebugAssetExecutionPlan | DebugFreeExecutionPlan;

export interface RunDebugExecutionOptions {
  registry: PluginRegistry;
  workspaceRoot?: string;
  httpSession?: HttpSession;
  signal?: AbortSignal;
  credentialMarkers?: readonly string[];
}

/** Build the exact immutable snapshot and credential selection for one debug invocation. */
export function prepareDebugExecution(snapshot: ProjectSnapshot, invocationValue: DebugInvocation): DebugExecutionPlan {
  const invocation = DebugInvocationSchema.parse(invocationValue);
  assertRequestFieldsReady(invocation);
  if (invocation.settings !== undefined) RequestSettingsOverrideSchema.parse(invocation.settings);
  return invocation.mode === "free"
    ? prepareFreeExecution(snapshot, invocation)
    : prepareAssetExecution(snapshot, invocation);
}

function prepareAssetExecution(snapshot: ProjectSnapshot, invocation: DebugAssetInvocation): DebugAssetExecutionPlan {
  DebugIdentitySchema.parse(invocation.locator);
  if (invocation.locator.projectId !== snapshot.project.id) throw new TypeError("The debug locator does not belong to the supplied project snapshot.");
  const collection = snapshot.project.collections.find((candidate) => candidate.id === invocation.locator.collectionId);
  if (!collection) throw new TypeError(`Debug collection ${invocation.locator.collectionId} is not in the supplied project snapshot.`);
  const sourceAsset = findApi(collection as unknown as ContractCollection, invocation.locator.folderIds, invocation.locator.apiId);
  const sourceApiRevision = getSourceApiRevision(sourceAsset);
  const environment = findEnvironment(snapshot, invocation.environmentId);
  const chain = resolveExecutionEnvironment(snapshot.project, collection.id, environment?.id).chain;
  const mutableProject = cloneDefinitionValue(snapshot.project) as unknown as ContractProject;
  const mutableCollection = mutableProject.collections.find((candidate) => candidate.id === invocation.locator.collectionId)!;
  const mutableAsset = findApi(mutableCollection, invocation.locator.folderIds, invocation.locator.apiId);
  let selectedCase: TestCase;
  let requestTemplate: ApiRequest;
  let baseParameters: Readonly<Record<string, string>>;
  let fields: readonly DebugFieldState[];
  let requestOverrideSelected = invocation.mode === "request";

  if (invocation.mode === "request") {
    mutableAsset.contract.request = cloneDefinitionValue(invocation.request) as ApiRequest;
    mutableAsset.cases = [{
      id: "__debug_request__",
      name: "Debug request",
      scope: "base",
      parameters: { ...invocation.parameters },
      preOperations: [],
      postOperations: [],
      assertions: [],
    }];
    selectedCase = mutableAsset.cases[0]!;
    requestTemplate = cloneDefinitionValue(invocation.request) as ApiRequest;
    baseParameters = Object.freeze({ ...invocation.parameters });
    fields = Object.freeze(invocation.fields.map((field) => ({ ...field })));
  } else {
    if (!sameLocator(invocation.locator, invocation.case)) throw new TypeError("The case identity must match the debug locator.");
    const effective = selectEffectiveCases(sourceAsset.cases, chain, invocation.case.caseId)[0];
    if (!effective) throw new TypeError(`Debug case ${invocation.case.caseId} is not effective in the selected environment.`);
    if (effective.scope !== invocation.case.scope) throw new TypeError("The case identity scope is not the current effective case scope.");
    const selected = mutableAsset.cases.find((candidate) => candidate.id === effective.id && candidate.scope === effective.scope);
    if (!selected) throw new TypeError("The selected effective case was not found in the cloned project snapshot.");
    selectedCase = selected;
    requestTemplate = cloneDefinitionValue(getEffectiveCaseRequest(sourceAsset, effective)) as ApiRequest;
    requestOverrideSelected = effective.requestOverride !== undefined;
    baseParameters = Object.freeze({ ...effective.parameters });
    fields = Object.freeze([]);
  }

  const sourceCategories: DebugSourceCategory[] = ["project"];
  if (environment !== undefined) sourceCategories.push("environment");
  if (requestOverrideSelected) sourceCategories.push("request-override");
  if (containsComponentReference(requestTemplate)) sourceCategories.push("module");
  if (requestTemplate.auth.kind !== "none") sourceCategories.push("auth");

  const executionSnapshot = createProjectSnapshot(mutableProject);
  const executionAsset = findApi(
    executionSnapshot.project.collections.find((candidate) => candidate.id === invocation.locator.collectionId)! as unknown as ContractCollection,
    invocation.locator.folderIds,
    invocation.locator.apiId,
  );
  const executionCase = executionAsset.cases.find((candidate) => candidate.id === selectedCase.id && candidate.scope === selectedCase.scope);
  if (!executionCase) throw new TypeError("The selected debug case is not present in the execution snapshot.");

  return Object.freeze({
    invocation,
    snapshot: executionSnapshot,
    source: Object.freeze({ sourceKind: "asset", locator: invocation.locator, sourceApiRevision }),
    sourceApiRevision,
    sourceProjectRevision: snapshot.definitionRevision,
    executionSnapshotRevision: executionSnapshot.definitionRevision,
    collectionId: collection.id,
    collectionName: collection.name,
    requestTemplate,
    sourceCategories: Object.freeze(sourceCategories),
    baseParameters,
    fields,
    ...(environment === undefined ? {} : { environmentName: environment.name }),
    credentialSelections: Object.freeze([{ asset: executionAsset, testCase: executionCase }]),
    caseSelection: Object.freeze({
      apiId: invocation.locator.apiId,
      caseId: executionCase.id,
      folderIds: Object.freeze([...invocation.locator.folderIds]),
    }),
  });
}

function prepareFreeExecution(snapshot: ProjectSnapshot, invocation: DebugFreeInvocation): DebugFreeExecutionPlan {
  const projectIdentity: DebugProjectIdentity = DebugProjectIdentitySchema.parse(invocation.project);
  if (projectIdentity.projectId !== snapshot.project.id) throw new TypeError("The free request project does not belong to the supplied project snapshot.");
  const environment = findEnvironment(snapshot, invocation.environmentId);
  const temporaryCollectionId = randomUUID();
  const temporaryApiId = randomUUID();
  const temporaryCaseId = randomUUID();
  const chain = resolveExecutionEnvironment(snapshot.project, temporaryCollectionId, environment?.id).chain;
  const mutableProject = cloneDefinitionValue(snapshot.project) as unknown as ContractProject;
  const temporaryCase: TestCase = {
    id: temporaryCaseId,
    name: "Free request",
    scope: "base",
    parameters: { ...invocation.parameters },
    preOperations: [],
    postOperations: [],
    assertions: [],
  };
  const temporaryAsset: ApiAsset = {
    contract: {
      formatVersion: 1,
      id: temporaryApiId,
      metadata: { name: "Free request", description: "", tags: [], version: "1", status: "draft" },
      request: cloneDefinitionValue(invocation.request) as ApiRequest,
      responses: [],
    },
    cases: [temporaryCase],
    documentation: "",
  };
  const temporaryCollection: ContractCollection = {
    id: temporaryCollectionId,
    name: "Free request",
    variables: {},
    preOperations: [],
    postOperations: [],
    folders: [],
    apis: [temporaryAsset],
  };
  mutableProject.collections.push(temporaryCollection);

  const executionSnapshot = createProjectSnapshot(mutableProject);
  const executionCollection = executionSnapshot.project.collections.find((candidate) => candidate.id === temporaryCollectionId);
  const executionAsset = executionCollection?.apis[0];
  const executionCase = executionAsset?.cases[0];
  if (!executionCollection || !executionAsset || !executionCase) throw new TypeError("The temporary free request was not present in the execution snapshot.");

  const draftRevision = getFreeDraftRevision(invocation);
  const requestTemplate = cloneDefinitionValue(invocation.request) as ApiRequest;
  const sourceCategories: DebugSourceCategory[] = ["project"];
  if (environment !== undefined) sourceCategories.push("environment");
  sourceCategories.push("request-override");
  if (containsComponentReference(requestTemplate)) sourceCategories.push("module");
  if (requestTemplate.auth.kind !== "none") sourceCategories.push("auth");

  return Object.freeze({
    invocation,
    snapshot: executionSnapshot,
    source: Object.freeze({ sourceKind: "free", project: projectIdentity, draftId: invocation.draftId, draftRevision }),
    draftRevision,
    sourceProjectRevision: snapshot.definitionRevision,
    executionSnapshotRevision: executionSnapshot.definitionRevision,
    collectionId: temporaryCollection.id,
    collectionName: temporaryCollection.name,
    requestTemplate,
    sourceCategories: Object.freeze(sourceCategories),
    baseParameters: Object.freeze({ ...invocation.parameters }),
    fields: Object.freeze(invocation.fields.map((field) => ({ ...field }))),
    ...(environment === undefined ? {} : { environmentName: environment.name }),
    credentialSelections: Object.freeze([{ asset: executionAsset, testCase: executionCase }]),
    caseSelection: Object.freeze({
      apiId: temporaryApiId,
      caseId: temporaryCaseId,
      folderIds: Object.freeze([]),
    }),
  });
}

function findEnvironment(snapshot: ProjectSnapshot, environmentId: string | undefined) {
  const environment = environmentId === undefined
    ? undefined
    : snapshot.project.environments.find((candidate) => candidate.id === environmentId);
  if (environmentId !== undefined && !environment) {
    throw new TypeError(`Debug environment ${environmentId} is not in the supplied project snapshot.`);
  }
  return environment;
}

function getFreeDraftRevision(invocation: DebugFreeInvocation): string {
  return stableHash({
    request: invocation.request,
    parameters: invocation.parameters,
    fields: invocation.fields,
    ...(invocation.environmentId === undefined ? {} : { environmentId: invocation.environmentId }),
    ...(invocation.settings === undefined ? {} : { settings: invocation.settings }),
  });
}

function assertRequestFieldsReady(invocation: DebugInvocation): void {
  if (invocation.mode !== "request" && invocation.mode !== "free") return;
  const pendingConsumedField = invocation.fields.some((field) => field.needsInput
    && (field.path === "request" || field.path.startsWith("request.")
      || field.path === "parameters" || field.path.startsWith("parameters.")));
  if (pendingConsumedField) throw new TypeError("Debug request fields need user input before execution.");
}

/** Execute all selected rows through CollectionRunner and project only safe, bounded observations. */
export async function runDebugExecution(
  plan: DebugExecutionPlan,
  preparedRun: ProjectExecutionRun,
  options: RunDebugExecutionOptions,
  runId = randomUUID(),
): Promise<DebugResult> {
  if (preparedRun.snapshot !== plan.snapshot) throw new TypeError("Credential preparation must use the exact debug execution snapshot.");
  const startedAt = new Date().toISOString();
  const collector = createDebugExchangeCollector(options.credentialMarkers ?? []);
  const evidence = createExecutionEvidenceCollector({ projectId: plan.snapshot.project.id, definitionRevision: plan.sourceProjectRevision, environmentId: plan.invocation.environmentId, dataDigest: preparedRun.preparedTestData?.digest }, options.credentialMarkers ?? []);
  const runner = new CollectionRunner({
    registry: options.registry,
    bus: createEventBus(),
    timeouts: { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    requestSettings: plan.invocation.settings,
    failFast: false,
  });
  const runOptions: RunnerOptions = {
    ...(plan.invocation.environmentId === undefined ? {} : { environmentId: plan.invocation.environmentId }),
    caseSelection: plan.caseSelection,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    ...(options.httpSession === undefined ? {} : { httpSession: options.httpSession }),
    observeHttp: (event, identity) => collector.observe(event, observationIdentity(plan, identity)),
    observeCaseExecution: (execution, identity) => {
      evidence.observe(execution, identity);
      // A legacy response still counts after the display cap, even when its combined
      // Cookie header cannot provide a complete marker set. Never export a partial set.
      if (!evidence.boundary().businessUnavailable) collector.addMarkers(evidence.markers());
      collector.observeExecution(execution, observationIdentity(plan, identity));
    },
  };
  let run: RunResult;
  let containerFailure: CollectionRunError | undefined;
  try {
    run = await runner.run(preparedRun, plan.collectionId, runOptions);
  } catch (error) {
    if (!(error instanceof CollectionRunError)) throw error;
    run = error.partialResult;
    containerFailure = error;
  }
  const result = projectDebugResult({
    plan,
    runId,
    run: evidence.projectRun(run),
    collector,
    markers: collector.markers(),
    projectionReliable: collector.projectionReliable() && !evidence.boundary().businessUnavailable,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(containerFailure === undefined ? {} : {
      failureKind: containerFailure.failureKind,
      error: containerFailure.message,
      errorName: containerFailure.name,
    }),
  });
  return DebugResultSchema.parse(result);
}

function observationIdentity(
  plan: DebugExecutionPlan,
  identity: { caseId: string; scope: string; rowIndex: number; settings: DebugExecutionIdentity["settings"]; parameters?: Readonly<Record<string, string>> },
): DebugExecutionIdentity {
  const common = {
    rowIndex: identity.rowIndex,
    settings: identity.settings,
    ...(identity.parameters === undefined ? {} : { parameters: identity.parameters }),
    fields: plan.fields,
    sourceCategories: plan.sourceCategories,
  };
  if (plan.source.sourceKind === "asset") return {
    ...common,
    source: {
      sourceKind: "asset",
      case: {
        ...plan.source.locator,
        caseId: identity.caseId,
        scope: identity.scope,
      },
    },
  };
  return {
    ...common,
    source: { sourceKind: "free", project: plan.source.project, draftId: plan.source.draftId },
  };
}

/** Safe completion for cancellation that wins while the host is still preparing credentials. */
export function abortedDebugResult(
  plan: DebugExecutionPlan,
  runId: string,
  startedAt: string,
  options: { markers?: readonly string[]; projectionReliable?: boolean } = {},
): DebugResult {
  const finishedAt = new Date().toISOString();
  const emptyRun: RunResult = {
    collectionId: plan.collectionId,
    collectionName: plan.collectionName,
    ...(plan.environmentName === undefined ? {} : { envName: plan.environmentName }),
    startedAt,
    finishedAt,
    total: 0,
    passed: 0,
    failed: 0,
    cases: [],
  };
  const result = projectDebugResult({
    plan,
    runId,
    run: emptyRun,
    collector: createDebugExchangeCollector(options.markers ?? []),
    markers: options.markers ?? [],
    projectionReliable: options.projectionReliable ?? false,
    startedAt,
    finishedAt,
    failureKind: "aborted",
  });
  return DebugResultSchema.parse(result);
}

/** Terminal result for a host-side failure after start has authorized and allocated a run. */
export function failedDebugResult(
  plan: DebugExecutionPlan,
  runId: string,
  startedAt: string,
  error: unknown,
  options: {
    failureKind: NonNullable<DebugResult["failureKind"]>;
    markers?: readonly string[];
    projectionReliable?: boolean;
  },
): DebugResult {
  const finishedAt = new Date().toISOString();
  const emptyRun: RunResult = {
    collectionId: plan.collectionId,
    collectionName: plan.collectionName,
    ...(plan.environmentName === undefined ? {} : { envName: plan.environmentName }),
    startedAt,
    finishedAt,
    total: 0,
    passed: 0,
    failed: 0,
    cases: [],
  };
  const result = projectDebugResult({
    plan,
    runId,
    run: emptyRun,
    collector: createDebugExchangeCollector(options.markers ?? []),
    markers: options.markers ?? [],
    projectionReliable: options.projectionReliable ?? false,
    startedAt,
    finishedAt,
    failureKind: options.failureKind,
    error,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return DebugResultSchema.parse(result);
}

function containsComponentReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsComponentReference);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.kind === "componentRef" || Object.values(record).some(containsComponentReference);
}

function findApi(
  collection: ContractCollection,
  folderIds: readonly string[],
  apiId: string,
): ApiAsset {
  let folders: readonly ContractFolder[] = collection.folders;
  let container: Pick<ContractCollection, "apis"> | Pick<ContractFolder, "apis"> = collection;
  for (const folderId of folderIds) {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder) throw new TypeError(`Debug folder ${folderId} is not in the selected collection path.`);
    container = folder;
    folders = folder.folders;
  }
  const asset = container.apis.find((candidate) => candidate.contract.id === apiId);
  if (!asset) throw new TypeError(`Debug API ${apiId} is not in the selected container.`);
  return asset as ApiAsset;
}

function sameLocator(left: DebugIdentity, right: DebugCaseIdentity): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId
    && left.projectId === right.projectId && left.collectionId === right.collectionId
    && left.apiId === right.apiId && left.folderIds.length === right.folderIds.length
    && left.folderIds.every((id, index) => id === right.folderIds[index]);
}

/** Stable hash used by the debug source and desktop draft-save transactions. */
export function getSourceApiRevision(value: ApiAsset): string {
  return stableHash(value);
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableCanonical(value), "utf8").digest("hex");
}

function stableCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableCanonical(item)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Debug source revisions require JSON-compatible assets.");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableCanonical(object[key])}`).join(",")}}`;
}
