import { SyncFixedDetailRequestSchema, SyncFixedDetailSchema } from '@apicc/core/sync/shared';
import { createHash } from "node:crypto";
import { z } from "zod";
import { DocumentPublicationInputSchema, MemberPublicationInputSchema, ArchivePublicationInputWireSchema, ProjectionPolicySchema,
  PublicArtifactDtoSchema, AssetMutationInputWireSchema, AssetMutationResultSchema, CompileMockInputWireSchema,
  CompileMockResultSchema, SharedMockPolicySchema, CompiledMockPlanSchema, MockEvaluationInputWireSchema, MockEvaluationResultWireSchema } from "@apicc/core/collaboration/shared";
import { SyncCandidateSchema, SyncPlanInputSchema, SyncResolveInputSchema, SyncRollbackInputSchema, SyncResolvedPlanSchema, SourceReadInputSchema, SourceReadResultSchema, SyncNormalizeInputSchema, SyncRevisionSchema, SyncHashSchema, SyncContentRefSchema } from "@apicc/core/sync/shared";
import { syncErrorCodes } from "./sourceHost.js";

/** Protocol v1 SHA256 JSON tree encoding, independent of JSON number spelling.
 * Tags: 00 null,01 false,02 true,03 number IEEE754binary64BE (-0→+0),
 * 04 string:u32BE UTF16 code-unit count + UTF16BE units,
 * 05 array:u32BE count+ordered nodes,06 object:u32BE count+key/value nodes.
 * Object keys sort by UTF16 code units. Strings preserve lone surrogates.
 * No coercions, nonfinite numbers or undefined JSON leaves.
 */
export function digestJson(value: unknown): string {
  const hash = createHash("sha256");
  const tag = (value: number) => hash.update(Buffer.from([value]));
  const length = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); hash.update(buffer); };
  const visit = (node: unknown): void => {
    if (node === null) { tag(0); return; }
    if (typeof node === "boolean") { tag(node ? 2 : 1); return; }
    if (typeof node === "number" && Number.isFinite(node)) { tag(3); const bytes = Buffer.alloc(8); bytes.writeDoubleBE(node === 0 ? 0 : node); hash.update(bytes); return; }
    if (typeof node === "string") { tag(4); length(node.length); const bytes = Buffer.alloc(node.length * 2); for (let i = 0; i < node.length; i++) bytes.writeUInt16BE(node.charCodeAt(i), i * 2); hash.update(bytes); return; }
    if (Array.isArray(node)) { tag(5); length(node.length); for (const child of node) visit(child); return; }
    if (typeof node === "object") { const keys = Object.keys(node! ).sort(); tag(6); length(keys.length); for (const key of keys) { visit(key); visit((node as Record<string, unknown>)[key]); } return; }
    throw new Error("RPC_JSON_INVALID");
  };
  visit(value); return hash.digest("hex");
}

export const operations = ["project-document", "project-report", "classify-asset-mutation", "compile-mock", "respond-mock", "health", "sync-read", "sync-plan", "sync-resolve", "sync-rollback"] as const;
export type Operation = typeof operations[number];
// Private material values are bounded by the authenticated total wire reservation.
// Native filenames, functions and authority-selected tool paths have no wire fields.
const tlsMaterial = z.object({ caPem: z.string().optional(), certPem: z.string().optional(), keyPem: z.string().optional() }).strict();
const networkTLS = z.object({ caPems: z.array(z.string()), clientCertPems: z.array(z.string()), clientKeyPem: z.string().optional(), clientKeyPassphrase: z.string().optional() }).strict();
const networkProfileBase = { id: z.string().min(1), name: z.string(), targetTlsBindings: z.array(z.object({ origin: z.string(), tls: networkTLS }).strict()) };
const privateNetwork = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct"), revision: SyncRevisionSchema }).strict(),
  z.object({ kind: z.literal("profile"), revision: SyncRevisionSchema, profile: z.discriminatedUnion("kind", [
    z.object({ ...networkProfileBase, kind: z.literal("direct") }).strict(),
    z.object({ ...networkProfileBase, kind: z.literal("proxy"), proxyUrl: z.string(), username: z.string().optional(), password: z.string().optional(), proxyTLS: networkTLS.optional() }).strict(),
  ]) }).strict(),
]);
export const SyncReadPayloadSchema = z.object({
  input: SourceReadInputSchema,
  context: z.object({ workspaceId: z.string().regex(/^[1-9][0-9]*$/), projectId: z.string().regex(/^[1-9][0-9]*$/), sourceRevision: SyncRevisionSchema, authorizationGeneration: SyncRevisionSchema, invocationId: z.string().uuid(), projectConcurrency: z.number().int().min(1).max(4), hostConcurrency: z.number().int().min(1).max(16) }).strict(),
  material: z.object({ leaseId: z.string().min(1), identity: SyncHashSchema, httpHeaders: z.array(z.object({ name: z.string(), value: z.string() }).strict()).optional(), tls: tlsMaterial.optional(),
    ssh: z.object({ privateKeyPem: z.string(), knownHostsText: z.string(), passphrase: z.string().optional() }).strict().optional() }).strict(),
  network: privateNetwork,
}).strict();
/** Complete content is private even on304. The public T1 not-modified DTO stays unchanged. */
export const SyncReadOutputSchema = z.object({ ...SourceReadResultSchema.options[0].shape, status: z.enum(["read", "not-modified"]) }).strict();
const p = SyncPlanInputSchema.shape;
const sourcePlanFields = { read: SyncReadOutputSchema, source: p.source, mapping: p.mapping,
  allocationSeed: SyncNormalizeInputSchema.shape.allocationSeed, baselineFiles: p.baselineFiles, localFiles: p.localFiles, otherSourceMappings: p.otherSourceMappings,
  budget: SyncNormalizeInputSchema.shape.budget.extend(p.budget.shape).strict() };
export const SyncPlanPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal('fixed-detail'), candidate: SyncCandidateSchema, request: SyncFixedDetailRequestSchema, files: p.localFiles, budget: p.budget }).strict(),
  z.object({ kind: z.literal("prepared"), input: SyncPlanInputSchema }).strict(),
  z.object({ kind: z.literal("source-read"), ...sourcePlanFields, stamp: p.stamp }).strict(),
  // Only DB-backed online metadata lacks a semantic revision. Full stamps still take the strict comparison path.
  z.object({ kind: z.literal("source-read-online"), ...sourcePlanFields, stamp: p.stamp.options[1].omit({ definitionRevision: true }) }).strict(),
]);
export type SyncReadPayload = z.infer<typeof SyncReadPayloadSchema>;
export type SyncReadOutput = z.infer<typeof SyncReadOutputSchema>;
export type SyncPlanPayload = z.infer<typeof SyncPlanPayloadSchema>;
const member = MemberPublicationInputSchema.shape.artifact.options;
const commitArtifact = z.object({ reference: SyncContentRefSchema, text: z.string() }).strict();
export const SyncCommitResultSchema = z.object({ plan: SyncResolvedPlanSchema, before: commitArtifact, after: commitArtifact, baseline: commitArtifact }).strict();
export const payloadSchemas = {
  "project-document": z.object({ input: z.union([DocumentPublicationInputSchema, MemberPublicationInputSchema.extend({ artifact: member[0] })]), policy: ProjectionPolicySchema }).strict(),
  "project-report": z.object({ input: z.union([ArchivePublicationInputWireSchema, MemberPublicationInputSchema.extend({ artifact: z.union([member[1], member[2]]) })]), policy: ProjectionPolicySchema }).strict(),
  "classify-asset-mutation": AssetMutationInputWireSchema,
  "compile-mock": z.object({ input: CompileMockInputWireSchema, policy: SharedMockPolicySchema }).strict(),
  "respond-mock": z.union([
    z.object({ plan: CompiledMockPlanSchema, planDigest: z.string().optional(), input: MockEvaluationInputWireSchema, policy: SharedMockPolicySchema }).strict(),
    z.object({ planDigest: z.string(), input: MockEvaluationInputWireSchema, policy: SharedMockPolicySchema }).strict(),
  ]),
  health: z.object({}).strict(),
  "sync-read": SyncReadPayloadSchema,
  "sync-plan": SyncPlanPayloadSchema,
  "sync-resolve": z.union([SyncResolveInputSchema, z.object({ kind: z.literal("online-commit"), input: SyncResolveInputSchema }).strict()]),
  "sync-rollback": z.union([SyncRollbackInputSchema, z.object({ kind: z.literal("online-commit"), input: SyncRollbackInputSchema }).strict()]),
};
export const outputSchemas = {
  "project-document": PublicArtifactDtoSchema, "project-report": PublicArtifactDtoSchema,
  "classify-asset-mutation": AssetMutationResultSchema, "compile-mock": CompileMockResultSchema,
  "respond-mock": MockEvaluationResultWireSchema, health: z.object({ ready: z.literal(true) }).strict(),
  "sync-read": SyncReadOutputSchema,
  "sync-plan": z.union([z.object({ candidate: SyncCandidateSchema, planInput: SyncPlanInputSchema }).strict(), SyncFixedDetailSchema]),
  "sync-resolve": z.union([SyncResolvedPlanSchema, SyncCommitResultSchema]), "sync-rollback": z.union([SyncResolvedPlanSchema, SyncCommitResultSchema]),
};
const fields = { protocolVersion: z.literal(1), requestId: z.string(), inputDigest: z.string(), deadlineEpochMs: z.number().int(), outputBudgetBytes: z.number().int().positive() };
const request = <O extends Operation>(operation: O) => z.object({ ...fields, operation: z.literal(operation), payload: payloadSchemas[operation] }).strict();
export const RequestSchema = z.union([request("project-document"), request("project-report"), request("classify-asset-mutation"), request("compile-mock"), request("respond-mock"), request("health"), request("sync-read"), request("sync-plan"), request("sync-resolve"), request("sync-rollback")]);
export type RpcRequest = z.infer<typeof RequestSchema>;
const success = <O extends Operation>(operation: O) => z.object({ ...fields, operation: z.literal(operation), coreBuildIdentity: z.string(), outputDigest: z.string(), outputBytes: z.number().int().nonnegative(), wireBytes: z.number().int().positive(), payload: outputSchemas[operation] }).strict();
export const ResponseSchema = z.union([success("project-document"), success("project-report"), success("classify-asset-mutation"), success("compile-mock"), success("respond-mock"), success("health"), success("sync-read"), success("sync-plan"), success("sync-resolve"), success("sync-rollback")]);
export const runtimeErrorCodes = new Set([...syncErrorCodes,
  "RPC_UNAUTHORIZED", "RPC_NOT_FOUND", "RPC_METHOD_NOT_ALLOWED", "RPC_BUSY", "RPC_INTERNAL_ERROR",
  "RPC_INVALID_REQUEST", "RPC_INPUT_DIGEST_MISMATCH", "RPC_MESSAGE_TOO_LARGE", "RPC_DEADLINE_EXCEEDED", "RPC_CANCELLED", "RPC_INVALID_OUTPUT", "RPC_DUPLICATE_PATH", "RPC_POLICY_MISMATCH", "RPC_PLAN_UNAVAILABLE", "RPC_PLAN_DIGEST_MISMATCH", "RPC_PLAN_UNSAFE",
  "PUBLICATION_SOURCE_INVALID", "PUBLICATION_INPUT_INVALID", "PUBLICATION_SCOPE_INVALID", "PUBLICATION_POLICY_INVALID", "PUBLICATION_ARTIFACT_TOO_LARGE",
]);
export const ErrorSchema = z.object({ code: z.enum([...runtimeErrorCodes] as [string, ...string[]]), requestId: z.string(), retryable: z.literal(false) }).strict();
export function parsePayload<O extends Operation>(operation: O, value: unknown): z.infer<typeof payloadSchemas[O]> {
  const result = payloadSchemas[operation].safeParse(value);
  if (!result.success) throw new Error("RPC_INVALID_REQUEST");
  return result.data as z.infer<typeof payloadSchemas[O]>;
}
