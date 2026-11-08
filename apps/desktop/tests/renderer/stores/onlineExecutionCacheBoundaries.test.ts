import { afterEach, expect, it, vi } from 'vitest';
import { ApiRequestSchema, DebugInvocationSchema } from '@apicc/core/schema';
import { createOnlineExecutionStore } from '../../../src/renderer/src/stores/onlineExecution.js';
import { DEFAULT_ONLINE_EXECUTION_CACHE_PREFERENCES as defaults, ONLINE_EXECUTION_CACHE_SETTINGS_KEY } from '../../../src/renderer/src/stores/onlineExecutionCachePreferences.js';
import type { FullOnlineJob, OnlineExecutionContext, OnlineExecutionInput, OnlineJob, OnlineLocalResult } from '../../../src/shared/online/execution.js';

const workflowId = '00000000-0000-4000-8000-000000000091';
const context = (id: number): OnlineExecutionContext => ({ serverId: 'https://cache.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: String(id) } });
type Store = ReturnType<typeof createOnlineExecutionStore>;
const stores: Store[] = [];
function store(api: { onlineExecution(input: OnlineExecutionInput): Promise<unknown> }, preferences = defaults, now?: () => number) {
  const value = createOnlineExecutionStore(api, { preferences, storage: null, ...(now ? { now } : {}) }); stores.push(value); return value;
}
function activate(value: Store, id: number) {
  value.activate(context(id)); value.setVisible(true);
  value.view = { project: null, problems: [], assets: { ...context(id).scope, format: 'contract-files-v1', contractProjectId: '00000000-0000-4000-8000-000000000018', version: '1', manifestHash: 'a'.repeat(64), files: [] } };
}
function result(runId: string, warning?: string, debugSessionId?: string): OnlineLocalResult {
  return { location: { kind: 'local' }, runId, snapshotId: '66', manifestHash: 'a'.repeat(64), runtimeCompatibilityId: 'recorded-local-runtime', scriptTimeoutMs: 3000, ...(debugSessionId ? { debugSessionId } : {}),
    output: { kind: 'failure', targetKind: debugSessionId ? 'debug' : 'workflow', error: 'Synthetic preparation failure', result: { collectionId: '', collectionName: 'synthetic', startedAt: '2026-11-08T00:00:00.000Z', finishedAt: '2026-11-08T00:00:00.001Z', total: 0, passed: 0, failed: 1, cases: [], ...(warning ? { warnings: [warning] } : {}) } } };
}
function job(): FullOnlineJob {
  return { jobId: '101', executionId: '201', agentId: '5', state: 'ended', cancelState: 'none', executionReleased: true, reportState: 'archived', task: { protocolVersion: 1, jobId: '101', executionId: '201', scope: context(1).scope, submittedByUserId: '7', contractProjectId: '00000000-0000-4000-8000-000000000018', snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'workflow', workflowId }, policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'recorded-agent-runtime', dispatchKind: 'dedicated-task', requiredCapabilities: ['task:workflow'] } };
}
function invocation() {
  const request = ApiRequestSchema.parse({ protocol: 'http', method: 'GET', baseUrl: 'https://synthetic.test', path: '/debug', pathParams: [], cookies: [], headers: [], query: [], auth: { kind: 'none' }, body: { kind: 'none' } });
  return DebugInvocationSchema.parse({ mode: 'request', locator: { workspaceId: 'ws', groupId: 'group', projectId: 'project', collectionId: 'collection', folderIds: [], apiId: 'api' }, request, parameters: {}, fields: [] });
}
afterEach(() => { for (const value of stores.splice(0)) value.setVisible(false); vi.useRealTimers(); });

it.each([-1, 0])('G04 idle deadline offset %s preserves only a not-yet-expired selection', offset => {
  let clock = 0; const value = store({ onlineExecution: async () => { throw new Error('Unexpected RPC'); } }, defaults, () => clock);
  activate(value, 1); value.selectLocation({ kind: 'agent', agentId: '5' }); value.environmentId = '00000000-0000-4000-8000-000000000019';
  activate(value, 2); clock = 30 * 60_000 + offset; activate(value, 1);
  expect(value.location).toEqual(offset < 0 ? { kind: 'agent', agentId: '5' } : { kind: 'local' });
  expect(value.environmentId).toBe(offset < 0 ? '00000000-0000-4000-8000-000000000019' : undefined);
});
it('G04 active time does not consume the next inactive retention interval', () => {
  let clock = 0; const value = store({ onlineExecution: async () => [] }, defaults, () => clock);
  activate(value, 1); value.selectLocation({ kind: 'agent', agentId: '5' }); clock = 24 * 60 * 60_000;
  activate(value, 2); clock += 30 * 60_000 - 1; activate(value, 1); expect(value.location).toEqual({ kind: 'agent', agentId: '5' });
});
it('G04 equal-length ASCII and multibyte payloads have an independently known UTF-8 byte difference', async () => {
  const measure = async (warning: string) => {
    const value = store({ onlineExecution: async input => { if (input.operation !== 'run') throw new Error('Unexpected RPC'); return result(input.runId, warning); } });
    activate(value, 1); await value.run({ kind: 'workflow', workflowId }); activate(value, 2);
    return value.cacheUsage.inactivePayloadBytes;
  };
  // All metadata has the same serialized length, including the fixed-length UUIDs.
  // 1000 occurrences of U+754C encode as 3000 bytes versus 1000 ASCII bytes.
  // A character-count implementation therefore yields 0 here and must fail.
  expect(await measure('界'.repeat(1000)) - await measure('x'.repeat(1000))).toBe(2000);
});
it.each([0, 1])('G04 UTF-8 serialized payload at budget plus %s bytes uses an inclusive boundary', async extra => {
  const budget = 1024 * 1024, prefix = '界'.repeat(1000);
  const run = async (warning: string, limit: number) => {
    const value = store({ onlineExecution: async input => { if (input.operation !== 'run') throw new Error('Unexpected RPC'); return result(input.runId, warning); } }, { ...defaults, maxInactivePayloadMiB: limit });
    activate(value, 1); await value.run({ kind: 'workflow', workflowId }); activate(value, 2); return value;
  };
  const calibration = await run(prefix, 2); const baseBytes = calibration.cacheUsage.inactivePayloadBytes;
  expect(baseBytes).toBeGreaterThan(prefix.length); expect(baseBytes).toBeLessThan(budget);
  const value = await run(prefix + 'x'.repeat(budget - baseBytes + extra), 1);
  expect(value.cacheUsage.inactivePayloadBytes).toBe(extra ? 0 : budget);
  activate(value, 1); expect(value.localResult !== null).toBe(extra === 0);
});
it('G04 accumulated small payloads evict the oldest result and preserve the newer result', async () => {
  const value = store({ onlineExecution: async input => { if (input.operation !== 'run') throw new Error('Unexpected RPC'); return result(input.runId, 'x'.repeat(600_000)); } }, { ...defaults, maxInactivePayloadMiB: 1 });
  activate(value, 1); await value.run({ kind: 'workflow', workflowId });
  activate(value, 2); await value.run({ kind: 'workflow', workflowId }); const newer = value.localResult!.runId;
  activate(value, 3); expect(value.cacheUsage.inactivePayloadBytes).toBeLessThan(1024 * 1024);
  activate(value, 1); expect(value.localResult).toBeNull(); activate(value, 2); expect(value.localResult!.runId).toBe(newer);
});

const protectionCases: Array<[string, OnlineJob, boolean]> = [
  ['ended but unreleased', { ...job(), executionReleased: false }, true],
  ['released but pending archive', { ...job(), reportState: 'pending' }, true],
  ['released with no archive', { ...job(), reportState: 'none' }, true],
  ['running', { ...job(), state: 'running', executionReleased: false, reportState: 'none' }, true],
  ['minimum released status', { jobId: '101', executionId: '201', agentId: '5', state: 'ended', cancelState: 'none', executionReleased: true, canCancel: false, view: 'active-status', scope: context(1).scope }, true],
  ['complete archive', job(), false], ['expired archive', { ...job(), reportState: 'expired' }, false],
];
it.each(protectionCases)('G05 zero-cache protection: %s', async (_name, response, protectedRecord) => {
  const value = store({ onlineExecution: async () => response }, { ...defaults, maxInactiveContexts: 0 });
  activate(value, 1); value.selectLocation({ kind: 'agent', agentId: '5' }); await value.run({ kind: 'workflow', workflowId });
  activate(value, 2); expect(value.cacheUsage.protectedContexts).toBe(protectedRecord ? 1 : 0);
  activate(value, 1); expect(value.location).toEqual(protectedRecord ? { kind: 'agent', agentId: '5' } : { kind: 'local' });
  expect(value.resultSelection !== null).toBe(protectedRecord);
});
it('G05 hiding stops retained-job polling and showing resumes only the current context', async () => {
  vi.useFakeTimers(); const calls: OnlineExecutionInput[] = [];
  const active = { ...job(), state: 'running' as const, executionReleased: false, reportState: 'none' as const };
  const value = store({ onlineExecution: async input => { calls.push(input); return input.operation === 'run' ? active : job(); } });
  activate(value, 1); value.selectLocation({ kind: 'agent', agentId: '5' }); await value.run({ kind: 'workflow', workflowId });
  value.setVisible(false); await vi.advanceTimersByTimeAsync(10_000); expect(calls.filter(call => call.operation === 'status')).toHaveLength(0);
  value.setVisible(true); await vi.advanceTimersByTimeAsync(value.statusRefreshMs); expect(calls.filter(call => call.operation === 'status')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10_000); expect(calls.filter(call => call.operation === 'status')).toHaveLength(1);
});
it('G05 a late retained status cannot overwrite another context or release the old protection by inference', async () => {
  let resolve!: (value: unknown) => void; const status = new Promise<unknown>(done => { resolve = done; });
  const value = store({ onlineExecution: async input => input.operation === 'run' ? { ...job(), state: 'running', executionReleased: false, reportState: 'none' } : status }, { ...defaults, maxInactiveContexts: 0 });
  activate(value, 1); value.selectLocation({ kind: 'agent', agentId: '5' }); await value.run({ kind: 'workflow', workflowId });
  const refreshing = value.refreshActive(); activate(value, 2); resolve(job()); await refreshing;
  expect(value.context).toEqual(context(2)); expect(value.jobs).toEqual([]); expect(value.localResult).toBeNull(); expect(value.error).toBe('');
  expect(value.cacheUsage.protectedContexts).toBe(1); activate(value, 1); expect(value.selectedJobId).toBe('101');
});

it('G06 retained debug sessions are reused without resetting another context', async () => {
  const calls: Array<Extract<OnlineExecutionInput, { operation: 'run' }>> = [];
  const value = store({ onlineExecution: async input => { if (input.operation !== 'run') throw new Error('Unexpected RPC'); calls.push(input); return result(input.runId, undefined, `session-${input.context.scope.projectId}`); } });
  activate(value, 1); await value.run({ kind: 'debug', invocation: invocation() });
  activate(value, 2); await value.run({ kind: 'debug', invocation: invocation() });
  activate(value, 1); await value.run({ kind: 'debug', invocation: invocation() });
  activate(value, 2); await value.run({ kind: 'debug', invocation: invocation() });
  expect(calls.map(call => call.debugSessionId)).toEqual([undefined, undefined, 'session-1', 'session-2']);
});
it('G06 safe eviction removes debug sessions, selections and results while the surviving context still resumes', async () => {
  const calls: Array<Extract<OnlineExecutionInput, { operation: 'run' }>> = [];
  const value = store({ onlineExecution: async input => { if (input.operation !== 'run') throw new Error('Unexpected RPC'); calls.push(input); return result(input.runId, undefined, `session-${input.context.scope.projectId}`); } }, { ...defaults, maxInactiveContexts: 1 });
  activate(value, 1); value.environmentId = '00000000-0000-4000-8000-000000000019'; await value.run({ kind: 'debug', invocation: invocation() });
  activate(value, 2); await value.run({ kind: 'debug', invocation: invocation() }); activate(value, 3);
  activate(value, 2); await value.run({ kind: 'debug', invocation: invocation() }); expect(calls.at(-1)!.debugSessionId).toBe('session-2');
  activate(value, 1); expect(value.localResult).toBeNull(); expect(value.location).toEqual({ kind: 'local' }); expect(value.environmentId).toBeUndefined();
  await value.run({ kind: 'debug', invocation: invocation() }); expect(calls.at(-1)!.debugSessionId).toBeUndefined();
});
it('G06 an uncertain context keeps its earlier debug session even with zero inactive retention', async () => {
  const ids: Array<string | undefined> = [];
  const value = store({ onlineExecution: async input => { if (input.operation !== 'run') throw new Error('Unexpected RPC'); ids.push(input.debugSessionId); if (ids.length === 2) throw new Error('Synthetic lost response'); return result(input.runId, undefined, 'protected-session'); } }, { ...defaults, maxInactiveContexts: 0 });
  activate(value, 1); await value.run({ kind: 'debug', invocation: invocation() }); await expect(value.run({ kind: 'debug', invocation: invocation() })).rejects.toThrow('Synthetic lost response');
  activate(value, 2); expect(value.cacheUsage.protectedContexts).toBe(1); activate(value, 1); await value.run({ kind: 'debug', invocation: invocation() });
  expect(ids).toEqual([undefined, 'protected-session', 'protected-session']);
});

const boundaries = [ ['maxInactiveContexts', 0, 200], ['inactiveTtlMinutes', 1, 1440], ['maxInactivePayloadMiB', 1, 512] ] as const;
for (const [key, min, max] of boundaries) {
  it.each([min, max])(`G07 ${key} accepts boundary %s and persists only local preferences`, number => {
    const entries = new Map<string, string>(); const storage = { getItem: (id: string) => entries.get(id) ?? null, setItem: (id: string, value: string) => { entries.set(id, value); } };
    const value = createOnlineExecutionStore({ onlineExecution: async () => { throw new Error('Unexpected RPC'); } }, { storage }); stores.push(value);
    const preferences = { ...defaults, [key]: number }; value.setCachePreferences(preferences);
    expect(value.cachePreferences).toEqual(preferences); expect([...entries.keys()]).toEqual([ONLINE_EXECUTION_CACHE_SETTINGS_KEY]); expect(JSON.parse(entries.get(ONLINE_EXECUTION_CACHE_SETTINGS_KEY)!)).toEqual(preferences);
  });
  it.each([min - 1, max + 1, min + 0.5])(`G07 ${key} rejects %s before persistence or policy change`, number => {
    const write = vi.fn(); const value = createOnlineExecutionStore({ onlineExecution: async () => [] }, { storage: { getItem: () => null, setItem: write } }); stores.push(value);
    expect(() => value.setCachePreferences({ ...defaults, [key]: number })).toThrow('online-cache-settings-invalid'); expect(write).not.toHaveBeenCalled(); expect(value.cachePreferences).toEqual(defaults);
  });
}
it('G07 a real storage read failure falls back to defaults with an unavailable diagnostic', () => {
  const value = createOnlineExecutionStore({ onlineExecution: async () => [] }, { storage: { getItem: () => { throw new Error('Synthetic unavailable read'); }, setItem: vi.fn() } }); stores.push(value);
  expect(value.cachePreferences).toEqual(defaults); expect(value.cachePreferenceDiagnostic).toBe('online-cache-settings-unavailable');
});
it('G07 a throwing localStorage getter is contained and its original descriptor is restored', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Synthetic SecurityError'); } });
    const value = createOnlineExecutionStore({ onlineExecution: async () => [] }); stores.push(value);
    expect(value.cachePreferences).toEqual(defaults); expect(value.cachePreferenceDiagnostic).toBe('online-cache-settings-unavailable');
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
it.each([[], {}, { ...defaults, maxInactiveContexts: '20' }, { ...defaults, extra: true }])('G07 valid JSON with an invalid schema falls back without rewriting it: %j', data => {
  const write = vi.fn(); const value = createOnlineExecutionStore({ onlineExecution: async () => [] }, { storage: { getItem: () => JSON.stringify(data), setItem: write } }); stores.push(value);
  expect(value.cachePreferences).toEqual(defaults); expect(value.cachePreferenceDiagnostic).toBe('online-cache-settings-corrupt'); expect(write).not.toHaveBeenCalled();
});
