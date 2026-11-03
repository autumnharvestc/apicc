// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { enableAutoUnmount, shallowMount, mount, flushPromises } from '@vue/test-utils';
import CollaborationPanel from '../../../src/renderer/src/components/online/CollaborationPanel.vue';
import { createCollaborationStore } from '../../../src/renderer/src/stores/collaboration.js';
import { context, port, publication, grant, server, source } from './collaboration-fixtures.js';
import { ContractWorkspaceSchema } from '@apicc/core/schema';
import { workspaceFixture } from '../../../../../packages/core/tests/helpers/contractFixtures.js';
import OnlineProjectAssets from '../../../src/renderer/src/components/online/OnlineProjectAssets.vue';
import { createOnlineStore } from '../../../src/renderer/src/stores/online.js';
import { createOnlineProjectAdapter } from '../../../src/renderer/src/stores/onlineProjectAdapter.js';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import type { ApiccApi } from '../../../src/shared/types.js';
enableAutoUnmount(afterEach);
it.each([['create','online'],['rotate','local']] as const)('addendum N01 original %s pending survives same-context %s preview selection and can reconcile',async(command,selection)=>{
  const api=port(),store=createCollaborationStore(api),{i18n}=createI18nInstance();store.context=context;await store.loadPublications();await store.loadGrants('41');
  let reject!:(error:Error)=>void;const waiting=new Promise<any>((_,no)=>{reject=no;});api.override(input=>input.operation===`${command}-grant`?waiting:undefined);
  const original=(command==='create'?store.createGrant('members',60000,false):store.grantCommand('rotate',store.grants[0]!)).catch(()=>{});
  await flushPromises();expect(store.grantBusy).toBe(true);expect(api.calls.filter(row=>row.operation===`${command}-grant`)).toHaveLength(1);
  if(selection==='online')await store.selectOnline({title:'New saved preview',includeEvidence:false,source:{kind:'document',revision:'12',manifestHash:'c'.repeat(64),scope:{kind:'project'}}});
  else await store.selectLocal(context,source,'New selected local preview');
  expect(store.preview?.stage).toBe(selection==='online'?'server':'local');reject(new Error('collaboration-grant-pending'));await original;
  expect.soft(store.grantBusy).toBe(false);expect.soft(store.grantPending).toBe(true);expect.soft(store.error).toBe('collaboration-grant-pending');
  const view=mount(CollaborationPanel,{props:{collaboration:store},global:{plugins:[i18n]}});
  expect.soft(view.get('[data-testid="reconcile-grant"]').attributes('disabled')).toBeUndefined();await view.get('[data-testid="reconcile-grant"]').trigger('click');await flushPromises();
  expect.soft(api.calls.filter(row=>row.operation==='reconcile-grant')).toHaveLength(1);expect.soft(store.result?.stage).toBe('grant-reconciled');expect.soft(store.grantBusy).toBe(false);expect.soft(store.grantPending).toBe(false);
  expect(api.calls.filter(row=>row.operation===`${command}-grant`)).toHaveLength(1);
});
it('addendum N01 admitted original reconciliation settles across another same-context preview',async()=>{
  const api=port(),store=createCollaborationStore(api);store.context=context;await store.loadPublications();await store.loadGrants('41');await store.createGrant('members',60000,false);expect(store.result?.stage).toBe('grant');
  let release!:(result:any)=>void;const waiting=new Promise<any>(yes=>{release=yes;});api.override(input=>input.operation==='reconcile-grant'?waiting:undefined);
  const reconciling=store.reconcile('grant');await flushPromises();expect(store.grantBusy).toBe(true);expect(api.calls.filter(row=>row.operation==='reconcile-grant')).toHaveLength(1);
  await store.selectOnline({title:'New saved preview',includeEvidence:false,source:{kind:'document',revision:'12',manifestHash:'c'.repeat(64),scope:{kind:'project'}}});expect(store.preview?.stage).toBe('server');
  release({stage:'grant-reconciled',receipt:{grantId:'42',command:'create',revision:1,generation:1,keyObtained:false}});await reconciling;
  expect.soft(store.grantBusy).toBe(false);expect.soft(store.result?.stage).toBe('grant-reconciled');expect.soft(store.preview?.stage).toBe('server');expect(api.calls.filter(row=>row.operation==='create-grant')).toHaveLength(1);
});
it('final I04 replacement activation clears only old renderer pending ownership before a new explicit command',async()=>{
  const api=port(),store=createCollaborationStore(api);store.context=context;await store.loadPublications();await store.loadGrants('41');
  api.override(input=>{if(input.operation==='create-grant')throw new Error('collaboration-grant-pending');});await store.createGrant('members',60000,false).catch(()=>{});
  api.override(()=>undefined);await store.activate(context);await store.loadGrants('41');await store.createGrant('members',60000,false);
  expect.soft(api.calls.filter(row=>row.operation==='create-grant')).toHaveLength(2);expect(store.result?.stage).toBe('grant');
});
it.each([['zh-CN','授权结果未决','先对账原操作'],['en','Grant result is pending','Reconcile the original operation first']] as const)('final I04 shows %s busy and pending recovery without another command',async(language,pendingText,hint)=>{
  const api=port(),store=createCollaborationStore(api),{i18n}=createI18nInstance();i18n.global.locale.value=language;store.context=context;await store.loadPublications();await store.loadGrants('41');
  let reject!:(error:Error)=>void;const gate=new Promise<any>((_,no)=>{reject=no;});api.override(input=>input.operation==='create-grant'?gate:undefined);
  const view=mount(CollaborationPanel,{props:{collaboration:store},global:{plugins:[i18n]}});expect(view.text()).toContain('42');
  const first=store.createGrant('members',60000,false).catch(()=>{});await flushPromises();
  expect.soft(view.get('[data-testid="create-grant"]').attributes('disabled')).toBeDefined();expect.soft(view.get('[data-testid="rotate-grant"]').attributes('disabled')).toBeDefined();
  const duplicate=store.createGrant('members',60000,false).catch(()=>{});reject(new Error('collaboration-grant-pending'));await Promise.all([first,duplicate]);await flushPromises();
  expect.soft(api.calls.filter(row=>row.operation==='create-grant')).toHaveLength(1);expect.soft(view.text()).toContain(pendingText);expect.soft(view.text()).toContain(hint);
  expect.soft(view.get('[data-testid="create-grant"]').attributes('disabled')).toBeDefined();await view.get('[data-testid="reconcile-grant"]').trigger('click');await flushPromises();
  expect.soft(view.text()).toContain(language==='en'?'key was not obtained':'密钥未取得');expect(api.calls.filter(row=>row.operation==='rotate-grant')).toHaveLength(0);
});
it.each([['zh-CN','接口文档'],['en','API documentation']] as const)('final M01 localizes only a newly generated %s document title',async(language,title)=>{
  const api=port(),store=createCollaborationStore(api),{i18n}=createI18nInstance();i18n.global.locale.value=language;store.context=context;const view=mount(CollaborationPanel,{props:{collaboration:store,saved:{revision:'12',manifestHash:'c'.repeat(64)}},global:{plugins:[i18n]}});
  await view.get('[data-testid="preview-document"]').trigger('click');await flushPromises();expect(api.calls.at(-1)).toMatchObject({operation:'preview-online',input:{title}});
});
// I4: a changed server default during explicit conflict refresh must not replace an edited draft.
it.each([[180000, 240000], [60000, 90000]])('round2 preserves edited duration across conflict refresh to default %s and maximum %s', async (nextDefault, nextMaximum) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; await store.loadPublications(); await store.loadGrants('41');
  const refreshed = await api.onlineCollaboration({ operation: 'grants', context, input: { publicationId: '41' } }); if (refreshed.stage !== 'grants') throw new Error('fixture');
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('42'); expect((view.get('[data-testid="grant-duration"]').element as HTMLInputElement).value).toBe('604800000');
  await view.get('[data-testid="grant-duration"]').setValue('120000'); const count = api.calls.length;
  api.override(input => { if (input.operation === 'create-grant') throw new Error('publication_revision_conflict'); });
  await view.get('[data-testid="create-grant"]').trigger('click'); await flushPromises(); expect(api.calls.slice(count).map(row => row.operation)).toEqual(['create-grant']); expect(view.text()).toContain('Publication revision changed');
  refreshed.page.constraints.defaultShareDurationMs.value = nextDefault; refreshed.page.constraints.maxShareDurationMs.value = nextMaximum;
  api.override(input => input.operation === 'grants' ? refreshed : undefined);
  await view.get('[data-testid="refresh-collaboration"]').trigger('click'); await flushPromises(); expect(store.grantConstraints!.defaultShareDurationMs.value).toBe(nextDefault); expect(store.grantConstraints!.maxShareDurationMs.value).toBe(nextMaximum);
  expect.soft((view.get('[data-testid="grant-duration"]').element as HTMLInputElement).value).toBe('120000'); expect.soft(api.calls.slice(count).map(row => row.operation)).toEqual(['create-grant', 'publications', 'grants']);
  if (nextMaximum < 120000) { await view.get('[data-testid="create-grant"]').trigger('click'); await flushPromises(); expect.soft((view.get('[data-testid="grant-duration"]').element as HTMLInputElement).value).toBe('120000'); expect.soft(view.text()).toContain('Use a whole-millisecond duration from 60,000 ms through the current maximum'); expect.soft(api.calls.slice(count).map(row => row.operation)).toEqual(['create-grant', 'publications', 'grants']); }
});
it.each([1, 59999])('round1 refuses sub-minute grant duration %s after a lawful minimum choice', async duration => {
  const api = port(), store = createCollaborationStore(api); store.context = context; await store.loadPublications(); await store.loadGrants('41'); await store.createGrant('members', 60000, false); expect(api.calls.at(-1)!.operation).toBe('create-grant'); const count = api.calls.length;
  await expect(store.createGrant('members', duration, false)).rejects.toThrow('collaboration-grant-input-invalid'); expect(api.calls).toHaveLength(count);
});
it.each([['zh-CN', '最短 60,000 ms', '期限从服务器创建时开始'], ['en', 'Minimum 60,000 ms', 'Duration starts at server creation']] as const)('round1 explains the real minimum and server-started duration in %s before creation', async (language, minimum, start) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = language; store.context = context; await store.loadPublications(); await store.loadGrants('41'); const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('42'); expect.soft(view.text()).toContain(minimum); expect.soft(view.text()).toContain(start);
});
it.each([['create', 'publication_revision_conflict', '发布副本修订已变化', 'Publication revision changed'], ['rotate', 'grant_revision_conflict', '授权修订已变化', 'Grant revision changed']] as const)('round1 preserves form input after %s CAS conflict and refreshes only on explicit action', async (command, code, zh, en) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; await store.loadPublications(); await store.loadGrants('41'); const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('42');
  await view.get('[data-testid="grant-audience"]').setValue('external'); await view.get('[data-testid="grant-duration"]').setValue('120000'); const count = api.calls.length;
  api.override(input => { if (input.operation === `${command}-grant`) throw new Error(code); }); await view.get(`[data-testid="${command}-grant"]`).trigger('click'); await flushPromises();
  i18n.global.locale.value = 'zh-CN'; await flushPromises(); expect.soft(view.text()).toContain(zh); expect.soft(view.text()).toContain('明确刷新当前修订'); i18n.global.locale.value = 'en'; await flushPromises(); expect.soft(view.text()).toContain(en); expect.soft(view.text()).toContain('explicitly refresh current revisions');
  expect((view.get('[data-testid="grant-duration"]').element as HTMLInputElement).value).toBe('120000'); expect((view.get('[data-testid="grant-audience"]').element as HTMLSelectElement).value).toBe('external'); expect(api.calls.slice(count).map(row => row.operation)).toEqual([`${command}-grant`]);
  await view.get('[data-testid="refresh-collaboration"]').trigger('click'); await flushPromises(); expect(api.calls.slice(count).map(row => row.operation)).toEqual([`${command}-grant`, 'publications', 'grants']); expect((view.get('[data-testid="grant-duration"]').element as HTMLInputElement).value).toBe('120000');
});
// I2: context alone is not a management-selection identity within one project.
it.each(['create', 'rotate', 'revoke'] as const)('round1 keeps publication B when publication A has a late %s receipt', async command => {
  const api = port(), store = createCollaborationStore(api); store.context = context; await store.loadPublications(); store.publications.push({ ...store.publications[0]!, id: '43' }); await store.loadGrants('41');
  const run = () => command === 'create' ? store.createGrant('members', 60000, false) : store.grantCommand(command, store.grants[0]!);
  await run(); expect(api.calls.at(-1)!.operation).toBe(`${command}-grant`); await store.loadGrants('41');
  const page = await api.onlineCollaboration({ operation: 'grants', context, input: { publicationId: '41' } }); if (page.stage !== 'grants') throw new Error('fixture');
  let release!: (value: any) => void; const waiting = new Promise<any>(yes => { release = yes; });
  api.override(input => input.operation === `${command}-grant` ? waiting : input.operation === 'grants' && input.input.publicationId === '43' ? { ...page, page: { ...page.page, items: [{ ...grant(), id: '99', publicationId: '43' }] } } : undefined);
  const pending = run(); await store.loadGrants('43'); expect(store.grants[0]!.id).toBe('99');
  release(command === 'revoke' ? { stage: 'revoked' } : { stage: 'grant', grant: { ...grant(), id: '98', publicationId: '41', revision: 2 }, keyAvailable: true }); await pending;
  expect.soft(store.selectedPublicationId).toBe('43'); expect.soft(store.grants.map(row => row.id)).toEqual(['99']); expect.soft(store.result).toBeNull();
  expect(api.calls.filter(row => row.operation === `${command}-grant`)).toHaveLength(2);
});
it('round1 clears old management facts immediately while a new publication directory is pending', async () => {
  const api = port(), store = createCollaborationStore(api); store.context = context; await store.loadGrants('41'); store.result = { stage: 'grant', grant: grant(), keyAvailable: false }; expect(store.grants).toHaveLength(1); expect(store.grantConstraints).not.toBeNull();
  const response = await api.onlineCollaboration({ operation: 'grants', context, input: { publicationId: '41' } }); let release!: (value: any) => void; const waiting = new Promise<any>(yes => { release = yes; }); api.override(input => input.operation === 'grants' ? waiting : undefined);
  const pending = store.loadGrants('43'); expect.soft(store.grants).toEqual([]); expect.soft(store.grantConstraints).toBeNull(); expect.soft(store.result).toBeNull(); release(response); await pending;
});
it.each(['return-to-A', 'late-error'] as const)('round1 binds pending grant feedback to its management selection generation: %s', async outcome => {
  const api = port(), store = createCollaborationStore(api); store.context = context; await store.loadPublications(); store.publications.push({ ...store.publications[0]!, id: '43' }); await store.loadGrants('41'); await store.createGrant('members', 60000, false); expect(store.result?.stage).toBe('grant');
  let release!: (value: any) => void, fail!: (error: Error) => void; const waiting = new Promise<any>((yes, no) => { release = yes; fail = no; }); api.override(input => input.operation === 'create-grant' ? waiting : undefined);
  const pending = store.createGrant('members', 60000, false).catch(() => {}); await store.loadGrants('43'); if (outcome === 'return-to-A') await store.loadGrants('41'); store.error = '';
  if (outcome === 'late-error') fail(new Error('grant_revision_conflict')); else release({ stage: 'grant', grant: { ...grant(), id: '98' }, keyAvailable: true }); await pending;
  expect.soft(store.grants.map(row => row.id)).toEqual(['42']); expect.soft(store.result).toBeNull(); expect.soft(store.error).toBe('');
});
it.each([['zh-CN', '已失活', '责任资格已变化', '策略已变化', '未知'], ['en', 'Inactive', 'Responsibility changed', 'Policy changed', 'Unknown']] as const)('round1 renders real inactive grant states and reasons in %s without translation keys', async (language, inactive, responsibility, policy, unknown) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = language; store.context = context;
  const page = await api.onlineCollaboration({ operation: 'grants', context, input: { publicationId: '41' } }); if (page.stage !== 'grants') throw new Error('fixture');
  api.override(input => input.operation === 'grants' ? { ...page, page: { ...page.page, items: ['revoked','expired','responsibility_changed','policy_changed','future-reason'].map((reason, index) => ({ ...grant(), id: String(42 + index), state: 'inactive', reason, revision: 2 })) } } : undefined);
  await store.loadGrants('41'); const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('42');
  for (const label of [inactive, language === 'zh-CN' ? '已撤销' : 'Revoked', language === 'zh-CN' ? '已到期' : 'Expired', responsibility, policy, unknown, 'future-reason']) expect.soft(view.text()).toContain(label);
  expect.soft(view.text()).not.toContain('collaboration.codes.inactive'); expect(store.grants[0]!.revision).toBe(2);
});
it('round1 requires an explicit authoritative refresh after revoke rather than inventing state or revision', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; await store.loadGrants('41'); const row = store.grants[0]!; expect(row.revision).toBe(1); const count = api.calls.length;
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); await store.grantCommand('revoke', row); await flushPromises();
  expect.soft(store.grants).toEqual([]); expect.soft(view.text()).toContain('Grant revoked; refresh the directory for current revisions'); expect(api.calls.slice(count).map(row => row.operation)).toEqual(['revoke-grant']);
  const page = await api.onlineCollaboration({ operation: 'grants', context, input: { publicationId: '41' } }); if (page.stage !== 'grants') throw new Error('fixture'); api.override(input => input.operation === 'grants' ? { ...page, page: { ...page.page, items: [{ ...grant(), state: 'inactive', reason: 'revoked', revision: 2 }] } } : undefined);
  await view.get('[data-testid="refresh-grants"]').trigger('click'); await flushPromises(); expect(store.grants[0]).toMatchObject({ state: 'inactive', reason: 'revoked', revision: 2 });
});
it.each(['publication', 'grant'] as const)('offers an explicit last-%s operation query without creating another write', async kind => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context;
  if (kind === 'publication') { store.preview = server() as any; await store.confirmPublication(); } else { await store.loadPublications(); await store.loadGrants('41'); await store.createGrant('members', 60000, false); }
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain(kind === 'grant' ? '42' : '41'); const count = api.calls.length;
  await view.get(`[data-testid="reconcile-${kind}"]`).trigger('click'); await flushPromises(); expect(api.calls.slice(count)).toEqual([{ operation: `reconcile-${kind}`, context }]); expect(store.result?.stage).toBe(kind === 'grant' ? 'grant-reconciled' : 'publication-reconciled');
});
it('shows the publication operation receipt after a lost return without replaying publication', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; store.preview = server() as any; const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Selected safe report');
  api.override(input => input.operation === 'confirm-publication' ? { stage: 'publication-reconciled', receipt: { publicationIntentId: 'saved-intent', publicationId: '41', state: 'committed', candidateDigest: 'b'.repeat(64) } } : undefined); await store.confirmPublication(); await flushPromises(); expect(view.text()).toContain('Fixed copy committed'); expect(view.text()).toContain('41'); expect(api.calls.map(call => call.operation)).toEqual(['confirm-publication']);
});
it.each([['zh-CN', '版本', '报告副本', '外部可用开关'], ['en', 'Version', 'Report copy', 'External availability']] as const)('keeps %s saved publication metadata readable rather than raw enum rows', async (locale, version, kind, state) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = locale; store.context = context; await store.loadPublications(); const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('41'); for (const label of [version, kind, state]) expect.soft(view.text()).toContain(label);
});
it('keeps the newly selected fixed publication when an older grant directory response arrives last', async () => {
  const api = port(), store = createCollaborationStore(api); store.context = context; await store.loadPublications(); store.publications.push({ ...store.publications[0]!, id: '43' }); await store.loadGrants('41'); expect(store.grants[0]!.publicationId).toBe('41'); const old = await api.onlineCollaboration({ operation: 'grants', context, input: { publicationId: '41' } }); if (old.stage !== 'grants') throw new Error('fixture');
  let release!: (result: any) => void; const wait = new Promise<any>(yes => { release = yes; }); api.override(input => input.operation === 'grants' ? input.input.publicationId === '41' ? wait : { ...old, page: { ...old.page, items: [{ ...grant(), id: '99', publicationId: '43' }] } } : undefined);
  const pending = store.loadGrants('41'); await store.loadGrants('43'); expect(store.grants[0]!.id).toBe('99'); release(old); await pending; expect.soft(store.selectedPublicationId).toBe('43'); expect.soft(store.grants[0]!.id).toBe('99');
});
it('enables only an explicitly selected saved Mock using its current revision and displays independent activity', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; const { artifact: _, ...metadata } = publication(), mock = { ...metadata, kind: 'mock' as const, trust: 'saved-contract' as const, enabled: false, source: { kind: 'mock' as const, revision: '12', digest: 'c'.repeat(64), uploadId: null, uploadedBy: null, jobId: null } };
  api.override(input => input.operation === 'publications' ? { stage: 'publications', page: { items: [{ ...mock, policyRevision: 2 }], nextCursor: null } } : input.operation === 'set-mock' ? { stage: 'published', publication: { ...mock, enabled: true, revision: 4, plan: { sourceProjectRevision: 'c'.repeat(64), routes: [] }, planFingerprint: 'd'.repeat(64), activity: { state: 'active', activeRequests: 1, stateLabel: '正在处理请求' } } } : undefined);
  await store.loadPublications(); const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('41'); expect(api.calls.some(call => call.operation === 'set-mock')).toBe(false);
  await view.get('[data-testid="mock-enable"]').trigger('click'); await flushPromises(); expect(api.calls.at(-1)).toEqual({ operation: 'set-mock', context, input: { publicationId: '41', enabled: true, expectedRevision: 3 } }); expect(view.text()).toContain('Already admitted requests'); expect(store.publications[0]).toMatchObject({ revision: 4, enabled: true });
  const count = api.calls.length; await store.close(); expect(api.calls.slice(count).map(call => call.operation)).toEqual(['cancel-preview']);
});

it.each(['publications', 'grants'] as const)('offers bounded next-page management for %s and keeps the selected publication', async kind => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; const first = await api.onlineCollaboration({ operation: kind, context, input: kind === 'grants' ? { publicationId: '41' } : {} } as any); if (first.stage !== kind) throw new Error('fixture'); first.page.nextCursor = 'next-management';
  api.override(input => input.operation === kind ? first : undefined); await store.loadPublications(); if (kind === 'grants') await store.loadGrants('41'); const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain(kind === 'grants' ? '42' : '41');
  await view.get(`[data-testid="${kind}-next"]`).trigger('click'); await flushPromises(); expect(api.calls.at(-1)).toEqual({ operation: kind, context, input: { ...(kind === 'grants' ? { publicationId: '41' } : {}), cursor: 'next-management' } });
});
it('shows an explicit key-unavailable remedy after a real successful copy without exposing or retrying a secret', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; await store.loadGrants('41'); const row = store.grants[0]!; await store.grantCommand('copy', row); expect(store.result?.stage).toBe('copied');
  api.override(input => { if (input.operation === 'copy-grant') throw new Error('collaboration-key-unavailable'); }); await expect(store.grantCommand('copy', row)).rejects.toThrow('collaboration-key-unavailable');
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('42'); expect(view.text()).toContain('The key is not available; explicitly rotate to obtain a new key'); expect(api.calls.filter(call => call.operation === 'rotate-grant')).toEqual([]);
});
it('keeps revoked grant metadata readable but explains that rotation cannot revive it', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; await store.loadGrants('41'); const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.get('[data-testid="rotate-grant"]').attributes('disabled')).toBeUndefined(); store.grants[0]!.state = 'inactive'; store.grants[0]!.reason = 'revoked'; await flushPromises();
  expect.soft(view.get('[data-testid="rotate-grant"]').attributes('disabled')).toBeDefined(); expect.soft(view.text()).toContain('Inactive grants cannot be revived; create a new grant explicitly');
});
it.each(['create', 'rotate'] as const)('does not restore a late grant %s result into another selected project', async command => {
  const api = port(), store = createCollaborationStore(api); store.context = context; await store.loadPublications(); await store.loadGrants('41'); const run = () => command === 'create' ? store.createGrant('members', 60000, false) : store.grantCommand('rotate', store.grants[0]!); await run(); expect(store.result?.stage).toBe('grant');
  let release!: (value: any) => void; const wait = new Promise<any>(yes => { release = yes; }); api.override(input => input.operation === command + '-grant' ? wait : undefined); const pending = run();
  await store.selectLocal({ ...context, scope: { ...context.scope, projectId: '44' } }, { kind: 'online-local', runId: '40000000-0000-4000-8000-000000000019' }, 'Another project'); expect(store.result).toBeNull(); release({ stage: 'grant', grant: { ...grant(), id: '99' }, keyAvailable: true }); await pending; expect.soft(store.result).toBeNull(); expect.soft(store.grants).toEqual([]);
});

it('keeps a newer initialization capability result when an older same-project read arrives last', async () => {
  const api = port(), store = createCollaborationStore(api); await store.activate(context); expect(store.access!.effectiveRole).toBe('EDITOR'); const previous = await api.onlineCollaboration({ operation: 'access', context, input: {} }); if (previous.stage !== 'access') throw new Error('fixture');
  const newer = { stage: 'access' as const, access: { ...previous.access, workspaceRole: 'VIEWER' as const, effectiveRole: 'VIEWER' as const, capabilities: ['history.read' as const], accessRevision: 3 } };
  let release!: (value: any) => void, reads = 0; const wait = new Promise<any>(yes => { release = yes; }); api.override(input => input.operation === 'access' ? ++reads === 1 ? wait : newer : undefined);
  const old = store.activate(context); await flushPromises(); await store.activate(context); expect(store.access!.effectiveRole).toBe('VIEWER'); release(previous); await old; expect(store.access!.effectiveRole).toBe('VIEWER');
});

it('clears old target facts and candidate before a changed-project initialization returns', async () => {
  const api = port(), store = createCollaborationStore(api); await store.activate(context); await store.selectOnline({ title: 'Saved', includeEvidence: false, source: { kind: 'document', revision: '12', manifestHash: 'c'.repeat(64), scope: { kind: 'project' } } }); const oldId = store.preview!.candidateId;
  const response = await api.onlineCollaboration({ operation: 'access', context, input: {} }); let release!: (value: any) => void; const wait = new Promise<any>(yes => { release = yes; }); api.override(input => input.operation === 'access' ? wait : undefined);
  const pending = store.activate({ ...context, scope: { ...context.scope, projectId: '44' } });
  expect.soft(store.history).toEqual([]); expect.soft(store.publications).toEqual([]); expect.soft(store.access).toBeNull(); expect.soft(store.preview).toBeNull();
  await expect(store.confirmPublication(oldId)).rejects.toThrow('collaboration-source-changed'); release(response); await pending;
});

it.each(['activate', 'access', 'history'] as const)('stops late %s initialization after the panel closes without another member read', async stage => {
  const api = port(), store = createCollaborationStore(api); await store.activate(context); expect(store.history).toHaveLength(2); const response = await api.onlineCollaboration(stage === 'activate' ? { operation: stage, context } : { operation: stage, context, input: {} } as any);
  let release!: (result: any) => void; const wait = new Promise<any>(yes => { release = yes; }); api.override(input => input.operation === stage ? wait : undefined);
  const pending = store.activate(context); await flushPromises(); await store.close(); const count = api.calls.length; release(response); await pending;
  expect.soft(store.visible).toBe(false); expect.soft(api.calls).toHaveLength(count);
});
it('initializes readable publication metadata without history capability rather than making a denied history request', async () => {
  const api = port(), store = createCollaborationStore(api), access = await api.onlineCollaboration({ operation: 'access', context, input: {} }); if (access.stage !== 'access') throw new Error('fixture'); access.access.capabilities = [];
  api.override(input => input.operation === 'access' ? access : input.operation === 'publications' ? { stage: 'publications', page: { items: [], nextCursor: null } } : undefined); api.calls.length = 0; await store.activate(context);
  expect(api.calls.map(call => call.operation)).toEqual(['activate', 'access', 'publications']);
});
it('uses the actual current default grant duration and disables policy-forbidden download input', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; const result = await api.onlineCollaboration({ operation: 'grants', context, input: { publicationId: '41' } }); if (result.stage !== 'grants') throw new Error('fixture'); result.page.constraints.defaultShareDurationMs.value = 120000; api.override(input => input.operation === 'grants' ? result : undefined); await store.loadPublications(); await store.loadGrants('41');
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('120000 ms');
  expect.soft((view.get('[data-testid="grant-duration"]').element as HTMLInputElement).value).toBe('120000'); expect.soft(view.get('input[type="checkbox"]').attributes('disabled')).toBeDefined();
});

it.each(['document', 'mock'] as const)('requires saving dirty %s edits before another preview can be sent', async kind => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; store.result = { stage: 'published', publication: publication() };
  const view = mount(CollaborationPanel, { props: { collaboration: store, saved: { revision: '12', manifestHash: 'c'.repeat(64) }, dirty: false }, global: { plugins: [i18n] } });
  await view.get(`[data-testid="preview-${kind}"]`).trigger('click'); await flushPromises(); expect(store.preview?.stage).toBe('server'); const count = api.calls.length;
  await view.setProps({ dirty: true }); await view.get(`[data-testid="preview-${kind}"]`).trigger('click'); await flushPromises();
  expect.soft(api.calls.map(call => call.operation)).toEqual(['preview-online', 'cancel-preview']); expect.soft(store.preview).toBeNull(); expect.soft(view.text()).toContain('Save the contract and Mock rules before previewing');
});
it('does not restore a late saved-source preview after the user cancels it', async () => {
  const api = port(), store = createCollaborationStore(api); store.context = context;
  const input = { title: 'Saved', includeEvidence: false, source: { kind: 'document' as const, revision: '12', manifestHash: 'c'.repeat(64), scope: { kind: 'project' as const } } }; await store.selectOnline(input); expect(store.preview?.stage).toBe('server');
  let release!: (result: any) => void; const wait = new Promise<any>(yes => { release = yes; }); const first = store.preview!;
  api.override(input => input.operation === 'preview-online' ? wait : undefined); const pending = store.selectOnline(input); await store.cancelPreview(); expect(store.preview).toBeNull(); release(first); await pending; expect(store.preview).toBeNull();
});
it.each(['history', 'publications', 'grants', 'read-history'] as const)('does not put a late %s response into a different selected target project', async operation => {
  const api = port(), store = createCollaborationStore(api); store.context = context;
  const run = () => operation === 'history' ? store.loadHistory() : operation === 'publications' ? store.loadPublications() : operation === 'grants' ? store.loadGrants('41') : store.readHistory({ id: '40', source: 'member-history' });
  await run(); const key = operation === 'read-history' ? 'historyBody' : operation;
  expect((store as any)[key]).toBeTruthy();
  let release!: (result: any) => void; const wait = new Promise<any>(yes => { release = yes; }); const response = await api.onlineCollaboration({ operation, context, input: operation === 'grants' ? { publicationId: '41' } : operation === 'read-history' ? { id: '40', source: 'member-history' } : {} } as any);
  const fresh: any = JSON.parse(JSON.stringify(response)); if (operation === 'read-history') fresh.history.id = '99'; else fresh.page.items[0].id = '99';
  api.override(input => input.operation === operation ? input.context.scope.projectId === '44' ? fresh : wait : undefined); const pending = run();
  await store.selectLocal({ ...context, scope: { ...context.scope, projectId: '44' } }, { kind: 'online-local', runId: '40000000-0000-4000-8000-000000000019' }, 'Another target');
  expect.soft((store as any)[key]).toEqual(operation === 'read-history' ? null : []);
  await run(); expect(operation === 'read-history' ? store.historyBody!.id : (store as any)[key][0].id).toBe('99');
  release(response); await pending; expect(operation === 'read-history' ? store.historyBody!.id : (store as any)[key][0].id).toBe('99');
});

it('disables grant writes without the corresponding current purpose capability while keeping metadata visible', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; await store.loadPublications(); await store.loadGrants('41');
  const access = await api.onlineCollaboration({ operation: 'access', context, input: {} }); Object.assign(store, { access: access.stage === 'access' ? access.access : null });
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('42'); expect(view.get('[data-testid="create-grant"]').attributes('disabled')).toBeUndefined();
  Object.assign(store, { access: { ...(store as any).access, capabilities: ['history.read'] } }); await flushPromises();
  for (const command of ['create', 'rotate', 'revoke']) expect.soft(view.get(`[data-testid="${command}-grant"]`).attributes('disabled')).toBeDefined();
});
it.each([0, 7776000001, 1.5])('refuses invalid grant duration %s after a legal explicit creation without another write', async duration => {
  const api = port(), store = createCollaborationStore(api); store.context = context; await store.loadPublications(); await store.loadGrants('41');
  await store.createGrant('members', 60000, false); expect(api.calls.at(-1)!.operation).toBe('create-grant'); const count = api.calls.length;
  await expect(store.createGrant('members', duration, false)).rejects.toThrow('collaboration-grant-input-invalid'); expect(api.calls).toHaveLength(count); expect(store.error).toBe('collaboration-grant-input-invalid');
});
it.each(['document', 'mock'] as const)('previews only the selected saved %s descriptor instead of uploading a renderer artifact', async kind => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; store.result = { stage: 'published', publication: publication() };
  const saved = { revision: '12', manifestHash: 'c'.repeat(64) }, view = mount(CollaborationPanel, { props: { collaboration: store, saved, dirty: false }, global: { plugins: [i18n] } }); expect(view.text()).toContain('41');
  await view.get(`[data-testid="preview-${kind}"]`).trigger('click'); await flushPromises();
  expect(api.calls.at(-1)).toEqual({ operation: 'preview-online', context, input: { title: kind === 'document' ? 'API documentation' : 'Mock', includeEvidence: false, source: { kind, ...saved, scope: { kind: 'project' } } } }); expect(store.preview?.stage).toBe('server');
});

it('creates only after explicit audience, duration and download review, using the fixed publication revision', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; store.result = { stage: 'published', publication: publication() }; await store.loadPublications(); await store.loadGrants('41');
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('42');
  expect(api.calls.filter(call => call.operation === 'create-grant')).toHaveLength(0);
  await view.get('[data-testid="grant-audience"]').setValue('members'); await view.get('[data-testid="grant-duration"]').setValue('60000');
  await view.get('[data-testid="create-grant"]').trigger('click'); await flushPromises();
  const call = api.calls.find(call => call.operation === 'create-grant')!; expect(call).toMatchObject({ context, input: { publicationId: '41', purpose: 'view', audience: 'members', downloadAllowed: false, expectedRevision: 3 } });
  expect(call.input).toMatchObject({ durationMs: 60000 }); expect(call.input).not.toHaveProperty('expiresAt');
});
it.each([['zh-CN', '授权已创建，但密钥未取得', '仅明确轮换才生成新密钥'], ['en', 'The grant was created, but its key was not obtained', 'Only an explicit rotation creates a new key']] as const)('explains %s lost-create reconciliation without a hidden write retry', async (locale, reason, next) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = locale; store.context = context; await store.loadGrants('41'); store.result = { stage: 'grant-reconciled', receipt: { grantId: '42', command: 'create', revision: 1, generation: 1, keyObtained: false } };
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('42'); expect.soft(view.text()).toContain(reason); expect.soft(view.text()).toContain(next); expect(api.calls.map(call => call.operation)).toEqual(['grants']);
});
it.each([['zh-CN', '外部受众', '授权到期时间', '下载权限', '修订', '查看用途'], ['en', 'External audience', 'Grant expiry', 'Download permission', 'Revision', 'View purpose']] as const)('keeps %s grant audience, millisecond expiry and revision readable without a secret URL', async (locale, audience, expiry, download, revision, purpose) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = locale; store.context = context; await store.loadGrants('41');
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('42');
  for (const value of [audience, expiry, download, revision, purpose, '.123', 'GMT']) expect.soft(view.text()).toContain(value);
  expect(view.text()).not.toContain('https://public.test');
});

it('reopens a fixed publication and recovers nonsecret grant management after the create response is gone', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; store.result = { stage: 'published', publication: publication() };
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } });
  expect(view.text()).toContain('41');
  await view.get('[data-testid="load-publications"]').trigger('click'); await flushPromises();
  await view.get('[data-testid="manage-grants"]').trigger('click'); await flushPromises();
  expect(api.calls.map(call => call.operation)).toEqual(['publications', 'grants']); expect(view.text()).toContain('42');
  expect.soft(view.text()).toContain('604800000 ms'); expect.soft(view.text()).toContain('7776000000 ms'); expect.soft(view.text()).not.toContain('https://public.test');
  expect.soft(view.text()).not.toContain('intent'); expect(view.find('pre').exists()).toBe(false);
});

it.each(['copy', 'rotate', 'revoke'] as const)('performs only the explicit %s action using the displayed grant revision', async command => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; store.result = { stage: 'published', publication: publication() };
  const view = mount(CollaborationPanel, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('41');
  await view.get('[data-testid="load-publications"]').trigger('click'); await flushPromises(); await view.get('[data-testid="manage-grants"]').trigger('click'); await flushPromises();
  expect(view.text()).toContain('42'); const count = api.calls.length;
  await view.get(`[data-testid="${command}-grant"]`).trigger('click'); await flushPromises();
  expect(api.calls[count]).toEqual({ operation: `${command}-grant`, context, input: command === 'copy' ? { grantId: '42' } : { grantId: '42', expectedRevision: 1 } });
});

it.each([['zh-CN', '协作与分享'], ['en', 'Collaboration and sharing']] as const)('offers a visible %s collaboration entry on an actual readable online project', async (locale, label) => {
  const api = { onlineExecution: async () => [], onlineCollaboration: async () => ({ stage: 'idle' }) } as unknown as ApiccApi;
  const online = createOnlineStore({ api }), context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
  online.execution.activate(context); online.execution.project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  online.execution.saved = JSON.stringify(online.execution.project);
  online.execution.view = { project: online.execution.project, problems: [], assets: { ...context.scope, format: 'contract-files-v1', contractProjectId: online.execution.project.id, version: '1', manifestHash: 'a'.repeat(64), files: [] } };
  const adapter = createOnlineProjectAdapter(online.execution, api, () => false, () => true), { i18n } = createI18nInstance(); i18n.global.locale.value = locale;
  try {
    const view = shallowMount(OnlineProjectAssets, { props: { online, adapter, localProjects: [] }, global: { plugins: [i18n] } });
    expect(view.find('[data-testid="online-debug-run"]').exists()).toBe(true);
    const entry = view.findAll('button').find(button => button.text() === label); expect(entry, 'business entry, not an empty new component').toBeDefined();
    await entry!.trigger('click'); expect(view.emitted('collaboration')).toEqual([[context]]);
  } finally { adapter.stop(); online.execution.setVisible(false); }
});
