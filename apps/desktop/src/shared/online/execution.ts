import { OnlineExecutionContextSchema, ExecutionLocationSchema, OnlineProjectViewSchema, OnlineJobSchema, OnlineReportSchema, OnlineLocalResultSchema } from "@apicc/execution/client/memberTypes";
export { OnlineExecutionContextSchema, ExecutionLocationSchema, OnlineProjectViewSchema, OnlineJobSchema, InvocationOutputSchema, OnlineReportSchema, OnlineLocalStressSchema, OnlineLocalResultSchema, type OnlineExecutionContext, type ExecutionLocation, type OnlineProjectView, type OnlineJob, type OnlineReport, type OnlineLocalResult } from "@apicc/execution/client/memberTypes";
export { FullOnlineJobSchema, MinimalOnlineJobSchema, isFullOnlineJob, onlineJobScope, type FullOnlineJob } from '@apicc/execution/client/memberTypes';
import { z } from "zod";
import { ContractProjectSchema, JsonValueSchema, SecretRefSchema } from "@apicc/core/schema";
import { CredentialMutationResultSchema, CredentialStatusResultSchema } from "../credentials.js";
import { EntityIdSchema, ServerProjectScopeSchema, TaskTargetSchema, RunConfigSchema, FixedMaterialSelectionSchema, AssetDeltaSchema, FixedNetworkInputSchema, ProjectExecutionAgentsSchema, ConfigVersionSchema, CredentialMetadataSchema, AttachmentMetadataSchema, AttachmentWriteSchema } from "@apicc/execution/contract";

const base = { context: OnlineExecutionContextSchema };
export const OnlineExecutionInputSchema = z.discriminatedUnion("operation", [
  z.object({ ...base, operation: z.literal("assets") }).strict(),
  z.object({ ...base, operation: z.literal("save"), delta: AssetDeltaSchema }).strict(),
  z.object({ ...base, operation: z.literal("saveProject"), project: ContractProjectSchema, expectedVersion: ConfigVersionSchema }).strict(),
  z.object({ ...base, operation: z.literal("publish"), project: ContractProjectSchema }).strict(),
  z.object({ ...base, operation: z.literal("publishNew"), name: z.string().min(1).max(128), project: ContractProjectSchema }).strict(),
  z.object({ ...base, operation: z.literal("agents") }).strict(),
  z.object({ ...base, operation: z.literal("datasetImport"), content: z.string().max(10 * 1024 * 1024), format: z.enum(["csv", "json"]) }).strict(),
  z.object({ ...base, operation: z.literal("datasetExport"), datasetId: z.string().uuid(), format: z.enum(["csv", "json"]) }).strict(),
  z.object({ ...base, operation: z.literal("materials") }).strict(),
  z.object({ ...base, operation: z.literal("attachmentUpload"), attachment: AttachmentWriteSchema }).strict(),
  z.object({ ...base, operation: z.literal("credential"), action: z.enum(["status", "put", "remove"]), ref: SecretRefSchema, storage: z.enum(["project", "local"]), contractProjectId: z.string().uuid(), value: z.string().optional() }).strict(),
  z.object({ ...base, operation: z.literal("run"), runId: z.string().uuid(), location: ExecutionLocationSchema, target: TaskTargetSchema, expectedVersion: ConfigVersionSchema, environmentId: z.string().uuid().optional(), debugSessionId: z.string().min(1).optional(), runConfig: RunConfigSchema, materials: FixedMaterialSelectionSchema, localOnlyRefIds: z.array(z.string()), network: FixedNetworkInputSchema.optional() }).strict(),
  z.object({ ...base, operation: z.literal("list"), limit: z.number().int().min(1).max(100), beforeJobId: EntityIdSchema.optional() }).strict(),
  z.object({ ...base, operation: z.enum(["status", "cancel", "report"]), location: ExecutionLocationSchema, runId: z.string().min(1) }).strict(),
]);
export type OnlineExecutionInput = z.infer<typeof OnlineExecutionInputSchema>;
export const OnlineMaterialsMetadataSchema = z.object({ credentials: z.array(CredentialMetadataSchema), attachments: z.array(AttachmentMetadataSchema) }).strict();
export const OnlineDatasetContentSchema = z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), JsonValueSchema)) }).strict();
export const OnlinePublishResultSchema = z.object({ scope: ServerProjectScopeSchema, view: OnlineProjectViewSchema }).strict();
export const OnlineExecutionResultSchema = z.union([OnlineProjectViewSchema, ProjectExecutionAgentsSchema, OnlineJobSchema, z.array(OnlineJobSchema), OnlineLocalResultSchema, OnlineReportSchema, OnlineMaterialsMetadataSchema, AttachmentMetadataSchema, CredentialMutationResultSchema, CredentialStatusResultSchema, OnlinePublishResultSchema, OnlineDatasetContentSchema, z.string()]);
export type OnlineExecutionResult = z.infer<typeof OnlineExecutionResultSchema>;
export interface OnlineExecutionPort { onlineExecution(input: OnlineExecutionInput): Promise<unknown> }
