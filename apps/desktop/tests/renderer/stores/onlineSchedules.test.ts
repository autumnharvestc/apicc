// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createOnlineStore } from '../../../src/renderer/src/stores/online.js';
import { createOnlineSchedulesStore } from '../../../src/renderer/src/stores/onlineSchedules.js';
import type { ApiccApi } from '../../../src/shared/types.js';
import { scheduleContext as context, scheduleOptions, scheduleView, schedulePreparation } from '../../helpers/scheduling.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotificationPageSchema } from '@apicc/execution/contract';
const other = { ...context, ownerId: '8', scope: { ...context.scope, projectId: '44' } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

// Break caught: an older project response replaces the currently selected project's list.
it('ignores late project list data after another context has loaded', async () => {
  const late = deferred<unknown>();
  const store = createOnlineSchedulesStore({ onlineScheduling: async input => {
    if (input.operation === 'options') return scheduleOptions();
    if (input.operation === 'list') return input.context.ownerId === '7' ? late.promise : { items: [], nextBeforeId: null };
    throw Error('unexpected');
  } });
  const a = store.load(context); await Promise.resolve(); await store.load(other);
  late.resolve({ items: [scheduleView()], nextBeforeId: null }); await a;
  expect(store.context).toEqual(other); expect(store.items).toEqual([]);
});

// Break caught: the real online store's execution activation leaves another owner's schedules visible.
it('clears schedules on the real online activation/logout lifecycle', async () => {
  const api = { onlineScheduling: async (input: any) => input.operation === 'options' ? scheduleOptions() : { items: [scheduleView()], nextBeforeId: null } } as unknown as ApiccApi;
  const online = createOnlineStore({ api }); online.execution.activate(context); online.execution.setVisible(true);
  await online.schedules.load(context); expect(online.schedules.items).toHaveLength(1);
  online.execution.activate(null);
  expect(online.schedules.items).toEqual([]); expect(online.schedules.options).toBeNull(); expect(online.schedules.context).toBeNull();
  online.execution.setVisible(false);
});

// Break caught: the old saved preparation may be POSTed after the project/owner changes.
it('does not save after an old preparation resolves in a changed context', async () => {
  const late = deferred<unknown>(); const persisted: unknown[] = [];
  const store = createOnlineSchedulesStore({ onlineScheduling: async input => {
    if (input.operation === 'options') return scheduleOptions();
    if (input.operation === 'list') return { items: [], nextBeforeId: null };
    if (input.operation === 'prepare') return late.promise;
    if (input.operation === 'save') { persisted.push(input); return scheduleView(); }
    throw Error('unexpected');
  } });
  await store.load(context);
  const { name, rule, policies, notifications, execution } = scheduleView();
  const pending = store.create({ name, rule, policies, notifications }, { context, expectedVersion: '1', agentId: '5', target: execution.target, runConfig: {}, materials: { projectId: '33', attachments: [] } });
  await store.load(other); late.resolve(schedulePreparation()); await pending;
  expect(persisted).toEqual([]); expect(store.items).toEqual([]); expect(store.error).toBe('');
});

it('uses canManageSchedules independently and refuses a direct unauthorized save', async () => {
  const persisted: unknown[] = [];
  const store = createOnlineSchedulesStore({ onlineScheduling: async input => {
    if (input.operation === 'options') return scheduleOptions(false);
    if (input.operation === 'list') return { items: [], nextBeforeId: null };
    if (input.operation === 'save') persisted.push(input);
    return input.operation === 'prepare' ? schedulePreparation() : scheduleView();
  } });
  await store.load(context);
  const { name, rule, policies, notifications, execution } = scheduleView();
  await store.create({ name, rule, policies, notifications }, { context, expectedVersion: '1', agentId: '5', target: execution.target, runConfig: {}, materials: { projectId: '33', attachments: [] } });
  expect(persisted).toEqual([]); expect(store.error).toBe('schedule-permission-denied');
});

it('keeps the newest schedule selection when an older detail lookup completes late', async () => {
  const late = deferred<unknown>();
  const store = createOnlineSchedulesStore({ onlineScheduling: async input => {
    if (input.operation === 'options') return scheduleOptions();
    if (input.operation === 'list') return { items: [], nextBeforeId: null };
    if (input.operation === 'detail') return input.id === '9007199254740993' ? late.promise : { ...scheduleView(), id: '9007199254740994', name: 'Latest selection' };
    throw Error('unexpected');
  } });
  await store.load(context); const a = store.inspect('9007199254740993'); await store.inspect('9007199254740994'); late.resolve(scheduleView()); await a;
  expect(store.selected!.name).toBe('Latest selection');
});

it('silently discards a failed old detail request after context activation changes', async () => {
  let reject!: (error: Error) => void; const late = new Promise<unknown>((_, fail) => { reject = fail; });
  const store = createOnlineSchedulesStore({ onlineScheduling: async input => input.operation === 'options' ? scheduleOptions() : input.operation === 'list' ? { items: [], nextBeforeId: null } : late });
  await store.load(context); const outcome = store.inspect('9007199254740993').then(() => 'fulfilled', () => 'rejected');
  store.activate(other); reject(Error('old-project-error'));
  expect(await outcome).toBe('fulfilled'); expect(store.error).toBe(''); expect(store.selected).toBeNull();
});

it('clears history and refresh facts from the previous selected schedule', async () => {
  const id = scheduleView().id;
  const store = createOnlineSchedulesStore({ onlineScheduling: async input => {
    if (input.operation === 'options') return scheduleOptions();
    if (input.operation === 'list') return { items: [], nextBeforeId: null };
    if (input.operation === 'detail') return { ...scheduleView(), id: input.id };
    if (input.operation === 'prepare') return schedulePreparation();
    if (input.operation === 'history') return { workspaceId: '11', projectId: '33', scheduleId: id, evaluationStatus: 'paused', pausedReasonCode: null, evaluatedThroughUtc: null, lastAdmittedPlannedAtUtc: null, items: [], nextBeforeId: null, missedWindows: [], nextMissedBeforeId: null };
    if (input.operation === 'notificationHistory') return { workspaceId: '11', projectId: '33', scheduleId: id, items: [], nextBeforeId: null, sources: [], nextSourceBeforeId: null, pauseSource: null };
    throw Error('unexpected');
  } });
  await store.load(context); await store.inspect(id); await store.loadHistory(); await store.loadNotificationHistory();
  await store.prepareRefresh({ context, expectedVersion: '1', agentId: '5', target: scheduleView().execution.target, runConfig: {}, materials: { projectId: '33', attachments: [] } });
  expect(store.refreshCandidate).not.toBeNull(); await store.inspect('9007199254740994');
  expect.soft(store.history).toBeNull(); expect.soft(store.notificationHistory).toBeNull(); expect(store.refreshCandidate).toBeNull();
});

it('releases the prior busy intent when the same project view reloads during a save', async () => {
  const late = deferred<unknown>();
  const store = createOnlineSchedulesStore({ onlineScheduling: async input => input.operation === 'options' ? scheduleOptions() : input.operation === 'list' ? { items: [], nextBeforeId: null } : input.operation === 'prepare' ? schedulePreparation() : late.promise });
  await store.load(context); const { name, rule, policies, notifications, execution } = scheduleView();
  const pending = store.create({ name, rule, policies, notifications }, { context, expectedVersion: '1', agentId: '5', target: execution.target, runConfig: {}, materials: { projectId: '33', attachments: [] } });
  await Promise.resolve(); expect(store.busy).toBe(true); await store.load(context); late.resolve(scheduleView()); await pending;
  expect(store.busy).toBe(false);
});
it('clears a prior error when the current project reload succeeds', async () => {
  let fail = true;
  const store = createOnlineSchedulesStore({ onlineScheduling: async input => { if (input.operation === 'options') { if (fail) throw Error('temporary-connection-failure'); return scheduleOptions(); } return { items: [], nextBeforeId: null }; } });
  await store.load(context); expect(store.error).toBe('temporary-connection-failure'); fail = false; await store.load(context); expect(store.error).toBe('');
});

function notificationPage(name = 'Original notification', cursor: string | null = '6') {
  const capture = JSON.parse(readFileSync(resolve('../../server/src/test/resources/notifications/center.json'), 'utf8'));
  return NotificationPageSchema.parse({ items: capture.items.map((event: any) => ({ ...event, workspaceId: '11', projectId: '33', link: '/workspaces/11/projects/33/schedules/6', scheduleName: name })), nextBeforeId: cursor });
}
// Break caught: a list collected before a successful read acknowledgement can revert it.
it('round1 notification preserves a successful member read acknowledgement after an earlier list returns', async () => {
  expect(process.versions.node).toBe('22.19.0');
  const late = deferred<unknown>();
  const store = createOnlineSchedulesStore({ onlineScheduling: async input => input.operation === 'markNotificationRead' ? { id: input.id, read: true } : late.promise });
  store.activate(context); store.notifications = notificationPage();
  const pending = store.loadNotifications(); await store.markRead('6');
  expect(store.notifications!.items[0]!.read).toBe(true);
  late.resolve(notificationPage()); await pending;
  expect(store.notifications!.items[0]!.read).toBe(true);
});

// Break caught: refresh must supersede both earlier refresh and earlier paging intents.
it.each([undefined, '6'])('round1 notification keeps the newest refresh instead of an older cursor %s', async beforeId => {
  const old = deferred<unknown>(); const latest = deferred<unknown>(); let requests = 0;
  const store = createOnlineSchedulesStore({ onlineScheduling: async () => ++requests === 1 ? old.promise : latest.promise });
  store.activate(context); store.notifications = notificationPage('Original');
  const pending = store.loadNotifications(beforeId); const current = store.loadNotifications();
  latest.resolve(notificationPage('Newest notification', '4')); await current;
  old.resolve(notificationPage('Obsolete notification', '5')); await pending;
  expect(store.notifications!.items.map(event => event.scheduleName)).toEqual(['Newest notification']);
  expect(store.notifications!.nextBeforeId).toBe('4');
});

// Existing scope generation is a baseline; a future read-fact cache must not weaken it.
it('round1 notification does not carry member read facts or a late acknowledgement into another scope', async () => {
  const ack = deferred<unknown>(); let delayed = false;
  const store = createOnlineSchedulesStore({ onlineScheduling: async input => input.operation === 'markNotificationRead' ? delayed ? ack.promise : { id: input.id, read: true } : notificationPage() });
  store.activate(context); store.notifications = notificationPage(); await store.markRead('6');
  expect(store.notifications.items[0]!.read).toBe(true);
  delayed = true; const pending = store.markRead('6'); store.activate(other); await store.loadNotifications();
  ack.resolve({ id: '6', read: true }); await pending;
  expect(store.notifications!.items[0]!.read).toBe(false);
});
