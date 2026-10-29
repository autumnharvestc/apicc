// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import StressReportView from "../../../src/renderer/src/components/StressReportView.vue";
import { stressV2Report } from "../../helpers/stressV2.js";
import StressPanel from "../../../src/renderer/src/components/StressPanel.vue";
import { createStressStore } from "../../../src/renderer/src/stores/stress.js";
import { contractAssetFixture } from "../helpers/contract-assets.js";
import { compareStressReports } from "@apicc/core";
import { evaluateStressMetricsThresholds } from '../../../../../packages/core/src/stress/thresholds.js';
import OnlineProjectAssets from '../../../src/renderer/src/components/online/OnlineProjectAssets.vue';
import { createOnlineStore } from '../../../src/renderer/src/stores/online.js';
import { createOnlineProjectAdapter } from '../../../src/renderer/src/stores/onlineProjectAdapter.js';
import { ContractWorkspaceSchema, StressPlanSchema, StressReportV2Schema } from '@apicc/core/schema';
import { workspaceFixture } from '../../../../../packages/core/tests/helpers/contractFixtures.js';
import {renderStressHtml} from '@apicc/core';
import {summarizeStressExecution} from '@apicc/execution/client';
import type {StressExecutionSummary} from '@apicc/core';
enableAutoUnmount(afterEach);
beforeAll(() => {
  const style = window.getComputedStyle; window.getComputedStyle = element => style.call(window, element);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
describe("stress workbench report", () => {
  it('final I2 and I4 carry bounded process facts and typed possible contention into readable summary and HTML',async()=>{
    const report=stressV2Report(),runtime={coreBuildId:'a'.repeat(64),scriptApiId:'b'.repeat(64),nodeVersion:'22.19.0',v8Version:'12.4',runtimeCompatibilityId:'compatible'};
    report.plan.maxVus=2;report.plan.load={kind:'constant-vus',vus:2};report.load.maxVus=2;StressReportV2Schema.parse(report);
    const observation={completeness:'complete' as const,started:3,exited:3,peak:3};
    // New optional wire value is structurally inspected through the existing adapter; no missing export/schema error is used as RED.
    const local={workerCount:2,processBudget:3,runtime,processObservation:observation};
    const summary=summarizeStressExecution({report,local})!;
    expect.soft((summary as unknown as Record<string,unknown>).processObservation).toEqual(observation);
    const execution={...summary,location:'agent',executorId:'5',executorName:'Actual agent',processObservation:observation,contentionHints:[{code:'shared-agent-capacity',jobLimit:2,stressJobLimit:2,activeOtherJobs:1}]} as unknown as StressExecutionSummary;
    const {i18n}=createI18nInstance();i18n.global.locale.value='zh-CN';const view=mount(StressReportView,{props:{report,execution},global:{plugins:[i18n]}});
    const visible=view.get('[data-testid="stress-execution-summary"]');
    expect.soft(visible.text()).toContain('实际启动 3');expect.soft(visible.text()).toContain('实际退出 3');expect.soft(visible.text()).toContain('同时存活峰值 3');expect.soft(visible.text()).not.toContain('未采集实际进程数');
    expect.soft(visible.text()).toContain('可能竞争');expect.soft(visible.text()).toContain('1');expect.soft(visible.text()).not.toMatch(/shared-agent-capacity|jobLimit|stressJobLimit|activeOtherJobs|\[object Object\]/);
    const doc=new DOMParser().parseFromString(renderStressHtml(report,undefined,{execution}),'text/html');new Function('document',doc.querySelector('script')!.textContent!)(doc);const html=doc.querySelector('[data-section="execution"]')!;
    expect.soft(html.textContent).toContain('实际启动 3');expect.soft(html.textContent).toContain('同时存活峰值 3');expect.soft(html.textContent).toContain('可能竞争');expect.soft(html.textContent).not.toContain('[object Object]');
    i18n.global.locale.value='en';await flushPromises();expect.soft(visible.text()).toContain('Started 3');expect.soft(visible.text()).toContain('Possible contention');
    const legacy={...summary,contentionHints:[]};delete (legacy as unknown as Record<string,unknown>).processObservation;await view.setProps({execution:legacy});expect.soft(visible.text()).toContain('not collected');
  });
  it('final I5 localizes the actual project-policy and trusted safety decisions in desktop and HTML',async()=>{
    // Exact safe decision codes observed in native-report-68.html and produced by caseSession.
    const report=stressV2Report();report.safety={availability:'available',targetOrigins:[{origin:'http://synthetic.test',confirmation:'project-policy',policy:'trusted'},{origin:'http://business.test',confirmation:'business-confirmation',policy:'business-policy'}]};StressReportV2Schema.parse(report);
    const {i18n}=createI18nInstance();i18n.global.locale.value='zh-CN';const view=mount(StressReportView,{props:{report},global:{plugins:[i18n]}});
    const safety=view.findAll('details').find(detail=>detail.get('summary').text()===i18n.global.t('stress.safety'))!;
    expect.soft(safety.text()).toContain('项目策略授权');expect.soft(safety.text()).toContain('受信任');expect(safety.text()).toContain('business-confirmation');
    const doc=new DOMParser().parseFromString(renderStressHtml(report),'text/html');new Function('document',doc.querySelector('script')!.textContent!)(doc);
    const htmlSafety=doc.querySelector('[data-section="host"]')!;expect.soft(htmlSafety.textContent).toContain('项目策略授权');expect.soft(htmlSafety.textContent).toContain('受信任');expect(htmlSafety.textContent).toContain('business-policy');
    i18n.global.locale.value='en';await flushPromises();expect.soft(safety.text()).toContain('Authorized by project policy');expect.soft(safety.text()).toContain('Trusted');
    const language=doc.querySelector<HTMLSelectElement>('#language')!;language.value='en';language.dispatchEvent(new Event('change'));expect.soft(htmlSafety.textContent).toContain('Authorized by project policy');expect.soft(htmlSafety.textContent).toContain('Trusted');
  });
  it('final I5 explains unavailable data and safety codes and rounds only visible lifecycle duration',async()=>{
    const report=stressV2Report();report.rps={availability:'unavailable',reason:'no-data'};report.latency={availability:'unavailable',reason:'incomplete'};
    report.completeness.metrics={complete:false,reasons:['worker-missing']};report.verdict={status:'incomplete',passed:false,violations:[]};
    report.lifecycle=[{role:'vuSetup',vuId:'business-vu',state:'passed',durationMs:1.234567891}];
    report.safety={availability:'available',targetOrigins:[{origin:'http://business.test',confirmation:'confirmed',policy:'allowed'},{origin:'http://unknown.test',confirmation:'business-confirmation',policy:'business-policy'}]};
    StressReportV2Schema.parse(report);
    const {i18n}=createI18nInstance();i18n.global.locale.value='zh-CN';const view=mount(StressReportView,{props:{report},global:{plugins:[i18n]}});
    const counts=view.get('[data-testid="stress-request-counts"]');expect.soft(counts.text()).toContain('无合格样本');expect.soft(counts.text()).toContain('不完整');expect.soft(counts.text()).not.toMatch(/no-data|\(incomplete\)/);
    const safety=view.findAll('details').find(detail=>detail.get('summary').text()===i18n.global.t('stress.safety'))!;
    expect(safety).toBeDefined();expect.soft(safety.text()).toContain('已确认');expect.soft(safety.text()).toContain('允许');expect(safety.text()).toContain('business-confirmation');expect(safety.text()).toContain('business-policy');
    const lifecycle=view.findAll('details').find(detail=>detail.get('summary').text()==='生命周期')!;expect.soft(lifecycle.text()).toContain('1.23 ms');expect.soft(lifecycle.text()).not.toContain('1.234567891');expect(report.lifecycle[0]!.durationMs).toBe(1.234567891);
    i18n.global.locale.value='en';await flushPromises();expect.soft(counts.text()).toContain('No eligible samples');expect.soft(counts.text()).toContain('Incomplete');expect.soft(safety.text()).toContain('Confirmed');expect.soft(safety.text()).toContain('Allowed');
  });
  // Final I5: formal phase codes must be localized in the actual source rows and legend, not just the page heading.
  it('final I5 localizes measured phase sources and legends while retaining the business stage ID',async()=>{
    const report=stressV2Report();report.phases[0]!.stageId='business-stage';report.timeline.buckets[0]!.sources[0]!.stageId='business-stage';StressReportV2Schema.parse(report);
    const {i18n}=createI18nInstance();i18n.global.locale.value='zh-CN';const view=mount(StressReportView,{props:{report},global:{plugins:[i18n]}});
    const trend=view.get('[data-testid="stress-trend"]');
    expect.soft(trend.get('.phase-legend').text()).toContain('测量');expect.soft(trend.get('.phase-legend').text()).not.toContain('measurement');
    expect.soft(trend.findAll('tbody tr')[0]!.text()).toContain('测量');expect(trend.get('.phase-legend').text()).toContain('business-stage');
    i18n.global.locale.value='en';await flushPromises();expect.soft(trend.get('.phase-legend').text()).toContain('Measurement');expect(trend.get('.phase-legend').text()).toContain('business-stage');
  });
  // Final I5: real Core threshold output remains numeric, but its visible diagnosis needs metric names and units.
  it('final I5 formats real Core threshold violations as percentages milliseconds and request rates',async()=>{
    const report=stressV2Report();report.requests.failed=1;
    const verdict=evaluateStressMetricsThresholds({requests:report.requests,eligibleFailureCounts:{transport:0,http:1,script:0,assertion:0,config:0,aborted:0,extraction:0},latency:report.latency,rps:report.rps,failedIterations:0},{maxErrorRate:0.2,maxP95Ms:5,minRps:2});
    report.verdict={...verdict,status:'failed'};StressReportV2Schema.parse(report);
    const {i18n}=createI18nInstance();i18n.global.locale.value='zh-CN';const view=mount(StressReportView,{props:{report},global:{plugins:[i18n]}});
    const violations=view.findAll('details').find(detail=>detail.get('summary').text().includes('阈值'))!;
    expect(violations).toBeDefined();
    expect.soft(violations.text()).toContain('错误率');expect.soft(violations.text()).toMatch(/100(?:\.0+)?%/);expect.soft(violations.text()).toMatch(/20(?:\.0+)?%/);
    expect.soft(violations.text()).toMatch(/10(?:\.0+)? ms/);expect.soft(violations.text()).toMatch(/5(?:\.0+)? ms/);expect.soft(violations.text()).toMatch(/1(?:\.0+)? 请求\/秒/);expect.soft(violations.text()).toMatch(/2(?:\.0+)? 请求\/秒/);
    i18n.global.locale.value='en';await flushPromises();expect.soft(violations.text()).toMatch(/error rate/i);expect.soft(violations.text()).toMatch(/1(?:\.0+)? requests\/s/);
    expect(report.verdict.violations.map(value=>({metric:value.metric,actual:value.actual,expected:value.expected}))).toEqual([{metric:'errorRate',actual:1,expected:0.2},{metric:'p95',actual:10,expected:5},{metric:'rps',actual:1,expected:2}]);
  });
  // I2: undefined arrival fields have different meanings in VU and arrival modes.
  it.each(['constant-vus','constant-arrival'] as const)('T7 R1 distinguishes arrival applicability from missing observations for %s',async kind=>{
    const report=stressV2Report();if(kind==='constant-arrival'){report.plan.load={kind,rate:1};report.plan.termination={durationMs:1000};report.load.plannedDurationMs=1000;}StressReportV2Schema.parse(report);
    const {i18n}=createI18nInstance();i18n.global.locale.value='zh-CN';const view=mount(StressReportView,{props:{report},global:{plugins:[i18n]}});
    const want=kind==='constant-vus'?'不适用':'未采集';
    expect.soft(view.text()).toContain(`目标迭代启动数/秒 ${want}`);expect.soft(view.text()).toContain(`实际迭代启动数/秒 ${want}`);
    if(kind==='constant-arrival'){report.load.actualStartRate={availability:'unavailable',reason:'incomplete'};report.completeness.metrics={complete:false,reasons:['worker-missing']};report.verdict={status:'incomplete',passed:false,violations:[]};StressReportV2Schema.parse(report);await view.setProps({report:structuredClone(report)});expect(view.text()).toContain('实际迭代启动数/秒 不完整');}
  });
  // I3: real Core camel-case lifecycle roles and passed must use known localized labels.
  it('T7 R1 localizes real VU lifecycle roles and state while preserving business identifiers',async()=>{
    const report=stressV2Report();report.lifecycle=[{role:'vuSetup',vuId:'business-vu-1',state:'passed',durationMs:1.25},{role:'vuTeardown',vuId:'business-vu-1',state:'passed',durationMs:2.5}];StressReportV2Schema.parse(report);
    const {i18n}=createI18nInstance();i18n.global.locale.value='zh-CN';const view=mount(StressReportView,{props:{report},global:{plugins:[i18n]}});
    const lifecycle=view.findAll('details').find(details=>details.get('summary').text()==='生命周期')!;(lifecycle.get('summary').element as HTMLElement).click();await flushPromises();expect((lifecycle.element as HTMLDetailsElement).open).toBe(true);
    for(const label of ['VU 准备','VU 收尾','通过','business-vu-1','1.25 ms','2.5 ms'])expect.soft(lifecycle.text()).toContain(label);
    for(const code of ['vuSetup','vuTeardown','passed'])expect.soft(lifecycle.text()).not.toContain(code);
    i18n.global.locale.value='en';await flushPromises();for(const label of ['VU setup','VU teardown','Passed','business-vu-1'])expect.soft(lifecycle.text()).toContain(label);
  });
  // Execute the generated report's own language/filter handlers and inspect actual DOM text.
  it('T7 switches the offline report to readable English and keeps raw data collapsed',()=>{
    const report=stressV2Report();
    report.requests.failed=1;report.completeness.metrics={complete:false,reasons:['worker-missing']};report.verdict={status:'incomplete',passed:false,violations:[]};StressReportV2Schema.parse(report);
    const html=renderStressHtml(report,compareStressReports(report,report),{execution:{location:'local',executorId:'local',executorName:'',workerCount:1,processBudget:1,runtime:{coreBuildId:'a'.repeat(64),scriptApiId:'b'.repeat(64),nodeVersion:'22.19.0',v8Version:'12.4',runtimeCompatibilityId:'compatible'},limits:{maxVus:1,requestConcurrency:1,maxRps:null}},comparison:{directlyComparable:false,reasons:['metadata']}});
    // Optional, test-only artifact output for the controller's concentrated browser review.
    if(process.env.APICC_T7_ARTIFACT_DIR)writeFileSync(join(process.env.APICC_T7_ARTIFACT_DIR,'t7-readable-report.html'),html,'utf8');
    const doc=new DOMParser().parseFromString(html,'text/html');new Function('document',doc.querySelector('script')!.textContent!)(doc);
    const language=doc.querySelector<HTMLSelectElement>('#language')!;language.value='en';language.dispatchEvent(new Event('change'));
    expect(doc.querySelector('[data-section="execution"]')!.textContent).toContain('Execution process budget');
    expect(doc.querySelector('[data-section="execution"]')!.textContent).toContain('No request RPS limit');
    expect(doc.querySelector('[data-section="comparison"]')!.textContent).toContain('Execution metadata not collected');
    expect(doc.querySelector('[data-section="timeline"]')!.textContent).toContain('single point');
    expect(doc.querySelector('details.raw-data')!.hasAttribute('open')).toBe(false);
    const filter=doc.querySelector<HTMLInputElement>('#filter')!;filter.value='Execution process budget';filter.dispatchEvent(new Event('input'));expect(doc.querySelector<HTMLElement>('#execution')!.hidden).toBe(false);expect(doc.querySelector<HTMLElement>('#nodes')!.hidden).toBe(true);
  });
  it('T7 explains zero and one observed buckets without drawing across unobserved time',async()=>{
    const report=stressV2Report(),{i18n}=createI18nInstance();i18n.global.locale.value='en';
    const view=mount(StressReportView,{props:{report},global:{plugins:[i18n]}});
    expect.soft(view.get('[data-testid="stress-trend"]').text()).toContain('single point');
    const sparse=structuredClone(report);sparse.timeline.buckets.push({...structuredClone(sparse.timeline.buckets[0]!),startOffsetMs:5000,endOffsetMs:6000});await view.setProps({report:sparse});
    expect.soft(view.findAll('path.series').some(path=>(path.attributes('d')??'').includes(' L'))).toBe(false);
    sparse.timeline.buckets=[];await view.setProps({report:structuredClone(sparse)});
    expect.soft(view.get('[data-testid="stress-trend"]').text()).toContain('No time buckets');
  });
  // Logical recovery cannot erase request failures, integrity loss or the absent RPS cap.
  it('T7 keeps logical success, request failures, integrity and execution budget readable', async () => {
    const report=stressV2Report();report.requests.failed=1;report.completeness.metrics={complete:false,reasons:['worker-missing']};report.verdict={status:'incomplete',passed:false,violations:[]};StressReportV2Schema.parse(report);
    const {i18n}=createI18nInstance();i18n.global.locale.value='zh-CN';
    const execution={location:'local',executorId:'local',executorName:'本机',workerCount:1,processBudget:1,runtime:{coreBuildId:'a'.repeat(64),scriptApiId:'b'.repeat(64),nodeVersion:'22.19.0',v8Version:'12.4',runtimeCompatibilityId:'runtime'}};
    const view=mount(StressReportView,{props:{report},attrs:{execution},global:{plugins:[i18n]}});
    expect.soft(view.text()).toContain('逻辑结论');expect.soft(view.text()).toContain('通过');
    expect.soft(view.text()).toContain('请求失败 1');expect.soft(view.text()).toContain('指标完整性: 不完整');
    expect.soft(view.text()).toContain('执行进程预算: 1');expect.soft(view.text()).toContain('未采集实际进程数');
    expect.soft(view.text()).toContain('未设置请求速率上限');
    expect.soft(view.get('[data-testid="stress-iteration-counts"]').text()).toContain('已完成');
    expect.soft(view.text()).not.toContain('planned');
    const historical=structuredClone(report);delete historical.load.effectiveMaxRps;await view.setProps({report:historical});
    expect.soft(view.text()).not.toContain('未设置请求速率上限');
  });
  // The standalone form is insufficient unless the real online project navigation can reach it.
  it('opens the real saved stress plan entry from the online project tab', async () => {
    const f = await contractAssetFixture(), online = createOnlineStore({ api: f.api }), execution = online.execution;
    const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
    const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    project.workflows = [{ id: '00000000-0000-4000-8000-000000000091', name: 'Online scenario', status: 'enabled', nodes: [{ id: 'noop', kind: 'noop' }], edges: [] }];
    project.stressPlans = [{ formatVersion: 1, id: 'saved', name: 'Online saved plan', updatedAt: 0, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId: project.workflows[0]!.id }, load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 1 } }) }];
    execution.activate(context); execution.setVisible(true); execution.project = project; execution.saved = JSON.stringify(project); execution.view = { project, problems: [], assets: { ...context.scope, format: 'contract-files-v1', contractProjectId: project.id, version: '1', manifestHash: 'a'.repeat(64), files: [] } };
    const adapter = createOnlineProjectAdapter(execution, f.api, () => true, () => true), { i18n } = createI18nInstance();
    const view = mount(OnlineProjectAssets, { props: { online, adapter, localProjects: [] }, global: { plugins: [i18n] } });
    try {
      const tab = view.findAll('nav.tabs button').find(button => button.text() === i18n.global.t('stress.title'));
      expect(tab?.exists()).toBe(true); await tab!.trigger('click'); await flushPromises();
      expect(view.get('[data-testid="online-stress-panel"]').text()).toContain('Online saved plan');
      expect(view.get('[data-testid="online-stress-location"]').text()).toContain(i18n.global.t('onlineExecution.local'));
    } finally { view.unmount(); adapter.stop(); execution.setVisible(false); }
  });
  it("edits rise/fall stages and arrival units, rejecting missing lifecycle references and unfinished input mappings", async () => {
    const f = await contractAssetFixture(); const flow = await f.api.wfCreate({ locator: f.projectLocator, name: 'scenario' });
    const s = createStressStore({ api: f.api, getContext: () => ({ root: f.root, locator: null, projectLocator: f.projectLocator }) });
    await s.openWorkbench(f.projectLocator, { kind: 'workflow', workflowId: flow.id });
    const { i18n } = createI18nInstance();
    const view = mount(StressPanel, { props: { stress: s, projectLocator: f.projectLocator, cases: [], envs: [], workflows: [flow], reportError: (e: unknown) => { throw e; } }, global: { plugins: [i18n] } });
    await view.get('[data-testid="stress-load-kind"]').setValue('stages');
    s.plan!.maxVus = 3;
    await view.get('[data-testid="stress-add-stage"]').trigger('click');
    const stages = view.findAll('[data-testid="stress-stage"]');
    await stages[0]!.findAll('input')[2]!.setValue(3); await stages[1]!.findAll('input')[2]!.setValue(1);
    expect(s.plan!.load).toMatchObject({ kind: 'stages', startTarget: 1, stages: [{ target: 3 }, { target: 1 }] });
    await view.get('[data-testid="stress-load-kind"]').setValue('constant-arrival');
    await view.get('[data-testid="stress-arrival-rate"]').setValue(7);
    expect(s.plan!.load).toEqual({ kind: 'constant-arrival', rate: 7 });
    expect(view.text()).toContain(i18n.global.t('stress.workbench.arrivalRate'));
    expect(view.text()).toContain(i18n.global.t('stress.workbench.httpRps'));
    await view.findAll('.lifecycle-step select')[0]!.setValue(flow.id);
    await view.findAll('.lifecycle-step')[0]!.findAll('button').find(b => b.text() === i18n.global.t('stress.workbench.addMapping'))!.trigger('click');
    expect(view.get('[data-testid="stress-plan-start"]').attributes('disabled')).toBeDefined();
    const mappingInputs = view.findAll('.lifecycle-step')[0]!.findAll('.input-row input');
    await mappingInputs[0]!.setValue('token'); await mappingInputs[1]!.setValue('initialToken');
    expect(s.plan!.lifecycle!.setup).toEqual({ workflowId: flow.id, outputs: { token: 'initialToken' } });
    await view.setProps({ workflows: [] });
    expect(view.find('[data-testid="stress-reference-error"]').exists()).toBe(true);
    expect(view.get('[data-testid="stress-plan-start"]').attributes('disabled')).toBeDefined();
  });
  it("keeps the explicit baseline independent of the report filter and exports its exact selection without inventing zero percentages", async () => {
    const f = await contractAssetFixture();
    const s = createStressStore({ api: f.api, getContext: () => ({ root: f.root, locator: null, projectLocator: f.projectLocator }) });
    const report = stressV2Report(); report.projectId = f.projectLocator.projectId;
    const base = structuredClone(report); base.rps = { availability: 'available', value: 0 };
    const exports: unknown[] = [];
    f.api.stressCompare = async (_scope, input) => { expect(input).toEqual({ baseFile: 'base.json', candidateFile: 'candidate.json' }); return compareStressReports(base, report); };
    f.api.stressExport = async (_scope, input) => { exports.push(input); return { saved: false, file: '' }; };
    await s.openWorkbench(f.projectLocator, report.target);
    f.api.stressRunsList = async () => ['base.json','candidate.json'].map(file => ({ kind: 'stress', projectId: report.projectId, file, startedAt: '2026-10-22', totalRequests: 1, ok: 1, failed: 0, rps: 1 }));
    s.planReport = report; s.planFile = 'candidate.json';
    const { i18n } = createI18nInstance();
    const view = mount(StressPanel, { props: { stress: s, projectLocator: f.projectLocator, workflows: [{ id: 'workflow', name: 'flow' }], cases: [], envs: [], reportError: (e: unknown) => { throw e; } }, global: { plugins: [i18n] } });
    await flushPromises(); await view.findAll('.pane-tabs button')[1]!.trigger('click');
    await view.get('[data-testid="stress-baseline"]').setValue('base.json'); await flushPromises();
    expect.soft(view.get('[data-testid="stress-comparison"]').text()).toContain(i18n.global.t('stressPresentation.reasons.metadata'));
    expect.soft(view.get('[data-testid="stress-comparison"]').text()).toContain(i18n.global.t('stressPresentation.environmentNotice'));
    expect.soft(view.get('[data-testid="stress-comparison"]').text()).toContain(i18n.global.t('stressPresentation.metrics.iterationsCompleted'));
    await view.get('[data-testid="stress-history-filter"]').setValue('nothing-matches');
    expect(s.baselineFile).toBe('base.json'); expect(view.findAll('.history-action')).toHaveLength(0);
    expect(view.get('[data-testid="stress-baseline"]').findAll('option')).toHaveLength(3);
    const rpsRow = view.get('[data-testid="stress-comparison"]').get('tr[data-metric="rps"]');
    expect(rpsRow.findAll('td')[3]!.text()).toBe('1'); expect(rpsRow.findAll('td')[4]!.text()).toBe(i18n.global.t('stress.workbench.notComputable'));
    await view.findAll('.export-tools button')[0]!.trigger('click'); await flushPromises();
    expect(exports).toEqual([{ file: 'candidate.json', baselineFile: 'base.json', format: 'html' }]);
    await view.get('[data-testid="stress-baseline-clear"]').trigger('click'); await flushPromises(); expect(s.comparison).toBeNull(); expect(s.baselineFile).toBeNull();
  });
  // Collapsing incomplete into a pass/fail, or treating recovered HTTP failures as iterations, loses facts.
  it("shows the authoritative incomplete verdict, separate counts and actual timeline coverage", async () => {
    const report = stressV2Report(); report.verdict = { status: "incomplete", passed: false, violations: [] };
    report.completeness.load = { complete: false, reasons: ["dropped"] }; report.iterations.planned = 3; report.iterations.dropped = 2;
    report.requests.failed = 1; report.timeline.bucketWidthMs = 2000;
    const { i18n } = createI18nInstance();
    const view = mount(StressReportView, { props: { report }, global: { plugins: [i18n] } });
    expect(view.get('[data-testid="stress-verdict"]').attributes("data-verdict")).toBe("incomplete");
    expect(view.get('[data-testid="stress-iteration-counts"]').text()).toContain("2");
    expect(view.get('[data-testid="stress-request-counts"]').text()).toContain("1");
    expect(view.get('[data-testid="stress-trend"]').text()).toContain("2000");
    expect(view.get('[data-testid="stress-trend"]').text()).toContain("rise");
    expect(view.text()).not.toContain("NaN");
    const beyond = structuredClone(report); beyond.statistics = { ...beyond.statistics, method: 'log-histogram', exact: false, relativeError: 0.01, underflow: 1, overflow: 2 };
    await view.setProps({ report: beyond });
    expect(view.text()).not.toContain('≤ 1%');
    expect(view.text()).toContain(i18n.global.t('stress.workbench.overflowPrecision'));
    expect(view.text()).toContain(i18n.global.t('stress.workbench.underflowPrecision', { resolution: 0.001 }));
    beyond.plan.load = { kind: 'constant-arrival', rate: 0.6 }; beyond.load.plannedDurationMs = 1000;
    await view.setProps({ report: structuredClone(beyond) });
    expect(view.text()).toContain(i18n.global.t('stress.workbench.arrivalWindow.quantization'));
    expect(view.text()).toContain(i18n.global.t('stress.workbench.arrivalWindow.incomplete-window'));
  });
});
