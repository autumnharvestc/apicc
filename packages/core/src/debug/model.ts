import { z } from "zod";
import { ApiRequestSchema } from "../contract/request.js";
import { RequestSettingsOverrideSchema, RequestSettingsSchema } from "../request/settings.js";
import type { ApiRequest } from "../contract/model.js";
import type { RequestSettings, RequestSettingsOverride } from "../request/settings.js";
import type { CaseFailureKind } from "../runner/caseExecutor.js";

const IdentityStringSchema = z.string().min(1);
const HistoryUuidSchema = z.string().uuid();

export const DebugIdentitySchema = z.object({
  workspaceId: IdentityStringSchema,
  groupId: IdentityStringSchema,
  projectId: IdentityStringSchema,
  collectionId: IdentityStringSchema,
  folderIds: z.array(IdentityStringSchema),
  apiId: IdentityStringSchema,
}).strict();

export const DebugCaseIdentitySchema = DebugIdentitySchema.extend({
  caseId: IdentityStringSchema,
  scope: IdentityStringSchema,
}).strict();

export const DebugFieldStateSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["redacted", "truncated", "missing"]),
  needsInput: z.boolean(),
}).strict();

const DebugInvocationCommonSchema = z.object({
  locator: DebugIdentitySchema,
  environmentId: IdentityStringSchema.optional(),
  settings: RequestSettingsOverrideSchema.optional(),
  parentHistoryId: IdentityStringSchema.optional(),
});

export const DebugProjectIdentitySchema = z.object({
  workspaceId: IdentityStringSchema,
  groupId: IdentityStringSchema,
  projectId: IdentityStringSchema,
}).strict();

export const DebugHistoryOwnerIdentitySchema = z.union([
  z.object({ sourceKind: z.literal("asset"), mode: z.literal("request"), locator: DebugIdentitySchema }).strict(),
  z.object({ sourceKind: z.literal("asset"), mode: z.literal("case"), case: DebugCaseIdentitySchema }).strict(),
  z.object({ sourceKind: z.literal("free"), project: DebugProjectIdentitySchema, draftId: HistoryUuidSchema }).strict(),
]);

const DebugFreeInvocationOptionsSchema = z.object({
  environmentId: IdentityStringSchema.optional(),
  settings: RequestSettingsOverrideSchema.optional(),
  parentHistoryId: IdentityStringSchema.optional(),
});

export const DebugInvocationSchema = z.discriminatedUnion("mode", [
  DebugInvocationCommonSchema.extend({
    mode: z.literal("request"),
    request: ApiRequestSchema,
    parameters: z.record(z.string(), z.string()),
    fields: z.array(DebugFieldStateSchema),
  }).strict(),
  DebugInvocationCommonSchema.extend({
    mode: z.literal("case"),
    case: DebugCaseIdentitySchema,
  }).strict(),
  DebugFreeInvocationOptionsSchema.extend({
    mode: z.literal("free"),
    project: DebugProjectIdentitySchema,
    draftId: z.string().uuid(),
    request: ApiRequestSchema,
    parameters: z.record(z.string(), z.string()),
    fields: z.array(DebugFieldStateSchema),
  }).strict(),
]);

export type DebugIdentity = z.infer<typeof DebugIdentitySchema>;
export type DebugCaseIdentity = z.infer<typeof DebugCaseIdentitySchema>;
export type DebugProjectIdentity = z.infer<typeof DebugProjectIdentitySchema>;
export type DebugFieldState = z.infer<typeof DebugFieldStateSchema>;
export type DebugInvocation = z.infer<typeof DebugInvocationSchema>;

const PairSchema = z.tuple([z.string(), z.string()]);
const NonNegativeIntegerSchema = z.number().finite().int().nonnegative();
const NonNegativeNumberSchema = z.number().finite().nonnegative();
export const DebugSourceCategorySchema = z.enum(["project", "environment", "module", "request-override", "auth", "session", "unknown"]);
export type DebugSourceCategory = z.infer<typeof DebugSourceCategorySchema>;

const DebugCapturedFileMetadataShape = {
  metadataAvailable: z.boolean().optional(),
  capturedFilename: z.string().optional(),
  capturedSizeBytes: NonNegativeIntegerSchema.optional(),
  effectiveFilename: z.string().optional(),
};

export const DebugRequestBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("metadata"), omittedReason: z.enum(["unreliable", "budget"]).optional() }).strict(),
  z.object({ kind: z.literal("text"), text: z.string(), contentBytes: NonNegativeIntegerSchema, truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal("form"), fields: z.array(z.object({ key: z.string(), value: z.string(), truncated: z.boolean() }).strict()) }).strict(),
  z.object({
    kind: z.literal("multipart"),
    entries: z.array(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), name: z.string(), value: z.string(), truncated: z.boolean() }).strict(),
      z.object({ kind: z.literal("file"), name: z.string(), filename: z.string().optional(), contentType: z.string(), source: z.literal("local-file"), ...DebugCapturedFileMetadataShape }).strict(),
    ])),
  }).strict(),
  z.object({ kind: z.literal("binary"), contentType: z.string(), source: z.literal("local-file"), ...DebugCapturedFileMetadataShape }).strict(),
]);

export const DebugResponseBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string(), contentBytes: NonNegativeIntegerSchema, truncated: z.boolean() }).strict(),
  z.object({
    kind: z.literal("binary"),
    contentBytes: NonNegativeIntegerSchema.optional(),
    previewHex: z.string().optional(),
    truncated: z.boolean(),
    omittedReason: z.enum(["credential-match", "unreliable", "budget"]).optional(),
  }).strict(),
  z.object({
    kind: z.literal("metadata"),
    contentBytes: NonNegativeIntegerSchema.optional(),
    omittedReason: z.enum(["incomplete", "unavailable", "budget", "unreliable"]).optional(),
  }).strict(),
]);

export const DebugRequestSchema = z.object({
  url: z.string(),
  method: z.string(),
  query: z.array(z.object({ key: z.string(), value: z.string(), enabled: z.boolean() }).strict()),
  headers: z.array(PairSchema),
  cookies: z.array(PairSchema),
  body: DebugRequestBodySchema,
  sourceCategories: z.array(DebugSourceCategorySchema).max(7).optional(),
}).strict();

export const DebugResponseSchema = z.object({
  status: z.number().finite().int(),
  headers: z.array(PairSchema),
  rawHeaders: z.array(PairSchema).optional(),
  cookies: z.array(z.string()),
  contentType: z.string().optional(),
  encodedReceivedBytes: NonNegativeIntegerSchema.optional(),
  decodedReceivedBytes: NonNegativeIntegerSchema.optional(),
  declaredContentLength: NonNegativeIntegerSchema.optional(),
  completeLength: NonNegativeIntegerSchema.optional(),
  bodyComplete: z.boolean().optional(),
  body: DebugResponseBodySchema,
  requestBody: z.object({ fileBytesRead: NonNegativeIntegerSchema, transportEncodedBytesWritten: NonNegativeIntegerSchema, complete: z.boolean() }).strict().optional(),
  requestBodyChain: z.object({ fileBytesRead: NonNegativeIntegerSchema, transportEncodedBytesWritten: NonNegativeIntegerSchema, complete: z.boolean() }).strict().optional(),
}).strict();

const AssertionOutcomeSchema = z.object({ pass: z.boolean(), message: z.string() }).strict();
const OutcomeFailureSchema = z.enum(["transport", "http", "script", "assertion", "config", "aborted"]);
export const DebugOutcomeSchema = z.object({
  apiId: IdentityStringSchema.optional(),
  apiName: z.string(),
  caseId: IdentityStringSchema.optional(),
  caseName: z.string(),
  identityAvailable: z.boolean().optional(),
  row: NonNegativeIntegerSchema.optional(),
  passed: z.boolean(),
  skipped: z.boolean().optional(),
  skipReason: z.string().optional(),
  durationMs: NonNegativeNumberSchema,
  assertions: z.array(AssertionOutcomeSchema),
  error: z.string().optional(),
  failureKind: OutcomeFailureSchema.optional(),
}).strict();

export const DebugRunSummarySchema = z.object({
  collectionId: IdentityStringSchema.optional(),
  identityAvailable: z.boolean().optional(),
  collectionName: z.string(),
  envName: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  total: NonNegativeIntegerSchema,
  passed: NonNegativeIntegerSchema,
  failed: NonNegativeIntegerSchema,
  skipped: NonNegativeIntegerSchema.optional(),
  warnings: z.array(z.string()).optional(),
}).strict();

export const DebugReplayDescriptorSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("request"),
    sourceKind: z.literal("asset"),
    locator: DebugIdentitySchema.optional(),
    request: ApiRequestSchema.optional(),
    requestTemplate: ApiRequestSchema.optional(),
    parameters: z.record(z.string(), z.string()),
    fields: z.array(DebugFieldStateSchema),
    settings: RequestSettingsOverrideSchema.optional(),
    identityAvailable: z.boolean().optional(),
    available: z.boolean(),
  }).strict(),
  z.object({
    mode: z.literal("case"),
    sourceKind: z.literal("asset"),
    case: DebugCaseIdentitySchema.optional(),
    requestTemplate: ApiRequestSchema.optional(),
    parameters: z.record(z.string(), z.string()),
    fields: z.array(DebugFieldStateSchema),
    settings: RequestSettingsOverrideSchema.optional(),
    identityAvailable: z.boolean().optional(),
    available: z.boolean(),
  }).strict(),
  z.object({
    mode: z.literal("free"),
    sourceKind: z.literal("free"),
    project: DebugProjectIdentitySchema.optional(),
    draftId: HistoryUuidSchema.optional(),
    request: ApiRequestSchema.optional(),
    requestTemplate: ApiRequestSchema.optional(),
    parameters: z.record(z.string(), z.string()),
    fields: z.array(DebugFieldStateSchema),
    settings: RequestSettingsOverrideSchema.optional(),
    identityAvailable: z.boolean().optional(),
    available: z.boolean(),
  }).strict(),
]);

export const DebugExecutionSourceSchema = z.discriminatedUnion("sourceKind", [
  z.object({ sourceKind: z.literal("asset"), case: DebugCaseIdentitySchema }).strict(),
  z.object({ sourceKind: z.literal("free"), project: DebugProjectIdentitySchema, draftId: HistoryUuidSchema }).strict(),
  z.object({ sourceKind: z.literal("unavailable") }).strict(),
]);

export const DebugResultSourceSchema = z.discriminatedUnion("sourceKind", [
  z.object({
    sourceKind: z.literal("asset"),
    locator: DebugIdentitySchema,
    sourceApiRevision: z.string().min(1),
  }).strict(),
  z.object({
    sourceKind: z.literal("free"),
    project: DebugProjectIdentitySchema,
    draftId: HistoryUuidSchema,
    draftRevision: z.string().min(1),
  }).strict(),
  z.object({ sourceKind: z.literal("unavailable") }).strict(),
]);

export const DebugExchangeSchema = z.object({
  source: DebugExecutionSourceSchema,
  identityAvailable: z.boolean().optional(),
  rowIndex: NonNegativeIntegerSchema,
  hopIndex: NonNegativeIntegerSchema,
  order: z.number().finite().int().positive(),
  transportState: z.enum(["prepared", "entered", "headers-received", "responded", "failed"]),
  observation: z.enum(["http-hop", "legacy-text"]).optional(),
  settings: RequestSettingsSchema,
  request: DebugRequestSchema.optional(),
  response: DebugResponseSchema.optional(),
  intent: z.object({
    parameters: z.record(z.string(), z.string()),
    fields: z.array(DebugFieldStateSchema),
    available: z.boolean(),
  }).strict().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: NonNegativeNumberSchema.optional(),
  failureStage: z.string().optional(),
  failureCode: z.string().optional(),
}).strict();

export const DebugResultSchema = z.object({
  runId: IdentityStringSchema,
  source: DebugResultSourceSchema,
  sourceProjectRevision: z.string().min(1),
  executionSnapshotRevision: z.string().min(1),
  mode: z.enum(["request", "case", "free"]),
  identityAvailable: z.boolean().optional(),
  environmentId: IdentityStringSchema.optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  run: DebugRunSummarySchema,
  outcomes: z.array(DebugOutcomeSchema),
  exchanges: z.array(DebugExchangeSchema).max(100),
  exchangeTotal: NonNegativeIntegerSchema,
  omittedExchangeCount: NonNegativeIntegerSchema,
  replay: DebugReplayDescriptorSchema,
  console: z.array(z.object({ level: z.enum(["log", "info", "warn", "error"]), message: z.string() }).strict()),
  warnings: z.array(z.string()),
  failureKind: OutcomeFailureSchema.optional(),
  error: z.string().optional(),
  errorName: z.string().optional(),
}).strict();

// Version 1 records retain their exact original shape and are parsed read-only.
export const DebugReplayDescriptorV1Schema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("request"),
    locator: DebugIdentitySchema.optional(),
    request: ApiRequestSchema.optional(),
    requestTemplate: ApiRequestSchema.optional(),
    parameters: z.record(z.string(), z.string()),
    fields: z.array(DebugFieldStateSchema),
    settings: RequestSettingsOverrideSchema.optional(),
    identityAvailable: z.boolean().optional(),
    available: z.boolean(),
  }).strict(),
  z.object({
    mode: z.literal("case"),
    case: DebugCaseIdentitySchema.optional(),
    requestTemplate: ApiRequestSchema.optional(),
    parameters: z.record(z.string(), z.string()),
    fields: z.array(DebugFieldStateSchema),
    settings: RequestSettingsOverrideSchema.optional(),
    identityAvailable: z.boolean().optional(),
    available: z.boolean(),
  }).strict(),
]);

export const DebugExchangeV1Schema = z.object({
  case: DebugCaseIdentitySchema.optional(),
  identityAvailable: z.boolean().optional(),
  rowIndex: NonNegativeIntegerSchema,
  hopIndex: NonNegativeIntegerSchema,
  order: z.number().finite().int().positive(),
  transportState: z.enum(["prepared", "entered", "headers-received", "responded", "failed"]),
  observation: z.enum(["http-hop", "legacy-text"]).optional(),
  settings: RequestSettingsSchema,
  request: DebugRequestSchema.optional(),
  response: DebugResponseSchema.optional(),
  intent: z.object({
    parameters: z.record(z.string(), z.string()),
    fields: z.array(DebugFieldStateSchema),
    available: z.boolean(),
  }).strict().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: NonNegativeNumberSchema.optional(),
  failureStage: z.string().optional(),
  failureCode: z.string().optional(),
}).strict();

export const DebugResultV1Schema = z.object({
  runId: IdentityStringSchema,
  sourceApiRevision: z.string().min(1),
  sourceProjectRevision: z.string().min(1),
  executionSnapshotRevision: z.string().min(1),
  mode: z.enum(["request", "case"]),
  locator: DebugIdentitySchema.optional(),
  identityAvailable: z.boolean().optional(),
  environmentId: IdentityStringSchema.optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  run: DebugRunSummarySchema,
  outcomes: z.array(DebugOutcomeSchema),
  exchanges: z.array(DebugExchangeV1Schema).max(100),
  exchangeTotal: NonNegativeIntegerSchema,
  omittedExchangeCount: NonNegativeIntegerSchema,
  replay: DebugReplayDescriptorV1Schema,
  console: z.array(z.object({ level: z.enum(["log", "info", "warn", "error"]), message: z.string() }).strict()),
  warnings: z.array(z.string()),
  failureKind: OutcomeFailureSchema.optional(),
  error: z.string().optional(),
  errorName: z.string().optional(),
}).strict();

export const DebugHistoryPreferencesSchema = z.object({
  enabled: z.boolean(),
  retentionDays: z.number().finite().int().positive(),
  maxRecords: z.number().finite().int().positive().max(10_000),
}).strict();

export const DebugHistoryRecordV1Schema = z.object({
  formatVersion: z.literal(1),
  historyId: HistoryUuidSchema,
  createdAt: z.string().datetime(),
  parentHistoryId: HistoryUuidSchema.optional(),
  result: DebugResultV1Schema,
}).strict();

export const DebugHistoryRecordV2Schema = z.object({
  formatVersion: z.literal(2),
  historyId: HistoryUuidSchema,
  createdAt: z.string().datetime(),
  parentHistoryId: HistoryUuidSchema.optional(),
  result: DebugResultSchema,
}).strict();

export const DebugHistoryRecordSchema = z.discriminatedUnion("formatVersion", [
  DebugHistoryRecordV1Schema,
  DebugHistoryRecordV2Schema,
]);

export const DebugHistoryResultFilterSchema = z.enum(["passed", "failed", "aborted"]);

export const DebugHistorySummarySchema = z.object({
  historyId: HistoryUuidSchema,
  createdAt: z.string().datetime(),
  parentHistoryId: HistoryUuidSchema.optional(),
  runId: IdentityStringSchema,
  mode: z.enum(["request", "case", "free"]),
  sourceKind: z.enum(["asset", "free", "unavailable"]),
  result: DebugHistoryResultFilterSchema,
  workspaceId: IdentityStringSchema.optional(),
  groupId: IdentityStringSchema.optional(),
  projectId: IdentityStringSchema.optional(),
  draftId: HistoryUuidSchema.optional(),
  collectionId: IdentityStringSchema.optional(),
  apiId: IdentityStringSchema.optional(),
  caseId: IdentityStringSchema.optional(),
  collectionName: z.string().optional(),
  apiName: z.string().optional(),
  method: z.string().optional(),
  total: NonNegativeIntegerSchema,
  passed: NonNegativeIntegerSchema,
  failed: NonNegativeIntegerSchema,
  exchangeTotal: NonNegativeIntegerSchema,
  searchText: z.string().max(16_384),
}).strict();

export const DebugHistoryListFilterSchema = z.object({
  sourceKind: z.enum(["asset", "free", "unavailable"]).optional(),
  projectId: IdentityStringSchema.optional(),
  apiId: IdentityStringSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  method: z.string().min(1).max(128).optional(),
  result: DebugHistoryResultFilterSchema.optional(),
  text: z.string().max(512).optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().max(10_000).default(0),
}).strict();

export const DebugHistoryDiagnosticSchema = z.object({
  code: z.enum([
    "corrupt-record",
    "future-version",
    "oversized-record",
    "unreadable-record",
    "invalid-config",
    "summary-rebuilt",
    "storage-failure",
    "scan-limit",
  ]),
  historyId: HistoryUuidSchema.optional(),
  message: z.string(),
}).strict();

export const DebugHistoryPageSchema = z.object({
  items: z.array(DebugHistorySummarySchema).max(200),
  nextOffset: z.number().int().nonnegative().optional(),
  diagnostics: z.array(DebugHistoryDiagnosticSchema),
}).strict();

export const DebugHistoryReadResultSchema = z.object({
  record: DebugHistoryRecordSchema.nullable(),
  diagnostics: z.array(DebugHistoryDiagnosticSchema),
}).strict();

export type DebugRequestBody = z.infer<typeof DebugRequestBodySchema>;
export type DebugResponseBody = z.infer<typeof DebugResponseBodySchema>;
export type DebugRequest = z.infer<typeof DebugRequestSchema>;
export type DebugResponse = z.infer<typeof DebugResponseSchema>;
export type DebugOutcome = z.infer<typeof DebugOutcomeSchema>;
export type DebugRunSummary = z.infer<typeof DebugRunSummarySchema>;
export type DebugReplayDescriptor = z.infer<typeof DebugReplayDescriptorSchema>;
export type DebugReplayDescriptorV1 = z.infer<typeof DebugReplayDescriptorV1Schema>;
export type DebugExchange = z.infer<typeof DebugExchangeSchema>;
export type DebugResult = z.infer<typeof DebugResultSchema>;
export type DebugResultV1 = z.infer<typeof DebugResultV1Schema>;
export type DebugExecutionSource = z.infer<typeof DebugExecutionSourceSchema>;
export type DebugResultSource = z.infer<typeof DebugResultSourceSchema>;
export type DebugHistoryPreferences = z.infer<typeof DebugHistoryPreferencesSchema>;
export type DebugHistoryRecord = z.infer<typeof DebugHistoryRecordSchema>;
export type DebugHistoryResultFilter = z.infer<typeof DebugHistoryResultFilterSchema>;
export type DebugHistorySummary = z.infer<typeof DebugHistorySummarySchema>;
export type DebugHistoryListFilter = z.input<typeof DebugHistoryListFilterSchema>;
export type DebugHistoryDiagnostic = z.infer<typeof DebugHistoryDiagnosticSchema>;
export type DebugHistoryPage = z.infer<typeof DebugHistoryPageSchema>;
export type DebugHistoryReadResult = z.infer<typeof DebugHistoryReadResultSchema>;

export type DebugHistoryOwnerIdentity = z.infer<typeof DebugHistoryOwnerIdentitySchema>;

export interface DebugExecutionObservation {
  rowIndex: number;
  settings: RequestSettings;
  parameters?: Readonly<Record<string, string>>;
  fields?: readonly DebugFieldState[];
  sourceCategories?: readonly DebugSourceCategory[];
}

export type DebugExecutionIdentity = DebugExecutionObservation & (
  | { source: { sourceKind: "asset"; case: DebugCaseIdentity } }
  | { source: { sourceKind: "free"; project: DebugProjectIdentity; draftId: string } }
);

export type DebugRequestOverride = RequestSettingsOverride;
export type DebugRequestValue = ApiRequest;
export type DebugFailureKind = CaseFailureKind;
