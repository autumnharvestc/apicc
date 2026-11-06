import { z } from 'zod';
import { createMemberExecutionRequest } from './memberHttp.js';
import type { MemberExecutionContext, MemberExecutionDependencies } from './memberTypes.js';
import { PublicArtifactDtoSchema, MemberPublicationInputSchema, PublicationScopeSchema, CompiledMockPlanSchema } from '@apicc/core/collaboration';

const id = z.string();
const revision = z.number().int().nonnegative().safe();
const textOrNull = z.string().nullable();
const cursor = textOrNull;
const noInput = z.object({}).strict();
export const CollaborationCapabilitySchema = z.enum(['script.edit', 'credential.manage', 'task.execute', 'history.read', 'history.publish', 'publication.manage', 'mock.manage', 'audit.read', 'mock.logs.read', 'sync.manage', 'sync.check', 'sync.apply']);
const role = z.enum(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
export const ProjectCollaborationAccessSchema = z.object({ accountEnabled: z.boolean(), member: z.boolean(), workspaceRole: role.nullable(), projectOverride: z.enum(['NONE', 'ADMIN', 'EDITOR', 'VIEWER']).nullable(), overrideState: z.string(), effectiveRole: role.nullable(), capabilities: z.array(CollaborationCapabilitySchema), accessRevision: revision, membershipEpoch: revision, responsibilityEpoch: revision, reasonCode: textOrNull }).strict();

const settingCodes = ['externalSharingAllowed','historyPublishingAllowed','sharedMockAllowed','defaultShareDurationMs','maxShareDurationMs','externalDownloadAllowed','previewTtlMs','maxPreviewsPerPerson','maxPreviewsPerProject','maxPreviewsGlobal','publicationOperationTimeoutMs','maxSourceBytes','maxArtifactBytes','evidenceAllowed','maxFieldBytes','maxEvidenceBytes','maxProjectVersions','maxProjectStorageBytes','maxProjectActiveGrants','inactiveArtifactRetentionMs','memberUploadRetentionMs','maxMemberUploadRecords','defaultPageSize','maxPageSize','publicReadRps','publicReadInFlight','mockRps','mockInFlight','maxMockRequestBytes','maxMockResponseBytes','maxMockDelayMs','mockCallTimeoutMs','mockLogMaxEntries','mockLogRetentionMs','extraSensitiveHeaders','extraSensitiveQuery','extraSensitiveFields','extraSensitivePointers','corsAllowedOrigins','managementAuditRetentionMs','accessAuditRetentionMs','cleanupBatchSize','cleanupIntervalMs','rpcConnectTimeoutMs','rpcCallTimeoutMs','deploymentMaxStorageBytes','deploymentPublicReadRps','deploymentPublicReadInFlight','deploymentMockRps','deploymentMockInFlight','deploymentMaxActiveGrants','nodeCacheBytes','rpcMaxMessageBytes'] as const;
const unit = z.enum(['boolean','milliseconds','bytes','count','requests-per-second','items','vCPU']);
const effect = z.enum(['current-access-and-new-grants','new-publications','new-grants','each-download','new-previews','new-operations','new-projections-and-existing-grant-compliance','new-projections','new-storage-writes','new-or-rotated-grants','eligible-cleanup','new-uploads-and-retention','each-list-read','each-admission','each-mock-call','new-plans-and-current-calls','new-log-entries-and-cleanup','each-browser-call','audit-cleanup','new-access-records-and-cleanup','next-cleanup-cycle','new-rpc-calls','runtime-startup']);
const settingCommon = { code: z.enum(settingCodes), source: z.enum(['builtin','deployment','platform','workspace','project','upper-ceiling','union']), unit, effect };
const setting = z.discriminatedUnion('valueType', [
  z.object({ ...settingCommon, valueType: z.literal('boolean'), builtin: z.boolean(), local: z.boolean().nullable(), effective: z.boolean() }).strict(),
  z.object({ ...settingCommon, valueType: z.literal('integer'), builtin: revision, local: revision.nullable(), effective: revision, minimum: revision.nullable(), maximum: revision.nullable() }).strict(),
  z.object({ ...settingCommon, valueType: z.literal('decimal'), builtin: z.number(), local: z.number().nullable(), effective: z.number(), minimum: z.number().nullable(), maximum: z.number().nullable() }).strict(),
  z.object({ ...settingCommon, valueType: z.literal('string-list'), builtin: z.array(z.string()), local: z.array(z.string()).nullable(), effective: z.array(z.string()), maxItems: revision.nullable(), maxItemCodePoints: revision.nullable() }).strict(),
]);
const recommended = z.object({ value: z.number(), minimum: z.number(), maximum: z.number(), unit }).strict();
const configured = z.object({ value: z.number().nullable(), status: z.enum(['unconfigured','configured']), unit }).strict();
export const CollaborationPolicySchema = z.object({ revision: revision.nullable(), projectionRevision: revision.nullable(), settings: z.array(setting),
  resources: z.object({ recommendations: z.object({ cpuVcpu: recommended, totalMemoryBytes: recommended, nodeHeapBytes: recommended }).strict(), externalLimits: z.object({ cpuVcpu: configured, totalMemoryBytes: configured }).strict(), applicationSettings: z.object({ nodeHeapBytes: configured, inFlightBytes: configured, headroomBytes: configured }).strict() }).strict(),
  identity: z.object({ deploymentDigest: z.string(), effectiveDigest: z.string(), lineage: z.array(z.object({ scope: z.enum(['platform','workspace','project']), workspaceId: textOrNull, projectId: textOrNull, revision, projectionRevision: revision }).strict()) }).strict(),
}).strict();
export const CollaborationSourceSchema = z.object({ kind: z.enum(['document','mock','server-report','member-upload','member-history']), revision: z.string(), digest: z.string(), uploadId: textOrNull, jobId: textOrNull, uploadedBy: textOrNull }).strict();
const constraintSource = z.enum(['builtin','deployment','platform','workspace','project','upper-ceiling','union']);
const integerFact = z.object({ value: revision, source: constraintSource }).strict();
const booleanFact = z.object({ value: z.boolean(), source: constraintSource }).strict();
export const CollaborationGrantConstraintsSchema = z.object({ defaultShareDurationMs: integerFact, maxShareDurationMs: integerFact, externalSharingAllowed: booleanFact, externalDownloadAllowed: booleanFact }).strict();
export const CollaborationPreviewConstraintsSchema = CollaborationGrantConstraintsSchema.extend({ maxSourceBytes: integerFact, maxArtifactBytes: integerFact, maxFieldBytes: integerFact, maxEvidenceBytes: integerFact, evidenceAllowed: booleanFact, memberUploadRetentionMs: integerFact, inactiveArtifactRetentionMs: integerFact }).strict();
const previewCommon = { id, state: z.string(), candidateDigest: z.string(), expectedPolicyRevision: revision, expiresAt: z.string(), constraints: CollaborationPreviewConstraintsSchema };
export const CollaborationPreviewSchema = z.union([
  z.object({ ...previewCommon, artifact: PublicArtifactDtoSchema }).strict(),
  z.object({ ...previewCommon, plan: CompiledMockPlanSchema, source: CollaborationSourceSchema, planFingerprint: z.string() }).strict(),
]);
const publicationCommon = { id, version: revision, digest: z.string(), kind: z.enum(['document','report','debug-history','mock']), trust: z.enum(['saved-contract','server-archive','member-claim']), createdBy: id, createdAt: z.string(), revision, enabled: z.boolean(), source: CollaborationSourceSchema };
const activity = z.object({ activeRequests: revision, state: z.enum(['enabled','active','draining','disabled']), stateLabel: z.string() }).strict();
export const CollaborationPublicationSchema = z.union([
  z.object({ ...publicationCommon, artifact: PublicArtifactDtoSchema }).strict(),
  z.object({ ...publicationCommon, kind: z.literal('mock'), plan: CompiledMockPlanSchema, planFingerprint: z.string(), activity: activity.optional() }).strict(),
]);
export const CollaborationPublicationMetadataSchema = z.object({ ...publicationCommon, policyRevision: revision }).strict();
export const CollaborationPublicationsSchema = z.object({ items: z.array(CollaborationPublicationMetadataSchema), nextCursor: cursor }).strict();
const historySource = z.enum(['server-report','member-history']);
export const CollaborationHistoryMetadataSchema = z.object({ id, source: historySource, kind: z.string(), trust: z.enum(['server-archive','member-claim']), createdBy: id, createdAt: z.string(), conclusion: textOrNull, state: z.string(), integrity: z.string(), jobId: textOrNull, executionId: textOrNull, agentId: textOrNull, creatorId: textOrNull, snapshotId: textOrNull,
  runtime: z.object({ origin: z.enum(['unavailable','start-permit','stress-admission']), runtimeCompatibilityId: textOrNull, executionProfile: textOrNull, policyRevision: textOrNull, coreBuildId: textOrNull, scriptApiId: textOrNull, nodeVersion: textOrNull, v8Version: textOrNull }).strict(),
  conclusionInfo: z.object({ origin: z.enum(['terminal-index','member-claim','not-ended','legacy-unindexed']), reasonCode: z.enum(['not-ended','legacy-unindexed']).nullable(), reason: textOrNull }).strict(),
}).strict();
export const CollaborationHistorySchema = z.object({ items: z.array(CollaborationHistoryMetadataSchema), nextCursor: cursor }).strict();
export const CollaborationHistoryBodySchema = z.object({ id, source: historySource, artifact: PublicArtifactDtoSchema }).strict();
export const PublicationOperationSchema = z.object({ publicationIntentId: z.string(), state: z.string(), publicationId: id, candidateDigest: z.string() }).strict();
export const GrantOperationSchema = z.object({ grantId: id, command: z.enum(['create','rotate']), revision, generation: revision, keyObtained: z.literal(false) }).strict();
export const CollaborationGrantSchema = z.object({ id, publicationId: id, version: revision, purpose: z.enum(['view','call']), audience: z.enum(['members','external']), responsibleId: id, responsibilityEpoch: revision, generation: revision, expiresAt: revision, downloadAllowed: z.boolean(), revision, state: z.string(), operationIntent: z.string(), publicId: z.string().optional(), publicUrl: z.string().optional(), baseUrl: z.string().optional(), memberPath: z.string().optional(), key: z.string().optional(), reason: z.string().optional() }).strict();
export const CollaborationGrantMetadataSchema = CollaborationGrantSchema.omit({ key: true }).strict();
export const CollaborationGrantsSchema = z.object({ items: z.array(CollaborationGrantMetadataSchema), nextCursor: cursor, constraints: CollaborationGrantConstraintsSchema }).strict();
const auditBase = { id, actorId: textOrNull, action: z.string(), time: z.string(), revision: revision.nullable(), objectKind: textOrNull, objectId: textOrNull };
const pageFacts = { nextCursor: cursor, scannedCount: revision, pageLimit: revision };
export const CollaborationAuditSchema = z.object({ access: z.array(z.object({ ...auditBase, reason: textOrNull }).strict()), execution: z.array(z.object({ ...auditBase, agentId: textOrNull, locations: z.array(z.string()).nullable(), locationLabel: z.string(), summary: textOrNull, summaryLabel: z.string(), beforeRevision: textOrNull, afterRevision: textOrNull }).strict()), collaboration: z.array(z.object({ ...auditBase, reason: textOrNull }).strict()), accessDetails: z.object({ state: z.enum(['bounded','disabled','observations-missing']), retentionMs: revision }).strict().optional(), ...pageFacts }).strict();
export const CollaborationMockLogsSchema = z.object({ items: z.array(z.object({ id, publicationId: id, version: revision, time: z.string(), method: z.string(), routeTemplate: textOrNull, ruleId: textOrNull, status: z.number().int(), durationMs: revision, reason: textOrNull, requestId: textOrNull, grantPublicId: textOrNull }).strict()), ...pageFacts, discarded: revision, state: z.enum(['disabled','bounded','observations-missing']), integrityLabel: z.string(), maxEntries: revision, retentionMs: revision }).strict();
const pageInput = { limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() };
export const CollaborationHistoryQuerySchema = z.object({ source: historySource.optional(), ...pageInput, conclusion: z.enum(['passed','failed','interrupted','cancelled','timed-out','rejected','unknown']).optional() }).strict();
export const CollaborationHistoryRefSchema = z.object({ id, source: historySource }).strict();
export const CollaborationPreviewInputSchema = z.object({ title: z.string(), includeEvidence: z.boolean(), source: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), revision: z.string(), manifestHash: z.string(), scope: PublicationScopeSchema }).strict(),
  z.object({ kind: z.literal('mock'), revision: z.string(), manifestHash: z.string(), scope: z.object({ kind: z.literal('project') }).strict() }).strict(),
  z.object({ kind: z.literal('server-report'), jobId: id }).strict(),
  z.object({ kind: z.literal('member-history'), uploadId: id }).strict(),
  z.object({ kind: z.literal('member-upload'), artifact: z.union([MemberPublicationInputSchema.shape.artifact.options[1], MemberPublicationInputSchema.shape.artifact.options[2]]) }).strict(),
]) }).strict();
export const CollaborationConfirmInputSchema = z.object({ publicationIntentId: z.string(), previewId: id, candidateDigest: z.string(), expectedPolicyRevision: revision.min(1) }).strict();
export const CollaborationOperationInputSchema = z.object({ kind: z.enum(['publication','grant']), intentId: z.string() }).strict();
export const CollaborationPublicationsQuerySchema = z.object(pageInput).strict();
const createGrantFields = z.object({ publicationId: id, operationIntent: z.string(), purpose: z.enum(['view','call']), audience: z.enum(['members','external']), downloadAllowed: z.boolean().optional(), expiresAt: revision.optional(), durationMs: revision.min(60000).optional(), expectedRevision: revision }).strict();
const exclusiveGrantExpiry = (input: { expiresAt?: number; durationMs?: number }) => input.expiresAt === undefined || input.durationMs === undefined;
export const CollaborationCreateGrantSchema = createGrantFields.refine(exclusiveGrantExpiry);
export const CollaborationCreateGrantCommandSchema = createGrantFields.omit({ operationIntent: true }).refine(exclusiveGrantExpiry);
export const CollaborationRotateGrantSchema = z.object({ grantId: id, operationIntent: z.string(), expectedRevision: revision }).strict();
export const CollaborationRevokeGrantSchema = z.object({ grantId: id, expectedRevision: revision }).strict();
export const CollaborationMockEnabledSchema = z.object({ publicationId: id, enabled: z.boolean(), expectedRevision: revision }).strict();
export const CollaborationMetadataQuerySchema = z.object({ ...pageInput, object: z.string().optional(), actor: z.string().optional(), time: z.string().optional() }).strict();
export const CollaborationMockLogsQuerySchema = CollaborationMetadataQuerySchema.extend({ publicationId: id }).strict();
export const CollaborationGrantsQuerySchema = z.object({ publicationId: id, ...pageInput }).strict();
function query(values: object) { const entries = Object.entries(values).filter(([,value]) => value !== undefined); return entries.length ? '?' + new URLSearchParams(entries.map(([key,value]) => [key,String(value)])).toString() : ''; }

/** Every operation captures the current member binding. No URL/path authority or retries. */
export function createMemberCollaborationClient(deps: Pick<MemberExecutionDependencies, 'session' | 'fetch'>) {
  function captured(context: MemberExecutionContext, signal?: AbortSignal) {
    const binding = deps.session.captureExecution(context); binding.assertCurrent();
    if (binding.userId !== context.ownerId || binding.serverId !== context.serverId) throw new Error('online-session-changed');
    return { request: createMemberExecutionRequest(binding, deps.fetch, signal), project: `workspaces/${encodeURIComponent(context.scope.workspaceId)}/projects/${encodeURIComponent(context.scope.projectId)}` };
  }
  function request<T>(context: MemberExecutionContext, method: string, path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal) { const bound = captured(context, signal); return bound.request(method, `${bound.project}/collaboration${path}`, body, schema); }
  return {
    async listGrants(context: MemberExecutionContext, raw: z.input<typeof CollaborationGrantsQuerySchema>, signal?: AbortSignal) { const { publicationId, ...input } = CollaborationGrantsQuerySchema.parse(raw); return request(context, 'GET', `/publications/${encodeURIComponent(publicationId)}/grants` + query(input), undefined, CollaborationGrantsSchema, signal); },
    async readPolicy(context: MemberExecutionContext, input: z.input<typeof noInput> = {}, signal?: AbortSignal) { noInput.parse(input); return request(context, 'GET', '/policy', undefined, CollaborationPolicySchema, signal); },
    async readAccess(context: MemberExecutionContext, input: z.input<typeof noInput> = {}, signal?: AbortSignal) { noInput.parse(input); const bound = captured(context, signal); return bound.request('GET', `${bound.project}/access`, undefined, ProjectCollaborationAccessSchema); },
    async listHistory(context: MemberExecutionContext, raw: z.input<typeof CollaborationHistoryQuerySchema> = {}, signal?: AbortSignal) { const input = CollaborationHistoryQuerySchema.parse(raw); return request(context, 'GET', '/history' + query(input), undefined, CollaborationHistorySchema, signal); },
    async readHistory(context: MemberExecutionContext, raw: z.input<typeof CollaborationHistoryRefSchema>, signal?: AbortSignal) { const input = CollaborationHistoryRefSchema.parse(raw); return request(context, 'GET', `/history/${encodeURIComponent(input.id)}` + query({ source: input.source }), undefined, CollaborationHistoryBodySchema, signal); },
    async preview(context: MemberExecutionContext, raw: z.input<typeof CollaborationPreviewInputSchema>, signal?: AbortSignal) { const input = CollaborationPreviewInputSchema.parse(raw); return request(context, 'POST', '/previews', input, CollaborationPreviewSchema, signal); },
    async commitPublication(context: MemberExecutionContext, raw: z.input<typeof CollaborationConfirmInputSchema>, signal?: AbortSignal) { const input = CollaborationConfirmInputSchema.parse(raw); return request(context, 'POST', '/publications', input, CollaborationPublicationSchema, signal); },
    async queryOperation(context: MemberExecutionContext, raw: z.input<typeof CollaborationOperationInputSchema>, signal?: AbortSignal) { const input = CollaborationOperationInputSchema.parse(raw); return input.kind === 'grant' ? request(context, 'GET', `/grant-operations/${encodeURIComponent(input.intentId)}`, undefined, GrantOperationSchema, signal) : request(context, 'GET', `/operations/${encodeURIComponent(input.intentId)}`, undefined, PublicationOperationSchema, signal); },
    async listPublications(context: MemberExecutionContext, raw: z.input<typeof CollaborationPublicationsQuerySchema> = {}, signal?: AbortSignal) { const input = CollaborationPublicationsQuerySchema.parse(raw); return request(context, 'GET', '/publications' + query(input), undefined, CollaborationPublicationsSchema, signal); },
    async createGrant(context: MemberExecutionContext, raw: z.input<typeof CollaborationCreateGrantSchema>, signal?: AbortSignal) { const { publicationId, ...body } = CollaborationCreateGrantSchema.parse(raw); return request(context, 'POST', `/publications/${encodeURIComponent(publicationId)}/grants`, body, CollaborationGrantSchema, signal); },
    async rotateGrant(context: MemberExecutionContext, raw: z.input<typeof CollaborationRotateGrantSchema>, signal?: AbortSignal) { const { grantId, ...body } = CollaborationRotateGrantSchema.parse(raw); return request(context, 'POST', `/grants/${encodeURIComponent(grantId)}/rotate`, body, CollaborationGrantSchema, signal); },
    async revokeGrant(context: MemberExecutionContext, raw: z.input<typeof CollaborationRevokeGrantSchema>, signal?: AbortSignal) { const { grantId, ...body } = CollaborationRevokeGrantSchema.parse(raw); return request(context, 'DELETE', `/grants/${encodeURIComponent(grantId)}`, body, z.undefined(), signal); },
    async setMockEnabled(context: MemberExecutionContext, raw: z.input<typeof CollaborationMockEnabledSchema>, signal?: AbortSignal) { const { publicationId, enabled, ...body } = CollaborationMockEnabledSchema.parse(raw); return request(context, 'POST', `/publications/${encodeURIComponent(publicationId)}/${enabled ? 'enable' : 'disable'}`, body, CollaborationPublicationSchema, signal); },
    async readAudit(context: MemberExecutionContext, raw: z.input<typeof CollaborationMetadataQuerySchema> = {}, signal?: AbortSignal) { const input = CollaborationMetadataQuerySchema.parse(raw); return request(context, 'GET', '/audit' + query(input), undefined, CollaborationAuditSchema, signal); },
    async readMockLogs(context: MemberExecutionContext, raw: z.input<typeof CollaborationMockLogsQuerySchema>, signal?: AbortSignal) { const { publicationId, ...input } = CollaborationMockLogsQuerySchema.parse(raw); return request(context, 'GET', `/publications/${encodeURIComponent(publicationId)}/mock-logs` + query(input), undefined, CollaborationMockLogsSchema, signal); },
  };
}
export type MemberCollaborationClient = ReturnType<typeof createMemberCollaborationClient>;
export type CollaborationPolicy = z.infer<typeof CollaborationPolicySchema>;
export type CollaborationPreview = z.infer<typeof CollaborationPreviewSchema>;
export type CollaborationPublication = z.infer<typeof CollaborationPublicationSchema>;
export type CollaborationPublicationMetadata = z.infer<typeof CollaborationPublicationMetadataSchema>;
export type CollaborationHistoryMetadata = z.infer<typeof CollaborationHistoryMetadataSchema>;
export type CollaborationGrant = z.infer<typeof CollaborationGrantSchema>;
