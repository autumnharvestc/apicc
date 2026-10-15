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
  DebugIdentitySchema, DebugInvocationSchema, DebugResultSchema,
  type DebugCaseIdentity, type DebugExecutionIdentity, type DebugFieldState, type DebugInvocation, type DebugResult, type DebugSourceCategory,
} from "./model.js";
import { createDebugExchangeCollector, projectDebugResult } from "./projection.js";

export interface DebugExecutionPlan {
  readonly invocation: DebugInvocation;
  readonly snapshot: ProjectSnapshot;
  readonly sourceApiRevision: string;
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
  DebugIdentitySchema.parse(invocation.locator);
  if (invocation.settings !== undefined) RequestSettingsOverrideSchema.parse(invocation.settings);
  if (invocation.locator.projectId !== snapshot.project.id) throw new TypeError("The debug locator does not belong to the supplied project snapshot.");
  const collection = snapshot.project.collections.find((candidate) => candidate.id === invocation.locator.collectionId);
  if (!collection) throw new TypeError(`Debug collection ${invocation.locator.collectionId} is not in the supplied project snapshot.`);
  const sourceAsset = findApi(collection as unknown as ContractCollection, invocation.locator.folderIds, invocation.locator.apiId);
  const sourceApiRevision = getSourceApiRevision(sourceAsset);
  const environment = invocation.environmentId === undefined
    ? undefined
    : snapshot.project.environments.find((candidate) => candidate.id === invocation.environmentId);
  if (invocation.environmentId !== undefined && !environment) {
    throw new TypeError(`Debug environment ${invocation.environmentId} is not in the supplied project snapshot.`);
  }
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

function assertRequestFieldsReady(invocation: DebugInvocation): void {
  if (invocation.mode !== "request") return;
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
    observeHttp: (event, identity) => collector.observe(event, {
      ...plan.invocation.locator,
      caseId: identity.caseId,
      scope: identity.scope,
      rowIndex: identity.rowIndex,
      settings: identity.settings,
      parameters: identity.parameters,
      fields: plan.fields,
      sourceCategories: plan.sourceCategories,
    }),
    observeCaseExecution: (execution, identity) => collector.observeExecution(execution, {
      ...plan.invocation.locator,
      caseId: identity.caseId,
      scope: identity.scope,
      rowIndex: identity.rowIndex,
      settings: identity.settings,
      parameters: identity.parameters,
      fields: plan.fields,
      sourceCategories: plan.sourceCategories,
    }),
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
    run,
    collector,
    markers: collector.markers(),
    projectionReliable: collector.projectionReliable(),
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

function sameLocator(left: DebugInvocation["locator"], right: DebugCaseIdentity): boolean {
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
