import { describe, it, expect, vi } from 'vitest';
import { defaultSyncPolicyValues } from '@apicc/core/sync';
import { createSynchronizationHost } from '../../../src/main/sync/ipc.js';
import { id, withLocalSync, deferred } from './fixtures.js';
import { createDesktopCredentialHost } from '../../../src/main/credentials.js';
import { createDesktopSyncProviders } from '../../../src/main/sync/providers.js';
import { readBuildIdentity } from '@apicc/execution/buildIdentity';
import { openLocalSync } from '../../../src/main/sync/local.js';
import { createIpcDeps } from '../../../src/main/ipc.js';
import { IpcChannel } from '../../../src/shared/channels.js';

describe('fix1 A real composition and awaited provider boundaries', () => {
  it('I1 dispatches a legal project through actual createIpcDeps and isolates trusted senders', async () => {
    await withLocalSync(async f => {
      let gate = deferred(), asked = deferred();
      const deps = createIpcDeps({ session: f.session, pickDirectory: async () => '', saveFile: async () => '', credentials: { secretStore: f.secrets.store, credentialPrivateRoot: f.privateRoot + '/credentials', networkPrivateRoot: f.privateRoot + '/network', oauthPrivateRoot: f.privateRoot + '/oauth' }, synchronization: { privateRoot: f.privateRoot + '/sync', pickTool: async () => null, confirmDestination: async () => { asked.resolve(); await gate.promise; return true; } } });
      const scope = { kind: 'local' as const, root: f.root, locator: { workspaceId: id(825), ...f.location } }, a = { sender: {} }, b = { sender: {} };
      try {
        await expect(deps.handle(IpcChannel.Synchronization, a, { scope, operation: 'activate' })).resolves.toBeNull();
        expect(await deps.handle(IpcChannel.Synchronization, a, { scope, operation: 'sources' })).toEqual([f.source]);
        await deps.handle(IpcChannel.Synchronization, b, { scope, operation: 'activate' });
        const input = { scope, operation: 'check' as const, sourceId: f.source.id, expectedSourceRevision: '1', expectedAssetVersion: '0', intentId: f.newIntent() };
        const first = deps.handle(IpcChannel.Synchronization, a, input); await asked.promise;
        await deps.handle(IpcChannel.Synchronization, b, { scope, operation: 'deactivate' }); gate.resolve(); expect(await first).toMatchObject({ applicable: true });
        gate = deferred(); asked = deferred();
        const second = deps.handle(IpcChannel.Synchronization, a, { ...input, intentId: f.newIntent() }); await asked.promise;
        await deps.handle(IpcChannel.Synchronization, a, { scope, operation: 'deactivate' }); await deps.handle(IpcChannel.Synchronization, a, { scope, operation: 'activate' }); gate.resolve();
        await expect(second).rejects.toThrow(/SYNC_CANCELLED|SYNC_CONTEXT_CHANGED/);
      } finally { gate.resolve(); await deps.stopSynchronization(); }
    });
  });
  it.each(['cancel', 'project'])('I2 stops after a real pending SSH material version boundary on %s', async kind => {
    await withLocalSync(async f => {
      const gate = deferred(), entered = deferred(), abort = new AbortController(); let resolved = 0, prompts = 0;
      const credentials = createDesktopCredentialHost(f.session, { networkPrivateRoot: f.privateRoot + '/network', secretStore: { put: async () => {}, remove: async () => {}, status: async () => 'available', version: async () => { entered.resolve(); await gate.promise; return '1'; }, resolve: async () => { resolved++; return 'owned synthetic secret'; } } });
      const providers = createDesktopSyncProviders({ session: f.session, credentials, privateRoot: f.privateRoot + '/sync', confirmDestination: async () => { prompts++; return true; }, pickTool: async () => null });
      const deps = await providers.dependencies({ workspaceId: id(825), ...f.location });
      const source = { formatVersion: 1 as const, id: f.source.id, revision: '1', moduleId: f.source.moduleId, kind: 'git-ssh' as const, repositoryUrl: 'ssh://git@127.0.0.1/owned.git', ref: 'main', filePath: 'openapi.yaml', privateKeyRef: 'owned-key', knownHostsRef: 'owned-hosts', schedule: f.source.schedule };
      const pending = deps.acquireMaterial(source, abort.signal); await entered.promise;
      if (kind === 'cancel') abort.abort(); else await f.session.open(f.otherRoot); gate.resolve();
      await expect(pending).rejects.toThrow(kind === 'cancel' ? 'SYNC_CANCELLED' : 'SYNC_CONTEXT_CHANGED');
      expect(resolved).toBe(0); expect(prompts).toBe(0);
    });
  });
  it('I2 does not prepare old network material after a pending authorize version crosses context', async () => {
    await withLocalSync(async f => {
      await f.mutateState(state => { state.sources[0]!.source = { ...f.source, authRef: 'owned-auth' }; });
      const gate = deferred(), entered = deferred(); let prepared = 0;
      const credentials = createDesktopCredentialHost(f.session, { networkPrivateRoot: f.privateRoot + '/network', secretStore: { put: async () => {}, remove: async () => {}, status: async () => 'available', version: async () => { entered.resolve(); await gate.promise; return '1'; }, resolve: async () => 'owned' } });
      const original = credentials.sourceAccess; credentials.sourceAccess = async locator => { const access = await original(locator); const prepare = access.host.prepare; return { ...access, host: { ...access.host, prepare: async options => { prepared++; return prepare(options); } } }; };
      const deps = await createDesktopSyncProviders({ session: f.session, credentials, privateRoot: f.privateRoot + '/sync', confirmDestination: async () => true, pickTool: async () => null }).dependencies({ workspaceId: id(825), ...f.location });
      const pending = deps.authorize(f.location.projectId); await entered.promise; await f.session.open(f.otherRoot); gate.resolve();
      await expect(pending).rejects.toThrow('SYNC_CONTEXT_CHANGED'); expect(prepared).toBe(0);
    });
  });
});

describe('fix1 C local protected fixed asset details', () => {
  const prefix = 'Shared review prefix '.repeat(20);
  it('returns all three complete protected sides while the summary is truncated', async () => {
    await withLocalSync(async f => {
      const change = f.preparedCandidate.changes.find(c => c.fieldPath === '/metadata/description')!; expect(change.summaries.current).toMatchObject({ truncated: true });
      for (const side of ['baseline','current','source'] as const) expect(await f.client.detail(f.location, { formatVersion: 1, candidateId: f.preparedCandidate.id, candidateDigest: f.preparedCandidate.candidateDigest, changeId: change.changeId, side })).toMatchObject({ kind: 'document', text: expect.stringContaining(side === 'baseline' ? 'BASELINE-TAIL' : side === 'current' ? 'FIXED-LOCAL-TAIL' : 'SOURCE-TAIL') });
    }, { baseline: prefix + 'BASELINE-TAIL', local: prefix + 'FIXED-LOCAL-TAIL', source: prefix + 'SOURCE-TAIL' });
  });
  it('keeps the fixed local side after the actual current API changes and the candidate expires', async () => {
    await withLocalSync(async f => {
      const project = f.readProject(), asset = structuredClone(project.collections[0]!.apis[0]!); asset.contract.metadata.description = prefix + 'LIVE-LOCAL-LATER';
      await f.session.saveApi({ workspaceId: id(825), ...f.location, collectionId: f.source.moduleId, folderIds: [], apiId: asset.contract.id }, asset); f.expire();
      const change = f.preparedCandidate.changes.find(c => c.fieldPath === '/metadata/description')!;
      const result = await f.client.detail(f.location, { formatVersion: 1, candidateId: f.preparedCandidate.id, candidateDigest: f.preparedCandidate.candidateDigest, changeId: change.changeId, side: 'current' });
      expect(result).toMatchObject({ kind: 'document', text: expect.stringContaining('FIXED-LOCAL-TAIL') }); expect(result).not.toMatchObject({ text: expect.stringContaining('LIVE-LOCAL-LATER') });
    }, { baseline: prefix + 'BASELINE-TAIL', local: prefix + 'FIXED-LOCAL-TAIL', source: prefix + 'SOURCE-TAIL' });
  });
  it('enforces the actual effective output budget at the local detail entry', async () => {
    const long = 'large input '.repeat(26000);
    await withLocalSync(async f => {
      f.deps.policy = { ...defaultSyncPolicyValues, maxCompareOutputBytes: 262144 }; await f.reopen();
      const change = f.preparedCandidate.changes.find(c => c.fieldPath === '/metadata/description')!;
      await expect(f.client.detail(f.location, { formatVersion: 1, candidateId: f.preparedCandidate.id, candidateDigest: f.preparedCandidate.candidateDigest, changeId: change.changeId, side: 'source' })).rejects.toThrow('SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED');
    }, { baseline: long + 'B', local: long + 'L', source: long + 'R' });
  });
});

describe('synchronization main trusted invocation', () => {
  it('keeps an actual committed write uncertain when the final main context fence changes', async () => {
    await withLocalSync(async f => {
      const host = createSynchronizationHost({ session: f.session, local: async root => { const client = await openLocalSync(root, f.deps); return { ...client, async apply(...args) { const receipt = await client.apply(...args); await f.session.open(f.otherRoot); return receipt; } }; } });
      const scope = { kind: 'local' as const, root: f.root, locator: { workspaceId: id(825), ...f.location } }, intentId = f.newIntent();
      await expect(host.handle({ scope, operation: 'apply', sourceId: f.source.id, candidateId: f.preparedCandidate.id, candidateDigest: f.preparedCandidate.candidateDigest, decisions: f.decisions(), expectedSourceRevision: '1', expectedAssetVersion: '0', intentId })).rejects.toThrow(/^SYNC_CONTEXT_CHANGED$/);
      expect((await f.state()).operations[0]?.receipt.intentId).toBe(intentId);
      await f.session.open(f.root);
      expect(await host.handle({ scope, operation: 'operation', intentId })).toMatchObject({ intentId, status: 'committed' });
    });
  });
  it('saves legal host settings through the real IPC envelope and fences an older candidate', async () => {
    await withLocalSync(async f => {
      const credentials = createDesktopCredentialHost(f.session, { secretStore: f.secrets.store, credentialPrivateRoot: f.privateRoot + '/credentials', networkPrivateRoot: f.privateRoot + '/network', oauthPrivateRoot: f.privateRoot + '/oauth' });
      const providers = createDesktopSyncProviders({ session: f.session, credentials, privateRoot: f.privateRoot + '/sync', confirmDestination: async () => true, pickTool: async () => null });
      const locator = { workspaceId: id(825), ...f.location }, scope = { kind: 'local' as const, root: f.root, locator };
      const host = createSynchronizationHost({ session: f.session, providers, local: (_root, value) => providers.open(value) });
      const checked = await host.handle({ scope, operation: 'check', sourceId: f.source.id, expectedSourceRevision: '1', expectedAssetVersion: '0', intentId: f.newIntent() }) as import('@apicc/core/sync').SyncCandidateView;
      expect(checked.applicable).toBe(true);
      const settings = await host.handle({ scope, operation: 'saveSettings', maxRedirects: 3, policy: { ...defaultSyncPolicyValues, historyMaxEntries: 2 } });
      expect(settings).toMatchObject({ revision: '1', maxRedirects: 3, policy: { historyMaxEntries: 2 } });
      expect(await host.handle({ scope, operation: 'candidate', candidateId: checked.candidate.id })).toMatchObject({ applicable: false, reasonCode: 'authorization-changed' });
    });
  });
  it('marks an actual pre-commit stale refusal as definitive for the renderer', async () => {
    await withLocalSync(async f => {
      await f.mutateState(state => { state.sources[0]!.source.revision = '2'; });
      const host = createSynchronizationHost({ session: f.session, local: async () => f.client }), scope = { kind: 'local' as const, root: f.root, locator: { workspaceId: id(825), ...f.location } };
      await expect(host.handle({ scope, operation: 'apply', sourceId: f.source.id, candidateId: f.preparedCandidate.id, candidateDigest: f.preparedCandidate.candidateDigest, decisions: f.decisions(), expectedSourceRevision: '1', expectedAssetVersion: '0', intentId: f.newIntent() })).rejects.toThrow('SYNC_REJECTED:SYNC_CANDIDATE_STALE');
      expect((await f.state()).operations).toEqual([]);
    });
  });
  it('holds the same-source owner until the actual read settles when project concurrency exceeds one', async () => {
    await withLocalSync(async f => {
      f.deps.policy = { ...defaultSyncPolicyValues, projectConcurrency: 2 }; await f.reopen();
      const host = createSynchronizationHost({ session: f.session, local: async () => f.client });
      const scope = { kind: 'local' as const, root: f.root, locator: { workspaceId: id(825), ...f.location } }, gate = f.blockRelease();
      const input = { scope, operation: 'check' as const, sourceId: f.source.id, expectedSourceRevision: '1', expectedAssetVersion: '0', intentId: f.newIntent() };
      const first = host.handle(input); await gate.started; expect(f.requests).toHaveLength(1);
      let secondSettled = false;
      const second = host.handle({ ...input, intentId: f.newIntent() }).then(value => ({ value }), error => ({ error })).finally(() => { secondSettled = true; });
      try { await vi.waitFor(() => expect(secondSettled || f.requests.length === 2).toBe(true)); }
      finally { gate.unblock(); }
      await first; const result = await second;
      expect(result).toHaveProperty('error.message', 'SYNC_SOURCE_BUSY'); expect(f.requests).toHaveLength(1);
    });
  });
  it.each(['cancel', 'project'])('rejects a late native approval after %s without source traffic', async kind => {
    await withLocalSync(async f => {
      const gate = deferred(), asked = deferred(), abort = new AbortController();
      const credentials = createDesktopCredentialHost(f.session, { secretStore: f.secrets.store, credentialPrivateRoot: f.privateRoot + '/credentials', networkPrivateRoot: f.privateRoot + '/network', oauthPrivateRoot: f.privateRoot + '/oauth' });
      const provider = createDesktopSyncProviders({ session: f.session, credentials, privateRoot: f.privateRoot + '/sync', confirmDestination: async () => { asked.resolve(); await gate.promise; return true; }, pickTool: async () => null });
      const deps = await provider.dependencies({ workspaceId: id(825), ...f.location });
      const pending = deps.acquireMaterial(f.source, abort.signal);
      await asked.promise;
      if (kind === 'cancel') abort.abort(); else await f.session.open(f.otherRoot);
      gate.resolve();
      await expect(pending).rejects.toThrow(kind === 'cancel' ? 'SYNC_CANCELLED' : 'SYNC_CONTEXT_CHANGED'); expect(f.requests).toEqual([]);
    });
  });
  it('uses the actual built host identity and denies unapproved destinations before source traffic', async () => {
    await withLocalSync(async f => {
      const credentials = createDesktopCredentialHost(f.session, { secretStore: f.secrets.store, credentialPrivateRoot: f.privateRoot + '/credentials', networkPrivateRoot: f.privateRoot + '/network', oauthPrivateRoot: f.privateRoot + '/oauth' });
      let asked = 0;
      const provider = createDesktopSyncProviders({ session: f.session, credentials, privateRoot: f.privateRoot + '/sync', confirmDestination: async () => { asked++; return false; }, pickTool: async () => null });
      const deps = await provider.dependencies({ workspaceId: id(825), ...f.location });
      expect(typeof (await readBuildIdentity()).coreBuildId).toBe('string');
      await expect(deps.acquireMaterial(f.source, new AbortController().signal)).rejects.toThrow('SYNC_DESTINATION_REJECTED');
      expect(asked).toBe(1); expect(f.requests).toEqual([]);
    });
  });
  it('binds the actual built host identity', async () => {
    await withLocalSync(async f => {
      const credentials = createDesktopCredentialHost(f.session, { secretStore: f.secrets.store, credentialPrivateRoot: f.privateRoot + '/credentials', networkPrivateRoot: f.privateRoot + '/network', oauthPrivateRoot: f.privateRoot + '/oauth' });
      const provider = createDesktopSyncProviders({ session: f.session, credentials, privateRoot: f.privateRoot + '/sync', confirmDestination: async () => true, pickTool: async () => null });
      expect(await (await provider.dependencies({ workspaceId: id(825), ...f.location })).readCoreBuildId()).toBe((await readBuildIdentity()).coreBuildId);
    });
  });
  it('uses project SecretStore header material while keeping plaintext out of synchronization IPC', async () => {
    await withLocalSync(async f => {
      const credentialOptions = { secretStore: f.secrets.store, credentialPrivateRoot: f.privateRoot + '/credentials', networkPrivateRoot: f.privateRoot + '/network', oauthPrivateRoot: f.privateRoot + '/oauth' };
      const credentials = createDesktopCredentialHost(f.session, credentialOptions);
      const locator = { workspaceId: id(825), ...f.location };
      const ref = { id: 'source-auth', policy: 'test-auto' }, token = 'Bearer owned-fixture';
      expect(await credentials.put({ locator, ref, value: JSON.stringify({ formatVersion: 1, kind: 'http-headers', headers: [{ name: 'Authorization', value: token }] }) })).toEqual({ ok: true });
      const provider = createDesktopSyncProviders({ session: f.session, credentials, privateRoot: f.privateRoot + '/sync', confirmDestination: async () => true, pickTool: async () => null });
      const deps = await provider.dependencies(locator);
      const lease = await deps.acquireMaterial({ ...f.source, authRef: 'source-auth' }, new AbortController().signal);
      try { expect(lease.httpHeaders).toEqual([{ name: 'Authorization', value: token }]); } finally { await lease.release(); }
      await f.mutateState(state => { state.sources[0]!.source = { ...f.source, authRef: ref.id }; });
      const ipc = createIpcDeps({ session: f.session, pickDirectory: async () => '', saveFile: async () => '', credentials: credentialOptions, synchronization: { privateRoot: f.privateRoot + '/sync', confirmDestination: async () => true, pickTool: async () => null } });
      const event = { sender: {} }, scope = { kind: 'local' as const, root: f.root, locator };
      try {
        const materials = await ipc.handle(IpcChannel.Synchronization, event, { scope, operation: 'materials' });
        expect(materials).toEqual([{ refId: ref.id, kind: 'credential', status: 'available', version: expect.any(String) }]);
        const result = await ipc.handle(IpcChannel.Synchronization, event, { scope, operation: 'check', sourceId: f.source.id, expectedSourceRevision: '1', expectedAssetVersion: '0', intentId: f.newIntent() });
        expect(result).toMatchObject({ applicable: true });
        expect(f.requests).toEqual([{ conditional: false, status: 200, authorization: token }]);
        expect(JSON.stringify([materials, result])).not.toContain(token);
        const materialReads = f.secrets.calls.filter(call => call.method === 'version' || call.method === 'resolve');
        expect(materialReads.length).toBeGreaterThan(0);
        for (const call of materialReads) expect(call).toMatchObject({ scope: locator, ref });
      } finally { await ipc.stopSynchronization(); }
    });
  });
  it('invokes the actual local source host through the active main session', async () => {
    await withLocalSync(async f => {
      const host = createSynchronizationHost({ session: f.session, local: async () => f.client });
      const scope = { kind: 'local' as const, root: f.root, locator: { workspaceId: id(825), ...f.location } };
      const result = await host.handle({ scope, operation: 'check', sourceId: f.source.id, intentId: f.newIntent(), expectedSourceRevision: '1', expectedAssetVersion: '0' });
      expect(result).toMatchObject({ applicable: true }); expect(f.requests).toHaveLength(1);
    });
  });
  it.each(['root', 'workspace'])('rejects a renderer %s mismatch before touching a provider', async kind => {
    await withLocalSync(async f => {
      let opened = 0;
      const host = createSynchronizationHost({ session: f.session, local: async () => { opened++; return f.client; } });
      const scope = { kind: 'local' as const, root: kind === 'root' ? f.otherRoot : f.root, locator: { workspaceId: kind === 'workspace' ? id(826) : id(825), ...f.location } };
      await expect(host.handle({ scope, operation: 'sources' })).rejects.toThrow('SYNC_CONTEXT_CHANGED');
      expect(opened).toBe(0);
    });
  });
  it('keeps historyMaxEntries per source with actual two-source atomic applications', async () => {
    await withLocalSync(async f => {
      f.deps.policy = { ...defaultSyncPolicyValues, historyMaxEntries: 1 }; await f.reopen();
      const first = await f.apply();
      const secondSource = { ...f.source, id: id(988), moduleId: id(824) };
      await f.client.saveSource(f.location, secondSource, '0');
      const candidate = (await f.client.check(f.location, secondSource.id)).candidate;
      expect(candidate.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
      const second = await f.client.apply(f.location, candidate, f.decisions(candidate, 'keep-current'), f.newIntent());
      expect((await f.client.history(f.location)).map(h => h.sourceId).sort()).toEqual([f.source.id, secondSource.id].sort());
      await f.reopen(); expect(await f.client.operation(f.location, first.intentId)).toEqual(first); expect(await f.client.operation(f.location, second.intentId)).toEqual(second);
    });
  });
});


import { handleOnlineSynchronization } from '../../../src/main/online/synchronization.js';
import { createOnlineSession } from '../../../src/main/online/session.js';
import { createOnlineClient } from '../../../src/main/online/client.js';
import { onlineScope, source as onlineSource, receipt as onlineReceipt, scheduleView, id as fixtureId } from '../../renderer/components/sync/fixtures.js';
async function remoteFixture(gate?: { promise: Promise<void>; started: () => void }) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const checkId = fixtureId(81), status = { formatVersion: 1, checkId, sourceId: onlineSource.id, state: 'waiting', candidateId: null, createdAtMs: 1793980800123, completedAtMs: null, reasonCode: 'source-busy' };
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url); if (path.endsWith('/auth/login')) return Response.json({ token: 'owned-member', expiresAt: '2027-01-01T00:00:00Z', user: { id: '7', username: 'member', displayName: 'Member', role: 'USER', disabled: false } });
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith('/sources') && init?.method === 'GET') { gate?.started(); await gate?.promise; return Response.json([onlineSource]); }
    if (path.endsWith(`/sources/${onlineSource.id}/checks`)) return Response.json({ formatVersion: 1, checkId }, { status: 202 });
    if (path.endsWith(`/checks/${checkId}`) || path.endsWith(`/checks/${checkId}/cancel`)) return Response.json(status);
    if (path.includes('/operations/')) return Response.json({ code: 'sync_operation_not_found', message: 'not found' }, { status: 404 });
    if (path.endsWith('/credentials')) return Response.json([{ refId: 'owned-auth', version: '2', status: 'unavailable' }]);
    if (path.endsWith('/schedule')) { const body = init?.body ? JSON.parse(String(init.body)) : null; return Response.json(body ? { ...scheduleView(), generation: '1', sourceRevision: '2', enabled: body.enabled, subjectUserId: '7', pausedReasonCode: null, rule: body.rule } : scheduleView()); }
    if (path.endsWith('/applications')) { const body = JSON.parse(String(init?.body)); const value = onlineReceipt(body.intentId); return Response.json({ ...value, afterStamp: { ...value.afterStamp, kind: 'online', assetVersion: '9007199254740994' } }); }
    return Response.json({ code: 'unexpected_fixture_request' }, { status: 400 });
  };
  const session = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: fetcher, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  await session.login({ baseUrl: 'https://control.test', username: 'member', password: 'owned-password' }); session.openWorkspace({ workspaceId: '11', name: 'Owned workspace', myRole: 'EDITOR' });
  return { requests, session, checkId, status, handle: (input: import('../../../src/shared/synchronization.js').SynchronizationInput) => handleOnlineSynchronization({ session, fetch: fetcher }, input) };
}
describe('remote synchronization finite main adapter', () => {
  it('uses explicit finite schedule authorization and constructs the canonical decisions digest in main', async () => {
    const f = await remoteFixture(), rule = onlineSource.schedule.rule;
    expect(await f.handle({ scope: onlineScope, operation: 'schedule', sourceId: onlineSource.id })).toMatchObject({ nextPlannedAtUtc: null, nextPlannedState: 'not-calculated' });
    expect(await f.handle({ scope: onlineScope, operation: 'saveSchedule', sourceId: onlineSource.id, expectedSourceRevision: '1', expectedGeneration: '0', enabled: true, rule })).toMatchObject({ generation: '1', subjectUserId: '7' });
    expect(f.requests[1]?.body).toEqual({ formatVersion: 1, expectedSourceRevision: '1', expectedGeneration: '0', enabled: true, rule });
    const decisions = { formatVersion: 1 as const, candidateDigest: 'f'.repeat(64), entries: [{ changeId: '1'.repeat(64), decision: 'take-source' as const }] };
    await f.handle({ scope: onlineScope, operation: 'apply', sourceId: onlineSource.id, candidateId: fixtureId(6), candidateDigest: decisions.candidateDigest, decisions, expectedSourceRevision: '1', expectedAssetVersion: '9007199254740993', intentId: fixtureId(82) });
    expect(f.requests[2]).toMatchObject({ method: 'POST', path: 'https://control.test/api/v1/workspaces/11/projects/33/sync/applications', body: { expectedAssetVersion: '9007199254740993', decisionsDigest: 'b4f47d2ace4503094d0e8b853024f1f02cbeddecfd12906f0163aa7bbefb5e8b' } });
  });
  it('preserves actual unavailable remote material status instead of declaring every registration usable', async () => {
    const f = await remoteFixture();
    expect(await f.handle({ scope: onlineScope, operation: 'materials' })).toEqual([{ refId: 'owned-auth', kind: 'credential', status: 'unavailable', version: '2' }]);
    expect(f.requests.map(request => request.path)).toEqual(['https://control.test/api/v1/workspaces/11/projects/33/credentials']);
  });
  it('rejects an actual late read after sender activation A to B to A', async () => {
    const gate = deferred(), started = deferred(), f = await remoteFixture({ promise: gate.promise, started: started.resolve });
    const host = createSynchronizationHost({ session: (await import('../../../src/main/session.js')).createSession(), local: async () => { throw Error('unexpected local fallback'); }, online: f.handle });
    const sender = {}, other = { ...onlineScope, context: { ...(onlineScope.kind === 'online' ? onlineScope.context : (() => { throw Error(); })()), scope: { workspaceId: '11', groupId: '22', projectId: '44' } } } as typeof onlineScope;
    await host.handle({ scope: onlineScope, operation: 'activate' }, sender);
    const pending = host.handle({ scope: onlineScope, operation: 'sources' }, sender); await started.promise;
    await host.handle({ scope: other, operation: 'activate' }, sender); await host.handle({ scope: onlineScope, operation: 'activate' }, sender); gate.resolve();
    await expect(pending).rejects.toThrow('SYNC_CONTEXT_CHANGED'); expect(f.requests).toHaveLength(1);
  });
  it('uses remote-only canonical scope routes for sources, asynchronous check/status and cancellation', async () => {
    const f = await remoteFixture(); expect(await f.handle({ scope: onlineScope, operation: 'sources' })).toEqual([onlineSource]);
    expect(await f.handle({ scope: onlineScope, operation: 'check', sourceId: onlineSource.id, expectedSourceRevision: '1', expectedAssetVersion: '9007199254740993', intentId: fixtureId(82) })).toEqual({ formatVersion: 1, checkId: f.checkId });
    expect(await f.handle({ scope: onlineScope, operation: 'checkStatus', checkId: f.checkId })).toEqual(f.status);
    expect(await f.handle({ scope: onlineScope, operation: 'cancel', checkId: f.checkId })).toEqual(f.status);
    expect(f.requests.map(r => [r.method, r.path.replace('https://control.test/api/v1/', '')])).toEqual([
      ['GET', 'workspaces/11/projects/33/sync/sources'], ['POST', `workspaces/11/projects/33/sync/sources/${onlineSource.id}/checks`], ['GET', `workspaces/11/projects/33/sync/checks/${f.checkId}`], ['POST', `workspaces/11/projects/33/sync/checks/${f.checkId}/cancel`],
    ]);
    expect(f.requests[1]!.body).toEqual({ formatVersion: 1, expectedSourceRevision: '1', expectedAssetVersion: '9007199254740993', intentId: fixtureId(82) }); expect(f.requests[3]!.body).toEqual({});
  });
  it('recovers only the original intent and treats an absent authorized operation as unknown', async () => {
    const f = await remoteFixture(); expect(await f.handle({ scope: onlineScope, operation: 'operation', intentId: fixtureId(82) })).toBeNull();
    expect(f.requests.map(r => r.path)).toEqual([`https://control.test/api/v1/workspaces/11/projects/33/sync/operations/${fixtureId(82)}`]);
  });
});
