import { it, expect } from 'vitest';
import { createSynchronizationHost } from '../../../src/main/sync/ipc.js';
import { handleOnlineSynchronization } from '../../../src/main/online/synchronization.js';
import { createOnlineSession } from '../../../src/main/online/session.js';
import { createOnlineClient } from '../../../src/main/online/client.js';
import { createSession } from '../../../src/main/session.js';
import { createSynchronizationStore } from '../../../src/renderer/src/stores/synchronization.js';
import { candidateView, source, receipt, onlineScope, id } from '../../renderer/components/sync/fixtures.js';
import { SyncHistoryEntrySchema } from '@apicc/core/sync/shared';

type Refusal = { status: number; code: string } | 'transport-lost' | 'drop-after-commit';
function onlineCandidate(candidateId = id(6), digest = 'f'.repeat(64)) {
  const view = candidateView();
  return { ...view, candidate: { ...view.candidate, id: candidateId, candidateDigest: digest, stamp: { ...view.candidate.stamp, kind: 'online' as const, assetVersion: '0' } } };
}
function historyEntry(historyId = id(10)) {
  const candidate = onlineCandidate().candidate, committed = receipt(), digest = { definitionRevision: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) }, content = { digest: 'c'.repeat(64), bytes: 2, contentType: 'application/vnd.apicc.sync-files+json' };
  return SyncHistoryEntrySchema.parse({ formatVersion: 1, id: historyId, sourceId: source.id, projectId: candidate.stamp.projectId, intentId: committed.intentId, operationKind: 'apply', actor: committed.actor, createdAtMs: committed.completedAtMs, beforeStamp: candidate.stamp, afterStamp: candidate.stamp, upstream: candidate.upstream, before: digest, after: digest, rollback: { beforeContent: content, afterContent: content }, integritySha256: '4'.repeat(64) });
}
async function fixture(first: Refusal | null, refreshFails = false) {
  const requests: { method: string; path: string; body?: Record<string, unknown> }[] = [], operations = new Map<string, unknown>(), values = new Map<string, string>();
  const storage: Storage = { get length() { return values.size; }, clear() { values.clear(); }, getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null, removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
  let responseFence: (() => Promise<void>) | undefined, submissions = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    if (path.endsWith('/auth/login')) return Response.json({ token: 'owned-member', expiresAt: '2027-01-01T00:00:00Z', user: { id: '7', username: 'member', displayName: 'Member', role: 'USER', disabled: false } });
    requests.push({ path, method, body });
    if (path.endsWith('/applications') || path.endsWith('/rollbacks')) {
      submissions++;
      if (submissions === 1 && first === 'transport-lost') throw Error('owned-transport-lost');
      if (submissions === 1 && first && typeof first === 'object') return Response.json({ code: first.code, message: 'private server diagnostic' }, { status: first.status });
      const value = receipt(String(body!.intentId));
      const committed = { ...value, kind: path.endsWith('/rollbacks') ? 'rollback' : 'apply', afterStamp: { ...value.afterStamp, kind: 'online', assetVersion: '1' } };
      operations.set(String(body!.intentId), committed);
      if (submissions === 1 && first === 'drop-after-commit') throw Error('owned-response-lost-after-commit');
      await responseFence?.();
      return Response.json(committed);
    }
    if (path.includes('/operations/')) { const value = operations.get(path.split('/').at(-1)!); return value ? Response.json(value) : Response.json({ code: 'sync_operation_not_found' }, { status: 404 }); }
    if (path.endsWith('/history')) return Response.json([]);
    throw Error('Unexpected owned synchronization route: ' + method + ' ' + path);
  };
  const session = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: fetcher, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  await session.login({ baseUrl: 'https://control.test', username: 'member', password: 'owned-password' }); session.openWorkspace({ workspaceId: '11', name: 'Owned workspace', myRole: 'EDITOR' });
  const sender = {}, host = createSynchronizationHost({ session: createSession(), local: async () => { throw Error('Unexpected local fallback'); }, online: input => handleOnlineSynchronization({ session, fetch: fetcher }, input) });
  const store = createSynchronizationStore({ synchronization: input => host.handle(input, sender) }, async () => { if (refreshFails) throw Error('owned-refresh-unavailable'); }, storage);
  store.activate(onlineScope); store.sources = [source]; store.selectSource(source.id); store.capabilities = ['sync.apply'];
  const select = (candidateId = id(6), digest = 'f'.repeat(64)) => { store.candidate = onlineCandidate(candidateId, digest); store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); };
  select();
  return { store, host, sender, requests, select, pending: () => JSON.parse(storage.getItem('apicc.sync.pending-intents.v1') ?? '[]') as { intentId: string }[], responseFence(value: () => Promise<void>) { responseFence = value; }, posts: () => requests.filter(request => request.method === 'POST') };
}

// Independent literals from the audited server/Core precommit contract; do not import the implementation list.
it.each([
  'source-revision-changed', 'project-assets-changed', 'mapping-revision-changed', 'baseline-revision-changed', 'authorization-changed', 'core-identity-changed', 'candidate-expired',
  'SYNC_CANDIDATE_MISMATCH', 'SYNC_DECISION_REQUIRED', 'SYNC_DECISION_DUPLICATE', 'SYNC_DECISION_UNKNOWN', 'SYNC_DIAGNOSTICS_BLOCKED',
  'SYNC_PROTECTED_REFERENCE', 'SYNC_PROTECTED_LOCAL_ASSET', 'SYNC_CROSS_SOURCE_OWNERSHIP', 'SYNC_MAPPING_DECISION_INVALID', 'SYNC_MAPPING_DECISION_REQUIRED', 'SYNC_MAPPING_KIND_MISMATCH',
  'SYNC_MAPPING_PARENT_MISMATCH', 'SYNC_MAPPING_PARENT_NOT_SELECTED', 'SYNC_MAPPING_TARGET_ACTIVE', 'SYNC_MAPPING_TARGET_AMBIGUOUS', 'SYNC_MAPPING_TARGET_DUPLICATE', 'SYNC_MAPPING_TARGET_UNAVAILABLE',
  'SYNC_ROLLBACK_CURRENT_CHANGED', 'SYNC_ROLLBACK_CONTENT_MISMATCH', 'SYNC_ROLLBACK_HISTORY_MISMATCH', 'SYNC_ROLLBACK_STAMP_MISMATCH', 'sync_policy_changed', 'sync_operation_expired',
])('A-P2-02 releases definite precommit %s and sends a new candidate with a new intent through the real main adapter', async code => {
  const f = await fixture({ status: 409, code });
  await f.store.apply(); const first = { error: f.store.error, intentId: f.store.intentId, pending: f.pending() };
  f.select(id(82), '5'.repeat(64)); await f.store.apply();
  expect(f.posts()).toHaveLength(2);
  expect(first).toEqual({ error: code, intentId: '', pending: [] });
  expect(f.posts().map(request => request.body!.candidateId)).toEqual([id(6), id(82)]);
  expect(f.posts()[1]!.body!.intentId).not.toBe(f.posts()[0]!.body!.intentId);
  expect(f.requests.some(request => request.path.includes('/operations/'))).toBe(false);
  expect(f.store.receipt?.status).toBe('committed');
});

it.each<Refusal>(['transport-lost', { status: 409, code: 'unreviewed-conflict' }, { status: 500, code: 'project-assets-changed' }, { status: 409, code: 'sync_receipt_integrity_mismatch' }])('A-P2-02 keeps the original unknown intent for %j even after a receipt 404 and a different candidate', async failure => {
  const f = await fixture(failure); await f.store.apply(); const intent = f.store.intentId;
  expect(intent).not.toBe(''); expect(f.store.error).toBe('SYNC_OPERATION_UNKNOWN');
  f.select(id(82), '5'.repeat(64)); await f.store.apply();
  expect(f.posts()).toHaveLength(1); expect(f.store.intentId).toBe(intent); expect(f.pending().map(entry => entry.intentId)).toEqual([intent]);
  expect(f.requests.filter(request => request.path.includes('/operations/')).map(request => request.path.split('/').at(-1))).toEqual([intent, intent]);
});

it('A-P2-02 reconciles a response lost after commit through the original intent without another POST', async () => {
  const f = await fixture('drop-after-commit'); await f.store.apply(); const intent = f.store.intentId;
  await f.store.apply(); expect(f.posts()).toHaveLength(1); expect(f.store.receipt?.intentId).toBe(intent); expect(f.store.receipt?.status).toBe('committed'); expect(f.pending()).toEqual([]);
  expect(f.requests.filter(request => request.path.includes('/operations/')).map(request => request.path.split('/').at(-1))).toEqual([intent]);
});

it('A-P2-02 preserves a committed identity across refresh failure and only queries its receipt', async () => {
  const f = await fixture(null, true); await f.store.apply(); const intent = f.store.intentId;
  await f.store.reconcile(); await f.store.apply();
  expect(f.store.receipt?.intentId).toBe(intent); expect(f.store.refreshError).toBe('owned-refresh-unavailable'); expect(f.posts()).toHaveLength(1); expect(f.pending()).toEqual([]);
  expect(f.requests.filter(request => request.path.includes('/operations/')).map(request => request.path.split('/').at(-1))).toEqual([intent]);
});

it('A-P2-02 retains the original identity when a main activation fence changes after server commit', async () => {
  const f = await fixture(null); f.responseFence(async () => { await f.host.handle({ scope: onlineScope, operation: 'deactivate' }, f.sender); });
  await f.store.apply(); const intent = f.store.intentId; expect(intent).not.toBe(''); expect(f.store.receipt).toBeNull(); expect(f.pending().map(entry => entry.intentId)).toEqual([intent]);
  await f.host.handle({ scope: onlineScope, operation: 'activate' }, f.sender); await f.store.reconcile(); await f.store.apply();
  expect(f.store.receipt?.intentId).toBe(intent); expect(f.posts()).toHaveLength(1);
});

it('A-P2-02 releases a definite rollback refusal and submits a new history with a new intent through the real adapter', async () => {
  const f = await fixture({ status: 409, code: 'SYNC_ROLLBACK_STAMP_MISMATCH' });
  await f.store.rollback(historyEntry()); expect(f.store.error).toBe('SYNC_ROLLBACK_STAMP_MISMATCH'); expect(f.store.intentId).toBe(''); expect(f.pending()).toEqual([]);
  await f.store.rollback(historyEntry(id(11)));
  expect(f.posts()).toHaveLength(2); expect(f.posts().every(request => request.path.endsWith('/rollbacks'))).toBe(true);
  expect(f.posts().map(request => request.body!.historyId)).toEqual([id(10), id(11)]); expect(f.posts()[1]!.body!.intentId).not.toBe(f.posts()[0]!.body!.intentId); expect(f.store.receipt?.kind).toBe('rollback');
});
it('A-P2-02 keeps an unknown rollback intent after a missing receipt instead of posting a different history', async () => {
  const f = await fixture({ status: 409, code: 'unreviewed-conflict' }); await f.store.rollback(historyEntry()); const intent = f.store.intentId;
  await f.store.rollback(historyEntry(id(11)));
  expect(f.posts()).toHaveLength(1); expect(f.posts()[0]!.path.endsWith('/rollbacks')).toBe(true); expect(f.pending().map(entry => entry.intentId)).toEqual([intent]);
  expect(f.requests.filter(request => request.path.includes('/operations/')).map(request => request.path.split('/').at(-1))).toEqual([intent, intent]);
});
it('A-P2-02 preserves a committed rollback identity across lost response and refresh failure without another POST', async () => {
  const f = await fixture('drop-after-commit', true), history = historyEntry(); await f.store.rollback(history); const intent = f.store.intentId;
  await f.store.reconcile(); await f.store.rollback(history);
  expect(f.store.receipt?.intentId).toBe(intent); expect(f.store.receipt?.kind).toBe('rollback'); expect(f.store.refreshError).toBe('owned-refresh-unavailable'); expect(f.posts()).toHaveLength(1); expect(f.pending()).toEqual([]);
  expect(f.requests.filter(request => request.path.includes('/operations/')).map(request => request.path.split('/').at(-1))).toEqual([intent, intent]);
});
