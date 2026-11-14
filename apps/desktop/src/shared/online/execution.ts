import { OnlineExecutionContextSchema, ExecutionLocationSchema, OnlineProjectViewSchema, OnlineJobSchema, OnlineReportSchema, OnlineLocalResultSchema } from "@apicc/execution/client/memberTypes";
export { OnlineExecutionContextSchema, ExecutionLocationSchema, OnlineProjectViewSchema, OnlineJobSchema, InvocationOutputSchema, OnlineReportSchema, OnlineLocalStressSchema, OnlineLocalResultSchema, type OnlineExecutionContext, type ExecutionLocation, type OnlineProjectView, type OnlineJob, type OnlineReport, type OnlineLocalResult } from "@apicc/execution/client/memberTypes";
export { FullOnlineJobSchema, MinimalOnlineJobSchema, isFullOnlineJob, onlineJobScope, type FullOnlineJob } from '@apicc/execution/client/memberTypes';
import { z } from "zod";
import { ApiRequestSchema, ContractProjectSchema, JsonValueSchema, SecretRefSchema } from "@apicc/core/schema";
import { CredentialMutationResultSchema, CredentialStatusResultSchema } from "../credentials.js";
import { EntityIdSchema, ServerProjectScopeSchema, TaskTargetSchema, RunConfigSchema, FixedMaterialSelectionSchema, AssetDeltaSchema, FixedNetworkInputSchema, ProjectExecutionAgentsSchema, ConfigVersionSchema, CredentialMetadataSchema, AttachmentMetadataSchema, AttachmentWriteSchema } from "@apicc/execution/contract";

const base = { context: OnlineExecutionContextSchema };
const uuid = z.string().uuid();
const onlineAssetName = z.string().trim().min(1).max(128);
export const OnlineDirectoryTargetSchema = z.union([
  z.object({ kind: z.literal("project-default"), expectedCollectionId: uuid.nullable() }).strict(),
  z.object({ kind: z.literal("container"), collectionId: uuid, folderIds: z.array(uuid) }).strict(),
]);
export type OnlineDirectoryTarget = z.infer<typeof OnlineDirectoryTargetSchema>;
export const OnlineDirectoryChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create-module"), collectionId: uuid, name: onlineAssetName }).strict(),
  z.object({ kind: z.literal("rename-default"), collectionId: uuid, name: onlineAssetName }).strict(),
  z.object({ kind: z.literal("create-api"), apiId: uuid, caseId: uuid, defaultNonce: uuid,
    target: OnlineDirectoryTargetSchema, name: onlineAssetName, request: ApiRequestSchema }).strict(),
]);
export type OnlineDirectoryChange = z.infer<typeof OnlineDirectoryChangeSchema>;
export const OnlineDirectoryWriteSchema = z.object({ ...base, operation: z.literal("directoryWrite"), expectedVersion: ConfigVersionSchema,
  expectedContractProjectId: uuid.nullable(), initialProjectId: uuid, projectName: onlineAssetName, change: OnlineDirectoryChangeSchema, verifyOnly: z.literal(true).optional() }).strict();
export type OnlineDirectoryWrite = z.infer<typeof OnlineDirectoryWriteSchema>;
export const OnlineExecutionInputSchema = z.discriminatedUnion("operation", [
  z.object({ ...base, operation: z.literal("assets") }).strict(),
  z.object({ ...base, operation: z.literal("save"), delta: AssetDeltaSchema }).strict(),
  z.object({ ...base, operation: z.literal("saveProject"), project: ContractProjectSchema, expectedVersion: ConfigVersionSchema }).strict(),
  OnlineDirectoryWriteSchema,
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
export const OnlineDirectoryResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), view: OnlineProjectViewSchema, path: z.string(), recovered: z.boolean() }).strict(),
  z.object({ status: z.enum(["version-conflict", "target-missing", "ambiguous-default", "legacy-layout", "unknown", "identity-conflict"]),
    view: OnlineProjectViewSchema.optional() }).strict(),
]);
export type OnlineDirectoryResult = z.infer<typeof OnlineDirectoryResultSchema>;
export const OnlineExecutionResultSchema = z.union([OnlineProjectViewSchema, ProjectExecutionAgentsSchema, OnlineJobSchema, z.array(OnlineJobSchema), OnlineLocalResultSchema, OnlineReportSchema, OnlineMaterialsMetadataSchema, AttachmentMetadataSchema, CredentialMutationResultSchema, CredentialStatusResultSchema, OnlinePublishResultSchema, OnlineDirectoryResultSchema, OnlineDatasetContentSchema, z.string()]);
export type OnlineExecutionResult = z.infer<typeof OnlineExecutionResultSchema>;
export interface OnlineExecutionPort { onlineExecution(input: OnlineExecutionInput): Promise<unknown> }
