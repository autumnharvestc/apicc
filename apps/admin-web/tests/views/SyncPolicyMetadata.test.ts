import { it, expect, afterEach } from 'vitest';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import fixtures from '../../../../packages/execution/tests/fixtures/sync-policy-view-fixtures.json';
import { mountSyncPolicyView, currentAccess, json } from './sync-fixtures.js';
enableAutoUnmount(afterEach);
it('I1 displays the real high ceiling separately from the legal URL range and completes a normal save', async () => {
  const f = await mountSyncPolicyView({ handler: call => call.path.endsWith('/access') ? json(currentAccess()) : json(call.method === 'PUT' ? fixtures.projectSaved : fixtures.projectHigh) });
  expect(f.wrapper.text()).not.toContain('protocol_error');
  const row = f.row('URL 检查总期限').text(); expect(row).toContain('5–600 秒'); expect(row).toContain('1800 秒');
  await f.wrapper.get('[data-testid="sync-input-gitDeadlineMs"]').setValue('60'); await f.wrapper.get('[data-testid="sync-policy-save"]').trigger('click'); await flushPromises();
  expect(f.wrapper.text()).toContain('版本 1'); expect(f.calls.find(call => call.method === 'PUT')?.body.policy.gitDeadlineMs).toBe(60000);
});
it('I1 displays the actual subminimum ceiling with the invalid state and no effective fallback', async () => {
  const f = await mountSyncPolicyView({ handler: call => call.path.endsWith('/access') ? json(currentAccess()) : json(fixtures.projectLow) });
  expect(f.wrapper.text()).toContain('SYNC_POLICY_INVALID'); expect(f.wrapper.text()).not.toContain('protocol_error');
  const row = f.row('URL 检查总期限').text(); expect(row).toContain('5–600 秒'); expect(row).toContain('1 秒'); expect(row).toContain('无有效值');
});
