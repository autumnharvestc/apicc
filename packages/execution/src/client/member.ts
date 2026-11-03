import { z } from "zod";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import { StressPlanSchema } from '@apicc/core/schema';
import { CredentialError, collectNetworkDependencies, decodeContractProjectFiles, createSystemSecretStore, defaultCredentialPrivateRoot, prepareTestData, testDataSelectionsForRequests, prepareNetworkRun, selectCredentialRequests, createHttpSession, createUserPluginHostFromSnapshot, type SecretStore, type NetworkTLSSettings, type PreparedNetworkRun } from "@apicc/core";
import { ProjectAssetsSchema, ExecutionSnapshotSchema, ProjectExecutionAgentsSchema, SubmitJobSchema, PolicyConfigSchema, runtimeCompatibilityIdForRuntime, logicalNetworkPath, resolveEffectiveConfig, defaultAgentConfig, type ProjectAssets } from "../contract/index.js";
import { prepareProjectFiles, invokeExecution, createOnlineProjectSecretStore, prepareRunCredentials, withRunCredentials, withDeclaredInputFiles, createExecutionRegistry } from "../host/index.js";
import { createMemberMaterialsClient } from "./materials.js";
import { ExecutionHttpError } from "./http.js";
import { readBuildIdentity } from "@apicc/execution/buildIdentity";
import { OnlineJobSchema, OnlineLocalResultSchema, OnlineReportSchema, MemberRunInputSchema, type MemberRunInput, type MemberExecutionContext, type MemberExecutionDependencies, type MemberExecutionClient, type PreparedMemberRun, type MemberStartedRun, type ExecutionLocation, type OnlineLocalResult, type OnlineReport, type OnlineJob } from "./memberTypes.js";
import { createBoundedMemberFetch, createMemberExecutionRequest } from "./memberHttp.js";
import { onlineJobScope, isFullOnlineJob } from './memberTypes.js';
import { createMemberLocalCredentialStore, memberLocalScope } from "./memberLocal.js";

type LocalRun = { context: string; abort: AbortController; completion: Promise<OnlineLocalResult>; result?: OnlineLocalResult; failure?: OnlineReport; started: boolean; settled: boolean };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((yes,no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function withCallSignal<T>(signal: AbortSignal, completion: Promise<T>):Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try { return await Promise.race([completion, new Promise<never>((_,reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort',abort,{once:true}); if (signal.aborted) abort(); })]); }
  finally { signal.removeEventListener('abort',abort); }
}
function assertAssetsScope(assets: ProjectAssets, context: MemberExecutionContext) {
  if (assets.workspaceId !== context.scope.workspaceId || assets.groupId !== context.scope.groupId || assets.projectId !== context.scope.projectId) throw new Error('online-project-scope-mismatch');
}
function assertJob(job: OnlineJob, context: MemberExecutionContext, location?: ExecutionLocation) {
  const scope = onlineJobScope(job);
  if (scope.workspaceId !== context.scope.workspaceId || scope.groupId !== context.scope.groupId || scope.projectId !== context.scope.projectId || location?.kind === 'agent' && job.agentId !== location.agentId) throw new Error('online-project-scope-mismatch');
  return job;
}
type PreparedRecord = { input: MemberRunInput; abort: AbortController; ticket?: PreparedMemberRun; localRun?: LocalRun; discarded?: boolean; intentId?: string; attempted?: boolean; submission?: (intent:string)=>z.infer<typeof SubmitJobSchema>; release(intent: string): void; admitted: Promise<void>; completion: Promise<OnlineLocalResult | OnlineJob> };
export function createMemberExecutionClient(deps: MemberExecutionDependencies): MemberExecutionClient {
  const localRuns = new Map<string, LocalRun>();
  const records = new WeakMap<PreparedMemberRun, PreparedRecord>();
  const pending = new Set<PreparedRecord>();
  let closed = false;
  const trimHistory = () => { const terminal = [...localRuns].filter(([, run]) => run.settled); for (const [id] of terminal.slice(0, Math.max(0, terminal.length - 100))) localRuns.delete(id); };
  type LocalDebugSession = { key: string; session: ReturnType<typeof createHttpSession>; refs: number; idleSince: number };
  const debugSessions = new Map<string, LocalDebugSession>();
  const contextKey = (input: { context: MemberExecutionContext }) => JSON.stringify(input.context);
  let localStore: SecretStore | undefined;
  const getLocalStore = () => localStore ??= deps.localStore?.() ?? createSystemSecretStore({ privateRoot: defaultCredentialPrivateRoot() });
  const capture=(context:MemberExecutionContext)=>{const binding=deps.session.captureExecution(context);binding.assertCurrent();if(binding.userId!==context.ownerId||binding.serverId!==context.serverId)throw new Error('online-session-changed');return binding;};
  const requestFor = (context: MemberExecutionContext, signal: AbortSignal) => createMemberExecutionRequest(capture(context), deps.fetch, signal);
  const pathFor = (context: MemberExecutionContext) => `workspaces/${context.scope.workspaceId}/projects/${context.scope.projectId}`;
  const localRun = (context: MemberExecutionContext, runId: string) => { capture(context); const run = localRuns.get(runId); if (!run || run.context !== contextKey({context})) throw new Error('local-run-unavailable-no-backend-handoff'); return run; };
  const client: MemberExecutionClient = {
    async stopOwnedLocalRun(prepared) {
      const record=records.get(prepared);if(!record)throw new Error('unknown-prepared-member-run');
      const run=record.localRun;if(!run)throw new Error('owned-local-cleanup-not-supported');
      if(!record.attempted)record.discarded=true;
      if(!run.settled)run.abort.abort(new Error('local-run-cancelled'));
      await run.completion.catch(()=>{});
    },
    async releaseLocalResult(prepared){
      const record=records.get(prepared);if(!record)throw new Error('unknown-prepared-member-run');
      const run=record.localRun;
      if(!run||run.completion!==record.completion||!record.attempted||!run.settled||!(run.result||run.failure?.executionFact==='not-started'))throw new Error('local-result-not-releasable');
      if(localRuns.get(record.input.runId)===run)localRuns.delete(record.input.runId);
      records.delete(prepared);pending.delete(record);
    },
    async discardPrepared(prepared){
      const record=records.get(prepared);if(!record)throw new Error('unknown-prepared-member-run');
      if(record.intentId!==undefined)throw new Error('prepared-member-run-already-started');
      record.discarded=true;record.abort.abort(new Error('prepared-member-run-discarded'));
      await record.completion.catch(()=>{});
      if(record.input.location.kind==='local')localRuns.delete(record.input.runId);
    },
    async assets(context, signal) {
      const assets = await requestFor(context,signal)('GET',`${pathFor(context)}/assets`,undefined,ProjectAssetsSchema); assertAssetsScope(assets,context);
      if (assets.format !== 'contract-files-v1') return { assets, project: null, problems: ['legacy-format-publish-new-project'] };
      const decoded = await decodeContractProjectFiles(new Map(assets.files.map(file => [file.path,file.content])));
      if (decoded.project?.id !== assets.contractProjectId) return { assets, project: null, problems: ['contract-project-identity-mismatch'] };
      return { assets, project: !decoded.readOnly && !decoded.problems.length ? decoded.project ?? null : null, problems: decoded.problems.map(problem => `${problem.file}: ${problem.message}`) };
    },
    async findIntent(context, intentId, signal) {
      const request = requestFor(context,signal);
      try { const job = await request('GET',`${pathFor(context)}/jobs/by-intent?intentId=${encodeURIComponent(intentId)}`,undefined,OnlineJobSchema); return assertJob(job,context); }
      catch (error) { if (error instanceof ExecutionHttpError && error.status === 404 && error.code === 'job_not_found') return null; throw error; }
    },
    async prepare(raw, signal) {
      const binding = capture(raw.context);
      if (raw.location.kind === 'agent' && raw.localOnlyRefIds.length) throw new Error('local-material-required');
      const input = MemberRunInputSchema.parse(structuredClone(raw));
      const path = pathFor(input.context);
      const admittedAt = performance.now();
      if (closed) throw new Error('local-run-unavailable-no-backend-handoff');
      if (localRuns.has(input.runId)) throw new Error('run-already-started');
      const abort = new AbortController();
      const parentAbort = () => abort.abort(signal.reason); signal.addEventListener('abort', parentAbort, {once:true}); if (signal.aborted) parentAbort();
      const ready = deferred<PreparedMemberRun>(); const gate = deferred<void>(); const admitted = deferred<void>(); let intentId = input.runId;
      void admitted.promise.catch(()=>{});
      const record: PreparedRecord = { input, abort, release(intent) { intentId = intent; gate.resolve(); }, admitted: admitted.promise, completion: undefined! };
      let run: LocalRun | undefined; let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline = input.runConfig.jobTimeoutMs === undefined ? undefined : admittedAt + input.runConfig.jobTimeoutMs;
      const checkAlive = () => { if (deadline !== undefined && performance.now() >= deadline && !abort.signal.aborted) abort.abort(new Error('job-timeout')); abort.signal.throwIfAborted(); };
      const armDeadline = () => { if (deadlineTimer) clearTimeout(deadlineTimer); if (deadline === undefined || abort.signal.aborted) return; const remaining = deadline - performance.now(); if (remaining <= 0) abort.abort(new Error('job-timeout')); else deadlineTimer = setTimeout(armDeadline, Math.min(remaining,2147483647)); };
      armDeadline();
      let localSession: { id: string; record: LocalDebugSession; created:boolean } | undefined;
          const completion = Promise.resolve().then(async () => {
          checkAlive();
          if (input.materials.projectId !== input.context.scope.projectId) throw new Error("online-project-scope-mismatch");
          const request = createMemberExecutionRequest(binding, deps.fetch, abort.signal);
          const view = await request("GET", `${path}/execution-agents`, undefined, ProjectExecutionAgentsSchema);
          const agentId = input.location.kind === "agent" ? input.location.agentId : undefined;
          const agent = agentId ? view.agents.find(agent => agent.id === agentId) : undefined;
          if (input.location.kind === "agent" && (!agent || agent.availability !== "available" || !agent.runtime || agent.configuration.status !== "applied")) throw new Error("agent-unavailable");
          const policy = PolicyConfigSchema.parse(agent?.policy ?? view.policy);
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
              record.refs++; localSession = { id: input.debugSessionId, record, created:false };
            } else {
              if (debugSessions.size >= defaultAgentConfig.maxDebugSessions) throw new Error('debug-session-capacity-exceeded');
              const id = randomUUID(); const record = { key, session: createHttpSession(), refs: 1, idleSince: now }; debugSessions.set(id, record); localSession = { id, record, created:true };
            }
          }
          const debugSessionScope = localSession ? { serverId: binding.serverId, scope: input.context.scope, submittedByUserId: binding.userId, debugSessionId: localSession.id } : undefined;
          const prepareInput = { target: input.target, environmentId: input.environmentId, requestSettings: input.runConfig.requestSettings, scriptTimeoutMs: effective.policy.scriptTimeoutMs, maxScriptTimeoutMs: policy.maxScriptTimeoutMs, debugSessionScope, evidenceLimits: { bodyBytes: policy.bodyPreviewBytes, valueBytes: policy.valuePreviewBytes, caseBytes: policy.caseEvidenceBytes, reportBytes: policy.reportBytes, workflowMetadataBytes: policy.workflowMetadataBytes },
          };
          let prepared = await prepareProjectFiles(snapshot.assets, { ...prepareInput, profile: "trusted-core-script" });
          checkAlive();
          const hasScripts = prepared.scriptRequirements.length > 0;
          if (!hasScripts) prepared = await prepareProjectFiles(snapshot.assets, { ...prepareInput, profile: "no-script" });
          checkAlive();
          if (agent) {
            if (identity.coreBuildId !== agent.runtime!.coreBuildId || identity.scriptApiId !== agent.runtime!.scriptApiId || prepared.prepared.requiredCapabilities.some(capability => !agent.runtime!.capabilities.includes(capability))) throw new Error("runtime-mismatch");
            const rejected = prepared.scriptRequirements.filter(script => !agent.scriptsAllowed || agent.scriptGrant.version === "0" || agent.scriptGrant.scope !== "project" && !agent.scriptGrant.scripts.some(grant => grant.scriptId === script.scriptId && grant.contentHash === script.contentHash));
            if (rejected.length) throw new Error(`script-admission-denied: ${rejected.map(script => `${script.scriptId}@${script.contentHash}`).join(", ")}`);
          }
          checkAlive();
            const materialsClient = createMemberMaterialsClient({ baseUrl: binding.serverId, token: async () => {
              binding.assertCurrent();
              const token = await withCallSignal(abort.signal, Promise.resolve(binding.token()));
              binding.assertCurrent();
              return token;
            }, fetch: createBoundedMemberFetch(deps.fetch) });
            const location = input.target.kind === "debug" ? input.target.invocation.mode === "free" ? input.target.invocation.project : input.target.invocation.locator : { workspaceId: input.context.scope.workspaceId, groupId: input.context.scope.groupId, projectId: snapshot.assets.contractProjectId! };
            const contractScope = { workspaceId: location.workspaceId, groupId: location.groupId, projectId: location.projectId };
            const materialBinding = { serverId: binding.serverId, userId: binding.userId, scope: input.context.scope, contractScope, snapshotId: snapshot.snapshotId };
            const projectStore = createOnlineProjectSecretStore(materialBinding, async (_binding, selection) => { binding.assertCurrent(); const result = await materialsClient.loadLocal(snapshot.snapshotId, selection, abort.signal); binding.assertCurrent(); return result; });
            // Request/transport credentials are selected by actual Core preparation, not by an
            // empty or overbroad renderer list. This bundle stages only declared ordinary files.
            const remoteMaterials = await materialsClient.loadLocal(snapshot.snapshotId, { ...input.materials, credentials: [] }, abort.signal);
            checkAlive();
            binding.assertCurrent();
            const store = createMemberLocalCredentialStore({ contractScope, projectStore, localStore: input.localOnlyRefIds.length ? getLocalStore() : projectStore, localOnlyRefIds: input.localOnlyRefIds, localScope: memberLocalScope(input.context, contractScope.projectId) });
            const result = await withDeclaredInputFiles(remoteMaterials, input.materials.attachmentPaths ?? {}, { totalInputBytes: policy.totalInputBytes, minFreeDiskBytes: defaultAgentConfig.minFreeDiskBytes }, async files => {
              checkAlive();
              for (const { request: selected } of selectCredentialRequests(prepared.prepared.snapshot, prepared.prepared.selections)) {
                if ('body' in selected && selected.body.kind === 'binary') files.pathFor(selected.body.file.path);
                if ('body' in selected && selected.body.kind === 'multipart') for (const entry of selected.body.entries) if (entry.kind === 'file' && entry.enabled) files.pathFor(entry.file.path);
              }
              for (const selected of prepared.prepared.selections) { const driver = selected.testCase?.dataDriver; if (driver && !('kind' in driver)) files.pathFor(driver.sourcePath); }
              const data = await prepareTestData(prepared.prepared.snapshot, prepared.prepared.suitePlan?.selections ?? testDataSelectionsForRequests(prepared.prepared.snapshot, prepared.prepared.selections, prepared.prepared.environmentId), { workspaceRoot: files.workspaceRoot });
              checkAlive();
              const networkVersions: Record<string,string> = {};
              if (input.network) {
                const dependencies = collectNetworkDependencies({ configuration: input.network.configuration, selection: input.network.selection, environmentId: prepared.prepared.environmentId });
                for (const certificate of dependencies.certificatePaths) files.pathFor(logicalNetworkPath(certificate.path));
                for (const need of dependencies.secretNeeds) networkVersions[need.ref.id] = await store.version(contractScope,need.ref);
              }
              const credentials = await prepareRunCredentials(prepared.prepared, materialBinding, store);
              try { checkAlive(); } catch (error) { credentials.dispose(); throw error; }
              for (const [refId, version] of Object.entries(networkVersions)) if (credentials.versions[refId] && credentials.versions[refId] !== version) { credentials.dispose(); throw new Error('CREDENTIAL_VERSION_CONFLICT'); }
              const versions = { ...credentials.versions, ...networkVersions };
              const pluginSnapshot = await deps.plugins?.snapshot();
              if(agent)record.submission=(intent)=>SubmitJobSchema.parse({ intentId: intent, agentId: agent.id, snapshotId: snapshot.snapshotId, target: input.target, environmentId: input.environmentId, debugSessionId: input.debugSessionId, runConfig: input.runConfig, materials: { ...input.materials, credentials: Object.entries(versions).map(([refId, version])=>({refId,version})) }, network: input.network,
                preparation: { scope: input.context.scope, manifestHash: snapshot.assets.manifestHash, scriptPlanDigest: prepared.scriptPlanDigest, ...(hasScripts ? {scriptGrantVersion:agent.scriptGrant.version}:{}), scriptRequirements:prepared.scriptRequirements, executionProfile:hasScripts?'trusted-core-script':'no-script', dispatchKind:input.target.kind==='debug'&&!hasScripts?'shared-debug':'dedicated-task', requiredCoreBuildId:identity.coreBuildId, requiredCapabilities:prepared.prepared.requiredCapabilities, runtimeCompatibilityId } });
              const ticket = Object.freeze({ summary: Object.freeze({ runId: input.runId, location: Object.freeze({ ...input.location }), snapshotId: snapshot.snapshotId, manifestHash: snapshot.assets.manifestHash, materialVersions: Object.freeze({ ...versions }), scriptPlanDigest: prepared.scriptPlanDigest,
                assetVersion:snapshot.assets.version,environmentId:prepared.prepared.environmentId??null,targetKind:input.target.kind,executionProfile:prepared.prepared.profile,policyVersion:agent?.policyVersion??view.policyVersion,
                budgets:Object.freeze({jobTimeoutMs:effective.jobTimeoutMs,scriptTimeoutMs:effective.policy.scriptTimeoutMs,cancelGraceMs:policy.cancelGraceMs,maxJobTimeoutMs:policy.maxJobTimeoutMs,maxScriptTimeoutMs:policy.maxScriptTimeoutMs,totalInputBytes:policy.totalInputBytes,reportBytes:policy.reportBytes}),
                sources:Object.freeze({policy:agent?'agent-effective':'project-effective',jobTimeoutMs:input.runConfig.jobTimeoutMs===undefined?'server-effective-policy':'run',scriptTimeoutMs:input.runConfig.scriptTimeoutMs===undefined?'server-effective-policy':'run'}),
                limitations:Object.freeze(['policy-layer-provenance-unavailable','start-rechecks-current-authority']),
              }) }) as PreparedMemberRun;
              record.ticket = ticket; records.set(ticket, record); ready.resolve(ticket);
              await withCallSignal(abort.signal, gate.promise);
              checkAlive(); binding.assertCurrent();
              if (agent) {
                try {
                  binding.assertCurrent(); checkAlive();
                  return assertJob(await request("POST", `${path}/jobs`, record.submission!(intentId), OnlineJobSchema), input.context, input.location);
                } finally { credentials.dispose(); }
              }
              // The same fixed snapshot/material selection also rechecks current execution authority.
              await materialsClient.loadLocal(snapshot.snapshotId,{...input.materials,credentials:[]},abort.signal);
              binding.assertCurrent();checkAlive();
              for (const [refId, version] of Object.entries(networkVersions)) if (await store.version(contractScope, { id: refId, policy: 'test-auto' }) !== version) { credentials.dispose(); throw new Error('CREDENTIAL_VERSION_CONFLICT'); }
              let network: PreparedNetworkRun | undefined;
              if (input.network) {
                const fixed = structuredClone(input.network);
                const mapTLS = (tls: NetworkTLSSettings | undefined) => { if(tls?.caCertificatePaths)tls.caCertificatePaths=tls.caCertificatePaths.map(path=>files.pathFor(logicalNetworkPath(path)));if(tls?.clientCertificatePaths)tls.clientCertificatePaths=tls.clientCertificatePaths.map(path=>files.pathFor(logicalNetworkPath(path))); };
                for(const profile of fixed.configuration.profiles){for(const binding of profile.targetTlsBindings)mapTLS(binding.tls);if(profile.kind==='proxy')mapTLS(profile.proxyTLS);}
                const fixedVersion = (id:string) => { const version=networkVersions[id];if(!version)throw new CredentialError('CREDENTIAL_VERSION_CONFLICT',id);return version; };
                const fixedStore: SecretStore = { ...store,
                  async version(scope,ref){const version=fixedVersion(ref.id);if(await store.version(scope,ref)!==version)throw new CredentialError('CREDENTIAL_VERSION_CONFLICT',ref.id);return version;},
                  async resolve(scope,ref,expected){const version=fixedVersion(ref.id);if(expected!==undefined&&expected!==version)throw new CredentialError('CREDENTIAL_VERSION_CONFLICT',ref.id);return store.resolve(scope,ref,version);},
                };
                network=await prepareNetworkRun({scope:{canonicalRoot:files.workspaceRoot,project:contractScope,...(prepared.prepared.environmentId?{environmentId:prepared.prepared.environmentId}:{})},secretStore:fixedStore,store:{load:async()=>({revision:fixed.revision,configuration:fixed.configuration}),save:async()=>{throw new Error('fixed-network-read-only');}},selection:fixed.selection,signal:abort.signal});
              }
              return withRunCredentials(credentials, async credentialBindings => {
                binding.assertCurrent(); checkAlive();
                if (run) run.started = true;
                admitted.resolve();
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
            return OnlineLocalResultSchema.parse({ location: { kind: "local" }, runId: input.runId, snapshotId: snapshot.snapshotId, manifestHash: snapshot.assets.manifestHash, runtimeCompatibilityId, scriptTimeoutMs: effective.policy.scriptTimeoutMs, ...(localSession ? { debugSessionId: localSession.id } : {}), output: JSON.parse(JSON.stringify(result)) });
          }).then(result => { if (run) run.result = OnlineLocalResultSchema.parse(result); return result; }, error => {
            if (run) {
              const rawCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.message.split(":", 1)[0]! : "";
              const reasonCode = /^[a-zA-Z][a-zA-Z0-9_-]{0,95}$/.test(rawCode) ? rawCode : run.started ? "local-execution-failed" : "local-preparation-failed";
              run.failure = OnlineReportSchema.parse({ executionId: input.runId, verdict: abort.signal.reason instanceof Error && abort.signal.reason.message === "local-run-cancelled" ? "cancelled" : reasonCode === "job-timeout" ? "timed-out" : "failed", executionFact: run.started ? "uncertain" : "not-started", reasonCode });
            }
            ready.reject(error); admitted.reject(error); throw error;
          }).finally(async () => {
            if(localSession&&--localSession.record.refs===0){
              if(localSession.created&&!run?.started){debugSessions.delete(localSession.id);await localSession.record.session.close();}
              else localSession.record.idleSince=performance.now();
            }
            if(deadlineTimer)clearTimeout(deadlineTimer);if(run){run.settled=true;trimHistory();}
          });

      record.completion = completion as Promise<OnlineLocalResult | OnlineJob>;
      pending.add(record);
      void completion.catch(() => {}).finally(() => { pending.delete(record); });
      if (input.location.kind === 'local') { run = { context: contextKey(input), abort, completion: completion as Promise<OnlineLocalResult>, started: false, settled: false }; record.localRun=run;localRuns.set(input.runId, run); }
      return ready.promise.finally(()=>signal.removeEventListener('abort',parentAbort));
    },
    async start(prepared, intentId, signal) {
      const record = records.get(prepared);
      if (!record) throw new Error('unknown-prepared-member-run');
      if(record.discarded)throw new Error('prepared-member-run-discarded');
      if (closed) throw new Error('member-client-closed');
      capture(record.input.context); signal.throwIfAborted();
      if(record.intentId!==undefined&&record.intentId!==intentId)throw new Error('intent_conflict');
      record.intentId=intentId;
      const begin=()=>{
        record.attempted=true;
        const cancel=()=>record.abort.abort(signal.reason);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
        record.release(intentId);
        return ()=>signal.removeEventListener('abort',cancel);
      };
      if (record.input.location.kind === 'agent') {
        // Reconciliation is read-only, even after a lost submit response or expired preparation.
        const prior=await client.findIntent(record.input.context,intentId,signal);
        if(prior){
          const job=assertJob(await requestFor(record.input.context,signal)('POST',`${pathFor(record.input.context)}/jobs/by-intent/verify`,record.submission!(intentId),OnlineJobSchema),record.input.context,record.input.location);
          return {runId:job.jobId,location:record.input.location,snapshotId:isFullOnlineJob(job)?job.task.snapshotId:prepared.summary.snapshotId,manifestHash:isFullOnlineJob(job)?job.task.manifestHash:prepared.summary.manifestHash,state:job.state,job};
        }
        if(record.attempted)throw new Error('execution-outcome-uncertain');
        const detach=begin();
        try {const job = await withCallSignal(signal,record.completion) as OnlineJob;
          return { runId: job.jobId, location: record.input.location, snapshotId: prepared.summary.snapshotId, manifestHash: prepared.summary.manifestHash, state: job.state, job };
        }finally{detach();}
      }
      const detach=record.attempted?()=>{}:begin();
      try {await withCallSignal(signal,record.admitted);
        return { runId: record.input.runId, location: record.input.location, snapshotId: prepared.summary.snapshotId, manifestHash: prepared.summary.manifestHash, state: 'running' };
      }finally{detach();}
    },
    async status(context, location, runId, signal) {
      signal.throwIfAborted();
      if (location.kind === 'local') { const run = localRun(context,runId); return { runId, location, state: run.settled ? 'ended' : run.started ? 'running' : 'preparing' }; }
      return assertJob(await requestFor(context,signal)('GET',`jobs/${runId}`,undefined,OnlineJobSchema),context,location);
    },
    async cancel(context, location, runId, signal) {
      signal.throwIfAborted();
      if (location.kind === 'local') { const run = localRun(context,runId); if (!run.settled) run.abort.abort(new Error('local-run-cancelled')); return withCallSignal(signal,Promise.resolve(run.result ?? run.failure ?? run.completion.catch(() => run.failure!))); }
      await client.status(context,location,runId,signal);
      return assertJob(await requestFor(context,signal)('POST',`jobs/${runId}/cancel`,{},OnlineJobSchema),context,location);
    },
    async report(context, location, runId, signal) {
      signal.throwIfAborted();
      if (location.kind === 'local') { const run = localRun(context,runId); return withCallSignal(signal,Promise.resolve(run.result ?? run.failure ?? run.completion.catch(() => run.failure!))); }
      let job = await client.status(context,location,runId,signal) as OnlineJob;
      const report = await requestFor(context,signal)('GET',`jobs/${runId}/report`,undefined,OnlineReportSchema).catch(error => { if (error instanceof z.ZodError && error.issues.some(issue => issue.path[0] === 'output')) throw new Error('invalid-core-output'); throw error; });
      if (!isFullOnlineJob(job)) {
        const current = assertJob(await requestFor(context,signal)('GET',`jobs/${runId}`,undefined,OnlineJobSchema),context,location);
        if (!isFullOnlineJob(current) || current.jobId !== job.jobId || current.executionId !== job.executionId) throw new Error('fixed-input-mismatch');
        job = current;
      }
      if (report.executionId !== job.executionId) throw new Error('fixed-input-mismatch');
      if(report.processObservation&&job.task.target.kind!=='stress')throw new Error('fixed-input-mismatch');
      if(report.output&&(job.task.target.kind==='stress')!==(report.output.kind==='stress'||report.output.kind==='stress-failure'))throw new Error('fixed-input-mismatch');
      if(report.output?.kind==='stress'&&job.task.target.kind==='stress'){
        const environmentId=job.task.target.plan.environmentId??job.task.environmentId;
        const plan=StressPlanSchema.parse({...job.task.target.plan,...(environmentId?{environmentId}:{})});
        if(report.output.result.projectId!==job.task.contractProjectId||report.output.result.environmentId!==(environmentId??null)||!isDeepStrictEqual(report.output.result.plan,plan)||!isDeepStrictEqual(report.output.result.target,plan.target))throw new Error('fixed-input-mismatch');
      }
      return report;
    },
    async close() {
      closed = true;
      for (const record of pending) record.abort.abort(new Error('local-run-cancelled'));
      await Promise.allSettled([...pending].map(record => record.completion)); localRuns.clear();
      await Promise.allSettled([...debugSessions.values()].map(record => record.session.close())); debugSessions.clear();
    },
  };
  return client;
}
