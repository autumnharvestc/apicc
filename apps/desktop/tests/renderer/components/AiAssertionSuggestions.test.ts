// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import AiSuggestionsDrawer from '../../../src/renderer/src/components/AiSuggestionsDrawer.vue';
import CasePanel from '../../../src/renderer/src/components/CasePanel.vue';
import { useCasesStore } from '../../../src/renderer/src/stores/cases.js';
import { assertionCandidate, fixtureBusinessResult, seedAiBusinessFixture } from '../fixtures/aiBusiness.js';

beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }); localStorage.setItem('apicc.locale', 'zh-CN'); });
enableAutoUnmount(afterEach);

it('final B I3 selected CasePanel exposes contract and selected-observation basis choices', async () => {
  const { ai, api, editor } = await seedAiBusinessFixture(), cases = useCasesStore(api, editor);
  const panel = mount(CasePanel, { props: { editor, cases, ai } as never, global: { plugins: [createI18nInstance().i18n] } });
  await flushPromises();
  expect.soft(panel.text()).toMatch(/契约依据|契约/);
  expect.soft(panel.text()).toMatch(/观测依据|观测建议|已有报告|已有观测/);
});
it.each(['foreign-scope', 'foreign-api', 'stale-report'] as const)('final B UI selected observation is unavailable for %s', async kind => {
  const { ai, api, editor } = await seedAiBusinessFixture(), cases = useCasesStore(api, editor), saved = editor.api!.cases[0]!;
  ai.selectAssertionObservation({ target: { ...editor.locator!, caseId: saved.id, scope: kind === 'foreign-scope' ? 'other-scope' : saved.scope,
    ...(kind === 'foreign-api' ? { apiId: '00000000-0000-4000-8000-000000000099' } : {}) },
    basis: { kind: 'observation', report: { kind: 'current', expectedReportDigest: 'a'.repeat(64) }, caseIndex: 0 }, isCurrent: () => kind !== 'stale-report' });
  const panel = mount(CasePanel, { props: { editor, cases, ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  const observed = panel.find('option[value="observation"]'); expect(observed.exists()).toBe(true);
  expect(observed.attributes('disabled')).toBeDefined();
});
it('final B UI contract context is not advertised as optional report evidence', async () => {
  const { ai } = await seedAiBusinessFixture(); await ai.fetchSuggestions();
  expect(ai.contentChoices!.evidence.items).toHaveLength(1);
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  expect(document.body.querySelector('[data-testid="ai-content-evidence"]')).toBeNull();
  expect(document.body.querySelector('[data-testid="ai-content-body"]')).not.toBeNull();
});

// Catches assertion assistance preparing the whole API or replacing a failed expected value.
it('T11 prepares independent assertions for the exact case and appends selected assertions without replacing existing expected values', async () => {
  const { ai, api, editor, prepared } = await seedAiBusinessFixture();
  const identity = { caseId: editor.api!.cases[0]!.id, scope: editor.api!.cases[0]!.scope };
  const original = JSON.stringify(editor.api!.cases);
  const surface = ai as typeof ai & { prepareAssertions?: (identity: { caseId: string; scope: string }) => Promise<void> };
  await surface.prepareAssertions?.(identity);
  expect(prepared).toHaveLength(1);
  expect(prepared[0]!.selection.business).toEqual({ purpose: 'assertion-suggestion', target: {
    collectionId: editor.locator!.collectionId, folderIds: editor.locator!.folderIds, apiId: editor.locator!.apiId, ...identity }, basis: { kind: 'contract' } });
  let sends = 0; const debug = api.debugSend; api.debugSend = async (...args) => { sends++; return debug(...args); };
  await ai.confirmAssistance();
  expect(ai.selectedIds).toEqual([]); expect(JSON.stringify(editor.api!.cases)).toBe(original);
  ai.toggleSelect(assertionCandidate.assertion.id); expect(ai.adopt()).toBe(1);
  expect(editor.api!.cases[0]!.assertions.slice(0, -1)).toEqual(JSON.parse(original)[0].assertions);
  expect(editor.api!.cases[0]!.assertions.at(-1)?.expected).toBe('north'); expect(editor.dirty).toBe(true); expect(sends).toBe(0);
});

// Catches presenting only a count instead of readable target/operator/path/expected/basis/reason.
it('T11 shows independent assertion conditions and their basis in the existing drawer', async () => {
  const { ai } = await seedAiBusinessFixture();
  (ai as unknown as { businessResult: unknown }).businessResult = fixtureBusinessResult('assertion-suggestion'); ai.drawerOpen = true;
  mount(AiSuggestionsDrawer, { props: { ai }, global: { plugins: [createI18nInstance().i18n] } }); await flushPromises();
  expect(document.body.textContent).toContain('$.customer.region');
  for (const text of ['bodyJson', 'eq', 'north', 'Region is required by the API contract']) expect(document.body.textContent).toContain(text);
  expect(document.body.textContent).toMatch(/契约/);
});

// Catches making assertion assistance available only through an internal store method.
it('T11 exposes independent assertion assistance on the selected CasePanel case', async () => {
  const { ai, api, editor } = await seedAiBusinessFixture(); const cases = useCasesStore(api, editor);
  const panel = mount(CasePanel, { props: { editor, cases, ai } as never, global: { plugins: [createI18nInstance().i18n] } });
  expect(panel.text()).toContain('AI 建议断言');
});
