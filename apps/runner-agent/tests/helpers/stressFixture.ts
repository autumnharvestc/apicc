import { createHash } from "node:crypto";
import { encodeContractProjectFiles, StressPlanSchema } from "@apicc/core";
import { createContractExecutionProject, contractExecutionIds as ids } from "../../../../packages/core/tests/helpers/contractExecutionFixtures.js";
import { prepareProjectFiles } from "@apicc/execution/host";
import { readBuildIdentity } from "@apicc/execution/buildIdentity";
import { AgentMessageV1Schema, defaultAgentConfig, defaultPolicyConfig, executionInputsDigestText, resolveEffectiveConfig, runtimeCompatibilityIdForRuntime, type AgentConfig, type AgentMessageV1, type ExecutionInputs, type ProjectRunMaterials, type TaskDeliveryV1 } from "@apicc/execution/contract";
import { AgentSupervisor, type SettledExecution } from "../../src/supervisor.js";

export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export async function stressFixture(origin: string, id = 901, workerCount = 2, path = "/stress", iterations = 4) {
  const identity = await readBuildIdentity();
  const compatibility = runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId);
  const project = createContractExecutionProject(origin), collection = project.collections[0]!, folder = collection.folders[0]!.folders[0]!, api = folder.apis[0]!;
  if (api.contract.request.protocol !== "http") throw new Error("Controlled HTTP fixture required");
  folder.preOperations = []; folder.postOperations = []; api.cases[0]!.preOperations = [];
  api.contract.request.baseUrl = origin; api.contract.request.query = []; api.contract.request.headers = []; api.contract.request.body = { kind: "json", content: '{"synthetic":true}' };
  api.contract.request.path = path;
  const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: "case", collectionId: collection.id, apiId: api.contract.id, caseId: ids.case }, load: { kind: "constant-vus", vus: 2 }, maxVus: 2, maxRequestConcurrency: 2, maxRps: 10, termination: { maxIterations: iterations } });
  const target = { kind: "stress" as const, plan };
  const config: AgentConfig = { ...defaultAgentConfig, minFreeDiskBytes: 1 };
  const policy = { ...defaultPolicyConfig, cancelGraceMs: 200 };
  const runConfig = { stress: { workerCount, confirmedTargetOrigins: [] } };
  const configuration = resolveEffectiveConfig({ agent: config, policy });
  const files = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content, version: "1", hash: hash(content), size: Buffer.byteLength(content) })).sort((a, b) => a.path.localeCompare(b.path));
  const assets = { workspaceId: "11", groupId: "22", projectId: "33", contractProjectId: project.id, format: "contract-files-v1" as const, version: "1", files, manifestHash: hash(files.map(file => `${file.path}\0${file.version}\0${file.hash}\0${file.size}\n`).join("")) };
  const prepared = await prepareProjectFiles(assets, { target, profile: "no-script", stressRun: runConfig.stress, stressConfig: { configuration, run: runConfig.stress } });
  const executionId = String(id), snapshotId = String(id + 1000);
  const delivery: TaskDeliveryV1 = { messageId: `delivery-${id}`, task: { protocolVersion: 1, jobId: String(id + 100), executionId, snapshotId, scope: { workspaceId: "11", groupId: "22", projectId: "33" }, submittedByUserId: "44", contractProjectId: project.id, manifestHash: assets.manifestHash, target, executionProfile: "no-script", dispatchKind: "dedicated-task", scriptPlanDigest: prepared.scriptPlanDigest, requiredCoreBuildId: identity.coreBuildId, requiredCapabilities: [...prepared.prepared.requiredCapabilities], policyVersion: "1", runtimeCompatibilityId: compatibility } };
  const materials: ProjectRunMaterials = { snapshotId, scope: delivery.task.scope, credentials: [{ refId: ids.credential, version: "1", value: `stress-private-${id}` }], attachments: [] };
  const inputs: ExecutionInputs = { executionId, snapshot: { snapshotId, createdByUserId: "44", assets }, policy, runConfig, materials: { projectId: "33", credentials: [{ refId: ids.credential, version: "1" }], attachments: [] }, stressBinding: prepared.prepared.stressBinding!, stressExecutor: { id: "7", name: "Controlled agent" }, inputsDigest: "0".repeat(64) };
  inputs.inputsDigest = hash(executionInputsDigestText(inputs));
  return { delivery, inputs, materials, prepared, identity, compatibility, config };
}
export type StressFixture = Awaited<ReturnType<typeof stressFixture>>;
export async function debugFixture(origin: string, id = 920) {
  const item = await stressFixture(origin, id, 1, "/neighbor-debug");
  const locator = { workspaceId: "workspace", groupId: "group", projectId: ids.project, collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: ids.contract };
  item.delivery.task.target = { kind: "debug", invocation: { mode: "case", locator, case: { ...locator, caseId: ids.case, scope: "base" } } };
  item.delivery.task.dispatchKind = "shared-debug";
  item.inputs.runConfig = {}; delete item.inputs.stressBinding; delete item.inputs.stressExecutor;
  item.prepared = await prepareProjectFiles(item.inputs.snapshot.assets, { target: item.delivery.task.target, profile: "no-script" });
  item.delivery.task.requiredCapabilities = [...item.prepared.prepared.requiredCapabilities];
  item.inputs.inputsDigest = hash(executionInputsDigestText(item.inputs));
  return item;
}
export function stressHarness(items: StressFixture[], overrides: Partial<AgentConfig> = {}, dataDirectory?: string, control: {
  holdStartPermit?: boolean;
  onStartRequest?(message: Extract<AgentMessageV1, { kind: "start-request" }>): void;
} = {}) {
  const completed: SettledExecution[] = [], messages: AgentMessageV1[] = [], rejectedDeclarations: string[] = [];
  const first = items[0]!;
  const supervisor = new AgentSupervisor({ dataDirectory, serverId: "https://control.test/api/v1", agentId: "7", sessionId: "stress-host", identity: first.identity, runtimeCompatibilityId: first.compatibility, config: { ...first.config, ...overrides }, configVersion: "1",
    loadInputs: async task => items.find(item => item.delivery.task.executionId === task.executionId)!.inputs,
    loadMaterials: async task => items.find(item => item.delivery.task.executionId === task.executionId)!.materials,
    transport: { exchange: async () => ({ deliveries: [], commands: [] }), send: async batch => {
      messages.push(...batch);
      for (const message of batch) if (message.kind === "start-request") {
        const item = items.find(item => item.delivery.task.executionId === message.executionId)!;
        // The control boundary requires the exact frozen declaration, as T4 does.
        const accepted = AgentMessageV1Schema.safeParse(message).success && JSON.stringify(message.stressBinding) === JSON.stringify(item.inputs.stressBinding);
        if (!accepted) rejectedDeclarations.push(message.executionId);
        control.onStartRequest?.(message);
        if (control.holdStartPermit) continue;
        queueMicrotask(() => supervisor.command(accepted ? { kind: "start-permit", messageId: `permit-${message.executionId}`, jobId: message.jobId, executionId: message.executionId, permitId: message.executionId, effectivePolicy: item.inputs.policy, policyVersion: message.policyVersion, scriptPlanDigest: message.scriptPlanDigest, executionProfile: message.executionProfile, runtimeCompatibilityId: message.runtimeCompatibilityId, credentialVersions: message.credentialVersions } : { kind: "start-rejected", messageId: `rejected-${message.executionId}`, jobId: message.jobId, executionId: message.executionId, reasonCode: "policy_changed" }));
      }
      return { acknowledged: batch.map(message => message.messageId) };
    } }, onSettled: result => completed.push(result) });
  return { supervisor, completed, messages, rejectedDeclarations };
}
