import { z } from "zod";

const MiB = 1024 * 1024;
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
export const SyncRevisionSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
export const SyncHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const materialRef = z.string().min(1);
// One wire-expressible syntax grammar for every source variant. Numeric hosts use
// canonical four-octet IPv4; legacy shorthand/octal/hex spellings are unsupported.
// Address reachability and trust remain source-host responsibilities.
const octet = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const ipv4 = `${octet}(?:\\.${octet}){3}`;
const hextet = "[a-fA-F0-9]{1,4}";
const hexSequence = (count: number) => count === 0 ? "" : `${hextet}(?::${hextet}){${count - 1}}`;
const ipv6 = [
  hexSequence(8), `${hexSequence(6)}:${ipv4}`,
  ...Array.from({ length: 8 }, (_, left) => {
    const rightMax = 7 - left; // :: must replace at least one of eight groups.
    return `${hexSequence(left)}::${rightMax === 0 ? "" : `(?:${hextet}(?::${hextet}){0,${rightMax - 1}})?`}`;
  }),
  ...Array.from({ length: 6 }, (_, left) => `${hexSequence(left)}::(?:${hextet}:){0,${5 - left}}${ipv4}`),
].join("|");
const dnsLabel = "[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?";
// WHATWG special URLs interpret a numeric final label as IPv4, not as DNS.
const dnsHost = `(?!(?:${dnsLabel}\\.)*(?:[0-9]+|0[xX][0-9a-fA-F]*)(?=[:/?]|$))${dnsLabel}(?:\\.${dnsLabel})*`;
const host = `(?:\\[(?:${ipv6})\\]|${ipv4}|${dnsHost})`;
const port = "(?:[0-5]?[0-9]{1,4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
const authority = `${host}(?::${port})?`;
const httpUrl = z.string().regex(new RegExp(`^https?://${authority}(?:[/?][^\\s#]*)?$`));
const httpsUrl = z.string().regex(new RegExp(`^https://${authority}(?:[/?][^\\s#]*)?$`));
const sshUrl = z.string().regex(new RegExp(`^ssh://(?:[a-zA-Z0-9._-]+@)?${authority}/[^\\s#?]+$`));
export const SyncRelativePathSchema = z.string().regex(/^(?!.*(?:^|\/)(?:\.|\.\.)(?:\/|$))[^\/\\:\u0000-\u001f]+(?:\/[^\/\\:\u0000-\u001f]+)*$/);
const gitRef = z.string().regex(/^(?!-)(?!.*\.\.)(?!.*[\u0000-\u0020~^:?*\[\\])(?!.*(?:\/\.|\.lock(?:\/|$)))(?!.*(?:\/\/|@\{))[^/]+(?:\/[^/]+)*$/);
export const SyncCronRuleSchema = z.object({
  kind: z.literal("cron"), expression: z.string().max(512).regex(/^\S+(?:[ \t]+\S+){5}$/),
  timeZone: z.string().min(1).max(128), dstOverlap: z.enum(["first", "both"]),
}).strict();
export const SyncScheduleSchema = z.object({ enabled: z.boolean(), rule: SyncCronRuleSchema }).strict();
const sourceBase = {
  formatVersion: z.literal(1), id: z.string().uuid(), revision: SyncRevisionSchema, moduleId: z.string().uuid(),
  networkProfileRef: materialRef.optional(),
  schedule: SyncScheduleSchema.default((): z.output<typeof SyncScheduleSchema> => ({ enabled: false, rule: { kind: "cron", expression: "0 0 * * * *", timeZone: "UTC", dstOverlap: "first" } })),
};
export const SyncSourceSchema = z.discriminatedUnion("kind", [
  z.object({ ...sourceBase, kind: z.literal("url"), url: httpUrl, authRef: materialRef.optional() }).strict(),
  z.object({ ...sourceBase, kind: z.literal("git-https"), repositoryUrl: httpsUrl, ref: gitRef, filePath: SyncRelativePathSchema, authRef: materialRef.optional() }).strict(),
  z.object({ ...sourceBase, kind: z.literal("git-ssh"), repositoryUrl: sshUrl, ref: gitRef, filePath: SyncRelativePathSchema, privateKeyRef: materialRef, knownHostsRef: materialRef, passphraseRef: materialRef.optional() }).strict(),
]);

const policyDefaultsSchema = z.object({
  connectTimeoutMs: integer(1000, 60000).default(10000), urlDeadlineMs: integer(5000, 600000).default(60000), gitDeadlineMs: integer(10000, 1800000).default(120000),
  maxAttempts: integer(1, 3).default(1), maxSourceBytes: integer(65536, 16 * MiB).default(5 * MiB),
  maxCompareInputBytes: integer(MiB, 64 * MiB).default(16 * MiB), maxCompareOutputBytes: integer(256 * 1024, 32 * MiB).default(8 * MiB),
  maxNormalizeDepth: integer(16, 256).default(128), maxNormalizeNodes: integer(1000, 1000000).default(100000),
  gitDiskThresholdBytes: integer(32 * MiB, 2 * 1024 * MiB).default(256 * MiB),
  projectConcurrency: integer(1, 4).default(1), hostConcurrency: integer(1, 16).default(4),
  candidateTtlMs: integer(300000, 604800000).default(86400000), historyRetentionDays: integer(1, 365).default(30), historyMaxEntries: integer(1, 1000).default(100),
}).strict();
export const defaultSyncPolicyValues = Object.freeze(policyDefaultsSchema.parse({}));
const valueFields = Object.fromEntries(Object.entries(policyDefaultsSchema.shape).map(([key, schema]) => [key, schema.removeDefault()])) as {
  [K in keyof typeof policyDefaultsSchema.shape]: ReturnType<(typeof policyDefaultsSchema.shape)[K]["removeDefault"]>;
};
export const SyncPolicyValuesSchema = z.object(valueFields).strict();
const overrideFields = SyncPolicyValuesSchema.partial().shape;
/** Saved overrides preserve omission. Scope is provenance metadata, never authorization. */
export const SyncPolicySchema = z.object({
  formatVersion: z.literal(1), revision: SyncRevisionSchema, scope: z.enum(["workspace", "project"]), ...overrideFields,
}).strict();
export const SyncDeploymentLimitsSchema = z.object({ maxWireBytes: z.number().int().positive(), envelopeReserveBytes: z.number().int().nonnegative() }).strict();
export const SyncEffectivePolicySchema = z.object({
  policy: SyncPolicyValuesSchema, savedRevision: SyncRevisionSchema, deploymentLimits: SyncDeploymentLimitsSchema,
  sources: z.record(SyncPolicyValuesSchema.keyof(), z.enum(["default", "deployment", "workspace", "project"])), appliesTo: z.literal("next-check"),
}).strict();
const stampBase = {
  formatVersion: z.literal(1), projectId: z.string().uuid(), definitionRevision: SyncHashSchema,
  sourceRevision: SyncRevisionSchema, mappingRevision: SyncRevisionSchema, baselineRevision: SyncRevisionSchema,
  authorizationGeneration: SyncRevisionSchema, coreBuildId: SyncHashSchema,
};
export const SyncStampSchema = z.discriminatedUnion("kind", [
  z.object({ ...stampBase, kind: z.literal("local") }).strict(),
  z.object({ ...stampBase, kind: z.literal("online"), assetVersion: SyncRevisionSchema }).strict(),
]);
export const SyncUpstreamSchema = z.union([
  z.object({ kind: z.literal("url"), finalUrl: httpUrl, rawSha256: SyncHashSchema }).strict(),
  z.object({ kind: z.literal("git"), objectFormat: z.literal("sha1"), commitOid: z.string().regex(/^[a-f0-9]{40}$/), blobOid: z.string().regex(/^[a-f0-9]{40}$/), rawSha256: SyncHashSchema }).strict(),
  z.object({ kind: z.literal("git"), objectFormat: z.literal("sha256"), commitOid: SyncHashSchema, blobOid: SyncHashSchema, rawSha256: SyncHashSchema }).strict(),
]);

export const SyncEntityKindSchema = z.enum(["module", "folder", "api", "model", "component", "parameter", "response", "example", "case", "schema-property"]);
const identityEntry = z.object({
  entityKind: SyncEntityKindSchema, externalKey: z.string().min(1), entityId: z.string().uuid(), ownerExternalKey: z.string().min(1),
  aliases: z.array(z.string().min(1)), ownership: z.enum(["source", "local"]), correspondence: z.enum(["confirmed", "manual"]),
}).strict();
export const SyncIdentityMapSchema = z.object({
  formatVersion: z.literal(1), sourceId: z.string().uuid(), namespace: z.string().min(1), revision: SyncRevisionSchema,
  algorithm: z.literal("apicc-sync-id-v1"), entries: z.array(identityEntry),
}).strict();
export const SyncFileSchema = z.object({ path: SyncRelativePathSchema, content: z.string() }).strict();
const files = z.array(SyncFileSchema);
export const SyncDiagnosticSchema = z.object({
  code: z.string().min(1), severity: z.enum(["info", "warning", "error"]), ownerId: z.string().uuid(), path: z.string(), message: z.string(),
}).strict();
const diagnostics = z.array(SyncDiagnosticSchema);
const count = z.number().int().nonnegative();
export const SyncSummarySchema = z.object({ added: count, updated: count, removed: count, conflicts: count }).strict();
export type SyncSummaryScalarValue = string | number | boolean | null;
export interface SyncSummaryAttribute { label: "name" | "description" | "method" | "path" | "status" | "location" | "type" | "reference" | "parameters" | "responses" | "examples" | "properties" | "property" | "required" | "value" | "items" | "apis"; name?: string; value: SyncSummaryScalarValue; truncated: boolean }
export interface SyncSummaryScalar { kind: "scalar"; value: SyncSummaryScalarValue; truncated: boolean }
export interface SyncSummaryStructure { kind: "structure"; entityKind: SyncEntityKind | null; attributes: SyncSummaryAttribute[]; truncated: boolean }
export type SyncSummaryItem = SyncSummaryScalar | SyncSummaryStructure | {kind:"array";count:number};
export type SyncValueSummary = {kind:"absent"} | SyncSummaryScalar | SyncSummaryStructure | {kind:"array";count:number;items:SyncSummaryItem[];truncated:boolean};
export interface SyncChangeSummaries { baseline: SyncValueSummary; current: SyncValueSummary; source: SyncValueSummary }
const summaryScalarValue = z.union([z.string().max(240),z.number().finite(),z.boolean(),z.null()]);
const summaryAttribute = z.object({
  label:z.enum(["name","description","method","path","status","location","type","reference","parameters","responses","examples","properties","property","required","value","items","apis"]),
  name:z.string().max(80).optional(),value:summaryScalarValue,truncated:z.boolean(),
}).strict();
const summaryScalar = z.object({kind:z.literal("scalar"),value:summaryScalarValue,truncated:z.boolean()}).strict();
const summaryStructure = z.object({kind:z.literal("structure"),entityKind:SyncEntityKindSchema.nullable(),attributes:z.array(summaryAttribute).max(8),truncated:z.boolean()}).strict();
const summaryArrayItem = z.object({kind:z.literal("array"),count}).strict();
export const SyncValueSummarySchema: z.ZodType<SyncValueSummary> = z.discriminatedUnion("kind",[
  z.object({kind:z.literal("absent")}).strict(),summaryScalar,summaryStructure,
  z.object({kind:z.literal("array"),count,items:z.array(z.discriminatedUnion("kind",[summaryScalar,summaryStructure,summaryArrayItem])).max(5),truncated:z.boolean()}).strict(),
]);
export const SyncChangeSummariesSchema = z.object({baseline:SyncValueSummarySchema,current:SyncValueSummarySchema,source:SyncValueSummarySchema}).strict();
export const SyncChangeSchema = z.object({
  changeId: SyncHashSchema, entityKind: SyncEntityKindSchema, externalKey: z.string().min(1), entityId: z.string().uuid(),
  layer: z.enum(["contract", "documentation", "cases", "models", "components", "structure"]), operation: z.enum(["add", "update", "remove"]),
  path: SyncRelativePathSchema, fieldPath: z.string().regex(/^(?:\/(?:[^~]|~[01])*)?$/), label: z.string(), beforeDigest: SyncHashSchema.nullable(), afterDigest: SyncHashSchema.nullable(),
  summaries: SyncChangeSummariesSchema,
}).strict();
const conflict = z.object({
  changeId: SyncHashSchema, reasonCode: z.enum(["both-modified", "source-deleted-local-modified", "identity-ambiguous", "protected-reference", "unsupported-source"]),
  message: z.string(), currentSummary: z.string(), sourceSummary: z.string(),
}).strict();
const referenceImpact = z.object({
  changeId: SyncHashSchema, ownerId: z.string().uuid(), targetId: z.string().uuid(), path: z.string(),
  reasonCode: z.enum(["protected-reference", "missing-target", "source-deletion"]), protected: z.boolean(),
}).strict();
export const SyncCandidateSchema = z.object({
  formatVersion: z.literal(1), id: z.string().uuid(), sourceId: z.string().uuid(), stamp: SyncStampSchema, upstream: SyncUpstreamSchema,
  candidateDigest: SyncHashSchema, summary: SyncSummarySchema, diagnostics, changes: z.array(SyncChangeSchema), conflicts: z.array(conflict), referenceImpacts: z.array(referenceImpact),
}).strict();
export const SyncCandidateViewSchema = z.object({
  candidate: SyncCandidateSchema, applicable: z.boolean(),
  reasonCode: z.enum(["source-revision-changed", "project-assets-changed", "mapping-revision-changed", "baseline-revision-changed", "authorization-changed", "core-identity-changed", "candidate-expired", "source-disabled", "unresolved-conflicts"]).nullable(),
}).strict();
const decisionBase = { changeId: SyncHashSchema };
export const SyncDecisionsSchema = z.object({
  formatVersion: z.literal(1), candidateDigest: SyncHashSchema, entries: z.array(z.discriminatedUnion("decision", [
    z.object({ ...decisionBase, decision: z.literal("take-source") }).strict(),
    z.object({ ...decisionBase, decision: z.literal("keep-current") }).strict(),
    z.object({ ...decisionBase, decision: z.literal("map-existing"), existingEntityId: z.string().uuid() }).strict(),
  ])),
}).strict();
const digestSummary = z.object({ definitionRevision: SyncHashSchema, manifestDigest: SyncHashSchema }).strict();
export const SyncResolvedPlanSchema = z.object({
  formatVersion: z.literal(1), candidateDigest: SyncHashSchema, decisionsDigest: SyncHashSchema, stamp: SyncStampSchema,
  writes: files, deletions: z.array(SyncRelativePathSchema), baselineFiles: files, mapping: SyncIdentityMapSchema, before: digestSummary, after: digestSummary,
}).strict();
const actor = z.object({ id: z.string().min(1), name: z.string() }).strict();
const operationKind = z.enum(["apply", "rollback"]);
export const SyncContentRefSchema = z.object({
  digest: SyncHashSchema, bytes: count, contentType: z.literal("application/vnd.apicc.sync-files+json"),
}).strict();
export const SyncReceiptSchema = z.object({
  formatVersion: z.literal(1), operationId: z.string().uuid(), intentId: z.string().uuid(), kind: operationKind, status: z.literal("committed"),
  historyId: z.string().uuid(), sourceId: z.string().uuid(), projectId: z.string().uuid(), afterStamp: SyncStampSchema,
  actor, completedAtMs: count, integritySha256: SyncHashSchema,
}).strict();
export const SyncHistoryEntrySchema = z.object({
  formatVersion: z.literal(1), id: z.string().uuid(), sourceId: z.string().uuid(), projectId: z.string().uuid(), intentId: z.string().uuid(),
  operationKind, actor, createdAtMs: count, beforeStamp: SyncStampSchema, afterStamp: SyncStampSchema, upstream: SyncUpstreamSchema,
  before: digestSummary, after: digestSummary, rollback: z.object({ beforeContent: SyncContentRefSchema, afterContent: SyncContentRefSchema }).strict(), integritySha256: SyncHashSchema,
}).strict();
const sourceReadBudget = z.object({
  connectTimeoutMs: SyncPolicyValuesSchema.shape.connectTimeoutMs, maxAttempts: SyncPolicyValuesSchema.shape.maxAttempts,
  maxSourceBytes: SyncPolicyValuesSchema.shape.maxSourceBytes, gitDiskThresholdBytes: SyncPolicyValuesSchema.shape.gitDiskThresholdBytes,
}).strict();
export const SourceReadInputSchema = z.object({
  formatVersion: z.literal(1), source: SyncSourceSchema, deadlineAtMs: z.number().int().positive(), budget: sourceReadBudget,
}).strict();
export const SourceReadResultSchema = z.discriminatedUnion("status", [
  z.object({ formatVersion: z.literal(1), status: z.literal("read"), upstream: SyncUpstreamSchema, rawText: z.string(), diagnostics }).strict(),
  z.object({ formatVersion: z.literal(1), status: z.literal("not-modified"), upstream: SyncUpstreamSchema, diagnostics }).strict(),
]);
const compareBudget = z.object({
  maxCompareInputBytes: SyncPolicyValuesSchema.shape.maxCompareInputBytes, maxCompareOutputBytes: SyncPolicyValuesSchema.shape.maxCompareOutputBytes,
}).strict();
export const SyncNormalizeInputSchema = z.object({
  rawText: z.string(), source: SyncSourceSchema, mapping: SyncIdentityMapSchema, allocationSeed: z.literal("apicc-sync-id-v1"),
  budget: z.object({ maxSourceBytes: SyncPolicyValuesSchema.shape.maxSourceBytes, maxCompareInputBytes: SyncPolicyValuesSchema.shape.maxCompareInputBytes, maxNormalizeDepth: SyncPolicyValuesSchema.shape.maxNormalizeDepth, maxNormalizeNodes: SyncPolicyValuesSchema.shape.maxNormalizeNodes }).strict(),
}).strict();
export const SyncNormalizedSourceSchema = z.object({
  files, mapping: SyncIdentityMapSchema, entityIds: z.array(z.object({ entityKind: SyncEntityKindSchema, externalKey: z.string().min(1), entityId: z.string().uuid() }).strict()), manifestDigest: SyncHashSchema, diagnostics,
}).strict();
export const SyncPlanInputSchema = z.object({
  source: SyncSourceSchema, stamp: SyncStampSchema, upstream: SyncUpstreamSchema, mapping: SyncIdentityMapSchema, baselineFiles: files, localFiles: files, remoteFiles: files, budget: compareBudget,
  normalizationDiagnostics: diagnostics, otherSourceMappings: z.array(SyncIdentityMapSchema),
}).strict();
export const SyncResolveInputSchema = z.object({ candidate: SyncCandidateSchema, decisions: SyncDecisionsSchema, planInput: SyncPlanInputSchema }).strict();
export const SyncRollbackInputSchema = z.object({
  history: SyncHistoryEntrySchema, currentFiles: files, currentStamp: SyncStampSchema,
  beforeFiles: files, afterFiles: files, mapping: SyncIdentityMapSchema, baselineFiles: files,
  otherSourceMappings: z.array(SyncIdentityMapSchema), budget: compareBudget,
}).strict();

export type SyncSchedule = z.output<typeof SyncScheduleSchema>;
export type SyncSource = z.output<typeof SyncSourceSchema>;
export type SyncPolicy = z.output<typeof SyncPolicySchema>;
export type SyncPolicyValues = z.output<typeof SyncPolicyValuesSchema>;
export type SyncDeploymentLimits = z.output<typeof SyncDeploymentLimitsSchema>;
export type SyncEffectivePolicy = z.output<typeof SyncEffectivePolicySchema>;
export type SyncStamp = z.output<typeof SyncStampSchema>;
export type SyncUpstream = z.output<typeof SyncUpstreamSchema>;
export type SyncIdentityMap = z.output<typeof SyncIdentityMapSchema>;
export type SyncCandidate = z.output<typeof SyncCandidateSchema>;
export type SyncCandidateView = z.output<typeof SyncCandidateViewSchema>;
export type SyncDecisions = z.output<typeof SyncDecisionsSchema>;
export type SyncResolvedPlan = z.output<typeof SyncResolvedPlanSchema>;
export type SyncReceipt = z.output<typeof SyncReceiptSchema>;
export type SyncHistoryEntry = z.output<typeof SyncHistoryEntrySchema>;
export type SourceReadInput = z.output<typeof SourceReadInputSchema>;
export type SourceReadResult = z.output<typeof SourceReadResultSchema>;
export type SyncNormalizeInput = z.output<typeof SyncNormalizeInputSchema>;
export type SyncNormalizedSource = z.output<typeof SyncNormalizedSourceSchema>;
export type SyncPlanInput = z.output<typeof SyncPlanInputSchema>;
export type SyncResolveInput = z.output<typeof SyncResolveInputSchema>;
export type SyncRollbackInput = z.output<typeof SyncRollbackInputSchema>;
export type SyncDiagnostic = z.output<typeof SyncDiagnosticSchema>;
export type SyncFile = z.output<typeof SyncFileSchema>;
export type SyncEntityKind = z.output<typeof SyncEntityKindSchema>;

/** Host-only injected material. There is deliberately no wire schema for a lease. */
export interface SourceMaterialLease {
  readonly leaseId: string;
  readonly httpHeaders?: readonly { readonly name: string; readonly value: string }[];
  readonly tls?: { readonly caPem?: string; readonly certPem?: string; readonly keyPem?: string };
  readonly ssh?: { readonly privateKeyPath: string; readonly knownHostsPath: string; readonly passphrase?: string };
  release(): Promise<void>;
}
// Read-only fixed asset documents. The public request has no path, files,
// material, private root or arbitrary object selector.
export const SyncFixedDetailRequestSchema = z.object({
  formatVersion: z.literal(1), candidateId: z.string().uuid(), candidateDigest: SyncHashSchema,
  changeId: SyncHashSchema, side: z.enum(['baseline', 'current', 'source']),
}).strict();
const fixedDetailIdentity = {
  formatVersion: z.literal(1), candidateId: z.string().uuid(), candidateDigest: SyncHashSchema, changeId: SyncHashSchema,
  side: SyncFixedDetailRequestSchema.shape.side, entityKind: SyncEntityKindSchema, entityId: z.string().uuid(),
  assetPath: SyncRelativePathSchema, fieldPath: SyncChangeSchema.shape.fieldPath,
};
export const SyncFixedDetailSchema = z.discriminatedUnion('kind', [
  z.object({ ...fixedDetailIdentity, kind: z.literal('absent') }).strict(),
  z.object({ ...fixedDetailIdentity, kind: z.literal('document'), contentType: z.enum(['application/vnd.apicc.contract+yaml', 'text/markdown']),
    text: z.string().max(32 * MiB), bytes: z.number().int().nonnegative().max(32 * MiB), sha256: SyncHashSchema }).strict(),
]);
export const SyncFixedDetailInputSchema = z.object({ candidate: SyncCandidateSchema, request: SyncFixedDetailRequestSchema, files,
  budget: compareBudget }).strict();
export type SyncFixedDetailRequest = z.output<typeof SyncFixedDetailRequestSchema>;
export type SyncFixedDetail = z.output<typeof SyncFixedDetailSchema>;
export type SyncFixedDetailInput = z.output<typeof SyncFixedDetailInputSchema>;
