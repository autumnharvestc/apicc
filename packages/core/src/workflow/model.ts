import { z } from "zod";
import { JsonValueSchema, StringRecordSchema, type JsonValue } from "../contract/schemaNode.js";

export const WorkflowStatusSchema = z.enum(["draft", "published", "enabled"]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type WorkflowValue =
  | { kind: "literal"; value: JsonValue }
  | { kind: "ref"; source: "inputs" | "vars" | "env" | "previous" | "error" | "loop"; path: Array<string | number> };
export const WorkflowValueSchema: z.ZodType<WorkflowValue> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: JsonValueSchema }).strict(),
  z.object({ kind: z.literal("ref"), source: z.enum(["inputs", "vars", "env", "previous", "error", "loop"]),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).max(64) }).strict(),
]);
export type WorkflowPredicate =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; left: WorkflowValue; right: WorkflowValue }
  | { op: "exists" | "notExists"; value: WorkflowValue }
  | { op: "and" | "or"; items: WorkflowPredicate[] }
  | { op: "not"; item: WorkflowPredicate };

// Bound untrusted input before recursive parsing, including cyclic JavaScript input.
function predicateBudget(value: unknown): boolean {
  const pending = [{ value, depth: 1 }];
  let count = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++count > 256 || entry.depth > 32) return false;
    if (typeof entry.value !== "object" || entry.value === null) continue;
    const node = entry.value as Record<string, unknown>;
    if (node.op === "not") pending.push({ value: node.item, depth: entry.depth + 1 });
    if ((node.op === "and" || node.op === "or") && Array.isArray(node.items)) {
      if (node.items.length > 256) return false;
      for (const item of node.items) pending.push({ value: item, depth: entry.depth + 1 });
    }
  }
  return true;
}
const PredicateShape: z.ZodType<WorkflowPredicate> = z.lazy(() => z.discriminatedUnion("op", [
  z.object({ op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]), left: WorkflowValueSchema, right: WorkflowValueSchema }).strict(),
  z.object({ op: z.enum(["exists", "notExists"]), value: WorkflowValueSchema }).strict(),
  z.object({ op: z.enum(["and", "or"]), items: z.array(PredicateShape).min(1) }).strict(),
  z.object({ op: z.literal("not"), item: PredicateShape }).strict(),
]));
export const WorkflowPredicateSchema = z.unknown().superRefine((value, context) => {
  if (!predicateBudget(value)) context.addIssue({ code: "custom", message: "Workflow predicate exceeds depth 32 or node budget 256" });
}).pipe(PredicateShape);
export const WorkflowRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(1),
  retryOn: z.array(z.enum(["transport", "http", "assertion", "extraction"])).default([]),
  delayMs: z.number().int().min(0).max(30000).default(0),
  backoff: z.enum(["fixed", "exponential"]).default("fixed"),
  allowRepeatSideEffects: z.boolean().default(false),
}).strict();
const HandlerSchema = z.object({ workflowId: z.string().min(1), timeoutMs: z.number().int().min(1).max(30000).default(5000) }).strict();
const policyFields = {
  timeoutMs: z.number().int().min(1).max(3600000).optional(),
  onError: HandlerSchema.extend({ mode: z.enum(["propagate", "recover"]) }).optional(),
  finally: HandlerSchema.optional(),
};
export const WorkflowPolicySchema = z.object(policyFields).strict();
export const WorkflowRequestPolicySchema = z.object({ ...policyFields, retry: WorkflowRetrySchema.optional() }).strict();
const nodeFields = { id: z.string(), label: z.string().optional(), position: z.object({ x: z.number(), y: z.number() }).strict().optional() };
const workflowNames = <Value>(schema: z.ZodType<Value>) => StringRecordSchema(schema)
  .refine((record) => Object.keys(record).every((name) => name.length > 0), "Workflow dictionary names must be nonempty");
const mappingFields = { inputs: workflowNames(WorkflowValueSchema).default({}), outputs: workflowNames(z.string().min(1)).default({}) };
export const WorkflowCallSchema = z.object({ workflowId: z.string().min(1), ...mappingFields }).strict();
export const WorkflowBranchSchema = WorkflowCallSchema.extend({ id: z.string().min(1) });
const LegacyNodeSchema = z.discriminatedUnion("kind", [
  z.object({ ...nodeFields, kind: z.literal("request"), apiId: z.string().optional(), caseId: z.string().optional() }).strict(),
  z.object({ ...nodeFields, kind: z.literal("noop"), apiId: z.string().optional(), caseId: z.string().optional() }).strict(),
]);
export const WorkflowNodeSchema = z.discriminatedUnion("kind", [
  z.object({ ...nodeFields, kind: z.literal("request"), apiId: z.string().optional(), caseId: z.string().optional(), policy: WorkflowRequestPolicySchema.optional() }).strict(),
  z.object({ ...nodeFields, kind: z.literal("noop"), apiId: z.string().optional(), caseId: z.string().optional(), policy: WorkflowPolicySchema.optional() }).strict(),
  z.object({ ...nodeFields, kind: z.literal("assign"), assignments: workflowNames(WorkflowValueSchema), policy: WorkflowPolicySchema.optional() }).strict(),
  z.object({ ...nodeFields, kind: z.literal("delay"), delayMs: z.number().int().nonnegative(), policy: WorkflowPolicySchema.optional() }).strict(),
  z.object({ ...nodeFields, kind: z.literal("assert"), predicate: WorkflowPredicateSchema, policy: WorkflowPolicySchema.optional() }).strict(),
  z.object({ ...nodeFields, kind: z.literal("condition"), predicate: WorkflowPredicateSchema, policy: WorkflowPolicySchema.optional() }).strict(),
  z.object({ ...nodeFields, kind: z.literal("subflow"), ...WorkflowCallSchema.shape, policy: WorkflowPolicySchema.optional() }).strict(),
  z.object({ ...nodeFields, kind: z.literal("loop"), ...WorkflowCallSchema.shape, count: z.number().int().nonnegative().optional(),
    while: WorkflowPredicateSchema.optional(), until: WorkflowPredicateSchema.optional(), maxIterations: z.number().int().min(1).max(10000).default(100), policy: WorkflowPolicySchema.optional() }).strict(),
  z.object({ ...nodeFields, kind: z.literal("parallel"), branches: z.array(WorkflowBranchSchema).min(2), join: z.enum(["all", "any-success"]), policy: WorkflowPolicySchema.optional() }).strict(),
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
const edgeFields = { id: z.string(), from: z.string(), to: z.string() };
const LegacyEdgeSchema = z.object({ ...edgeFields, condition: z.string().optional() }).strict();
export const WorkflowEdgeSchema = z.object({ ...edgeFields, condition: z.string().optional(), port: z.enum(["true", "false"]).optional() }).strict();
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
const workflowFields = { id: z.string(), name: z.string(), status: WorkflowStatusSchema.default("draft") };
export const WorkflowV1Schema = z.object({ ...workflowFields, executionVersion: z.literal(1).optional(), nodes: z.array(LegacyNodeSchema).default([]), edges: z.array(LegacyEdgeSchema).default([]) }).strict();
export const WorkflowV2Schema = z.object({ ...workflowFields, executionVersion: z.literal(2), nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(z.object({ ...edgeFields, port: z.enum(["true", "false"]).optional() }).strict()).default([]),
  inputs: workflowNames(z.object({ required: z.boolean(), default: JsonValueSchema.optional() }).strict()).default({}),
  outputs: workflowNames(WorkflowValueSchema).default({}),
  limits: z.object({ maxConcurrency: z.number().int().min(1).max(32).default(4), timeoutMs: z.number().int().min(1).max(3600000).default(300000) }).strict().default({ maxConcurrency: 4, timeoutMs: 300000 }),
}).strict().superRefine((workflow, context) => {
  workflow.nodes.forEach((node, index) => {
    if (node.kind !== "loop") return;
    if ((node.count === undefined) === (node.while === undefined)) context.addIssue({ code: "custom", path: ["nodes", index], message: "loop requires exactly one of count or while" });
    if (node.count !== undefined && node.count > node.maxIterations) context.addIssue({ code: "custom", path: ["nodes", index, "count"], message: "count exceeds maxIterations" });
  });
});
export const WorkflowSchema = z.union([WorkflowV1Schema, WorkflowV2Schema]);
export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowV1 = z.infer<typeof WorkflowV1Schema>;
export type WorkflowV2 = z.infer<typeof WorkflowV2Schema>;
