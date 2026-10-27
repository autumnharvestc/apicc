import { createHash } from "node:crypto";
import { prepareTestData, testDataSelectionsForRequests, selectCredentialRequests, prepareNetworkRun, type HttpSession, type NetworkTLSSettings, type PreparedNetworkRun } from "@apicc/core";
import { prepareProjectFiles, createOnlineProjectSecretStore, prepareRunCredentials, withRunCredentials, withDeclaredInputFiles, type ExecutionMaterials, type InvocationOutput, invokeExecution, type DebugSessionScope, type PreparedProjectFiles } from "@apicc/execution/host";
import { ExecutionInputsSchema, ProjectRunMaterialsSchema, executionInputsDigestText, logicalNetworkPath, runtimeCompatibilityIdForRuntime, type ExecutionInputs, type ProjectRunMaterials, type TaskEnvelopeV1, type PolicyConfig, type AgentCommandV1 } from "@apicc/execution/contract";
import type { BuildIdentity } from "@apicc/execution/buildIdentity";
export type StartPermit = Extract<AgentCommandV1, { kind: "start-permit" }>;
export interface InvocationDTO { task: TaskEnvelopeV1; inputs: ExecutionInputs; materials: ProjectRunMaterials; serverId: string; minFreeDiskBytes: number; runtimeCompatibilityId: string }
export interface PreparedMetadata { project: PreparedProjectFiles; credentialVersions: Readonly<Record<string, string>>; inputBytes: number }
/** Public localization keys only: exception text, material values and host paths never cross the control boundary. */
export type PreparationReasonCode = "runtime-mismatch" | "script-admission-denied" | "fixed-input-mismatch" | "policy-mismatch" | "input-capacity-exceeded" | "result-capacity-exceeded" | "shared-debug-capacity-exceeded" | "debug-session-expired" | "debug-session-scope-mismatch" | "debug-session-capacity-exceeded";
class PreparationRejection extends Error {
  constructor(readonly reasonCode: PreparationReasonCode) { super(reasonCode); }
}
export function rejectPreparation(reasonCode: PreparationReasonCode): never { throw new PreparationRejection(reasonCode); }
export function preparationReason(error: unknown): PreparationReasonCode | "preparation-rejected" { return error instanceof PreparationRejection ? error.reasonCode : "preparation-rejected"; }
export const digest = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
export const equal = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value; }
export function sessionScope(dto: InvocationDTO): DebugSessionScope | undefined {
  const task = dto.task;
  return task.debugSessionId ? { serverId: dto.serverId, scope: task.scope, submittedByUserId: task.submittedByUserId, debugSessionId: task.debugSessionId } : undefined;
}
export function validateRuntime(task: TaskEnvelopeV1, identity: BuildIdentity, runtimeCompatibilityId: string): void {
  let actual: string;
  try { actual = runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId); } catch { rejectPreparation("runtime-mismatch"); }
  if (runtimeCompatibilityId !== actual || task.requiredCoreBuildId !== identity.coreBuildId || task.runtimeCompatibilityId !== runtimeCompatibilityId || task.requiredCapabilities.some(item => !identity.capabilities.includes(item))) rejectPreparation("runtime-mismatch");
}
export function validatePermit(dto: InvocationDTO, metadata: PreparedMetadata, permit: StartPermit): void {
  const task = dto.task;
  if (permit.jobId !== task.jobId || permit.executionId !== task.executionId || permit.policyVersion !== task.policyVersion || !equal(permit.effectivePolicy, dto.inputs.policy) || permit.scriptPlanDigest !== metadata.project.scriptPlanDigest || permit.executionProfile !== task.executionProfile || permit.runtimeCompatibilityId !== task.runtimeCompatibilityId || permit.scriptGrantVersion !== task.scriptGrantVersion || !equal(permit.credentialVersions, metadata.credentialVersions)) throw new Error("Start permit does not match actual prepared inputs");
}
/** Each call reparses immutable DTOs and creates its own bindings, registry and cleanup lifetime. */
export async function withInvocation<T>(raw: InvocationDTO, signal: AbortSignal, action: (metadata: PreparedMetadata, materials: ExecutionMaterials) => Promise<T>, session?: HttpSession, minFreeDiskBytes = 1, reserveInput?: (bytes: number) => number): Promise<T> {
  signal.throwIfAborted();
  const parsedInputs = ExecutionInputsSchema.safeParse(raw.inputs), parsedMaterials = ProjectRunMaterialsSchema.safeParse(raw.materials);
  if (!parsedInputs.success || !parsedMaterials.success) rejectPreparation("fixed-input-mismatch");
  const dto = { ...raw, task: structuredClone(raw.task), inputs: parsedInputs.data, materials: parsedMaterials.data };
  const { task, inputs, materials } = dto; const policy = inputs.policy;
  if (inputs.executionId !== task.executionId || inputs.snapshot.snapshotId !== task.snapshotId || inputs.snapshot.assets.manifestHash !== task.manifestHash || inputs.snapshot.assets.contractProjectId !== task.contractProjectId || !equal(task.scope, materials.scope) || !equal(task.scope, { workspaceId: inputs.snapshot.assets.workspaceId, groupId: inputs.snapshot.assets.groupId, projectId: inputs.snapshot.assets.projectId }) || materials.snapshotId !== task.snapshotId || digest(executionInputsDigestText(inputs)) !== inputs.inputsDigest) rejectPreparation("fixed-input-mismatch");
  const scope = sessionScope(dto);
  if ((inputs.runConfig.scriptTimeoutMs ?? policy.scriptTimeoutMs) > policy.maxScriptTimeoutMs) rejectPreparation("policy-mismatch");
  const project = await prepareProjectFiles(inputs.snapshot.assets, { target: task.target, profile: task.executionProfile, environmentId: task.environmentId, requestSettings: inputs.runConfig.requestSettings, scriptTimeoutMs: inputs.runConfig.scriptTimeoutMs ?? policy.scriptTimeoutMs, maxScriptTimeoutMs: policy.maxScriptTimeoutMs, requiredCapabilities: task.requiredCapabilities, debugSessionScope: scope,
    evidenceLimits: { bodyBytes: policy.bodyPreviewBytes, valueBytes: policy.valuePreviewBytes, caseBytes: policy.caseEvidenceBytes, reportBytes: policy.reportBytes, workflowMetadataBytes: policy.workflowMetadataBytes } });
  if (project.scriptPlanDigest !== task.scriptPlanDigest) rejectPreparation("fixed-input-mismatch");
  for (const selected of inputs.materials.credentials) {
    const matches = materials.credentials.filter(item => item.refId === selected.refId);
    if (matches.length !== 1 || matches[0]!.version !== selected.version) rejectPreparation("fixed-input-mismatch");
  }
  if (materials.credentials.length !== inputs.materials.credentials.length) rejectPreparation("fixed-input-mismatch");
  const location = task.target.kind === "debug" ? task.target.invocation.mode === "free" ? task.target.invocation.project : task.target.invocation.locator : { workspaceId: "online", groupId: "online", projectId: task.contractProjectId };
  const contractScope = { workspaceId: location.workspaceId, groupId: location.groupId, projectId: location.projectId };
  const binding = { serverId: dto.serverId, userId: task.submittedByUserId, scope: task.scope, contractScope, snapshotId: task.snapshotId };
  const store = createOnlineProjectSecretStore(binding, async () => materials);
  if (materials.attachments.length !== inputs.materials.attachments.length || inputs.materials.attachments.some(selected => materials.attachments.filter(item => item.refId === selected.refId && item.version === selected.version && item.hash === selected.hash).length !== 1)) rejectPreparation("fixed-input-mismatch");
  const paths = inputs.materials.attachmentPaths ?? {};
  const inputBytes = inputs.snapshot.assets.files.reduce((sum, file) => sum + file.size, 0) + materials.credentials.reduce((sum, item) => sum + Buffer.byteLength(item.value), 0) + materials.attachments.reduce((sum, item) => sum + item.size * Math.max(1, Object.values(paths).filter(ref => ref.refId === item.refId).length), 0) + (inputs.network ? Buffer.byteLength(JSON.stringify(inputs.network)) : 0);
  if (inputBytes > policy.totalInputBytes || inputs.snapshot.assets.files.reduce((sum, file) => sum + file.size, 0) > policy.snapshotBytes || materials.attachments.some(item => item.size > policy.singleAttachmentBytes)) rejectPreparation("input-capacity-exceeded");
  const promised = reserveInput?.(inputBytes) ?? 0;
  return withDeclaredInputFiles(materials, paths, { totalInputBytes: policy.totalInputBytes, minFreeDiskBytes: minFreeDiskBytes + promised }, async files => {
    for (const { request } of selectCredentialRequests(project.prepared.snapshot, project.prepared.selections)) {
      if ("body" in request && request.body.kind === "binary") files.pathFor(request.body.file.path);
      if ("body" in request && request.body.kind === "multipart") for (const entry of request.body.entries) if (entry.kind === "file" && entry.enabled) files.pathFor(entry.file.path);
    }
    for (const selection of project.prepared.selections) { const driver = selection.testCase?.dataDriver; if (driver && !("kind" in driver)) files.pathFor(driver.sourcePath); }
    const data = await prepareTestData(project.prepared.snapshot, project.prepared.suitePlan?.selections ?? testDataSelectionsForRequests(project.prepared.snapshot, project.prepared.selections, project.prepared.environmentId), { workspaceRoot: files.workspaceRoot });
    let network: PreparedNetworkRun | undefined;
    if (inputs.network) {
      const fixed = structuredClone(inputs.network);
      const mapTLS = (tls: NetworkTLSSettings | undefined) => { if (!tls) return; if (tls.caCertificatePaths) tls.caCertificatePaths = tls.caCertificatePaths.map(path => files.pathFor(logicalNetworkPath(path))); if (tls.clientCertificatePaths) tls.clientCertificatePaths = tls.clientCertificatePaths.map(path => files.pathFor(logicalNetworkPath(path))); };
      for (const profile of fixed.configuration.profiles) { for (const binding of profile.targetTlsBindings) mapTLS(binding.tls); if (profile.kind === "proxy") mapTLS(profile.proxyTLS); }
      network = await prepareNetworkRun({ scope: { canonicalRoot: files.workspaceRoot, project: contractScope, ...(project.prepared.environmentId ? { environmentId: project.prepared.environmentId } : {}) }, secretStore: store, store: { load: async () => ({ revision: fixed.revision, configuration: fixed.configuration }), save: async () => { throw new Error("Fixed network material is read-only"); } }, selection: fixed.selection, signal });
    }
    const credentials = await prepareRunCredentials(project.prepared, binding, store);
    const versions = { ...credentials.versions, ...network?.credentialVersions };
    if (Object.keys(versions).length !== inputs.materials.credentials.length || inputs.materials.credentials.some(item => versions[item.refId] !== item.version)) { credentials.dispose(); rejectPreparation("fixed-input-mismatch"); }
    return withRunCredentials(credentials, async credentialBindings => { signal.throwIfAborted(); return action({ project, credentialVersions: Object.freeze(versions), inputBytes }, { credentialBindings, preparedTestData: data, network, workspaceRoot: files.workspaceRoot, ...(scope && session ? { debugSession: { scope, session } } : {}) }); });
  });
}
export async function executeInvocation(dto: InvocationDTO, permit: StartPermit, identity: BuildIdentity, signal: AbortSignal, session?: HttpSession, onBusinessStart?: () => void): Promise<InvocationOutput> {
  validateRuntime(dto.task, identity, dto.runtimeCompatibilityId);
  return withInvocation(dto, signal, async (metadata, materials) => { validatePermit(dto, metadata, permit); signal.throwIfAborted(); onBusinessStart?.(); return invokeExecution(metadata.project.prepared, materials, { signal }); }, session, dto.minFreeDiskBytes);
}
