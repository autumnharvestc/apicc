// @vitest-environment jsdom
import { it, expect } from 'vitest';
import fixtures from '../../../../../../packages/execution/tests/fixtures/sync-policy-view-fixtures.json';
import { mountSyncPanel, onlineScope } from './fixtures.js';
import { metadataOnlineAdapter } from '../../../main/sync/policy-metadata-fixture.js';

it('I1 keeps legal URL range and a real accepted intermediate deployment ceiling separately visible', async () => {
  const adapter = await metadataOnlineAdapter(fixtures.projectMid);
  const f = await mountSyncPanel('en', { transport: input => input.operation === 'policy' ? adapter.handle(input) : undefined });
  try {
    f.store.activate(onlineScope); await f.store.load(); await f.flush(); expect(f.store.error).toBe('');
    const row = f.wrapper.findAll('tr').find(row => row.find('th').text() === 'URL total deadline')!.text();
    expect(row).toContain('5,000 ms – 600,000 ms'); expect(row).toContain('Deployment limit: 300,000 ms');
  } finally { f.unmount(); }
});
it.each(['projectHigh', 'projectLow'] as const)('I1 actual online policy %s load retains access capabilities and readable state', async key => {
  const adapter = await metadataOnlineAdapter(fixtures[key]);
  const f = await mountSyncPanel('en', { transport: input => input.operation === 'policy' ? adapter.handle(input) : undefined });
  try {
    f.store.activate(onlineScope); await f.store.load(); await f.flush(); expect(f.store.error).toBe('');
    expect(f.store.capabilities).toContain('sync.check'); expect(f.store.policy?.deploymentCeilings.urlDeadlineMs).toBe(key.endsWith('Low') ? 1000 : 1800000);
    if (key.endsWith('Low')) { expect(f.store.policy?.effective).toBeNull(); expect(f.wrapper.text()).toContain('Synchronization policy is invalid'); expect(f.wrapper.get('[data-testid="sync-check"]').attributes('disabled')).toBeDefined(); }
    else expect(f.wrapper.get('[data-testid="sync-check"]').attributes('disabled')).toBeUndefined();
  } finally { f.unmount(); }
});
