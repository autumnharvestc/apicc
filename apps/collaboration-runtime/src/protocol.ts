import { createHash } from "node:crypto";
import { z } from "zod";
import { DocumentPublicationInputSchema, MemberPublicationInputSchema, ArchivePublicationInputWireSchema, ProjectionPolicySchema,
  PublicArtifactDtoSchema, AssetMutationInputWireSchema, AssetMutationResultSchema, CompileMockInputWireSchema,
  CompileMockResultSchema, SharedMockPolicySchema, CompiledMockPlanSchema, MockEvaluationInputWireSchema, MockEvaluationResultWireSchema } from "@apicc/core/collaboration/shared";

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

export const operations = ["project-document", "project-report", "classify-asset-mutation", "compile-mock", "respond-mock", "health"] as const;
export type Operation = typeof operations[number];
const member = MemberPublicationInputSchema.shape.artifact.options;
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
};
export const outputSchemas = {
  "project-document": PublicArtifactDtoSchema, "project-report": PublicArtifactDtoSchema,
  "classify-asset-mutation": AssetMutationResultSchema, "compile-mock": CompileMockResultSchema,
  "respond-mock": MockEvaluationResultWireSchema, health: z.object({ ready: z.literal(true) }).strict(),
};
const fields = { protocolVersion: z.literal(1), requestId: z.string(), inputDigest: z.string(), deadlineEpochMs: z.number().int(), outputBudgetBytes: z.number().int().positive() };
const request = <O extends Operation>(operation: O) => z.object({ ...fields, operation: z.literal(operation), payload: payloadSchemas[operation] }).strict();
export const RequestSchema = z.union([request("project-document"), request("project-report"), request("classify-asset-mutation"), request("compile-mock"), request("respond-mock"), request("health")]);
export type RpcRequest = z.infer<typeof RequestSchema>;
const success = <O extends Operation>(operation: O) => z.object({ ...fields, operation: z.literal(operation), coreBuildIdentity: z.string(), outputDigest: z.string(), outputBytes: z.number().int().nonnegative(), wireBytes: z.number().int().positive(), payload: outputSchemas[operation] }).strict();
export const ResponseSchema = z.union([success("project-document"), success("project-report"), success("classify-asset-mutation"), success("compile-mock"), success("respond-mock"), success("health")]);
export const ErrorSchema = z.object({ code: z.string(), requestId: z.string(), retryable: z.literal(false) }).strict();
export function parsePayload<O extends Operation>(operation: O, value: unknown): z.infer<typeof payloadSchemas[O]> {
  const result = payloadSchemas[operation].safeParse(value);
  if (!result.success) throw new Error("RPC_INVALID_REQUEST");
  return result.data as z.infer<typeof payloadSchemas[O]>;
}
