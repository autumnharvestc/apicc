// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import SharedHistoryPanel from '../../../src/renderer/src/components/online/SharedHistoryPanel.vue';
import { createCollaborationStore } from '../../../src/renderer/src/stores/collaboration.js';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import { context, port, history } from './collaboration-fixtures.js';
enableAutoUnmount(afterEach);
it.each([['zh-CN','已接受'],['en','Accepted']] as const)('final M01 localizes %s accepted state and protects compact identity/status headers',async(language,accepted)=>{
  const api=port(),store=createCollaborationStore(api),{i18n}=createI18nInstance();i18n.global.locale.value=language;store.context=context;
  api.override(input=>input.operation==='history'?{stage:'history',page:{items:[{...history(),state:'accepted',conclusion:'passed'},{...history('member-history'),state:'future-state'}],nextCursor:null}}:undefined);await store.loadHistory();
  const view=mount(SharedHistoryPanel,{props:{collaboration:store},global:{plugins:[i18n]}});expect(view.findAll('tbody tr')).toHaveLength(2);
  expect.soft(view.text()).toContain(accepted);expect.soft(view.text()).toContain('future-state');expect.soft(view.findAll('thead th.compact-column')).toHaveLength(2);expect(view.find('.table-scroll').exists()).toBe(true);
});
it.each([['zh-CN', ['已中断', '已取消', '已超时', '已拒绝']], ['en', ['Interrupted', 'Cancelled', 'Timed out', 'Rejected']]] as const)('round1 localizes every known conclusion filter in %s', async (language, labels) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = language; store.context = context; await store.loadHistory();
  const view = mount(SharedHistoryPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.findAll('tbody tr')).toHaveLength(2); for (const label of labels) expect.soft(view.get('[data-testid="history-conclusion"]').text()).toContain(label);
});
it.each(['server-report', 'member-history'] as const)('previews a selected %s by its original source reference rather than re-uploading its body', async kind => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; await store.loadHistory(); const view = mount(SharedHistoryPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); const row = view.findAll('tbody tr')[kind === 'server-report' ? 0 : 1]!; expect(row.text()).toContain('40');
  await row.get('[data-testid="history-publish"]').trigger('click'); await flushPromises(); expect(api.calls.at(-1)).toEqual({ operation: 'preview-online', context, input: { title: 'Selected history report', includeEvidence: false, source: kind === 'server-report' ? { kind, jobId: '40' } : { kind, uploadId: '40' } } }); expect(store.preview?.stage).toBe('server');
});
it('offers readable source/conclusion/page-size filters and sends one bounded selected query', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; await store.loadHistory(); const view = mount(SharedHistoryPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.findAll('tbody tr')).toHaveLength(2);
  await view.get('[data-testid="history-source"]').setValue('member-history'); await view.get('[data-testid="history-conclusion"]').setValue('failed'); await view.get('[data-testid="history-limit"]').setValue('1'); await view.get('[data-testid="history-filter"]').trigger('click'); await flushPromises(); expect(api.calls.at(-1)).toEqual({ operation: 'history', context, input: { source: 'member-history', conclusion: 'failed', limit: 1 } });
});
it.each([['zh-CN', '服务端归档', '成员上传历史', '旧结果未建立终态索引', '未采集'], ['en', 'Server archive', 'Member upload history', 'Legacy result has no terminal index', 'Not collected']] as const)('shows %s history provenance and unavailable facts without guessing runtime', async (locale, archive, member, legacy, unavailable) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = locale;
  store.context = context; await store.loadHistory();
  const view = mount(SharedHistoryPanel, { props: { collaboration: store }, global: { plugins: [i18n] } });
  expect(view.findAll('tbody tr')).toHaveLength(2);
  expect.soft(view.text()).toContain(archive); expect.soft(view.text()).toContain(member); expect.soft(view.text()).toContain(legacy); expect.soft(view.text()).toContain(unavailable);
  expect(view.find('pre').exists()).toBe(false);
});
it('keeps a next-page action for an empty filtered page with a continuation cursor', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context;
  api.override(input => input.operation === 'history' ? { stage: 'history', page: { items: [], nextCursor: 'sparse-next' } } : undefined); await store.loadHistory();
  const view = mount(SharedHistoryPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(store.historyCursor).toBe('sparse-next'); expect(view.findAll('tbody tr')).toHaveLength(0);
  expect(view.find('[data-testid="history-next"]').exists()).toBe(true);
});
it('keeps source filter and page limit on continuation and replaces rather than accumulates rows', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context;
  api.override(input => input.operation === 'history' ? { stage: 'history', page: { items: input.input.cursor ? [{ ...history(), id: '41' }] : [history()], nextCursor: input.input.cursor ? null : 'next-one' } } : undefined);
  await store.loadHistory({ source: 'server-report', conclusion: 'unknown', limit: 1 }); expect(store.history).toHaveLength(1);
  expect(api.calls[0]).toEqual({ operation: 'history', context, input: { source: 'server-report', conclusion: 'unknown', limit: 1 } });
  const view = mount(SharedHistoryPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); await view.get('[data-testid="history-next"]').trigger('click'); await flushPromises();
  expect(api.calls[1]).toEqual({ operation: 'history', context, input: { source: 'server-report', conclusion: 'unknown', limit: 1, cursor: 'next-one' } }); expect(store.history.map(row => row.id)).toEqual(['41']);
});
it('reads the selected member history with its source discriminator even when archive IDs collide', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; await store.loadHistory();
  const view = mount(SharedHistoryPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.findAll('tbody tr')).toHaveLength(2);
  const member = view.findAll('tbody tr')[1]!; await member.get('[data-testid="history-read"]').trigger('click'); await flushPromises();
  expect(api.calls.at(-1)).toEqual({ operation: 'read-history', context, input: { id: '40', source: 'member-history' } }); expect(view.text()).toContain('Selected safe report');
});
