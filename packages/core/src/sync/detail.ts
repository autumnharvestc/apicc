import { createHash } from 'node:crypto';
import { SyncFixedDetailInputSchema, SyncFixedDetailSchema, type SyncFixedDetailInput, type SyncFixedDetail } from './types.js';
import { assertBytes, readSyncProject } from './files.js';
export type { SyncFixedDetailInput as FixedSyncDetailInput, SyncFixedDetailRequest as FixedSyncDetailRequest } from './types.js';

/** The trusted coordinator supplies one protected fixed side. The caller can
 * select only a candidate-owned change, never a filename or a live project. */
export async function readFixedSyncDetail(value: SyncFixedDetailInput): Promise<SyncFixedDetail> {
  const parsed = SyncFixedDetailInputSchema.safeParse(value); if (!parsed.success) throw Error('SYNC_INPUT_INVALID');
  const { candidate, request, files, budget } = parsed.data;
  if (candidate.id !== request.candidateId || candidate.candidateDigest !== request.candidateDigest) throw Error('SYNC_CANDIDATE_MISMATCH');
  const change = candidate.changes.find(change => change.changeId === request.changeId); if (!change) throw Error('SYNC_CANDIDATE_MISMATCH');
  assertBytes(files, budget.maxCompareInputBytes, 'SYNC_COMPARE_INPUT_BYTES_EXCEEDED');
  if (files.length) await readSyncProject(files);
  const identity = { ...request, entityKind: change.entityKind, entityId: change.entityId, assetPath: change.path, fieldPath: change.fieldPath };
  const file = files.find(file => file.path === change.path);
  if (!file) return SyncFixedDetailSchema.parse({ ...identity, kind: 'absent' });
  const contentType = file.path.endsWith('.md') ? 'text/markdown' : /\.ya?ml$/.test(file.path) ? 'application/vnd.apicc.contract+yaml' : undefined;
  if (!contentType) throw Error('SYNC_INVALID_FILES');
  const result = SyncFixedDetailSchema.parse({ ...identity, kind: 'document', contentType, text: file.content,
    bytes: Buffer.byteLength(file.content, 'utf8'), sha256: createHash('sha256').update(file.content, 'utf8').digest('hex') });
  assertBytes(result, budget.maxCompareOutputBytes, 'SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED');
  return result;
}
