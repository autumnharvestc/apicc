// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { webcrypto } from 'node:crypto';
import type { AiEvidence, DebugResult, RunResult, WorkflowRunResult } from '@apicc/core';
import { AssertionSchema, DebugResultSchema, StressPlanSchema, StressReportV2Schema, TestCaseSchema } from '@apicc/core/schema';
import { createProjectSnapshot } from '../../../../../packages/core/src/assets/snapshot.js';
import { projectAiReport, parseAnalysisOutput } from '../../../../../packages/core/src/ai/analysis.js';
import { AiAssertionOutputSchema } from '../../../../../packages/core/src/ai/assertions.js';
import { prepareAiContext } from '../../../../../packages/core/src/ai/context.js';
import { parseAiCaseOutput } from '../../../../../packages/core/src/ai/suggest.js';
import { contractExecutionIds, createContractExecutionProject } from '../../../../../packages/core/tests/helpers/contractExecutionFixtures.js';
import { compareStressReports } from '@apicc/core/stress/compare';
import { workflowToRunResult } from '@apicc/core/workflow/adapter';
import type { AiBusinessResultDto, AiContextPreviewDto } from '../../../src/shared/ai/contract.js';
import { seedAiBusinessFixture, fixtureBusinessResult } from '../fixtures/aiBusiness.js';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import { initI18n } from '../../../src/renderer/src/i18n/bridge.js';
import { createTestingStore } from '../../../src/renderer/src/stores/testing.js';
import AiSuggestionsDrawer from '../../../src/renderer/src/components/AiSuggestionsDrawer.vue';
import SuitePanel from '../../../src/renderer/src/components/SuitePanel.vue';
import WfResultDrawer from '../../../src/renderer/src/components/WfResultDrawer.vue';
import { stressV2Report } from '../../helpers/stressV2.js';

const originalStyle = window.getComputedStyle;
beforeAll(() => {
  window.getComputedStyle = element => originalStyle.call(window, element);
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: webcrypto.subtle });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  localStorage.setItem('apicc.locale', 'zh-CN');
});
afterAll(() => { window.getComputedStyle = originalStyle; });
enableAutoUnmount(afterEach);
const globalUi = () => ({ plugins: [createI18nInstance().i18n] });
const page = () => document.body.textContent ?? '';
const snapshotFor = (projectId: string) => { const project = createContractExecutionProject('https://synthetic.example.test'); project.id = projectId; return createProjectSnapshot(project); };
function projectReport(projectId: string, report: RunResult | DebugResult | ReturnType<typeof stressV2Report>) {
  const snapshot = snapshotFor(projectId);
  return projectAiReport({ purpose: 'report-analysis', snapshot, context: snapshot.context, source: { kind: 'local', bindingId: 'fixture-binding', rootIdentity: 'opaque-root', projectId, definitionRevision: snapshot.definitionRevision, editRevision: 0 }, bodySelection: [], reportId: 'native-report', report });
}
function analysisResult(evidence: readonly AiEvidence[], sourceReport?: AiContextPreviewDto['source']['report']): Extract<AiBusinessResultDto, { purpose: 'report-analysis' }> {
  const selected = evidence.find(item => item.kind === 'logical-summary') ?? evidence[0]!;
  // The model response is valid even though it does not select native failures/warnings/request facts.
  const parsed = parseAnalysisOutput(JSON.stringify({ conclusion: 'Model cites only its selected summary', observedFacts: [{ evidenceIds: [selected.id] }], possibleCauses: [], checks: [], limitations: [] }), evidence);
  const base = fixtureBusinessResult('report-analysis'); if (base.purpose !== 'report-analysis') throw new Error('fixture purpose');
  return { ...base, source: { ...base.source, ...(sourceReport ? { report: sourceReport } : {}) }, evidence,
    analysis: { ...parsed, observedFacts: evidence.filter(item => parsed.observedFacts.some(fact => fact.evidenceIds.includes(item.id))) }, evidenceSelection: { selected: evidence.length, total: evidence.length, omitted: 0 } };
}

// I1: catches using model-selected observedFacts as the sole source of host failure/warning/request truth.
it('T11 fix1 I1 keeps native debug failure warnings and unknown request facts visible and exportable when the legal model omits them', async () => {
  const { ai, editor } = await seedAiBusinessFixture(); const locator = editor.locator!;
  const native = DebugResultSchema.parse({ runId: 'native-debug', source: { sourceKind: 'asset', locator, sourceApiRevision: 'api-revision' }, sourceProjectRevision: 'project-revision', executionSnapshotRevision: 'snapshot', mode: 'request',
    startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z', run: { collectionName: 'native debug', startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z', total: 0, passed: 0, failed: 0 },
    outcomes: [], exchanges: [], exchangeTotal: 0, omittedExchangeCount: 0, replay: { mode: 'request', sourceKind: 'asset', locator, parameters: {}, fields: [], available: false }, console: [], warnings: ['Native warning must survive model omission'], failureKind: 'transport', errorName: 'NativeTransportError', error: 'Native transport failed before exchanges' });
  const original = JSON.stringify(native), projected = projectReport(locator.projectId, native);
  ai.businessResult = analysisResult(projected.evidence, projected.source); ai.drawerOpen = true;
  mount(AiSuggestionsDrawer, { props: { ai }, global: globalUi() }); await flushPromises();
  for (const text of ['NativeTransportError', 'Native transport failed before exchanges', 'Native warning must survive model omission', '未采集']) expect.soft(page()).toContain(text);
  const exported = ai.exportAnalysis()?.content ?? '';
  for (const text of ['NativeTransportError', 'Native transport failed before exchanges', 'Native warning must survive model omission', '未采集']) expect.soft(exported).toContain(text);
  expect(JSON.stringify(native)).toBe(original);
});

// I2: catches matching renderer envelope/node-array indexes instead of Core's real native cases[n] contract.
it.each(['suite', 'workflow'] as const)('T11 fix1 I2 locates actual Core-projected %s case evidence through its real report entry', async kind => {
  const { ai, api, editor, workspace } = await seedAiBusinessFixture(); const locator = editor.locator!;
  const project = { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
  const definitionRevision = snapshotFor(project.projectId).definitionRevision;
  const identity = { projectId: project.projectId, definitionRevision, locator: { ...locator, caseId: 'case-identity', scope: 'base' }, workflowId: 'workflow-owned', nodeId: 'request-owned', invocationId: 'inv-owned', nodeVisitId: 'visit-owned', attempt: 2, rowIndex: 3 };
  const outcome = { apiId: locator.apiId, apiName: 'real API', caseId: 'case-identity', caseName: 'real case', scope: 'base', nodeId: 'request-owned', invocationId: 'inv-owned', nodeVisitId: 'visit-owned', attempt: 2, row: 3, locator: identity.locator, passed: false, durationMs: 12, assertions: [], failureKind: 'transport' as const,
    evidence: { identity, state: 'collected' as const, scriptDiagnostics: 'not-collected' as const, truncated: false } };
  const flow: WorkflowRunResult = { workflowId: 'workflow-owned', workflowName: 'real workflow', status: 'enabled', startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.012Z', total: 2, passed: 1, failed: 1, skipped: 0, warnings: [],
    nodeResults: [{ nodeId: 'no-outcome-node', label: 'same business label', kind: 'noop', state: 'noop' }, { nodeId: 'request-owned', label: 'same business label', kind: 'request', state: 'failed', outcome }] };
  const native: RunResult = kind === 'workflow' ? { ...workflowToRunResult(flow), projectId: project.projectId, definitionRevision }
    : { collectionId: locator.collectionId, collectionName: 'native suite', projectId: project.projectId, definitionRevision, startedAt: flow.startedAt, finishedAt: flow.finishedAt, total: 1, passed: 0, failed: 1, cases: [outcome] };
  const projected = projectReport(project.projectId, native);
  const evidence = projected.evidence.find(item => item.kind === 'execution-identity')!;
  expect(evidence.location).toBe('cases[0].evidence.identity');
  const prepare = api.aiPrepareAssistance;
  api.aiPrepareAssistance = async input => { const value = await prepare(input); value.preview.evidence = projected.evidence; return value; };
  const start = api.aiStart;
  api.aiStart = async input => { const metadata = await start(input); const result = analysisResult(projected.evidence); return { ...result, source: metadata.source, bindingId: metadata.bindingId }; };
  let panel;
  if (kind === 'workflow') panel = mount(WfResultDrawer, { props: { open: true, embedded: true, result: flow, projectLocator: project, ai }, global: globalUi() });
  else {
    const testing = createTestingStore(api, { confirmDiscard: () => true });
    testing.view = { context: { root: workspace.root, project, revision: definitionRevision }, readOnly: false, datasets: [], suites: [], environments: [], collections: [], workflows: [], cases: [] };
    testing.suite = { formatVersion: 1, id: crypto.randomUUID(), name: 'suite', tags: [], failFast: false, reporters: ['html'], selection: { kind: 'explicit', entries: [] } };
    testing.result = { invocationId: 'suite-owned', context: testing.view.context, result: native };
    panel = mount(SuitePanel, { props: { testing, ai }, global: globalUi() });
  }
  mount(AiSuggestionsDrawer, { props: { ai }, global: globalUi() }); await flushPromises();
  await panel.get('[data-testid="ai-analyze-report"]').trigger('click'); await flushPromises(); await ai.confirmAssistance(); await flushPromises();
  const summary = projected.evidence.find(item => item.kind === 'logical-summary')!;
  expect.soft([...document.body.querySelectorAll('.analysis li button')].some(item => item.textContent === summary.id)).toBe(false);
  const button = [...document.body.querySelectorAll('.analysis li button')].find(item => item.textContent === evidence.id);
  expect(button).toBeDefined(); if (button) await new DOMWrapper(button).trigger('click');
  expect(panel.emitted(kind === 'suite' ? 'locate-evidence' : 'locate')?.at(-1)?.[0]).toMatchObject(identity);
});

// I2: catches active-looking evidence actions that have neither a target nor a supplied navigator.
it('T11 fix1 I2 marks summary and callback-free evidence as non-navigable instead of empty buttons', async () => {
  const { ai, editor } = await seedAiBusinessFixture();
  const native: RunResult = { collectionId: editor.locator!.collectionId, collectionName: 'empty native', total: 0, passed: 0, failed: 0, cases: [], startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z' };
  ai.businessResult = analysisResult(projectReport(editor.locator!.projectId, native).evidence); ai.drawerOpen = true;
  mount(AiSuggestionsDrawer, { props: { ai }, global: globalUi() }); await flushPromises();
  expect.soft(document.body.querySelectorAll('.analysis li button')).toHaveLength(0);
  expect.soft(page()).toMatch(/不可定位|仅供阅读/);
});

// I3: catches adoption of selector/options semantics that the user could not distinguish in either candidate view.
it.each(['case', 'assertion'] as const)('T11 fix1 I3 shows full legal selector and comparison semantics in the %s candidate view', async kind => {
  const { ai } = await seedAiBusinessFixture();
  const assertions = [
    AssertionSchema.parse({ id: 'header-condition', target: 'header', headerName: 'X-Region-Required', match: 'all', op: 'regex', expected: '^north$', options: { flags: 'im' } }),
    AssertionSchema.parse({ id: 'cookie-condition', target: 'cookie', cookieName: 'session-region-cookie', match: 'first', op: 'eq', expected: 'north' }),
    AssertionSchema.parse({ id: 'xml-condition', target: 'bodyXml', path: '/p:order/p:region', namespaces: { p: 'urn:business:orders' }, match: 'all', op: 'regex', expected: '^north$', options: { flags: 'i' } }),
  ];
  if (kind === 'assertion') {
    const result = fixtureBusinessResult('assertion-suggestion'); if (result.purpose !== 'assertion-suggestion') throw new Error('fixture purpose');
    result.assertions = AiAssertionOutputSchema.parse({ assertions: assertions.map(assertion => ({ assertion, basis: 'contract', reason: 'Actual selector semantics', evidenceIds: ['contract:e1'], requiresUserJudgment: false })) }).assertions;
    ai.businessResult = result;
  } else {
    const candidate = TestCaseSchema.parse({ id: 'case-selector', name: 'selector candidate', scope: 'base', parameters: {}, preOperations: [], postOperations: [], assertions });
    ai.suggestions = [{ ...candidate, parameters: candidate.parameters ?? {}, preOperations: candidate.preOperations ?? [], postOperations: candidate.postOperations ?? [] }];
  }
  ai.drawerOpen = true; mount(AiSuggestionsDrawer, { props: { ai }, global: globalUi() }); await flushPromises();
  for (const text of ['X-Region-Required', 'session-region-cookie', 'urn:business:orders', '/p:order/p:region', 'im']) expect.soft(page()).toContain(text);
  expect.soft(page()).toMatch(/全部匹配/); expect.soft(page()).toMatch(/首个匹配/);
  expect(document.body.querySelector('pre')).toBeNull();
});

// I3: catches losing the caseId-to-explanation association while native cases themselves remain readable.
it('T11 fix1 I3 associates each native case explanation and evidence with its own candidate', async () => {
  const { ai, api, editor } = await seedAiBusinessFixture(); const snapshot = snapshotFor(editor.locator!.projectId);
  const corePreview = prepareAiContext({ purpose: 'case-suggestion', snapshot, context: snapshot.context, source: { kind: 'local', bindingId: 'fixture-binding', rootIdentity: 'opaque-root', projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, editRevision: 0 }, bodySelection: [],
    target: { collectionId: contractExecutionIds.collection, folderIds: [contractExecutionIds.outerFolder, contractExecutionIds.innerFolder], apiId: contractExecutionIds.contract } });
  const evidenceId = corePreview.evidence[0]!.id;
  const decoded = parseAiCaseOutput(JSON.stringify({ cases: [
    { name: 'First native candidate', scope: 'base', parameters: [], preOperations: [], postOperations: [], assertions: [], reason: 'First candidate requires explicit region', evidenceIds: [evidenceId] },
    { name: 'Second native candidate', scope: 'base', parameters: [], preOperations: [], postOperations: [], assertions: [], reason: 'Second candidate handles absent region', evidenceIds: [evidenceId] },
  ] }), corePreview);
  await ai.fetchSuggestions();
  const start = api.aiStart;
  api.aiStart = async input => { const result = await start(input); if (result.purpose !== 'case-suggestion') throw new Error('fixture purpose');
    return { ...result, ...decoded }; };
  await ai.confirmAssistance(); mount(AiSuggestionsDrawer, { props: { ai }, global: globalUi() }); await flushPromises();
  const rows = [...document.body.querySelectorAll('[data-testid="ai-suggest-item"]')]; expect(rows).toHaveLength(2);
  expect.soft(rows[0]!.textContent).toContain('First candidate requires explicit region'); expect.soft(rows[0]!.textContent).toContain(evidenceId);
  expect.soft(rows[1]!.textContent).toContain('Second candidate handles absent region'); expect.soft(rows[1]!.textContent).toContain(evidenceId);
  expect.soft(rows[0]!.textContent).not.toContain('Second candidate handles absent region');
});

// I4: catches request labels reused for iterations and raw statistical/phase codes losing units and meaning.
it('T11 fix1 I4 renders real stress iteration request statistics and phase facts with honest populations localized reasons and units', async () => {
  const { ai, editor } = await seedAiBusinessFixture(); const raw = stressV2Report();
  raw.projectId = editor.locator!.projectId; raw.iterations = { ...raw.iterations, planned: 12, started: 10, completed: 8, passed: 7, failed: 1, aborted: 2, dropped: 2 };
  raw.requests = { started: 21, completed: 20, eligibleCompleted: 20, failed: 4 };
  raw.statistics = { ...raw.statistics, method: 'log-histogram', exact: false, relativeError: 0.01 };
  raw.phases[0] = { ...raw.phases[0]!, startOffsetMs: null, endOffsetMs: null, durationMs: null, rps: { availability: 'unavailable', reason: 'not-collected' } };
  raw.completeness.metrics = { complete: false, reasons: ['phase-window-missing'] }; raw.incomplete = true; raw.verdict = { status: 'incomplete', passed: false, violations: [] };
  const native = StressReportV2Schema.parse(raw), projected = projectReport(raw.projectId, native);
  const result = analysisResult(projected.evidence); result.analysis.observedFacts = [...projected.evidence]; ai.businessResult = result; ai.drawerOpen = true;
  const { i18n } = createI18nInstance(); mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [i18n] } }); await flushPromises();
  const fact = (heading: string) => [...document.body.querySelectorAll('.analysis article')].find(article => article.querySelector('h4')?.textContent === heading)?.textContent ?? '';
  expect.soft(fact('迭代')).toMatch(/已(?:开始|启动)迭代\s*10/); expect.soft(fact('迭代')).not.toContain('已开始请求');
  expect.soft(fact('真实请求统计')).toMatch(/已开始请求\s*21/);
  expect.soft(fact('统计')).toMatch(/1(?:\.0+)?\s*%/); expect.soft(fact('统计')).toContain('对数直方图');
  expect.soft(page()).toContain('缺少阶段覆盖窗口'); expect.soft(page()).not.toContain('phase-window-missing');
  expect.soft(page()).toContain('请求/秒'); expect.soft(fact('统计')).not.toContain('relativeError');
  i18n.global.locale.value = 'en'; await flushPromises();
  expect.soft(fact('Iterations')).toMatch(/Iterations started\s*10/); expect.soft(page()).toContain('Phase coverage window missing');
});

// I5: catches indistinguishable same-project API/case outbound sources and a missing safe connection identity.
it('T11 fix1 I5 distinguishes exact same-project targets and the saved connection in the real outbound preview', async () => {
  const { ai, api, editor } = await seedAiBusinessFixture(); const locator = editor.locator!, testCase = editor.api!.cases[0]!;
  await ai.prepareAssertions({ caseId: testCase.id, scope: testCase.scope });
  const first = ai.outboundPreview!;
  mount(AiSuggestionsDrawer, { props: { ai }, global: globalUi() }); await flushPromises();
  for (const text of [locator.apiId, testCase.id, testCase.scope, '个人主连接']) expect.soft(page()).toContain(text);
  expect.soft(page()).toMatch(/未保存|草稿/); expect.soft(page()).toMatch(new RegExp(`(?:编辑|草稿).*${first.preview.source.editRevision}`));
  const { credentialState: _credentialState, ...connection } = ai.settings!.connections[0]!;
  await ai.writeSettings({ operation: 'connection', expectedRevision: ai.settings!.revision, connection: { ...connection, name: 'Changed after prepared revision' } }); await flushPromises();
  expect.soft(page()).not.toContain('Changed after prepared revision');
  const created = await api.nodeCreate({ kind: 'api', parent: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId, collectionId: locator.collectionId }, api: { name: 'Second actual target', method: 'GET', path: '/second', baseUrl: 'https://synthetic.example.test' } });
  if (created.kind !== 'api') throw new Error('fixture API'); await editor.load(created.locator); await ai.fetchSuggestions(); await flushPromises();
  expect.soft(page()).toContain(created.locator.apiId); expect.soft(page()).not.toContain(locator.apiId);
});

// I5: catches flattening report/baseline/candidate identities into role-free repeated ID lines.
it('T11 fix1 I5 preserves report comparison roles times and safe summaries in preview and independent export', async () => {
  const { ai, editor } = await seedAiBusinessFixture(); await ai.fetchSuggestions();
  const baseline = stressV2Report(), candidate = stressV2Report();
  for (const [report, completed, date] of [[baseline, 5, '2026-10-30'], [candidate, 8, '2026-10-31']] as const) {
    report.projectId = editor.locator!.projectId; report.plan.termination.maxIterations = 10;
    report.iterations = { ...report.iterations, planned: 10, started: completed, completed, passed: completed };
    report.startedAt = Date.parse(`${date}T01:02:03.004Z`); report.finishedAt = Date.parse(`${date}T01:02:04.005Z`);
    StressReportV2Schema.parse(report);
  }
  const snapshot = snapshotFor(editor.locator!.projectId), judgment = compareStressReports(baseline, candidate); expect(judgment.directlyComparable).toBe(true);
  const projected = projectAiReport({ purpose: 'report-analysis', snapshot, context: snapshot.context, source: { kind: 'local', bindingId: 'fixture-binding', rootIdentity: 'opaque-root', projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, editRevision: 0 }, bodySelection: [], reportId: 'candidate-report-B', report: candidate,
    comparison: { baselineReportId: 'baseline-report-A', baseline, judgment } });
  const source = { ...ai.outboundPreview!.preview.source, report: projected.source, comparison: projected.comparisonSource };
  ai.outboundPreview!.preview = { ...ai.outboundPreview!.preview, purpose: 'report-analysis', source };
  mount(AiSuggestionsDrawer, { props: { ai }, global: globalUi() }); await flushPromises();
  expect.soft(page()).toMatch(/基线[\s\S]*baseline-report-A/); expect.soft(page()).toMatch(/候选[\s\S]*candidate-report-B/);
  expect.soft(page()).toContain('2026-10-30T01:02:03.004Z'); expect.soft(page()).toMatch(/已完成[^\n]*5/);
  const result = fixtureBusinessResult('report-analysis'); result.source = source; ai.businessResult = result;
  const original = JSON.stringify(result), exported = ai.exportAnalysis()?.content ?? '';
  expect.soft(exported).toMatch(/基线[\s\S]*baseline-report-A/); expect.soft(exported).toMatch(/候选[\s\S]*candidate-report-B/);
  expect.soft(exported).toContain('2026-10-30T01:02:03.004Z'); expect.soft(exported).toMatch(/已完成[^\n]*5/);
  expect(JSON.stringify(result)).toBe(original);
});

// Fix2 I4: catches treating formal metric-unavailable union members as unknown user strings in UI/export.
it('T11 fix2 I4 explains all remaining formal unavailable metric reasons in both languages and the safe export', async () => {
  const { ai, editor } = await seedAiBusinessFixture(); const raw = stressV2Report(); raw.projectId = editor.locator!.projectId;
  raw.rps = { availability: 'unavailable', reason: 'budget-exhausted' }; raw.latency = { availability: 'unavailable', reason: 'overflow' };
  raw.scriptLatency = { availability: 'unavailable', reason: 'unaligned' }; raw.iterationLatency = { availability: 'unavailable', reason: 'legacy' };
  raw.completeness.metrics = { complete: false, reasons: ['metrics-budget-exhausted'] }; raw.incomplete = true; raw.verdict = { passed: false, status: 'incomplete', violations: [] };
  const native = StressReportV2Schema.parse(raw), original = JSON.stringify(native);
  const metric = projectReport(raw.projectId, native).evidence.find(item => item.kind === 'stress-metrics')!;
  ai.businessResult = analysisResult([metric]); ai.drawerOpen = true;
  const shared = initI18n(); shared.setLocale('zh-CN'); mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [shared.i18n] } });
  for (const [locale, expected] of [['zh-CN', ['预算耗尽', '超出统计范围', '时间轴未对齐', '旧版未采集']], ['en', ['Budget exhausted', 'Outside statistics range', 'Timeline unaligned', 'Legacy: not collected']]] as const) {
    shared.setLocale(locale); await flushPromises(); const exported = ai.exportAnalysis()?.content ?? '';
    for (const reason of expected) { expect.soft(page()).toContain(reason); expect.soft(exported).toContain(reason); }
    const displayedValues = Array.from(document.querySelectorAll('[data-testid="ai-report-analysis"] dd'), node => node.textContent?.trim());
    for (const code of ['budget-exhausted', 'overflow', 'unaligned', 'legacy']) { expect.soft(displayedValues).not.toContain(code); expect.soft(exported).not.toMatch(new RegExp(`: ${code}$`, 'm')); }
  }
  shared.setLocale('zh-CN'); expect(JSON.stringify(native)).toBe(original);
});

// Fix2 N1: catches reading nonexistent termination.maxDurationMs instead of the actual durationMs field.
it('T11 fix2 N1 preserves a legal constant-load termination duration in the Core plan fact UI and export', async () => {
  const { ai, editor } = await seedAiBusinessFixture(); const raw = stressV2Report(); raw.projectId = editor.locator!.projectId;
  raw.plan = StressPlanSchema.parse({ formatVersion: 1, target: raw.target, load: { kind: 'constant-vus', vus: 2 }, maxVus: 2, termination: { durationMs: 60000 } });
  const native = StressReportV2Schema.parse(raw), original = JSON.stringify(native), plan = projectReport(raw.projectId, native).evidence.find(item => item.kind === 'stress-plan')!;
  expect(plan.location).toBe('plan'); ai.businessResult = analysisResult([plan]); ai.drawerOpen = true;
  const shared = initI18n(); shared.setLocale('zh-CN'); mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [shared.i18n] } }); await flushPromises();
  expect.soft(page()).toContain('60000 ms'); expect.soft(ai.exportAnalysis()?.content).toContain('60000 ms');
  expect(JSON.stringify(native)).toBe(original);
});

// Fix2 N1: catches dropping the real staged curve or labelling an arrival target as VUs (and vice versa).
it.each(['vus', 'arrival'] as const)('T11 fix2 N1 preserves legal %s staged start targets and every stage duration target and business ID in UI and export', async executor => {
  const { ai, editor } = await seedAiBusinessFixture(); const raw = stressV2Report(); raw.projectId = editor.locator!.projectId;
  const start = executor === 'vus' ? 2 : 1.5, target = executor === 'vus' ? 4 : 3.5, unit = executor === 'vus' ? 'VU' : '迭代/秒';
  raw.plan = StressPlanSchema.parse({ formatVersion: 1, target: raw.target, maxVus: 8, load: { kind: 'stages', executor, startTarget: start,
    stages: [{ id: 'unknown-business-rise', durationMs: 12345, target }, { id: 'unknown-business-drain', durationMs: 23456, target: 0 }] } });
  const native = StressReportV2Schema.parse(raw), original = JSON.stringify(native), plan = projectReport(raw.projectId, native).evidence.find(item => item.kind === 'stress-plan')!;
  ai.businessResult = analysisResult([plan]); ai.drawerOpen = true;
  const shared = initI18n(); shared.setLocale('zh-CN'); mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [shared.i18n] } }); await flushPromises();
  for (const text of ['初始目标', `${start} ${unit}`, 'unknown-business-rise', '12345 ms', `${target} ${unit}`, 'unknown-business-drain', '23456 ms', `0 ${unit}`]) {
    expect.soft(page()).toContain(text); expect.soft(ai.exportAnalysis()?.content).toContain(text);
  }
  expect(JSON.stringify(native)).toBe(original);
});
