import { collectionScriptRequirements, workflowScriptRequirements, mergeScriptRequirements, compileWorkflowPlan, resolveSuitePlan, prepareDebugExecution, selectCredentialRequests, suiteCaseRequests, workflowPlanRequests, resolveRequestSettings, RequestSettingsOverrideSchema, assertRequestSettingsApplicable, createEvidenceBudget, type ProjectSnapshot, type DebugExecutionPlan, type ResolvedSuitePlan, type CompiledWorkflowPlan, type CredentialRequestSelection, type RequestSettingsOverride, type CoreScriptRequirement, type EvidenceLimits } from "@apicc/core";
import { TaskTargetSchema, ExecutionProfileSchema, type TaskTarget, type ExecutionProfile, type ServerProjectScope } from "../contract/index.js";
import { executionCapabilities } from "./capabilities.js";
import { ProjectAssetsSchema, type ProjectAssets, type ScriptRequirement } from "../contract/index.js";
import { createHash } from "node:crypto";
import { decodeContractProjectFiles, createProjectSnapshot, apiCaseFilePath, collectionMetadataFilePath, folderMetadataFilePath, projectDirectoryPath, type ContractFolder } from "@apicc/core";
import { compileStressPlan, type CompiledStressPlan, type StressCompileOptions } from "@apicc/core";
import { resolveStressExecutionConfig, StressCompiledBindingSchema, StressRunConfigSchema, type StressAdmissionConfiguration, type StressCompiledBinding, type StressRunConfig } from "../contract/index.js";

export interface PreparedProjectFiles {
  readonly prepared: PreparedExecution;
  readonly assets: ProjectAssets;
  readonly scriptRequirements: readonly ScriptRequirement[];
  readonly scriptPlanDigest: string;
}
const hashText = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
/** Shared wire framing: sorted path, NUL, version, NUL, hash, NUL, UTF-8 size, LF. */
export function projectAssetsManifestHash(files: ProjectAssets["files"]): string {
  return hashText([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => `${file.path}\0${file.version}\0${file.hash}\0${file.size}\n`).join(""));
}
/** Recompute from authoritative fixed bytes; this makes no script approval or permit decision. */
export async function prepareProjectFiles(rawAssets: unknown, input: Omit<PrepareExecutionInput, "snapshot">): Promise<PreparedProjectFiles> {
  const assets = ProjectAssetsSchema.parse(rawAssets);
  if (assets.format !== "contract-files-v1") throw new Error("Project format must be contract-files-v1; publish a valid project explicitly");
  const files = new Map<string, string>();
  for (const file of assets.files) {
    if (files.has(file.path)) throw new Error(`Duplicate project file identity: ${file.path}`);
    if (hashText(file.content) !== file.hash || Buffer.byteLength(file.content, "utf8") !== file.size) throw new Error(`Project file hash/bytes mismatch: ${file.path}`);
    files.set(file.path, file.content);
  }
  if (projectAssetsManifestHash(assets.files) !== assets.manifestHash) throw new Error("Project manifest hash mismatch");
  const decoded = await decodeContractProjectFiles(files);
  if (decoded.readOnly || !decoded.project || decoded.problems.length) throw new Error(`Project files cannot execute: ${decoded.problems.map(problem => `${problem.file}: ${problem.message}`).join("; ")}`);
  const project = decoded.project;
  if (project.id !== assets.contractProjectId) throw new Error("Contract project identity mismatch");
  const prepared = prepareExecution({ ...input, snapshot: createProjectSnapshot(project) });
  const sourcePaths = new Map<string, string>();
  const groupId = "00000000-0000-4000-8000-000000000000";
  const prefix = `${projectDirectoryPath(groupId, project.id)}/`;
  for (const collection of project.collections) {
    const location = { groupId, projectId: project.id, collectionId: collection.id };
    const visit = (container: typeof collection | ContractFolder, folderIds: string[]) => {
      const owner = `collection/${collection.id}${folderIds.map(id => `/folder/${id}`).join("")}`;
      const path = folderIds.length ? folderMetadataFilePath(location, folderIds) : collectionMetadataFilePath(location);
      sourcePaths.set(owner, path.slice(prefix.length));
      for (const api of container.apis) for (const testCase of api.cases) {
        sourcePaths.set(`${owner}/api/${api.contract.id}/case/${testCase.id}/scope/${testCase.scope}`, apiCaseFilePath({ ...location, folderIds, apiId: api.contract.id }, testCase.id, testCase.scope).slice(prefix.length));
      }
      for (const folder of container.folders) visit(folder, [...folderIds, folder.id]);
    };
    visit(collection, []);
  }
  for (const workflow of project.workflows) for (const edge of workflow.edges) sourcePaths.set(`workflow/${workflow.id}/edge/${edge.id}`, "project.yaml");
  const fileByPath = new Map(assets.files.map(file => [file.path, file]));
  // Merge Core declarations before source mapping; conflicting stable IDs must not be overwritten.
  const scriptRequirements = mergeScriptRequirements(prepared.scriptRequirements).map(requirement => {
    const path = sourcePaths.get(requirement.location); const file = path && fileByPath.get(path);
    if (!file) throw new Error(`Actual script source file is missing: ${requirement.scriptId}`);
    return { scriptId: requirement.scriptId, contentHash: hashText(requirement.content), kind: requirement.kind, source: { filePath: file.path, fileHash: file.hash } };
  });
  return freeze({ prepared, assets, scriptRequirements, scriptPlanDigest: hashText(JSON.stringify(scriptRequirements)) });
}

export interface DebugSessionScope { serverId: string; scope: ServerProjectScope; submittedByUserId: string; debugSessionId: string }
export interface PrepareExecutionInput {
  snapshot: ProjectSnapshot; target: TaskTarget; profile: ExecutionProfile; environmentId?: string;
  requestSettings?: RequestSettingsOverride; requestSettingsLimits?: RequestSettingsOverride;
  scriptTimeoutMs?: number; maxScriptTimeoutMs?: number; evidenceLimits?: EvidenceLimits;
  debugSessionScope?: DebugSessionScope; requiredCapabilities?: readonly string[];
  stressCompileOptions?: StressCompileOptions;
  /** Agent admission uses authoritative fixed policy plus applied node configuration; never the submitted binding. */
  stressConfig?: { configuration: StressAdmissionConfiguration; run?: unknown };
  /** Local execution has no agent reservation; only Core/project limits and explicit host budgets apply. */
  stressRun?: StressRunConfig;
  expectedStressBinding?: StressCompiledBinding;
}
export interface PreparedExecution {
  readonly snapshot: ProjectSnapshot; readonly target: TaskTarget; readonly profile: ExecutionProfile;
  readonly environmentId?: string; readonly debugPlan?: DebugExecutionPlan; readonly suitePlan?: ResolvedSuitePlan; readonly workflowPlan?: CompiledWorkflowPlan;
  readonly stressPlan?: CompiledStressPlan;
  /** Agent-only final reservation. admissionLimits are bounds, not the actual compiled load. */
  readonly stressBinding?: StressCompiledBinding;
  readonly stressRunConfig?: StressRunConfig;
  readonly selections: readonly CredentialRequestSelection[]; readonly scriptRequirements: readonly CoreScriptRequirement[]; readonly requiredCapabilities: readonly string[];
  readonly requestSettings?: RequestSettingsOverride; readonly scriptTimeoutMs?: number; readonly evidenceLimits?: EvidenceLimits; readonly debugSessionScope?: DebugSessionScope;
}
const owners = new WeakSet<PreparedExecution>();
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
export function assertPreparedExecution(prepared: PreparedExecution): void { if (!owners.has(prepared)) throw new Error("Unknown prepared execution"); }
/** Definition-only preparation. Material providers use the returned exact snapshot and selections. */
export function prepareExecution(input: PrepareExecutionInput): PreparedExecution {
  const target = freeze(TaskTargetSchema.parse(input.target)); const profile = ExecutionProfileSchema.parse(input.profile);
  let snapshot = input.snapshot; let debugPlan: DebugExecutionPlan | undefined; let suitePlan: ResolvedSuitePlan | undefined; let workflowPlan: CompiledWorkflowPlan | undefined;
  let stressPlan: CompiledStressPlan | undefined;
  let stressBinding: StressCompiledBinding | undefined; let stressRunConfig: StressRunConfig | undefined;
  let selections: readonly CredentialRequestSelection[];
  let scriptRequirements: CoreScriptRequirement[];
  const environmentId = target.kind === "debug" ? target.invocation.environmentId : target.kind === "stress" ? target.plan.environmentId ?? input.environmentId : input.environmentId;
  if (target.kind === "debug") {
    debugPlan = prepareDebugExecution(snapshot, target.invocation); snapshot = debugPlan.snapshot; selections = debugPlan.credentialSelections;
    scriptRequirements = collectionScriptRequirements(snapshot, debugPlan.collectionId, { environmentId, caseSelection: debugPlan.caseSelection });
  } else if (target.kind === "suite") {
    suitePlan = resolveSuitePlan(snapshot, target.suiteId, { environmentId, datasetId: target.datasetId, allowDraft: target.allowDraft }); selections = suiteCaseRequests(snapshot, suitePlan);
    scriptRequirements = suitePlan.entries.flatMap(entry => entry.kind === "workflow" ? workflowScriptRequirements(snapshot, entry.workflowId!, suitePlan!.environmentId) : entry.cases.flatMap(({ locator }) => collectionScriptRequirements(snapshot, locator.collectionId, { environmentId: suitePlan!.environmentId, caseSelection: locator })));
  } else if (target.kind === "stress") {
    if (input.environmentId && target.plan.environmentId && input.environmentId !== target.plan.environmentId) throw new Error("Stress environment mismatch");
    stressRunConfig = StressRunConfigSchema.parse(input.stressConfig?.run ?? input.stressRun ?? {});
    if (stressRunConfig.workerCount > target.plan.maxVus) throw new Error("Stress workers exceed maxVus");
    let compileOptions: StressCompileOptions = { ...input.stressCompileOptions, evidenceLimits: input.evidenceLimits ?? input.stressCompileOptions?.evidenceLimits };
    const configured = input.stressConfig;
    const admission = configured && resolveStressExecutionConfig(target.plan, stressRunConfig, configured.configuration);
    if (configured && admission) {
      const { policy, agent } = configured.configuration;
      compileOptions = { limits: { maxVus: Math.min(policy.maxStressVus, agent.maxStressVus), ...admission.effective }, evidenceMaxSamples: policy.stressEvidenceMaxSamples,
        numericMemoryBytes: policy.stressMetricMemoryBytes, evidenceLimits: { bodyBytes: policy.bodyPreviewBytes, valueBytes: policy.valuePreviewBytes, caseBytes: policy.caseEvidenceBytes, reportBytes: policy.reportBytes, workflowMetadataBytes: policy.workflowMetadataBytes } };
    }
    stressPlan = compileStressPlan(snapshot, { ...target.plan, environmentId }, compileOptions);
    if (admission) stressBinding = freeze(StressCompiledBindingSchema.parse({ stage: "compiled-limits", admissionLimits: compileOptions.limits, requested: admission.requested, sources: admission.sources,
      numericMemoryBytes: stressPlan.metricPlan.memory.maxNumericBytes, evidenceMaxSamples: stressPlan.metricPlan.evidence.maxSamples,
      reservation: { ...admission.reservation, requestConcurrency: stressPlan.schedule.effective.maxRequestConcurrency, maxRps: stressPlan.schedule.effective.maxRps } }));
    selections = stressPlan.targets.flatMap(value => [...value.requests]);
    scriptRequirements = stressPlan.targets.flatMap(value => value.workflowId
      ? workflowScriptRequirements(snapshot, value.workflowId, environmentId)
      : value.requests.flatMap(selection => collectionScriptRequirements(snapshot, selection.collectionId, { environmentId, caseSelection: selection })));
  } else {
    workflowPlan = compileWorkflowPlan(snapshot, target.workflowId, { environmentId }); selections = workflowPlanRequests(snapshot, workflowPlan);
    scriptRequirements = workflowScriptRequirements(snapshot, target.workflowId, environmentId);
  }
  const requiredCapabilities = [...new Set([`task:${target.kind}`, ...(target.kind === "stress" ? ["stress:local-workers-v1"] : []), ...selectCredentialRequests(snapshot, selections).map(({ request }) => `protocol:${request.protocol}`), ...(scriptRequirements.length ? ["script:trusted-core"] : [])])].sort();
  const available = executionCapabilities(profile);
  for (const capability of [...requiredCapabilities, ...(input.requiredCapabilities ?? [])]) if (!available.includes(capability)) throw new Error(`Execution profile ${profile} lacks ${capability}${scriptRequirements.length ? `: ${scriptRequirements[0]!.scriptId}` : ""}`);
  const scriptTimeoutMs = input.scriptTimeoutMs ?? 3000; const maximum = input.maxScriptTimeoutMs ?? 10000;
  if (![scriptTimeoutMs, maximum].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647) || scriptTimeoutMs > maximum) throw new Error("scriptTimeoutMs exceeds valid maximum");
  const requestSettings = RequestSettingsOverrideSchema.parse({ ...(target.kind === "debug" ? target.invocation.settings : {}), ...input.requestSettings });
  const limits = RequestSettingsOverrideSchema.parse(input.requestSettingsLimits ?? {});
  for (const selected of selections) {
    const { request } = selectCredentialRequests(snapshot, [selected])[0]!;
    assertRequestSettingsApplicable(request.protocol, selected?.testCase?.requestSettingsOverride ?? {}, requestSettings);
    const settings = resolveRequestSettings(selected?.testCase?.requestSettingsOverride, requestSettings);
    for (const name of Object.keys(limits) as (keyof RequestSettingsOverride)[]) {
      const ceiling = limits[name]!; const actual = settings[name];
      if (typeof ceiling === "number" && typeof actual === "number" ? actual > ceiling : ceiling === false && actual === true) throw new Error(`Request setting ${name} exceeds administrator maximum`);
    }
  }
  if (input.debugSessionScope && target.kind !== "debug") throw new Error("Debug sessions are only valid for debug targets");
  const evidenceLimits = input.evidenceLimits && freeze({ ...input.evidenceLimits });
  if (evidenceLimits) {
    const budget = createEvidenceBudget(evidenceLimits);
    if (budget.bodyBytes > budget.caseBytes || budget.valueBytes > budget.caseBytes || budget.caseBytes > budget.reportBytes || (evidenceLimits.workflowMetadataBytes !== undefined && (!Number.isSafeInteger(evidenceLimits.workflowMetadataBytes) || evidenceLimits.workflowMetadataBytes < 1 || evidenceLimits.workflowMetadataBytes > budget.reportBytes))) throw new Error("Invalid evidence budget hierarchy");
  }
  const prepared = Object.freeze({ snapshot: Object.freeze(snapshot), target, profile, environmentId: suitePlan?.environmentId ?? environmentId, selections: Object.freeze(selections.map(value => Object.freeze({ ...value }))), scriptRequirements: freeze(mergeScriptRequirements(scriptRequirements)), requiredCapabilities: Object.freeze(requiredCapabilities), debugPlan, suitePlan, workflowPlan, stressPlan, stressBinding, stressRunConfig: stressRunConfig && freeze(stressRunConfig),
    requestSettings: freeze(requestSettings), scriptTimeoutMs, evidenceLimits, debugSessionScope: input.debugSessionScope && freeze(structuredClone(input.debugSessionScope)) });
  owners.add(prepared);
  if (input.expectedStressBinding !== undefined) assertStressCompiledBinding(prepared, input.expectedStressBinding);
  return prepared;
}
/** The expected value is a declaration only. Preparation must independently use authoritative node/policy inputs. */
export function assertStressCompiledBinding(prepared: PreparedExecution, expected: unknown): void {
  assertPreparedExecution(prepared);
  const declared = StressCompiledBindingSchema.parse(expected);
  if (!prepared.stressBinding || JSON.stringify(StressCompiledBindingSchema.parse(prepared.stressBinding)) !== JSON.stringify(declared)) throw new Error("Stress compiled binding mismatch; prepare again with the current authoritative configuration");
}
