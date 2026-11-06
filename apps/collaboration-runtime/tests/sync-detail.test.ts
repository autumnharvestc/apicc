import { it, expect } from 'vitest';
import { threeWayFixture } from '../../../packages/core/tests/sync/fixtures.js';
import { buildSyncCandidate } from '@apicc/core/sync';
import { startCollaborationRuntime } from '../src/server.js';
import { rpc, secret } from './sync-runtime-fixture.js';
it('fix1 C fixed-detail crosses the real bounded private RPC without exposing planInput or materials', async () => {
  const f = await threeWayFixture(); f.remoteProject.collections[0]!.apis[0]!.documentation = '# Fixed Markdown\n' + 'common '.repeat(50) + 'RPC-SOURCE-TAIL';
  const input = f.planInput(), candidate = await buildSyncCandidate(input), change = candidate.changes.find(change => change.path.endsWith('/design.md'))!;
  const request = { formatVersion: 1, candidateId: candidate.id, candidateDigest: candidate.candidateDigest, changeId: change.changeId, side: 'source' };
  const payload = { kind: 'fixed-detail', candidate, request, files: input.remoteFiles, budget: input.budget };
  const runtime = await startCollaborationRuntime({ secret, port: 0 });
  try {
    const reply = await rpc(runtime.url, 'sync-plan', payload); expect(reply.status).toBe(200); const envelope = await reply.json();
    expect(envelope.payload).toMatchObject({ kind: 'document', contentType: 'text/markdown', text: expect.stringContaining('RPC-SOURCE-TAIL') }); expect(envelope.payload).not.toHaveProperty('planInput'); expect(envelope.payload).not.toHaveProperty('material');
    const invalid = await rpc(runtime.url, 'sync-plan', { ...payload, request: { ...request, side: 'live' } }); expect(invalid.ok).toBe(false);
  } finally { await runtime.close(); }
});
