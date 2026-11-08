// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computeReport } from '@apicc/core';
import { StressReportV2Schema, StressReportSchema } from '@apicc/core/schema';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import StressReportView from '../../../src/renderer/src/components/StressReportView.vue';
import { stressV2Report } from '../../helpers/stressV2.js';

const originalStyle = window.getComputedStyle;
beforeAll(() => {
  window.getComputedStyle = element => originalStyle.call(window, element);
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
afterAll(() => { window.getComputedStyle = originalStyle; });
enableAutoUnmount(afterEach);
function language() { const { i18n } = createI18nInstance(); i18n.global.locale.value = 'zh-CN'; return i18n; }
const legacy = () => computeReport([{ requestStarted: true, requestCompleted: true, requestTimeMs: 10, status: 200, ok: true }], { concurrency: 1, startedAt: 0, finishedAt: 1000 });

describe('P3b stress presentation', () => {
  it.each(['legacy', 'v2'] as const)('preserves unknown safety codes even when they collide with status translations in %s', async kind => {
    const report = kind === 'v2' ? stressV2Report() : legacy(), i18n = language();
    report.safety = { availability: 'available', targetOrigins: [{ origin: 'https://literal.test', confirmation: 'http', policy: 'passed' }] };
    if (kind === 'v2') StressReportV2Schema.parse(report); else StressReportSchema.parse(report);
    const view = mount(StressReportView, { props: { report }, global: { plugins: [i18n] } });
    const safety = () => kind === 'legacy' ? view.get('[data-testid="stress-safety"]') : view.findAll('details').find(detail => detail.get('summary').text() === i18n.global.t('stress.safety'))!;
    const decisions = () => safety().findAll('p').find(p => p.text().includes(' · '))!.text().split(' · ').slice(kind === 'legacy' ? 0 : 1, kind === 'legacy' ? 2 : 3);
    expect(decisions()).toEqual(['http', 'passed']);
    i18n.global.locale.value = 'en'; await flushPromises();
    expect(decisions()).toEqual(['http', 'passed']);
  });
  it('distinguishes the recorded policy cap from the requested and effective run concurrency', () => {
    const report = legacy(), i18n = language(); i18n.global.locale.value = 'en';
    report.safety = { targetOrigins: [{ origin: 'https://business.test', confirmation: 'explicit', policy: 'none', appliedPolicy: { maxConcurrency: 3 } }], run: { requestedConcurrency: 2, effectiveConcurrency: 1, requestedMaxRps: null, effectiveMaxRps: null, connectionMode: 'pooled' } };
    StressReportSchema.parse(report);
    const view = mount(StressReportView, { props: { report }, global: { plugins: [i18n] } });
    const fields = view.get('[data-testid="stress-safety"]').findAll('dl > div').map(field => [field.get('dt').text(), field.get('dd').text()]);
    expect(fields).toContainEqual(['Policy concurrency limit', '3']);
    expect(fields).toContainEqual(['Requested concurrency limit', '2']); expect(fields).toContainEqual(['Effective concurrency limit', '1']);
  });
  it('labels every node count separately and preserves business IDs, missing latency and the other bucket', async () => {
    const report = stressV2Report(), i18n = language();
    report.nodes = [{ key: 'literal-key', workflowId: 'workflow-business', nodeId: 'passed', other: false, visits: 15, passed: 5, failed: 4, aborted: 3, skipped: 3, requests: { started: 12, completed: 11, eligibleCompleted: 9, failed: 4 }, requestLatency: report.latency, nodeLatency: { availability: 'unavailable', reason: 'no-data' } }, { key: 'other', workflowId: null, nodeId: null, other: true, visits: 0, passed: 0, failed: 0, aborted: 0, skipped: 0, requests: { started: 0, completed: 0, eligibleCompleted: 0, failed: 0 }, requestLatency: { availability: 'unavailable', reason: 'not-collected' }, nodeLatency: report.latency }];
    StressReportV2Schema.parse(report);
    const view = mount(StressReportView, { props: { report }, global: { plugins: [i18n] } });
    const table = view.get('[data-testid="stress-nodes"]');
    expect(table.findAll('th').map(cell => cell.text())).toEqual(['节点', '访问次数', '通过', '失败', '已中止', '跳过', '请求合格完成', '请求失败', 'HTTP p95', '节点 p95']);
    expect(table.findAll('tbody tr')[0]!.findAll('td').map(cell => cell.text())).toEqual(['workflow-business / passed', '15', '5', '4', '3', '3', '9', '4', '10 ms', '无合格样本']);
    expect(table.text()).toContain('其他节点'); expect(table.text()).toContain('未采集');
    i18n.global.locale.value = 'en'; await flushPromises();
    expect(table.text()).toContain('Other nodes'); expect(table.text()).toContain('Eligible requests'); expect(table.text()).toContain('workflow-business / passed');
  });
  it('shows lifecycle roles, raw VU IDs, duration and failure kind in named columns without changing the DTO', async () => {
    const report = stressV2Report(), i18n = language();
    report.lifecycle = [{ role: 'vuSetup', vuId: 'passed', state: 'failed', durationMs: 1.234567, failureKind: 'http' }, { role: 'teardown', vuId: null, state: 'passed', durationMs: 0 }];
    report.verdict = { status: 'failed', passed: false, violations: [] }; StressReportV2Schema.parse(report);
    const before = structuredClone(report);
    const view = mount(StressReportView, { props: { report }, global: { plugins: [i18n] } });
    const table = view.get('[data-testid="stress-lifecycle"]');
    expect(table.findAll('th').map(cell => cell.text())).toEqual(['角色', '虚拟用户', '状态', '耗时', '失败类型']);
    expect(table.findAll('tbody tr')[0]!.findAll('td').map(cell => cell.text())).toEqual(['VU 准备', 'passed', '失败', '1.23 ms', 'HTTP']);
    expect(table.find('[title="1.234567"]').exists()).toBe(true); expect(table.text()).toContain('0 ms');
    i18n.global.locale.value = 'en'; await flushPromises(); expect(table.text()).toContain('Run level'); expect(table.text()).toContain('Not applicable');
    expect(report).toEqual(before);
  });
  it('localizes legacy safety fields and units while retaining unknown decisions and exact origin strings', async () => {
    const report = legacy(), i18n = language();
    report.safety = { availability: 'partial', targetOrigins: [{ origin: 'https://business.test', confirmation: 'explicit', policy: 'custom-business-policy', appliedPolicy: { trustedOrigins: ['https://trusted.test'], deniedOrigins: ['https://denied.test'], maxConcurrency: 3, maxRps: 7 } }], run: { requestedConcurrency: 3, effectiveConcurrency: 2, requestedMaxRps: null, effectiveMaxRps: 7, connectionMode: 'pooled' } };
    report.generator = { availability: 'available', cpuUserMs: 0, cpuSystemMs: 0, rssStartBytes: 2097152, rssPeakBytes: 2097152, cpuPercent: 0, schedulerBacklogMax: 0, eventLoopDelayP95Ms: 0, saturated: false, reasons: [], limits: { cpuPercent: 90, eventLoopDelayP95Ms: 50, schedulerBacklog: 10 } };
    StressReportSchema.parse(report);
    const view = mount(StressReportView, { props: { report }, global: { plugins: [i18n] } });
    const safety = view.get('[data-testid="stress-safety"]');
    for (const text of ['回环地址', '未采集', '本次显式确认', 'custom-business-policy', 'https://trusted.test', 'https://denied.test', '7 请求/秒', '请求并发上限', '生效并发上限', '连接复用']) expect.soft(safety.text()).toContain(text);
    expect(safety.text()).not.toContain('loopback='); expect(safety.text()).not.toContain('requestedConcurrency=');
    expect(view.get('[data-testid="stress-generator"]').text()).toContain('2 MiB');
    i18n.global.locale.value = 'en'; await flushPromises();
    expect(safety.text()).toContain('Loopback'); expect(safety.text()).toContain('Not collected'); expect(safety.text()).toContain('custom-business-policy');
    expect(safety.text()).toContain('7 requests/s');
  });
  it('distinguishes legacy evidence not collected from an empty retained sample, in both languages', async () => {
    const report = legacy(), i18n = language(); delete report.failureEvidence;
    const view = mount(StressReportView, { props: { report }, global: { plugins: [i18n] } });
    const details = view.get('[data-testid="stress-evidence"]');
    expect(details.text()).toContain('未采集'); expect(details.attributes('open')).toBeUndefined();
    await view.setProps({ report: { ...report, failureEvidence: [] } }); expect(details.text()).toContain('没有保留的失败证据'); expect(details.text()).not.toContain('未采集');
    i18n.global.locale.value = 'en'; await flushPromises();
    expect(details.get('summary').text()).toContain('Failure evidence'); expect(details.text()).toContain('No retained failure evidence'); expect(details.text()).not.toContain('失败证据');
  });
});
