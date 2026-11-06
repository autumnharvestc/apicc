import type { SyncCandidateView, SyncFixedDetailRequest, SyncFixedDetail, SyncDecisions, SyncHistoryEntry, SyncPolicyValues, SyncReceipt, SyncSource } from '@apicc/core/sync/shared';
import type { ProjectLocator } from './locations.js';
import type { OnlineExecutionContext } from './online/execution.js';

export type SyncScope = { kind: 'local'; root: string; locator: ProjectLocator } | { kind: 'online'; context: OnlineExecutionContext };
export type SynchronizationInput = { scope: SyncScope; locale?: 'zh-CN' | 'en' } & (
  | { operation: 'activate' | 'deactivate' | 'sources' | 'history' | 'settings' | 'policy' | 'materials' | 'access' }
  | { operation: 'saveSource'; source: SyncSource; expectedRevision: string; expectedAssetVersion: string; intentId: string }
  | { operation: 'check'; sourceId: string; expectedSourceRevision: string; expectedAssetVersion: string; intentId: string }
  | { operation: 'cancel'; checkId: string }
  | { operation: 'detail'; request: SyncFixedDetailRequest }
  | { operation: 'candidate'; candidateId: string }
  | { operation: 'apply'; sourceId: string; candidateId: string; candidateDigest: string; decisions: SyncDecisions; expectedSourceRevision: string; expectedAssetVersion: string; intentId: string }
  | { operation: 'rollback'; sourceId: string; historyId: string; expectedSourceRevision: string; expectedAssetVersion: string; intentId: string }
  | { operation: 'operation'; intentId: string }
  | { operation: 'checkStatus'; checkId: string }
  | { operation: 'checks' | 'schedule'; sourceId: string }
  | { operation: 'saveSchedule'; sourceId: string; expectedSourceRevision: string; expectedGeneration: string; enabled: boolean; rule: import('@apicc/core/sync/shared').SyncSource['schedule']['rule'] }
  | { operation: 'previewSchedule'; sourceId: string; rule: import('@apicc/core/sync/shared').SyncSource['schedule']['rule']; afterUtc: string }
  | { operation: 'configureTools'; tool: 'git' | 'ssh' }
  | { operation: 'saveSettings'; maxRedirects: number; policy: SyncPolicyValues }
);
export interface SyncHostSettings { revision?: string; maxRedirects: number; policy: SyncPolicyValues; git: 'available' | 'missing'; ssh: 'available' | 'missing' }
export type SynchronizationResult = SyncFixedDetail | SyncSource[] | SyncSource | SyncCandidateView | SyncHistoryEntry[] | SyncReceipt | SyncHostSettings | z.infer<typeof SyncCheckAcceptedSchema> | z.infer<typeof SyncCheckStatusSchema> | z.infer<typeof SyncCheckLookupSchema> | SyncScheduleView | SyncPolicyView | SyncMaterialStatus[] | z.infer<typeof SchedulePreviewSchema> | z.infer<typeof ProjectCollaborationAccessSchema> | null;
export interface SynchronizationPort { synchronization(input: SynchronizationInput): Promise<unknown> }
import { z } from 'zod';
import { SyncSourceSchema, SyncDecisionsSchema, SyncCandidateViewSchema, SyncReceiptSchema, SyncHistoryEntrySchema, SyncPolicyValuesSchema, SyncRevisionSchema, SyncHashSchema, SyncFixedDetailRequestSchema, SyncFixedDetailSchema, SyncCronRuleSchema, SyncPolicySchema, SyncEffectivePolicySchema, SyncDeploymentLimitsSchema } from '@apicc/core/sync/shared';
import { SyncCheckAcceptedSchema, SyncCheckStatusSchema, SyncCheckLookupSchema } from '@apicc/execution/contract';
import { ProjectCollaborationAccessSchema } from '@apicc/execution/client/collaboration';
import { SchedulePreviewSchema } from '@apicc/execution/contract';
import { ProjectLocatorSchema } from './locations.js';
import { OnlineExecutionContextSchema } from './online/execution.js';
const scope = { locale: z.enum(['zh-CN', 'en']).optional(), scope: z.discriminatedUnion('kind', [z.object({ kind: z.literal('local'), root: z.string().min(1), locator: ProjectLocatorSchema }).strict(), z.object({ kind: z.literal('online'), context: OnlineExecutionContextSchema }).strict()]) };
const uuid = z.string().uuid(), expected = { expectedSourceRevision: SyncRevisionSchema, expectedAssetVersion: SyncRevisionSchema, intentId: uuid };
export const SynchronizationInputSchema = z.discriminatedUnion('operation', [
  z.object({ ...scope, operation: z.enum(['activate', 'deactivate', 'sources', 'history', 'settings', 'policy', 'materials', 'access']) }).strict(),
  z.object({ ...scope, operation: z.literal('saveSource'), source: SyncSourceSchema, expectedRevision: SyncRevisionSchema, expectedAssetVersion: SyncRevisionSchema, intentId: uuid }).strict(),
  z.object({ ...scope, operation: z.literal('check'), sourceId: uuid, ...expected }).strict(),
  z.object({ ...scope, operation: z.enum(['cancel', 'checkStatus']), checkId: uuid }).strict(),
  z.object({ ...scope, operation: z.literal('detail'), request: SyncFixedDetailRequestSchema }).strict(),
  z.object({ ...scope, operation: z.literal('candidate'), candidateId: uuid }).strict(),
  z.object({ ...scope, operation: z.literal('apply'), sourceId: uuid, candidateId: uuid, candidateDigest: SyncHashSchema, decisions: SyncDecisionsSchema, ...expected }).strict(),
  z.object({ ...scope, operation: z.literal('rollback'), sourceId: uuid, historyId: uuid, ...expected }).strict(),
  z.object({ ...scope, operation: z.literal('operation'), intentId: uuid }).strict(),
  z.object({ ...scope, operation: z.enum(['checks', 'schedule']), sourceId: uuid }).strict(),
  z.object({ ...scope, operation: z.literal('saveSchedule'), sourceId: uuid, expectedSourceRevision: SyncRevisionSchema, expectedGeneration: SyncRevisionSchema, enabled: z.boolean(), rule: SyncCronRuleSchema }).strict(),
  z.object({ ...scope, operation: z.literal('previewSchedule'), sourceId: uuid, rule: SyncCronRuleSchema, afterUtc: z.string().datetime().regex(/Z$/) }).strict(),
  z.object({ ...scope, operation: z.literal('configureTools'), tool: z.enum(['git', 'ssh']) }).strict(),
  z.object({ ...scope, operation: z.literal('saveSettings'), maxRedirects: z.number().int().min(0).max(20), policy: SyncPolicyValuesSchema }).strict(),
]);
export const SyncHostSettingsSchema = z.object({ revision: SyncRevisionSchema.optional(), maxRedirects: z.number().int().min(0).max(20), policy: SyncPolicyValuesSchema, git: z.enum(['available', 'missing']), ssh: z.enum(['available', 'missing']) }).strict();
export function parseSynchronizationResult(input: SynchronizationInput, value: unknown): SynchronizationResult {
  switch (input.operation) {
    case 'activate': case 'deactivate': return z.null().parse(value);
    case 'schedule': case 'saveSchedule': return SyncScheduleViewSchema.parse(value);
    case 'previewSchedule': return SchedulePreviewSchema.parse(value);
    case 'policy': return SyncPolicyViewSchema.parse(value);
    case 'materials': return z.array(SyncMaterialStatusSchema).parse(value);
    case 'access': return ProjectCollaborationAccessSchema.parse(value);
    case 'sources': return z.array(SyncSourceSchema).parse(value);
    case 'saveSource': return SyncSourceSchema.parse(value);
    case 'history': return z.array(SyncHistoryEntrySchema).parse(value);
    case 'apply': case 'rollback': return SyncReceiptSchema.parse(value);
    case 'operation': return SyncReceiptSchema.nullable().parse(value);
    case 'detail': return SyncFixedDetailSchema.parse(value);
    case 'candidate': return SyncCandidateViewSchema.parse(value);
    case 'check': return input.scope.kind === 'local' ? SyncCandidateViewSchema.parse(value) : SyncCheckAcceptedSchema.parse(value);
    case 'cancel': return input.scope.kind === 'local' ? z.null().parse(value) : SyncCheckStatusSchema.parse(value);
    case 'checkStatus': return SyncCheckStatusSchema.parse(value);
    case 'checks': return SyncCheckLookupSchema.parse(value);
    case 'settings': case 'configureTools': case 'saveSettings': return SyncHostSettingsSchema.parse(value);
    default: throw Error('SYNC_OPERATION_UNAVAILABLE');
  }
}

const nullableText = z.string().nullable();
export const SyncScheduleViewSchema = z.object({ formatVersion: z.literal(1), sourceId: uuid, sourceRevision: SyncRevisionSchema, generation: SyncRevisionSchema, enabled: z.boolean(), subjectUserId: nullableText, pausedReasonCode: z.enum(['authorization-changed','source-revision-changed','material-changed','occurrence-capacity','storage-limit','policy-changed','rule-invalid']).nullable(), rule: SyncCronRuleSchema, nextPlannedAtUtc: z.null(), nextPlannedState: z.literal('not-calculated'), lastOccurrence: z.object({ occurrenceId: z.string(), plannedAtUtc: z.string(), checkId: uuid.nullable(), state: z.enum(['submitted','coalesced','detached','queued','running','waiting','cancelling','cancelled','lost','succeeded','failed']), associationState: z.enum(['submitted','coalesced','detached']), checkState: SyncCheckStatusSchema.shape.state.nullable(), coalesced: z.boolean(), coalescedDueCount: z.number().int().nonnegative().nullable(), missedBeforeWindow: z.boolean().nullable(), evaluatedAfterUtc: nullableText, evaluatedThroughUtc: nullableText, requestedSubjectUserId: nullableText, executedSubjectUserId: nullableText }).strict().nullable() }).strict();
export type SyncScheduleView = z.infer<typeof SyncScheduleViewSchema>;
const policyBase = { saved: SyncPolicySchema, inherited: SyncPolicySchema.nullable(), workspaceRevision: SyncRevisionSchema, units: z.record(SyncPolicyValuesSchema.keyof(), z.enum(['milliseconds','bytes','days','count'])), deploymentLimits: SyncDeploymentLimitsSchema, deploymentCeilings: z.partialRecord(SyncPolicyValuesSchema.keyof(), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)) };
export const SyncPolicyViewSchema = z.discriminatedUnion('status', [z.object({ ...policyBase, status: z.literal('valid'), effective: SyncEffectivePolicySchema, reasonCode: z.null() }).strict(), z.object({ ...policyBase, status: z.literal('invalid'), effective: z.null(), reasonCode: z.literal('SYNC_POLICY_INVALID') }).strict()]);
export type SyncPolicyView = z.infer<typeof SyncPolicyViewSchema>;
export const SyncMaterialStatusSchema = z.object({ refId: z.string(), kind: z.enum(['credential','network-profile']), status: z.enum(['available','registered','missing','unavailable']), version: z.string().nullable() }).strict();
export type SyncMaterialStatus = z.infer<typeof SyncMaterialStatusSchema>;
