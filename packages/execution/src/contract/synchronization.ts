import { z } from "zod";
import {
  SyncSourceSchema, SyncPolicySchema, SyncEffectivePolicySchema, SyncDeploymentLimitsSchema, SyncStampSchema,
  SyncUpstreamSchema, SyncIdentityMapSchema, SyncCandidateSchema, SyncCandidateViewSchema, SyncDecisionsSchema,
  SyncResolvedPlanSchema, SyncReceiptSchema, SyncHistoryEntrySchema, SourceReadInputSchema, SourceReadResultSchema,
  SyncNormalizeInputSchema, SyncNormalizedSourceSchema, SyncPlanInputSchema, SyncResolveInputSchema, SyncRollbackInputSchema,
  SyncRevisionSchema, SyncHashSchema, SyncFixedDetailRequestSchema, SyncFixedDetailSchema,
} from "@apicc/core/sync/shared";

export * from "@apicc/core/sync/shared";
/** One finite vocabulary shared by private RPC validation and durable public source diagnostics. */
export const syncErrorCodeValues = [
  "SYNC_HOST_UNAVAILABLE", "SYNC_HOST_CONFIG_INVALID", "SYNC_BUSY", "SYNC_CONTEXT_STALE", "SYNC_NETWORK_SNAPSHOT_INVALID", "SYNC_NETWORK_DENIED", "SYNC_NETWORK_FAILED", "SYNC_PROXY_UNSUPPORTED", "SYNC_TLS_FAILED", "SYNC_TLS_POLICY_INVALID",
  "SYNC_CACHE_MISS", "SYNC_CANCELLED", "SYNC_DEADLINE", "SYNC_CONNECT_TIMEOUT", "SYNC_CONTENT_HANDOFF_FAILED", "SYNC_CONTENT_DIGEST_MISMATCH", "SYNC_CONTENT_BYTES_MISMATCH", "SYNC_CONTENT_REFERENCE_MISMATCH", "SYNC_CONTENT_NONCANONICAL",
  "SYNC_MATERIAL_INVALID", "SYNC_MATERIAL_MISSING", "SYNC_MATERIAL_RELEASE_FAILED", "SYNC_ENCODING_INVALID", "SYNC_ENCODING_UNSUPPORTED", "SYNC_HTTP_STATUS", "SYNC_READ_FAILED", "SYNC_REDIRECT_INVALID", "SYNC_REDIRECT_LIMIT", "SYNC_SOURCE_TOO_LARGE",
  "SYNC_INPUT_INVALID", "SYNC_INVALID_FILES", "SYNC_STAMP_MISMATCH", "SYNC_SOURCE_MODULE_MISMATCH", "SYNC_COMPARE_INPUT_BYTES_EXCEEDED", "SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED", "SYNC_CANDIDATE_MISMATCH", "SYNC_CROSS_SOURCE_OWNERSHIP", "SYNC_PROTECTED_REFERENCE", "SYNC_PROTECTED_LOCAL_ASSET", "SYNC_DIAGNOSTICS_BLOCKED",
  "SYNC_DECISION_DUPLICATE", "SYNC_DECISION_REQUIRED", "SYNC_DECISION_UNKNOWN", "SYNC_MAPPING_DECISION_INVALID", "SYNC_MAPPING_DECISION_REQUIRED", "SYNC_MAPPING_KIND_MISMATCH", "SYNC_MAPPING_PARENT_MISMATCH", "SYNC_MAPPING_PARENT_NOT_SELECTED", "SYNC_MAPPING_TARGET_ACTIVE", "SYNC_MAPPING_TARGET_AMBIGUOUS", "SYNC_MAPPING_TARGET_DUPLICATE", "SYNC_MAPPING_TARGET_UNAVAILABLE",
  "SYNC_ROLLBACK_CONTENT_MISMATCH", "SYNC_ROLLBACK_CURRENT_CHANGED", "SYNC_ROLLBACK_HISTORY_MISMATCH", "SYNC_ROLLBACK_STAMP_MISMATCH",
  "SYNC_GIT_UNAVAILABLE", "SYNC_GIT_AUTH_FAILED", "SYNC_GIT_CAPABILITY_UNSUPPORTED", "SYNC_GIT_DISK_LIMIT", "SYNC_GIT_LFS_UNSUPPORTED", "SYNC_GIT_OBJECT_INVALID", "SYNC_GIT_PATH_NOT_FOUND", "SYNC_GIT_READ_FAILED", "SYNC_GIT_REF_NOT_FOUND",
  "SYNC_PROCESS_UNCOLLECTED", "SYNC_PROCESS_HELPER_INVALID", "SYNC_PROCESS_HELPER_UNAVAILABLE", "SYNC_PROCESS_INPUT_LIMIT", "SYNC_PROCESS_OUTPUT_LIMIT", "SYNC_PROCESS_START_FAILED", "SYNC_INTERRUPTED", "SYNC_DISK_MONITOR_FAILED", "SYNC_TOOL_CONFIG_INVALID", "SYNC_TOOL_UNAVAILABLE", "SYNC_SSH_AUTH_FAILED", "SYNC_SSH_CAPABILITY_UNSUPPORTED", "SYNC_SSH_ROUTE_UNAVAILABLE", "SYNC_HOST_KEY_MISMATCH",
] as const;
const writeBase = { formatVersion: z.literal(1), intentId: z.string().uuid(), expectedSourceRevision: SyncRevisionSchema, expectedAssetVersion: SyncRevisionSchema };
export const SyncSourceSaveInputSchema = z.object({ ...writeBase, source: SyncSourceSchema }).strict();
export const SyncPolicySaveInputSchema = z.object({ formatVersion: z.literal(1), intentId: z.string().uuid(), expectedRevision: SyncRevisionSchema, policy: SyncPolicySchema }).strict();
export const SyncApplicationInputSchema = z.object({ ...writeBase, sourceId: z.string().uuid(), candidateId: z.string().uuid(), candidateDigest: SyncHashSchema, decisions: SyncDecisionsSchema, decisionsDigest: SyncHashSchema }).strict();
export const SyncRollbackRequestSchema = z.object({ ...writeBase, sourceId: z.string().uuid(), historyId: z.string().uuid() }).strict();
export const SyncCheckRequestSchema = z.object(writeBase).strict();
export const SyncCheckAcceptedSchema = z.object({ formatVersion: z.literal(1), checkId: z.string().uuid() }).strict();
export const SyncCheckCancelRequestSchema = z.object({}).strict();
export const SyncCheckStatusSchema = z.object({ formatVersion: z.literal(1), checkId: z.string().uuid(), sourceId: z.string().uuid(),
  state: z.enum(["queued", "running", "waiting", "cancelling", "cancelled", "lost", "succeeded", "failed"]),
  candidateId: z.string().uuid().nullable(), createdAtMs: z.number().int().nonnegative(),
  completedAtMs: z.number().int().nonnegative().nullable(),
  detailCode: z.enum(syncErrorCodeValues).nullable().optional(),
  reasonCode: z.enum(["project-assets-changed", "source-revision-changed", "authorization-changed", "policy-changed", "storage-limit", "material-changed", "material-invalid", "source-busy", "source-read-failed", "comparison-failed", "deadline-exceeded", "runtime-unavailable", "runtime-uncertain", "server-restarted", "cancel-requested", "cancelled"]).nullable(),
}).strict();
export const SyncCheckLookupSchema = z.object({ formatVersion: z.literal(1), sourceId: z.string().uuid(), current: SyncCheckStatusSchema.nullable(), latestAttempt: SyncCheckStatusSchema.nullable(), latestSuccess: SyncCheckStatusSchema.nullable() }).strict();
/** Explicit stored credential codecs. Native paths and caller-selected lease/revision identities have no fields. */
export const SyncHeaderCredentialSchema = z.object({ formatVersion: z.literal(1), kind: z.literal("http-headers"), headers: z.array(z.object({ name: z.string(), value: z.string() }).strict()) }).strict();
const profileTLS = z.object({ caPems: z.array(z.string()), clientCertPems: z.array(z.string()), clientKeyPem: z.string().optional(), clientKeyPassphrase: z.string().optional() }).strict();
const profileBase = { name: z.string(), targetTlsBindings: z.array(z.object({ origin: z.string(), tls: profileTLS }).strict()) };
export const SyncNetworkCredentialSchema = z.object({ formatVersion: z.literal(1), kind: z.literal("network-profile"), profile: z.discriminatedUnion("kind", [
  z.object({ ...profileBase, kind: z.literal("direct") }).strict(),
  z.object({ ...profileBase, kind: z.literal("proxy"), proxyUrl: z.string(), username: z.string().optional(), password: z.string().optional(), proxyTLS: profileTLS.optional() }).strict(),
]) }).strict();
export const syncWireSchemas = {
  source: SyncSourceSchema, policy: SyncPolicySchema, effectivePolicy: SyncEffectivePolicySchema, deploymentLimits: SyncDeploymentLimitsSchema,
  stamp: SyncStampSchema, upstream: SyncUpstreamSchema, mapping: SyncIdentityMapSchema, candidate: SyncCandidateSchema,
  candidateView: SyncCandidateViewSchema, decisions: SyncDecisionsSchema, resolvedPlan: SyncResolvedPlanSchema,
  receipt: SyncReceiptSchema, history: SyncHistoryEntrySchema, sourceReadInput: SourceReadInputSchema, sourceReadResult: SourceReadResultSchema,
  normalizeInput: SyncNormalizeInputSchema, normalizedSource: SyncNormalizedSourceSchema, planInput: SyncPlanInputSchema,
  resolveInput: SyncResolveInputSchema, rollbackInput: SyncRollbackInputSchema,
  sourceSave: SyncSourceSaveInputSchema, policySave: SyncPolicySaveInputSchema, application: SyncApplicationInputSchema, rollback: SyncRollbackRequestSchema,
  checkRequest: SyncCheckRequestSchema, checkAccepted: SyncCheckAcceptedSchema, checkStatus: SyncCheckStatusSchema, checkLookup: SyncCheckLookupSchema,
  checkCancelRequest: SyncCheckCancelRequestSchema,
  fixedDetailRequest: SyncFixedDetailRequestSchema, fixedDetail: SyncFixedDetailSchema,
  headerCredential: SyncHeaderCredentialSchema, networkCredential: SyncNetworkCredentialSchema,
};
export type SyncSourceSaveInput = z.output<typeof SyncSourceSaveInputSchema>;
export type SyncPolicySaveInput = z.output<typeof SyncPolicySaveInputSchema>;
export type SyncApplicationInput = z.output<typeof SyncApplicationInputSchema>;
export type SyncRollbackRequest = z.output<typeof SyncRollbackRequestSchema>;
export type SyncCheckRequest = z.output<typeof SyncCheckRequestSchema>;
export type SyncCheckAccepted = z.output<typeof SyncCheckAcceptedSchema>;
export type SyncCheckCancelRequest = z.output<typeof SyncCheckCancelRequestSchema>;
export type SyncCheckStatus = z.output<typeof SyncCheckStatusSchema>;
export type SyncCheckLookup = z.output<typeof SyncCheckLookupSchema>;
export type SyncHeaderCredential = z.output<typeof SyncHeaderCredentialSchema>;
export type SyncNetworkCredential = z.output<typeof SyncNetworkCredentialSchema>;
