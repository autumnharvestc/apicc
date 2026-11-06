import { z } from 'zod';
import { hash } from '@apicc/core/sync';
import { createMemberExecutionRequest, ExecutionHttpError } from '@apicc/execution/client';
import { ProjectCollaborationAccessSchema } from '@apicc/execution/client/collaboration';
import { SyncSourceSchema, SyncSourceSaveInputSchema, SyncCandidateViewSchema, SyncFixedDetailSchema, SyncReceiptSchema, SyncHistoryEntrySchema, SyncApplicationInputSchema, SyncRollbackRequestSchema, SyncCheckRequestSchema, SyncCheckAcceptedSchema, SyncCheckStatusSchema, SyncCheckLookupSchema, CredentialMetadataSchema, SchedulePreviewSchema, syncErrorCodeValues } from '@apicc/execution/contract';
import { SynchronizationInputSchema, SyncScheduleViewSchema, SyncPolicyViewSchema, type SynchronizationInput } from '../../shared/synchronization.js';
import type { OnlineSession } from './session.js';
const detailErrorCodes = new Set<string>(syncErrorCodeValues);

/** Remote materials and source reads never fall back to the current computer. */
export async function handleOnlineSynchronization(deps: { session: OnlineSession; fetch?: typeof fetch }, raw: SynchronizationInput): Promise<unknown> {
  const input = SynchronizationInputSchema.parse(raw); if (input.scope.kind !== 'online') throw Error('SYNC_CONTEXT_CHANGED');
  const binding = deps.session.captureExecution(input.scope.context), scope = input.scope.context.scope;
  const request = createMemberExecutionRequest(binding, deps.fetch, undefined, input.operation === 'detail' ? { errorCodes: syncErrorCodeValues } : undefined), project = `workspaces/${scope.workspaceId}/projects/${scope.projectId}`, path = `${project}/sync`;
  const expected = 'intentId' in input && 'expectedSourceRevision' in input ? { formatVersion: 1 as const, intentId: input.intentId, expectedSourceRevision: input.expectedSourceRevision, expectedAssetVersion: input.expectedAssetVersion } : undefined;
  try {
    switch (input.operation) {
      case 'activate': return null;
      case 'sources': return request('GET', `${path}/sources`, undefined, z.array(SyncSourceSchema));
      case 'saveSource': return request(input.expectedRevision === '0' ? 'POST' : 'PUT', `${path}/sources${input.expectedRevision === '0' ? '' : '/' + input.source.id}`, SyncSourceSaveInputSchema.parse({ formatVersion: 1, intentId: input.intentId, expectedSourceRevision: input.expectedRevision, expectedAssetVersion: input.expectedAssetVersion, source: input.source }), SyncSourceSchema);
      case 'check': return request('POST', `${path}/sources/${input.sourceId}/checks`, SyncCheckRequestSchema.parse(expected), SyncCheckAcceptedSchema);
      case 'checks': return request('GET', `${path}/checks?sourceId=${input.sourceId}`, undefined, SyncCheckLookupSchema);
      case 'checkStatus': return request('GET', `${path}/checks/${input.checkId}`, undefined, SyncCheckStatusSchema);
      case 'cancel': return request('POST', `${path}/checks/${input.checkId}/cancel`, {}, SyncCheckStatusSchema);
      case 'detail': { const detail = await request('GET', `${path}/candidates/${input.request.candidateId}/changes/${input.request.changeId}/details?side=${input.request.side}`, undefined, SyncFixedDetailSchema); if (detail.candidateId !== input.request.candidateId || detail.candidateDigest !== input.request.candidateDigest || detail.changeId !== input.request.changeId || detail.side !== input.request.side) throw Error('SYNC_CANDIDATE_MISMATCH'); return detail; }
      case 'candidate': return request('GET', `${path}/candidates/${input.candidateId}`, undefined, SyncCandidateViewSchema);
      case 'apply': {
        const decisions = { ...input.decisions, entries: [...input.decisions.entries].sort((a, b) => a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0) };
        const body = SyncApplicationInputSchema.parse({ ...expected, sourceId: input.sourceId, candidateId: input.candidateId, candidateDigest: input.candidateDigest, decisions: input.decisions, decisionsDigest: hash(['apicc-sync-decisions-v1', decisions]) });
        return request('POST', `${path}/applications`, body, SyncReceiptSchema);
      }
      case 'rollback': return request('POST', `${path}/rollbacks`, SyncRollbackRequestSchema.parse({ ...expected, sourceId: input.sourceId, historyId: input.historyId }), SyncReceiptSchema);
      case 'operation': try { return await request('GET', `${path}/operations/${input.intentId}`, undefined, SyncReceiptSchema); } catch (error) { if (error instanceof ExecutionHttpError && error.status === 404) return null; throw error; }
      case 'history': return request('GET', `${path}/history`, undefined, z.array(SyncHistoryEntrySchema));
      case 'schedule': return request('GET', `${path}/sources/${input.sourceId}/schedule`, undefined, SyncScheduleViewSchema);
      case 'saveSchedule': return request('PUT', `${path}/sources/${input.sourceId}/schedule`, { formatVersion: 1, expectedSourceRevision: input.expectedSourceRevision, expectedGeneration: input.expectedGeneration, enabled: input.enabled, rule: input.rule }, SyncScheduleViewSchema);
      case 'previewSchedule': return request('POST', `${path}/sources/${input.sourceId}/schedule/preview`, { formatVersion: 1, rule: input.rule, afterUtc: input.afterUtc }, SchedulePreviewSchema);
      case 'policy': return request('GET', `${path}/policy`, undefined, SyncPolicyViewSchema);
      case 'access': return request('GET', `${project}/access`, undefined, ProjectCollaborationAccessSchema);
      case 'materials': { const credentials = await request('GET', `${project}/credentials`, undefined, z.array(CredentialMetadataSchema)); return credentials.map(c => ({ refId: c.refId, kind: 'credential', status: c.status, version: c.version })); }
      default: throw Error('SYNC_OPERATION_UNAVAILABLE');
    }
  } catch (error) {
    binding.assertCurrent();
    // Electron preserves Error.message, not arbitrary custom properties. This
    // marker describes a read failure and never classifies a durable write.
    if (input.operation === 'detail' && error instanceof ExecutionHttpError && error.status !== 401 && error.status !== 403 && error.code && detailErrorCodes.has(error.code)) throw Error(`SYNC_DETAIL:${error.code}`);
    throw error;
  }
}
