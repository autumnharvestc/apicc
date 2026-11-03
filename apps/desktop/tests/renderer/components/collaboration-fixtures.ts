import { safeReport } from '../../../../../packages/core/tests/collaboration/fixtures.js';
import { previewConstraints, grantConstraints } from '../../../../../packages/execution/tests/helpers/collaboration.js';
import { CollaborationInputSchema, CollaborationResultSchema, COLLABORATION_LOCAL_LIMITS, type CollaborationInput, type CollaborationResult } from '../../../src/shared/online/collaboration.js';
export const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
export const source = { kind: 'current' as const, project: { workspaceId: '00000000-0000-4000-8000-000000000001', groupId: '00000000-0000-4000-8000-000000000002', projectId: '00000000-0000-4000-8000-000000000003' }, expectedReportDigest: 'a'.repeat(64) };
export function artifact() { const value = safeReport(); value.title = 'Selected safe report'; value.source.trust = 'member-claim'; value.report!.counts.unshift({ labelCode: 'logical.units', total: 1, passed: 1, failed: 0 }); const result = CollaborationResultSchema.parse({ stage: 'history-body', history: { source: 'member-history', id: '40', artifact: value } }); if (result.stage !== 'history-body') throw new Error('fixture'); return result.history.artifact; }
export const local = () => CollaborationResultSchema.parse({ stage: 'local', candidateId: '40000000-0000-4000-8000-000000000001', artifact: artifact(), expiresAt: '2099-11-02T00:10:00.123Z', artifactBytes: 4096, uploadBytes: 4200, localLimits: COLLABORATION_LOCAL_LIMITS, source: { kind: 'local-current', location: 'local', selectionCount: 1, project: source.project } });
export const server = () => CollaborationResultSchema.parse({ stage: 'server', candidateId: '40000000-0000-4000-8000-000000000002', preview: { id: '40', state: 'pending', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2, expiresAt: '2099-11-02T00:10:00.123Z', artifact: artifact(), constraints: previewConstraints() } });
export const publication = () => ({ id: '41', version: 1, digest: 'b'.repeat(64), kind: 'report' as const, trust: 'member-claim' as const, createdBy: '7', createdAt: '2026-11-02T00:00:00.123Z', revision: 3, enabled: true, source: { kind: 'member-upload' as const, revision: 'r1', digest: 'd1', uploadId: '12', uploadedBy: '7', jobId: null }, artifact: artifact() });
export const grant = () => ({ id: '42', publicationId: '41', version: 1, purpose: 'view' as const, audience: 'external' as const, responsibleId: '7', responsibilityEpoch: 2, generation: 1, expiresAt: 2000000000123, downloadAllowed: false, revision: 1, state: 'active', operationIntent: 'intent', publicId: 'a'.repeat(22), publicUrl: 'https://public.test/s/' + 'a'.repeat(22) });
export const history = (kind: 'server-report' | 'member-history' = 'server-report') => ({ id: '40', source: kind, kind: 'report', trust: kind === 'server-report' ? 'server-archive' as const : 'member-claim' as const, createdBy: '7', createdAt: '2026-11-02T00:00:00.123Z', conclusion: 'unknown', state: 'ended', integrity: 'unavailable', jobId: kind === 'server-report' ? '40' : null, executionId: null, agentId: null, creatorId: '7', snapshotId: null, runtime: { origin: 'unavailable' as const, runtimeCompatibilityId: null, executionProfile: null, policyRevision: null, coreBuildId: null, scriptApiId: null, nodeVersion: null, v8Version: null }, conclusionInfo: { origin: 'legacy-unindexed' as const, reasonCode: 'legacy-unindexed' as const, reason: 'Legacy result has no terminal index' } });
export function port() {
  const calls: CollaborationInput[] = [];
  let override: ((input: CollaborationInput) => Promise<CollaborationResult | void> | CollaborationResult | void) | undefined;
  return { calls, override(handler: NonNullable<typeof override>) { override = handler; }, async onlineCollaboration(input: CollaborationInput): Promise<CollaborationResult> {
    calls.push(CollaborationInputSchema.parse(input)); const supplied = await override?.(input); if (supplied) return supplied;
    switch (input.operation) {
      case 'activate': case 'cancel-preview': return { stage: 'idle' };
      case 'preview-local': return local();
      case 'preview-online': case 'confirm-upload': return server();
      case 'confirm-publication': case 'set-mock': return { stage: 'published', publication: publication() };
      case 'access': return { stage: 'access', access: { accountEnabled: true, member: true, workspaceRole: 'EDITOR', projectOverride: null, overrideState: 'inherited', effectiveRole: 'EDITOR', capabilities: ['history.read', 'history.publish', 'publication.manage', 'mock.manage'], accessRevision: 2, membershipEpoch: 1, responsibilityEpoch: 1, reasonCode: null } };
      case 'history': return { stage: 'history', page: { items: [history(), history('member-history')], nextCursor: 'next' } };
      case 'read-history': return { stage: 'history-body', history: { ...input.input, artifact: artifact() } };
      case 'publications': { const { artifact: _, ...metadata } = publication(); return { stage: 'publications', page: { items: [{ ...metadata, policyRevision: 2 }], nextCursor: null } }; }
      case 'grants': return { stage: 'grants', page: { items: [grant()], nextCursor: null, constraints: { ...grantConstraints(), externalSharingAllowed: { value: true, source: 'project' }, externalDownloadAllowed: { value: false, source: 'project' } } } };
      case 'create-grant': case 'rotate-grant': return { stage: 'grant', grant: grant(), keyAvailable: true };
      case 'revoke-grant': return { stage: 'revoked' };
      case 'copy-grant': return { stage: 'copied' };
      case 'reconcile-grant': return { stage: 'grant-reconciled', receipt: { grantId: '42', command: 'create', revision: 1, generation: 1, keyObtained: false } };
      case 'reconcile-publication': return { stage: 'publication-reconciled', receipt: { publicationIntentId: 'intent', state: 'committed', publicationId: '41', candidateDigest: 'b'.repeat(64) } };
      default: throw new Error('Unexpected collaboration test operation');
    }
  } };
}
