import { describe, it, expect } from 'vitest';
import { buildSyncCandidate } from '../../src/sync/compare.js';
import { readFixedSyncDetail, type FixedSyncDetailInput } from '../../src/sync/detail.js';
import { threeWayFixture } from './fixtures.js';
async function fixed(long = false) {
  const f = await threeWayFixture(), prefix = 'Shared prefix '.repeat(long ? 26000 : 30);
  f.baseProject.collections[0]!.apis[0]!.contract.metadata.description = prefix + 'BASELINE-TAIL';
  f.localProject.collections[0]!.apis[0]!.contract.metadata.description = prefix + 'FIXED-LOCAL-TAIL';
  f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = prefix + 'SOURCE-TAIL';
  const input = f.planInput(), candidate = await buildSyncCandidate(input), change = candidate.changes.find(c => c.fieldPath === '/metadata/description')!;
  expect(change.summaries.current).toMatchObject({ kind: 'scalar', truncated: true });
  return { input, candidate, change };
}
describe('fix1 C fixed typed asset document projection', () => {
  it('reports an asset absent on the actual empty first-check baseline', async () => {
    const f = await threeWayFixture(), input = { ...f.planInput(), baselineFiles: [] }, candidate = await buildSyncCandidate(input), change = candidate.changes.find(change => change.entityKind === 'api' && change.path.endsWith('/api.yaml'))!;
    expect(change).toBeDefined();
    const result = await readFixedSyncDetail({ candidate, request: { formatVersion: 1, candidateId: candidate.id, candidateDigest: candidate.candidateDigest, changeId: change.changeId, side: 'baseline' }, files: [], budget: input.budget });
    expect(result).toMatchObject({ kind: 'absent', side: 'baseline', assetPath: change.path }); expect(result).not.toHaveProperty('text');
  });
  it('preserves the actual design.md Markdown media type and complete fixed text', async () => {
    const f = await threeWayFixture(), prefix = '# Fixed markdown\n' + 'common documentation '.repeat(20);
    f.baseProject.collections[0]!.apis[0]!.documentation = prefix + 'BASE-MARKDOWN-TAIL'; f.localProject.collections[0]!.apis[0]!.documentation = prefix + 'LOCAL-MARKDOWN-TAIL'; f.remoteProject.collections[0]!.apis[0]!.documentation = prefix + 'SOURCE-MARKDOWN-TAIL';
    const input = f.planInput(), candidate = await buildSyncCandidate(input), change = candidate.changes.find(change => change.path.endsWith('/design.md'))!; expect(change).toBeDefined();
    const result = await readFixedSyncDetail({ candidate, request: { formatVersion: 1, candidateId: candidate.id, candidateDigest: candidate.candidateDigest, changeId: change.changeId, side: 'source' }, files: input.remoteFiles, budget: input.budget });
    expect(result).toMatchObject({ kind: 'document', contentType: 'text/markdown', text: prefix + 'SOURCE-MARKDOWN-TAIL' });
  });
  it.each(['baseline','current','source'] as const)('returns the complete fixed %s asset document beyond the summary tail', async side => {
    const f = await fixed(), files = side === 'baseline' ? f.input.baselineFiles : side === 'current' ? f.input.localFiles : f.input.remoteFiles;
    const result = await readFixedSyncDetail({ candidate: f.candidate, request: { formatVersion: 1, candidateId: f.candidate.id, candidateDigest: f.candidate.candidateDigest, changeId: f.change.changeId, side }, files, budget: f.input.budget });
    expect(result).toMatchObject({ kind: 'document', side, entityId: f.change.entityId, fieldPath: '/metadata/description', text: expect.stringContaining(side === 'baseline' ? 'BASELINE-TAIL' : side === 'current' ? 'FIXED-LOCAL-TAIL' : 'SOURCE-TAIL') });
  });
  it.each(['candidate','digest','change','side'])('rejects an unbound %s through the callable fixed-detail entry', async wrong => {
    const f = await fixed(), request = { formatVersion: 1 as const, candidateId: f.candidate.id, candidateDigest: f.candidate.candidateDigest, changeId: f.change.changeId, side: 'current' as const };
    const input: FixedSyncDetailInput = { candidate: f.candidate, request, files: f.input.localFiles, budget: f.input.budget };
    if (wrong === 'candidate') input.request = { ...request, candidateId: '00000000-0000-4000-8000-000000000099' };
    if (wrong === 'digest') input.request = { ...request, candidateDigest: '0'.repeat(64) };
    if (wrong === 'change') input.request = { ...request, changeId: '0'.repeat(64) };
    if (wrong === 'side') input.request = { ...request, side: 'live' as never };
    await expect(readFixedSyncDetail(input)).rejects.toThrow(/^SYNC_/);
  });
  it('rejects an actual full asset above the output budget instead of silently truncating it', async () => {
    const f = await fixed(true);
    await expect(readFixedSyncDetail({ candidate: f.candidate, request: { formatVersion: 1, candidateId: f.candidate.id, candidateDigest: f.candidate.candidateDigest, changeId: f.change.changeId, side: 'source' }, files: f.input.remoteFiles, budget: { ...f.input.budget, maxCompareOutputBytes: 262144 } })).rejects.toThrow('SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED');
  });
});
