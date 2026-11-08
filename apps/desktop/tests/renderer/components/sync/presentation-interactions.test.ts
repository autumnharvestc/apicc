// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { mountSyncPanel, candidateView, source, id } from './fixtures.js';
import { SyncHistoryEntrySchema } from '@apicc/core/sync/shared';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import SyncHistory from '../../../../src/renderer/src/components/sync/SyncHistory.vue';
import zh from '../../../../src/renderer/src/i18n/zh-CN.json';
import en from '../../../../src/renderer/src/i18n/en.json';

it.each(['zh-CN', 'en'] as const)('distinguishes filtered history and retains explicit rollback confirmation in %s', async language => {
  const candidate = candidateView().candidate;
  const content = { digest: 'a'.repeat(64), bytes: 12, contentType: 'application/vnd.apicc.sync-files+json' };
  const entry = SyncHistoryEntrySchema.parse({ formatVersion: 1, id: id(10), sourceId: source.id, projectId: id(1), intentId: id(8), operationKind: 'apply', actor: { id: '7', name: 'Member' }, createdAtMs: 1793980800123, beforeStamp: candidate.stamp, afterStamp: candidate.stamp, upstream: candidate.upstream, before: { definitionRevision: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) }, after: { definitionRevision: 'c'.repeat(64), manifestDigest: 'd'.repeat(64) }, rollback: { beforeContent: content, afterContent: content }, integritySha256: 'e'.repeat(64) });
  const wrapper = mount(SyncHistory, { props: { entries: [entry], search: 'not-present' }, global: { plugins: [createI18n({ legacy: false, locale: language, messages: { 'zh-CN': zh, en } })] } });
  try {
    expect(wrapper.get('p').text()).toBe(language === 'en' ? 'No matching history. Clear the search to show all records.' : '没有匹配的历史。清除搜索可查看全部记录。');
    await wrapper.setProps({ search: '' });
    expect(wrapper.text()).toContain('Member'); expect(wrapper.find('details').attributes('open')).toBeUndefined();
    await wrapper.get('button').trigger('click'); expect(wrapper.emitted('rollback')).toBeUndefined();
    await wrapper.get('.sync-confirm').findAll('button')[1]!.trigger('click'); expect(wrapper.emitted('rollback')).toBeUndefined();
    await wrapper.get('button').trigger('click');
    await wrapper.get('.sync-confirm button').trigger('click'); expect(wrapper.emitted('rollback')).toEqual([[entry]]);
    await wrapper.setProps({ disabled: true }); expect(wrapper.get('button').attributes('disabled')).toBeDefined();
    await wrapper.setProps({ entries: [], search: 'not-present' }); expect(wrapper.text()).toContain(language === 'en' ? en.sync.noHistory : zh.sync.noHistory);
  } finally { wrapper.unmount(); }
});

it.each(['zh-CN', 'en'] as const)('distinguishes filtered sources/changes from missing data and restores decisions and drafts in %s', async language => {
  const f = await mountSyncPanel(language);
  try {
    await f.showCandidate('project-a');
    await f.wrapper.get('[data-testid="sync-edit-source"]').trigger('click');
    await f.wrapper.get('input[type="url"]').setValue('https://source.test/unsaved.yaml');
    await f.wrapper.get('select[data-change]').setValue('keep-current');
    await f.wrapper.get('[data-testid="sync-keep-confirm"]').setValue(true);
    const candidate = f.store.candidate, sourceId = f.store.sourceId, decisions = [...f.store.decisions];
    await f.wrapper.get('[data-testid="sync-search"]').setValue('not-present-anywhere');
    expect(f.wrapper.get('[data-testid="sync-source-empty"]').text()).toBe(language === 'en' ? 'No matching sources. Clear the search to show all sources.' : '没有匹配的来源。清除搜索可查看全部来源。');
    expect(f.wrapper.get('[data-testid="sync-change-empty"]').text()).toBe(language === 'en' ? 'No matching changes. Existing decisions are retained.' : '没有匹配的变更，已有决策仍保留。');
    expect(f.wrapper.find('.sync-change').exists()).toBe(false);
    await f.wrapper.get('[data-testid="sync-clear"]').trigger('click');
    expect(f.wrapper.find('[data-testid="sync-change-empty"]').exists()).toBe(false);
    expect(f.wrapper.get<HTMLSelectElement>('select[data-change]').element.value).toBe('keep-current');
    expect(f.wrapper.get<HTMLInputElement>('input[type="url"]').element.value).toBe('https://source.test/unsaved.yaml');
    expect(f.store.candidate).toBe(candidate); expect(f.store.sourceId).toBe(sourceId);
    expect(f.store.decisions).toEqual(decisions); expect(f.store.keepConfirmed).toBe(true);
    expect(document.activeElement).toBe(f.wrapper.get('[data-testid="sync-search"]').element);
    expect(f.savedSources()).toHaveLength(0); expect(f.applicationCalls()).toHaveLength(0);
  } finally { f.unmount(); }
});
