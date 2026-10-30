import { z } from 'zod';
import { ConfigVersionSchema, EntityIdSchema, TaskTargetSchema, RunConfigSchema, AttachmentSelectionSchema, AttachmentPathsSchema, ScheduleCredentialBindingSchema, ScheduleExecutionSchema, FixedNetworkInputSchema, ScheduleOptionsSchema, SchedulePageSchema, ScheduleSaveSchema, ScheduleViewSchema } from '@apicc/execution/contract';
import { OnlineExecutionContextSchema } from './execution.js';
import { ScheduleUpdateSchema, SchedulePreviewRequestSchema, SchedulePreviewSchema, ScheduleMaterialOptionsSchema, ScheduleHistoryPageSchema, NotificationPageSchema, NotificationHistoryPageSchema, NotificationReadSchema } from '@apicc/execution/contract';

// Pure transport declarations; Core preparation and secrets remain in main.
export const OnlineSchedulePreparationInputSchema = z.object({ context: OnlineExecutionContextSchema, expectedVersion: ConfigVersionSchema, agentId: EntityIdSchema, target: TaskTargetSchema, environmentId: z.string().uuid().optional(), runConfig: RunConfigSchema, materials: z.object({ projectId: EntityIdSchema, attachments: z.array(AttachmentSelectionSchema), attachmentPaths: AttachmentPathsSchema.optional() }).strict(), credentialBindings: z.array(ScheduleCredentialBindingSchema).default([]), localOnlyRefIds: z.array(z.string()).default([]), network: FixedNetworkInputSchema.optional(), previous: z.object({ execution: ScheduleExecutionSchema, snapshotVersion: ConfigVersionSchema, manifestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict();
const diffValue = z.object({ name: z.string().optional(), ids: z.array(z.string()).optional(), count: z.number().int().nonnegative().optional(), version: z.string().optional(), fingerprint: z.string().optional() }).strict();
export const OnlineSchedulePreparationSchema = z.object({ execution: ScheduleExecutionSchema, snapshotVersion: ConfigVersionSchema, manifestHash: z.string().regex(/^[a-f0-9]{64}$/), snapshotDiff: z.object({ previousSnapshotVersion: ConfigVersionSchema.nullable(), currentSnapshotVersion: ConfigVersionSchema, areas: z.array(z.object({ area: z.enum(['target', 'environment', 'scripts', 'data', 'materials', 'network', 'runtime']), changed: z.boolean(), before: diffValue.nullable(), after: diffValue }).strict()) }).strict() }).strict();
const context = { context: OnlineExecutionContextSchema };
export const OnlineOriginalJobIdentitySchema = z.object({ jobId: EntityIdSchema, executionId: EntityIdSchema, agentId: EntityIdSchema }).strict();
export const OnlineSchedulingInputSchema = z.discriminatedUnion('operation', [
  z.object({ ...context, operation: z.literal('originalJob'), jobId: EntityIdSchema, executionId: EntityIdSchema }).strict(),
  z.object({ ...context, operation: z.literal('options') }).strict(),
  z.object({ ...context, operation: z.literal('list'), limit: z.number().int().min(1).max(100), beforeId: EntityIdSchema.optional() }).strict(),
  z.object({ ...context, operation: z.literal('prepare'), input: OnlineSchedulePreparationInputSchema.omit({ context: true }) }).strict(),
  z.object({ ...context, operation: z.literal('save'), input: ScheduleSaveSchema }).strict(),
  z.object({ ...context, operation: z.literal('detail'), id: EntityIdSchema }).strict(),
  z.object({ ...context, operation: z.literal('update'), id: EntityIdSchema, input: ScheduleUpdateSchema }).strict(),
  z.object({ ...context, operation: z.literal('remove'), id: EntityIdSchema, expectedVersion: ConfigVersionSchema }).strict(),
  z.object({ ...context, operation: z.literal('preview'), input: SchedulePreviewRequestSchema }).strict(),
  z.object({ ...context, operation: z.literal('materialOptions') }).strict(),
  z.object({ ...context, operation: z.literal('history'), id: EntityIdSchema, limit: z.number().int().min(1).max(100), beforeId: EntityIdSchema.optional(), missedBeforeId: EntityIdSchema.optional() }).strict(),
  z.object({ ...context, operation: z.literal('notificationHistory'), id: EntityIdSchema, limit: z.number().int().min(1).max(100), beforeId: EntityIdSchema.optional(), sourceBeforeId: EntityIdSchema.optional() }).strict(),
  z.object({ ...context, operation: z.literal('notifications'), limit: z.number().int().min(1).max(100), beforeId: EntityIdSchema.optional() }).strict(),
  z.object({ ...context, operation: z.literal('markNotificationRead'), id: EntityIdSchema }).strict(),
]);
export type OnlineSchedulingInput = z.input<typeof OnlineSchedulingInputSchema>;
export const OnlineSchedulingResultSchema = z.union([OnlineOriginalJobIdentitySchema, ScheduleOptionsSchema, SchedulePageSchema, OnlineSchedulePreparationSchema, ScheduleViewSchema, SchedulePreviewSchema, ScheduleMaterialOptionsSchema, ScheduleHistoryPageSchema, NotificationPageSchema, NotificationHistoryPageSchema, NotificationReadSchema, z.null()]);
export type OnlineSchedulingResult = z.infer<typeof OnlineSchedulingResultSchema>;
export function parseOnlineSchedulingResult(input: OnlineSchedulingInput, value: unknown): OnlineSchedulingResult {
  const schemas = { originalJob: OnlineOriginalJobIdentitySchema, prepare: OnlineSchedulePreparationSchema, options: ScheduleOptionsSchema, list: SchedulePageSchema, save: ScheduleViewSchema, detail: ScheduleViewSchema, update: ScheduleViewSchema, remove: z.null(), preview: SchedulePreviewSchema, materialOptions: ScheduleMaterialOptionsSchema, history: ScheduleHistoryPageSchema, notificationHistory: NotificationHistoryPageSchema, notifications: NotificationPageSchema, markNotificationRead: NotificationReadSchema };
  return schemas[input.operation].parse(value);
}
export type OnlineSchedulePreparation = z.infer<typeof OnlineSchedulePreparationSchema>;
export type OnlineSchedulePreparationInput = z.input<typeof OnlineSchedulePreparationInputSchema>;
export interface OnlineSchedulingPort { onlineScheduling(input: OnlineSchedulingInput): Promise<unknown> }
