// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ContractWorkspaceSchema } from '@apicc/core/schema';
import { workspaceFixture } from '../../../../../packages/core/tests/helpers/contractFixtures.js';
import { createOnlineStore } from '../../../src/renderer/src/stores/online.js';
import { createOnlineProjectAdapter } from '../../../src/renderer/src/stores/onlineProjectAdapter.js';
import OnlineProjectAssets from '../../../src/renderer/src/components/online/OnlineProjectAssets.vue';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import type { ApiccApi } from '../../../src/shared/types.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scheduleOptions, schedulePreparation, scheduleView, scheduleAgents, workflowId } from '../../helpers/scheduling.js';
import { OnlineJobSchema } from '../../../src/shared/online/execution.js';
import { ProjectExecutionAgentsSchema } from '@apicc/execution/contract';

enableAutoUnmount(afterEach);
function projectFixture(saved = false, updateFailure: boolean | string = false, notificationCapture = 'history', historyCapture = 'history') {
  const calls: Array<Record<string, any>> = [];
  const executionCalls: Array<Record<string, any>> = [];
  let statusGate: Promise<void> | undefined; let mismatchJob = false;
  let listNext: string | null = null;
  let historyPaging = false; let options = scheduleOptions();
  let detailGate: Promise<void> | undefined;
  let previewGate: Promise<void> | undefined; let prepareGate: Promise<void> | undefined;
  let previewNotices = ['schedule-min-interval']; let dstGapHistory = false;
  let twoReports = false;
  let reportIO: ((stage: 'originalJob' | 'status' | 'report', jobId: string) => Promise<void>) | undefined;
  const api = { assertionOperators: async () => [], onlineExecution: async (input: Record<string, any>) => {
    executionCalls.push(input);
    if (input.operation === 'status') { if (statusGate) await statusGate; await reportIO?.('status', input.runId); if (input.location.agentId !== '5') throw Error('online-project-scope-mismatch'); return OnlineJobSchema.parse({ jobId: mismatchJob ? '999' : input.runId, executionId: input.runId === '88' ? '89' : '79', agentId: '5', state: 'ended', cancelState: 'none', executionReleased: true, reportState: 'archived', task: { protocolVersion: 1, jobId: mismatchJob ? '999' : input.runId, executionId: input.runId === '88' ? '89' : '79', scope: { workspaceId: '11', groupId: '22', projectId: '33' }, submittedByUserId: '7', contractProjectId: '00000000-0000-4000-8000-000000000018', snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'workflow', workflowId }, policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'compatible', dispatchKind: 'dedicated-task', requiredCapabilities: ['task:workflow'] } }); }
    if (input.operation === 'report') { await reportIO?.('report', input.runId); return { executionId: input.runId === '88' ? '89' : '79', verdict: input.runId === '88' ? 'passed' : 'failed', executionFact: 'started' }; }
    throw Error('unexpected-execution-operation');
  }, onlineScheduling: async (input: Record<string, any>) => {
    calls.push(input);
    if (input.operation === 'originalJob') { await reportIO?.('originalJob', input.jobId); return { jobId: input.jobId, executionId: input.executionId, agentId: '5' }; }
    if (input.operation === 'options') return options;
    if (input.operation === 'list') return { items: saved && !input.beforeId ? [scheduleView()] : [], nextBeforeId: input.beforeId ? null : listNext };
    if (input.operation === 'remove') return null;
    if (input.operation === 'notifications') return { items: [], nextBeforeId: null };
    if (input.operation === 'materialOptions') return { credentialValidation: 'metadata-only', credentials: [{ refId: 'api-token', version: '2', status: 'registered' }], attachments: [] };
    if (input.operation === 'detail') { if (detailGate) await detailGate; return scheduleView(); }
    if (input.operation === 'history') {
      const page = JSON.parse(readFileSync(resolve('../../server/src/test/resources/scheduling/' + historyCapture + '.json'), 'utf8'));
      if (dstGapHistory) page.missedWindows[0].reasonCode = 'dst-gap-skipped';
      if (twoReports) page.items = [...page.items, { ...page.items[0], id: '49', jobId: '88', executionId: '89' }];
      if (historyPaging) { page.nextBeforeId = input.beforeId ? null : '44'; page.nextMissedBeforeId = input.missedBeforeId ? null : '55'; if (input.beforeId) page.items = []; if (input.missedBeforeId) page.missedWindows = []; }
      return { ...page, workspaceId: '11', projectId: '33', scheduleId: scheduleView().id, items: page.items.map((row: any) => ({ ...row, workspaceId: '11', projectId: '33', scheduleId: scheduleView().id, materials: { ...row.materials, projectId: '33' } })) };
    }
    if (input.operation === 'notificationHistory') {
      const capture = notificationCapture === 'paging' || notificationCapture === 'not-ready' || notificationCapture === 'not-observed' ? 'history' : notificationCapture;
      const page = { ...JSON.parse(readFileSync(resolve('../../server/src/test/resources/notifications/' + capture + '.json'), 'utf8')), workspaceId: '11', projectId: '33', scheduleId: scheduleView().id };
      if (notificationCapture === 'paging') { page.nextBeforeId = input.beforeId ? null : '44'; page.nextSourceBeforeId = input.sourceBeforeId ? null : '55'; if (input.beforeId) page.items = []; if (input.sourceBeforeId) page.sources = []; }
      if (notificationCapture === 'not-ready' || notificationCapture === 'not-observed') { page.items = []; page.sources = [{ sourceId: 'occurrence/3', sourceVersion: '1', observationState: notificationCapture, eventId: null, inApp: null }]; }
      return page;
    }
    if (input.operation === 'prepare') { if (prepareGate) await prepareGate; return schedulePreparation(); }
    if (input.operation === 'save') return { ...scheduleView(), ...input.input };
    if (input.operation === 'update') { if (updateFailure) throw Error(typeof updateFailure === 'string' ? updateFailure : 'version_conflict'); const patch = input.input; const row = scheduleView(); return { ...row, name: patch.name ?? row.name, rule: patch.rule ?? row.rule, policies: patch.policies ?? row.policies, notifications: patch.notifications ?? row.notifications, execution: patch.execution ?? row.execution, enabled: patch.enabled ?? row.enabled, version: '9007199254740996' }; }
    if (input.operation === 'preview') { if (previewGate) await previewGate; return { candidates: [{ plannedAtUtc: '2035-01-01T00:00:00.123456789Z', localTime: '2035-01-01T08:00:00.123456789', offset: '+08:00' }], notices: previewNotices, limits: { minIntervalMs: 60000 } }; }
    throw Error('unexpected scheduling operation');
  } } as unknown as ApiccApi;
  const online = createOnlineStore({ api });
  const execution = online.execution;
  const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
  const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  project.workflows = [{ id: '00000000-0000-4000-8000-000000000091', name: 'Saved workflow', status: 'enabled', nodes: [{ id: 'noop', kind: 'noop' }], edges: [] }];
  execution.activate(context); execution.setVisible(true); execution.project = project; execution.saved = JSON.stringify(project);
  execution.view = { project, problems: [], assets: { ...context.scope, format: 'contract-files-v1', contractProjectId: project.id, version: '1', manifestHash: 'a'.repeat(64), files: [] } };
  execution.agents = scheduleAgents();
  const adapter = createOnlineProjectAdapter(execution, api, () => false, () => true);
  const { i18n } = createI18nInstance(); i18n.global.locale.value = 'zh-CN';
  const view = mount(OnlineProjectAssets, { props: { online, adapter, localProjects: [] }, global: { plugins: [i18n] } });
  return { online, execution, context, project, i18n, view, calls, executionCalls, twoReports() { twoReports = true; }, reportIO(handler: NonNullable<typeof reportIO>) { reportIO = handler; }, notices(values: string[]) { previewNotices = values; }, dstGapHistory() { dstGapHistory = true; }, delayStatus(promise: Promise<void>) { statusGate = promise; }, delayDetail(promise: Promise<void>) { detailGate = promise; }, delayPreview(promise: Promise<void>) { previewGate = promise; }, delayPrepare(promise: Promise<void>) { prepareGate = promise; }, mismatchJob() { mismatchJob = true; }, listNext(id: string) { listNext = id; }, historyPaging() { historyPaging = true; }, customPolicy() { options = { ...scheduleOptions(), policy: { ...scheduleOptions().policy, queueTimeoutMs: 12345, maxQueueTimeoutMs: 20000, minIntervalMs: 65000 }, sources: { queueTimeoutMs: 'project', minIntervalMs: 'workspace', maxQueueTimeoutMs: 'workspace' } }; } };
}
async function openSchedules(f: ReturnType<typeof projectFixture>) { await f.view.findAll('nav.tabs button').find(b => b.text() === '定时任务')!.trigger('click'); await flushPromises(); }
async function inspectSaved(f: ReturnType<typeof projectFixture>) { await openSchedules(f); await f.view.get('[data-testid="schedule-open"]').trigger('click'); await flushPromises(); }

it.each([['passed','通过','Passed'],['failed','失败','Failed']] as const)('shows actual original-job %s in the history verdict cell in both languages',async(verdict,zh,en)=>{
  const f=projectFixture(true,false,'history','job-history');
  try{
    await inspectSaved(f);await f.view.get('[data-testid="schedule-history-open"]').trigger('click');await flushPromises();
    const page=f.online.schedules.history!;f.online.schedules.history={...page,items:page.items.map(row=>({...row,execution:{...row.execution,state:'ended',verdict}}))};await flushPromises();
    expect(f.view.get('[data-testid="schedule-history"] tbody tr').findAll('td')[4]!.text()).toBe(zh);
    f.i18n.global.locale.value='en';await flushPromises();expect(f.view.get('[data-testid="schedule-history"] tbody tr').findAll('td')[4]!.text()).toBe(en);
  }finally{f.execution.setVisible(false);}
});

it.each([
  ['network-error','通知网络连接失败','Notification network connection failed'],['timeout','通知请求总时限已过','Notification request deadline exceeded'],
  ['transport-busy','通知传输容量已满','Notification transport capacity is full'],['http-retryable','通知端点暂时失败（可重试状态）','Notification endpoint temporarily failed (retryable status)'],
  ['http-terminal','通知端点拒绝投递，不再重试','Notification endpoint rejected delivery; no retry'],['response-too-large','通知响应超过读取上限','Notification response exceeded the read limit'],
] as const)('explains actual outbound reason %s in notification history without losing delivery facts',async(reason,zh,en)=>{
  const f=projectFixture(true);
  try{
    await inspectSaved(f);await f.view.get('[data-testid="schedule-notification-history-open"]').trigger('click');await flushPromises();
    const page=f.online.schedules.notificationHistory!;f.online.schedules.notificationHistory={...page,items:page.items.map(event=>({...event,reasonCodes:[reason],deliveries:event.deliveries.map(d=>({...d,reasonCode:reason,status:302,attempts:1}))}))};await flushPromises();
    const text=()=>f.view.get('[data-testid="schedule-notification-history"] article').text();expect(text()).toContain(zh);expect(text()).not.toContain(reason);expect(text()).toContain('HTTP 302');
    f.i18n.global.locale.value='en';await flushPromises();expect(text()).toContain(en);expect(text()).toContain('HTTP 302');expect(text()).not.toContain(reason);
  }finally{f.execution.setVisible(false);}
});

// A locally scrolling history must remain reachable by keyboard, not require
// horizontal scrolling of the entire plan editor. Native geometry is checked too.
it('exposes the occurrence table as a labelled keyboard-reachable local scrolling region', async () => {
  const f = projectFixture(true, false, 'history', 'job-history');
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises();
    const region = f.view.find('[role="region"][aria-label="触发历史"]');
    expect(region.exists()).toBe(true);
    expect((region.element as HTMLElement).tabIndex).toBe(0);
    expect(region.findAll('thead th')).toHaveLength(8);
    expect(region.get('[data-testid="schedule-original-report"]').text()).toBe('查看原任务报告');
    f.i18n.global.locale.value = 'en'; await flushPromises();
    expect(f.view.find('[role="region"][aria-label="Occurrence history"]').exists()).toBe(true);
  } finally { f.execution.setVisible(false); }
});

it.each([
  ['intent_source_conflict', '任务来源冲突', 'Job source conflict'], ['credential_unavailable', '凭据不可用', 'Credential unavailable'],
  ['snapshot_version_conflict', '快照版本冲突', 'Snapshot version conflict'],
  ['execution-passed', '执行通过', 'Execution passed'], ['execution-failed', '执行失败', 'Execution failed'],
  ['execution-abnormal', '执行异常', 'Execution abnormal'], ['schedule-skipped', '计划触发已跳过', 'Scheduled trigger skipped'],
  ['schedule-rejected', '计划触发已拒绝', 'Scheduled trigger rejected'], ['schedule-cancelled', '计划触发已取消', 'Scheduled trigger cancelled'],
  ['schedule-deleted', '计划已删除', 'Schedule deleted'],
] as const)('localizes known notification history reason %s in both languages', async (reason, zh, en) => {
  const f = projectFixture(true);
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-notification-history-open"]').trigger('click'); await flushPromises();
    const page = f.online.schedules.notificationHistory!;
    f.online.schedules.notificationHistory = { ...page, items: page.items.map(event => ({ ...event, reasonCodes: [reason] })) }; await flushPromises();
    expect(f.view.get('[data-testid="schedule-notification-history"] article').text()).toContain(zh);
    expect(f.view.get('[data-testid="schedule-notification-history"] article').text()).not.toContain(reason);
    f.i18n.global.locale.value = 'en'; await flushPromises();
    expect(f.view.get('[data-testid="schedule-notification-history"] article').text()).toContain(en);
  } finally { f.execution.setVisible(false); }
});

it('round1 originalJob report still opens agent A history after the saved plan changes to agent B', async () => {
  const f = projectFixture(true, false, 'history', 'job-history');
  try {
    await inspectSaved(f);
    const row = f.online.schedules.selected!;
    f.online.schedules.selected = { ...row, execution: { ...row.execution, agentId: '6' } };
    await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises();
    await f.view.get('[data-testid="schedule-original-report"]').trigger('click'); await flushPromises();
    expect(f.view.find('[data-testid="online-execution-report"]').exists()).toBe(true);
    expect(f.execution.report).toMatchObject({ executionId: '79', verdict: 'failed' });
    expect(f.executionCalls.filter(input => input.operation === 'status' || input.operation === 'report').map(input => input.location)).toEqual([{ kind: 'agent', agentId: '5' }, { kind: 'agent', agentId: '5' }]);
    expect(f.calls.filter(input => input.operation === 'prepare' || input.operation === 'save')).toEqual([]);
  } finally { f.execution.setVisible(false); }
});

// Producer ScheduleRuleCalculator returns these notices; the user must not interpret internal codes.
it.each(['originalJob', 'status', 'report'] as const)('round1 report intent keeps B when A has a late %s success or failure', async stage => {
  for (const failure of [false, true]) {
    const f = projectFixture(true, false, 'history', 'job-history'); f.twoReports(); let release!: () => void;
    const old = new Promise<void>(done => { release = done; });
    f.reportIO(async (current, jobId) => { if (current === stage && jobId === '78') { await old; if (failure) throw Error('obsolete-report-error'); } });
    try {
      await inspectSaved(f); await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises();
      await f.view.findAll('[data-testid="schedule-original-report"]')[0]!.trigger('click'); await flushPromises();
      await f.view.findAll('[data-testid="schedule-original-report"]')[1]!.trigger('click'); await flushPromises();
      expect(f.execution.report).toMatchObject({ executionId: '89', verdict: 'passed' });
      release(); await flushPromises();
      expect.soft(f.execution.report).toMatchObject({ executionId: '89', verdict: 'passed' });
      expect.soft(f.execution.selectedJobId).toBe('88');
      expect(f.execution.error).toBe('');
      expect(f.view.get('[data-testid="online-execution-report"]').text()).toContain('通过');
    } finally { release(); f.execution.setVisible(false); }
  }
});

it.each([
  ['originalJob', 'new'], ['status', 'new'], ['report', 'new'],
  ['originalJob', 'select'], ['status', 'select'], ['report', 'select'],
  ['originalJob', 'hidden'], ['status', 'hidden'], ['report', 'hidden'],
  ['originalJob', 'pane'], ['status', 'pane'], ['report', 'pane'],
  ['originalJob', 'unmount'], ['status', 'unmount'], ['report', 'unmount'],
] as const)('round1 report intent discards a pending %s after %s', async (stage, lifecycle) => {
  const f = projectFixture(true, false, 'history', 'job-history'); let release!: () => void;
  const old = new Promise<void>(done => { release = done; });
  f.reportIO(async current => { if (current === stage) await old; });
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises();
    await f.view.get('[data-testid="schedule-original-report"]').trigger('click'); await flushPromises();
    if (lifecycle === 'new') await f.view.findAll('button').find(button => button.text() === '新建计划')!.trigger('click');
    if (lifecycle === 'select') await f.online.schedules.inspect('9007199254740994');
    if (lifecycle === 'hidden') f.execution.setVisible(false);
    if (lifecycle === 'pane') await f.view.findAll('nav.tabs button').find(button => button.text() === '通知中心')!.trigger('click');
    if (lifecycle === 'unmount') f.view.unmount();
    await flushPromises(); release(); await flushPromises();
    expect(f.execution.report).toBeNull(); expect(f.execution.error).toBe('');
    if (stage !== 'report') expect(f.executionCalls.filter(input => input.operation === 'report')).toEqual([]);
  } finally { release(); f.execution.setVisible(false); }
});

it.each([
  ['dst-gap-skipped', '因夏令时跳变不存在的本地时刻已跳过', 'Nonexistent local times in the daylight-saving gap were skipped.'],
  ['dst-overlap-first', '夏令时重复的本地时刻仅触发第一次', 'Repeated local times in the daylight-saving overlap trigger only the first occurrence.'],
  ['dst-overlap-both', '夏令时重复的本地时刻将分别触发两次', 'Repeated local times in the daylight-saving overlap trigger both occurrences.'],
])('round1 DST preview explains %s in both languages', async (notice, zh, en) => {
  const f = projectFixture(); f.notices([notice]);
  try {
    await openSchedules(f); await f.view.get('[data-testid="schedule-preview"]').trigger('click'); await flushPromises();
    expect(f.view.text()).toContain(zh); expect(f.view.text()).not.toContain(notice);
    f.i18n.global.locale.value = 'en'; await flushPromises();
    expect(f.view.text()).toContain(en); expect(f.view.text()).not.toContain(notice);
  } finally { f.execution.setVisible(false); }
});
it('round1 DST gap missed-window reason is readable in both languages', async () => {
  const f = projectFixture(true); f.dstGapHistory();
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises();
    const history = f.view.get('[data-testid="schedule-history"]');
    expect(history.text()).toContain('因夏令时跳变不存在的本地时刻已跳过'); expect(history.text()).not.toContain('dst-gap-skipped');
    f.i18n.global.locale.value = 'en'; await flushPromises();
    expect(history.text()).toContain('Nonexistent local times in the daylight-saving gap were skipped.');
  } finally { f.execution.setVisible(false); }
});

// Break caught: schedules are absent from the actual project navigation.
it('offers the schedules business page inside the saved online project', async () => {
  const f = projectFixture();
  try {
    expect(f.view.get('nav.tabs').text()).toContain('定时任务');
    await f.view.findAll('nav.tabs button').find(b => b.text() === '定时任务')!.trigger('click');
    await flushPromises();
    expect(f.view.text()).toContain('首次保存为暂停状态');
  } finally { f.execution.setVisible(false); }
});

it('opens a saved schedule with its fixed identity and readable snapshot summary without preparing it', async () => {
  const f = projectFixture(true);
  try {
    await openSchedules(f);
    expect(f.view.text()).toContain('查看计划');
    await f.view.get('[data-testid="schedule-open"]').trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('快照版本'); expect(f.view.text()).toContain('9007199254740995');
    expect(f.view.get('[data-testid="schedule-fingerprint"]').attributes('title')).toBe('a'.repeat(64));
    expect(f.view.get('[data-testid="schedule-fingerprint"]').text().length).toBeLessThan(30);
    expect(f.calls.filter(c => c.operation === 'prepare' || c.operation === 'save')).toEqual([]);
    expect(f.view.find('pre').exists()).toBe(false);
  } finally { f.execution.setVisible(false); }
});

// Break caught: save must prepare a saved snapshot and POST once without enabling or executing.
it('saves a paused schedule through the actual project form despite unrelated edit-file readOnly', async () => {
  const f = projectFixture();
  try {
    await openSchedules(f);
    expect(f.view.text()).toContain('保存暂停计划');
    await f.view.get('[data-testid="schedule-name"]').setValue('Daily');
    await f.view.get('[data-testid="schedule-target"]').setValue('workflow:' + workflowId);
    await f.view.get('[data-testid="schedule-agent"]').setValue('5');
    await f.view.get('[data-testid="schedule-save"]').trigger('click'); await flushPromises();
    expect(f.calls.filter(c => c.operation === 'save'), f.view.text()).toHaveLength(1);
    expect(f.calls.find(c => c.operation === 'save')!.input).toMatchObject({ name: 'Daily', execution: { snapshotId: '66', agentId: '5' } });
    expect(f.calls.find(c => c.operation === 'save')!.input).not.toHaveProperty('enabled');
    expect(f.view.text()).toContain('已暂停');
  } finally { f.execution.setVisible(false); }
});

// Each blocker must remain independently visible before preparation can happen.
it.each([['draft', '请先保存项目草稿'], ['local', '仅本机材料不能用于服务端调度'], ['agent', '请选择代理']] as const)('blocks creation for %s with a readable reason', async (kind, reason) => {
  const f = projectFixture();
  try {
    if (kind === 'draft') f.execution.project!.name += ' changed';
    if (kind === 'local') f.execution.localOnlyRefIds = ['local-token'];
    await openSchedules(f);
    expect(f.view.text()).toContain(reason);
    const save = f.view.find('[data-testid="schedule-save"]');
    expect(save.exists()).toBe(true);
    expect(save.attributes('disabled')).toBeDefined();
    expect(f.calls.filter(c => c.operation === 'prepare' || c.operation === 'save')).toEqual([]);
  } finally { f.execution.setVisible(false); }
});

it('saves name and notifications only, preserving the untouched nanosecond rule and decimal version', async () => {
  const f = projectFixture(true);
  try {
    await inspectSaved(f); expect(f.view.text()).toContain('保存更改');
    await f.view.get('[data-testid="schedule-name"]').setValue('Renamed');
    await f.view.get('[data-testid="schedule-inapp"]').setValue(false);
    await f.view.get('[data-testid="schedule-update"]').trigger('click'); await flushPromises();
    expect(f.calls.filter(c => c.operation === 'prepare')).toEqual([]);
    expect(f.calls.find(c => c.operation === 'update')!.input).toEqual({ expectedVersion: '9007199254740995', name: 'Renamed', notifications: { inApp: false, eventKinds: ['failed', 'abnormal', 'expired', 'paused'], channelIds: [] } });
    expect(f.online.schedules.selected!.rule).toEqual({ kind: 'once', atUtc: '2035-01-01T00:00:00.123456789Z', timeZone: 'Asia/Shanghai' });
  } finally { f.execution.setVisible(false); }
});

it('uses only server preview candidates for daily weekly and six-field rules in an explicit zone', async () => {
  const f = projectFixture();
  try {
    await openSchedules(f); expect(f.view.text()).toContain('服务器预览');
    await f.view.get('[data-testid="schedule-rule-mode"]').setValue('weekly');
    await f.view.get('[data-testid="schedule-weekday"]').setValue('MON');
    await f.view.get('[data-testid="schedule-hour"]').setValue('9'); await f.view.get('[data-testid="schedule-minute"]').setValue('30');
    await f.view.get('[data-testid="schedule-zone"]').setValue('America/New_York');
    await f.view.get('[data-testid="schedule-preview"]').trigger('click'); await flushPromises();
    expect(f.calls.find(c => c.operation === 'preview')!.input.rule).toEqual({ kind: 'cron', expression: '0 30 9 * * MON', timeZone: 'America/New_York', dstOverlap: 'first' });
    expect(f.view.get('[data-testid="schedule-preview-results"]').text()).toContain('+08:00');
    expect(f.view.get('[data-testid="schedule-preview-results"]').text()).toContain('123');
    expect(f.view.get('[data-testid="schedule-preview-results"]').findAll('li')).toHaveLength(1);
    f.i18n.global.locale.value = 'en'; await flushPromises(); expect(f.view.text()).toContain('Server preview');
  } finally { f.execution.setVisible(false); }
});

it('converts editable policy seconds to wire milliseconds and explains missed overlap and queue semantics', async () => {
  const f = projectFixture(true);
  try {
    await inspectSaved(f); expect(f.view.text()).toContain('排队截止（秒）');
    expect(f.view.text()).toContain('只补最近一次'); expect(f.view.text()).toContain('保留一个等待项');
    await f.view.get('[data-testid="schedule-queue-seconds"]').setValue('12.5');
    await f.view.get('[data-testid="schedule-update"]').trigger('click'); await flushPromises();
    expect(f.calls.find(c => c.operation === 'update')!.input.policies.queueTimeoutMs).toBe(12500);
    expect(f.calls.find(c => c.operation === 'update')!.input).not.toHaveProperty('rule');
  } finally { f.execution.setVisible(false); }
});

it('requires explicit risk confirmation before enabling and reauthorization explicitly pauses the new subject', async () => {
  const f = projectFixture(true);
  try {
    await inspectSaved(f); expect(f.view.text()).toContain('启用前确认');
    expect(f.view.text()).toContain('出站请求');
    expect(f.view.get('[data-testid="schedule-enable"]').attributes('disabled')).toBeDefined();
    await f.view.get('[data-testid="schedule-risk-confirm"]').setValue(true);
    await f.view.get('[data-testid="schedule-enable"]').trigger('click'); await flushPromises();
    expect(f.calls.find(c => c.operation === 'update')!.input).toEqual({ expectedVersion: '9007199254740995', enabled: true });
    expect(f.view.text()).toContain('7 → 7');
    await f.view.get('[data-testid="schedule-subject-confirm"]').setValue(true);
    await f.view.get('[data-testid="schedule-reauthorize"]').trigger('click'); await flushPromises();
    expect(f.calls.filter(c => c.operation === 'update').at(-1)!.input).toEqual({ expectedVersion: '9007199254740996', reauthorize: true, enabled: false });
  } finally { f.execution.setVisible(false); }
});

it('prepares refresh differences from the fixed saved revision and updates only after explicit confirmation', async () => {
  const f = projectFixture(true);
  try {
    await inspectSaved(f); expect(f.view.text()).toContain('刷新快照');
    await f.view.get('[data-testid="schedule-refresh-snapshot"]').trigger('click'); await flushPromises();
    const diff = f.view.get('[data-testid="schedule-snapshot-diff"]');
    for (const label of ['目标', '环境', '脚本', '数据', '材料绑定', '网络', '运行时', '更新前', '更新后']) expect(diff.text()).toContain(label);
    expect(f.calls.find(c => c.operation === 'prepare')!.input.previous).toMatchObject({ snapshotVersion: '1', manifestHash: 'a'.repeat(64), execution: { snapshotId: '66' } });
    expect(f.calls.filter(c => c.operation === 'update')).toEqual([]);
    await f.view.get('[data-testid="schedule-confirm-refresh"]').trigger('click'); await flushPromises();
    expect(f.calls.find(c => c.operation === 'update')!.input).toMatchObject({ expectedVersion: '9007199254740995', refreshExecution: true, execution: { snapshotId: '66' } });
    expect(f.view.find('pre').exists()).toBe(false);
  } finally { f.execution.setVisible(false); }
});

it('clears only search while preserving the selected status filter', async () => {
  const f = projectFixture(true);
  try {
    await openSchedules(f); expect(f.view.text()).toContain('清除搜索');
    await f.view.get('[data-testid="schedule-filter"]').setValue('enabled');
    await f.view.get('[data-testid="schedule-search"]').setValue('missing');
    await f.view.get('[data-testid="schedule-clear-search"]').trigger('click'); await flushPromises();
    expect((f.view.get('[data-testid="schedule-search"]').element as HTMLInputElement).value).toBe('');
    expect((f.view.get('[data-testid="schedule-filter"]').element as HTMLSelectElement).value).toBe('enabled');
    expect(f.view.findAll('[data-testid="schedule-open"]')).toHaveLength(0);
  } finally { f.execution.setVisible(false); }
});

it('shows a bilingual version conflict without overwriting the saved row or the editable draft', async () => {
  const f = projectFixture(true, true);
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-name"]').setValue('My draft');
    await f.view.get('[data-testid="schedule-update"]').trigger('click'); await flushPromises();
    expect(f.view.get('[role="alert"]').text()).toContain('版本冲突');
    expect(f.online.schedules.selected!.version).toBe('9007199254740995');
    expect((f.view.get('[data-testid="schedule-name"]').element as HTMLInputElement).value).toBe('My draft');
    f.i18n.global.locale.value = 'en'; await flushPromises(); expect(f.view.get('[role="alert"]').text()).toContain('Version conflict');
  } finally { f.execution.setVisible(false); }
});

it('reads original occurrence history with millisecond zone, delay, queue and genuinely uncollected actual facts', async () => {
  const f = projectFixture(true);
  try {
    await inspectSaved(f); expect(f.view.text()).toContain('触发历史');
    await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises();
    const history = f.view.get('[data-testid="schedule-history"]');
    for (const label of ['计划时间', '触发延迟', '排队', '实际运行', '执行结论', '归档', '通知', '未采集', '55000 ms', 'Asia/Shanghai']) expect(history.text()).toContain(label);
    expect(history.text()).toContain('.000'); expect(history.text()).toContain('错过窗口'); expect(history.text()).toContain('次数未精确采集');
    expect(history.find('time').attributes('title')).toBe('2035-01-01T00:03:00Z');
    expect(f.view.find('pre').exists()).toBe(false);
    f.i18n.global.locale.value = 'en'; await flushPromises();
    expect(history.text()).toContain('Not collected'); expect(history.text()).toContain('Planned time');
  } finally { f.execution.setVisible(false); }
});

it('reads source observation facts and external delivery failure from independent notification history', async () => {
  const f = projectFixture(true);
  try {
    await inspectSaved(f); expect(f.view.text()).toContain('通知历史');
    await f.view.get('[data-testid="schedule-notification-history-open"]').trigger('click'); await flushPromises();
    const history = f.view.get('[data-testid="schedule-notification-history"]');
    for (const text of ['来源观察', '已记录事件', '站内关闭', 'Webhook', '投递失败', '通知待投递容量已满', '0 次']) expect(history.text()).toContain(text);
    expect(f.calls.find(c => c.operation === 'notificationHistory')).toEqual({ operation: 'notificationHistory', context: f.context, id: '9007199254740993', limit: 25 });
    expect(f.calls.filter(c => c.operation === 'history')).toEqual([]);
  } finally { f.execution.setVisible(false); }
});

it.each([
  ['history-expired', '安全详情已过期', '外部已确认'],
  ['history-in-app-disabled', '站内关闭', '未请求通知'],
  ['history-unselected', '该来源未选择通知', '不能当作送达成功'],
  ['history-pause-recorded', '当前暂停来源', '未请求通知'],
  ['history-pause-not-selected', '当前暂停来源', '该来源未选择通知'],
  ['history-pause-legacy-unknown', '当前暂停来源', '暂停来源版本无法恢复'],
  ['not-ready', '来源尚未具备终态事实', '不能判断通知成败'],
  ['not-observed', '来源尚未完成观察', '不能推断没有通知'],
])('renders actual notification provenance/retention facts from %s without inventing success', async (capture, first, second) => {
  const f = projectFixture(true, false, capture);
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-notification-history-open"]').trigger('click'); await flushPromises();
    const history = f.view.get('[data-testid="schedule-notification-history"]');
    expect.soft(history.text()).toContain(first!); expect(history.text()).toContain(second!);
    expect(history.text()).not.toContain('null'); expect(history.find('pre').exists()).toBe(false);
  } finally { f.execution.setVisible(false); }
});

it('pages original occurrences and missed windows independently while retaining prior facts', async () => {
  const f = projectFixture(true); f.historyPaging();
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises(); expect(f.view.text()).toContain('更多触发'); expect(f.view.text()).toContain('更多错过窗口');
    await f.view.get('[data-testid="schedule-history-more"]').trigger('click'); await flushPromises();
    expect(f.calls.filter(input => input.operation === 'history').at(-1)).toEqual({ operation: 'history', context: f.context, id: '9007199254740993', limit: 25, beforeId: '44' });
    expect(f.online.schedules.history!.missedWindows).toHaveLength(1);
    await f.view.get('[data-testid="schedule-missed-more"]').trigger('click'); await flushPromises();
    expect(f.calls.filter(input => input.operation === 'history').at(-1)).toEqual({ operation: 'history', context: f.context, id: '9007199254740993', limit: 25, missedBeforeId: '55' });
    expect(f.online.schedules.history!.items).toHaveLength(1); expect(f.online.schedules.history!.nextBeforeId).toBeNull();
  } finally { f.execution.setVisible(false); }
});

it('reads effective policy defaults and sources with units instead of silently using unrelated constants', async () => {
  const f = projectFixture(); f.customPolicy();
  try {
    await openSchedules(f); expect(f.view.text()).toContain('生效额度与来源');
    expect(f.view.text()).toContain('65 秒'); expect(f.view.text()).toContain('20 秒'); expect(f.view.text()).toContain('项目策略'); expect(f.view.text()).toContain('工作区策略');
    expect((f.view.get('[data-testid="schedule-queue-seconds"]').element as HTMLInputElement).value).toBe('12.345');
  } finally { f.execution.setVisible(false); }
});

it('reopens the fixed saved schedule form after switching business pages without preparing or running it', async () => {
  const f = projectFixture(true);
  try {
    await inspectSaved(f); await f.view.findAll('nav.tabs button').find(button => button.text() === '通知中心')!.trigger('click'); await flushPromises();
    await f.view.findAll('nav.tabs button').find(button => button.text() === '定时任务')!.trigger('click'); await flushPromises();
    expect((f.view.get('[data-testid="schedule-name"]').element as HTMLInputElement).value).toBe(scheduleView().name);
    expect(f.calls.filter(input => input.operation === 'prepare' || input.operation === 'save')).toEqual([]); expect(f.executionCalls).toEqual([]);
  } finally { f.execution.setVisible(false); }
});

it('starts a new paused schedule with current policy and notification defaults after editing a different schedule', async () => {
  const f = projectFixture(true);
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-inapp"]').setValue(false); await f.view.get('[data-testid="schedule-queue-seconds"]').setValue('12.5');
    await f.view.findAll('button').find(button => button.text() === '新建计划')!.trigger('click'); await flushPromises();
    expect((f.view.get('[data-testid="schedule-inapp"]').element as HTMLInputElement).checked).toBe(true);
    expect((f.view.get('[data-testid="schedule-queue-seconds"]').element as HTMLInputElement).value).toBe('300');
  } finally { f.execution.setVisible(false); }
});
it('keeps a new draft selected when an earlier detail lookup completes after New', async () => {
  const f = projectFixture(true); let release!: () => void; f.delayDetail(new Promise<void>(resolve => { release = resolve; }));
  try {
    await openSchedules(f); await f.view.get('[data-testid="schedule-open"]').trigger('click'); await flushPromises();
    await f.view.findAll('button').find(button => button.text() === '新建计划')!.trigger('click'); release(); await flushPromises();
    expect(f.online.schedules.selected).toBeNull();
  } finally { f.execution.setVisible(false); }
});
it('offers an initially collapsed full fingerprint and comparison values for inspection', async () => {
  const f = projectFixture(true);
  try {
    await inspectSaved(f); expect(f.view.text()).toContain('展开完整指纹');
    const full = f.view.get('[data-testid="schedule-full-fingerprint"]'); expect(full.attributes('open')).toBeUndefined(); expect(full.get('code').text()).toBe('a'.repeat(64));
    await f.view.get('[data-testid="schedule-refresh-snapshot"]').trigger('click'); await flushPromises();
    expect(f.view.get('[data-testid="schedule-snapshot-diff"]').text()).toContain('完整比较值');
  } finally { f.execution.setVisible(false); }
});
it('discards a server preview that finishes after its rule or zone has changed', async () => {
  const f = projectFixture(); let release!: () => void; f.delayPreview(new Promise<void>(resolve => { release = resolve; }));
  try {
    await openSchedules(f); await f.view.get('[data-testid="schedule-preview"]').trigger('click'); await flushPromises();
    await f.view.get('[data-testid="schedule-zone"]').setValue('America/New_York'); release(); await flushPromises();
    expect(f.view.find('[data-testid="schedule-preview-results"]').exists()).toBe(false);
  } finally { f.execution.setVisible(false); }
});
it('discards a refresh preparation that finishes after its execution inputs changed', async () => {
  const f = projectFixture(true); let release!: () => void; f.delayPrepare(new Promise<void>(resolve => { release = resolve; }));
  const otherId = '00000000-0000-4000-8000-000000000092'; f.execution.project!.workflows.push({ id: otherId, name: 'Other', status: 'enabled', nodes: [{ id: 'noop', kind: 'noop' }], edges: [] }); f.execution.saved = JSON.stringify(f.execution.project);
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-refresh-snapshot"]').trigger('click'); await flushPromises();
    await f.view.get('[data-testid="schedule-target"]').setValue('workflow:' + otherId); release(); await flushPromises();
    expect(f.view.find('[data-testid="schedule-confirm-refresh"]').exists()).toBe(false);
  } finally { f.execution.setVisible(false); }
});
it.each([
  ['schedule-manage-required', '需要本项目定时任务管理权限'], ['schedule-permission-denied', '需要本项目定时任务管理权限'],
  ['schedule-capacity', '计划数量已达到生效上限'], ['schedule-policy-conflict', '计划设置超出生效策略'],
  ['agent-configuration-pending', '代理配置尚未应用'], ['schedule-misfire-skipped', '错过触发已按策略跳过'],
  ['channel-unavailable', '通知渠道当前不可用'], ['payload-too-large', '通知安全摘要超出大小上限'], ['payload-unavailable', '通知安全摘要不可用'],
  ['notification-http', '通知端点未确认投递'], ['notification-dispatch', '通知投递过程失败'],
] as const)('explains the current producer admission/delivery reason %s', async (reason, text) => {
  const f = projectFixture(); try { await openSchedules(f); f.online.schedules.error = reason; await flushPromises(); expect(f.view.get('[role="alert"]').text()).toContain(text); } finally { f.execution.setVisible(false); }
});

it('advances notification event and retained-source cursors independently without losing the other facts', async () => {
  const f = projectFixture(true, false, 'paging');
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-notification-history-open"]').trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('更多事件'); expect(f.view.text()).toContain('更多来源');
    await f.view.get('[data-testid="schedule-notification-events-more"]').trigger('click'); await flushPromises();
    expect(f.calls.filter(c => c.operation === 'notificationHistory').at(-1)).toEqual({ operation: 'notificationHistory', context: f.context, id: '9007199254740993', limit: 25, beforeId: '44' });
    expect(f.online.schedules.notificationHistory!.sources).toHaveLength(1);
    await f.view.get('[data-testid="schedule-notification-sources-more"]').trigger('click'); await flushPromises();
    expect(f.calls.filter(c => c.operation === 'notificationHistory').at(-1)).toEqual({ operation: 'notificationHistory', context: f.context, id: '9007199254740993', limit: 25, sourceBeforeId: '55' });
    expect(f.online.schedules.notificationHistory!.items).toHaveLength(1);
  } finally { f.execution.setVisible(false); }
});

it('opens the same original job report from schedule history repeatedly without creating or running any job', async () => {
  const f = projectFixture(true, false, 'history', 'job-history');
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises();
    expect(f.view.get('[data-testid="schedule-history"]').text()).toContain('查看原任务报告');
    await f.view.get('[data-testid="schedule-original-report"]').trigger('click'); await flushPromises();
    expect(f.view.get('[data-testid="online-execution-report"]').text()).toContain('失败');
    await f.view.get('[data-testid="schedule-original-report"]').trigger('click'); await flushPromises();
    expect(f.executionCalls.map(input => [input.operation, input.runId])).toEqual([['status', '78'], ['report', '78'], ['status', '78'], ['report', '78']]);
    expect(f.calls.filter(input => input.operation === 'prepare' || input.operation === 'save')).toEqual([]);
  } finally { f.execution.setVisible(false); }
});

it('does not open a different original job returned for the occurrence', async () => {
  const f = projectFixture(true, false, 'history', 'job-history'); f.mismatchJob();
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises();
    await f.view.get('[data-testid="schedule-original-report"]').trigger('click'); await flushPromises();
    expect(f.executionCalls.filter(input => input.operation === 'report')).toEqual([]);
    expect(f.execution.report).toBeNull();
  } finally { f.execution.setVisible(false); }
});
it('discards a report status lookup that finishes after switching owner and project', async () => {
  const f = projectFixture(true, false, 'history', 'job-history'); let release!: () => void;
  f.delayStatus(new Promise<void>(resolve => { release = resolve; }));
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises();
    await f.view.get('[data-testid="schedule-original-report"]').trigger('click'); await flushPromises();
    f.execution.activate({ ...f.context, ownerId: '8', scope: { ...f.context.scope, projectId: '44' } });
    release(); await flushPromises();
    expect(f.executionCalls.filter(input => input.operation === 'report')).toEqual([]);
    expect(f.execution.report).toBeNull();
  } finally { f.execution.setVisible(false); }
});

function configurationState(f: ReturnType<typeof projectFixture>, state: 'applied' | 'pending' | 'restart-required') {
  const agents = scheduleAgents();
  agents.agents[0]!.configuration = { configVersion: state === 'applied' ? '0' : '1', appliedConfigVersion: '0', status: state, pendingFields: state === 'pending' ? ['maxConcurrentJobs'] : [], restartRequiredFields: state === 'restart-required' ? ['childMaxOldSpaceMiB'] : [] };
  f.execution.agents = ProjectExecutionAgentsSchema.parse(agents);
}
// Human accepted this exact protection's ordering deviation. This is explicitly post-hoc validation.
it.each(['applied', 'pending', 'restart-required'] as const)('posthoc accepted B5c configuration option protection for %s', async state => {
  const f = projectFixture(); configurationState(f, state);
  try { await openSchedules(f); const option = f.view.get('[data-testid="schedule-agent"] option[value="5"]'); expect((option.element as HTMLOptionElement).disabled).toBe(state !== 'applied'); }
  finally { f.execution.setVisible(false); }
});
// New actual presentation bug is independent from the accepted, already-written protection.
it.each([['pending', '配置尚未应用', 'Configuration not yet applied'], ['restart-required', '配置需重启后应用', 'Configuration requires restart']] as const)('explains the unavailable configuration option for %s in both languages', async (state, zh, en) => {
  const f = projectFixture(); configurationState(f, state);
  try {
    await openSchedules(f); expect(f.view.get('[data-testid="schedule-agent"] option[value="5"]').text()).toContain(zh);
    f.i18n.global.locale.value = 'en'; await flushPromises(); expect(f.view.get('[data-testid="schedule-agent"] option[value="5"]').text()).toContain(en);
  } finally { f.execution.setVisible(false); }
});

it('captures task and script run settings in milliseconds for saved preparation', async () => {
  const f = projectFixture();
  try {
    await openSchedules(f); expect(f.view.text()).toContain('任务期限（秒）');
    await f.view.get('[data-testid="schedule-name"]').setValue('Timed'); await f.view.get('[data-testid="schedule-target"]').setValue('workflow:' + workflowId); await f.view.get('[data-testid="schedule-agent"]').setValue('5');
    await f.view.get('[data-testid="schedule-job-seconds"]').setValue('30.5'); await f.view.get('[data-testid="schedule-script-seconds"]').setValue('2.5');
    await f.view.get('[data-testid="schedule-save"]').trigger('click'); await flushPromises();
    expect(f.calls.find(input => input.operation === 'prepare')!.input.runConfig).toEqual({ jobTimeoutMs: 30500, scriptTimeoutMs: 2500 });
  } finally { f.execution.setVisible(false); }
});

it('selects an explicit fixed credential version from metadata without exposing or uploading a secret', async () => {
  const f = projectFixture();
  try {
    await openSchedules(f); expect(f.view.text()).toContain('材料版本策略');
    await f.view.get('[data-testid="schedule-material-options"]').trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('api-token'); expect(f.view.text()).toContain('触发时当前版本');
    await f.view.get('[data-testid="schedule-credential-mode"]').setValue('fixed-version');
    await f.view.get('[data-testid="schedule-name"]').setValue('Fixed material'); await f.view.get('[data-testid="schedule-target"]').setValue('workflow:' + workflowId); await f.view.get('[data-testid="schedule-agent"]').setValue('5');
    await f.view.get('[data-testid="schedule-save"]').trigger('click'); await flushPromises();
    expect(f.calls.find(input => input.operation === 'prepare')!.input.credentialBindings).toEqual([{ refId: 'api-token', mode: 'fixed-version', version: '2' }]);
    expect(f.calls.some(input => 'value' in input)).toBe(false);
  } finally { f.execution.setVisible(false); }
});

it('loads more schedules and explicitly deletes only the selected decimal version', async () => {
  const f = projectFixture(true); f.listNext('9007199254740992');
  try {
    await openSchedules(f); expect(f.view.text()).toContain('更多计划');
    await f.view.get('[data-testid="schedule-list-more"]').trigger('click'); await flushPromises();
    expect(f.calls.filter(input => input.operation === 'list').at(-1)).toMatchObject({ beforeId: '9007199254740992', limit: 25 });
    await f.view.get('[data-testid="schedule-open"]').trigger('click'); await flushPromises();
    expect(f.view.text()).toContain('删除计划');
    await f.view.get('[data-testid="schedule-delete-confirm"]').setValue(true); await f.view.get('[data-testid="schedule-delete"]').trigger('click'); await flushPromises();
    expect(f.calls.find(input => input.operation === 'remove')).toEqual({ operation: 'remove', context: f.context, id: '9007199254740993', expectedVersion: '9007199254740995' });
    expect(f.online.schedules.items).toEqual([]);
  } finally { f.execution.setVisible(false); }
});

it('revokes enable consent and a prepared refresh when execution input changes while keeping risk tied to the fixed snapshot', async () => {
  const f = projectFixture(true); const otherWorkflow = '00000000-0000-4000-8000-000000000092';
  f.execution.project!.workflows.push({ id: otherWorkflow, name: 'Different target', status: 'enabled', nodes: [{ id: 'noop', kind: 'noop' }], edges: [] }); f.execution.saved = JSON.stringify(f.execution.project);
  try {
    await inspectSaved(f); await f.view.get('[data-testid="schedule-risk-confirm"]').setValue(true);
    await f.view.get('[data-testid="schedule-refresh-snapshot"]').trigger('click'); await flushPromises();
    await f.view.get('[data-testid="schedule-target"]').setValue('workflow:' + otherWorkflow); await flushPromises();
    expect.soft((f.view.get('[data-testid="schedule-risk-confirm"]').element as HTMLInputElement).checked).toBe(false);
    expect.soft(f.view.get('.risk').text()).toContain(workflowId); expect.soft(f.view.get('.risk').text()).not.toContain(otherWorkflow);
    expect(f.view.find('[data-testid="schedule-confirm-refresh"]').exists()).toBe(false);
  } finally { f.execution.setVisible(false); }
});

it('keeps the schedule workspace focused on saved scheduling and original reports', async () => {
  const f = projectFixture(true, false, 'history', 'job-history');
  try {
    await inspectSaved(f); expect(f.view.text()).not.toContain('下一次运行（当前配置）');
    await f.view.get('[data-testid="schedule-history-open"]').trigger('click'); await flushPromises(); await f.view.get('[data-testid="schedule-original-report"]').trigger('click'); await flushPromises();
    expect(f.view.get('[data-testid="online-execution-report"]').text()).toContain('失败');
    expect(f.view.text()).not.toContain('下一次运行（当前配置）');
  } finally { f.execution.setVisible(false); }
});

it('localizes the actual Electron-wrapped safe conflict code', async () => {
  const f = projectFixture(true, "Error invoking remote method 'online:scheduling': Error: version_conflict");
  try { await inspectSaved(f); await f.view.get('[data-testid="schedule-name"]').setValue('Draft'); await f.view.get('[data-testid="schedule-update"]').trigger('click'); await flushPromises(); expect(f.view.get('[role="alert"]').text()).toContain('版本冲突'); }
  finally { f.execution.setVisible(false); }
});

it.each([
  ['schedule-queue-expired', '排队已超过绝对截止时间', 'Queue exceeded its absolute deadline'],
  ['schedule-evaluation-limit', '规则求值预算已耗尽', 'Rule evaluation budget exhausted'],
  ['schedule-subject-unauthorized', '执行主体已无调度权限', 'Execution subject no longer has scheduling permission'],
  ['schedule-subject-unavailable', '执行主体已停用或不可用', 'Execution subject disabled or unavailable'],
  ['schedule-material-unavailable', '计划材料不可用', 'Scheduled materials unavailable'],
  ['schedule-catchup-gap', '只补最近一次，此前缺口已封存', 'Only the latest trigger was caught up; earlier gaps were sealed'],
  ['schedule-overlap-skipped', '已有运行占用，跳过重叠触发', 'Skipped because an earlier execution is active'],
  ['schedule-interval-too-short', '触发间隔低于有效上限要求', 'Trigger interval is shorter than the effective minimum'],
  ['notification-channel-unavailable', '所选通知渠道不可用', 'Selected notification channel unavailable'],
  ['outbound-denied', '通知出站目标未获部署许可', 'Notification destination is not permitted by deployment policy'],
  ['channel-changed', '渠道版本已变更，旧投递已停止', 'Channel changed; the old delivery was stopped'],
  ['delivery-exhausted', '投递尝试次数已耗尽', 'Delivery attempts exhausted'],
  ['delivery-expired', '投递总期限已过', 'Delivery lifetime expired'],
] as const)('presents the safe reason %s in business language and preserves unknown codes', async (reason, zh, en) => {
  const f = projectFixture();
  try { await openSchedules(f); f.online.schedules.error = reason; await flushPromises(); expect(f.view.get('[role="alert"]').text()).toContain(zh); f.i18n.global.locale.value = 'en'; await flushPromises(); expect(f.view.get('[role="alert"]').text()).toContain(en); f.online.schedules.error = 'future-safe-reason'; await flushPromises(); expect(f.view.get('[role="alert"]').text()).toBe('future-safe-reason'); }
  finally { f.execution.setVisible(false); }
});
