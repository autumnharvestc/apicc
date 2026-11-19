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
import { scheduleContext as context, scheduleOptions, scheduleView } from '../../helpers/scheduling.js';
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
    await f.view.findAll('nav.run-tabs button').find(b=>b.text()==='通知')!.trigger('click');await flushPromises();const page=f.online.schedules.notifications!;
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
function fixture(crossProject = false, runInput?: (input: Record<string, any>) => Promise<unknown>) {
  const page = JSON.parse(readFileSync(resolve('../../server/src/test/resources/notifications/center.json'), 'utf8'));
  const delivery = JSON.parse(readFileSync(resolve('../../server/src/test/resources/notifications/history.json'), 'utf8')).items[0].deliveries[0];
  const response = NotificationPageSchema.parse({ ...page, items: page.items.map((item: any) => ({ ...item, workspaceId: '11', projectId: '33', link: '/workspaces/11/projects/33/schedules/' + item.scheduleId, notificationState: 'failed', deliveries: [delivery] })) });
  const calls: Array<Record<string, any>> = [];
  let listGate: Promise<void> | undefined;
  const api = { assertionOperators: async () => [], onlineExecution: async (input: Record<string, any>) => {
    calls.push(input);
    if (runInput && (input.operation === 'run' || input.operation === 'report')) return runInput(input);
    if (input.operation === 'status') return {jobId:'701',executionId:'702',agentId:'5',state:'running',cancelState:'none',executionReleased:false,canCancel:false,view:'active-status',scope:input.context.scope};
    return [];
  }, onlineScheduling: async (input: Record<string, any>) => { calls.push(input);
    if (input.operation === 'options') return scheduleOptions();
    if (input.operation === 'list') return {items:[],nextBeforeId:null};
    if (input.operation === 'detail') return {...scheduleView(),id:input.id,workspaceId:input.context.scope.workspaceId,projectId:input.context.scope.projectId,name:'Linked schedule'};
    if (input.operation === 'originalJob') return {jobId:input.jobId,executionId:input.executionId,agentId:'5'};
    if (crossProject && input.operation === 'notifications' && input.beforeId) return {items:[{...response.items[0],id:'5',projectId:'44',jobId:'701',executionId:'702',scheduleName:'Other project schedule',link:'/workspaces/11/projects/44/schedules/6'}],nextBeforeId:null};
    if (input.operation === 'notifications' && listGate) await listGate; return input.operation === 'markNotificationRead' ? { id: input.id, read: true } : input.beforeId ? { items: [], nextBeforeId: null } : response; } } as unknown as ApiccApi;
  const online = createOnlineStore({ api }); const execution = online.execution;
  const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  execution.activate(context); execution.setVisible(true); execution.project = project; execution.saved = JSON.stringify(project);
  execution.view = { project, problems: [], assets: { ...context.scope, format: 'contract-files-v1', contractProjectId: project.id, version: '1', manifestHash: 'a'.repeat(64), files: [] } };
  const adapter = createOnlineProjectAdapter(execution, api, () => true, () => true);
  const { i18n } = createI18nInstance(); i18n.global.locale.value = 'zh-CN';
  return { online, execution, i18n, calls, delayList(promise: Promise<void>) { listGate = promise; }, view: mount(OnlineProjectAssets, { props: { online, adapter, localProjects: [], view: 'run', openProject: async (ws:string,id:string) => {
    calls.push({operation:'switch-tab',workspaceId:ws,projectId:id});
    if (!crossProject || ws !== context.scope.workspaceId || !['33','44'].includes(id)) return false;
    execution.activate({...context,scope:{...context.scope,projectId:id}});
    execution.project=project; execution.saved=JSON.stringify(project);return true;
  } }, global: { plugins: [i18n] } }) };
}
it("recovers the selected pending local run after the host returns a cancellation with uncertain request execution", async () => {
  let rejectRun!: (error: Error) => void;
  const f = fixture(false, async input => input.operation === 'run' ? new Promise((_, reject) => { rejectRun = reject; })
    : {executionId:input.runId,verdict:'cancelled',executionFact:'uncertain',reasonCode:'local-run-cancelled'});
  try {
    await f.view.get('[data-testid="run-pane-records"]').trigger("click"); await flushPromises();
    const pending = f.execution.run({kind:'workflow',workflowId:'00000000-0000-4000-8000-000000000091'}).catch(error => error.message);
    await flushPromises();
    const id = f.execution.submissions[0]!.runId;
    await f.view.get(`[data-record="${id}"]`).trigger("click"); await flushPromises();
    expect(f.execution.report).toBeNull();
    rejectRun(Error('local-run-cancelled')); await pending; await flushPromises();
    const info = f.view.get('[data-testid="selected-execution-facts"]');
    expect(info.text()).toContain('已结束'); expect(info.text()).toContain('已取消'); expect(info.text()).toContain('是否执行尚不确定');
    expect(f.view.get('.record-failure').text()).toBe('本次本机运行已取消。');
    expect(f.calls.filter(call => call.operation === 'report').map(call => call.runId)).toEqual([id]);
    expect(f.calls.filter(call => call.operation === 'run')).toHaveLength(1);
  } finally { f.execution.setVisible(false); }
});

it("preserves the explicit record list when leaving and returning to Run", async () => {
  const f = fixture();
  try {
    const job = { jobId: '701', executionId: '702', agentId: '5', state: 'running', cancelState: 'none', executionReleased: false,
      canCancel: false, view: 'active-status', scope: f.execution.context!.scope } as const;
    f.execution.jobs = [job];
    await f.view.get('[data-testid="run-pane-records"]').trigger("click");
    await f.view.get('[data-record="5/701/702"]').trigger("click");
    const back = () => f.view.findAll(".record-detail button").find(button => button.text() === "返回列表");
    expect(back()).toBeDefined();
    await back()!.trigger("click");
    await f.view.setProps({ view: "test" }); await f.view.setProps({ view: "run" }); await flushPromises();
    expect(back()).toBeUndefined();
    expect(f.view.find('[data-record="5/701/702"]').exists()).toBe(true);
    expect(f.calls.filter(call => call.operation === "status" || call.operation === "run")).toEqual([]);
  } finally { f.execution.setVisible(false); }
});

it.each(terminalReasons)('localizes known notification reason %s in Chinese and English', async (reasonCode, zh, en) => {
  const f = fixture();
  try {
    await f.view.findAll('nav.run-tabs button').find(button => button.text() === '通知')!.trigger('click'); await flushPromises();
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
    await f.view.findAll('nav.run-tabs button').find(button => button.text() === '通知')!.trigger('click'); await flushPromises();
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
    expect(f.view.get('nav.run-tabs').text()).toContain('通知');
    await f.view.findAll('nav.run-tabs button').find(button => button.text() === '通知')!.trigger('click'); await flushPromises();
    expect(f.view.get('.event-list h2').text()).toBe('通知列表');
    expect(f.view.get('.event-name strong').text()).toBe('每日回归');
  } finally { f.execution.setVisible(false); }
});

it('shows in-app read state and external failure separately from an uncollected test verdict and marks only this member read', async () => {
  const f = fixture();
  try {
    await f.view.findAll('nav.run-tabs button').find(button => button.text() === '通知')!.trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('每日回归');
    expect(f.view.text()).toContain('投递失败'); expect(f.view.get('.notice-detail dl dd').text()).toBe('未采集');
    expect(f.view.text()).toContain('Webhook'); expect(f.view.text()).toContain('站内未读'); expect(f.view.text()).toContain('UTC');
    await f.view.get('[data-testid="notification-read"]').trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('站内已读');
    expect(f.calls.find(c => c.operation === 'markNotificationRead')).toEqual({ operation: 'markNotificationRead', context, id: '6' });
    f.i18n.global.locale.value = 'en'; await flushPromises();
    expect(f.view.text()).toContain('Delivery failed'); expect(f.view.get('.notice-detail dl dd').text()).toBe('Not collected');
    expect(f.view.find('pre').exists()).toBe(false);
  } finally { f.execution.setVisible(false); }
});

it('keeps absent report archive separate from absent delivery retry', async () => {
  const f = fixture();
  try {
    f.i18n.global.locale.value = 'en'; await flushPromises();
    await f.view.findAll('nav.run-tabs button').find(button => button.text() === 'Notifications')!.trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('No archive yet');
  } finally { f.execution.setVisible(false); }
});

it('keeps protocol or structured errors out of the notification business view', async () => {
  const f = fixture();
  try {
    await f.view.findAll('nav.run-tabs button').find(button => button.text() === '通知')!.trigger('click'); await flushPromises();
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
    await f.view.findAll('nav.run-tabs button').find(button => button.text() === '通知')!.trigger('click'); await flushPromises();
    const page = f.online.schedules.notifications!;
    f.online.schedules.notifications = NotificationPageSchema.parse({ ...page, items: page.items.map(event => ({ ...event, eventKind: 'failed', reasonCode: 'execution-failed', jobId: '78', executionId: '79', verdict: 'failed', reportState: 'archived', evidenceState: 'complete' })) }); await flushPromises();
    expect(f.view.get('.notice-detail dl dd').text()).toBe('失败'); expect(f.view.get('.delivery-list').text()).toContain('投递失败');
  } finally { f.execution.setVisible(false); }
});
it('shows an in-app-only event without inventing an external delivery', async () => {
  const f = fixture();
  try {
    await f.view.findAll('nav.run-tabs button').find(button => button.text() === '通知')!.trigger('click'); await flushPromises();
    const page = f.online.schedules.notifications!; f.online.schedules.notifications = NotificationPageSchema.parse({ ...page, items: page.items.map(event => ({ ...event, notificationState: 'in-app', deliveries: [] })) }); await flushPromises();
    expect(f.view.text()).toContain('仅站内通知'); expect(f.view.text()).not.toContain('Webhook #');
  } finally { f.execution.setVisible(false); }
});
it('pages current member notifications without losing an already-read event', async () => {
  const f = fixture();
  try {
    await f.view.findAll('nav.run-tabs button').find(button => button.text() === '通知')!.trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('更多通知');
    await f.view.get('[data-testid="notification-read"]').trigger('click'); await flushPromises();
    await f.view.get('[data-testid="notification-more"]').trigger('click'); await flushPromises();
    expect(f.calls.filter(input => input.operation === 'notifications').at(-1)).toEqual({ operation: 'notifications', context, limit: 25, beforeId: '6' });
    expect(f.online.schedules.notifications!.items).toHaveLength(1); expect(f.view.text()).toContain('站内已读');
  } finally { f.execution.setVisible(false); }
});

it.each(['zh-CN', 'en'] as const)('P3f distinguishes loaded empty notifications from unavailable results in %s', async locale => {
  const f = fixture();
  try {
    await f.view.findAll('nav.run-tabs button').find(button => button.text() === '通知')!.trigger('click'); await flushPromises();
    f.i18n.global.locale.value = locale;
    f.online.schedules.notifications = { items: [], nextBeforeId: '6' }; await flushPromises();
    const empty = locale === 'en' ? 'No notifications in the loaded results.' : '已加载的结果中暂无通知。';
    expect(f.view.get('.notifications').text()).toContain(empty);
    expect(f.view.find('[data-testid="notification-more"]').exists()).toBe(true);
    f.online.schedules.error = 'network-error'; await flushPromises();
    expect(f.view.get('.notifications').text()).not.toContain(empty);
    f.online.schedules.error = ''; f.online.schedules.notifications = null; await flushPromises();
    expect(f.view.get('.notifications').text()).not.toContain(empty);
  } finally { f.execution.setVisible(false); }
});

it("opens a cross-project status beyond the recent page and restores the unread notification, paging and scroll", async () => {
  const f=fixture(true);
  try {
    await f.view.get('[data-testid="run-pane-notifications"]').trigger('click'); await flushPromises();
    const first = f.view.get('.notice-detail');
    expect(first.findAll('.links button').map(b=>b.text())).toEqual(['查看计划','查看本次运行']);
    expect(first.get('[data-testid="notification-run"]').attributes('disabled')).toBeDefined();
    expect(first.text()).toContain('此通知没有关联运行');
    await f.view.get('[data-testid="notification-more"]').trigger('click'); await flushPromises();
    (f.view.get('.event-scroll').element as HTMLElement).scrollTop=72;
    await f.view.findAll('[data-event]')[1]!.trigger('click'); await flushPromises();
    await f.view.get('[data-testid="notification-refresh"]').trigger('click'); await flushPromises();
    expect(f.view.get('.notice-detail h2').text()).toBe('Other project schedule');
    await f.view.get('[data-testid="notification-run"]').trigger('click'); await flushPromises();
    expect(f.execution.resultSelection).toMatchObject({kind:'agent',job:{jobId:'701',executionId:'702',view:'active-status'}});
    expect(f.calls.find(c=>c.operation==='originalJob')).toMatchObject({context:{scope:{projectId:'44'}},jobId:'701',executionId:'702'});
    expect(f.view.get('[data-testid="selected-execution-facts"]').text()).toContain('702');
    expect(f.calls.filter(c=>['run','report','markNotificationRead'].includes(c.operation))).toEqual([]);
    await f.view.get('[data-testid="return-notification"]').trigger('click'); await flushPromises();
    expect(f.execution.context?.scope.projectId).toBe('33');
    expect(f.view.get('.notifications article[aria-current=true]').text()).toContain('Other project schedule');
    expect(f.online.schedules.notificationPages).toBe(2);
    expect((f.view.get('.event-scroll').element as HTMLElement).scrollTop).toBe(72);
    expect(f.view.get('.notifications article[aria-current=true]').text()).toContain('站内未读');
  } finally { f.execution.setVisible(false); }
});

it("reads the exact schedule when the notification has no job and leaves its read state unchanged", async () => {
  const f=fixture();
  try {
    await f.view.get('[data-testid="run-pane-notifications"]').trigger('click'); await flushPromises();
    await f.view.get('[data-testid="notification-plan"]').trigger('click'); await flushPromises();
    expect(f.online.schedules.selected).toMatchObject({id:'6',projectId:'33',name:'Linked schedule'});
    expect(f.calls.filter(c=>c.operation==='detail')).toEqual([{operation:'detail',context,id:'6'}]);
    expect(f.calls.filter(c=>['originalJob','report','markNotificationRead','run'].includes(c.operation))).toEqual([]);
    await f.view.get('[data-testid="return-notification"]').trigger('click'); await flushPromises();
    expect(f.view.get('.notifications article[aria-current=true]').text()).toContain('站内未读');
  } finally { f.execution.setVisible(false); }
});
