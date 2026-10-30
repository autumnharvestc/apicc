import { shallowReactive } from 'vue';
import { ScheduleOptionsSchema, SchedulePageSchema, ScheduleViewSchema, type ScheduleOptions, type ScheduleView, type ScheduleSave } from '@apicc/execution/contract';
import { OnlineSchedulePreparationSchema, type OnlineSchedulingPort, type OnlineSchedulePreparationInput } from '../../../shared/online/scheduling.js';
import type { OnlineExecutionContext } from '../../../shared/online/execution.js';
import { SchedulePreviewSchema, type ScheduleRule, type ScheduleUpdate } from '@apicc/execution/contract';
import { ScheduleHistoryPageSchema, type ScheduleHistoryPage } from '@apicc/execution/contract';
import { NotificationPageSchema, NotificationHistoryPageSchema, NotificationReadSchema, type NotificationPage, type NotificationHistoryPage } from '@apicc/execution/contract';
import { ScheduleMaterialOptionsSchema } from '@apicc/execution/contract';
import type { OnlineSchedulePreparation } from '../../../shared/online/scheduling.js';
import { OnlineOriginalJobIdentitySchema } from '../../../shared/online/scheduling.js';

export function createOnlineSchedulesStore(api: OnlineSchedulingPort) {
  let generation = 0;
  let selectionGeneration = 0;
  let previewGeneration = 0; let refreshGeneration = 0;
  let notificationGeneration = 0;
  const acknowledgedReads = new Set<string>();
  const key = (context: OnlineExecutionContext | null) => JSON.stringify(context);
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const current = (token: number, context: OnlineExecutionContext) => token === generation && store.visible && key(context) === key(store.context);
  const store = shallowReactive({
    context: null as OnlineExecutionContext | null, visible: false, options: null as ScheduleOptions | null, items: [] as ScheduleView[], selected: null as ScheduleView | null, busy: false, error: '',
    previewResult: null as import('zod').z.infer<typeof SchedulePreviewSchema> | null,
    history: null as ScheduleHistoryPage | null,
    notifications: null as NotificationPage | null, notificationHistory: null as NotificationHistoryPage | null,
    nextBeforeId: null as string | null, materialOptions: null as import('zod').z.infer<typeof ScheduleMaterialOptionsSchema> | null,
    refreshCandidate: null as { preparation: OnlineSchedulePreparation; id: string; version: string } | null,
    async originalJob(context: OnlineExecutionContext, jobId: string, executionId: string) {
      return OnlineOriginalJobIdentitySchema.parse(await api.onlineScheduling({ operation: 'originalJob', context, jobId, executionId }));
    },
    activate(context: OnlineExecutionContext | null, visible = true) {
      if (key(context) === key(store.context) && visible === store.visible) return;
      generation++; store.context = context ? plain(context) : null; store.visible = visible;
      notificationGeneration++; acknowledgedReads.clear();
      store.options = null; store.items = []; store.selected = null; store.error = ''; store.busy = false;
      store.previewResult = null; store.refreshCandidate = null;
      store.history = null;
      store.notifications = null; store.notificationHistory = null;
      store.nextBeforeId = null; store.materialOptions = null;
    },
    async load(context: OnlineExecutionContext) {
      store.activate(context); const token = ++generation;
      store.busy = false; store.error = '';
      try {
        const options = ScheduleOptionsSchema.parse(await api.onlineScheduling({ operation: 'options', context }));
        if (!current(token, context)) return;
        store.options = options;
        const page = SchedulePageSchema.parse(await api.onlineScheduling({ operation: 'list', context, limit: 25 }));
        if (current(token, context)) { store.items = page.items; store.nextBeforeId = page.nextBeforeId; }
      } catch (error) { if (current(token, context)) store.error = error instanceof Error ? error.message : String(error); }
    },
    async loadMore() {
      const context = store.context && plain(store.context); const beforeId = store.nextBeforeId; if (!context || !beforeId) return; const token = generation;
      try { const page = SchedulePageSchema.parse(await api.onlineScheduling({ operation: 'list', context, limit: 25, beforeId })); if (current(token, context)) { store.items = [...store.items, ...page.items]; store.nextBeforeId = page.nextBeforeId; } }
      catch (error) { if (current(token, context)) store.error = error instanceof Error ? error.message : String(error); }
    },
    async loadMaterialOptions() {
      const context = store.context && plain(store.context); if (!context) return; const token = generation;
      try { const result = ScheduleMaterialOptionsSchema.parse(await api.onlineScheduling({ operation: 'materialOptions', context })); if (current(token, context)) store.materialOptions = result; }
      catch (error) { if (current(token, context)) store.error = error instanceof Error ? error.message : String(error); }
    },
    async remove() {
      const context = store.context && plain(store.context); const row = store.selected; if (!context || !row) return; const token = generation;
      if (!store.options?.canManageSchedules) { store.error = 'schedule-permission-denied'; return; }
      try { await api.onlineScheduling({ operation: 'remove', context, id: row.id, expectedVersion: row.version }); if (current(token, context)) { store.items = store.items.filter(item => item.id !== row.id); if (store.selected?.id === row.id) { store.selected = null; store.history = null; store.notificationHistory = null; store.refreshCandidate = null; } } }
      catch (error) { if (current(token, context)) store.error = error instanceof Error ? error.message : String(error); }
    },
    async inspect(id: string) {
      const context = store.context && plain(store.context); if (!context) return;
      store.clearSelection(); const token = generation; const selection = selectionGeneration;
      try {
        const row = ScheduleViewSchema.parse(await api.onlineScheduling({ operation: 'detail', context, id }));
        if (current(token, context) && selection === selectionGeneration) store.selected = row;
      } catch (error) { if (current(token, context) && selection === selectionGeneration) store.error = error instanceof Error ? error.message : String(error); }
    },
    clearSelection() { selectionGeneration++; store.selected = null; store.history = null; store.notificationHistory = null; store.invalidateRefresh(); store.invalidatePreview(); },
    invalidateRefresh() { refreshGeneration++; store.refreshCandidate = null; },
    invalidatePreview() { previewGeneration++; store.previewResult = null; },
    async loadHistory(paging: { beforeId?: string; missedBeforeId?: string } = {}) {
      const row = store.selected; const context = store.context && plain(store.context); if (!row || !context) return;
      const token = generation;
      try {
        const result = ScheduleHistoryPageSchema.parse(await api.onlineScheduling({ operation: 'history', context, id: row.id, limit: 25, ...paging }));
        if (current(token, context) && store.selected?.id === row.id) {
          const prior = store.history;
          store.history = prior && paging.beforeId ? { ...result, items: [...prior.items, ...result.items], missedWindows: prior.missedWindows, nextMissedBeforeId: prior.nextMissedBeforeId } : prior && paging.missedBeforeId ? { ...result, items: prior.items, nextBeforeId: prior.nextBeforeId, missedWindows: [...prior.missedWindows, ...result.missedWindows] } : result;
        }
      }
      catch (error) { if (current(token, context)) store.error = error instanceof Error ? error.message : String(error); }
    },
    async loadNotifications(beforeId?: string) {
      const context = store.context && plain(store.context); if (!context) return;
      const token = generation; const intent = ++notificationGeneration;
      try {
        const page = NotificationPageSchema.parse(await api.onlineScheduling({ operation: 'notifications', context, limit: 25, ...(beforeId ? { beforeId } : {}) }));
        if (current(token, context) && intent === notificationGeneration) {
          const items = page.items.map(event => acknowledgedReads.has(event.id) ? { ...event, read: true } : event);
          store.notifications = { ...page, items: beforeId && store.notifications ? [...store.notifications.items, ...items] : items };
        }
      } catch (error) { if (current(token, context) && intent === notificationGeneration) store.error = error instanceof Error ? error.message : String(error); }
    },
    async markRead(id: string) {
      const context = store.context && plain(store.context); if (!context) return;
      const token = generation;
      try {
        const result = NotificationReadSchema.parse(await api.onlineScheduling({ operation: 'markNotificationRead', context, id }));
        if (current(token, context)) {
          acknowledgedReads.add(result.id);
          if (store.notifications) store.notifications = { ...store.notifications, items: store.notifications.items.map(event => event.id === result.id ? { ...event, read: true } : event) };
        }
      }
      catch (error) { if (current(token, context)) store.error = error instanceof Error ? error.message : String(error); }
    },
    async loadNotificationHistory(paging: { beforeId?: string; sourceBeforeId?: string } = {}) {
      const row = store.selected; const context = store.context && plain(store.context); if (!row || !context) return;
      const token = generation;
      try {
        const page = NotificationHistoryPageSchema.parse(await api.onlineScheduling({ operation: 'notificationHistory', context, id: row.id, limit: 25, ...paging }));
        if (current(token, context) && store.selected?.id === row.id) {
          const prior = store.notificationHistory;
          store.notificationHistory = prior && paging.beforeId ? { ...prior, items: [...prior.items, ...page.items], nextBeforeId: page.nextBeforeId, pauseSource: page.pauseSource } : prior && paging.sourceBeforeId ? { ...prior, sources: [...prior.sources, ...page.sources], nextSourceBeforeId: page.nextSourceBeforeId, pauseSource: page.pauseSource } : page;
        }
      }
      catch (error) { if (current(token, context)) store.error = error instanceof Error ? error.message : String(error); }
    },
    async preview(rule: ScheduleRule) {
      const context = store.context && plain(store.context); if (!context) return;
      const token = generation; const intent = ++previewGeneration; store.previewResult = null; store.error = '';
      try { const result = SchedulePreviewSchema.parse(await api.onlineScheduling({ operation: 'preview', context, input: { rule: plain(rule), afterUtc: new Date().toISOString() } })); if (current(token, context) && intent === previewGeneration) store.previewResult = result; }
      catch (error) { if (current(token, context) && intent === previewGeneration) store.error = error instanceof Error ? error.message : String(error); }
    },
    async update(patch: Omit<ScheduleUpdate, 'expectedVersion'>) {
      const context = store.context && plain(store.context); const row = store.selected; if (!context || !row) return;
      const token = generation; if (!current(token, context)) return;
      if (!store.options?.canManageSchedules) { store.error = 'schedule-permission-denied'; return; }
      store.busy = true; store.error = '';
      try {
        const result = ScheduleViewSchema.parse(await api.onlineScheduling({ operation: 'update', context, id: row.id, input: { ...plain(patch), expectedVersion: row.version } }));
        if (current(token, context) && store.selected?.id === row.id && store.selected.version === row.version) { store.selected = result; store.items = store.items.map(item => item.id === result.id ? result : item); store.refreshCandidate = null; }
      } catch (error) { if (current(token, context)) store.error = error instanceof Error ? error.message : String(error); }
      finally { if (current(token, context)) store.busy = false; }
    },
    async prepareRefresh(input: OnlineSchedulePreparationInput) {
      const row = store.selected; const context = store.context && plain(store.context); if (!row || !context) return;
      const token = generation; const intent = ++refreshGeneration; store.refreshCandidate = null; store.error = '';
      if (!store.options?.canManageSchedules) { store.error = 'schedule-permission-denied'; return; }
      try {
        const { context: _, ...preparation } = input;
        const result = OnlineSchedulePreparationSchema.parse(await api.onlineScheduling({ operation: 'prepare', context, input: { ...plain(preparation), previous: { execution: row.execution, snapshotVersion: row.snapshotVersion, manifestHash: row.manifestHash } } }));
        if (current(token, context) && intent === refreshGeneration && store.selected?.id === row.id && store.selected.version === row.version) store.refreshCandidate = { preparation: result, id: row.id, version: row.version };
      } catch (error) { if (current(token, context) && intent === refreshGeneration) store.error = error instanceof Error ? error.message : String(error); }
    },
    async confirmRefresh() {
      const candidate = store.refreshCandidate; if (!candidate || candidate.id !== store.selected?.id || candidate.version !== store.selected.version) return;
      await store.update({ execution: candidate.preparation.execution, refreshExecution: true });
    },
    async create(input: Omit<ScheduleSave, 'execution'>, preparation: OnlineSchedulePreparationInput) {
      const context = plain(preparation.context); const token = generation;
      if (!current(token, context)) return;
      if (!store.options?.canManageSchedules) { store.error = 'schedule-permission-denied'; return; }
      store.busy = true; store.error = '';
      try {
        const { context: _, ...prepareInput } = preparation;
        const prepared = OnlineSchedulePreparationSchema.parse(await api.onlineScheduling({ operation: 'prepare', context, input: prepareInput }));
        if (!current(token, context)) return;
        const result = ScheduleViewSchema.parse(await api.onlineScheduling({ operation: 'save', context, input: { ...input, execution: prepared.execution } }));
        if (current(token, context)) store.items = [result, ...store.items];
      } catch (error) { if (current(token, context)) store.error = error instanceof Error ? error.message : String(error); }
      finally { if (current(token, context)) store.busy = false; }
    },
  });
  return store;
}
export type OnlineSchedulesStore = ReturnType<typeof createOnlineSchedulesStore>;
