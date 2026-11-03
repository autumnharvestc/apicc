// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import PublicationPreview from '../../../src/renderer/src/components/online/PublicationPreview.vue';
import { createCollaborationStore } from '../../../src/renderer/src/stores/collaboration.js';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import { context, source, port, local, server } from './collaboration-fixtures.js';
import { safeDocument } from '../../../../../packages/core/tests/collaboration/fixtures.js';
import { CollaborationResultSchema } from '../../../src/shared/online/collaboration.js';
enableAutoUnmount(afterEach);
it.each([['zh-CN','失败诊断'],['en','Failure diagnostic']] as const)('final I02 shows %s top-level debug diagnostic without a fabricated node',async(language,label)=>{
  const api=port(),store=createCollaborationStore(api),{i18n}=createI18nInstance();i18n.global.locale.value=language;store.context=context;const preview=local() as any;
  preview.artifact.summary.push({labelCode:'report.failure',value:'Selected post-script failed'});preview.artifact.report.nodes=[];store.preview=preview;
  const view=mount(PublicationPreview,{props:{collaboration:store},global:{plugins:[i18n]}});expect(view.text()).toContain('Selected safe report');expect.soft(view.text()).toContain(label);expect(view.text()).toContain('Selected post-script failed');
});
it.each(['activate','preview'] as const)('final I05 %s normalizes IPC HTTPS refusal and presents zh/en connection recovery',async operation=>{
  const api=port(),store=createCollaborationStore(api),{i18n}=createI18nInstance();store.context=context;
  if(operation==='activate')await store.activate(context);else await store.selectOnline({title:'Saved',includeEvidence:false,source:{kind:'document',revision:'12',manifestHash:'c'.repeat(64),scope:{kind:'project'}}});
  expect(store.context).toEqual(context);api.override(input=>{if(input.operation===(operation==='activate'?'access':'preview-online'))throw new Error("Error invoking remote method 'online:collaboration': Error: execution-requires-https");});
  await (operation==='activate'?store.activate(context):store.selectOnline({title:'Saved',includeEvidence:false,source:{kind:'document',revision:'12',manifestHash:'c'.repeat(64),scope:{kind:'project'}}})).catch(()=>{});
  expect.soft(store.error).toBe('execution-requires-https');const view=mount(PublicationPreview,{props:{collaboration:store},global:{plugins:[i18n]}});
  i18n.global.locale.value='zh-CN';await flushPromises();expect.soft(view.text()).toContain('HTTPS');expect.soft(view.text()).toContain('有效证书');expect.soft(view.text()).toContain('重新配置连接');expect.soft(view.text()).not.toContain('重新选择');
  i18n.global.locale.value='en';await flushPromises();expect.soft(view.text()).toContain('valid certificate');expect.soft(view.text()).toContain('Reconfigure the connection');expect.soft(view.text()).not.toContain('reselect');expect(view.text()).not.toContain('remote method');
});
it.each([['zh-CN','7 天','90 天'],['en','7 days','90 days']] as const)('final M01 %s server durations retain exact ms alongside readable days',async(language,seven,ninety)=>{
  const api=port(),store=createCollaborationStore(api),{i18n}=createI18nInstance();i18n.global.locale.value=language;store.context=context;store.preview=server() as any;
  const view=mount(PublicationPreview,{props:{collaboration:store},global:{plugins:[i18n]}});expect(view.text()).toContain('Selected safe report');
  expect.soft(view.text()).toContain(seven);expect.soft(view.text()).toContain(ninety);expect.soft(view.text()).toContain('604800000 ms');expect(view.text()).toContain('7776000000 ms');
});
it.each([
  ['collaboration_storage_limit', 'confirm-upload', '协作存储额度已满', 'Collaboration storage quota is full', '释放存储额度', 'free storage capacity'],
  ['collaboration_preview_limit', 'confirm-upload', '待处理候选额度已满', 'Pending candidate quota is full', '等待候选到期', 'Wait for candidates to expire'],
  ['collaboration_version_limit', 'confirm-publication', '固定副本版本额度已满', 'Fixed-copy version quota is full', '清理旧版本', 'remove old versions'],
  ['collaboration_upload_limit', 'confirm-publication', '成员上传历史额度已满', 'Member upload history quota is full', '清理上传历史', 'remove upload history'],
  ['publication_deadline_exceeded', 'confirm-publication', '发布操作时间预算已耗尽', 'Publication time budget was exhausted', '查询原操作', 'query the original operation'],
] as const)('round1 explains finite producer %s quota or deadline with its own safe next step', async (code, operation, zh, en, zhHint, enHint) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; store.preview = (operation === 'confirm-upload' ? local() : server()) as typeof store.preview;
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Selected safe report'); api.override(input => { if (input.operation === operation) throw new Error(code); });
  await (operation === 'confirm-upload' ? store.confirmUpload() : store.confirmPublication()).catch(() => {}); i18n.global.locale.value = 'zh-CN'; await flushPromises(); expect.soft(view.text()).toContain(zh); expect.soft(view.text()).toContain(zhHint);
  i18n.global.locale.value = 'en'; await flushPromises(); expect.soft(view.text()).toContain(en); expect.soft(view.text()).toContain(enHint); expect(store.preview).toBeNull(); expect(api.calls.map(row => row.operation)).toEqual([operation]);
});
it('shows the actual plan-only Mock candidate bytes before publication, without substituting the artifact maximum', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(), normal = server() as any; const { artifact: _, ...metadata } = normal.preview;
  const plan = { sourceProjectRevision: 'c'.repeat(64), routes: [{ contractId: 'api-1', method: 'GET', pathTemplate: '/items', segments: [{ kind: 'literal', value: 'items' }], rules: [] }] };
  api.override(input => input.operation === 'preview-online' ? CollaborationResultSchema.parse({ ...normal, preview: { ...metadata, source: { kind: 'mock', revision: '12', digest: 'c'.repeat(64), uploadId: null, uploadedBy: null, jobId: null }, planFingerprint: 'd'.repeat(64), plan } }) : undefined); store.context = context; await store.selectOnline({ title: 'Saved Mock', includeEvidence: false, source: { kind: 'mock', revision: '12', manifestHash: 'c'.repeat(64), scope: { kind: 'project' } } });
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('/items'); expect(view.text()).toContain(`${Buffer.byteLength(JSON.stringify(plan))} B`);
});
it.each([['zh-CN', '固定候选内容大小', '仅下列服务器安全投影内容'], ['en', 'Fixed candidate content size', 'Only the server-projected safe content below']] as const)('shows %s actual server candidate size and fixed scope before publication', async (language, sizeLabel, scopeLabel) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = language; store.context = context; await store.selectOnline({ title: 'Saved', includeEvidence: false, source: { kind: 'document', revision: '12', manifestHash: 'c'.repeat(64), scope: { kind: 'project' } } });
  if (store.preview?.stage !== 'server' || !('artifact' in store.preview.preview)) throw new Error('fixture'); const expectedBytes = Buffer.byteLength(JSON.stringify(store.preview.preview.artifact));
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Selected safe report'); expect.soft(view.text()).toContain(sizeLabel); expect.soft(view.text()).toContain(`${expectedBytes} B`); expect.soft(view.text()).toContain(scopeLabel); expect(api.calls.map(row => row.operation)).toEqual(['preview-online']);
});
it('records a finite online-preview refusal after a real saved-source preview so the safe next step can be shown', async () => {
  const api = port(), store = createCollaborationStore(api); store.context = context; const input = { title: 'Saved', includeEvidence: false, source: { kind: 'document' as const, revision: '12', manifestHash: 'c'.repeat(64), scope: { kind: 'project' as const } } }; await store.selectOnline(input); expect(store.preview?.stage).toBe('server'); api.override(input => { if (input.operation === 'preview-online') throw new Error('collaboration_projection_unavailable'); });
  await expect(store.selectOnline(input)).rejects.toThrow('collaboration_projection_unavailable'); expect(store.error).toBe('collaboration_projection_unavailable');
});

it.each(['zh-CN', 'en'] as const)('shows the actual saved document request/response scope in %s before confirmation', async language => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = language; const candidate = server() as any, document = safeDocument(); document.title = 'Saved contract'; document.source.trust = 'saved-contract'; candidate.preview.artifact = document; store.context = context; store.preview = CollaborationResultSchema.parse(candidate) as any;
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Saved contract');
  for (const fact of ['GET', '/items', '安全接口', 'q', '200', '模型']) expect.soft(view.text()).toContain(fact);
  expect.soft(view.findAll('details summary').some(row => row.text().includes('bbbbbbbbbbbb'))).toBe(true);
});
it('keeps a valid plan-only Mock preview visible instead of treating its strict union as an artifact report', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(), normal = server() as any;
  const { artifact: _, ...metadata } = normal.preview;
  store.context = context; store.preview = CollaborationResultSchema.parse({ ...normal, preview: { ...metadata, source: { kind: 'mock', revision: '12', digest: 'c'.repeat(64), uploadId: null, uploadedBy: null, jobId: null }, planFingerprint: 'd'.repeat(64), plan: { sourceProjectRevision: 'c'.repeat(64), routes: [{ contractId: 'api-1', method: 'GET', pathTemplate: '/items', segments: [{ kind: 'literal', value: 'items' }], rules: [] }] } } }) as any;
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(store.preview?.stage).toBe('server');
  expect(view.find('[data-testid="publication-preview"]').exists()).toBe(true);
  expect(view.text()).toContain('/items'); expect(view.text()).toContain('GET'); expect(view.find('[data-testid="confirm-publication"]').exists()).toBe(true);
});
it.each([['zh-CN', '运行轨迹', '裁剪', '证据状态'], ['en', 'Execution trace', 'Truncated', 'Evidence status']] as const)('shows %s original trace, evidence status and completeness limitations alongside the verdict', async (language, trace, clipped, evidence) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = language; const candidate = local() as any; candidate.artifact.limitations = [{ code: 'truncated', path: 'report.trace' }]; store.context = context; store.preview = candidate;
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Selected safe report');
  for (const fact of [trace, clipped, evidence, 'report.trace']) expect.soft(view.text()).toContain(fact);
});
// POSTERIOR only: controller/user accepted the immediate reset sequence gap at4b1a7.
it.each(['pending', 'old-error'])('posterior validates immediate saved-source %s reset without claiming a historical RED', async state => {
  const api = port(), store = createCollaborationStore(api); store.context = context; const input = { title: 'Saved', includeEvidence: false, source: { kind: 'document' as const, revision: '12', manifestHash: 'c'.repeat(64), scope: { kind: 'project' as const } } }; await store.selectOnline(input); const oldId = store.preview!.candidateId; if (state === 'old-error') store.error = 'preview_expired';
  let release!: (result: any) => void; const wait = new Promise<any>(yes => { release = yes; }); api.override(input => input.operation === 'preview-online' ? wait : undefined);
  const pending = store.selectOnline({ ...input, title: 'New selection' }); expect.soft(store.preview).toBeNull(); expect.soft(store.error).toBe('');
  await expect(store.confirmPublication(oldId)).rejects.toThrow('collaboration-source-changed'); release(server()); await pending; expect(store.preview?.stage).toBe('server'); expect(api.calls.some(call => call.operation === 'confirm-publication')).toBe(false);
});
it.each([['zh-CN', '本机产品安全上限，非服务器当前有效值', '成员上传／本机执行声明', '确认上传安全单项'], ['en', 'Local product safety ceilings, not current server limits', 'Member upload / local execution claim', 'Confirm upload of this safe item']] as const)('shows actual %s local candidate facts before any explicit upload', async (locale, ceiling, trust, upload) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = locale;
  await store.selectLocal(context, source, 'Selected report');
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } });
  expect(view.text()).toContain('Selected safe report');
  expect.soft(view.text()).toContain(ceiling); expect.soft(view.text()).toContain(trust); expect.soft(view.text()).toContain('4200 B'); expect.soft(view.text()).toContain('64 MiB');
  expect(api.calls.map(call => call.operation)).toEqual(['preview-local']);
  expect(view.findAll('button').some(button => button.text() === upload)).toBe(true); expect(view.find('pre').exists()).toBe(false);
});
it.each([['zh-CN', '本机执行', '独立保留', '不包含证据正文', '逻辑单元', '原始用例行', '原始失败'], ['en', 'Local execution', 'Independent retention', 'Evidence bodies excluded', 'Logical units', 'Raw case rows', 'Original failures']] as const)('keeps %s scope, omission and differing report populations readable', async (locale, location, retention, evidence, logical, rows, failures) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = locale; await store.selectLocal(context, source, 'Selected');
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Selected safe report');
  for (const text of [location, retention, evidence, logical, rows, failures, context.scope.projectId]) expect.soft(view.text()).toContain(text);
  expect.soft(view.text()).toContain('transport'); expect.soft(view.text()).toContain('1'); expect.soft(view.text()).toContain('2');
});
it.each([['zh-CN', '本次服务器限制', '成员上传历史保留', '停用副本保留', '确认发布固定副本'], ['en', 'Server limits for this candidate', 'Member upload history retention', 'Inactive copy retention', 'Confirm fixed-copy publication']] as const)('shows %s captured server facts and a separate publication action', async (locale, limits, uploadRetention, copyRetention, publish) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); i18n.global.locale.value = locale; store.context = context; store.preview = server() as typeof store.preview;
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Selected safe report');
  for (const text of [limits, uploadRetention, copyRetention, '604800000 ms', '7776000000 ms', '2592000000 ms', '.123', 'GMT']) expect.soft(view.text()).toContain(text);
  expect(view.findAll('button').some(button => button.text() === publish)).toBe(true);
});
it('uploads only on the first explicit confirmation and publishes only on the second', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); await store.selectLocal(context, source, 'Selected');
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Selected safe report'); expect(api.calls).toHaveLength(1);
  await view.get('[data-testid="confirm-upload"]').trigger('click'); await flushPromises();
  expect(api.calls.map(call => call.operation)).toEqual(['preview-local', 'confirm-upload']);
  expect(api.calls[1]).toEqual({ operation: 'confirm-upload', context, candidateId: '40000000-0000-4000-8000-000000000001' });
  expect(store.preview?.stage).toBe('server');
});
it('submits only the opaque server candidate on explicit publication confirmation', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; store.preview = server() as typeof store.preview;
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Selected safe report');
  await view.get('[data-testid="confirm-publication"]').trigger('click'); await flushPromises();
  expect(api.calls).toEqual([{ operation: 'confirm-publication', context, candidateId: '40000000-0000-4000-8000-000000000002' }]);
});
it('disposes only local preview state when the user cancels', async () => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); await store.selectLocal(context, source, 'Selected');
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Selected safe report');
  await view.get('[data-testid="cancel-preview"]').trigger('click'); await flushPromises();
  expect(api.calls.map(call => call.operation)).toEqual(['preview-local', 'cancel-preview']); expect(store.preview).toBeNull();
});
it('accepts the actual reactive online context without a renderer clone exception', async () => {
  const api = port(), store = createCollaborationStore(api); await store.selectLocal(context, source, 'Plain'); expect(store.preview?.stage).toBe('local');
  await store.selectLocal(reactive(structuredClone(context)), source, 'Reactive'); expect(store.preview?.stage).toBe('local');
});
it('clears an old candidate and records the finite reason before a failed reduced selection can leave a stale action', async () => {
  const api = port(), store = createCollaborationStore(api); await store.selectLocal(context, source, 'First'); expect(store.preview?.stage).toBe('local');
  api.override(input => { if (input.operation === 'preview-local') throw new Error('PUBLICATION_ARTIFACT_TOO_LARGE'); });
  await expect(store.selectLocal(context, { ...source, expectedReportDigest: 'c'.repeat(64) }, 'Reduced')).rejects.toThrow('PUBLICATION_ARTIFACT_TOO_LARGE');
  expect.soft(store.preview).toBeNull(); expect.soft(store.error).toBe('PUBLICATION_ARTIFACT_TOO_LARGE');
});
it.each(['success', 'failure'])('does not overwrite a newly selected real candidate with a late %s', async outcome => {
  const api = port(), store = createCollaborationStore(api); await store.selectLocal(context, source, 'Initial'); expect(store.preview?.stage).toBe('local');
  let resolve!: (value: ReturnType<typeof local>) => void, reject!: (error: Error) => void;
  const wait = new Promise<ReturnType<typeof local>>((yes, no) => { resolve = yes; reject = no; });
  const fresh = { ...local(), candidateId: '40000000-0000-4000-8000-000000000003' };
  api.override(input => input.operation === 'preview-local' ? input.title === 'Old' ? wait : fresh : undefined);
  const old = store.selectLocal(context, source, 'Old').catch(() => {}); await store.selectLocal(context, { ...source, expectedReportDigest: 'c'.repeat(64) }, 'New'); expect(store.preview?.candidateId).toBe(fresh.candidateId);
  if (outcome === 'success') resolve(local()); else reject(new Error('PUBLICATION_ARTIFACT_TOO_LARGE')); await old;
  expect.soft(store.preview?.candidateId).toBe(fresh.candidateId); expect.soft(store.error).toBe('');
});
it('does not restore an in-flight upload after explicit local cancellation', async () => {
  const api = port(), store = createCollaborationStore(api); await store.selectLocal(context, source, 'Initial'); expect(store.preview?.stage).toBe('local');
  let resolve!: (value: ReturnType<typeof server>) => void; const wait = new Promise<ReturnType<typeof server>>(yes => { resolve = yes; });
  api.override(input => input.operation === 'confirm-upload' ? wait : undefined);
  const old = store.confirmUpload(); await store.cancelPreview(); expect(store.preview).toBeNull(); resolve(server()); await old; expect(store.preview).toBeNull();
});
it('rejects the old candidate callback instead of uploading the new selection behind it', async () => {
  const api = port(), store = createCollaborationStore(api); await store.selectLocal(context, source, 'Initial'); const oldId = store.preview!.candidateId;
  const fresh = { ...local(), candidateId: '40000000-0000-4000-8000-000000000003' }; api.override(input => input.operation === 'preview-local' ? fresh : undefined);
  await store.selectLocal(context, { ...source, expectedReportDigest: 'c'.repeat(64) }, 'Reduced'); expect(store.preview!.candidateId).toBe(fresh.candidateId);
  await expect(store.confirmUpload(oldId)).rejects.toThrow('collaboration-source-changed'); expect(api.calls.filter(call => call.operation === 'confirm-upload')).toEqual([]);
});
it('does not duplicate a pending upload even when two confirmation actions arrive', async () => {
  const api = port(), store = createCollaborationStore(api); await store.selectLocal(context, source, 'Initial');
  let resolve!: (value: ReturnType<typeof server>) => void; const wait = new Promise<ReturnType<typeof server>>(yes => { resolve = yes; }); api.override(input => input.operation === 'confirm-upload' ? wait : undefined);
  const first = store.confirmUpload(), second = store.confirmUpload(); await Promise.resolve();
  expect.soft(api.calls.filter(call => call.operation === 'confirm-upload')).toHaveLength(1); resolve(server()); await Promise.all([first, second]);
});
it.each([
  ['preview_expired', '候选已过期，请重新预览', 'The candidate expired; preview again'],
  ['collaboration-candidate-expired', '本机候选已过期，请重新预览', 'The local candidate expired; preview again'],
  ['collaboration-source-budget-exceeded', '本机来源超过读取上限，请选择更小单项', 'The local source exceeds the read limit; choose a smaller item'],
  ['collaboration-source-changed', '来源或当前会话已变化，旧候选不可提交', 'The source or current session changed; the old candidate cannot be submitted'],
  ['PUBLICATION_ARTIFACT_TOO_LARGE', '安全副本超过大小限制，请缩小范围', 'The safe copy exceeds the size limit; reduce the selection'],
  ['forbidden', '当前账号没有此操作权限', 'Your current account is not permitted to perform this action'],
  ['publication_source_changed', '源版本已变化，未发布旧候选', 'The source revision changed; the old candidate was not published'],
  ['collaboration_projection_unavailable', '协作投影服务暂不可用', 'The collaboration projection service is unavailable'],
] as const)('shows the finite %s rejection and safe next step in both languages', async (code, zh, en) => {
  const api = port(), store = createCollaborationStore(api), { i18n } = createI18nInstance(); store.context = context; store.preview = server() as typeof store.preview;
  const view = mount(PublicationPreview, { props: { collaboration: store }, global: { plugins: [i18n] } }); expect(view.text()).toContain('Selected safe report');
  api.override(input => { if (input.operation === 'confirm-publication') throw new Error(code); });
  i18n.global.locale.value = 'zh-CN'; await view.get('[data-testid="confirm-publication"]').trigger('click'); await flushPromises();
  expect.soft(view.text()).toContain(zh); expect.soft(view.text()).toContain('重新选择来源并预览，不自动重发'); expect.soft(store.preview).toBeNull();
  i18n.global.locale.value = 'en'; await flushPromises(); expect.soft(view.text()).toContain(en); expect.soft(view.text()).toContain('Select a source and preview again; no automatic retry');
  expect(api.calls.filter(call => call.operation === 'confirm-publication')).toHaveLength(1);
});
