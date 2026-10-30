// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContractWorkspaceSchema } from '@apicc/core/schema';
import { workspaceFixture } from '../../../../../packages/core/tests/helpers/contractFixtures.js';
import { createOnlineStore } from '../../../src/renderer/src/stores/online.js';
import { createOnlineProjectAdapter } from '../../../src/renderer/src/stores/onlineProjectAdapter.js';
import OnlineProjectAssets from '../../../src/renderer/src/components/online/OnlineProjectAssets.vue';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import type { ApiccApi } from '../../../src/shared/types.js';
import { scheduleContext as context } from '../../helpers/scheduling.js';
import { NotificationPageSchema } from '@apicc/execution/contract';
import { NotificationDeliverySchema } from '@apicc/execution/contract';
import OnlineDeliveryList from '../../../src/renderer/src/components/online/OnlineDeliveryList.vue';
enableAutoUnmount(afterEach);
it.each([
  ['network-error','通知网络连接失败','Notification network connection failed'],['timeout','通知请求总时限已过','Notification request deadline exceeded'],
  ['transport-busy','通知传输容量已满','Notification transport capacity is full'],['http-retryable','通知端点暂时失败（可重试状态）','Notification endpoint temporarily failed (retryable status)'],
  ['http-terminal','通知端点拒绝投递，不再重试','Notification endpoint rejected delivery; no retry'],['response-too-large','通知响应超过读取上限','Notification response exceeded the read limit'],
] as const)('explains actual outbound reason %s in notification center in both languages',async(reasonCode,zh,en)=>{
  const f=fixture();
  try{
    await f.view.findAll('nav.tabs button').find(b=>b.text()==='通知中心')!.trigger('click');await flushPromises();const page=f.online.schedules.notifications!;
    f.online.schedules.notifications=NotificationPageSchema.parse({...page,items:page.items.map(event=>({...event,deliveries:event.deliveries.map(d=>({...d,reasonCode,status:302,attempts:1}))}))});await flushPromises();
    const text=()=>f.view.get('.notifications').text();expect(text()).toContain(zh);expect(text()).toContain('HTTP 302');expect(text()).not.toContain(reasonCode);
    f.i18n.global.locale.value='en';await flushPromises();expect(text()).toContain(en);expect(text()).toContain('HTTP 302');expect(text()).not.toContain(reasonCode);
  }finally{f.execution.setVisible(false);}
});
// Missing producer reasons must not leak internal codes into either business view.
const terminalReasons = [
  ['intent_source_conflict', '任务来源冲突', 'Job source conflict'], ['credential_unavailable', '凭据不可用', 'Credential unavailable'],
  ['snapshot_version_conflict', '快照版本冲突', 'Snapshot version conflict'],
  ['execution-passed', '执行通过', 'Execution passed'], ['execution-failed', '执行失败', 'Execution failed'],
  ['execution-abnormal', '执行异常', 'Execution abnormal'], ['schedule-skipped', '计划触发已跳过', 'Scheduled trigger skipped'],
  ['schedule-rejected', '计划触发已拒绝', 'Scheduled trigger rejected'], ['schedule-cancelled', '计划触发已取消', 'Scheduled trigger cancelled'],
  ['schedule-deleted', '计划已删除', 'Schedule deleted'],
] as const;
function fixture() {
  const page = JSON.parse(readFileSync(resolve('../../server/src/test/resources/notifications/center.json'), 'utf8'));
  const delivery = JSON.parse(readFileSync(resolve('../../server/src/test/resources/notifications/history.json'), 'utf8')).items[0].deliveries[0];
  const response = NotificationPageSchema.parse({ ...page, items: page.items.map((item: any) => ({ ...item, workspaceId: '11', projectId: '33', link: '/workspaces/11/projects/33/schedules/' + item.scheduleId, notificationState: 'failed', deliveries: [delivery] })) });
  const calls: Array<Record<string, any>> = [];
  let listGate: Promise<void> | undefined;
  const api = { assertionOperators: async () => [], onlineExecution: async () => [], onlineScheduling: async (input: Record<string, any>) => { calls.push(input); if (input.operation === 'notifications' && listGate) await listGate; return input.operation === 'markNotificationRead' ? { id: input.id, read: true } : input.beforeId ? { items: [], nextBeforeId: null } : response; } } as unknown as ApiccApi;
  const online = createOnlineStore({ api }); const execution = online.execution;
  const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  execution.activate(context); execution.setVisible(true); execution.project = project; execution.saved = JSON.stringify(project);
  execution.view = { project, problems: [], assets: { ...context.scope, format: 'contract-files-v1', contractProjectId: project.id, version: '1', manifestHash: 'a'.repeat(64), files: [] } };
  const adapter = createOnlineProjectAdapter(execution, api, () => true, () => true);
  const { i18n } = createI18nInstance(); i18n.global.locale.value = 'zh-CN';
  return { online, execution, i18n, calls, delayList(promise: Promise<void>) { listGate = promise; }, view: mount(OnlineProjectAssets, { props: { online, adapter, localProjects: [] }, global: { plugins: [i18n] } }) };
}
it.each(terminalReasons)('localizes known notification reason %s in Chinese and English', async (reasonCode, zh, en) => {
  const f = fixture();
  try {
    await f.view.findAll('nav.tabs button').find(button => button.text() === '通知中心')!.trigger('click'); await flushPromises();
    const page = f.online.schedules.notifications!;
    f.online.schedules.notifications = NotificationPageSchema.parse({ ...page, items: page.items.map(event => ({ ...event, reasonCode })) }); await flushPromises();
    expect(f.view.get('.notifications').text()).toContain(zh);
    expect(f.view.get('.notifications').text()).not.toContain(reasonCode);
    f.i18n.global.locale.value = 'en'; await flushPromises();
    expect(f.view.get('.notifications').text()).toContain(en);
    expect(f.view.get('.notifications').text()).not.toContain(reasonCode);
  } finally { f.execution.setVisible(false); }
});
it('round1 notification stays visibly read after a stale refresh finishes', async () => {
  const f = fixture(); let release!: () => void;
  try {
    await f.view.findAll('nav.tabs button').find(button => button.text() === '通知中心')!.trigger('click'); await flushPromises();
    f.delayList(new Promise<void>(done => { release = done; }));
    const pending = f.online.schedules.loadNotifications();
    await f.view.get('[data-testid="notification-read"]').trigger('click'); await flushPromises();
    expect(f.view.find('[data-testid="notification-read"]').exists()).toBe(false);
    release(); await pending; await flushPromises();
    expect(f.view.find('[data-testid="notification-read"]').exists()).toBe(false);
    expect(f.view.text()).toContain('已读');
  } finally { f.execution.setVisible(false); }
});
it('offers the current member notification center inside the project navigation', async () => {
  const f = fixture();
  try {
    expect(f.view.get('nav.tabs').text()).toContain('通知中心');
    await f.view.findAll('nav.tabs button').find(button => button.text() === '通知中心')!.trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('当前成员有权项目');
  } finally { f.execution.setVisible(false); }
});

it('shows in-app read state and external failure separately from an uncollected test verdict and marks only this member read', async () => {
  const f = fixture();
  try {
    await f.view.findAll('nav.tabs button').find(button => button.text() === '通知中心')!.trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('每日回归');
    expect(f.view.text()).toContain('投递失败'); expect(f.view.text()).toContain('执行结论：未采集');
    expect(f.view.text()).toContain('Webhook'); expect(f.view.text()).toContain('站内未读'); expect(f.view.text()).toContain('UTC');
    await f.view.get('[data-testid="notification-read"]').trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('站内已读');
    expect(f.calls.find(c => c.operation === 'markNotificationRead')).toEqual({ operation: 'markNotificationRead', context, id: '6' });
    f.i18n.global.locale.value = 'en'; await flushPromises();
    expect(f.view.text()).toContain('Delivery failed'); expect(f.view.text()).toContain('Execution verdict: Not collected');
    expect(f.view.find('pre').exists()).toBe(false);
  } finally { f.execution.setVisible(false); }
});

it('keeps absent report archive separate from absent delivery retry', async () => {
  const f = fixture();
  try {
    f.i18n.global.locale.value = 'en'; await flushPromises();
    await f.view.findAll('nav.tabs button').find(button => button.text() === 'Notification center')!.trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('No archive yet');
  } finally { f.execution.setVisible(false); }
});

it('keeps protocol or structured errors out of the notification business view', async () => {
  const f = fixture();
  try {
    await f.view.findAll('nav.tabs button').find(button => button.text() === '通知中心')!.trigger('click'); await flushPromises();
    f.online.schedules.error = '[{"code":"invalid_type","private":"DO-NOT-DISPLAY"}]'; await flushPromises();
    expect(f.view.get('[role="alert"]').text()).toBe('调度请求失败，请检查输入或刷新后重试。');
    expect(f.view.text()).not.toContain('DO-NOT-DISPLAY');
  } finally { f.execution.setVisible(false); }
});

it.each([['pending', '等待投递', 'Awaiting delivery'], ['sending', '正在投递', 'Sending'], ['stopped', '已停止投递', 'Delivery stopped'], ['expired', '投递期限已过', 'Delivery deadline expired']] as const)('renders external delivery %s in its own domain and both languages', async (state, zh, en) => {
  const capture = JSON.parse(readFileSync(resolve('../../server/src/test/resources/notifications/history.json'), 'utf8')).items[0].deliveries[0];
  const delivery = NotificationDeliverySchema.parse({ ...capture, state, reasonCode: null });
  const { i18n } = createI18nInstance(); i18n.global.locale.value = 'zh-CN';
  const view = mount(OnlineDeliveryList, { props: { deliveries: [delivery] }, global: { plugins: [i18n] } });
  expect(view.text()).toContain(zh); i18n.global.locale.value = 'en'; await flushPromises(); expect(view.text()).toContain(en);
});

it('keeps a failed execution verdict distinct from its failed delivery', async () => {
  const f = fixture();
  try {
    await f.view.findAll('nav.tabs button').find(button => button.text() === '通知中心')!.trigger('click'); await flushPromises();
    const page = f.online.schedules.notifications!;
    f.online.schedules.notifications = NotificationPageSchema.parse({ ...page, items: page.items.map(event => ({ ...event, eventKind: 'failed', reasonCode: 'execution-failed', jobId: '78', executionId: '79', verdict: 'failed', reportState: 'archived', evidenceState: 'complete' })) }); await flushPromises();
    expect(f.view.text()).toContain('执行结论：失败'); expect(f.view.text()).toContain('投递失败');
  } finally { f.execution.setVisible(false); }
});
it('shows an in-app-only event without inventing an external delivery', async () => {
  const f = fixture();
  try {
    await f.view.findAll('nav.tabs button').find(button => button.text() === '通知中心')!.trigger('click'); await flushPromises();
    const page = f.online.schedules.notifications!; f.online.schedules.notifications = NotificationPageSchema.parse({ ...page, items: page.items.map(event => ({ ...event, notificationState: 'in-app', deliveries: [] })) }); await flushPromises();
    expect(f.view.text()).toContain('仅站内通知'); expect(f.view.text()).not.toContain('Webhook #');
  } finally { f.execution.setVisible(false); }
});
it('pages current member notifications without losing an already-read event', async () => {
  const f = fixture();
  try {
    await f.view.findAll('nav.tabs button').find(button => button.text() === '通知中心')!.trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('更多通知');
    await f.view.get('[data-testid="notification-read"]').trigger('click'); await flushPromises();
    await f.view.get('[data-testid="notification-more"]').trigger('click'); await flushPromises();
    expect(f.calls.filter(input => input.operation === 'notifications').at(-1)).toEqual({ operation: 'notifications', context, limit: 25, beforeId: '6' });
    expect(f.online.schedules.notifications!.items).toHaveLength(1); expect(f.view.text()).toContain('站内已读');
  } finally { f.execution.setVisible(false); }
});
