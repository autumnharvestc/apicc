import { z } from "zod";
import { computeReport, type ComputeReportOptions } from "./aggregate.js";
import type { StressDistributed, StressReport, StressSample } from "./model.js";

/** 协调端下发给 shard worker 的规格消息（protocolVersion 为前向兼容锚点，D5）。 */
export const StressWorkerSpecSchema = z.object({
  protocolVersion: z.literal(1),
  shardId: z.string(),
  apiPath: z.string(),
  caseId: z.string(),
  envName: z.string().optional(),
  concurrency: z.number().int().positive(),
  maxIterations: z.number().int().positive().optional(),
  durationMs: z.number().positive().optional(),
  workspaceRoot: z.string(),
}).strict();
export type StressWorkerSpec = z.infer<typeof StressWorkerSpecSchema>;

/** 成功 shard 回传的原始样本批（样本结构与其余 StressSample 同构，D1：合并后统一算分位）。 */
export const ShardResultSchema = z.object({
  protocolVersion: z.literal(1),
  ok: z.literal(true),
  shardId: z.string(),
  samples: z.array(z.object({ timeMs: z.number().nonnegative(), status: z.number(), ok: z.boolean(), error: z.string().optional() })),
}).strict();
export type ShardResult = z.infer<typeof ShardResultSchema>;

/** 失败 shard 回传的错误消息。 */
export const ShardFailureSchema = z.object({
  protocolVersion: z.literal(1),
  ok: z.literal(false),
  shardId: z.string(),
  error: z.string(),
}).strict();
export type ShardFailure = z.infer<typeof ShardFailureSchema>;

/** shard 回传结果判别联合（按 ok 字段区分成功/失败）。 */
export const ShardOutcomeSchema = z.discriminatedUnion("ok", [ShardResultSchema, ShardFailureSchema]);
export type ShardOutcome = z.infer<typeof ShardOutcomeSchema>;

/** 单个 shard 的份额（并发与终止条件）。 */
export interface ShardPlan {
  concurrency: number;
  maxIterations?: number;
  durationMs?: number;
}

/**
 * D3 分配纯函数：iterations 均分、余数给前 r 个（总数守恒）；并发每 shard
 * max(1, floor(C/n))、余数给前 r 个（每 shard 至少 1）；duration 模式各 shard 同截止各自跑满。
 */
export function planShards(
  share: { concurrency: number; maxIterations?: number; durationMs?: number },
  shards: number,
): ShardPlan[] {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`shards 必须为正整数，收到 ${shards}`);
  }
  if (share.maxIterations === undefined && share.durationMs === undefined) {
    // 与 StressRunner 口径同文案。
    throw new Error("压测终止条件缺失：maxIterations 与 durationMs 必须给其一");
  }
  const iterBase = share.maxIterations === undefined ? 0 : Math.floor(share.maxIterations / shards);
  const iterRemainder = share.maxIterations === undefined ? 0 : share.maxIterations % shards;
  const plans: ShardPlan[] = [];
  for (let i = 0; i < shards; i += 1) {
    plans.push({
      concurrency: Math.max(1, Math.floor(share.concurrency / shards) + (i < share.concurrency % shards ? 1 : 0)),
      ...(share.maxIterations !== undefined ? { maxIterations: iterBase + (i < iterRemainder ? 1 : 0) } : {}),
      ...(share.durationMs !== undefined ? { durationMs: share.durationMs } : {}),
    });
  }
  return plans;
}

/** shard 执行器注入签名：传输层实现按 spec 启动一个 worker 并回传协议结果（D2，MVP 为本地子进程）。 */
export type SpawnWorker = (spec: StressWorkerSpec) => Promise<ShardOutcome>;

/** 协调器运行选项。 */
export interface DistributedRunOptions {
  shards: number;
  /** 单 shard 等待上限毫秒，到期判该 shard 失败；默认 300s。 */
  shardTimeoutMs?: number;
  spawnWorker: SpawnWorker;
}

/** 协调器 specBase：除 protocolVersion/shardId 外的完整 worker 规格（并发与终止条件为总额，按 shard 拆分）。 */
export type StressWorkerSpecBase = Omit<StressWorkerSpec, "protocolVersion" | "shardId">;

/** run 结果：报告 + 失败 shard 数（退出语义留在 CLI，core 不携带）。 */
export interface CoordinatorRunResult {
  report: StressReport;
  shardFailureCount: number;
}

/** 单 shard 归一化后的结果：成功样本批或失败原因（spawn 抛错/超时/协议坏输出统一为后者）。 */
type ShardAttempt = { ok: true; result: ShardResult } | { ok: false; error: string };

/** 单 shard 超时包裹：到期 reject（协调侧判失败）；正常落定时清计时器，不拖尾事件循环。 */
function withTimeout<T>(promise: Promise<T>, shardId: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`shard ${shardId} 超时：${timeoutMs}ms 内未完成`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (cause) => { clearTimeout(timer); reject(cause); },
    );
  });
}

/** 协调窗口秒数（0 时 rps 口径为 0，与 computeReport 除法防护一致）。 */
function windowSeconds(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt) / 1000;
}

/** 报告组装（D1/D6）：合并样本一次 computeReport（跨 shard 分位精确）+ 挂 distributed 段；无失败时省略 shardErrors。 */
export function mergeStressReport(
  samples: StressSample[],
  distributed: StressDistributed,
  meta: ComputeReportOptions,
): StressReport {
  const report = computeReport(samples, meta);
  report.distributed = {
    shards: distributed.shards,
    perShard: distributed.perShard,
    ...(distributed.shardErrors !== undefined && distributed.shardErrors.length > 0
      ? { shardErrors: distributed.shardErrors }
      : {}),
  };
  return report;
}

/**
 * 多 shard 协调器：planShards 拆份额 → 并发 spawn 全部（allSettled 收集，单 shard 超时/抛错/
 * 协议坏输出均归入该 shard 失败，D4）→ 成功样本合并挂 distributed 段。任一 shard 失败不抛，
 * 失败数随结果返回供 CLI 决定退出码。
 */
export class DistributedStressCoordinator {
  async run(specBase: StressWorkerSpecBase, opts: DistributedRunOptions): Promise<CoordinatorRunResult> {
    const { shards, spawnWorker } = opts;
    const shardTimeoutMs = opts.shardTimeoutMs ?? 300_000;
    const plans = planShards(specBase, shards);
    const startedAt = Date.now();

    const specs = plans.map((plan, i): StressWorkerSpec => {
      const spec: StressWorkerSpec = { ...specBase, protocolVersion: 1, shardId: `shard-${i}`, concurrency: plan.concurrency };
      if (plan.maxIterations !== undefined) spec.maxIterations = plan.maxIterations;
      if (plan.durationMs !== undefined) spec.durationMs = plan.durationMs;
      // 自产协议消息过 schema：specBase 非法（如终止条件缺失）在此暴露。
      return StressWorkerSpecSchema.parse(spec);
    });

    // Promise.resolve 包一层：spawnWorker 同步抛错同样进入 rejected，归入该 shard 失败。
    const attempts = await Promise.allSettled(
      specs.map((spec) => withTimeout(Promise.resolve().then(() => spawnWorker(spec)), spec.shardId, shardTimeoutMs)),
    );
    const finishedAt = Date.now();

    const merged: StressSample[] = [];
    const perShard: StressDistributed["perShard"] = [];
    const shardErrors: { shardId: string; error: string }[] = [];
    let successConcurrency = 0;

    specs.forEach((spec, i) => {
      const settled = attempts[i];
      let attempt: ShardAttempt;
      if (settled.status === "rejected") {
        attempt = { ok: false, error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) };
      } else {
        const parsed = ShardOutcomeSchema.safeParse(settled.value);
        if (!parsed.success) {
          const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
          attempt = { ok: false, error: `协议解析失败：${detail}` };
        } else if (!parsed.data.ok) {
          attempt = { ok: false, error: parsed.data.error };
        } else {
          attempt = { ok: true, result: parsed.data };
        }
      }

      if (!attempt.ok) {
        shardErrors.push({ shardId: spec.shardId, error: attempt.error });
        return;
      }
      const samples = attempt.result.samples;
      merged.push(...samples);
      const okCount = samples.filter((s) => s.ok).length;
      // perShard rps 以协调窗口计（各 shard 同窗，为 shard 吞吐下界口径）。
      const seconds = windowSeconds(startedAt, finishedAt);
      perShard.push({
        shardId: spec.shardId,
        totalRequests: samples.length,
        ok: okCount,
        failed: samples.length - okCount,
        rps: seconds > 0 ? samples.length / seconds : 0,
      });
      successConcurrency += plans[i].concurrency;
    });

    // 报告 concurrency = 各成功 shard 分得并发之和；无成功 shard 时回退为分配总额
    // （StressReportSchema 要求正整数，D4 要求全失败仍落盘可回读）。
    const concurrency = successConcurrency > 0
      ? successConcurrency
      : plans.reduce((sum, plan) => sum + plan.concurrency, 0);

    const report = mergeStressReport(merged, { shards, perShard, shardErrors }, { concurrency, startedAt, finishedAt });
    return { report, shardFailureCount: shardErrors.length };
  }
}
