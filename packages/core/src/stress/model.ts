import { z } from "zod";
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

export type StressViolationMetric = "errorRate" | "assertionFailureRate" | "p95" | "rps" | "businessFailures";

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

/** Stable local generator resource metadata; legacy reports may omit this field. */
export interface StressGeneratorMetrics {
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuPercent: number;
  rssStartBytes: number;
  rssPeakBytes: number;
  eventLoopDelayP95Ms: number;
  schedulerBacklogMax: number;
  saturated: boolean;
  reasons: Array<"cpu" | "event-loop-delay" | "scheduler-backlog">;
  limits: { cpuPercent: number; eventLoopDelayP95Ms: number; schedulerBacklog: number };
}

export interface StressSafetyTarget {
  origin: string;
  confirmation: string;
  policy: string;
}

export interface StressSafety {
  targetOrigins: StressSafetyTarget[];
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
  // CaseOutcome is already validated by the execution kernel. Keep it opaque on the wire
  // so the worker protocol does not duplicate the report model's recursive details.
  outcome: z.any().optional(),
}).strict();

const latencySchema = z.object({
  min: z.number().finite().nonnegative(), avg: z.number().finite().nonnegative(), max: z.number().finite().nonnegative(),
  p50: z.number().finite().nonnegative(), p90: z.number().finite().nonnegative(), p95: z.number().finite().nonnegative(), p99: z.number().finite().nonnegative(),
}).strict();

export const StressFailureCountsSchema = z.object({
  transport: z.number().int().nonnegative(), http: z.number().int().nonnegative(), script: z.number().int().nonnegative(),
  assertion: z.number().int().nonnegative(), config: z.number().int().nonnegative(), aborted: z.number().int().nonnegative(),
}).strict();

const thresholdsSchema = z.object({
  maxErrorRate: z.number().min(0).max(1).optional(),
  maxAssertionFailureRate: z.number().min(0).max(1).optional(),
  maxP95Ms: z.number().nonnegative().optional(),
  minRps: z.number().nonnegative().optional(),
}).strict();

const verdictSchema = z.object({
  passed: z.boolean(),
  violations: z.array(z.object({
    metric: z.enum(["errorRate", "assertionFailureRate", "p95", "rps", "businessFailures"]),
    actual: z.number(), expected: z.number(), message: z.string(),
  }).strict()),
}).strict();

export const StressGeneratorSchema = z.object({
  cpuUserMs: z.number().finite().nonnegative(), cpuSystemMs: z.number().finite().nonnegative(), cpuPercent: z.number().finite().nonnegative(),
  rssStartBytes: z.number().finite().nonnegative(), rssPeakBytes: z.number().finite().nonnegative(), eventLoopDelayP95Ms: z.number().finite().nonnegative(),
  schedulerBacklogMax: z.number().finite().int().nonnegative(), saturated: z.boolean(),
  reasons: z.array(z.enum(["cpu", "event-loop-delay", "scheduler-backlog"])),
  limits: z.object({ cpuPercent: z.number().finite().nonnegative(), eventLoopDelayP95Ms: z.number().finite().nonnegative(), schedulerBacklog: z.number().finite().int().nonnegative() }).strict(),
}).strict();

export const StressSafetySchema = z.object({
  targetOrigins: z.array(z.object({ origin: z.string(), confirmation: z.string(), policy: z.string() }).strict()),
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
  }).strict()),
  shardErrors: z.array(z.object({ shardId: z.string(), error: z.string() })).optional(),
}).strict();
export type StressDistributed = z.infer<typeof StressDistributedSchema>;

export const StressReportSchema = z.object({
  concurrency: z.number().int().positive(),
  totalRequests: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  rps: z.number().nonnegative(),
  latency: latencySchema,
  statusDist: z.record(z.string(), z.number().int().nonnegative()),
  errorKinds: z.record(z.string(), z.number().int().nonnegative()),
  startedAt: z.number(), finishedAt: z.number(),
  // M2-D 分布式段：optional 保证 M2-C 旧报告（无 distributed）继续可解析（D6）。
  distributed: StressDistributedSchema.optional(),
  failures: StressFailureCountsSchema.optional(),
  scriptLatency: latencySchema.optional(),
  iterationLatency: latencySchema.optional(),
  thresholds: thresholdsSchema.optional(),
  verdict: verdictSchema.optional(),
  incomplete: z.boolean().optional(),
  generator: StressGeneratorSchema.optional(),
  safety: StressSafetySchema.optional(),
}).strict();
type ParsedStressReport = z.infer<typeof StressReportSchema>;
/** New reports always include the aggregate fields; parser fields remain optional for legacy files. */
export type StressReport = Omit<ParsedStressReport, "failures" | "scriptLatency" | "iterationLatency"> & {
  failures: StressFailureCounts;
  scriptLatency: z.infer<typeof latencySchema>;
  iterationLatency: z.infer<typeof latencySchema>;
};
