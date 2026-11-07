import { shallowReactive } from 'vue';
import { SyncCandidateViewSchema, SyncFixedDetailSchema, SyncDecisionsSchema, SyncReceiptSchema, SyncSourceSchema, SyncHistoryEntrySchema, type SyncCandidateView, type SyncFixedDetail, type SyncFixedDetailRequest, type SyncDecisions, type SyncReceipt, type SyncSource, type SyncHistoryEntry } from '@apicc/core/sync/shared';
import { SyncCheckAcceptedSchema, SyncCheckStatusSchema, SyncCheckLookupSchema, SchedulePreviewSchema, syncErrorCodeValues, type SyncCheckStatus, type SyncCheckLookup } from '@apicc/execution/contract';
import { ProjectCollaborationAccessSchema } from '@apicc/execution/client/collaboration';
import { IpcChannel } from '../../../shared/channels.js';
import { SyncHostSettingsSchema, SyncScheduleViewSchema, SyncPolicyViewSchema, SyncMaterialStatusSchema, type SynchronizationInput, type SynchronizationPort, type SyncScope, type SyncHostSettings, type SyncScheduleView, type SyncPolicyView, type SyncMaterialStatus } from '../../../shared/synchronization.js';
import type { z } from 'zod';
const key = (scope: SyncScope | null) => JSON.stringify(scope);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const detailErrorCodes = new Set<string>(syncErrorCodeValues);
const inspectionOperations = new Set<SynchronizationInput['operation']>(['sources', 'check', 'candidate', 'detail', 'history', 'materials', 'settings', 'policy', 'access', 'checks', 'checkStatus', 'schedule', 'previewSchedule']);
const synchronizationErrorPrefix = `Error invoking remote method '${IpcChannel.Synchronization}': Error: `;
const failureCode = (text: string) => {
  const detail = /SYNC_DETAIL:([A-Za-z0-9_-]+)/.exec(text)?.[1];
  if (detail) return detailErrorCodes.has(detail) ? detail : 'SYNC_REQUEST_FAILED';
  return /SYNC_(?:REJECTED|UNCERTAIN):([a-zA-Z0-9_-]+)/.exec(text)?.[1] ?? text;
};
const message = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? failureCode(error.message) : 'SYNC_REQUEST_FAILED';
type PreviewOwner = { token: number; preview: number; sourceId: string; candidateId: string | null };
type Intent = { owner?: PreviewOwner; scope: SyncScope; sourceId: string; intentId: string; identity: string; receipt: SyncReceipt | null; pending: boolean };
export function createSynchronizationStore(api: SynchronizationPort, refresh: () => Promise<void> = async () => undefined, storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage) {
  let generation = 0, previewGeneration = 0, lookupGeneration = 0, detailGeneration = 0, detailOwner: symbol | undefined, activation: Promise<unknown> = Promise.resolve(), timer: ReturnType<typeof setTimeout> | undefined;
  // Undefined follows latest success only until a preview is selected; null owns pending manual admission.
  let previewCheck: string | null | undefined;
  const intents = new Map<string, Intent>();
  const persistenceKey = 'apicc.sync.pending-intents.v1';
  try { const pending = JSON.parse(storage?.getItem(persistenceKey) ?? '[]'); if (Array.isArray(pending)) for (const entry of pending.slice(0, 32)) { const scope = entry.scope as SyncScope; if (scope && typeof entry.intentId === 'string' && typeof entry.sourceId === 'string' && typeof entry.identity === 'string') intents.set(key(scope), { ...entry, receipt: null, pending: false }); } } catch { /* Memory ownership remains authoritative for this window. */ }
  const persist = () => { try { storage?.setItem(persistenceKey, JSON.stringify([...intents.values()].filter(i => !i.receipt).map(({ scope, sourceId, intentId, identity }) => ({ scope, sourceId, intentId, identity })))); } catch { store.persistenceError = 'SYNC_INTENT_STORAGE_UNAVAILABLE'; } };
  const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const current = (token: number, scope: SyncScope) => token === generation && key(scope) === key(store.scope);
  const previewCurrent = (token: number, preview: number, scope: SyncScope, sourceId: string) => current(token, scope) && preview === previewGeneration && sourceId === store.sourceId;
  const ownsPreview = (intent: Intent) => !!intent.owner && previewCurrent(intent.owner.token, intent.owner.preview, intent.scope, intent.owner.sourceId) && (store.candidate?.candidate.id ?? null) === intent.owner.candidateId;
  const request = async (input: SynchronizationInput) => {
    await activation;
    try { return await api.synchronization(copy({ ...input, locale: store.locale })); }
    catch (error) {
      if (inspectionOperations.has(input.operation) && error instanceof Error && error.message.startsWith(synchronizationErrorPrefix)) {
        const code = error.message.slice(synchronizationErrorPrefix.length);
        if (detailErrorCodes.has(code)) throw new Error(code);
      }
      throw error;
    }
  };
  const clearPreview = () => { previewGeneration++; detailGeneration++; previewCheck = undefined; stop(); store.candidate = null; store.replacementCandidateId = ''; store.decisions = []; store.keepConfirmed = false; store.error = ''; store.busy = false; store.checkStatus = null; store.lookup = null; store.schedule = null; store.preview = null; store.scheduleError = ''; store.scheduleBusy = false; store.fixedDetails = {}; store.detailErrors = {}; store.detailChangeId = ''; };
  const observeLookup = (lookup: SyncCheckLookup) => { store.lookup = lookup; const latest = lookup.sourceId === store.sourceId ? lookup.latestSuccess?.candidateId : null; if (store.candidate && latest) store.replacementCandidateId = latest === store.candidate.candidate.id ? '' : latest; };
  async function publish(intent: Intent) {
    if (key(store.scope) !== key(intent.scope)) return;
    store.receipt = intent.receipt; store.intentId = intent.intentId; store.intentSourceId = intent.sourceId; store.applying = intent.pending;
    if (intent.receipt) { if (ownsPreview(intent)) store.error = ''; store.refreshError = ''; try { await refresh(); } catch (error) { if (key(store.scope) === key(intent.scope)) store.refreshError = message(error); } }
  }
  async function reconcile(intent: Intent) {
    try { const result = SyncReceiptSchema.nullable().parse(await api.synchronization({ scope: intent.scope, operation: 'operation', intentId: intent.intentId }));
      if (result && (result.intentId !== intent.intentId || result.sourceId !== intent.sourceId)) throw Error('SYNC_RECEIPT_MISMATCH');
      intent.receipt = result; if (result) persist(); else if (ownsPreview(intent)) store.error = 'SYNC_OPERATION_UNKNOWN';
    } catch (error) { if (ownsPreview(intent)) store.error = message(error); }
    await publish(intent);
  }
  async function submit(input: Extract<SynchronizationInput, { operation: 'apply' | 'rollback' }>, identity: string) {
    const scopeKey = key(input.scope), prior = intents.get(scopeKey);
    if (prior && !prior.receipt) { await reconcile(prior); return; }
    if (prior?.identity === identity && prior.receipt) return;
    const intent: Intent = { owner: { token: generation, preview: previewGeneration, sourceId: input.sourceId, candidateId: store.candidate?.candidate.id ?? null }, scope: copy(input.scope), sourceId: input.sourceId, intentId: input.intentId, identity, receipt: null, pending: true };
    intents.set(scopeKey, intent); persist(); store.applying = true; store.receipt = null; store.intentId = intent.intentId; store.intentSourceId = intent.sourceId;
    try { const result = SyncReceiptSchema.parse(await request(input)); if (result.intentId !== input.intentId || result.sourceId !== input.sourceId) throw Error('SYNC_RECEIPT_MISMATCH'); intent.receipt = result; persist(); }
    catch (error) {
      if (error instanceof Error && /SYNC_REJECTED:[a-zA-Z0-9_-]+/.test(error.message)) {
        if (intents.get(scopeKey) === intent) intents.delete(scopeKey); persist();
        if (key(store.scope) === scopeKey) { store.intentId = ''; store.intentSourceId = ''; store.applying = false; if (ownsPreview(intent)) store.error = message(error); }
        return;
      }
      await reconcile(intent);
    }
    finally { intent.pending = false; }
    await publish(intent);
    if (key(store.scope) === scopeKey && intent.receipt) { if (ownsPreview(intent)) { store.candidate = null; store.decisions = []; } try { await store.loadHistory(); } catch { /* A committed receipt is independent from history refresh. */ } }
  }
  const store = shallowReactive({
    locale: 'zh-CN' as 'zh-CN' | 'en', scope: null as SyncScope | null, sources: [] as SyncSource[], sourceId: '', candidate: null as SyncCandidateView | null,
    detailChangeId: '', fixedDetails: {} as Record<string, SyncFixedDetail>, detailErrors: {} as Record<string, string>, detailBusy: [] as string[],
    history: [] as SyncHistoryEntry[], decisions: [] as SyncDecisions['entries'], keepConfirmed: false, receipt: null as SyncReceipt | null,
    error: '', refreshError: '', persistenceError: '', busy: false, applying: false, visible: false, assetVersion: '0', intentId: '', intentSourceId: '',
    settings: null as SyncHostSettings | null, policy: null as SyncPolicyView | null, materials: [] as SyncMaterialStatus[], capabilities: null as string[] | null,
    checkStatus: null as SyncCheckStatus | null, lookup: null as SyncCheckLookup | null, replacementCandidateId: '', schedule: null as SyncScheduleView | null,
    preview: null as z.infer<typeof SchedulePreviewSchema> | null, scheduleError: '', scheduleBusy: false,
    get selectedSource(): SyncSource | null { return store.sources.find(s => s.id === store.sourceId) ?? null; },
    get candidateSuperseded(): boolean { return !!store.candidate && !!store.replacementCandidateId && store.replacementCandidateId !== store.candidate.candidate.id; },
    get blockReason(): string {
      if (store.applying) return 'SYNC_OPERATION_PENDING'; if (!store.candidate) return 'SYNC_CANDIDATE_REQUIRED';
      if (store.candidateSuperseded) return 'SYNC_CANDIDATE_SUPERSEDED';
      if (!store.candidate.applicable) return store.candidate.reasonCode ?? 'SYNC_CANDIDATE_STALE';
      if (store.candidate.candidate.diagnostics.some(d => d.severity === 'error')) return 'SYNC_DIAGNOSTICS_BLOCKED';
      if (store.candidate.candidate.changes.some(c => !store.decisions.some(d => d.changeId === c.changeId))) return 'SYNC_DECISION_REQUIRED';
      if (!SyncDecisionsSchema.safeParse({ formatVersion: 1, candidateDigest: store.candidate.candidate.candidateDigest, entries: store.decisions }).success) return 'SYNC_MAPPING_DECISION_INVALID';
      if (store.decisions.some(d => d.decision === 'keep-current') && !store.keepConfirmed) return 'SYNC_KEEP_CONFIRM_REQUIRED';
      if (store.scope?.kind === 'online' && !store.capabilities?.includes('sync.apply')) return 'forbidden';
      return '';
    },
    activate(scope: SyncScope | null) {
      if (key(scope) === key(store.scope)) return; const previousScope = store.scope; generation++; clearPreview(); store.scope = scope ? copy(scope) : null;
      store.sources = []; store.history = []; store.materials = []; store.policy = null; store.settings = null; store.capabilities = null; store.sourceId = ''; store.receipt = null; store.refreshError = ''; store.applying = false; store.intentId = ''; store.intentSourceId = ''; store.scheduleBusy = false;
      const intent = intents.get(key(scope)); if (intent) { store.receipt = intent.receipt; store.applying = intent.pending; store.intentId = intent.intentId; store.intentSourceId = intent.sourceId; }
      activation = scope ? api.synchronization({ scope: copy(scope), operation: 'activate' }).catch(error => { if (key(scope) === key(store.scope)) store.error = message(error); throw error; }) : previousScope ? api.synchronization({ scope: copy(previousScope), operation: 'deactivate' }).catch(() => undefined) : Promise.resolve();
      void activation.catch(() => undefined);
    },
    selectSource(id: string) { if (id === store.sourceId) return; clearPreview(); store.sourceId = id; if (store.visible) void store.loadSource(); },
    setVisible(visible: boolean) { store.visible = visible; if (!visible) stop(); else if (store.checkStatus) schedulePoll(); },
    async load() {
      if (!store.scope) return; const scope = copy(store.scope), token = generation; store.busy = true;
      try { const sources = SyncSourceSchema.array().parse(await request({ scope, operation: 'sources' })); if (!current(token, scope)) return; store.sources = sources; if (!sources.some(s => s.id === store.sourceId)) store.selectSource(sources[0]?.id ?? '');
        const reads = [store.loadHistory(), (async () => { const value = SyncMaterialStatusSchema.array().parse(await request({ scope, operation: 'materials' })); if (current(token, scope)) store.materials = value; })(),
          scope.kind === 'local' ? (async () => { const value = SyncHostSettingsSchema.parse(await request({ scope, operation: 'settings' })); if (current(token, scope)) store.settings = value; })() : (async () => {
            const [policy, access] = await Promise.all([request({ scope, operation: 'policy' }), request({ scope, operation: 'access' })]); if (!current(token, scope)) return; store.policy = SyncPolicyViewSchema.parse(policy); store.capabilities = ProjectCollaborationAccessSchema.parse(access).capabilities;
          })()];
        const results = await Promise.allSettled(reads); if (current(token, scope)) { const failure = results.find(r => r.status === 'rejected'); if (failure?.status === 'rejected') store.error = message(failure.reason); }
        if (current(token, scope) && scope.kind === 'online') await store.loadSource();
        const intent = intents.get(key(scope)); if (intent && !intent.receipt && !intent.pending && current(token, scope)) await reconcile(intent);
      } catch (error) { if (current(token, scope)) store.error = message(error); }
      finally { if (current(token, scope)) store.busy = false; }
    },
    async loadHistory() { if (!store.scope) return; const scope = copy(store.scope), token = generation; const result = SyncHistoryEntrySchema.array().parse(await request({ scope, operation: 'history' })); if (current(token, scope)) store.history = result; },
    async refresh() { if (!store.scope) return; clearPreview(); await store.load(); },
    async loadSource() {
      if (store.scope?.kind !== 'online' || !store.sourceId) return; const scope = copy(store.scope), token = generation, preview = previewGeneration, sourceId = store.sourceId, lookupRequest = ++lookupGeneration;
      const owns = () => previewCurrent(token, preview, scope, sourceId) && lookupRequest === lookupGeneration;
      try { const lookup = SyncCheckLookupSchema.parse(await request({ scope, operation: 'checks', sourceId })); if (!owns()) return; observeLookup(lookup); store.checkStatus = lookup.current ?? lookup.latestAttempt;
        const schedule = SyncScheduleViewSchema.parse(await request({ scope, operation: 'schedule', sourceId })); if (!owns()) return; store.schedule = schedule;
        const candidateId = !store.candidate && previewCheck === undefined ? lookup.latestSuccess?.candidateId : null; if (candidateId) { const candidate = SyncCandidateViewSchema.parse(await request({ scope, operation: 'candidate', candidateId })); if (owns() && !store.candidate && previewCheck === undefined) store.candidate = candidate; }
        if (owns()) schedulePoll();
      } catch (error) { if (owns()) store.error = message(error); }
    },
    async check() {
      if (!store.scope || !store.sourceId) return; const scope = copy(store.scope), sourceId = store.sourceId, token = generation;
      const schedule = scope.kind === 'online' && store.schedule?.sourceId === sourceId ? store.schedule : null;
      clearPreview(); previewCheck = null; store.schedule = schedule; const preview = previewGeneration; store.busy = true;
      const intentId = crypto.randomUUID(); store.localCheckId = scope.kind === 'local' ? intentId : '';
      try { const result = await request({ scope, operation: 'check', sourceId, expectedSourceRevision: store.selectedSource?.revision ?? '0', expectedAssetVersion: store.assetVersion, intentId }); if (!previewCurrent(token, preview, scope, sourceId)) return;
        if (scope.kind === 'local') store.candidate = SyncCandidateViewSchema.parse(result); else { const accepted = SyncCheckAcceptedSchema.parse(result); previewCheck = accepted.checkId; await store.readCheck(accepted.checkId); }
      } catch (error) { if (previewCurrent(token, preview, scope, sourceId)) store.error = message(error); }
      finally { if (previewCurrent(token, preview, scope, sourceId)) { store.busy = false; store.localCheckId = ''; } }
    },
    localCheckId: '',
    async readCheck(checkId = store.checkStatus?.checkId) {
      if (!checkId || store.scope?.kind !== 'online') return; const scope = copy(store.scope), token = generation, preview = previewGeneration, sourceId = store.sourceId;
      try { const status = SyncCheckStatusSchema.parse(await request({ scope, operation: 'checkStatus', checkId })); if (!previewCurrent(token, preview, scope, sourceId)) return; store.checkStatus = status;
        if (status.candidateId && !store.candidate && (previewCheck === undefined || previewCheck === checkId)) { const candidate = SyncCandidateViewSchema.parse(await request({ scope, operation: 'candidate', candidateId: status.candidateId })); if (previewCurrent(token, preview, scope, sourceId) && !store.candidate && (previewCheck === undefined || previewCheck === checkId)) store.candidate = candidate; }
        const lookupRequest = ++lookupGeneration;
        try {
          const lookup = SyncCheckLookupSchema.parse(await request({ scope, operation: 'checks', sourceId })); if (!previewCurrent(token, preview, scope, sourceId) || lookupRequest !== lookupGeneration) return; observeLookup(lookup);
        } catch (error) { if (!previewCurrent(token, preview, scope, sourceId) || lookupRequest !== lookupGeneration) return; store.lookup = null; store.error = message(error); }
        schedulePoll();
      } catch (error) { if (previewCurrent(token, preview, scope, sourceId)) store.error = message(error); }
    },
    async cancel() { const checkId = store.localCheckId || store.checkStatus?.checkId; if (!store.scope || !checkId) return; const scope = copy(store.scope), token = generation, preview = previewGeneration; const result = await request({ scope, operation: 'cancel', checkId }); if (current(token, scope) && preview === previewGeneration && scope.kind === 'online') store.checkStatus = SyncCheckStatusSchema.parse(result); },
    selectDetailChange(changeId: string) {
      if (!store.candidate?.candidate.changes.some(change => change.changeId === changeId) || store.detailChangeId === changeId) return;
      detailGeneration++; store.detailChangeId = changeId; store.fixedDetails = {}; store.detailErrors = {};
    },
    async loadDetail(changeId: string, side: SyncFixedDetailRequest['side']) {
      if (!store.scope || !store.candidate) return; const scope = copy(store.scope), token = generation, preview = previewGeneration, sourceId = store.sourceId, candidate = store.candidate.candidate;
      if (!candidate.changes.some(change => change.changeId === changeId)) return;
      store.selectDetailChange(changeId); const reader = detailGeneration;
      const requestValue = { formatVersion: 1 as const, candidateId: candidate.id, candidateDigest: candidate.candidateDigest, changeId, side };
      const detailKey = `${candidate.id}:${changeId}:${side}`; if (detailOwner || store.fixedDetails[detailKey]) return;
      const owner = Symbol('fixed-detail'); detailOwner = owner;
      const owns = () => reader === detailGeneration && store.detailChangeId === changeId && previewCurrent(token, preview, scope, sourceId) && store.candidate?.candidate.id === candidate.id && store.candidate.candidate.candidateDigest === candidate.candidateDigest;
      store.detailBusy = [detailKey]; store.detailErrors = { ...store.detailErrors, [detailKey]: '' };
      try {
        const detail = SyncFixedDetailSchema.parse(await request({ scope, operation: 'detail', request: requestValue })); if (!owns()) return;
        const change = candidate.changes.find(change => change.changeId === changeId);
        if (!change || detail.candidateId !== candidate.id || detail.candidateDigest !== candidate.candidateDigest || detail.changeId !== changeId || detail.side !== side || detail.entityId !== change.entityId || detail.entityKind !== change.entityKind || detail.assetPath !== change.path || detail.fieldPath !== change.fieldPath) throw Error('SYNC_CANDIDATE_MISMATCH');
        store.fixedDetails = { ...store.fixedDetails, [detailKey]: detail };
      } catch (error) { if (owns()) store.detailErrors = { ...store.detailErrors, [detailKey]: message(error) }; }
      finally { if (detailOwner === owner) { detailOwner = undefined; store.detailBusy = []; } }
    },
    decide(entry: SyncDecisions['entries'][number]) { store.decisions = [...store.decisions.filter(d => d.changeId !== entry.changeId), entry]; store.keepConfirmed = false; },
    async apply() {
      if (!store.candidate && (store.receipt || store.intentId)) return; if (store.blockReason) throw Error(store.blockReason);
      const candidate = store.candidate!.candidate, decisions = SyncDecisionsSchema.parse({ formatVersion: 1, candidateDigest: candidate.candidateDigest, entries: store.decisions });
      const identity = JSON.stringify(['apply', candidate.id, candidate.candidateDigest, [...decisions.entries].sort((a,b) => a.changeId.localeCompare(b.changeId))]);
      await submit({ scope: copy(store.scope!), operation: 'apply', sourceId: candidate.sourceId, candidateId: candidate.id, candidateDigest: candidate.candidateDigest, decisions, expectedSourceRevision: candidate.stamp.sourceRevision, expectedAssetVersion: candidate.stamp.kind === 'online' ? candidate.stamp.assetVersion : '0', intentId: crypto.randomUUID() }, identity);
    },
    async rollback(history: SyncHistoryEntry) { if (!store.scope || store.applying) return; await submit({ scope: copy(store.scope), operation: 'rollback', sourceId: history.sourceId, historyId: history.id, expectedSourceRevision: store.sources.find(s => s.id === history.sourceId)?.revision ?? history.afterStamp.sourceRevision, expectedAssetVersion: store.assetVersion, intentId: crypto.randomUUID() }, `rollback:${history.id}`); },
    async reconcile() { const intent = intents.get(key(store.scope)); if (intent) await reconcile(intent); },
    async saveSource(source: SyncSource, expectedRevision: string) { if (!store.scope) return; const scope = copy(store.scope), token = generation, sourceId = store.sourceId; clearPreview(); const preview = previewGeneration; const saved = SyncSourceSchema.parse(await request({ scope, operation: 'saveSource', source, expectedRevision, expectedAssetVersion: store.assetVersion, intentId: crypto.randomUUID() })); if (current(token, scope)) { store.sources = [...store.sources.filter(s => s.id !== saved.id), saved]; if (previewCurrent(token, preview, scope, sourceId)) store.selectSource(saved.id); } },
    async saveSettings(value: Pick<SyncHostSettings, 'maxRedirects' | 'policy'>) { if (store.scope?.kind !== 'local') return; const scope = copy(store.scope), token = generation; const settings = SyncHostSettingsSchema.parse(await request({ scope, operation: 'saveSettings', ...value })); if (current(token, scope)) { store.settings = settings; clearPreview(); } },
    async configureTool(tool: 'git' | 'ssh') { if (store.scope?.kind !== 'local') return; const scope = copy(store.scope), token = generation; const settings = SyncHostSettingsSchema.parse(await request({ scope, operation: 'configureTools', tool })); if (current(token, scope)) store.settings = settings; },
    async saveSchedule(enabled: boolean, rule: SyncSource['schedule']['rule']) {
      if (store.scope?.kind !== 'online' || !store.schedule) return; const scope = copy(store.scope), token = generation, preview = previewGeneration, sourceId = store.sourceId, original = store.schedule; store.scheduleBusy = true; store.scheduleError = '';
      try { let result: SyncScheduleView;
        try { result = SyncScheduleViewSchema.parse(await request({ scope, operation: 'saveSchedule', sourceId, expectedSourceRevision: original.sourceRevision, expectedGeneration: original.generation, enabled, rule })); }
        catch { result = SyncScheduleViewSchema.parse(await request({ scope, operation: 'schedule', sourceId })); if (result.generation !== (BigInt(original.generation) + 1n).toString() || result.enabled !== enabled || result.subjectUserId !== scope.context.ownerId || JSON.stringify(result.rule) !== JSON.stringify(rule)) throw Error('SYNC_SCHEDULE_OUTCOME_UNKNOWN'); }
        if (previewCurrent(token, preview, scope, sourceId)) { store.schedule = result; store.sources = store.sources.map(s => s.id === sourceId ? { ...s, revision: result.sourceRevision, schedule: { enabled: result.enabled, rule: result.rule } } : s); store.candidate = null; }
      } catch (error) { if (previewCurrent(token, preview, scope, sourceId)) store.scheduleError = message(error); }
      finally { if (previewCurrent(token, preview, scope, sourceId)) store.scheduleBusy = false; }
    },
    async previewSchedule(rule: SyncSource['schedule']['rule']) { if (store.scope?.kind !== 'online' || !store.sourceId) return; const scope = copy(store.scope), token = generation, preview = previewGeneration, sourceId = store.sourceId; const result = SchedulePreviewSchema.parse(await request({ scope, operation: 'previewSchedule', sourceId, rule, afterUtc: new Date().toISOString() })); if (previewCurrent(token, preview, scope, sourceId)) store.preview = result; },
  });
  function schedulePoll() { stop(); if (store.visible && store.scope?.kind === 'online' && store.checkStatus && ['queued','running','waiting','cancelling'].includes(store.checkStatus.state)) timer = setTimeout(() => { void store.readCheck(); }, 1000); }
  return store;
}
