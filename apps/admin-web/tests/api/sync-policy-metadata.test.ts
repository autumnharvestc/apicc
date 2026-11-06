// @vitest-environment node
import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import fixtures from '../../../../packages/execution/tests/fixtures/sync-policy-view-fixtures.json';
import { SyncPolicyViewSchema, createSynchronizationApi } from '../../src/api/synchronization.js';
import { createAdminClient } from '../../src/api/client.js';
import { SyncPolicyValuesSchema, defaultSyncPolicyValues } from '@apicc/execution/contract';

it.each(['workspaceHigh', 'projectHigh', 'workspaceLow', 'projectLow'] as const)('I1 decodes actual Java %s metadata without changing the reported ceiling or invalid state', key => {
  const view = SyncPolicyViewSchema.parse(fixtures[key]);
  expect(view.deploymentCeilings.urlDeadlineMs).toBe(key.endsWith('Low') ? 1000 : 1800000);
  if (key.endsWith('Low')) { expect(view.status).toBe('invalid'); expect(view.effective).toBeNull(); expect(view.reasonCode).toBe('SYNC_POLICY_INVALID'); }
});
it.each([{ unknown: 1000 }, { urlDeadlineMs: -1 }, { urlDeadlineMs: 1.5 }, { urlDeadlineMs: Number.MAX_SAFE_INTEGER + 1 }, { urlDeadlineMs: '1000' }, { urlDeadlineMs: Infinity }])('I1 rejects undeclared or unsafe metadata %j', deploymentCeilings => {
  expect(SyncPolicyViewSchema.safeParse({ ...fixtures.projectHigh, deploymentCeilings }).success).toBe(false);
});
it('I1 keeps executable policy legal ranges independent of deployment metadata', () => {
  expect(SyncPolicyValuesSchema.safeParse({ ...defaultSyncPolicyValues, urlDeadlineMs: 1800000 }).success).toBe(false);
  expect(SyncPolicyValuesSchema.safeParse({ ...defaultSyncPolicyValues, gitDeadlineMs: 1000 }).success).toBe(false);
});
it.each(['GET', 'PUT'] as const)('I1 real AdminClient %s decodes the actual Java high-ceiling response over HTTP', async method => {
  const server = createServer((req, res) => {
    if (req.url !== '/api/v1/workspaces/1/projects/2/sync/policy' || req.headers.authorization !== 'Bearer owned-metadata') { res.writeHead(403); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.method === 'PUT' ? fixtures.projectSaved : fixtures.projectHigh));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const client = createAdminClient({ baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/v1`, token: 'owned-metadata' });
    const api = createSynchronizationApi(client), scope = { workspaceId: '1', projectId: '2' };
    if (method === 'GET') expect((await api.policy(scope)).deploymentCeilings.urlDeadlineMs).toBe(1800000);
    else {
      const saved = await api.savePolicy(scope, { formatVersion: 1, intentId: '00000000-0000-4000-8000-000000000099', expectedRevision: '0', policy: { formatVersion: 1, revision: '1', scope: 'project', gitDeadlineMs: 60000 } });
      expect(saved.saved.revision).toBe('1'); expect(saved.saved.gitDeadlineMs).toBe(60000); expect(saved.deploymentCeilings.urlDeadlineMs).toBe(1800000);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
