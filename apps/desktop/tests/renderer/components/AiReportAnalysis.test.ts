// @vitest-environment jsdom
import { afterEach, afterAll, beforeAll, expect, it } from 'vitest';
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createHash, webcrypto } from 'node:crypto';
import AiSuggestionsDrawer from '../../../src/renderer/src/components/AiSuggestionsDrawer.vue';
import AiReportAnalysis from '../../../src/renderer/src/components/ai/AiReportAnalysis.vue';
import { aiFactRows } from '../../../src/renderer/src/ai/presentation.js';
import { caseEvidenceIdentity } from '../../../src/renderer/src/ai/evidenceNavigation.js';
import RunView from '../../../src/renderer/src/components/RunView.vue';
import { useRunStore } from '../../../src/renderer/src/stores/run.js';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import { fixtureBusinessResult, seedAiBusinessFixture } from '../fixtures/aiBusiness.js';
import type { AiSourceRef } from '../../../src/shared/ai/contract.js';
import { createProjectSnapshot, inspectAiContextChoices, prepareAiContext } from '@apicc/core';
import type { AiEvidence, WorkflowRunResult, DebugResult, RunResult } from '@apicc/core';
import { contractExecutionIds, createContractExecutionProject } from '../../../../../packages/core/tests/helpers/contractExecutionFixtures.js';
import type { AiBusinessResultDto } from '../../../src/shared/ai/contract.js';
import StressReportView from '../../../src/renderer/src/components/StressReportView.vue';
import WfResultDrawer from '../../../src/renderer/src/components/WfResultDrawer.vue';
import SuitePanel from '../../../src/renderer/src/components/SuitePanel.vue';
import OnlineExecutionPanel from '../../../src/renderer/src/components/online/OnlineExecutionPanel.vue';
import { createTestingStore } from '../../../src/renderer/src/stores/testing.js';
import { createOnlineExecutionStore } from '../../../src/renderer/src/stores/onlineExecution.js';
import { stressV2Report } from '../../helpers/stressV2.js';
import DebugHistory from '../../../src/renderer/src/components/DebugHistory.vue';
import { useDebugHistoryStore } from '../../../src/renderer/src/stores/debugHistory.js';
import { useDebugStore } from '../../../src/renderer/src/stores/debug.js';
import { DebugHistoryRecordSchema } from '@apicc/core/schema';
import CasePanel from '../../../src/renderer/src/components/CasePanel.vue';
import { useCasesStore } from '../../../src/renderer/src/stores/cases.js';

const originalStyle = window.getComputedStyle;
beforeAll(() => {
  window.getComputedStyle = element => originalStyle.call(window, element);
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: webcrypto.subtle });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }); localStorage.setItem('apicc.locale', 'zh-CN');
});
afterAll(() => { window.getComputedStyle = originalStyle; });
enableAutoUnmount(afterEach);
afterEach(() => { localStorage.setItem('apicc.locale', 'zh-CN'); });

// Only the external host is substituted: projection, budget rejection, selection IDs, Pinia and navigation predicate stay real.
it.each(['normal', 'first-budget', 'after-A-budget', 'after-A-no-capability'] as const)('residual N1 report capability belongs to the current selection: %s', async scenario => {
  const { ai, api, editor, workspace, started } = await seedAiBusinessFixture(), locator = editor.locator!;
  const before = JSON.stringify(editor.api), project = createContractExecutionProject('https://synthetic.example.test'); project.id = locator.projectId;
  const snapshot = createProjectSnapshot(project), time = '2026-11-01T00:00:00Z';
  const makeReport = (name: string, count: number): RunResult => ({ collectionId: locator.collectionId, collectionName: name, projectId: locator.projectId,
    total: count, passed: 0, failed: count, startedAt: time, finishedAt: time,
    cases: Array.from({ length: count }, (_, row) => ({ apiId: locator.apiId, apiName: 'Saved API', caseId: editor.api!.cases[0]!.id, caseName: 'Saved case', row,
      passed: false, durationMs: 1, assertions: [], error: 'Safe repeated diagnostic '.repeat(80),
      evidence: { identity: { projectId: locator.projectId, definitionRevision: snapshot.definitionRevision,
        locator: { collectionId: locator.collectionId, folderIds: [...locator.folderIds], apiId: locator.apiId, caseId: editor.api!.cases[0]!.id, scope: editor.api!.cases[0]!.scope } },
        state: 'collected', truncated: false, scriptDiagnostics: 'not-collected' } })) });
  const reports = { A: makeReport('Saved report A', 1), B: makeReport('Saved report B', scenario === 'normal' ? 1 : 70) };
  let selected: 'A' | 'B' = 'B', current = true;
  const inputFor = (key: 'A' | 'B') => ({ purpose: 'report-analysis' as const, snapshot, context: snapshot.context,
    source: { kind: 'local' as const, bindingId: `owned-${key}`, rootIdentity: 'opaque-root', projectId: locator.projectId, definitionRevision: snapshot.definitionRevision, editRevision: 0 },
    bodySelection: [], reportId: `owned-report-${key}`, report: reports[key], maxContextBytes: 15000 });
  const inspect = api.aiInspectChoices, prepare = api.aiPrepareAssistance, start = api.aiStart;
  let projected: ReturnType<typeof prepareAiContext> | null = null;
  const attempts: string[] = [], callbacks: string[] = [], located: string[] = [];
  api.aiInspectChoices = async input => {
    const value = await inspect(input), catalog = inspectAiContextChoices(inputFor(selected));
    return { ...value, source: catalog.source, evidence: { ...value.evidence, items: catalog.evidence.slice(0, 20), total: catalog.evidence.length,
      selectable: catalog.evidence.length, returned: Math.min(20, catalog.evidence.length), omitted: 0, complete: catalog.evidence.length <= 20 } };
  };
  api.aiPrepareAssistance = async input => {
    attempts.push(selected);
    const formal = prepareAiContext({ ...inputFor(selected), evidenceSelection: input.evidenceSelection });
    const value = await prepare(input); projected = formal;
    return { ...value, preview: { ...value.preview, ...formal } };
  };
  api.aiStart = async input => {
    const value = await start(input); if (value.purpose !== 'report-analysis' || !projected) throw new Error('fixture-report-preview-required');
    return { ...value, bindingId: projected.source.bindingId, source: projected.source, evidence: projected.evidence,
      analysis: { ...value.analysis, observedFacts: [...projected.evidence], possibleCauses: [], checks: [] } };
  };
  const prepareReport = async (key: 'A' | 'B', withCapability = true) => {
    selected = key;
    await ai.prepareReportAnalysis({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } },
      displayed: reports[key], isCurrent: () => current && selected === key,
      ...(withCapability ? { canLocateEvidence: (evidence: AiEvidence, authorised: readonly AiEvidence[]) => {
        callbacks.push(key); return !workspace.readOnly && !!caseEvidenceIdentity(evidence, authorised, reports[key].cases);
      }, locateEvidence: (evidence: AiEvidence, authorised: readonly AiEvidence[]) => {
        if (caseEvidenceIdentity(evidence, authorised, reports[key].cases)) located.push(key);
      } } : {}) });
  };
  if (scenario.startsWith('after-A')) {
    await prepareReport('A'); expect(ai.outboundPreview).not.toBeNull(); await ai.confirmAssistance();
    const id = ai.businessResult!.purpose === 'report-analysis' ? ai.businessResult!.evidence.find(item => item.kind === 'execution-identity')!.id : '';
    ai.locateEvidence(id); expect(located).toEqual(['A']); callbacks.length = 0; located.length = 0;
  }
  const capability = scenario !== 'after-A-no-capability';
  await prepareReport('B', capability);
  if (scenario !== 'normal') {
    expect(ai.businessError).toBe('context-budget'); expect(ai.outboundPreview).toBeNull(); expect(ai.contentChoices).not.toBeNull();
    const id = ai.contentChoices!.evidence.items.find(item => item.kind === 'execution-identity')!.id;
    ai.clearContentEvidence(); await ai.toggleContentEvidence(id); await ai.repreviewContent();
    expect(ai.outboundPreview!.preview.evidence.map(item => item.id)).toEqual([id]);
  }
  expect(started).toHaveLength(scenario.startsWith('after-A') ? 1 : 0);
  expect(ai.outboundPreview).not.toBeNull(); await ai.confirmAssistance(); expect(ai.businessResult?.purpose).toBe('report-analysis');
  const evidenceId = (ai.businessResult as Extract<AiBusinessResultDto, { purpose: 'report-analysis' }>).evidence.find(item => item.kind === 'execution-identity')!.id;
  expect.soft(ai.canLocateEvidence(evidenceId), 'current B capability must be bound after normal or recovered preview').toBe(capability);
  ai.locateEvidence(evidenceId);
  expect.soft(located, 'only the current B callback may run; missing B capability must not inherit A').toEqual(capability ? ['B'] : []);
  expect.soft(callbacks).not.toContain('A');
  workspace.readOnly = true; expect(ai.canLocateEvidence(evidenceId)).toBe(false); workspace.readOnly = false;
  current = false; expect(ai.canLocateEvidence(evidenceId)).toBe(false); current = true;
  await ai.cancelAssistance(); expect(ai.canLocateEvidence(evidenceId)).toBe(false);
  expect(attempts).toEqual(scenario === 'normal' ? ['B'] : scenario === 'first-budget' ? ['B', 'B'] : ['A', 'B', 'B']);
  expect(JSON.stringify(editor.api)).toBe(before);
});

it.each(['zh-CN', 'en'] as const)('residual I6 Core observation refusals expose safe reasons and next steps in %s', async locale => {
  localStorage.setItem('apicc.locale', locale);
  const ids = contractExecutionIds, snapshot = createProjectSnapshot(createContractExecutionProject('https://synthetic.example.test'));
  const target = { collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: ids.contract, caseId: ids.case, scope: 'base' };
  const report: RunResult = { projectId: ids.project, definitionRevision: snapshot.definitionRevision, collectionId: ids.collection, collectionName: 'Saved observation',
    total: 1, passed: 1, failed: 0, startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z',
    cases: [{ apiId: ids.contract, apiName: 'API', caseId: ids.case, caseName: 'case', passed: true, durationMs: 1, assertions: [],
      evidence: { identity: { projectId: ids.project, definitionRevision: snapshot.definitionRevision, locator: structuredClone(target) }, state: 'collected', scriptDiagnostics: 'not-collected', truncated: false,
        response: { status: 200, headers: { text: '', truncated: false }, body: { text: 'UNSELECTED_PRIVATE_BODY', truncated: false } } } }] };
  const coreInput = { purpose: 'assertion-suggestion' as const, snapshot, context: snapshot.context, target, bodySelection: [],
    source: { kind: 'local' as const, bindingId: 'owned-observation', rootIdentity: 'opaque-root', projectId: ids.project, definitionRevision: snapshot.definitionRevision, editRevision: 0 },
    basis: { kind: 'observation' as const, reportId: 'saved-report', caseIndex: 0, report } };
  const positive = prepareAiContext(coreInput);
  expect(positive.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'response-status', value: 200 })]));
  expect(JSON.stringify(positive)).not.toContain('UNSELECTED_PRIVATE_BODY');
  for (const code of ['evidence-unavailable', 'evidence-locator-unavailable'] as const) {
    const selected = structuredClone(report);
    if (code === 'evidence-unavailable') { selected.cases[0]!.evidence!.state = 'not-collected'; delete selected.cases[0]!.evidence!.response; }
    else delete selected.cases[0]!.evidence!.identity.locator;
    expect(() => prepareAiContext({ ...coreInput, basis: { ...coreInput.basis, report: selected } })).toThrow(code);
    const { ai, api, editor, prepared, started } = await seedAiBusinessFixture(), before = JSON.stringify(editor.api);
    ai.settingsFailure(new Error('missing-model')); const issue = JSON.stringify(ai.settingsIssue);
    let inspections = 0;
    api.aiInspectChoices = async input => {
      inspections++; expect(input.operation === 'capture' && input.input.selection.business.purpose).toBe('assertion-suggestion');
      prepareAiContext({ ...coreInput, basis: { ...coreInput.basis, report: selected } });
      throw new Error('fixture-must-reach-Core-refusal');
    };
    await ai.prepareAssertions({ caseId: editor.api!.cases[0]!.id, scope: editor.api!.cases[0]!.scope }, { kind: 'observation', caseIndex: 0, report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) } });
    const drawer = mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
    const alert = document.body.querySelector('[role="alert"]')?.textContent ?? '';
    expect(ai.businessError).toBe(code); expect(JSON.stringify(ai.settingsIssue)).toBe(issue); expect(inspections).toBe(1);
    expect.soft(alert).not.toMatch(/AI 操作失败|AI operation failed/);
    expect.soft(alert).toMatch(locale === 'zh-CN' ? code === 'evidence-unavailable' ? /未采集|没有.*已采集/ : /定位|归属/ : code === 'evidence-unavailable' ? /not collected|no collected/i : /locator|attribut/i);
    expect.soft(alert).toMatch(locale === 'zh-CN' ? /选择.*已采集.*可归属|选择.*可归属.*已采集/ : /select.*collected.*attribut|select.*attribut.*collected/i);
    expect.soft(alert).toMatch(locale === 'zh-CN' ? /不会自动补取|不能自动补取/ : /will not.*fetch|cannot.*fetch|does not.*fetch/i);
    expect(alert).not.toContain('UNSELECTED_PRIVATE_BODY'); expect(prepared).toEqual([]); expect(started).toEqual([]); expect(JSON.stringify(editor.api)).toBe(before);
    drawer.unmount();
  }
});

it('residual I6 unknown host error remains generic and does not disclose secrets or overwrite settings', async () => {
  const { ai, api, editor, prepared, started } = await seedAiBusinessFixture();
  ai.settingsFailure(new Error('missing-model')); const issue = JSON.stringify(ai.settingsIssue);
  api.aiInspectChoices = async () => { throw Object.assign(new Error('provider-private-error: SECRET_NOT_FOR_UI'), { code: 'unknown-provider-state' }); };
  await ai.prepareAssertions({ caseId: editor.api!.cases[0]!.id, scope: editor.api!.cases[0]!.scope });
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('AI 操作失败，请检查来源与设置后重试。');
  expect(document.body.textContent).not.toContain('SECRET_NOT_FOR_UI'); expect(JSON.stringify(ai.settingsIssue)).toBe(issue); expect(prepared).toEqual([]); expect(started).toEqual([]);
});

it.each([{ locale: 'zh-CN', previousAssertion: false }, { locale: 'en', previousAssertion: true }] as const)('residual M7 actual DebugHistory early rejection has report title: $locale previousAssertion=$previousAssertion', async ({ locale, previousAssertion }) => {
  localStorage.setItem('apicc.locale', locale);
  const { ai, api, editor, workspace, prepared, started } = await seedAiBusinessFixture(), locator = editor.locator!;
  if (previousAssertion) {
    await ai.prepareAssertions({ caseId: editor.api!.cases[0]!.id, scope: editor.api!.cases[0]!.scope });
    expect(ai.businessPurpose).toBe('assertion-suggestion'); expect(ai.outboundPreview).not.toBeNull(); await ai.cancelAssistance(); prepared.length = 0;
  } else expect(ai.businessPurpose).toBe('case-suggestion');
  let inspections = 0; const inspect = api.aiInspectChoices; api.aiInspectChoices = async input => { inspections++; return inspect(input); };
  const history = useDebugHistoryStore(api), debug = useDebugStore(api, editor, () => ({ root: workspace.root, readOnly: false }));
  const record = DebugHistoryRecordSchema.parse({ formatVersion: 1, historyId: '00000000-0000-4000-8000-000000000055', createdAt: '2026-10-31T01:00:00.000Z',
    result: { runId: 'legacy-debug', sourceApiRevision: 'api', sourceProjectRevision: 'project', executionSnapshotRevision: 'snapshot', mode: 'request', locator,
      startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z', run: { collectionName: 'legacy', startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z', total: 0, passed: 0, failed: 0 },
      outcomes: [], exchanges: [], exchangeTotal: 0, omittedExchangeCount: 0, replay: { mode: 'request', locator, parameters: {}, fields: [], available: false }, console: [], warnings: [] } });
  Object.assign(history, { selected: { record, diagnostics: [] } });
  const before = JSON.stringify(record), projectLocator = { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
  mount(DebugHistory, { props: { open: true, api, history, debug, editor, projectLocator, ai }, global: { plugins: [createI18nInstance().i18n] } });
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  await new DOMWrapper(document.body.querySelector('[data-testid="ai-analyze-report"]')!).trigger('click'); await flushPromises();
  expect(ai.businessError).toBe('ai-report-unattributable'); expect(ai.settingsIssue).toBeNull();
  expect(document.body.textContent).toContain(locale === 'zh-CN' ? '报告缺少可证明的来源归属' : 'provable source ownership');
  expect(inspections).toBe(0); expect(prepared).toEqual([]); expect(started).toEqual([]); expect(JSON.stringify(record)).toBe(before);
  expect(document.body.querySelector('.ant-drawer-title')?.textContent).toBe(locale === 'zh-CN' ? 'AI 报告分析' : 'AI Report Analysis');
});

// Catches missing fixed identity captions, accidental one-based row conversion, and broad translation of user keys.
it.each(['zh-CN', 'en'] as const)('native identity labels: selected formal execution identity has localized business rows without rewriting values in %s', async locale => {
  const ids = contractExecutionIds, snapshot = createProjectSnapshot(createContractExecutionProject('https://synthetic.example.test'));
  const identity = { projectId: ids.project, definitionRevision: snapshot.definitionRevision, suiteRunId: 'suite-run-native-labels', entryId: 'suite-entry-native-labels',
    suiteRow: 0, rowIndex: 0, dataDigest: '0123456789abcdef'.repeat(4),
    locator: { collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: ids.contract, caseId: ids.case, scope: 'base' } };
  const report: RunResult = { projectId: ids.project, definitionRevision: snapshot.definitionRevision, collectionId: ids.collection, collectionName: 'Archived suite report',
    total: 1, passed: 1, failed: 0, startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z', cases: [
      { apiId: ids.contract, apiName: 'Saved API', caseId: ids.case, caseName: 'Saved case', passed: true, durationMs: 0, assertions: [],
        evidence: { identity, state: 'collected', scriptDiagnostics: 'not-collected', truncated: false } },
    ] };
  const original = JSON.stringify(report), input = { purpose: 'report-analysis' as const, snapshot, context: snapshot.context,
    source: { kind: 'local' as const, bindingId: 'owned-identity-report', rootIdentity: 'opaque-root', projectId: ids.project, definitionRevision: snapshot.definitionRevision, editRevision: 0 },
    reportId: 'owned-archived-suite-report', report, bodySelection: [] };
  const catalog = inspectAiContextChoices(input), selected = catalog.evidence.find(item => item.kind === 'execution-identity')!;
  expect(selected).toBeDefined();
  const preview = prepareAiContext({ ...input, evidenceSelection: [selected.id] });
  expect(preview.evidence).toHaveLength(1); expect(preview.evidence[0]!.value).toEqual(identity);
  expect(preview.evidenceSelection).toEqual({ selected: 1, total: catalog.evidence.length, omitted: catalog.evidence.length - 1 });
  const fixture = fixtureBusinessResult('report-analysis'); if (fixture.purpose !== 'report-analysis') throw new Error('report fixture required');
  const result = { ...fixture, source: preview.source, evidence: preview.evidence, evidenceSelection: preview.evidenceSelection!,
    analysis: { ...fixture.analysis, observedFacts: [] } };
  const ui = createI18nInstance(); ui.setLocale(locale);
  const panel = mount(AiReportAnalysis, { props: { result }, global: { plugins: [ui.i18n] } }); await flushPromises();
  expect(panel.findAll('article')).toHaveLength(1); expect(panel.find('article .evidence-ref').text()).toContain(selected.id);
  expect(panel.findAll('article dd').map(row => row.text())).toEqual([ids.project, snapshot.definitionRevision, 'suite-run-native-labels', 'suite-entry-native-labels',
    '0', '0', '0123456789abcdef'.repeat(4), ids.collection, ids.outerFolder, ids.innerFolder, ids.contract, ids.case, 'base']);
  expect(JSON.stringify(report)).toBe(original); expect(panel.find('pre').exists()).toBe(false);
  const translate = (key: string) => String(ui.i18n.global.t(key));
  expect(aiFactRows({ ...preview.evidence[0]!, value: { customOwnershipKey: 'unchanged-user-value' } }, translate)).toEqual([{ label: 'customOwnershipKey', value: 'unchanged-user-value' }]);
  expect(aiFactRows({ ...preview.evidence[0]!, kind: 'request', value: { headers: { projectId: 'user-defined-header', customHeader: 'unchanged-header' } } }, translate))
    .toEqual([{ label: 'headers · projectId', value: 'user-defined-header' }, { label: 'headers · customHeader', value: 'unchanged-header' }]);
  const expected = locale === 'en'
    ? ['Project ID', 'Definition revision', 'Suite run ID', 'Suite entry ID', 'Suite data row (zero-based)', 'Data row index (zero-based)', 'Data fingerprint',
      'Case locator · Collection ID', 'Case locator · Folder IDs · 1', 'Case locator · Folder IDs · 2', 'Case locator · API ID', 'Case locator · Case ID', 'Case locator · Scope']
    : ['项目标识', '定义版本', '套件运行标识', '套件入口标识', '套件数据行位置（从 0 开始）', '数据行位置（从 0 开始）', '数据指纹',
      '用例定位 · 集合标识', '用例定位 · 文件夹标识 · 1', '用例定位 · 文件夹标识 · 2', '用例定位 · 接口标识', '用例定位 · 用例标识', '用例定位 · 作用域'];
  expect(panel.findAll('article dt').map(row => row.text()), 'primary metadata captions must be business labels, not internal field names').toEqual(expected);
});

it.each(['zh-CN', 'en'] as const)('final C I5 outbound preview shows fixed effective budgets provenance capability and cost/wait warning in %s', async locale => {
  const { ai, api, read, started } = await seedAiBusinessFixture();
  await api.aiSettingsWrite({ operation: 'preferences', expectedRevision: read().revision, models: read().models.map(model => model.id === 'model-a' ? { ...model, budgets: { ...model.budgets, maxRequests: 6 } } : model) });
  await ai.init(); const original = api.aiPrepareAssistance;
  api.aiPrepareAssistance = async input => { const value = await original(input); value.preview.warnings = ai.resolveSettings('model-a', input.selection.business.purpose).warnings; return value; };
  await ai.fetchSuggestions(); expect(ai.outboundPreview!.preview.budgets.maxRequests).toBe(6); expect(ai.outboundPreview!.preview.warnings).toHaveLength(1);
  const { i18n, setLocale } = createI18nInstance(); setLocale(locale);
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [i18n] } }); await flushPromises();
  const preview = document.body.querySelector('[data-testid="ai-outbound-preview"]')!, text = preview.textContent ?? '';
  expect.soft(text).toMatch(locale === 'en' ? /cost.*wait|wait.*cost/i : /费用.*等待|等待.*费用/);
  const budgets = ai.outboundPreview!.preview.budgets;
  for (const key of ['maxRequests', 'maxOutputTokens', 'totalOutputTokens', 'deadlineMs', 'requestTimeoutMs', 'evidenceCount'] as const) expect.soft(text).toContain(String(budgets[key]));
  expect.soft(text).toMatch(/tokens?/i); expect.soft(text).toContain(locale === 'en' ? 'ms' : '毫秒');
  expect.soft(text).toMatch(locale === 'en' ? /model settings/i : /模型设置/);
  const capability = [...preview.querySelectorAll('p')].find(p => (p.textContent ?? '').startsWith(locale === 'en' ? 'Declared capabilities' : '能力声明'));
  expect.soft(capability?.textContent).toMatch(locale === 'en' ? /\bconfirmed\b/i : /已确认/);
  const evidenceBudget = [...preview.querySelectorAll('tr')].find(row => (row.textContent ?? '').startsWith(locale === 'en' ? 'Evidence count' : '证据数量'));
  expect.soft(evidenceBudget?.textContent).toContain(locale === 'en' ? '20 items' : '20 项');
  expect.soft(text).toMatch(locale === 'en' ? /not.*(?:exact|actual)|unconfirmed/i : /不是.*(?:精确|实际)|未确认/);
  expect(preview.querySelector('pre')).toBeNull(); expect(text).not.toContain('"maxRequests"'); expect(started).toEqual([]);
});

it.each(['case-suggestion', 'assertion-suggestion', 'report-analysis'] as const)('final C M7 real %s preview uses its own bilingual business drawer title', async purpose => {
  const { ai, editor, started } = await seedAiBusinessFixture(), locator = editor.locator!;
  if (purpose === 'report-analysis') await ai.prepareReportAnalysis({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } }, report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) } });
  else if (purpose === 'assertion-suggestion') await ai.prepareAssertions({ caseId: editor.api!.cases[0]!.id, scope: editor.api!.cases[0]!.scope });
  else await ai.fetchSuggestions();
  expect(ai.outboundPreview!.preview.purpose).toBe(purpose);
  const ui = createI18nInstance(); ui.setLocale('zh-CN'); mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [ui.i18n] } }); await flushPromises();
  expect.soft(document.body.querySelector('.ant-drawer-title')!.textContent).toMatch(purpose === 'case-suggestion' ? /用例/ : purpose === 'assertion-suggestion' ? /断言/ : /报告/);
  ui.setLocale('en'); await flushPromises();
  expect(document.body.querySelector('.ant-drawer-title')!.textContent).toMatch(purpose === 'case-suggestion' ? /cases/i : purpose === 'assertion-suggestion' ? /assertion/i : /report/i);
  expect(started).toEqual([]);
});

it('final C R73 large real evidence catalog remains open after budget failure and can clear then explicitly preview one ID', async () => {
  const { ai, api, editor, started, prepared } = await seedAiBusinessFixture(), locator = editor.locator!, before = JSON.stringify(editor.api);
  const project = createContractExecutionProject('https://synthetic.example.test'); project.id = locator.projectId;
  const snapshot = createProjectSnapshot(project), time = '2026-11-01T00:00:00Z';
  const report: RunResult = { collectionId: locator.collectionId, collectionName: 'Large saved report', projectId: locator.projectId, total: 70, passed: 0, failed: 70, startedAt: time, finishedAt: time,
    cases: Array.from({ length: 70 }, (_, row) => ({ apiId: locator.apiId, apiName: 'Saved API', caseId: editor.api!.cases[0]!.id, caseName: 'Saved case', row, passed: false, durationMs: 1, assertions: [], error: 'Safe repeated diagnostic '.repeat(80),
      evidence: { identity: { projectId: locator.projectId, definitionRevision: snapshot.definitionRevision }, state: 'collected', truncated: false, scriptDiagnostics: 'not-collected' } })) };
  const coreInput = { purpose: 'report-analysis' as const, snapshot, context: snapshot.context, source: { kind: 'local' as const, bindingId: 'owned', rootIdentity: 'opaque-root', projectId: locator.projectId, definitionRevision: snapshot.definitionRevision, editRevision: 0 },
    bodySelection: [], reportId: 'owned-report', report, maxContextBytes: 15000 };
  const catalog = inspectAiContextChoices(coreInput); expect(catalog.evidence.length).toBeGreaterThan(200);
  expect(() => prepareAiContext(coreInput)).toThrow(/context-budget/);
  const inspect = api.aiInspectChoices, prepare = api.aiPrepareAssistance;
  api.aiInspectChoices = async input => { const value = await inspect(input); return { ...value, source: catalog.source,
    bodies: { ...value.bodies, items: catalog.bodies, total: catalog.bodies.length, selectable: catalog.bodies.length, returned: catalog.bodies.length, omitted: 0, complete: true },
    evidence: { ...value.evidence, items: catalog.evidence.slice(0, 20), total: catalog.evidence.length, selectable: catalog.evidence.length,
    returned: 20, omitted: 0, complete: false, nextCursor: crypto.randomUUID() } }; };
  api.aiPrepareAssistance = async input => {
    // External host returns the same formal Core projection, with its genuine byte rejection and genuine selection IDs.
    const projected = prepareAiContext({ ...coreInput, evidenceSelection: input.evidenceSelection });
    const value = await prepare(input); return { ...value, preview: { ...value.preview, ...projected } };
  };
  await ai.prepareReportAnalysis({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } }, report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) } });
  expect(ai.drawerOpen).toBe(true); expect(ai.contentChoices!.evidence.selectable).toBeGreaterThan(200); expect(ai.outboundPreview).toBeNull();
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  const clear = [...document.body.querySelectorAll('button')].find(button => /清空.*证据|clear.*evidence/i.test(button.textContent ?? ''));
  expect(clear, 'large catalog needs a reachable clear-evidence action, not hundreds of unchecks').toBeDefined();
  if (!clear) return;
  await new DOMWrapper(clear).trigger('click'); await flushPromises(); expect(ai.contentEvidenceIds).toEqual([]); expect(ai.outboundPreview).toBeNull();
  await new DOMWrapper(document.body.querySelector<HTMLInputElement>('[data-testid="ai-content-evidence"]')!).setValue(true); await flushPromises();
  await new DOMWrapper(document.body.querySelector('[data-testid="ai-repreview-content"]')!).trigger('click'); await flushPromises();
  expect(prepared.at(-1)!.evidenceSelection).toEqual([catalog.evidence[0]!.id]); expect(ai.outboundPreview!.preview.evidence.map(item => item.id)).toEqual([catalog.evidence[0]!.id]);
  await new DOMWrapper(clear).trigger('click'); await flushPromises(); expect(ai.outboundPreview).toBeNull();
  await ai.confirmAssistance(); expect(started).toEqual([]); expect(JSON.stringify(editor.api)).toBe(before);
});

it('final B I4 actual outbound drawer offers evidence and default-off body selection with explicit repreview', async () => {
  const { ai, editor, started } = await seedAiBusinessFixture(), locator = editor.locator!;
  await ai.prepareReportAnalysis({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } },
    report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) }, displayed: { verdict: 'failed' } });
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  const content = document.body.textContent ?? '';
  expect.soft(content).toMatch(/选择证据|证据选择/);
  expect.soft(content).toMatch(/重新预览/);
  expect.soft(document.body.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(0);
  expect(started).toEqual([]);
});
it('final B I3 actual report details offer the exact saved case as observation basis without execution', async () => {
  const { ai, api, workspace, editor, started } = await seedAiBusinessFixture(), run = useRunStore(api), locator = editor.locator!, saved = editor.api!.cases[0]!;
  const { apiId: _api, folderIds: _folders, ...collection } = locator;
  const panel = mount(RunView, { props: { run, workspace, selectedCollectionLocator: collection, reportError() {}, ai }, global: { plugins: [createI18nInstance().i18n] } });
  run.result = { collectionId: collection.collectionId, collectionName: 'saved report', total: 1, passed: 0, failed: 1, cases: [
    { apiId: locator.apiId, apiName: 'saved API', caseId: saved.id, caseName: saved.name, locator: { ...locator, caseId: saved.id, scope: saved.scope }, passed: false, durationMs: 1, assertions: [],
      evidence: { identity: { projectId: locator.projectId, definitionRevision: 'fixture-definition', locator: { ...locator, caseId: saved.id, scope: saved.scope } }, state: 'collected', scriptDiagnostics: 'not-collected', truncated: false, response: { status: 503, headers: { text: '', truncated: false }, body: { text: '', truncated: false } } } },
  ], startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:00:01.000Z' };
  await flushPromises();
  expect(panel.text()).toMatch(/选为断言观测依据|用此观测建议断言/);
  expect(started).toEqual([]);
});
it.each(['missing', 'missing-scope', 'missing-folderIds'] as const)('final B I3 unlocated report rows have a readable disabled observation entry: %s', async kind => {
  const { ai, api, workspace, editor } = await seedAiBusinessFixture(), run = useRunStore(api), locator = editor.locator!, saved = editor.api!.cases[0]!;
  const { apiId: _api, folderIds: _folders, ...collection } = locator;
  const panel = mount(RunView, { props: { run, workspace, selectedCollectionLocator: collection, reportError() {}, ai }, global: { plugins: [createI18nInstance().i18n] } });
  run.result = { collectionId: collection.collectionId, collectionName: 'saved report', total: 1, passed: 0, failed: 1, startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z',
    cases: [{ apiId: locator.apiId, apiName: 'API', caseId: saved.id, caseName: saved.name, passed: false, durationMs: 1, assertions: [],
      ...(kind === 'missing' ? {} : { locator: (kind === 'missing-scope' ? { ...locator, caseId: saved.id } : { ...locator, folderIds: undefined, caseId: saved.id, scope: saved.scope }) as never }) }] };
  await flushPromises();
  expect(panel.text()).toMatch(/定位不足|缺少完整定位/);
  const button = panel.find('[data-testid="ai-select-observation"]'); expect(button.exists()).toBe(true);
  expect(button.attributes('disabled')).toBeDefined();
});
it('final B I4 metadata remains selectable when full prepared input is over budget', async () => {
  const { ai, api, editor } = await seedAiBusinessFixture(), locator = editor.locator!, inspect = api.aiInspectChoices;
  let inspections = 0;
  api.aiInspectChoices = async input => { inspections++; return inspect(input); };
  api.aiPrepareAssistance = async () => { throw new Error('context-budget'); };
  await ai.prepareReportAnalysis({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } }, report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) } });
  expect(inspections).toBe(1);
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  expect(document.body.textContent).toMatch(/选择证据|证据选择/);
  expect(document.body.querySelector('[data-testid="ai-confirm-send"]')).toBeNull();
});
it('final B UI explicit evidence and body changes invalidate preview and require subset repreview without sending', async () => {
  const { ai, editor, prepared, started } = await seedAiBusinessFixture(), locator = editor.locator!, before = JSON.stringify(editor.api);
  await ai.prepareReportAnalysis({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } }, report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) } });
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  const body = new DOMWrapper(document.body.querySelector<HTMLInputElement>('[data-testid="ai-content-body"]')!);
  expect(body.element.checked).toBe(false);
  await new DOMWrapper(document.body.querySelector<HTMLInputElement>('[data-testid="ai-content-evidence"]')!).setValue(false); await flushPromises();
  expect(ai.outboundPreview).toBeNull(); await ai.confirmAssistance(); expect(started).toEqual([]);
  await new DOMWrapper(document.body.querySelector('[data-testid="ai-repreview-content"]')!).trigger('click'); await flushPromises();
  expect(prepared.at(-1)!.evidenceSelection).not.toContain('logic:e1'); expect(prepared.at(-1)!.bodySelection).toEqual([]);
  await body.setValue(true); await flushPromises(); expect(ai.outboundPreview).toBeNull(); expect(ai.contentEvidenceIds).toEqual([]);
  await new DOMWrapper(document.body.querySelector<HTMLInputElement>('[data-testid="ai-content-evidence"]')!).setValue(true); await flushPromises();
  await new DOMWrapper(document.body.querySelector('[data-testid="ai-repreview-content"]')!).trigger('click'); await flushPromises();
  expect(prepared.at(-1)!.bodySelection).toEqual(['cases[0].evidence.response.body']); expect(prepared.at(-1)!.evidenceSelection).toEqual(['logic:e1']);
  expect(started).toEqual([]); expect(JSON.stringify(editor.api)).toBe(before);
});
it('final B UI report-row selection reaches exact saved observation in CasePanel without running', async () => {
  const { ai, api, workspace, editor, prepared, started } = await seedAiBusinessFixture(), run = useRunStore(api), locator = editor.locator!, saved = editor.api!.cases[0]!;
  const { apiId: _api, folderIds: _folders, ...collection } = locator;
  const panel = mount(RunView, { props: { run, workspace, selectedCollectionLocator: collection, reportError() {}, ai }, global: { plugins: [createI18nInstance().i18n] } });
  run.result = { collectionId: collection.collectionId, collectionName: 'saved report', total: 1, passed: 0, failed: 1, startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z',
    cases: [{ apiId: locator.apiId, apiName: 'API', caseId: saved.id, caseName: saved.name, locator: { ...locator, caseId: saved.id, scope: saved.scope }, passed: false, durationMs: 1, assertions: [] }] };
  await flushPromises(); await panel.find('[data-testid="ai-select-observation"]').trigger('click'); await flushPromises();
  const casePanel = mount(CasePanel, { props: { editor, cases: useCasesStore(api, editor), ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  await casePanel.find('[data-testid="ai-assertion-basis"]').setValue('observation');
  await casePanel.find('[data-testid="ai-suggest-assertions"]').trigger('click'); await flushPromises();
  expect(prepared.at(-1)!.selection.business).toMatchObject({ purpose: 'assertion-suggestion', target: { apiId: locator.apiId, caseId: saved.id, scope: saved.scope }, basis: { kind: 'observation', caseIndex: 0, report: { kind: 'current' } } });
  expect(started).toEqual([]);
});

// Existing-behavior verification ONLY: the renderer V1 rejection predates this test and is pending a root/user ruling.
it('T11 pending V1 deviation currently refuses a valid legacy record with a readable ownership reason', async () => {
  const { ai, api, editor, workspace, prepared, started } = await seedAiBusinessFixture(); const locator = editor.locator!;
  const history = useDebugHistoryStore(api), debug = useDebugStore(api, editor, () => ({ root: workspace.root, readOnly: false }));
  const record = DebugHistoryRecordSchema.parse({ formatVersion: 1, historyId: '00000000-0000-4000-8000-000000000055', createdAt: '2026-10-31T01:00:00.000Z',
    result: { runId: 'legacy-debug', sourceApiRevision: 'api', sourceProjectRevision: 'project', executionSnapshotRevision: 'snapshot', mode: 'request', locator,
      startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z',
      run: { collectionName: 'legacy', startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z', total: 0, passed: 0, failed: 0 },
      outcomes: [], exchanges: [], exchangeTotal: 0, omittedExchangeCount: 0, replay: { mode: 'request', locator, parameters: {}, fields: [], available: false }, console: [], warnings: [] } });
  Object.assign(history, { selected: { record, diagnostics: [] } });
  const projectLocator = { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
  const panel = mount(DebugHistory, { props: { open: true, api, history, debug, editor, projectLocator, ai }, global: { plugins: [createI18nInstance().i18n] } });
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  const button = document.body.querySelector('[data-testid="ai-analyze-report"]'); expect(button).not.toBeNull();
  await new (await import('@vue/test-utils')).DOMWrapper(button!).trigger('click'); await flushPromises();
  expect(prepared).toEqual([]); expect(started).toEqual([]);
  expect.soft(ai.businessError).toBe('ai-report-unattributable'); expect.soft(ai.settingsIssue).toBeNull();
  expect(document.body.textContent).toContain('报告缺少可证明的来源归属'); expect(panel.exists()).toBe(true);
});

// Catches selecting only SuiteOutput.result instead of the exact public envelope shown by the testing store.
it('T11 B6 preserves a legitimate local report without an active API editor', async () => {
  const { api, editor, workspace } = await seedAiBusinessFixture(); const locator = editor.locator!;
  editor.activeKey = null;
  const ai = (await import('../../../src/renderer/src/stores/ai.js')).createAiStore({ api, editor,
    getContext: () => ({ root: workspace.root, readOnly: false }), getSource: () => null, getSourceVersion: () => null });
  await ai.init();
  await ai.prepareReportAnalysis({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } },
    displayed: { collectionName: 'retained public report', total: 0, passed: 0, failed: 0, cases: [] } });
  expect(ai.outboundPreview?.preview.purpose).toBe('report-analysis');
  await ai.confirmAssistance(); expect(ai.businessResult?.purpose).toBe('report-analysis');
});

it('T11 prepares current report analysis from the exact displayed suite envelope without sending a renderer report object', async () => {
  const { ai, editor, prepared } = await seedAiBusinessFixture(); const locator = editor.locator!;
  const source: AiSourceRef = { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } };
  const displayed = { invocationId: 'suite-owned-id', context: { root: '/tmp/ws', revision: 'rev1' }, result: { cases: [], failed: 0, passed: 0, total: 0 } };
  const before = JSON.stringify(displayed);
  const digest = createHash('sha256').update('apicc-ai-report-selection:v1\n{"context":{"revision":"rev1","root":"/tmp/ws"},"invocationId":"suite-owned-id","result":{"cases":[],"failed":0,"passed":0,"total":0}}').digest('hex');
  const surface = ai as typeof ai & { prepareReportAnalysis?: (input: { source: AiSourceRef; displayed: unknown }) => Promise<void> };
  await surface.prepareReportAnalysis?.({ source, displayed });
  expect(prepared).toHaveLength(1);
  expect(prepared[0]!.selection.business).toEqual({ purpose: 'report-analysis', report: { kind: 'current', expectedReportDigest: digest } });
  expect(prepared[0]).not.toHaveProperty('report'); expect(prepared[0]).not.toHaveProperty('displayed'); expect(JSON.stringify(displayed)).toBe(before);
});

// Catches primary JSON output and zero logical outcomes hiding an actual native transport failure.
it('T11 separates conclusion program facts hypotheses evidence and limitations without hiding debug failures or inventing request zeroes', async () => {
  const { ai } = await seedAiBusinessFixture(); const result = fixtureBusinessResult('report-analysis'); const before = JSON.stringify(result);
  (ai as unknown as { businessResult: unknown }).businessResult = result; ai.drawerOpen = true;
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  expect(document.body.textContent).toContain('Review the transport failure separately from logical success');
  for (const text of ['主要结论', '程序观测事实', '可能原因', '核查建议', '证据', '限制', 'Synthetic transport refused', 'TransportError']) expect(document.body.textContent).toContain(text);
  expect(document.body.textContent).toContain('未采集');
  expect(document.body.querySelector('pre')).toBeNull(); expect(JSON.stringify(result)).toBe(before);
});

// Catches an analysis product that is unreachable from the actual displayed collection report.
it('T11 exposes report analysis in the existing RunView', async () => {
  const { ai, api, workspace, editor } = await seedAiBusinessFixture(); const run = useRunStore(api);
  const { apiId: _api, folderIds: _folders, ...collection } = editor.locator!;
  const panel = mount(RunView, { props: { run, workspace, selectedCollectionLocator: collection, reportError() {}, ai } as never, global: { plugins: [createI18nInstance().i18n] } });
  run.result = { collectionId: collection.collectionId, collectionName: 'fixture report', total: 0, passed: 0, failed: 0, cases: [], startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z' };
  await flushPromises(); expect(panel.text()).toContain('AI 分析报告');
});

// Catches silently analysing retained A after the view has switched to public result B.
it('T11 refuses confirming a RunView report after the displayed public result is replaced', async () => {
  const { ai, api, workspace, editor } = await seedAiBusinessFixture(); const run = useRunStore(api);
  const { apiId: _api, folderIds: _folders, ...collection } = editor.locator!;
  const panel = mount(RunView, { props: { run, workspace, selectedCollectionLocator: collection, reportError() {}, ai }, global: { plugins: [createI18nInstance().i18n] } });
  run.result = { collectionId: collection.collectionId, collectionName: 'A', total: 0, passed: 0, failed: 0, cases: [], startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z' };
  await flushPromises(); await panel.get('[data-testid="ai-analyze-report"]').trigger('click'); await flushPromises();
  const started: unknown[] = [], start = api.aiStart; api.aiStart = async input => { started.push(input); return start(input); };
  run.result = { ...run.result, collectionName: 'B' }; await ai.confirmAssistance();
  expect(started).toEqual([]);
});

// Catches untrusted text being treated as a file/path/URL navigation instruction.
it('T11 locates only an authorised evidence ID through the supplied existing evidence callback', async () => {
  const { ai, editor } = await seedAiBusinessFixture(); const locator = editor.locator!; const located: string[] = [];
  await (ai.prepareReportAnalysis as (input: unknown) => Promise<void>)({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } },
    report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) }, displayed: { verdict: 'failed' }, canLocateEvidence: (evidence: AiEvidence) => evidence.id === 'debug:e1', locateEvidence: (evidence: AiEvidence) => { located.push(evidence.id); } });
  await ai.confirmAssistance();
  const surface = ai as typeof ai & { locateEvidence?: (id: string) => void };
  surface.locateEvidence?.('debug:e1'); expect(located).toEqual(['debug:e1']);
  surface.locateEvidence?.('https://untrusted.example.test/path'); surface.locateEvidence?.('../report.json'); expect(located).toEqual(['debug:e1']);
});

// Catches modifying original verdict/bytes or exporting bodies instead of a safe independent AI copy.
it('T11 exports a separate safe AI analysis copy with model source millisecond time and timezone', async () => {
  const { ai } = await seedAiBusinessFixture(); const result = fixtureBusinessResult('report-analysis');
  result.source.report = { reportId: 'owned-report-a', definitionRevision: 'definition-a', formatVersion: 2, startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z', summary: { total: 0, failed: 0 } };
  if (result.purpose !== 'report-analysis') throw new Error('fixture purpose');
  result.evidence = [...result.evidence, { purpose: 'report-analysis', id: 'body:e1', kind: 'body-text', location: 'cases[0].evidence.response.body', state: 'collected', value: 'BODY_MUST_NOT_EXPORT' }];
  ai.businessResult = result; const original = JSON.stringify(result);
  const surface = ai as typeof ai & { exportAnalysis?: () => { filename: string; content: string } | null };
  const exported = surface.exportAnalysis?.();
  expect(exported?.content ?? '').toContain('AI 辅助');
  for (const text of ['manual-model-A', 'owned-report-a', '2026-10-31T01:02:03.004Z', 'UTC']) expect(exported?.content).toContain(text);
  expect(exported?.content).not.toContain('BODY_MUST_NOT_EXPORT'); expect(JSON.stringify(result)).toBe(original);
});

// Catches missing non-computable metrics or known warnings behind empty/JSON metadata.
it('T11 renders stress availability completeness reasons and native debug warnings as business facts', async () => {
  const { ai } = await seedAiBusinessFixture(); const result = fixtureBusinessResult('report-analysis'); if (result.purpose !== 'report-analysis') throw new Error('fixture purpose');
  result.analysis.observedFacts = [
    { purpose: 'report-analysis', id: 'metric:e1', kind: 'stress-metrics', location: 'metrics', state: 'collected', value: { rps: null, latency: { availability: 'unavailable', reason: 'insufficient-samples' } } },
    { purpose: 'report-analysis', id: 'complete:e1', kind: 'stress-completeness', location: 'completeness', state: 'collected', value: { execution: { complete: false, reasons: ['cancelled'] }, metrics: { complete: false, reasons: ['snapshot-missing'] }, load: { complete: true, reasons: [] } } },
    { purpose: 'report-analysis', id: 'warnings:e1', kind: 'debug-warnings', location: 'warnings', state: 'collected', value: ['Synthetic known debug warning'] },
  ]; ai.businessResult = result; ai.drawerOpen = true;
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  expect(document.body.textContent).toContain('Synthetic known debug warning');
  expect(document.body.textContent).toMatch(/不可计算|未采集/); expect(document.body.textContent).toMatch(/取消/); expect(document.body.textContent).toMatch(/快照/);
});

// Catches report helpers existing without actual source-specific entry points.
it.each(['stress', 'workflow', 'suite', 'online', 'debug'] as const)('T11 exposes the actual %s report analysis entry', async kind => {
  const { ai, api, workspace, editor } = await seedAiBusinessFixture(); const location = editor.locator!;
  const source: AiSourceRef = { kind: 'local', project: { workspaceId: location.workspaceId, groupId: location.groupId, projectId: location.projectId } };
  const result = { collectionId: location.collectionId, collectionName: 'report', startedAt: '2026-10-31T01:00:00.000Z', finishedAt: '2026-10-31T01:00:00.001Z', total: 0, passed: 0, failed: 0, cases: [] };
  let panel;
  if (kind === 'stress') panel = mount(StressReportView, { props: { report: stressV2Report(), ai, source, reportRef: { kind: 'stress', file: 'owned-stress.json' } } as never, global: { plugins: [createI18nInstance().i18n] } });
  else if (kind === 'workflow') panel = mount(WfResultDrawer, { props: { open: true, embedded: true, result: { workflowId: 'wf', workflowName: 'native workflow', status: 'enabled', ...result, skipped: 0, warnings: [], nodeResults: [] } satisfies WorkflowRunResult, projectLocator: source.project, ai } as never, global: { plugins: [createI18nInstance().i18n] } });
  else if (kind === 'suite') {
    const testing = createTestingStore(api, { confirmDiscard: () => true });
    testing.view = { context: { root: workspace.root, project: source.project, revision: 'fixture-revision' }, readOnly: false, datasets: [], suites: [], environments: [], collections: [], workflows: [], cases: [] };
    testing.suite = { formatVersion: 1, id: crypto.randomUUID(), name: 'suite', tags: [], failFast: false, reporters: ['html'], selection: { kind: 'explicit', entries: [] } };
    testing.result = { invocationId: 'owned-suite', context: testing.view!.context, result };
    panel = mount(SuitePanel, { props: { testing, ai } as never, global: { plugins: [createI18nInstance().i18n] } });
  } else if (kind === 'online') {
    const execution = createOnlineExecutionStore(api); execution.activate({ serverId: 'https://member.example.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } });
    execution.localResult = { location: { kind: 'local' }, runId: 'owned-online-run', snapshotId: 'snap', manifestHash: 'a'.repeat(64), runtimeCompatibilityId: 'runtime', scriptTimeoutMs: 3000, output: { kind: 'failure', targetKind: 'workflow', error: 'synthetic', result } };
    execution.resultSelection = { kind: 'local', runId: 'owned-online-run' };
    panel = mount(OnlineExecutionPanel, { props: { execution, ai } as never, global: { plugins: [createI18nInstance().i18n] } });
  } else {
    const history = useDebugHistoryStore(api), debug = useDebugStore(api, editor, () => ({ root: workspace.root, readOnly: false }));
    const native: DebugResult = { runId: 'owned-debug-run', source: { sourceKind: 'asset', locator: location, sourceApiRevision: 'api-revision' }, sourceProjectRevision: 'definition', executionSnapshotRevision: 'snapshot', mode: 'request',
      startedAt: result.startedAt, finishedAt: result.finishedAt, run: { collectionName: 'debug', startedAt: result.startedAt, finishedAt: result.finishedAt, total: 0, passed: 0, failed: 0 }, outcomes: [], exchanges: [], exchangeTotal: 0, omittedExchangeCount: 0,
      replay: { mode: 'request', sourceKind: 'asset', locator: location, parameters: {}, fields: [], available: false }, console: [], warnings: [], failureKind: 'transport', error: 'Synthetic native failure' };
    const selected: import('@apicc/core').DebugHistoryReadResult = { record: { formatVersion: 2, historyId: '00000000-0000-4000-8000-000000000055', createdAt: result.startedAt, result: native }, diagnostics: [] };
    Object.assign(history, { selected });
    panel = mount(DebugHistory, { props: { open: true, api, history, debug, editor, projectLocator: source.project, ai } as never, global: { plugins: [createI18nInstance().i18n] } });
  }
  await flushPromises(); expect(kind === 'debug' ? document.body.textContent : panel.text()).toContain('AI 分析报告');
});

// Catches host ownership/staleness failures becoming invisible or retrying real requests to repair proof.
it.each(['ai-current-report-changed', 'ai-report-unattributable'] as const)('T11 shows a readable %s report refusal without automatic rerun', async code => {
  const { ai, api, editor } = await seedAiBusinessFixture(); const locator = editor.locator!; let starts = 0, runs = 0;
  api.aiPrepareAssistance = async () => { throw new Error(code); };
  const start = api.aiStart; api.aiStart = async input => { starts++; return start(input); };
  const run = api.runCollection; api.runCollection = async input => { runs++; return run(input); };
  await ai.prepareReportAnalysis({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } }, displayed: { verdict: 'failed' } });
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  expect(document.body.textContent ?? '').toMatch(/报告.*(过期|归属|证明)/); expect(starts).toBe(0); expect(runs).toBe(0);
});

// Catches silently dropping the user's narrowed authorised evidence selection when preparing again.
it('T11 keeps an explicit report evidence selection in the trusted prepare request', async () => {
  const { ai, editor, prepared } = await seedAiBusinessFixture(); const locator = editor.locator!;
  await (ai.prepareReportAnalysis as (input: unknown) => Promise<void>)({ source: { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } },
    report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) }, displayed: { verdict: 'failed' }, evidenceSelection: ['logic:e1'] });
  expect(prepared[0]?.evidenceSelection).toEqual(['logic:e1']);
});
