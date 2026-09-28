import { z } from "zod";
import type { StressTargetPolicy } from "../domain/model.js";
import type { CaseFailureKind } from "../runner/caseExecutor.js";
import type { CaseOutcome } from "../report/types.js";

/** Stable business-result categories shared by case execution and stress reports. */
export type StressFailureKind = CaseFailureKind;

export const STRESS_FAILURE_KINDS: readonly StressFailureKind[] = [
  "transport", "http", "script", "assertion", "config", "aborted",
];

export type StressFailureCounts = Record<StressFailureKind, number>;

export interface StressThresholds {
  maxErrorRate?: number;
  maxAssertionFailureRate?: number;
  maxP95Ms?: number;
  minRps?: number;
}

export type StressViolationMetric = "errorRate" | "assertionFailureRate" | "p95" | "rps" | "businessFailures" | "noData";

export interface StressViolation {
  metric: StressViolationMetric;
  actual: number;
  expected: number;
  message: string;
}

export interface StressVerdict {
  passed: boolean;
  violations: StressViolation[];
}

/** Worker-owned pressure window. Wall timestamps make shard windows comparable;
 * monotonic duration remains authoritative when a wall clock jumps. */
export interface StressMeasurementWindow {
  startWallMs: number;
  endWallMs: number;
  monotonicDurationMs: number;
  eligibleCompletedAttempts: number;
}

export type StressGeneratorAvailability = "available" | "partial" | "unavailable";

/** Stable local generator resource metadata; legacy reports may omit this field. */
export interface StressGeneratorMetrics {
  /** Missing availability is the legacy shape and is treated as available. */
  availability?: StressGeneratorAvailability;
  unavailableReason?: string;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  cpuPercent?: number;
  rssStartBytes?: number;
  rssPeakBytes?: number;
  eventLoopDelayP95Ms?: number;
  schedulerBacklogMax?: number;
  saturated?: boolean;
  reasons?: Array<"cpu" | "event-loop-delay" | "scheduler-backlog">;
  limits?: { cpuPercent: number; eventLoopDelayP95Ms: number; schedulerBacklog: number };
}

export interface StressSafetyTarget {
  origin: string;
  confirmation: string;
  policy: string;
  loopback?: boolean;
  /** Normalized policy snapshot; values are origins and numeric limits only. */
  appliedPolicy?: StressTargetPolicy;
}

export interface StressSafetyRun {
  requestedConcurrency: number;
  effectiveConcurrency: number;
  requestedMaxRps: number | null;
  effectiveMaxRps: number | null;
  connectionMode: "pooled" | "fresh";
}

export interface StressSafety {
  targetOrigins: StressSafetyTarget[];
  availability?: "available" | "partial" | "unavailable";
  unavailableReason?: string;
  run?: StressSafetyRun;
}

/** 单次压测请求的采样结果（由并发池产生，aggregate 消费）。 */
export interface StressSample {
  /** Deprecated alias retained for M2 reports; new producers use requestTimeMs. */
  timeMs?: number;
  status: number;
  ok: boolean;
  error?: string;
  /** Execution-kernel timings. `timeMs` remains request latency for compatibility. */
  requestTimeMs?: number;
  scriptTimeMs?: number;
  iterationTimeMs?: number;
  /** Explicit protocol-I/O qualification; omitted means legacy sample semantics. */
  requestStarted?: boolean;
  /** Whether an entered protocol attempt settled; omitted means legacy completed semantics. */
  requestCompleted?: boolean;
  failureKind?: StressFailureKind;
  outcome?: CaseOutcome;
  safety?: StressSafetyTarget;
}

/** v2 worker wire format for a single Task 4 execution sample. */
export const StressSampleSchema = z.object({
  timeMs: z.number().finite().nonnegative().optional(),
  requestTimeMs: z.number().finite().nonnegative(),
  scriptTimeMs: z.number().finite().nonnegative(),
  iterationTimeMs: z.number().finite().nonnegative(),
  status: z.number().int().nonnegative(),
  ok: z.boolean(),
  error: z.string().optional(),
  requestStarted: z.boolean().optional(),
  requestCompleted: z.boolean().optional(),
  failureKind: z.enum(["transport", "http", "script", "assertion", "config", "aborted"]).optional(),
  safety: z.object({
    origin: z.string(), confirmation: z.string(), policy: z.string(), loopback: z.boolean().optional(),
    appliedPolicy: z.object({
      trustedOrigins: z.array(z.string()).optional(), deniedOrigins: z.array(z.string()).optional(),
      maxConcurrency: z.number().int().positive().optional(), maxRps: z.number().finite().positive().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict().superRefine((sample, ctx) => {
  if (sample.ok && sample.failureKind !== undefined) {
    ctx.addIssue({ code: "custom", path: ["failureKind"], message: "successful sample cannot carry failureKind" });
  }
  if (!sample.ok && sample.failureKind === undefined) {
    ctx.addIssue({ code: "custom", path: ["failureKind"], message: "failed sample requires failureKind" });
  }
  if (sample.requestCompleted === true && sample.requestStarted !== true) {
    ctx.addIssue({ code: "custom", path: ["requestCompleted"], message: "requestCompleted requires requestStarted" });
  }
  if (sample.requestStarted === false && (sample.requestTimeMs !== 0 || (sample.timeMs !== undefined && sample.timeMs !== 0))) {
    ctx.addIssue({ code: "custom", path: ["requestTimeMs"], message: "request not started cannot carry request latency" });
  }
});

const latencySchema = z.object({
  min: z.number().finite().nonnegative(), avg: z.number().finite().nonnegative(), max: z.number().finite().nonnegative(),
  p50: z.number().finite().nonnegative(), p90: z.number().finite().nonnegative(), p95: z.number().finite().nonnegative(), p99: z.number().finite().nonnegative(),
}).strict();

export const StressFailureCountsSchema = z.object({
  transport: z.number().int().nonnegative(), http: z.number().int().nonnegative(), script: z.number().int().nonnegative(),
  assertion: z.number().int().nonnegative(), config: z.number().int().nonnegative(), aborted: z.number().int().nonnegative(),
}).strict();

const thresholdsSchema = z.object({
  maxErrorRate: z.number().finite().min(0).max(1).optional(),
  maxAssertionFailureRate: z.number().finite().min(0).max(1).optional(),
  maxP95Ms: z.number().finite().nonnegative().optional(),
  minRps: z.number().finite().nonnegative().optional(),
}).strict();

const verdictSchema = z.object({
  passed: z.boolean(),
  violations: z.array(z.object({
    metric: z.enum(["errorRate", "assertionFailureRate", "p95", "rps", "businessFailures", "noData"]),
    actual: z.number().finite(), expected: z.number().finite(), message: z.string(),
  }).strict()),
}).strict();

const generatorLimitsSchema = z.object({
  cpuPercent: z.number().finite().nonnegative(), eventLoopDelayP95Ms: z.number().finite().nonnegative(),
  schedulerBacklog: z.number().finite().int().nonnegative(),
}).strict();

/** Legacy numeric generator objects remain readable; unavailable is explicit and has no fake metrics. */
export const StressGeneratorSchema = z.object({
  availability: z.enum(["available", "partial", "unavailable"]).optional(), unavailableReason: z.string().optional(),
  cpuUserMs: z.number().finite().nonnegative().optional(), cpuSystemMs: z.number().finite().nonnegative().optional(), cpuPercent: z.number().finite().nonnegative().optional(),
  rssStartBytes: z.number().finite().nonnegative().optional(), rssPeakBytes: z.number().finite().nonnegative().optional(), eventLoopDelayP95Ms: z.number().finite().nonnegative().optional(),
  schedulerBacklogMax: z.number().finite().int().nonnegative().optional(), saturated: z.boolean().optional(),
  reasons: z.array(z.enum(["cpu", "event-loop-delay", "scheduler-backlog"])).optional(),
  limits: generatorLimitsSchema.optional(),
}).strict().superRefine((generator, ctx) => {
  if (generator.availability === "unavailable") {
    for (const key of ["cpuUserMs", "cpuSystemMs", "cpuPercent", "rssStartBytes", "rssPeakBytes", "eventLoopDelayP95Ms", "schedulerBacklogMax", "saturated", "reasons", "limits"] as const) {
      if (generator[key] !== undefined) ctx.addIssue({ code: "custom", path: [key], message: "unavailable generator cannot fabricate metrics" });
    }
    return;
  }
  for (const key of ["cpuUserMs", "cpuSystemMs", "cpuPercent", "rssStartBytes", "rssPeakBytes", "eventLoopDelayP95Ms", "schedulerBacklogMax", "saturated", "reasons", "limits"] as const) {
    if (generator[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: "available generator requires complete metrics" });
  }
});

export const StressMeasurementWindowSchema = z.object({
  startWallMs: z.number().finite(), endWallMs: z.number().finite(),
  monotonicDurationMs: z.number().finite().nonnegative(), eligibleCompletedAttempts: z.number().int().nonnegative(),
}).strict().superRefine((window, ctx) => {
  if (window.endWallMs < window.startWallMs && window.monotonicDurationMs === 0) {
    ctx.addIssue({ code: "custom", path: ["endWallMs"], message: "measurement window wall clock reversed without monotonic duration" });
  }
});

export const StressSafetySchema = z.object({
  targetOrigins: z.array(z.object({
    origin: z.string(), confirmation: z.string(), policy: z.string(), loopback: z.boolean().optional(),
    appliedPolicy: z.object({
      trustedOrigins: z.array(z.string()).optional(), deniedOrigins: z.array(z.string()).optional(),
      maxConcurrency: z.number().int().positive().optional(), maxRps: z.number().finite().positive().optional(),
    }).strict().optional(),
  }).strict()),
  availability: z.enum(["available", "partial", "unavailable"]).optional(),
  unavailableReason: z.string().optional(),
  run: z.object({
    requestedConcurrency: z.number().int().positive(), effectiveConcurrency: z.number().int().positive(),
    requestedMaxRps: z.number().finite().positive().nullable(), effectiveMaxRps: z.number().finite().positive().nullable(),
    connectionMode: z.enum(["pooled", "fresh"]),
  }).strict().optional(),
}).strict();

/** distributed 段：多 shard 汇聚信息（M2-D）。shardErrors 无失败时省略。 */
export const StressDistributedSchema = z.object({
  protocolVersion: z.literal(2),
  dataComplete: z.boolean(),
  shards: z.number().int().positive(),
  perShard: z.array(z.object({
    shardId: z.string(),
    totalRequests: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    rps: z.number().finite().nonnegative(),
    generator: StressGeneratorSchema,
    measurementWindow: StressMeasurementWindowSchema,
    safety: StressSafetySchema.optional(),
  }).strict()),
  shardErrors: z.array(z.object({ shardId: z.string(), error: z.string() })).optional(),
}).strict();
export type StressDistributed = z.infer<typeof StressDistributedSchema>;

export const StressReportSchema = z.object({
  concurrency: z.number().int().positive(),
  totalRequests: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  durationMs: z.number().finite().nonnegative(),
  rps: z.number().finite().nonnegative(),
  latency: latencySchema,
  statusDist: z.record(z.string(), z.number().int().nonnegative()),
  errorKinds: z.record(z.string(), z.number().int().nonnegative()),
  startedAt: z.number().finite(), finishedAt: z.number().finite(),
  eligibleCompletedAttempts: z.number().int().nonnegative().optional(),
  measurementWindow: StressMeasurementWindowSchema.optional(),
  // M2-D 分布式段：optional 保证 M2-C 旧报告（无 distributed）继续可解析（D6）。
  distributed: StressDistributedSchema.optional(),
  failures: StressFailureCountsSchema.optional(),
  /** Failure counts restricted to requestStarted + requestCompleted + non-aborted attempts. */
  eligibleFailureCounts: StressFailureCountsSchema.optional(),
  scriptLatency: latencySchema.optional(),
  iterationLatency: latencySchema.optional(),
  thresholds: thresholdsSchema.optional(),
  verdict: verdictSchema.optional(),
  incomplete: z.boolean().optional(),
  generator: StressGeneratorSchema.optional(),
  safety: StressSafetySchema.optional(),
  connectionMode: z.enum(["pooled", "fresh"]).optional(),
}).strict();
/**
 * Contract for reports produced by a current stress run.  StressReportSchema
 * intentionally remains permissive so historical JSON can still be read; all
 * new CLI/worker output must pass this stricter shape before it is emitted.
 */
export const CurrentStressReportSchema = StressReportSchema.extend({
  failures: StressFailureCountsSchema,
  eligibleFailureCounts: StressFailureCountsSchema,
  scriptLatency: latencySchema,
  iterationLatency: latencySchema,
  verdict: verdictSchema,
  generator: StressGeneratorSchema,
  safety: StressSafetySchema.extend({
    run: z.object({
      requestedConcurrency: z.number().int().positive(), effectiveConcurrency: z.number().int().positive(),
      requestedMaxRps: z.number().finite().positive().nullable(), effectiveMaxRps: z.number().finite().positive().nullable(),
      connectionMode: z.enum(["pooled", "fresh"]),
    }).strict(),
  }).superRefine((safety, ctx) => {
    for (const [index, target] of safety.targetOrigins.entries()) {
      if (!target.appliedPolicy) {
        ctx.addIssue({ code: "custom", path: ["targetOrigins", index, "appliedPolicy"], message: "current safety target requires appliedPolicy" });
      } else {
        if (!Array.isArray(target.appliedPolicy.trustedOrigins)) {
          ctx.addIssue({ code: "custom", path: ["targetOrigins", index, "appliedPolicy", "trustedOrigins"], message: "current safety target requires normalized trustedOrigins" });
        }
        if (!Array.isArray(target.appliedPolicy.deniedOrigins)) {
          ctx.addIssue({ code: "custom", path: ["targetOrigins", index, "appliedPolicy", "deniedOrigins"], message: "current safety target requires normalized deniedOrigins" });
        }
      }
    }
  }),
  eligibleCompletedAttempts: z.number().int().nonnegative(),
  measurementWindow: StressMeasurementWindowSchema,
});
export type CurrentStressReport = z.infer<typeof CurrentStressReportSchema>;
type ParsedStressReport = z.infer<typeof StressReportSchema>;
/** New reports always include the aggregate fields; parser fields remain optional for legacy files. */
export type StressReport = Omit<ParsedStressReport, "failures" | "scriptLatency" | "iterationLatency"> & {
  failures: StressFailureCounts;
  scriptLatency: z.infer<typeof latencySchema>;
  iterationLatency: z.infer<typeof latencySchema>;
};
