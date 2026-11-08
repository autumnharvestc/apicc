// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import type { DebugResult, RunResult, SafeExecutionEvidence } from '@apicc/core';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import { createMemoryApi } from '../../../src/renderer/src/api/memory.js';
import { useWorkspaceStore } from '../../../src/renderer/src/stores/workspace.js';
import { useRunStore } from '../../../src/renderer/src/stores/run.js';
import RunView from '../../../src/renderer/src/components/RunView.vue';
import CaseEvidencePanel from '../../../src/renderer/src/components/CaseEvidencePanel.vue';
import ResponseViewer from '../../../src/renderer/src/components/ResponseViewer.vue';

const originalStyle = window.getComputedStyle;
beforeAll(() => {
  window.getComputedStyle = element => originalStyle.call(window, element);
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
afterAll(() => { window.getComputedStyle = originalStyle; });
enableAutoUnmount(afterEach);
function language() { const { i18n } = createI18nInstance(); i18n.global.locale.value = 'zh-CN'; return i18n; }
const base = (): RunResult => ({ collectionId: 'c', collectionName: '合成运行', startedAt: '2026-11-08T00:00:00Z', finishedAt: '2026-11-08T00:00:01Z', total: 3, passed: 2, failed: 1, cases: [], reportingMode: 'workflow-invocation-v2', workflowUnits: [{ entryId: 'checkout', workflowId: 'wf', verdict: 'passed' }], workflow: { total: 2, passed: 1, failed: 0, skipped: 1, entries: [{ entryId: 'pay', kind: 'workflow', workflowId: 'wf', label: '支付节点', nodeKind: 'request', status: 'passed' }, { entryId: 'optional', kind: 'workflow', workflowId: 'wf', nodeKind: 'condition', status: 'skipped', skipReason: 'condition-pruned' }] } });
async function runView(result: RunResult) {
  const api = createMemoryApi(); api.seedWorkspace();
  const workspace = useWorkspaceStore(api); await workspace.open(await api.wsPickDirectory());
  const run = useRunStore(api), i18n = language();
  const wrapper = mount(RunView, { props: { run, workspace, selectedCollectionLocator: null, reportError: () => {} }, global: { plugins: [i18n] } });
  await flushPromises(); run.result = result; await flushPromises();
  return { wrapper, run, i18n };
}
const preview = (text: string) => ({ text, truncated: false });
const proof = (): SafeExecutionEvidence => ({ identity: { projectId: 'p', definitionRevision: '1234567890abcdef'.repeat(4), rowIndex: 0, entryId: 'checkout', nodeId: 'pay' }, state: 'collected', truncated: false, scriptDiagnostics: 'existing-assertions-only', assertions: [{ id: preview('assert-1'), op: preview('equals'), selector: preview('$.status'), code: preview('ASSERT_MISMATCH'), message: preview('业务原文 <b>失败</b>'), pass: false, actual: preview('"pending"'), expected: preview('"paid"'), differencePath: preview('$.status') }], extractions: [{ id: preview('e1'), name: preview('订单编号'), selector: preview('$.id'), code: preview('CUSTOM'), message: preview('未发布原因'), status: 'custom-v9', published: false, sensitive: true, value: preview('[REDACTED]') }] });

describe('P3 report presentation', () => {
  it('preserves scope environment names even when they resemble application categories', async () => {
    const evidence = proof(), i18n = language();
    const locator = { collectionId: 'c', folderIds: [], apiId: 'a', caseId: 'case', scope: 'project' };
    const wrapper = mount(CaseEvidencePanel, { props: { evidence: { ...evidence, identity: { ...evidence.identity, locator } } }, global: { plugins: [i18n] } });
    const scopeText = () => wrapper.findAll('.identity-grid > div').find(field => field.get('dt').text() === (i18n.global.locale.value === 'en' ? 'Scope' : '作用域'))!.get('dd').text();
    for (const scope of ['project', 'global', 'api', 'collection', '生产环境']) {
      await wrapper.setProps({ evidence: { ...evidence, identity: { ...evidence.identity, locator: { ...locator, scope } } } });
      expect.soft(scopeText()).toBe(scope);
    }
    i18n.global.locale.value = 'en'; await flushPromises(); expect(scopeText()).toBe('生产环境');
    await wrapper.setProps({ evidence: { ...evidence, identity: { ...evidence.identity, locator: { ...locator, scope: 'base' } } } });
    expect(scopeText()).toBe('Base');
  });
  it('shows logical and raw populations separately, readable workflow rows and live language changes', async () => {
    const { wrapper, i18n } = await runView(base());
    expect(wrapper.get('[data-testid="run-logical-summary"]').text()).toContain('共 1 条 · 通过 1 · 失败 0 · 跳过 0');
    expect(wrapper.get('[data-testid="run-raw-summary"]').text()).toContain('共 3 条 · 通过 2 · 失败 1 · 跳过 0');
    const rows = wrapper.get('[data-testid="run-workflow-entries"]');
    expect(rows.text()).toContain('支付节点'); expect(rows.text()).toContain('请求'); expect(rows.text()).toContain('未选中此条件分支');
    expect(rows.findAll('tbody tr')).toHaveLength(2); expect(rows.find('pre').exists()).toBe(false);
    i18n.global.locale.value = 'en'; await flushPromises();
    expect(wrapper.get('[data-testid="run-logical-summary"]').text()).toContain('1 total · 1 passed · 0 failed · 0 skipped');
    expect(rows.text()).toContain('Request'); expect(rows.text()).toContain('Skipped'); expect(rows.text()).toContain('支付节点');
  });
  it('keeps budget-projected totals, diagnostics, suite reasons and unknown codes visible', async () => {
    const result = base(); result.reportFailure = true; result.evidenceOmitted = true;
    result.reportingUnits = { total: 8, passed: 5, failed: 2, skipped: 1, entryDiagnostics: 1 };
    result.suite = { suiteRunId: 'suite', projectId: 'p', definitionRevision: 'r', verdict: 'aborted', total: 2, passed: 1, failed: 1, skipped: 0, entries: [{ entryId: 'missing', kind: 'case', suiteRow: 0, status: 'aborted', error: '<script>business failure</script>' }] };
    result.workflow!.entries[0]!.nodeKind = 'future-kind'; result.warnings = ['保留的采集警告'];
    const { wrapper } = await runView(result);
    expect(wrapper.get('[data-testid="run-logical-summary"]').text()).toContain('共 8 条 · 通过 5 · 失败 2 · 跳过 1');
    expect(wrapper.get('[data-testid="run-report-limit"]').text()).toContain('不完整');
    const row = wrapper.get('[data-testid="run-suite-entries"] tbody tr');
    expect(row.text()).toContain('中止'); expect(row.text()).toContain('<script>business failure</script>'); expect(row.find('script').exists()).toBe(false);
    expect(row.findAll('td')[1]!.text()).toBe('1'); expect(wrapper.text()).toContain('future-kind'); expect(wrapper.text()).toContain('保留的采集警告');
    expect(wrapper.findAllComponents(CaseEvidencePanel)).toHaveLength(1);
  });
  it('keeps legacy row counts distinct from additional diagnostic units', async () => {
    const result = base(); delete result.reportingMode; delete result.workflowUnits; delete result.workflow;
    result.total = 0; result.passed = 0; result.failed = 0;
    result.suite = { suiteRunId: 's', projectId: 'p', definitionRevision: 'r', verdict: 'failed', total: 1, passed: 0, failed: 1, skipped: 0, entries: [{ entryId: 'missing', kind: 'case', status: 'failed', error: 'missing target' }] };
    const { wrapper } = await runView(result);
    expect(wrapper.get('[data-testid="run-logical-summary"]').text()).toContain('共 1 条 · 通过 0 · 失败 1');
    expect(wrapper.get('[data-testid="run-raw-summary"]').text()).toContain('共 0 条 · 通过 0 · 失败 0');
  });
  it('presents evidence fields and outcomes while retaining safe copy, disclosure and action gates', async () => {
    const evidence = proof(), i18n = language(), writeText = vi.fn(async () => {}), rerun = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const wrapper = mount(CaseEvidencePanel, { props: { evidence, inspect: async () => ({ available: true, changed: false, definitionRevision: evidence.identity.definitionRevision }), rerun }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.get('[data-testid="evidence-row"] dd').text()).toBe('1');
    const fingerprint = wrapper.get('[data-testid="evidence-fingerprint"]');
    expect(fingerprint.attributes('open')).toBeUndefined(); expect(fingerprint.get('summary').text()).toContain('1234567890ab'); expect(fingerprint.get('summary').text()).not.toContain(evidence.identity.definitionRevision);
    expect(fingerprint.text()).toContain(evidence.identity.definitionRevision);
    const assertion = wrapper.get('[data-testid="assertion-evidence"]');
    expect(assertion.get('header').text()).toContain('失败'); expect(assertion.text()).toContain('差异路径'); expect(assertion.text()).toContain('$.status'); expect(assertion.find('b').exists()).toBe(false);
    expect(wrapper.get('[data-testid="extraction-evidence"]').text()).toContain('custom-v9');
    await wrapper.get('[data-testid="evidence-locate"]').trigger('click'); expect(wrapper.emitted('locate')![0]![0]).toEqual(evidence.identity);
    await wrapper.get('[data-testid="evidence-rerun"]').trigger('click'); expect(rerun).toHaveBeenCalledExactlyOnceWith(evidence.identity);
    await wrapper.get('[data-testid="evidence-copy"]').trigger('click'); expect(writeText).toHaveBeenCalledExactlyOnceWith(JSON.stringify(evidence, null, 2));
    await wrapper.setProps({ disabled: true }); expect(wrapper.get('[data-testid="evidence-rerun"]').attributes('disabled')).toBeDefined();
    i18n.global.locale.value = 'en'; await flushPromises(); expect(assertion.text()).toContain('Actual'); expect(assertion.text()).toContain('业务原文');
  });
  it('rejects stale evidence inspection and keeps unavailable targets disabled after layout changes', async () => {
    const evidence = proof(), i18n = language(); let settle!: (value: { available: boolean; changed: boolean; definitionRevision: string }) => void;
    const inspect = vi.fn().mockImplementationOnce(() => new Promise(resolve => { settle = resolve; })).mockResolvedValueOnce({ available: false, changed: true, definitionRevision: 'new', reason: 'target missing' });
    const wrapper = mount(CaseEvidencePanel, { props: { evidence, inspect, rerun: vi.fn() }, global: { plugins: [i18n] } });
    await wrapper.setProps({ evidence: { ...evidence, identity: { ...evidence.identity, nodeId: 'new' } } }); await flushPromises();
    settle({ available: true, changed: false, definitionRevision: 'old' }); await flushPromises();
    expect(wrapper.text()).toContain('target missing'); expect(wrapper.find('[data-testid="evidence-revision-changed"]').exists()).toBe(true); expect(wrapper.get('[data-testid="evidence-locate"]').attributes('disabled')).toBeDefined();
  });
  it('renders console levels and literal messages in order without inventing timestamps', async () => {
    const i18n = language();
    const result: DebugResult = { runId: 'debug', source: { sourceKind: 'asset', locator: { workspaceId: 'w', groupId: 'g', projectId: 'p', collectionId: 'c', folderIds: [], apiId: 'a' }, sourceApiRevision: 'r' }, sourceProjectRevision: 'r', executionSnapshotRevision: 'r', mode: 'request', startedAt: '2026-11-08T00:00:00Z', finishedAt: '2026-11-08T00:00:01Z', run: { collectionName: 'c', startedAt: '', finishedAt: '', total: 0, passed: 0, failed: 0 }, outcomes: [], exchanges: [], exchangeTotal: 0, omittedExchangeCount: 0, replay: { mode: 'request', sourceKind: 'asset', parameters: {}, fields: [], available: false }, console: [{ level: 'info', message: '开始\n{"order":1}' }, { level: 'error', message: '<img src=x onerror=alert(1)>' }], warnings: [] };
    const wrapper = mount(ResponseViewer, { props: { result }, global: { plugins: [i18n] } });
    await wrapper.get('[data-testid="response-tab-console"]').trigger('click'); await flushPromises();
    const rows = wrapper.findAll('[data-testid="console-entry"]'); expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('信息'); expect(rows[0]!.get('.console-message').text()).toBe(result.console[0]!.message);
    expect(rows[1]!.text()).toContain('错误'); expect(rows[1]!.find('img').exists()).toBe(false); expect(wrapper.find('time').exists()).toBe(false);
    i18n.global.locale.value = 'en'; await flushPromises(); expect(rows[1]!.text()).toContain('Error');
    await wrapper.setProps({ result: { ...result, console: [] } }); await flushPromises(); expect(wrapper.findAll('[data-testid="console-entry"]')).toHaveLength(0); expect(wrapper.get('[data-testid="response-console"]').text()).toContain('no console capture capability');
  });
});
