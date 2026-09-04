import { z } from "zod";

/** 单次压测请求的采样结果（由并发池产生，aggregate 消费）。 */
export interface StressSample {
  timeMs: number;
  status: number;
  ok: boolean;
  error?: string;
}

/** distributed 段：多 shard 汇聚信息（M2-D）。shardErrors 无失败时省略。 */
export const StressDistributedSchema = z.object({
  shards: z.number().int().positive(),
  perShard: z.array(z.object({ shardId: z.string(), totalRequests: z.number().int().nonnegative(), ok: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), rps: z.number().nonnegative() })),
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
  latency: z.object({ min: z.number(), avg: z.number(), max: z.number(), p50: z.number(), p90: z.number(), p95: z.number(), p99: z.number() }),
  statusDist: z.record(z.string(), z.number()),
  errorKinds: z.record(z.string(), z.number()),
  startedAt: z.number(), finishedAt: z.number(),
  // M2-D 分布式段：optional 保证 M2-C 旧报告（无 distributed）继续可解析（D6）。
  distributed: StressDistributedSchema.optional(),
}).strict();
export type StressReport = z.infer<typeof StressReportSchema>;
