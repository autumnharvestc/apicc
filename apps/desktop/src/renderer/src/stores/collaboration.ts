import { reactive } from 'vue';
import type { ApiccApi } from '../../../shared/types.js';
import type { OnlineExecutionContext } from '../../../shared/online/execution.js';
import type { CollaborationInput, CollaborationResult } from '../../../shared/online/collaboration.js';
import type { CollaborationHistoryMetadata } from '@apicc/execution/client';
type HistoryQuery = Extract<CollaborationInput, { operation: 'history' }>['input'];
type HistoryRef = Extract<CollaborationInput, { operation: 'read-history' }>['input'];
type ResultOf<S extends CollaborationResult['stage']> = Extract<CollaborationResult, { stage: S }>;
type PublicationQuery = Extract<CollaborationInput, { operation: 'publications' }>['input'];
type GrantQuery = Omit<Extract<CollaborationInput, { operation: 'grants' }>['input'], 'publicationId'>;
type Grant = ResultOf<'grant'>['grant'];
interface CollaborationState {
  context: OnlineExecutionContext | null; visible: boolean; access: ResultOf<'access'>['access'] | null;
  error: string; busy: boolean; result: CollaborationResult | null; preview: ResultOf<'local' | 'server'> | null;
  history: CollaborationHistoryMetadata[]; historyCursor: string | null; historyBody: ResultOf<'history-body'>['history'] | null;
  publications: ResultOf<'publications'>['page']['items']; publicationsCursor: string | null;
  grants: ResultOf<'grants'>['page']['items']; grantsCursor: string | null; selectedPublicationId: string;
  grantRefreshRequired: boolean; grantBusy: boolean; grantPending: boolean;
  grantConstraints: ResultOf<'grants'>['page']['constraints'] | null;
  activate(context: OnlineExecutionContext): Promise<void>; close(): Promise<void>;
  reconcile(kind: 'publication' | 'grant'): Promise<void>;
  createGrant(audience: 'members' | 'external', durationMs: number, downloadAllowed: boolean): Promise<void>;
  grantCommand(command: 'copy' | 'rotate' | 'revoke', row: Grant): Promise<void>;
  setMock(publicationId: string, enabled: boolean, expectedRevision: number): Promise<void>;
  loadGrants(publicationId: string, input?: GrantQuery): Promise<void>; nextGrants(): Promise<void>;
  loadPublications(input?: PublicationQuery): Promise<void>; nextPublications(): Promise<void>;
  selectLocal(context: OnlineExecutionContext, source: Extract<CollaborationInput, { operation: 'preview-local' }>['source'], title: string): Promise<void>;
  selectOnline(input: Extract<CollaborationInput, { operation: 'preview-online' }>['input']): Promise<void>;
  confirmUpload(expectedId?: string): Promise<void>; confirmPublication(expectedId?: string): Promise<void>; cancelPreview(): Promise<void>;
  loadHistory(input?: HistoryQuery): Promise<void>; nextHistory(): Promise<void>; readHistory(input: HistoryRef): Promise<void>;
}
export function createCollaborationStore(api: Pick<ApiccApi, 'onlineCollaboration'>) {
  const errorCode = (error: unknown): string => {
    const message = error instanceof Error ? error.message : '';
    return message.match(/\b(?:execution-requires-https|collaboration-[a-z-]+|collaboration_[a-z_]+|PUBLICATION_[A-Z_]+|grant_revision_conflict|publication_revision_conflict|publication_deadline_exceeded|preview_expired|forbidden|publication_source_changed)\b/)?.[0] ?? 'collaboration-request-failed';
  };
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  let generation = 0;
  let grantGeneration = 0;
  let managementGeneration = 0;
  let historyQuery: HistoryQuery = {};
  let publicationQuery: Extract<CollaborationInput, { operation: 'publications' }>['input'] = {};
  let grantQuery: Omit<Extract<CollaborationInput, { operation: 'grants' }>['input'], 'publicationId'> = {};
  const stamp = (): { generation: number; context: string } => ({ generation, context: JSON.stringify(store.context) });
  const current = (value: ReturnType<typeof stamp>) => value.generation === generation && value.context === JSON.stringify(store.context);
  // Grant ownership survives selecting another preview, but never a session/context reset.
  const grantStamp = () => ({ generation: grantGeneration, context: JSON.stringify(store.context) });
  const grantCurrent = (value: ReturnType<typeof grantStamp>) => value.generation === grantGeneration && value.context === JSON.stringify(store.context);
  function clearFrames() { managementGeneration++; grantGeneration++; store.history = []; store.historyCursor = null; store.historyBody = null; store.publications = []; store.publicationsCursor = null; store.grants = []; store.grantsCursor = null; store.grantConstraints = null; store.grantRefreshRequired = false; store.grantBusy = false; store.grantPending = false; store.selectedPublicationId = ''; store.access = null; store.result = null; }
  async function owned(input: CollaborationInput, management?: number, operationCurrent?: () => boolean): Promise<CollaborationResult | undefined> {
    const token = stamp();
    const outcome = await (async () => { try { return { ok: true as const, value: await api.onlineCollaboration(input) }; } catch (error) { return { ok: false as const, error }; } })();
    if (!(operationCurrent ? operationCurrent() : current(token)) || management !== undefined && management !== managementGeneration) return;
    if (!outcome.ok) { store.error = errorCode(outcome.error); throw new Error(store.error); }
    return outcome.value;
  }
  async function confirm(operation: 'confirm-upload' | 'confirm-publication', expectedId?: string) {
    if (!expectedId || expectedId !== store.preview?.candidateId) throw new Error('collaboration-source-changed');
    if (store.busy) return;
    const token = generation, context = plain(store.context!); store.busy = true;
    try {
      const result = await api.onlineCollaboration({ operation, context, candidateId: expectedId });
      if (token !== generation) return;
      if (operation === 'confirm-upload') store.preview = result as ResultOf<'local' | 'server'>;
      else { store.result = result; store.preview = null; }
    } catch (error) {
      if (token === generation) { store.preview = null; store.error = errorCode(error); }
      throw new Error(errorCode(error));
    } finally { if (token === generation) store.busy = false; }
  }
  const store: CollaborationState = reactive({
    context: null as OnlineExecutionContext | null,
    visible: false,
    async activate(context: OnlineExecutionContext) {
      generation++; clearFrames(); store.preview = null; store.context = plain(context); store.visible = true;
      const token = stamp();
      store.error = '';
      try {
      await owned({ operation: 'activate', context: plain(context) });
      if (!current(token)) return;
      const result = await owned({ operation: 'access', context: plain(context), input: {} });
      if (!result || !current(token)) return;
      store.access = (result as Extract<CollaborationResult, { stage: 'access' }>).access;
      if (store.access.capabilities.includes('history.read')) await store.loadHistory();
      if (!current(token)) return;
      await store.loadPublications();
      } catch { /* The visible collaboration panel owns finite localized recovery. */ }
    },
    async close() { store.visible = false; await store.cancelPreview(); },
    access: null as Extract<CollaborationResult, { stage: 'access' }>['access'] | null,
    error: '', busy: false, result: null as CollaborationResult | null,
    preview: null as Extract<CollaborationResult, { stage: 'local' | 'server' }> | null,
    history: [] as CollaborationHistoryMetadata[], historyCursor: null as string | null,
    historyBody: null as Extract<CollaborationResult, { stage: 'history-body' }>['history'] | null,
    publications: [] as Extract<CollaborationResult, { stage: 'publications' }>['page']['items'],
    publicationsCursor: null as string | null,
    grants: [] as Extract<CollaborationResult, { stage: 'grants' }>['page']['items'],
    grantsCursor: null as string | null,
    selectedPublicationId: '',
    grantRefreshRequired: false, grantBusy: false, grantPending: false,
    async reconcile(kind: 'publication' | 'grant') {
      if (kind === 'grant' && store.grantBusy) return;
      const token = kind === 'grant' ? grantStamp() : stamp();
      const isCurrent = () => kind === 'grant' ? grantCurrent(token) : current(token);
      if (kind === 'grant') store.grantBusy = true;
      try {
      const result = await owned({ operation: `reconcile-${kind}`, context: plain(store.context!) }, undefined, isCurrent);
      if (result) { store.result = result; if (kind === 'grant') { store.grantPending = false; store.grantRefreshRequired = true; } }
      } finally { if (isCurrent() && kind === 'grant') store.grantBusy = false; }
    },
    async createGrant(audience: 'members' | 'external', durationMs: number, downloadAllowed: boolean) {
      if (store.grantBusy || store.grantPending) return;
      if (!Number.isSafeInteger(durationMs) || durationMs < 60000 || durationMs > store.grantConstraints!.maxShareDurationMs.value) { store.error = 'collaboration-grant-input-invalid'; throw new Error(store.error); }
      const publication = store.publications.find(row => row.id === store.selectedPublicationId)!;
      const token = grantStamp(); store.grantBusy = true;
      try {
      const result = await owned({ operation: 'create-grant', context: plain(store.context!), input: { publicationId: publication.id, purpose: publication.kind === 'mock' ? 'call' : 'view', audience, downloadAllowed, expectedRevision: publication.revision, durationMs } }, managementGeneration, () => grantCurrent(token));
      if (!result) return; store.result = result;
      if (store.result.stage === 'grant') store.grants = [store.result.grant, ...store.grants.filter(row => row.id !== (store.result as Extract<CollaborationResult, { stage: 'grant' }>).grant.id)];
      } catch (error) { if (grantCurrent(token) && errorCode(error) === 'collaboration-grant-pending') store.grantPending = true; throw error; }
      finally { if (grantCurrent(token)) store.grantBusy = false; }
    },
    grantConstraints: null as Extract<CollaborationResult, { stage: 'grants' }>['page']['constraints'] | null,
    async grantCommand(command: 'copy' | 'rotate' | 'revoke', row: Extract<CollaborationResult, { stage: 'grant' }>['grant']) {
      if (command === 'rotate' && (store.grantBusy || store.grantPending)) return;
      const token = command === 'rotate' ? grantStamp() : stamp();
      const isCurrent = () => command === 'rotate' ? grantCurrent(token) : current(token);
      if (command === 'rotate') store.grantBusy = true;
      try {
      const input = command === 'copy' ? { grantId: row.id } : { grantId: row.id, expectedRevision: row.revision };
      const result = await owned({ operation: `${command}-grant`, context: plain(store.context!), input } as CollaborationInput, managementGeneration, isCurrent);
      if (!result) return; store.result = result;
      if (store.result.stage === 'grant') store.grants = store.grants.map(value => value.id === row.id ? (store.result as Extract<CollaborationResult, { stage: 'grant' }>).grant : value);
      else if (store.result.stage === 'revoked') { store.grants = []; store.grantsCursor = null; store.grantConstraints = null; store.grantRefreshRequired = true; }
      } catch (error) { if (isCurrent() && errorCode(error) === 'collaboration-grant-pending') store.grantPending = true; throw error; }
      finally { if (isCurrent() && command === 'rotate') store.grantBusy = false; }
    },
    async setMock(publicationId: string, enabled: boolean, expectedRevision: number) {
      const result = await owned({ operation: 'set-mock', context: plain(store.context!), input: { publicationId, enabled, expectedRevision } }); if (!result) return; store.result = result;
      if (result.stage === 'published') store.publications = store.publications.map(row => row.id === publicationId ? { ...row, enabled: result.publication.enabled, revision: result.publication.revision } : row);
    },
    async loadGrants(publicationId: string, input: typeof grantQuery = {}) {
      if (store.selectedPublicationId !== publicationId) { managementGeneration++; store.grants = []; store.grantsCursor = null; store.grantConstraints = null; store.grantRefreshRequired = false; store.result = null; }
      store.selectedPublicationId = publicationId; grantQuery = plain(input);
      const token = stamp();
      const result = await owned({ operation: 'grants', context: plain(store.context!), input: { publicationId, ...plain(input) } }, managementGeneration);
      if (!result || !current(token) || store.selectedPublicationId !== publicationId) return;
      const page = (result as Extract<CollaborationResult, { stage: 'grants' }>).page;
      store.grants = page.items; store.grantConstraints = page.constraints;
      store.grantsCursor = page.nextCursor; store.grantRefreshRequired = false;
    },
    async nextGrants() { await store.loadGrants(store.selectedPublicationId, { ...grantQuery, cursor: store.grantsCursor! }); },
    async loadPublications(input: typeof publicationQuery = {}) {
      publicationQuery = plain(input);
      const result = await owned({ operation: 'publications', context: plain(store.context!), input: plain(input) });
      if (!result) return;
      const page = (result as Extract<CollaborationResult, { stage: 'publications' }>).page; store.publications = page.items; store.publicationsCursor = page.nextCursor;
    },
    async nextPublications() { await store.loadPublications({ ...publicationQuery, cursor: store.publicationsCursor! }); },
    async selectLocal(context: OnlineExecutionContext, source: Extract<CollaborationInput, { operation: 'preview-local' }>['source'], title: string) {
      if (JSON.stringify(store.context) !== JSON.stringify(context)) clearFrames();
      const token = ++generation; store.context = plain(context); store.preview = null; store.error = ''; store.busy = false;
      try { const result = await api.onlineCollaboration({ operation: 'preview-local', context: plain(context), source: plain(source), title }); if (token === generation) store.preview = result as ResultOf<'local' | 'server'>; }
      catch (error) { if (token === generation) store.error = errorCode(error); throw new Error(errorCode(error)); }
    },
    async confirmUpload(expectedId = store.preview?.candidateId) { await confirm('confirm-upload', expectedId); },
    async selectOnline(input: Extract<CollaborationInput, { operation: 'preview-online' }>['input']) {
      const token = ++generation; store.preview = null; store.error = '';
      const result = await owned({ operation: 'preview-online', context: plain(store.context!), input: plain(input) });
      if (result && token === generation) store.preview = result as ResultOf<'local' | 'server'>;
    },
    async confirmPublication(expectedId = store.preview?.candidateId) { await confirm('confirm-publication', expectedId); },
    async cancelPreview() {
      generation++; store.preview = null; store.busy = false; await api.onlineCollaboration({ operation: 'cancel-preview', context: plain(store.context!) });
    },
    async loadHistory(input: HistoryQuery = {}) {
      const token = stamp();
      historyQuery = plain(input);
      const result = await owned({ operation: 'history', context: plain(store.context!), input: plain(input) });
      if (!result || !current(token)) return;
      const value = result as Extract<CollaborationResult, { stage: 'history' }>;
      store.history = value.page.items; store.historyCursor = value.page.nextCursor;
    },
    async nextHistory() { await store.loadHistory({ ...historyQuery, cursor: store.historyCursor! }); },
    async readHistory(input: HistoryRef) {
      const token = stamp();
      const result = await owned({ operation: 'read-history', context: plain(store.context!), input: plain(input) });
      if (!result || !current(token)) return;
      store.historyBody = (result as Extract<CollaborationResult, { stage: 'history-body' }>).history;
    },
  } as object) as CollaborationState;
  return store;
}
export type CollaborationStore = ReturnType<typeof createCollaborationStore>;
