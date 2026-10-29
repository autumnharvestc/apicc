import { z } from "zod";
import { isDeepStrictEqual } from 'node:util';
import { StressPlanSchema } from '@apicc/core/schema';
import { createHash, randomUUID } from "node:crypto";
import { createSystemSecretStore, defaultCredentialPrivateRoot, prepareTestData, testDataSelectionsForRequests, prepareNetworkRun, selectCredentialRequests, createHttpSession, createUserPluginHostFromSnapshot, type SecretStore, type NetworkTLSSettings, type PreparedNetworkRun } from "@apicc/core";
import { ProjectAssetsSchema, ExecutionSnapshotSchema, ProjectExecutionAgentsSchema, SubmitJobSchema, PolicyConfigSchema, StressRunConfigSchema, runtimeCompatibilityIdForRuntime, logicalNetworkPath, resolveEffectiveConfig, defaultAgentConfig } from "@apicc/execution/contract";
import { prepareProjectFiles, invokeExecution, assertStressExecutionDeadline, createOnlineProjectSecretStore, prepareRunCredentials, withRunCredentials, withDeclaredInputFiles, createExecutionRegistry } from "@apicc/execution/host";
import { createMemberMaterialsClient } from "@apicc/execution/client";
import { readBuildIdentity } from "@apicc/execution/buildIdentity";
import { OnlineExecutionInputSchema, OnlineJobSchema, OnlineLocalResultSchema, OnlineReportSchema, type OnlineExecutionInput, type OnlineLocalResult, type OnlineReport } from "../../shared/online/execution.js";
import type { OnlineSession } from "./session.js";
import { createExecutionRequest } from "./client.js";
import { readOnlineProject, assertAssetsScope, onlineProjectDelta } from "./projectAssets.js";
import { encodeContractProjectFiles } from "@apicc/core";
import { createOnlineLocalCredentialStore } from "./projectCredentials.js";
import type { PluginsRuntime } from "../plugins/runtime.js";
import { importDatasetContent, exportDatasetContent } from "../datasetExchange.js";
import { runDesktopStress, type DesktopStressConfiguration } from './stressProcess.js';

type LocalRun = { context: string; abort: AbortController; completion: Promise<OnlineLocalResult>; result?: OnlineLocalResult; failure?: OnlineReport; started: boolean; settled: boolean };
export function createOnlineExecutionHost(deps: { session: OnlineSession; fetch?: typeof fetch; localStore?: () => SecretStore; plugins?: PluginsRuntime }) {
  const localRuns = new Map<string, LocalRun>();
  let closed = false;
  const trimHistory = () => { const terminal = [...localRuns].filter(([, run]) => run.settled); for (const [id] of terminal.slice(0, Math.max(0, terminal.length - 100))) localRuns.delete(id); };
  type LocalDebugSession = { key: string; session: ReturnType<typeof createHttpSession>; refs: number; idleSince: number };
  const debugSessions = new Map<string, LocalDebugSession>();
  const contextKey = (input: OnlineExecutionInput) => JSON.stringify(input.context);
  // Versioned address adaptation only: Core's private credential scope requires UUIDs.
  const addressUuid = (purpose: string, identity: string[]) => {
    const bytes = createHash("sha256").update(JSON.stringify(["apicc-online-personal-v1", purpose, ...identity])).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const localScope = (input: OnlineExecutionInput, projectId: string) => {
    const { ownerId, scope } = input.context;
    const serverId = new URL(input.context.serverId).href.replace(/\/$/, "");
    return { workspaceId: addressUuid("server-owner", [serverId, ownerId]), groupId: addressUuid("remote-project", [serverId, ownerId, scope.workspaceId, scope.groupId, scope.projectId]), projectId };
  };
  let localStore: SecretStore | undefined;
  const getLocalStore = () => localStore ??= deps.localStore?.() ?? createSystemSecretStore({ privateRoot: defaultCredentialPrivateRoot() });
  return {
    async close() { closed = true; for (const run of localRuns.values()) run.abort.abort(new Error("local-run-cancelled")); await Promise.allSettled([...localRuns.values()].map(run => run.completion)); localRuns.clear(); await Promise.allSettled([...debugSessions.values()].map(record => record.session.close())); debugSessions.clear(); },
    async handle(raw: OnlineExecutionInput): Promise<unknown> {
      // Material/identity checks deliberately precede any request to the server.
      const binding = deps.session.captureExecution(raw.context);
      if (raw.operation === "run" && raw.location.kind === "agent" && raw.localOnlyRefIds.length) throw new Error("local-material-required");
      const input = OnlineExecutionInputSchema.parse(raw);
      const request = createExecutionRequest(binding, deps.fetch);
      const path = `workspaces/${input.context.scope.workspaceId}/projects/${input.context.scope.projectId}`;
      const projectAgents = () => request("GET", `${path}/execution-agents`, undefined, ProjectExecutionAgentsSchema);
      const memberMaterials = () => createMemberMaterialsClient({ baseUrl: binding.serverId, token: binding.token, fetch: deps.fetch ?? globalThis.fetch });
      const assertJob = (job: z.infer<typeof OnlineJobSchema>) => {
        if (job.task.scope.workspaceId !== input.context.scope.workspaceId || job.task.scope.groupId !== input.context.scope.groupId || job.task.scope.projectId !== input.context.scope.projectId || ("location" in input && input.location.kind === "agent" && job.agentId !== input.location.agentId)) throw new Error("online-project-scope-mismatch");
        return job;
      };
      switch (input.operation) {
        case "assets": return readOnlineProject(await request("GET", `${path}/assets`, undefined, ProjectAssetsSchema), input.context);
        case "save": {
          const current = await request("GET", `${path}/assets`, undefined, ProjectAssetsSchema); assertAssetsScope(current, input.context);
          if (current.format !== "contract-files-v1" || current.contractProjectId !== input.delta.contractProjectId) throw new Error("legacy-format-read-only");
          return readOnlineProject(await request("PUT", `${path}/assets`, input.delta, ProjectAssetsSchema), input.context);
        }
        case "saveProject": {
          const current = await request("GET", `${path}/assets`, undefined, ProjectAssetsSchema); assertAssetsScope(current, input.context);
          if (current.version !== input.expectedVersion) throw new Error("version_conflict");
          const delta = onlineProjectDelta(input.project, current);
          return readOnlineProject(await request("PUT", `${path}/assets`, delta, ProjectAssetsSchema), input.context);
        }
        case "publish": {
          const current = await request("GET", `${path}/assets`, undefined, ProjectAssetsSchema); assertAssetsScope(current, input.context);
          if (current.files.length || current.format !== null || current.version !== "0") throw new Error("publish-requires-empty-project");
          const delta = { format: "contract-files-v1", contractProjectId: input.project.id, expectedVersion: "0", changes: [...encodeContractProjectFiles(input.project).files].map(([path, content]) => ({ path, content })), deletes: [] };
          return readOnlineProject(await request("PUT", `${path}/assets`, delta, ProjectAssetsSchema), input.context);
        }
        case "publishNew": {
          // Creating a new entity is explicit; the existing project's files are never a target.
          await request("GET", `${path}/assets`, undefined, ProjectAssetsSchema);
          const created = await request("POST", `workspaces/${input.context.scope.workspaceId}/projects`, { groupId: input.context.scope.groupId, name: input.name }, z.object({ id: z.string().regex(/^[1-9]\d*$/), groupId: z.string(), name: z.string(), createdAt: z.string() }).strict());
          const scope = { ...input.context.scope, groupId: created.groupId, projectId: created.id };
          const targetPath = `workspaces/${scope.workspaceId}/projects/${scope.projectId}/assets`;
          const empty = await request("GET", targetPath, undefined, ProjectAssetsSchema);
          assertAssetsScope(empty, { ...input.context, scope });
          if (empty.files.length || empty.format !== null || empty.version !== "0") throw new Error(`publish-requires-empty-project: ${created.id}`);
          const delta = { format: "contract-files-v1", contractProjectId: input.project.id, expectedVersion: "0", changes: [...encodeContractProjectFiles(input.project).files].map(([path, content]) => ({ path, content })), deletes: [] };
          try { return { scope, view: await readOnlineProject(await request("PUT", targetPath, delta, ProjectAssetsSchema), { ...input.context, scope }) }; }
          catch (error) { throw new Error(`publish-created-project-save-failed: ${created.id}; ${error instanceof Error ? error.message : "execution-request-failed"}`); }
        }
        case "agents": return projectAgents();
        case "datasetImport": case "datasetExport": {
          const view = await readOnlineProject(await request("GET", `${path}/assets`, undefined, ProjectAssetsSchema), input.context);
          if (!view.project) throw new Error("legacy-format-read-only");
          if (input.operation === "datasetImport") return importDatasetContent(input.content, input.format);
          const dataset = view.project.datasets?.find(dataset => dataset.id === input.datasetId);
          if (!dataset) throw new Error("dataset-not-found");
          return exportDatasetContent(dataset, input.format);
        }
        case "materials": {
          const client = memberMaterials(); const signal = new AbortController().signal;
          const credentials = await client.listCredentials(input.context.scope, signal); binding.assertCurrent();
          const attachments = await client.listAttachments(input.context.scope, signal); binding.assertCurrent();
          return { credentials, attachments };
        }
        case "attachmentUpload": { const result = await memberMaterials().putAttachment(input.context.scope, input.attachment, new AbortController().signal); binding.assertCurrent(); return result; }
        case "credential": {
          const assets = await request("GET", `${path}/assets`, undefined, ProjectAssetsSchema); assertAssetsScope(assets, input.context);
          if (assets.contractProjectId !== input.contractProjectId || assets.format !== "contract-files-v1") throw new Error("online-project-scope-mismatch");
          if (input.ref.policy !== "test-auto") throw new Error("CREDENTIAL_POLICY_UNSUPPORTED");
          if (input.storage === "local") {
            const store = getLocalStore(); const scope = localScope(input, input.contractProjectId);
            if (input.action === "status") { const status = await store.status(scope, input.ref); binding.assertCurrent(); return { ok: true, status }; }
            if (input.action === "put") { if (input.value === undefined) throw new Error("credential-value-required"); await store.put(scope, input.ref, input.value); }
            else await store.remove(scope, input.ref);
          } else {
            const client = memberMaterials(); const signal = new AbortController().signal;
            const metadata = (await client.listCredentials(input.context.scope, signal)).find(ref => ref.refId === input.ref.id); binding.assertCurrent();
            if (input.action === "status") return { ok: true, status: metadata?.status ?? "missing" };
            if (input.action === "put") { if (input.value === undefined) throw new Error("credential-value-required"); await client.putCredential(input.context.scope, input.ref.id, { expectedVersion: metadata?.version ?? "0", value: input.value }, signal); }
            else if (metadata) await client.removeCredential(input.context.scope, input.ref.id, metadata.version, signal);
          }
          binding.assertCurrent(); return { ok: true };
        }
        case "list": return (await request("GET", `${path}/jobs?limit=${input.limit}${input.beforeJobId ? `&beforeJobId=${input.beforeJobId}` : ""}`, undefined, z.array(OnlineJobSchema))).map(assertJob);
        case "status": case "cancel": case "report": {
          if (input.location.kind === "local") {
            const run = localRuns.get(input.runId);
            if (!run || run.context !== contextKey(input)) throw new Error("local-run-unavailable-no-backend-handoff");
            if (input.operation === "cancel" && !run.settled) run.abort.abort(new Error("local-run-cancelled"));
            return run.result ?? run.failure ?? await run.completion.catch(() => run.failure!);
          }
          const job = assertJob(await request("GET", `jobs/${input.runId}`, undefined, OnlineJobSchema));
          if (input.operation === "status") return job;
          if (input.operation === "cancel") return assertJob(await request("POST", `jobs/${input.runId}/cancel`, {}, OnlineJobSchema));
          const report = await request("GET", `jobs/${input.runId}/report`, undefined, OnlineReportSchema).catch(error => {
            if (error instanceof z.ZodError && error.issues.some(issue => issue.path[0] === 'output')) throw new Error('invalid-core-output');
            throw error;
          });
          if (report.executionId !== job.executionId) throw new Error("fixed-input-mismatch");
          if(report.processObservation&&job.task.target.kind!=='stress')throw new Error('fixed-input-mismatch');
          if (report.output && (job.task.target.kind === 'stress') !== (report.output.kind === 'stress' || report.output.kind === 'stress-failure')) throw new Error('fixed-input-mismatch');
          if (report.output?.kind === 'stress' && job.task.target.kind === 'stress') {
            const environmentId = job.task.target.plan.environmentId ?? job.task.environmentId;
            const plan = StressPlanSchema.parse({ ...job.task.target.plan, ...(environmentId ? { environmentId } : {}) });
            if (report.output.result.projectId !== job.task.contractProjectId || report.output.result.environmentId !== (environmentId ?? null) || !isDeepStrictEqual(report.output.result.plan, plan) || !isDeepStrictEqual(report.output.result.target, plan.target)) throw new Error('fixed-input-mismatch');
          }
          return report;
        }
        case "run": {
          const admittedAt = performance.now();
          if (closed) throw new Error("local-run-unavailable-no-backend-handoff");
          if (localRuns.has(input.runId)) throw new Error("run-already-started");
          const abort = new AbortController();
          let run: LocalRun | undefined; let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
          let processObservation:import('@apicc/execution/contract').StressProcessObservation|undefined;
          let deadline = input.runConfig.jobTimeoutMs === undefined ? undefined : admittedAt + input.runConfig.jobTimeoutMs;
          const checkAlive = () => { if (deadline !== undefined && performance.now() >= deadline && !abort.signal.aborted) abort.abort(new Error("job-timeout")); abort.signal.throwIfAborted(); };
          const armDeadline = () => { if (deadlineTimer) clearTimeout(deadlineTimer); if (deadline === undefined || abort.signal.aborted) return; const remaining = deadline - performance.now(); if (remaining <= 0) abort.abort(new Error("job-timeout")); else deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2147483647)); };
          // Explicit input budget already bounds admission. Authority can only refine the same origin.
          armDeadline();
          let localSession: { id: string; record: LocalDebugSession } | undefined;
          const completion = Promise.resolve().then(async () => {
          checkAlive();
          if (input.materials.projectId !== input.context.scope.projectId) throw new Error("online-project-scope-mismatch");
          const request = createExecutionRequest(binding, deps.fetch, abort.signal);
          const view = await request("GET", `${path}/execution-agents`, undefined, ProjectExecutionAgentsSchema);
          const agentId = input.location.kind === "agent" ? input.location.agentId : undefined;
          const agent = agentId ? view.agents.find(agent => agent.id === agentId) : undefined;
          if (input.location.kind === "agent" && (!agent || agent.availability !== "available" || !agent.runtime || agent.configuration.status !== "applied")) throw new Error("agent-unavailable");
          const policy = PolicyConfigSchema.parse(agent?.policy ?? view.policy);
          if (input.target.kind === 'stress' && !agent && (input.runConfig.stress?.workerCount ?? 1) > policy.maxStressWorkers) throw new Error('stress-worker-policy-exceeded');
          const effective = resolveEffectiveConfig({ policy, run: input.runConfig });
          // Client preparation is bounded here; this is not the server agent task's deadline.
          deadline = admittedAt + effective.jobTimeoutMs; armDeadline(); checkAlive();
          const snapshot = await request("POST", `${path}/execution-snapshots`, { expectedVersion: input.expectedVersion }, ExecutionSnapshotSchema);
          checkAlive();
          assertAssetsScope(snapshot.assets, input.context);
          if (snapshot.createdByUserId !== binding.userId || snapshot.assets.version !== input.expectedVersion) throw new Error("fixed-input-mismatch");
          const identity = await readBuildIdentity();
          checkAlive();
          // Reject an unknown local host before allocating a persistent HTTP session.
          let runtimeCompatibilityId = agent?.runtime?.runtimeCompatibilityId ?? "";
          if (!agent) try { runtimeCompatibilityId = runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId); } catch { throw new Error(`runtime-mismatch: Node ${process.versions.node}; V8 ${process.versions.v8}`); }
          if (!agent && input.target.kind === 'debug') {
            const key = contextKey(input); const now = performance.now();
            for (const [id, record] of debugSessions) if (record.refs === 0 && now - record.idleSince > defaultAgentConfig.debugSessionIdleMs) { debugSessions.delete(id); await record.session.close(); }
            if (input.debugSessionId) {
              const record = debugSessions.get(input.debugSessionId);
              if (!record) throw new Error('debug-session-expired');
              if (record.key !== key) throw new Error('debug-session-scope-mismatch');
              record.refs++; localSession = { id: input.debugSessionId, record };
            } else {
              if (debugSessions.size >= defaultAgentConfig.maxDebugSessions) throw new Error('debug-session-capacity-exceeded');
              const id = randomUUID(); const record = { key, session: createHttpSession(), refs: 1, idleSince: now }; debugSessions.set(id, record); localSession = { id, record };
            }
          }
          const debugSessionScope = localSession ? { serverId: binding.serverId, scope: input.context.scope, submittedByUserId: binding.userId, debugSessionId: localSession.id } : undefined;
          const prepareInput = { target: input.target, environmentId: input.environmentId, requestSettings: input.runConfig.requestSettings, scriptTimeoutMs: effective.policy.scriptTimeoutMs, maxScriptTimeoutMs: policy.maxScriptTimeoutMs, debugSessionScope, evidenceLimits: { bodyBytes: policy.bodyPreviewBytes, valueBytes: policy.valuePreviewBytes, caseBytes: policy.caseEvidenceBytes, reportBytes: policy.reportBytes, workflowMetadataBytes: policy.workflowMetadataBytes },
            ...(input.target.kind === 'stress' && agent ? { stressConfig: { configuration: { ...agent.stressConfiguration, policy }, run: StressRunConfigSchema.parse(input.runConfig.stress ?? {}) } } : {}),
            ...(input.target.kind === 'stress' && !agent ? { stressRun: StressRunConfigSchema.parse(input.runConfig.stress ?? {}), stressCompileOptions: { numericMemoryBytes: policy.stressMetricMemoryBytes, evidenceMaxSamples: policy.stressEvidenceMaxSamples } } : {}),
          };
          let prepared = await prepareProjectFiles(snapshot.assets, { ...prepareInput, profile: "trusted-core-script" });
          checkAlive();
          const hasScripts = prepared.scriptRequirements.length > 0;
          if (!hasScripts) prepared = await prepareProjectFiles(snapshot.assets, { ...prepareInput, profile: "no-script" });
          checkAlive();
          if (!agent && prepared.prepared.stressPlan) {
            const schedule = prepared.prepared.stressPlan.schedule;
            if (schedule.maxVus > policy.maxStressVus || schedule.effective.maxRequestConcurrency > policy.maxStressRequestConcurrency || schedule.effective.maxRps !== null && schedule.effective.maxRps > policy.maxStressRps) throw new Error('stress-local-budget-exceeded');
          }
          if (agent) {
            if (identity.coreBuildId !== agent.runtime!.coreBuildId || identity.scriptApiId !== agent.runtime!.scriptApiId || prepared.prepared.requiredCapabilities.some(capability => !agent.runtime!.capabilities.includes(capability))) throw new Error("runtime-mismatch");
            const rejected = prepared.scriptRequirements.filter(script => !agent.scriptsAllowed || agent.scriptGrant.version === "0" || agent.scriptGrant.scope !== "project" && !agent.scriptGrant.scripts.some(grant => grant.scriptId === script.scriptId && grant.contentHash === script.contentHash));
            if (rejected.length) throw new Error(`script-admission-denied: ${rejected.map(script => `${script.scriptId}@${script.contentHash}`).join(", ")}`);
          }
          checkAlive();
            const materialsClient = createMemberMaterialsClient({ baseUrl: binding.serverId, token: binding.token, fetch: deps.fetch ?? globalThis.fetch });
            const location = input.target.kind === "debug" ? input.target.invocation.mode === "free" ? input.target.invocation.project : input.target.invocation.locator : { workspaceId: input.context.scope.workspaceId, groupId: input.context.scope.groupId, projectId: snapshot.assets.contractProjectId! };
            const contractScope = { workspaceId: location.workspaceId, groupId: location.groupId, projectId: location.projectId };
            const materialBinding = { serverId: binding.serverId, userId: binding.userId, scope: input.context.scope, contractScope, snapshotId: snapshot.snapshotId };
            const projectStore = createOnlineProjectSecretStore(materialBinding, async (_binding, selection) => { binding.assertCurrent(); const result = await materialsClient.loadLocal(snapshot.snapshotId, selection, abort.signal); binding.assertCurrent(); return result; });
            // Request/transport credentials are selected by actual Core preparation, not by an
            // empty or overbroad renderer list. This bundle stages only declared ordinary files.
            const remoteMaterials = await materialsClient.loadLocal(snapshot.snapshotId, { ...input.materials, credentials: [] }, abort.signal);
            checkAlive();
            binding.assertCurrent();
            const store = createOnlineLocalCredentialStore({ contractScope, projectStore, localStore: input.localOnlyRefIds.length ? getLocalStore() : projectStore, localOnlyRefIds: input.localOnlyRefIds, localScope: localScope(input, contractScope.projectId) });
            const result = await withDeclaredInputFiles(remoteMaterials, input.materials.attachmentPaths ?? {}, { totalInputBytes: policy.totalInputBytes, minFreeDiskBytes: defaultAgentConfig.minFreeDiskBytes }, async files => {
              checkAlive();
              for (const { request: selected } of selectCredentialRequests(prepared.prepared.snapshot, prepared.prepared.selections)) {
                if ('body' in selected && selected.body.kind === 'binary') files.pathFor(selected.body.file.path);
                if ('body' in selected && selected.body.kind === 'multipart') for (const entry of selected.body.entries) if (entry.kind === 'file' && entry.enabled) files.pathFor(entry.file.path);
              }
              for (const selected of prepared.prepared.selections) { const driver = selected.testCase?.dataDriver; if (driver && !('kind' in driver)) files.pathFor(driver.sourcePath); }
              const data = await prepareTestData(prepared.prepared.snapshot, prepared.prepared.suitePlan?.selections ?? testDataSelectionsForRequests(prepared.prepared.snapshot, prepared.prepared.selections, prepared.prepared.environmentId), { workspaceRoot: files.workspaceRoot });
              checkAlive();
              let network: PreparedNetworkRun | undefined;
              let fixedNetwork: DesktopStressConfiguration['network'];
              if (input.network) {
                const fixed = structuredClone(input.network); const mapTLS = (tls: NetworkTLSSettings | undefined) => { if (tls?.caCertificatePaths) tls.caCertificatePaths = tls.caCertificatePaths.map(path => files.pathFor(logicalNetworkPath(path))); if (tls?.clientCertificatePaths) tls.clientCertificatePaths = tls.clientCertificatePaths.map(path => files.pathFor(logicalNetworkPath(path))); };
                for (const profile of fixed.configuration.profiles) { for (const binding of profile.targetTlsBindings) mapTLS(binding.tls); if (profile.kind === "proxy") mapTLS(profile.proxyTLS); }
                network = await prepareNetworkRun({ scope: { canonicalRoot: files.workspaceRoot, project: contractScope, ...(prepared.prepared.environmentId ? { environmentId: prepared.prepared.environmentId } : {}) }, secretStore: store, store: { load: async () => ({ revision: fixed.revision, configuration: fixed.configuration }), save: async () => { throw new Error("fixed-network-read-only"); } }, selection: fixed.selection, signal: abort.signal });
                if (!agent && input.target.kind === 'stress') {
                  const values: Record<string, string> = {};
                  for (const [refId, version] of Object.entries(network.credentialVersions)) values[refId] = await store.resolve(contractScope, { id: refId, policy: 'test-auto' }, version);
                  fixedNetwork = { ...fixed, scope: contractScope, identity: network.identity, credentialVersions: { ...network.credentialVersions }, values };
                }
              }
              const credentials = await prepareRunCredentials(prepared.prepared, materialBinding, store);
              try { checkAlive(); } catch (error) { credentials.dispose(); throw error; }
              for (const [refId, version] of Object.entries(network?.credentialVersions ?? {})) if (credentials.versions[refId] && credentials.versions[refId] !== version) { credentials.dispose(); throw new Error('CREDENTIAL_VERSION_CONFLICT'); }
              const versions = { ...credentials.versions, ...network?.credentialVersions };
              if (agent) {
                try {
                  const fixedMaterials = { ...input.materials, credentials: Object.entries(versions).map(([refId, version]) => ({ refId, version })) };
                  const submission = SubmitJobSchema.parse({ intentId: input.runId, agentId: agent.id, snapshotId: snapshot.snapshotId, target: input.target, environmentId: input.environmentId, debugSessionId: input.debugSessionId, runConfig: input.runConfig, materials: fixedMaterials, network: input.network,
                    preparation: { scope: input.context.scope, manifestHash: snapshot.assets.manifestHash, scriptPlanDigest: prepared.scriptPlanDigest, ...(prepared.prepared.stressBinding ? { stressBinding: prepared.prepared.stressBinding } : {}), ...(hasScripts ? { scriptGrantVersion: agent.scriptGrant.version } : {}), scriptRequirements: prepared.scriptRequirements, executionProfile: hasScripts ? "trusted-core-script" : "no-script", dispatchKind: input.target.kind === "debug" && !hasScripts ? "shared-debug" : "dedicated-task", requiredCoreBuildId: identity.coreBuildId, requiredCapabilities: prepared.prepared.requiredCapabilities, runtimeCompatibilityId } });
                  binding.assertCurrent(); checkAlive();
                  return assertJob(await request("POST", `${path}/jobs`, submission, OnlineJobSchema));
                } finally { credentials.dispose(); }
              }
              for (const [refId, version] of Object.entries(network?.credentialVersions ?? {})) if (await store.version(contractScope, { id: refId, policy: 'test-auto' }) !== version) { credentials.dispose(); throw new Error('CREDENTIAL_VERSION_CONFLICT'); }
              return withRunCredentials(credentials, async credentialBindings => {
                const pluginSnapshot = await deps.plugins?.snapshot();
                binding.assertCurrent(); checkAlive();
                if (input.target.kind === 'stress') {
                  const remainingMs = deadline! - performance.now(); assertStressExecutionDeadline(prepared.prepared, remainingMs);
                  const values = Object.fromEntries(Object.keys(credentialBindings.versions).map(refId => [refId, credentialBindings.resolve({ id: refId, policy: 'test-auto' })]));
                  const { stressConfig: _agentConfig, debugSessionScope: _debugScope, ...fixedPrepare } = prepareInput;
                  if (run) run.started = true;
                  return runDesktopStress({ protocolVersion: 1, identity: { context: input.context, runId: input.runId, snapshotId: snapshot.snapshotId, manifestHash: snapshot.assets.manifestHash, coreBuildId: identity.coreBuildId, scriptApiId: identity.scriptApiId, runtimeCompatibilityId, scriptPlanDigest: prepared.scriptPlanDigest }, assets: snapshot.assets, prepare: { ...fixedPrepare, profile: prepared.prepared.profile }, deadlineAt: Date.now() + remainingMs, cancelGraceMs: policy.cancelGraceMs, workspaceRoot: files.workspaceRoot, preparedTestData: data, credentials: { scope: contractScope, versions: { ...credentialBindings.versions }, values }, ...(fixedNetwork ? { network: fixedNetwork } : {}), ...(pluginSnapshot ? { pluginSnapshot } : {}) }, abort.signal,value=>{processObservation=value;});
                }
                if (run) run.started = true;
                return invokeExecution(prepared.prepared, { credentialBindings, preparedTestData: data, network, workspaceRoot: files.workspaceRoot, ...(debugSessionScope && localSession ? { debugSession: { scope: debugSessionScope, session: localSession.record.session } } : {}) }, { signal: abort.signal,
                  ...(pluginSnapshot ? { registryFactory: async (options: Parameters<typeof createExecutionRegistry>[0]) => {
                    const base = createExecutionRegistry(options);
                    try { const host = createUserPluginHostFromSnapshot(pluginSnapshot, { hostVersion: pluginSnapshot.hostVersion, registry: base }); await host.registry(); return base; }
                    catch (error) { await base.close(); throw error; }
                  } } : {}),
                });
              });
            });
            binding.assertCurrent(); checkAlive();
            if (agent) return result as z.infer<typeof OnlineJobSchema>;
            const workerCount = prepared.prepared.stressRunConfig?.workerCount;
            return OnlineLocalResultSchema.parse({ location: { kind: "local" }, runId: input.runId, snapshotId: snapshot.snapshotId, manifestHash: snapshot.assets.manifestHash, runtimeCompatibilityId, scriptTimeoutMs: effective.policy.scriptTimeoutMs, ...(localSession ? { debugSessionId: localSession.id } : {}), ...(workerCount ? { localStress: { workerCount, processBudget: workerCount === 1 ? 1 : workerCount + 1, runtime: { coreBuildId: identity.coreBuildId, scriptApiId: identity.scriptApiId, nodeVersion: process.versions.node, v8Version: process.versions.v8, runtimeCompatibilityId },...(processObservation?{processObservation}:{}) } } : {}), output: JSON.parse(JSON.stringify(result)) });
          }).then(result => { if (run) run.result = OnlineLocalResultSchema.parse(result); return result; }, error => {
            if (run) {
              const rawCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.message.split(":", 1)[0]! : "";
              const reasonCode = /^[a-z][a-z0-9_-]{0,95}$/.test(rawCode) ? rawCode : run.started ? "local-execution-failed" : "local-preparation-failed";
              run.failure = OnlineReportSchema.parse({ executionId: input.runId, verdict: abort.signal.reason instanceof Error && abort.signal.reason.message === "local-run-cancelled" ? "cancelled" : reasonCode === "job-timeout" ? "timed-out" : "failed", executionFact: run.started ? "uncertain" : "not-started", reasonCode,...(processObservation?{processObservation}:{}) });
            }
            throw error;
          }).finally(() => { if (localSession && --localSession.record.refs === 0) localSession.record.idleSince = performance.now(); if (deadlineTimer) clearTimeout(deadlineTimer); if (run) { run.settled = true; trimHistory(); } });
          // Register before the microtask can enter its first asynchronous admission operation.
          if (input.location.kind === "local") { run = { context: contextKey(input), abort, completion: completion as Promise<OnlineLocalResult>, started: false, settled: false }; localRuns.set(input.runId, run); }
          return completion;
        }
      }
    },
  };
}
