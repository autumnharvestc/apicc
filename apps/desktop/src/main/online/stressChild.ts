import { prepareCredentialBindings, bindPreparedTestData, prepareNetworkRun, collectCredentialRefsForRequests, selectCredentialRequests, collectCredentialMarkersForRequests, bindPreparedStressExecution, createExecutionEvidenceCollector, createPreparedStressHost, serveLocalStressWorker, createUserPluginHostFromSnapshot, type SecretStore, type StressWorkerChannel } from '@apicc/core';
import { prepareProjectFiles, assertStressExecutionDeadline, invokeExecution, createExecutionRegistry, processStressWorkerChannel, localStressClock, localStressClockDomain } from '@apicc/execution/host';
import { runtimeCompatibilityIdForRuntime, ProjectAssetsSchema } from '@apicc/execution/contract';
import { readBuildIdentity } from '@apicc/execution/buildIdentity';
import { OnlineExecutionContextSchema } from '../../shared/online/execution.js';
import type { DesktopStressConfiguration, DesktopBrokerRequest } from './stressProcess.js';

const channel = processStressWorkerChannel();
const role = process.argv[2], outerRunId = process.argv[3]!;
const controller = new AbortController();
let registry: ReturnType<typeof createExecutionRegistry> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
function storeFor(versions: Record<string, string>, values: Record<string, string>): SecretStore {
  const read = (id: string) => { if (!Object.hasOwn(versions, id) || !Object.hasOwn(values, id)) throw new Error('fixed-input-mismatch'); return values[id]!; };
  return { async resolve(_scope, ref, expected) { if (expected !== undefined && versions[ref.id] !== expected) throw new Error('fixed-input-mismatch'); return read(ref.id); }, async version(_scope, ref) { read(ref.id); return versions[ref.id]!; }, async put() { throw new Error('fixed-material-read-only'); }, async remove() { throw new Error('fixed-material-read-only'); }, async status(_scope, ref) { read(ref.id); return 'available'; } };
}
async function prepare(configuration: DesktopStressConfiguration, signal: AbortSignal) {
  const identity = await readBuildIdentity();
  const actualRuntime = runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId);
  const context = OnlineExecutionContextSchema.parse(configuration.identity.context), assets = ProjectAssetsSchema.parse(configuration.assets);
  if (configuration.protocolVersion !== 1 || configuration.identity.runId !== outerRunId || configuration.identity.coreBuildId !== identity.coreBuildId || configuration.identity.scriptApiId !== identity.scriptApiId || configuration.identity.runtimeCompatibilityId !== actualRuntime || configuration.identity.manifestHash !== assets.manifestHash || context.scope.projectId !== assets.projectId || context.scope.groupId !== assets.groupId || context.scope.workspaceId !== assets.workspaceId) throw new Error('fixed-input-mismatch');
  signal.throwIfAborted();
  const project = await prepareProjectFiles(assets, configuration.prepare), prepared = project.prepared;
  if (prepared.target.kind !== 'stress' || project.scriptPlanDigest !== configuration.identity.scriptPlanDigest) throw new Error('fixed-input-mismatch');
  assertStressExecutionDeadline(prepared, configuration.deadlineAt - Date.now());
  deadline = setTimeout(() => { controller.abort(new Error('job-timeout')); }, Math.max(1, configuration.deadlineAt - Date.now()));
  const requests = selectCredentialRequests(prepared.snapshot, prepared.selections);
  const credentialBindings = await prepareCredentialBindings(configuration.credentials.scope, collectCredentialRefsForRequests(prepared.snapshot.project, requests), storeFor(configuration.credentials.versions, configuration.credentials.values), configuration.credentials.versions);
  const preparedTestData = bindPreparedTestData(prepared.snapshot, configuration.preparedTestData);
  let network;
  if (configuration.network) {
    const fixed = configuration.network;
    network = await prepareNetworkRun({ scope: { canonicalRoot: configuration.workspaceRoot, project: fixed.scope, ...(prepared.environmentId ? { environmentId: prepared.environmentId } : {}) }, store: { load: async () => ({ revision: fixed.revision, configuration: fixed.configuration }), save: async () => { throw new Error('fixed-material-read-only'); } }, selection: fixed.selection, secretStore: storeFor(fixed.credentialVersions, fixed.values), signal });
    if (network.identity !== fixed.identity || JSON.stringify(network.credentialVersions) !== JSON.stringify(fixed.credentialVersions)) throw new Error('fixed-input-mismatch');
  }
  const registryFactory = async (options: Parameters<typeof createExecutionRegistry>[0]) => {
    const base = createExecutionRegistry(options);
    try { if (configuration.pluginSnapshot) await createUserPluginHostFromSnapshot(configuration.pluginSnapshot, { hostVersion: configuration.pluginSnapshot.hostVersion, registry: base }).registry(); return base; }
    catch (error) { await base.close(); throw error; }
  };
  return { prepared, materials: { credentialBindings, preparedTestData, network, workspaceRoot: configuration.workspaceRoot }, registryFactory };
}

// The broker is a private multiplexing adapter, not a native-clock capability.
function brokerWorker(identity: { runId: string; workerId: string }): Promise<StressWorkerChannel> {
  const listeners = new Set<(value: unknown) => void>(), closed = new Set<() => void>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let id = 0; let closing: Promise<void> | undefined;
  const unsubscribe = channel.subscribe(raw => {
    const message = raw as { kind: string; runId: string; workerId?: string; id?: number; ok?: boolean; value?: unknown };
    if (message.runId !== outerRunId) return;
    if (message.kind === 'broker-ack' && message.id !== undefined) { const call = pending.get(message.id); if (call) { pending.delete(message.id); if (message.ok) call.resolve(message.value); else call.reject(new Error('worker-failed')); } }
    else if (message.workerId === identity.workerId && message.kind === 'broker-frame') listeners.forEach(listener => listener(message.value));
    else if (message.workerId === identity.workerId && message.kind === 'broker-closed') closed.forEach(listener => listener());
  });
  // IDs are unique across all worker adapters in this coordinator.
  const request = (operation: DesktopBrokerRequest['operation'], value?: unknown) => new Promise<unknown>((resolve, reject) => {
    id = ++brokerSerial; const requestId = id; pending.set(requestId, { resolve, reject });
    void Promise.resolve(channel.send({ kind: 'broker', runId: outerRunId, id: requestId, identity, operation, ...(value === undefined ? {} : { value }) })).catch(error => { pending.delete(requestId); reject(error); });
  });
  const disconnected = channel.onClose(() => { pending.forEach(call => call.reject(new Error('worker-failed'))); pending.clear(); closed.forEach(listener => listener()); });
  const transport: StressWorkerChannel = { async send(value) { await request('send', value); }, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, onClose(listener) { closed.add(listener); return () => { closed.delete(listener); }; }, async waitForExit() { return await request('wait') as { code: number | null; signal: string | null }; }, close() { return closing ??= (async () => { try { await request('close'); } finally { unsubscribe(); disconnected(); } })(); } };
  return request('spawn').then(() => transport);
}
let brokerSerial = 0;
let peer: ReturnType<typeof serveLocalStressWorker> | undefined;
if (role === 'worker') {
  peer = serveLocalStressWorker(channel, { runId: process.argv[4]!, workerId: process.argv[5]! }, async (raw, signal) => {
    const configuration = raw as DesktopStressConfiguration;
    const { prepared, materials, registryFactory } = await prepare(configuration, signal);
    registry = await registryFactory({ profile: prepared.profile, scriptTimeoutMs: prepared.scriptTimeoutMs });
    const markers = [...collectCredentialMarkersForRequests(prepared.snapshot.project, selectCredentialRequests(prepared.snapshot, prepared.selections), materials.credentialBindings), ...(materials.network?.outputMarkers ?? [])];
    const evidence = createExecutionEvidenceCollector({ projectId: prepared.snapshot.project.id, definitionRevision: prepared.snapshot.definitionRevision, environmentId: prepared.environmentId, dataDigest: materials.preparedTestData.digest }, markers, { privateMarkers: true, maxSamples: prepared.stressPlan!.metricPlan.evidence.maxSamples, limits: prepared.evidenceLimits });
    const execution = bindPreparedStressExecution(prepared.stressPlan!, { snapshot: prepared.snapshot, ...materials });
    const host = createPreparedStressHost(execution, { registry, evidence, workspaceRoot: materials.workspaceRoot, requestSettings: prepared.requestSettings }, { confirmedTargetOrigins: prepared.stressRunConfig!.confirmedTargetOrigins });
    return { clock: localStressClock, metricPlan: execution.compiled.metricPlan, lifecycle: prepared.target.kind === 'stress' ? prepared.target.plan.lifecycle : undefined, evidence, host: { ...host, async closeRun() { await host.closeRun?.(); await registry?.close(); clearTimeout(deadline); } } };
  }, localStressClockDomain);
} else if (role === 'coordinator') {
  let started = false;
  channel.subscribe(raw => {
    const message = raw as { kind: string; runId: string; configuration?: DesktopStressConfiguration };
    if (message.runId !== outerRunId) { controller.abort(); return; }
    if (message.kind === 'cancel') { controller.abort(new Error('local-run-cancelled')); return; }
    if (message.kind !== 'run' || started || !message.configuration) return;
    started = true; const configuration = message.configuration;
    void (async () => {
      try {
        const { prepared, materials, registryFactory } = await prepare(configuration, controller.signal);
        const count = prepared.stressRunConfig!.workerCount;
        const output = await invokeExecution(prepared, materials, { signal: controller.signal, registryFactory, stress: count > 1 ? { workers: { count, configuration, argsFor: () => [], timeoutMs: Math.max(1, configuration.deadlineAt - Date.now()), spawnWorker: brokerWorker } } : {} });
        await channel.send({ kind: 'result', runId: outerRunId, output });
      } catch { await Promise.resolve(channel.send({ kind: 'failure', runId: outerRunId })).catch(() => {}); }
      finally { clearTimeout(deadline); }
    })();
  });
  await channel.send({ kind: 'ready', runId: outerRunId });
} else throw new Error('Private stress role unavailable');

process.once('disconnect', () => { controller.abort(); clearTimeout(deadline); void (async () => { try { await peer?.close(); await registry?.close(); } finally { process.exit(0); } })(); });
