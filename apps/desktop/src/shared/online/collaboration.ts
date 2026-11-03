import { z } from 'zod';
import { DebugHistoryOwnerIdentitySchema } from '@apicc/core/schema';
import { OnlineExecutionContextSchema } from './execution.js';
import { ProjectLocatorSchema } from '../locations.js';
import { PublicArtifactDtoSchema } from '@apicc/core/collaboration';
import { ProjectCollaborationAccessSchema, CollaborationPreviewSchema, CollaborationPublicationSchema, CollaborationHistorySchema, CollaborationHistoryBodySchema, CollaborationPublicationsSchema, CollaborationGrantsSchema, CollaborationAuditSchema, CollaborationMockLogsSchema, CollaborationGrantMetadataSchema, PublicationOperationSchema, GrantOperationSchema } from '@apicc/execution/client/collaboration';
import { CollaborationHistoryQuerySchema, CollaborationHistoryRefSchema, CollaborationPublicationsQuerySchema, CollaborationGrantsQuerySchema, CollaborationMetadataQuerySchema, CollaborationMockLogsQuerySchema, CollaborationCreateGrantCommandSchema, CollaborationRotateGrantSchema, CollaborationRevokeGrantSchema, CollaborationPreviewInputSchema, CollaborationMockEnabledSchema } from '@apicc/execution/client/collaboration';

export const CollaborationLocalSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('debug'), historyId: z.string().uuid(), owner: DebugHistoryOwnerIdentitySchema, project: ProjectLocatorSchema }).strict(),
  z.object({ kind: z.literal('current'), expectedReportDigest: z.string().regex(/^[a-f0-9]{64}$/), project: ProjectLocatorSchema }).strict(),
  z.object({ kind: z.literal('stress'), file: z.string().regex(/^[^/\\]+\.json$/), project: ProjectLocatorSchema }).strict(),
  z.object({ kind: z.literal('online-local'), runId: z.string().uuid() }).strict(),
]);
const context = { context: OnlineExecutionContextSchema };
export type CollaborationLocalSource = z.infer<typeof CollaborationLocalSourceSchema>;
const candidate = { ...context, candidateId: z.string().uuid() };
export const CollaborationInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('activate'), ...context }).strict(),
  z.object({ operation: z.literal('cancel-preview'), ...context }).strict(),
  z.object({ operation: z.literal('preview-local'), ...context, title: z.string(), source: CollaborationLocalSourceSchema }).strict(),
  z.object({ operation: z.literal('confirm-upload'), ...candidate }).strict(),
  z.object({ operation: z.literal('confirm-publication'), ...candidate }).strict(),
  z.object({ operation: z.literal('access'), ...context, input: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('history'), ...context, input: CollaborationHistoryQuerySchema }).strict(),
  z.object({ operation: z.literal('read-history'), ...context, input: CollaborationHistoryRefSchema }).strict(),
  z.object({ operation: z.literal('publications'), ...context, input: CollaborationPublicationsQuerySchema }).strict(),
  z.object({ operation: z.literal('grants'), ...context, input: CollaborationGrantsQuerySchema }).strict(),
  z.object({ operation: z.literal('audit'), ...context, input: CollaborationMetadataQuerySchema }).strict(),
  z.object({ operation: z.literal('mock-logs'), ...context, input: CollaborationMockLogsQuerySchema }).strict(),
  z.object({ operation: z.literal('create-grant'), ...context, input: CollaborationCreateGrantCommandSchema }).strict(),
  z.object({ operation: z.literal('rotate-grant'), ...context, input: CollaborationRotateGrantSchema.omit({ operationIntent: true }).strict() }).strict(),
  z.object({ operation: z.literal('revoke-grant'), ...context, input: CollaborationRevokeGrantSchema }).strict(),
  z.object({ operation: z.literal('preview-online'), ...context, input: CollaborationPreviewInputSchema.extend({ source: z.discriminatedUnion('kind', [CollaborationPreviewInputSchema.shape.source.options[0], CollaborationPreviewInputSchema.shape.source.options[1], CollaborationPreviewInputSchema.shape.source.options[2], CollaborationPreviewInputSchema.shape.source.options[3]]) }).strict() }).strict(),
  z.object({ operation: z.literal('copy-grant'), ...context, input: z.object({ grantId: z.string() }).strict() }).strict(),
  z.object({ operation: z.literal('reconcile-publication'), ...context, input: z.object({}).strict().optional() }).strict(),
  z.object({ operation: z.literal('reconcile-grant'), ...context, input: z.object({}).strict().optional() }).strict(),
  z.object({ operation: z.literal('set-mock'), ...context, input: CollaborationMockEnabledSchema }).strict(),
]);
export type CollaborationInput = z.infer<typeof CollaborationInputSchema>;
export const COLLABORATION_LOCAL_LIMITS = { source: 'product-hard-ceiling', maxSourceBytes: 67108864, maxArtifactBytes: 33554432, maxFieldBytes: 65536, evidenceIncluded: false, serverPolicyKnown: false } as const;
export const CollaborationLocalLimitsSchema = z.object({ source: z.literal('product-hard-ceiling'), maxSourceBytes: z.literal(67108864), maxArtifactBytes: z.literal(33554432), maxFieldBytes: z.literal(65536), evidenceIncluded: z.literal(false), serverPolicyKnown: z.literal(false) }).strict();
export const CollaborationResultSchema = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('idle') }).strict(),
  z.object({ stage: z.literal('local'), candidateId: z.string().uuid(), artifact: PublicArtifactDtoSchema, expiresAt: z.string(), artifactBytes: z.number().int().nonnegative(), uploadBytes: z.number().int().nonnegative(), localLimits: CollaborationLocalLimitsSchema, source: z.object({ kind: z.enum(['local-debug','local-current','local-stress','online-local']), location: z.literal('local'), selectionCount: z.literal(1), project: z.union([ProjectLocatorSchema, OnlineExecutionContextSchema.shape.scope]) }).strict() }).strict(),
  z.object({ stage: z.literal('server'), candidateId: z.string().uuid(), preview: CollaborationPreviewSchema }).strict(),
  z.object({ stage: z.literal('published'), publication: CollaborationPublicationSchema }).strict(),
  z.object({ stage: z.literal('publication-reconciled'), receipt: PublicationOperationSchema }).strict(),
  z.object({ stage: z.literal('grant-reconciled'), receipt: GrantOperationSchema }).strict(),
  z.object({ stage: z.literal('grant'), grant: CollaborationGrantMetadataSchema, keyAvailable: z.boolean() }).strict(),
  z.object({ stage: z.literal('copied') }).strict(),
  z.object({ stage: z.literal('revoked') }).strict(),
  z.object({ stage: z.literal('access'), access: ProjectCollaborationAccessSchema }).strict(),
  z.object({ stage: z.literal('history'), page: CollaborationHistorySchema }).strict(),
  z.object({ stage: z.literal('history-body'), history: CollaborationHistoryBodySchema }).strict(),
  z.object({ stage: z.literal('publications'), page: CollaborationPublicationsSchema }).strict(),
  z.object({ stage: z.literal('grants'), page: CollaborationGrantsSchema }).strict(),
  z.object({ stage: z.literal('audit'), page: CollaborationAuditSchema }).strict(),
  z.object({ stage: z.literal('mock-logs'), page: CollaborationMockLogsSchema }).strict(),
]);
export type CollaborationResult = z.infer<typeof CollaborationResultSchema>;
