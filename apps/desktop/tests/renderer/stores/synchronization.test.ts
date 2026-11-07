// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { createSynchronizationStore } from '../../../src/renderer/src/stores/synchronization.js';
import { candidateView, source, receipt, localScope, onlineScope, scheduleView, policyView, id, deferred } from '../components/sync/fixtures.js';
import type { SynchronizationInput } from '../../../src/shared/synchronization.js';
import { defaultSyncPolicyValues, SyncCheckStatusSchema, SyncCheckLookupSchema } from '@apicc/execution/contract';
function fixture(action: (input: SynchronizationInput) => Promise<unknown>, refresh?: () => Promise<void>) {
  const applications: SynchronizationInput[] = [];
  const store = createSynchronizationStore({ synchronization: async input => { if (input.operation === 'apply') applications.push(input); if (input.operation === 'sources') return [source]; if (input.operation === 'activate') return null; return action(input); } }, refresh, null);
  store.activate(localScope()); store.selectSource(source.id); return { store, applications };
}
const wrappedReadError = (code: string, channel = 'synchronization:handle') => `Error invoking remote method '${channel}': Error: ${code}`;
function onlineCheckFixture() {
  let phase: 'running' | 'succeeded' | 'failed' = 'running', started = false, rejectStart = false;
  let lookupFailure = false, statusReads = 0, resultCandidateId = id(82), currentCheckId = id(81), checkCreatedAtMs = 1793956009510;
  let heldLookup: (ReturnType<typeof deferred<unknown>> & { entered: ReturnType<typeof deferred<void>> }) | undefined;
  let heldDetail: (ReturnType<typeof deferred<void>> & { entered: ReturnType<typeof deferred<void>> }) | undefined;
  const oldSuccess = SyncCheckStatusSchema.parse({ formatVersion: 1, checkId: id(80), sourceId: source.id, state: 'succeeded', candidateId: id(6), createdAtMs: 1793955900000, completedAtMs: 1793955900100, reasonCode: null });
  const status = () => SyncCheckStatusSchema.parse({ formatVersion: 1, checkId: currentCheckId, sourceId: source.id, state: phase, candidateId: phase === 'succeeded' ? resultCandidateId : null, createdAtMs: checkCreatedAtMs, completedAtMs: phase === 'running' ? null : checkCreatedAtMs + 249, reasonCode: phase === 'failed' ? 'source-read-failed' : null, detailCode: phase === 'failed' ? 'SYNC_TLS_FAILED' : null });
  const lookup = () => SyncCheckLookupSchema.parse({ formatVersion: 1, sourceId: source.id, current: started && phase === 'running' ? status() : null, latestAttempt: started ? status() : oldSuccess, latestSuccess: started && phase === 'succeeded' ? status() : oldSuccess });
  const view = (candidateId: string) => { const value = candidateView(); value.candidate = { ...value.candidate, id: candidateId, stamp: { ...value.candidate.stamp, kind: 'online', assetVersion: '0' } }; if (candidateId === id(82)) { value.candidate.candidateDigest = '5'.repeat(64); value.candidate.changes[0]!.changeId = '6'.repeat(64); value.candidate.changes[0]!.summaries.source = { kind: 'scalar', value: 'New upstream pets', truncated: false }; value.candidate.conflicts[0]!.changeId = '6'.repeat(64); } return value; };
  const f = fixture(async input => {
    if (input.operation === 'checks') { if (started && lookupFailure) throw Error('SYNC_NETWORK_FAILED'); if (started && heldLookup) { const held = heldLookup; heldLookup = undefined; held.entered.resolve(); return held.promise; } return lookup(); }
    if (input.operation === 'schedule') return scheduleView();
    if (input.operation === 'check') { if (rejectStart) throw Error('SYNC_BUSY'); started = true; return { formatVersion: 1, checkId: currentCheckId }; }
    if (input.operation === 'checkStatus') { statusReads++; return status(); }
    if (input.operation === 'candidate') return view(input.candidateId);
    if (input.operation === 'detail') { if (heldDetail) { heldDetail.entered.resolve(); await heldDetail.promise; } const candidate = view(input.request.candidateId).candidate, change = candidate.changes[0]!; return { ...input.request, entityKind: change.entityKind, entityId: change.entityId, assetPath: change.path, fieldPath: change.fieldPath, kind: 'absent' }; }
    if (input.operation === 'policy') return policyView();
    if (input.operation === 'access') return { accountEnabled: true, member: true, workspaceRole: 'EDITOR', projectOverride: null, overrideState: 'inherited', effectiveRole: 'EDITOR', capabilities: ['sync.check','sync.apply'], accessRevision: 1, membershipEpoch: 1, responsibilityEpoch: 1, reasonCode: null };
    return [];
  });
  f.store.activate(onlineScope); f.store.sources = [source]; f.store.selectSource(source.id);
  return { ...f, status, lookup, background(sameCandidate = false, checkId = id(81), createdAtMs = 1793956009510) { started = true; resultCandidateId = sameCandidate ? id(6) : id(82); currentCheckId = checkId; checkCreatedAtMs = createdAtMs; }, setPhase(value: typeof phase) { phase = value; }, rejectStart() { rejectStart = true; }, holdLookup() { heldLookup = { ...deferred<unknown>(), entered: deferred<void>() }; return heldLookup; }, holdDetail() { heldDetail = { ...deferred<void>(), entered: deferred<void>() }; return heldDetail; }, failLookup() { lookupFailure = true; }, statusReads: () => statusReads };
}
it.each(['poll', 'load', 'loadSource'] as const)('A-P2-01 preserves the fixed preview decisions and details when a background result arrives through %s', async entry => {
  vi.useFakeTimers(); const f = onlineCheckFixture(); f.background();
  try {
    await f.store.loadSource(); f.store.capabilities = ['sync.apply']; f.store.decide({ changeId: '1'.repeat(64), decision: 'keep-current' }); f.store.keepConfirmed = true;
    await f.store.loadDetail('1'.repeat(64), 'current'); const fixed = structuredClone(f.store.candidate), decisions = [...f.store.decisions], details = { ...f.store.fixedDetails };
    expect(f.store.blockReason).toBe(''); f.setPhase('succeeded');
    if (entry === 'poll') { f.store.setVisible(true); await vi.advanceTimersByTimeAsync(1000); } else await f.store[entry]();
    expect(f.store.candidate).toEqual(fixed); expect(f.store.decisions).toEqual(decisions); expect(f.store.keepConfirmed).toBe(true); expect(f.store.fixedDetails).toEqual(details);
    expect(f.store.lookup?.latestSuccess?.candidateId).toBe(id(82)); expect(f.store.blockReason).toBe('SYNC_CANDIDATE_SUPERSEDED'); expect(f.applications).toEqual([]);
  } finally { f.store.setVisible(false); vi.useRealTimers(); }
});
it('A-P2-01 keeps decisions usable when a background check repeats the same fixed candidate', async () => {
  const f = onlineCheckFixture(); f.background(true); await f.store.loadSource(); f.store.capabilities = ['sync.apply']; f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' });
  await f.store.loadDetail('1'.repeat(64), 'source'); const fixed = structuredClone(f.store.candidate), details = { ...f.store.fixedDetails };
  f.setPhase('succeeded'); await f.store.readCheck();
  expect(f.store.candidate).toEqual(fixed); expect(f.store.fixedDetails).toEqual(details); expect(f.store.decisions).toEqual([{ changeId: '1'.repeat(64), decision: 'take-source' }]); expect(f.store.blockReason).toBe('');
});
it('A-P2-01 retains known supersession when a later authoritative lookup fails', async () => {
  const f = onlineCheckFixture(); f.background(); await f.store.loadSource(); f.store.capabilities = ['sync.apply']; f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' });
  f.setPhase('succeeded'); await f.store.readCheck(); expect(f.store.blockReason).toBe('SYNC_CANDIDATE_SUPERSEDED');
  f.failLookup(); await f.store.readCheck();
  expect(f.store.lookup).toBeNull(); expect(f.store.error).toBe('SYNC_NETWORK_FAILED'); expect(f.store.candidate?.candidate.id).toBe(id(6)); expect(f.store.blockReason).toBe('SYNC_CANDIDATE_SUPERSEDED');
});
it.each(['readCheck', 'loadSource'] as const)('A-P2-01 ignores an old same-preview lookup from %s after a newer result supersedes A', async entry => {
  const f = onlineCheckFixture(); f.background(); await f.store.loadSource(); f.store.capabilities = ['sync.apply']; f.store.decide({ changeId: '1'.repeat(64), decision: 'keep-current' }); f.store.keepConfirmed = true;
  await f.store.loadDetail('1'.repeat(64), 'current'); const fixed = structuredClone(f.store.candidate), decisions = [...f.store.decisions], details = { ...f.store.fixedDetails };
  const oldLookup = f.lookup(), gate = f.holdLookup(), pending = f.store[entry](); await gate.entered.promise;
  try {
    f.setPhase('succeeded'); await f.store.readCheck(); expect(f.store.blockReason).toBe('SYNC_CANDIDATE_SUPERSEDED');
  } finally { gate.resolve(oldLookup); await pending; }
  expect(f.store.blockReason).toBe('SYNC_CANDIDATE_SUPERSEDED'); expect(f.store.lookup?.latestSuccess?.candidateId).toBe(id(82));
  expect(f.store.candidate).toEqual(fixed); expect(f.store.decisions).toEqual(decisions); expect(f.store.keepConfirmed).toBe(true); expect(f.store.fixedDetails).toEqual(details);
  await expect(f.store.apply()).rejects.toThrow('SYNC_CANDIDATE_SUPERSEDED'); expect(f.applications).toEqual([]);
});
it('A-P2-01 unlocks the fixed candidate after a genuinely newer same-ID success', async () => {
  const f = onlineCheckFixture(); f.background(); await f.store.loadSource(); f.store.capabilities = ['sync.apply']; f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' });
  const fixed = structuredClone(f.store.candidate), decisions = [...f.store.decisions]; f.setPhase('succeeded'); await f.store.readCheck(); expect(f.store.blockReason).toBe('SYNC_CANDIDATE_SUPERSEDED');
  f.background(true, id(83), 1793956010510); await f.store.readCheck(id(83));
  expect(f.store.lookup?.latestSuccess?.checkId).toBe(id(83)); expect(f.store.lookup?.latestSuccess?.candidateId).toBe(id(6));
  expect(f.store.candidate).toEqual(fixed); expect(f.store.decisions).toEqual(decisions); expect(f.store.blockReason).toBe('');
});
it('A-P2-01 an automatic reload cannot refill a pending manual preview with an earlier success', async () => {
  const f = onlineCheckFixture(); await f.store.loadSource(); await f.store.check(); await f.store.load();
  expect(f.store.candidate).toBeNull(); expect(f.store.decisions).toEqual([]);
  f.setPhase('succeeded'); await f.store.readCheck(); expect(f.store.candidate?.candidate.id).toBe(id(82));
});
it('A-P2-01 a late fixed detail cannot enter the candidate chosen by explicit Refresh', async () => {
  const f = onlineCheckFixture(); f.background(); await f.store.loadSource(); const gate = f.holdDetail();
  const pending = f.store.loadDetail('1'.repeat(64), 'current'); await gate.entered.promise;
  try { f.setPhase('succeeded'); await f.store.refresh(); expect(f.store.candidate?.candidate.id).toBe(id(82)); }
  finally { gate.resolve(); await pending; }
  expect(f.store.fixedDetails).toEqual({}); expect(f.store.detailBusy).toEqual([]); expect(f.store.detailChangeId).toBe('');
});
it('I4 keeps active check polling and a visible read error if authoritative lookup refresh fails', async () => {
  vi.useFakeTimers(); const f = onlineCheckFixture();
  try {
    await f.store.loadSource(); f.store.setVisible(true); f.failLookup(); await f.store.check();
    expect(f.store.error).toBe('SYNC_NETWORK_FAILED'); expect(f.store.checkStatus?.state).toBe('running'); expect(f.store.lookup).toBeNull(); expect(f.store.schedule).toEqual(scheduleView());
    expect(f.statusReads()).toBe(1); await vi.advanceTimersByTimeAsync(1000); expect(f.statusReads()).toBe(2); expect(f.store.error).toBe('SYNC_NETWORK_FAILED'); expect(f.applications).toEqual([]);
  } finally { f.store.setVisible(false); vi.useRealTimers(); }
});
it('I4 retains the loaded schedule while manual online admission is pending and clears the old lookup', async () => {
  const late = deferred<unknown>(), entered = deferred<void>();
  const f = fixture(async input => { if (input.operation === 'check') { entered.resolve(); return late.promise; } return []; });
  f.store.activate(onlineScope); f.store.sources = [source]; f.store.selectSource(source.id); f.store.schedule = scheduleView();
  f.store.lookup = SyncCheckLookupSchema.parse({ formatVersion: 1, sourceId: source.id, current: null, latestAttempt: null, latestSuccess: null });
  const pending = f.store.check(); await entered.promise;
  try { expect(f.store.schedule).toEqual(scheduleView()); expect(f.store.lookup).toBeNull(); expect(f.store.busy).toBe(true); }
  finally { late.reject(Error('SYNC_BUSY')); await pending; }
});
it.each(['running', 'succeeded', 'failed'] as const)('I4 retains the same-source schedule after manual online check becomes %s', async phase => {
  const f = onlineCheckFixture(); await f.store.loadSource(); const schedule = f.store.schedule;
  f.setPhase(phase); await f.store.check(); expect(f.store.checkStatus?.state).toBe(phase);
  expect(f.store.schedule).toEqual(schedule); expect(f.store.schedule?.generation).toBe('0'); expect(f.store.schedule?.rule.timeZone).toBe('UTC');
  if (phase === 'failed') expect(f.store.candidate).toBeNull(); expect(f.applications).toEqual([]);
});
it.each(['running', 'succeeded', 'failed'] as const)('I4 reads authoritative latest attempt and success after manual online check becomes %s', async phase => {
  const f = onlineCheckFixture(); await f.store.loadSource(); f.setPhase(phase); await f.store.check();
  expect(f.store.checkStatus?.state).toBe(phase); expect(f.store.lookup).toEqual(f.lookup());
  expect(f.store.lookup?.latestAttempt?.checkId).toBe(id(81)); expect(f.store.lookup?.latestSuccess?.checkId).toBe(phase === 'succeeded' ? id(81) : id(80));
  if (phase === 'failed') expect(f.store.candidate).toBeNull();
});
it('I4 keeps the source schedule if manual online admission fails without relabeling old lookup as latest', async () => {
  const f = onlineCheckFixture(); await f.store.loadSource(); const schedule = f.store.schedule; f.rejectStart(); await f.store.check();
  expect(f.store.error).toBe('SYNC_BUSY'); expect(f.store.schedule).toEqual(schedule); expect(f.store.lookup).toBeNull(); expect(f.store.candidate).toBeNull();
});
it.each(['scope', 'source'] as const)('I4 drops an old check status after a %s switch without restoring its schedule or lookup', async kind => {
  const late = deferred<unknown>(), entered = deferred<void>();
  const f = fixture(async input => { if (input.operation === 'check') return { formatVersion: 1, checkId: id(81) }; if (input.operation === 'checkStatus') { entered.resolve(); return late.promise; } return []; });
  f.store.activate(onlineScope); f.store.sources = [source]; f.store.selectSource(source.id); f.store.schedule = scheduleView();
  const pending = f.store.check(); await entered.promise;
  if (onlineScope.kind !== 'online') throw Error('online fixture required');
  if (kind === 'scope') f.store.activate({ ...onlineScope, context: { ...onlineScope.context, scope: { ...onlineScope.context.scope, projectId: '44' } } }); else f.store.selectSource(id(88));
  late.resolve({ formatVersion: 1, checkId: id(81), sourceId: source.id, state: 'succeeded', candidateId: id(82), createdAtMs: 1793956009510, completedAtMs: 1793956009759, reasonCode: null }); await pending;
  expect(f.store.schedule).toBeNull(); expect(f.store.lookup).toBeNull(); expect(f.store.candidate).toBeNull(); expect(f.store.checkStatus).toBeNull();
});
it.each(['scope', 'source'] as const)('I4 drops a late authoritative lookup after a %s switch', async kind => {
  const f = onlineCheckFixture(); await f.store.loadSource(); await f.store.check(); const late = f.holdLookup();
  const pending = f.store.readCheck(); await late.entered.promise;
  if (onlineScope.kind !== 'online') throw Error('online fixture required');
  if (kind === 'scope') f.store.activate({ ...onlineScope, context: { ...onlineScope.context, scope: { ...onlineScope.context.scope, projectId: '44' } } }); else f.store.selectSource(id(88));
  late.resolve(f.lookup()); await pending;
  expect(f.store.schedule).toBeNull(); expect(f.store.lookup).toBeNull(); expect(f.store.candidate).toBeNull(); expect(f.store.checkStatus).toBeNull();
});
it.each(['SYNC_CANCELLED', 'SYNC_TLS_FAILED'])('I3 recovers exact synchronization read wrapper %s for readable state without producing a candidate or write intent', async code => {
  const f = fixture(async input => { if (input.operation === 'check') throw Error(wrappedReadError(code)); return []; });
  await f.store.check(); expect(f.store.error).toBe(code); expect(f.store.candidate).toBeNull(); expect(f.store.intentId).toBe(''); expect(f.applications).toEqual([]);
});
it.each([
  wrappedReadError('SYNC_UNDECLARED_PRIVATE_REASON'), wrappedReadError('SYNC_CANCELLED extra private text'), wrappedReadError('SYNC_CANCELLED', 'other:handle'), 'private prefix ' + wrappedReadError('SYNC_CANCELLED'), 'private text contains SYNC_CANCELLED',
])('I3 does not recover a finite code from undeclared, wrong-channel or embedded text %s', async text => {
  const f = fixture(async input => { if (input.operation === 'check') throw Error(text); return []; }); await f.store.check(); expect(f.store.error).toBe(text);
});
it('I3 leaves a settings write rejection intact rather than reclassifying it as a read error', async () => {
  const text = wrappedReadError('SYNC_CANCELLED'); const f = fixture(async () => { throw Error(text); });
  await expect(f.store.saveSettings({ maxRedirects: 5, policy: { ...defaultSyncPolicyValues } })).rejects.toThrow(text);
});
it('I3 preserves unknown apply ownership after a raw cancellation error and an absent receipt', async () => {
  const f = fixture(async input => { if (input.operation === 'apply') throw Error(wrappedReadError('SYNC_CANCELLED')); return null; });
  f.store.candidate = candidateView(); f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); await f.store.apply(); const intent = f.store.intentId;
  expect(intent).not.toBe(''); expect(f.store.error).toBe('SYNC_OPERATION_UNKNOWN'); await f.store.apply(); expect(f.store.intentId).toBe(intent); expect(f.applications).toHaveLength(1);
});
it.each(['committed', 'rejected'])('fix1 A I3 old %s apply does not change the new source candidate decisions or error', async outcome => {
  const late = deferred<unknown>(), secondSource = { ...source, id: id(88) }, second = candidateView(); second.candidate = { ...second.candidate, id: id(89), sourceId: secondSource.id, candidateDigest: '5'.repeat(64) };
  const f = fixture(async input => input.operation === 'apply' ? late.promise : input.operation === 'check' ? second : []); f.store.sources = [source, secondSource];
  f.store.candidate = candidateView(); f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); const pending = f.store.apply(); await vi.waitFor(() => expect(f.applications).toHaveLength(1));
  f.store.selectSource(secondSource.id); await f.store.check(); f.store.decide({ changeId: '1'.repeat(64), decision: 'keep-current' }); f.store.error = 'second-source-error'; const decisions = [...f.store.decisions];
  const input = f.applications[0]!; if (input.operation !== 'apply') throw Error('invalid fixture');
  if (outcome === 'committed') late.resolve(receipt(input.intentId)); else late.reject(Error('SYNC_REJECTED:forbidden')); await pending;
  expect(f.store.candidate).toEqual(second); expect(f.store.decisions).toEqual(decisions); expect(f.store.error).toBe('second-source-error');
  if (outcome === 'committed') expect(f.store.receipt?.sourceId).toBe(source.id); expect(f.applications).toHaveLength(1);
});
it('fix1 A I3 an old saved source cannot reselect itself over a newer preview', async () => {
  const late = deferred<unknown>(), entered = deferred<void>(), secondSource = { ...source, id: id(88) }, second = candidateView(); second.candidate = { ...second.candidate, id: id(89), sourceId: secondSource.id };
  const f = fixture(async input => { if (input.operation === 'saveSource') { entered.resolve(); return late.promise; } if (input.operation === 'check') return second; return []; }); f.store.sources = [source, secondSource];
  const pending = f.store.saveSource({ ...source, revision: '2' }, '1'); await entered.promise; f.store.selectSource(secondSource.id); await f.store.check();
  late.resolve({ ...source, revision: '2' }); await pending; expect(f.store.sourceId).toBe(secondSource.id); expect(f.store.candidate).toEqual(second);
});
it('fix1 A I4 source switch releases only the old schedule busy display and never replays authorization', async () => {
  const late = deferred<unknown>(), entered = deferred<void>(), writes: SynchronizationInput[] = [];
  const store = createSynchronizationStore({ synchronization: async input => { if (input.operation === 'saveSchedule') { writes.push(input); entered.resolve(); return late.promise; } return null; } }, undefined, null);
  store.activate(onlineScope); store.selectSource(source.id); store.schedule = scheduleView(); const pending = store.saveSchedule(true, source.schedule.rule); await entered.promise;
  store.selectSource(id(88)); expect(store.scheduleBusy).toBe(false); store.schedule = { ...scheduleView(), sourceId: id(88) };
  late.resolve({ ...scheduleView(), generation: '1', sourceRevision: '2', enabled: true, subjectUserId: '7' }); await pending; expect(store.scheduleBusy).toBe(false); expect(store.schedule?.sourceId).toBe(id(88)); expect(writes).toHaveLength(1);
});
it('clears candidate and old errors immediately when project scope changes and drops a late response', async () => {
  const late = deferred<unknown>(); const f = fixture(async () => late.promise);
  f.store.candidate = candidateView(); f.store.error = 'old'; const pending = f.store.check(); f.store.activate(localScope(id(99)));
  expect(f.store.candidate).toBeNull(); expect(f.store.error).toBe(''); late.resolve(candidateView()); await pending; expect(f.store.candidate).toBeNull(); expect(f.applications).toEqual([]);
});
it('clears the preview on source selection and ignores an old source response', async () => {
  const late = deferred<unknown>(), f = fixture(async () => late.promise); f.store.candidate = candidateView(); const pending = f.store.check(); f.store.selectSource(id(88));
  expect(f.store.candidate).toBeNull(); late.resolve(candidateView()); await pending; expect(f.store.candidate).toBeNull();
});
it.each(['project', 'source'])('discards a completed old %s check after switching', async kind => {
  const late = deferred<unknown>(), f = fixture(async () => late.promise); const pending = f.store.check();
  if (kind === 'project') f.store.activate(localScope(id(99))); else f.store.selectSource(id(88));
  late.resolve(candidateView()); await pending; expect(f.store.candidate).toBeNull();
});
it('requires every conflict decision before application', async () => {
  const f = fixture(async () => receipt()); f.store.candidate = candidateView(); await expect(f.store.apply()).rejects.toThrow('SYNC_DECISION_REQUIRED'); expect(f.applications).toEqual([]);
});
it('requires explicit confirmation after choosing keep current', async () => {
  const f = fixture(async () => receipt()); f.store.candidate = candidateView(); f.store.decide({ changeId: '1'.repeat(64), decision: 'keep-current' }); await expect(f.store.apply()).rejects.toThrow('SYNC_KEEP_CONFIRM_REQUIRED'); expect(f.applications).toEqual([]);
});
it('reconciles a lost application response by the original intent without replay', async () => {
  const seen: SynchronizationInput[] = [], f = fixture(async input => { seen.push(input); if (input.operation === 'apply') throw Error('connection-lost'); if (input.operation === 'operation') return receipt(input.intentId); if (input.operation === 'history') return []; return []; });
  f.store.candidate = candidateView(); f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); await f.store.apply();
  expect(f.store.receipt?.status).toBe('committed'); expect(seen.map(i => i.operation).filter(op => op !== 'history')).toEqual(['apply', 'operation']); expect(f.applications).toHaveLength(1);
});
it('preserves committed success when refresh fails and refuses a replay', async () => {
  const f = fixture(async input => input.operation === 'apply' ? receipt(input.intentId) : [], async () => { throw Error('refresh unavailable'); });
  f.store.candidate = candidateView(); f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); await f.store.apply();
  expect(f.store.receipt?.status).toBe('committed'); expect(f.store.refreshError).toBe('refresh unavailable'); await f.store.apply(); expect(f.applications).toHaveLength(1);
});
it('keeps submitted intent ownership across a source switch and reconciles on returning to a scope', async () => {
  const late = deferred<unknown>(), f = fixture(async input => input.operation === 'apply' ? late.promise : []);
  f.store.candidate = candidateView(); f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); const pending = f.store.apply(); await Promise.resolve(); await Promise.resolve(); f.store.selectSource(id(88));
  late.resolve(receipt(f.applications[0]!.operation === 'apply' ? f.applications[0]!.intentId : id(8))); await pending;
  expect(f.store.receipt?.status).toBe('committed'); await f.store.apply(); expect(f.applications).toHaveLength(1);
});
it('allows a genuinely new candidate in the same scope after an earlier receipt', async () => {
  const f = fixture(async input => input.operation === 'apply' ? { ...receipt(input.intentId), sourceId: input.sourceId } : []);
  f.store.candidate = candidateView(); f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); await f.store.apply();
  f.store.selectSource(id(88)); const next = candidateView(); next.candidate = { ...next.candidate, id: id(89), sourceId: id(88), candidateDigest: '5'.repeat(64) }; f.store.candidate = next;
  f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); await f.store.apply(); expect(f.applications).toHaveLength(2); expect(f.store.receipt?.sourceId).toBe(id(88));
});
it('allows an explicit new submission after a definitive refusal while unknown outcomes still reconcile', async () => {
  let rejected = false;
  const f = fixture(async input => { if (input.operation === 'apply') { if (!rejected) { rejected = true; throw Error('SYNC_REJECTED:forbidden'); } return receipt(input.intentId); } return null; });
  f.store.candidate = candidateView(); f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); await f.store.apply();
  f.store.candidate = candidateView(); f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); await f.store.apply(); expect(f.applications).toHaveLength(2); expect(f.store.receipt?.status).toBe('committed');
});
it('retains the original intent after a post-commit context fence and an absent receipt lookup', async () => {
  const f = fixture(async input => { if (input.operation === 'apply') throw Error('SYNC_CONTEXT_CHANGED'); return null; });
  f.store.candidate = candidateView(); f.store.decide({ changeId: '1'.repeat(64), decision: 'take-source' }); await f.store.apply(); const intent = f.store.intentId;
  await f.store.apply(); expect(f.applications).toHaveLength(1); expect(f.store.intentId).toBe(intent); expect(f.store.error).toBe('SYNC_OPERATION_UNKNOWN');
});
it('fix1 C bounded reader keeps only one change and one in-flight document request', async () => {
  const late = deferred<unknown>(), entered = deferred<void>(), calls: SynchronizationInput[] = [];
  const view = candidateView(); const first = view.candidate.changes[0]!, second = { ...first, changeId: '7'.repeat(64), fieldPath: '/metadata/name' }; view.candidate.changes.push(second);
  const document = (change: typeof first, side: 'baseline' | 'current' | 'source') => ({ formatVersion: 1, candidateId: view.candidate.id, candidateDigest: view.candidate.candidateDigest, changeId: change.changeId, side, entityKind: change.entityKind, entityId: change.entityId, assetPath: change.path, fieldPath: change.fieldPath, kind: 'document', contentType: 'application/vnd.apicc.contract+yaml', text: 'fixed complete document'.repeat(1024), bytes: 22528, sha256: '8'.repeat(64) });
  const f = fixture(async input => { if (input.operation !== 'detail') return null; calls.push(input); if (calls.length === 3) { entered.resolve(); return late.promise; } return document(input.request.changeId === first.changeId ? first : second, input.request.side); }); f.store.candidate = view;
  await f.store.loadDetail(first.changeId, 'baseline'); await f.store.loadDetail(second.changeId, 'source');
  expect(Object.keys(f.store.fixedDetails)).toEqual([`${view.candidate.id}:${second.changeId}:source`]);
  const pending = f.store.loadDetail(first.changeId, 'current'); await entered.promise; const duplicate = f.store.loadDetail(second.changeId, 'baseline'); await Promise.resolve(); await Promise.resolve(); expect(calls).toHaveLength(3);
  late.resolve(document(first, 'current')); await Promise.all([pending, duplicate]); expect(Object.values(f.store.fixedDetails).some(value => value.changeId === first.changeId)).toBe(false);
  expect(f.store.detailBusy).toEqual([]); await f.store.loadDetail(second.changeId, 'baseline'); expect(calls).toHaveLength(4); expect(Object.keys(f.store.fixedDetails)).toEqual([`${view.candidate.id}:${second.changeId}:baseline`]);
});
