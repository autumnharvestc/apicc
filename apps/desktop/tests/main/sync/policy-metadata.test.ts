import { it, expect } from 'vitest';
import fixtures from '../../../../../packages/execution/tests/fixtures/sync-policy-view-fixtures.json';
import { SyncPolicyViewSchema } from '../../../src/shared/synchronization.js';

it.each(['workspaceHigh', 'projectHigh', 'workspaceLow', 'projectLow'] as const)('I1 desktop decodes actual Java %s ceiling metadata unchanged', key => {
  const view = SyncPolicyViewSchema.parse(fixtures[key]); expect(view.deploymentCeilings.urlDeadlineMs).toBe(key.endsWith('Low') ? 1000 : 1800000);
  if (key.endsWith('Low')) { expect(view.status).toBe('invalid'); expect(view.effective).toBeNull(); expect(view.reasonCode).toBe('SYNC_POLICY_INVALID'); }
});
it.each([{ unknown: 1000 }, { urlDeadlineMs: -1 }, { urlDeadlineMs: 1.5 }, { urlDeadlineMs: Number.MAX_SAFE_INTEGER + 1 }, { urlDeadlineMs: '1000' }, { urlDeadlineMs: Infinity }])('I1 desktop rejects undeclared or unsafe metadata %j', deploymentCeilings => {
  expect(SyncPolicyViewSchema.safeParse({ ...fixtures.projectHigh, deploymentCeilings }).success).toBe(false);
});
