import { z } from "zod";

/** 单次压测请求的采样结果（由并发池产生，aggregate 消费）。 */
export interface StressSample {
  timeMs: number;
  status: number;
  ok: boolean;
  error?: string;
}

export const StressReportSchema = z.object({
  concurrency: z.number().int().positive(),
  totalRequests: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  rps: z.number().nonnegative(),
  latency: z.object({ min: z.number(), avg: z.number(), max: z.number(), p50: z.number(), p90: z.number(), p95: z.number(), p99: z.number() }),
  statusDist: z.record(z.string(), z.number()),
  errorKinds: z.record(z.string(), z.number()),
  startedAt: z.number(), finishedAt: z.number(),
}).strict();
export type StressReport = z.infer<typeof StressReportSchema>;
