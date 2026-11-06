// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mountSyncPanel, candidateView, onlineScope, policyView, deferred, source } from './fixtures.js';
import { SyncNetworkCredentialSchema, SyncCheckStatusSchema } from '@apicc/execution/contract';
import type { ApiccApi } from '../../../../src/shared/types.js';
import { withLocalSync } from '../../../main/sync/fixtures.js';
import { onlineDetailFailure } from '../../../main/sync/detail-error-fixture.js';

describe('readable synchronization panel', () => {
  it.each(['running', 'succeeded', 'failed'] as const)('I4 keeps the loaded online schedule form visible after a manual check becomes %s', async phase => {
    let started = false;
    const status = SyncCheckStatusSchema.parse({ formatVersion: 1, checkId: '00000000-0000-4000-8000-000000000051', sourceId: source.id, state: phase, candidateId: phase === 'succeeded' ? candidateView().candidate.id : null, createdAtMs: 1793956009510, completedAtMs: phase === 'running' ? null : 1793956009759, reasonCode: phase === 'failed' ? 'source-read-failed' : null, detailCode: phase === 'failed' ? 'SYNC_TLS_FAILED' : null });
    const f = await mountSyncPanel('en', { transport: input => {
      if (input.operation === 'check') { started = true; return Promise.resolve({ formatVersion: 1, checkId: status.checkId }); }
      if (input.operation === 'checkStatus') return Promise.resolve(status);
      if (input.operation === 'checks' && started) return Promise.resolve({ formatVersion: 1, sourceId: source.id, current: phase === 'running' ? status : null, latestAttempt: status, latestSuccess: phase === 'succeeded' ? status : null });
      if (input.operation === 'candidate') { const view = candidateView(); return Promise.resolve({ ...view, candidate: { ...view.candidate, stamp: { ...view.candidate.stamp, kind: 'online', assetVersion: '0' } } }); }
      return undefined;
    } });
    try {
      f.store.activate(onlineScope); await f.store.load(); await f.flush();
      const scheduleSection = () => f.wrapper.findAll('section').find(section => section.find('h3').exists() && section.find('h3').text() === 'Online scheduled checks')!;
      expect(scheduleSection().findAll('input').map(input => input.element.value)).toEqual(['0 0 * * * *', 'UTC']);
      await f.wrapper.get('[data-testid="sync-check"]').trigger('click'); await f.flush(); expect(f.store.checkStatus?.state).toBe(phase);
      expect(scheduleSection().findAll('input').map(input => input.element.value)).toEqual(['0 0 * * * *', 'UTC']);
      expect(scheduleSection().text()).toContain('Grant generation'); expect(scheduleSection().text()).toContain('Enable or reauthorize as my current identity');
      expect(f.wrapper.text()).toContain('Latest attempt'); expect(f.wrapper.text()).toContain('2026-11-06 09:06:49.510 UTC'); expect(f.applicationCalls()).toEqual([]); expect(f.scheduleWrites()).toEqual([]);
    } finally { f.unmount(); }
  });
  it.each([
    { language: 'zh-CN' as const, code: 'SYNC_CANCELLED', text: '检查已取消' },
    { language: 'en' as const, code: 'SYNC_CANCELLED', text: 'Check cancelled' },
    { language: 'en' as const, code: 'SYNC_TLS_FAILED', text: 'Source TLS verification failed; check trusted CAs and client certificates' },
  ])('I3 displays the existing $language reason for actual synchronization wrapper $code without internal IPC text', async ({ language, code, text }) => {
    const f = await mountSyncPanel(language, { transport: input => input.operation === 'check' ? Promise.reject(Error(`Error invoking remote method 'synchronization:handle': Error: ${code}`)) : undefined });
    try {
      await f.showCandidate('owned-local'); expect(f.wrapper.text()).toContain(text); expect(f.store.error).toBe(code);
      expect(f.wrapper.text()).not.toContain('Error invoking remote method'); expect(f.wrapper.text()).not.toContain('Operation unavailable'); expect(f.store.candidate).toBeNull(); expect(f.applicationCalls()).toEqual([]);
    } finally { f.unmount(); }
  });
  it.each([{ language: 'zh-CN' as const, wrapped: false, reason: '固定候选输出超出已配置的字节上限' }, { language: 'en' as const, wrapped: true, reason: 'Fixed candidate output exceeds the configured byte limit' }])('fix2 shows a declared online detail limit in $language using only IPC Error.message', async ({ language, wrapped, reason }) => {
    const remote = await onlineDetailFailure('SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED');
    const f = await mountSyncPanel(language, { transport: input => {
      if (input.operation !== 'detail') return undefined;
      return (async () => { try { return await remote.handle(input); } catch (error) { const text = (error as Error).message; throw new Error(wrapped ? `Error invoking remote method 'synchronization': Error: ${text}` : text); } })();
    } });
    try {
      f.store.activate(onlineScope); await f.store.load(); await f.flush(); f.store.candidate = candidateView(); await f.flush();
      const detail = f.wrapper.get('details[data-fixed-detail]'); (detail.element as HTMLDetailsElement).open = true;
      await detail.get('button[data-detail-side="source"]').trigger('click');
      await vi.waitFor(() => expect(detail.text()).toContain(reason));
      expect(f.wrapper.text()).not.toContain('PRIVATE SERVER BODY'); expect(f.store.intentId).toBe(''); expect(remote.requests).toEqual([remote.path]);
    } finally { f.unmount(); }
  });
  it('fix1 C I6 expands the actual protected three-sided asset documents beyond a 240-character common prefix', async () => {
    const prefix = 'Identical common prefix '.repeat(20);
    await withLocalSync(async local => {
      const f = await mountSyncPanel('en', { transport: input => {
        if (input.operation === 'sources') return Promise.resolve([local.source]);
        if (input.operation === 'check') return local.client.check(local.location, local.source.id);
        if (input.operation === 'detail') return local.client.detail(local.location, input.request);
      } });
      try {
        f.store.activate({ kind: 'local', root: local.root, locator: { workspaceId: '00000000-0000-4000-8000-000000000339', ...local.location } }); await f.store.load(); await f.store.check(); await f.flush();
        expect(f.wrapper.text()).not.toContain('BASELINE-TAIL'); expect(f.wrapper.text()).not.toContain('FIXED-LOCAL-TAIL'); expect(f.wrapper.text()).not.toContain('SOURCE-TAIL');
        const changedApi = f.store.candidate!.candidate.changes.find(change => change.path.endsWith('/api.yaml'))!;
        const detail = f.wrapper.get(`details[data-fixed-detail="${changedApi.changeId}"]`);
        (detail.element as HTMLDetailsElement).open = true;
        for (const button of detail.findAll('button[data-detail-side]')) { await button.trigger('click'); await f.flush(); expect(Object.values(f.store.detailErrors).filter(Boolean)).toEqual([]); await vi.waitFor(() => expect(Object.values(f.store.fixedDetails).some(value => value.side === button.attributes('data-detail-side'))).toBe(true)); await f.flush(); }
        expect(f.wrapper.text()).toContain('BASELINE-TAIL'); expect(f.wrapper.text()).toContain('FIXED-LOCAL-TAIL'); expect(f.wrapper.text()).toContain('SOURCE-TAIL'); expect(f.wrapper.text()).toContain('/metadata/description');
      } finally { f.unmount(); }
    }, { baseline: prefix + 'BASELINE-TAIL', local: prefix + 'FIXED-LOCAL-TAIL', source: prefix + 'SOURCE-TAIL' });
  });
  it.each(['direct', 'proxy'])('fix1 B I5 stores a strict %s network credential from semantic fields in the current online project', async kind => {
    const puts: Parameters<ApiccApi['onlineExecution']>[0][] = [];
    const api = { onlineExecution: async (input: Parameters<ApiccApi['onlineExecution']>[0]) => { puts.push(input); return { ok: true }; } } as unknown as ApiccApi;
    const f = await mountSyncPanel('en', { api });
    try { f.store.activate(onlineScope); await f.store.load(); await f.flush(); await f.wrapper.get('[data-testid="sync-edit-source"]').trigger('click');
      const purpose = f.wrapper.findAll('label').find(label => label.text().startsWith('Material purpose'))!.get('select');
      expect(purpose.findAll('option').map(option => option.attributes('value'))).toContain('networkProfileRef');
      const networkRef = f.wrapper.findAll('label').find(label => label.text().startsWith('Network profile reference'))!.get('input'); await networkRef.setValue('owned-network'); await purpose.setValue('networkProfileRef');
      await f.wrapper.get('[data-testid="sync-network-kind"]').setValue(kind); await f.wrapper.get('[data-testid="sync-network-name"]').setValue('Owned source route'); await f.wrapper.get('[data-testid="sync-network-origin"]').setValue('https://source.test');
      await f.wrapper.get('[data-testid="sync-network-ca"]').setValue('OWNED CA PEM'); await f.wrapper.get('[data-testid="sync-network-client-cert"]').setValue('OWNED CLIENT CERT'); await f.wrapper.get('[data-testid="sync-network-client-key"]').setValue('OWNED CLIENT KEY');
      if (kind === 'proxy') { await f.wrapper.get('[data-testid="sync-network-proxy-url"]').setValue('https://proxy.test:8443'); await f.wrapper.get('[data-testid="sync-network-proxy-user"]').setValue('proxy-user'); await f.wrapper.get('[data-testid="sync-network-proxy-password"]').setValue('owned-proxy-password'); await f.wrapper.get('[data-testid="sync-network-proxy-ca"]').setValue('OWNED PROXY CA'); }
      await f.wrapper.get('[data-testid="sync-network-save"]').trigger('click'); await f.flush(); expect(puts).toHaveLength(1);
      const put = puts[0]!; expect(put).toMatchObject({ operation: 'credential', action: 'put', storage: 'project', context: onlineScope.kind === 'online' ? onlineScope.context : null, contractProjectId: '00000000-0000-4000-8000-000000000001', ref: { id: 'owned-network', policy: 'test-auto' } });
      if (put.operation !== 'credential') throw Error('invalid fixture'); const material = SyncNetworkCredentialSchema.parse(JSON.parse(put.value!));
      expect(material.profile).toMatchObject({ kind, name: 'Owned source route', targetTlsBindings: [{ origin: 'https://source.test', tls: { caPems: ['OWNED CA PEM'], clientCertPems: ['OWNED CLIENT CERT'], clientKeyPem: 'OWNED CLIENT KEY' } }] });
      expect(put).not.toHaveProperty('version'); expect(f.wrapper.get('[data-testid="sync-network-client-key"]').element).toHaveProperty('value', ''); expect(f.wrapper.text()).not.toContain('OWNED CLIENT KEY');
    } finally { f.unmount(); }
  });
  it.each(['failure', 'success'])('fix1 A I3 a late source-save %s cannot affect a new project editor or error', async outcome => {
    const late = deferred<unknown>(), entered = deferred<void>();
    const f = await mountSyncPanel('en', { transport: input => { if (input.operation === 'saveSource') { entered.resolve(); return late.promise; } } });
    try { await f.showCandidate('project-a'); await f.wrapper.get('[data-testid="sync-edit-source"]').trigger('click'); await f.wrapper.get('form').trigger('submit'); await entered.promise;
      await f.switchProject('project-b'); await f.wrapper.get('[data-testid="sync-edit-source"]').trigger('click'); f.store.error = 'new-project-error';
      if (outcome === 'failure') late.reject(Error('old-source-save-error')); else late.resolve({ ...source, revision: '2' }); await f.flush();
      expect(f.store.error).toBe('new-project-error'); expect(f.wrapper.find('.sync-source-form form').exists()).toBe(true); expect(f.wrapper.text()).not.toContain('old-source-save-error');
    } finally { f.unmount(); }
  });
  it.each(['zh-CN', 'en'] as const)('renders business B/L/R values and unresolved reasons in %s', async language => {
    const f = await mountSyncPanel(language); try { await f.showCandidate('project-a'); const text = f.wrapper.text();
      expect(text).toContain(language === 'en' ? 'Confirmed baseline B' : '已确认基线 B'); expect(text).toContain('Baseline pets'); expect(text).toContain('Local pets'); expect(text).toContain('Upstream pets');
      expect(text).toContain(language === 'en' ? 'Choose a decision for every change' : '请为每项变更选择决策'); expect(f.wrapper.get('[data-testid="sync-apply"]').attributes('disabled')).toBeDefined(); expect(f.wrapper.find('pre').exists()).toBe(false);
    } finally { f.unmount(); }
  });
  it('clears the old candidate when project scope changes', async () => {
    const f = await mountSyncPanel(); try { await f.showCandidate('project-a'); expect(f.visibleCandidate()).not.toBeNull(); await f.startOldRequest(); await f.switchProject('project-b'); expect(f.visibleCandidate()).toBeNull(); await f.completeOldRequest(); expect(f.visibleCandidate()).toBeNull(); expect(f.applicationCalls()).toHaveLength(0); } finally { f.unmount(); }
  });
  it('shows actual stale and missing-tool reasons without opening advanced data', async () => {
    const f = await mountSyncPanel('en'); try { await f.showCandidate('project-a'); f.store.candidate = { ...candidateView(), applicable: false, reasonCode: 'candidate-expired' }; await f.flush();
      expect(f.wrapper.text()).toContain('Candidate expired'); expect(f.wrapper.text()).toContain('Git is not installed'); expect(f.wrapper.text()).toContain('Only the approved host, port and IP addresses'); expect(f.wrapper.get('[data-testid="sync-apply"]').attributes('disabled')).toBeDefined();
    } finally { f.unmount(); }
  });
  it('clears search with focus retained and keeps long content in a local scroll region', async () => {
    const f = await mountSyncPanel(); try { await f.showCandidate('project-a'); const input = f.wrapper.get<HTMLInputElement>('[data-testid="sync-search"]'); await input.setValue('pets'); await f.wrapper.get('[data-testid="sync-clear"]').trigger('click'); expect(input.element.value).toBe(''); expect(document.activeElement).toBe(input.element);
      expect(getComputedStyle(f.wrapper.get('.sync-scroll').element).overflowY).toBe('auto');
    } finally { f.unmount(); }
  });
  it('disables application until every change is decided and keeping current is confirmed', async () => {
    const f = await mountSyncPanel('en'); try { await f.showCandidate('project-a'); expect(f.wrapper.get('[data-testid="sync-apply"]').attributes('disabled')).toBeDefined();
      f.store.decide({ changeId: '1'.repeat(64), decision: 'keep-current' }); await f.flush(); expect(f.wrapper.get('[data-testid="sync-apply"]').attributes('disabled')).toBeDefined();
      f.store.keepConfirmed = true; await f.flush(); expect(f.wrapper.get('[data-testid="sync-apply"]').attributes('disabled')).toBeUndefined();
    } finally { f.unmount(); }
  });
  it('uses a local scroll region for a long diff', async () => { const f = await mountSyncPanel(); try { await f.showCandidate('project-a'); expect(getComputedStyle(f.wrapper.get('.sync-scroll').element).overflowY).toBe('auto'); } finally { f.unmount(); } });
  it('saves a legal source through semantic fields and exposes actual unavailable material status', async () => {
    const f = await mountSyncPanel('en'); try { await f.showCandidate('project-a'); await f.wrapper.get('[data-testid="sync-edit-source"]').trigger('click');
      expect(f.wrapper.text()).toContain('Unavailable'); const input = f.wrapper.get('input[type="url"]'); await input.setValue('https://source.test/revised.yaml'); await f.wrapper.get('form').trigger('submit'); await f.flush();
      expect(f.savedSources()).toHaveLength(1); expect(f.savedSources()[0]).toMatchObject({ operation: 'saveSource', expectedRevision: '1', source: { revision: '2', url: 'https://source.test/revised.yaml', schedule: { enabled: false } } });
      expect(f.store.selectedSource?.kind === 'url' && f.store.selectedSource.url).toBe('https://source.test/revised.yaml');
    } finally { f.unmount(); }
  });
  it('consumes finite schedule facts and explicitly authorizes the current actor without guessing a next time', async () => {
    const f = await mountSyncPanel('en'); try { f.store.activate(onlineScope); await f.store.load(); await f.flush(); const text = f.wrapper.text();
      expect(text).toContain('Private server source host'); expect(text).toContain('Captured material rotated or was removed'); expect(text).toContain('Next occurrence: not calculated'); expect(text).toContain('Earlier intervals were skipped'); expect(text).toContain('2026-11-06 16:00:00.123 UTC'); expect(text).toContain('Executed subject');
      const authorize = f.wrapper.findAll('button').find(button => button.text() === 'Enable or reauthorize as my current identity')!; await authorize.trigger('click'); await f.flush();
      expect(f.scheduleWrites()).toHaveLength(1); expect(f.scheduleWrites()[0]).toMatchObject({ operation: 'saveSchedule', expectedSourceRevision: '1', expectedGeneration: '0', enabled: true }); expect(f.store.schedule?.subjectUserId).toBe('7');
    } finally { f.unmount(); }
  });
  it('shows units, effective provenance and invalid-policy repair reasons in the main view', async () => {
    const f = await mountSyncPanel('en'); try { f.store.activate(onlineScope); await f.store.load(); await f.flush();
      expect(f.wrapper.text()).toContain('Maximum history entries per source'); expect(f.wrapper.text()).toContain('100 entries/source'); expect(f.wrapper.text()).toContain('5 MiB'); expect(f.wrapper.text()).toContain('Value source');
      f.store.policy = { ...policyView(), status: 'invalid', effective: null, reasonCode: 'SYNC_POLICY_INVALID' } as typeof f.store.policy; await f.flush(); expect(f.wrapper.text()).toContain('An administrator must repair saved values'); expect(f.wrapper.get('[data-testid="sync-check"]').attributes('disabled')).toBeDefined();
    } finally { f.unmount(); }
  });
  it('explains a known source byte-limit failure in visible business language', async () => {
    const f = await mountSyncPanel('en'); try { await f.showCandidate('project-a'); f.store.error = 'SYNC_SOURCE_TOO_LARGE'; await f.flush(); expect(f.wrapper.text()).toContain('Source document exceeds the configured byte limit'); } finally { f.unmount(); }
  });
});
