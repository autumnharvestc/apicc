import { z } from "zod";
import { JsonValueSchema, StringRecordSchema } from "../contract/schemaNode.js";
import type { DeepReadonly } from "../assets/snapshot.js";

const count = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().finite().nonnegative();
const duration = count.max(604800000);
const boundedDelay = z.number().int().min(0).max(3600000);
const name = z.string().min(1);
const inputs = StringRecordSchema(JsonValueSchema);
export const StressTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("case"), collectionId: name, apiId: name, caseId: name }).strict(),
  z.object({ kind: z.literal("workflow"), workflowId: name, inputs: inputs.optional() }).strict(),
]);
export const StressLoadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("constant-vus"), vus: count.max(1000) }).strict(),
  z.object({ kind: z.literal("constant-arrival"), rate: z.number().finite().positive() }).strict(),
  z.object({ kind: z.literal("stages"), executor: z.enum(["vus", "arrival"]), startTarget: nonnegative,
    stages: z.array(z.object({ id: name, durationMs: duration, target: nonnegative }).strict()).min(1).max(32) }).strict(),
]);
const lifecycleFields = { workflowId: name, inputs: inputs.optional() };
const setup = z.object({ ...lifecycleFields, outputs: StringRecordSchema(name).optional() }).strict();
const teardown = z.object(lifecycleFields).strict();
export const StressLifecycleSchema = z.object({ setup: setup.optional(), vuSetup: setup.optional(), vuTeardown: teardown.optional(), teardown: teardown.optional() }).strict();
export const StressPlanSchema = z.object({
  formatVersion: z.literal(1), target: StressTargetSchema, load: StressLoadSchema,
  maxVus: count.max(1000).default(1),
  termination: z.object({ durationMs: duration.optional(), maxIterations: count.optional() }).strict().default({}),
  warmupMs: boundedDelay.default(0), thinkTimeMs: boundedDelay.default(0), pacingMs: boundedDelay.default(0),
  gracefulStopMs: z.number().int().min(0).max(300000).default(30000),
  maxRequestConcurrency: count.max(1000).optional(), maxRps: z.number().finite().positive().optional(),
  environmentId: name.optional(), connectionMode: z.enum(["pooled", "fresh"]).default("pooled"),
  thresholds: z.object({ maxErrorRate: z.number().finite().min(0).max(1).optional(),
    maxAssertionFailureRate: z.number().finite().min(0).max(1).optional(), maxP95Ms: nonnegative.optional(), minRps: nonnegative.optional() }).strict().optional(),
  lifecycle: StressLifecycleSchema.optional(), dataPolicy: z.enum(["vu-round-robin", "node-selection"]).optional(),
}).strict().superRefine((plan, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const load = plan.load;
  if (load.kind === "stages") {
    if (plan.termination.durationMs !== undefined) issue(["termination", "durationMs"], "Stage durations are the only duration source");
    if (load.stages.reduce((sum, stage) => sum + stage.durationMs, 0) > 604800000) issue(["load", "stages"], "Measurement duration exceeds seven days");
    if (new Set(load.stages.map((stage) => stage.id)).size !== load.stages.length) issue(["load", "stages"], "Stage IDs must be unique");
    if (load.startTarget === 0 && load.stages.every((stage) => stage.target === 0)) issue(["load"], "Load cannot be entirely zero");
    const targets = [load.startTarget, ...load.stages.map((stage) => stage.target)];
    if (load.executor === "vus" && targets.some((value) => !Number.isSafeInteger(value) || value > plan.maxVus)) issue(["load"], "VU targets must be integers within maxVus");
    if (load.executor === "arrival") {
      let previous = load.startTarget; let slots = 0;
      for (const stage of load.stages) { slots += (previous / 2 + stage.target / 2) * (stage.durationMs / 1000); previous = stage.target; }
      if (!Number.isFinite(slots) || slots > Number.MAX_SAFE_INTEGER) issue(["load"], "Arrival slot integral exceeds safe integer capacity");
    }
  } else {
    if (plan.termination.durationMs === undefined && plan.termination.maxIterations === undefined) issue(["termination"], "A constant load requires durationMs or maxIterations");
    if (load.kind === "constant-vus" && load.vus > plan.maxVus) issue(["load", "vus"], "VU target exceeds maxVus");
    if (load.kind === "constant-arrival") {
      if (plan.termination.durationMs === undefined) issue(["termination", "durationMs"], "Arrival load requires durationMs");
      const slots = load.rate * ((plan.termination.durationMs ?? 0) / 1000);
      if (!Number.isFinite(slots) || slots > Number.MAX_SAFE_INTEGER) issue(["load", "rate"], "Arrival slot integral exceeds safe integer capacity");
    }
  }
  if (plan.dataPolicy !== undefined && plan.dataPolicy !== (plan.target.kind === "case" ? "vu-round-robin" : "node-selection")) issue(["dataPolicy"], "Data policy must match the target kind");
});
export const SavedStressPlanSchema = z.object({ formatVersion: z.literal(1), id: name, name,
  updatedAt: z.number().finite().nonnegative(), plan: StressPlanSchema }).strict();
export type StressPlan = z.infer<typeof StressPlanSchema>;
export type SavedStressPlan = z.infer<typeof SavedStressPlanSchema>;
export type StressTarget = z.infer<typeof StressTargetSchema>;
export type StressLoad = z.infer<typeof StressLoadSchema>;
export type StressLifecycle = z.infer<typeof StressLifecycleSchema>;
export type StressPhase = "setup" | "vu-setup" | "warmup" | "measurement" | "drain" | "vu-teardown" | "teardown";
export type StressLifecycleRole = "setup" | "vuSetup" | "vuTeardown" | "teardown";
export interface StressMetricPlan {
  readonly stableNodeKeys: readonly { readonly workflowId: string; readonly nodeId: string; readonly key: string }[];
  readonly histogram: { readonly minValueMs: 0.001; readonly gamma: 1.01; readonly bucketCount: 4608; readonly exactLimit: 256 };
  readonly timeline: { readonly initialBucketWidthMs: 1000; readonly maxBuckets: 120 };
  readonly node: { readonly maxKeys: 512; readonly otherKey: "other" };
  readonly error: { readonly maxKeys: 128; readonly otherKey: "other" };
  readonly evidence: { readonly maxSamples: 20; readonly bodyBytes: 65536; readonly valueBytes: 4096; readonly caseBytes: 262144; readonly reportBytes: 16777216 };
  readonly memory: { readonly maxNumericBytes: 67108864 };
}
export interface StressSchedule {
  readonly load: DeepReadonly<StressLoad>;
  readonly durationMs: number | null; readonly maxIterations: number | null; readonly maxVus: number;
  readonly warmupMs: number; readonly thinkTimeMs: number; readonly pacingMs: number; readonly gracefulStopMs: number;
  readonly metricPlan: StressMetricPlan;
  readonly requested: { readonly maxRequestConcurrency: number | null; readonly maxRps: number | null };
  readonly effective: { readonly maxRequestConcurrency: number; readonly maxRps: number | null };
}
