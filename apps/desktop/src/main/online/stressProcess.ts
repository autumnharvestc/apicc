import { fileURLToPath } from 'node:url';
import { spawnLocalStressWorker, type NativeStressWorkerChannel, type InvocationOutput, type PrepareExecutionInput } from '@apicc/execution/host';
import type { ProjectAssets,StressProcessObservation } from '@apicc/execution/contract';
import type { PreparedTestData, PluginRuntimeSnapshotV1, CredentialScope } from '@apicc/core';
import { InvocationOutputSchema, type OnlineExecutionContext, type OnlineExecutionInput } from '../../shared/online/execution.js';

/** Private parent-created wire only. Functions, server tokens and renderer filesystem paths never cross it. */
export interface DesktopStressConfiguration {
  protocolVersion: 1;
  identity: { context: OnlineExecutionContext; runId: string; snapshotId: string; manifestHash: string; coreBuildId: string; scriptApiId: string; runtimeCompatibilityId: string; scriptPlanDigest: string };
  assets: ProjectAssets;
  prepare: Omit<PrepareExecutionInput, 'snapshot' | 'debugSessionScope' | 'stressConfig' | 'expectedStressBinding'>;
  deadlineAt: number; cancelGraceMs: number; workspaceRoot: string;
  preparedTestData: PreparedTestData;
  credentials: { scope: CredentialScope; versions: Record<string, string>; values: Record<string, string> };
  network?: NonNullable<Extract<OnlineExecutionInput, { operation: 'run' }>['network']> & { scope: CredentialScope; identity: string; credentialVersions: Record<string, string>; values: Record<string, string> };
  pluginSnapshot?: PluginRuntimeSnapshotV1;
}
export type DesktopBrokerRequest = { kind: 'broker'; runId: string; id: number; identity: { runId: string; workerId: string }; operation: 'spawn' | 'send' | 'close' | 'wait'; value?: unknown };
const childEntry = () => fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../../dist-electron/main/online/stressChild.js' : './stressChild.js', import.meta.url));
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

/** Main owns every real ChildProcess through the existing native channel, including brokered leaves. */
export async function runDesktopStress(configuration: DesktopStressConfiguration, signal: AbortSignal,onObservation?:(value:StressProcessObservation)=>void): Promise<InvocationOutput> {
  signal.throwIfAborted();
  const runId = configuration.identity.runId, workerCount = configuration.prepare.stressRun!.workerCount;
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'LANG', 'TZ'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  env.ELECTRON_RUN_AS_NODE = '1';
  let started=0,exited=0,peak=0;const live=new Set<NativeStressWorkerChannel>();const processBudget=workerCount===1?1:workerCount+1;
  const publish=()=>onObservation?.({completeness:started===processBudget?'complete':'partial',started,exited,peak});
  const spawn = (role: string, args: string[] = []) => {
    const channel=spawnLocalStressWorker(['--max-old-space-size=256', childEntry(), role, runId, ...args], Math.max(1, configuration.deadlineAt - Date.now()), { env, windowsHide: true });
    let observed=false;channel.onSpawn(()=>{if(observed)return;observed=true;started++;live.add(channel);peak=Math.max(peak,live.size);publish();});
    channel.onExit(()=>{if(observed&&live.delete(channel)){exited++;publish();}});return channel;
  };
  const coordinator = spawn('coordinator');
  const leaves = new Map<string, NativeStressWorkerChannel>();
  const ready = deferred<void>(), result = deferred<InvocationOutput>();
  // Attach rejection observers before the child can emit an early close.
  void ready.promise.catch(() => {}); void result.promise.catch(() => {});
  let stopping = false, coreRunId = '', cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const reply = (id: number, ok: boolean, value?: unknown) => coordinator.send({ kind: 'broker-ack', runId, id, ok, ...(value === undefined ? {} : { value }) });
  const pending = new Set<Promise<void>>();
  async function broker(message: DesktopBrokerRequest) {
    const workerNumber = /^worker-([1-9]\d*)$/.exec(message.identity?.workerId)?.[1];
    if (message.runId !== runId || !Number.isSafeInteger(message.id) || !workerNumber || Number(workerNumber) > workerCount || workerCount <= 1 || typeof message.identity.runId !== 'string' || !/^[0-9a-f-]{36}$/.test(message.identity.runId)) throw new Error('local-stress-worker-identity-mismatch');
    if (!coreRunId) coreRunId = message.identity.runId;
    if (coreRunId !== message.identity.runId) throw new Error('local-stress-worker-identity-mismatch');
    const key = message.identity.workerId;
    if (message.operation === 'spawn') {
      if (stopping || leaves.has(key)) throw new Error('local-stress-worker-identity-mismatch');
      const channel = spawn('worker', [coreRunId, key]);
      // Ownership and exit supervision exist before any fixed material is sent.
      leaves.set(key, channel);
      channel.subscribe(value => { void Promise.resolve(coordinator.send({ kind: 'broker-frame', runId, workerId: key, value })).catch(() => {}); });
      channel.onClose(() => { void Promise.resolve(coordinator.send({ kind: 'broker-closed', runId, workerId: key })).catch(() => {}); });
      await reply(message.id, true); return;
    }
    const channel = leaves.get(key); if (!channel) throw new Error('local-stress-worker-identity-mismatch');
    if (message.operation === 'send') { await channel.send(message.value); await reply(message.id, true); }
    else if (message.operation === 'close') { await channel.close(); await reply(message.id, true); }
    else if (message.operation === 'wait') await reply(message.id, true, await channel.waitForExit!());
    else throw new Error('local-stress-worker-identity-mismatch');
  }
  const unsubscribe = coordinator.subscribe(raw => {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as { kind: string; runId: string; output?: unknown };
    if (message.runId !== runId) { result.reject(new Error('fixed-input-mismatch')); return; }
    if (message.kind === 'ready') ready.resolve();
    else if (message.kind === 'result') { const parsed = InvocationOutputSchema.safeParse(message.output); if (!parsed.success || !['stress', 'stress-failure'].includes(parsed.data.kind)) result.reject(new Error('invalid-core-output')); else result.resolve(parsed.data); }
    else if (message.kind === 'failure') result.reject(new Error('local-stress-preparation-failed'));
    else if (message.kind === 'broker') {
      const operation = broker(raw as DesktopBrokerRequest).catch(async () => { await Promise.resolve(reply((raw as DesktopBrokerRequest).id, false)).catch(() => {}); result.reject(new Error('local-stress-worker-failed')); });
      pending.add(operation); void operation.finally(() => pending.delete(operation));
    }
  });
  const onClose = coordinator.onClose(() => { ready.reject(new Error('local-stress-process-exited')); result.reject(new Error('local-stress-process-exited')); });
  const cancel = () => { stopping = true; void Promise.resolve(coordinator.send({ kind: 'cancel', runId })).catch(() => {}); cancelTimer ??= setTimeout(() => { result.reject(new Error('local-run-cancelled')); }, configuration.cancelGraceMs); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await ready.promise; signal.throwIfAborted();
    await coordinator.send({ kind: 'run', runId, configuration });
    return await result.promise;
  } finally {
    stopping = true; signal.removeEventListener('abort', cancel); clearTimeout(cancelTimer);
    // Closing owned native channels observes their actual close events, never just PID existence.
    await Promise.allSettled([...leaves.values()].map(channel => channel.close()));
    await coordinator.close();
    await Promise.allSettled([...pending]);
    unsubscribe(); onClose();
  }
}
