import { z } from "zod";
import { computeReport, isEligibleCompletedAttempt, measurementWindowDurationMs, type ComputeReportOptions } from "./aggregate.js";
import type { StressDistributed, StressGeneratorMetrics, StressMeasurementWindow, StressReport, StressSafetyRun, StressSample, StressThresholds } from "./model.js";
import { CurrentStressReportSchema, StressGeneratorSchema, StressMeasurementWindowSchema, StressSampleSchema } from "./model.js";

/** 协调端下发给 shard worker 的规格消息（protocolVersion 为前向兼容锚点，D5）。 */
export const StressWorkerSpecSchema = z.object({
  protocolVersion: z.literal(2),
  shardId: z.string(),
  apiPath: z.string(),
  caseId: z.string(),
  envName: z.string().optional(),
  concurrency: z.number().int().positive().safe(),
  maxIterations: z.number().int().positive().safe().optional(),
  durationMs: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxRps: z.number().finite().positive().optional(),
  maxErrorRate: z.number().finite().min(0).max(1).optional(),
  maxAssertionFailureRate: z.number().finite().min(0).max(1).optional(),
  maxP95Ms: z.number().finite().nonnegative().optional(),
  minRps: z.number().finite().nonnegative().optional(),
  confirmedTargetOrigins: z.array(z.string()).optional(),
  connectionMode: z.enum(["pooled", "fresh"]).optional(),
  workspaceRoot: z.string(),
}).strict();
export type StressWorkerSpec = z.infer<typeof StressWorkerSpecSchema>;

/** 成功 shard 回传的原始样本批（样本结构与其余 StressSample 同构，D1：合并后统一算分位）。 */
export const ShardResultSchema = z.object({
  protocolVersion: z.literal(2),
  ok: z.literal(true),
  shardId: z.string(),
  samples: z.array(StressSampleSchema),
  generator: StressGeneratorSchema,
  measurementWindow: StressMeasurementWindowSchema,
}).strict().superRefine((result, ctx) => {
  // v2 must carry the explicit Task-4 qualification bits. Legacy report
  // readers remain permissive, but a worker result cannot silently fall back
  // to legacy "all samples completed" semantics.
  result.samples.forEach((sample, index) => {
    if (sample.requestStarted === undefined) {
      ctx.addIssue({ code: "custom", path: ["samples", index, "requestStarted"], message: "v2 sample requires requestStarted" });
    }
    if (sample.requestCompleted === undefined) {
      ctx.addIssue({ code: "custom", path: ["samples", index, "requestCompleted"], message: "v2 sample requires requestCompleted" });
    }
  });
});
export type ShardResult = z.infer<typeof ShardResultSchema>;

/** 失败 shard 回传的错误消息。 */
export const ShardFailureSchema = z.object({
  protocolVersion: z.literal(2),
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
  maxRps?: number;
}

/**
 * D3 分配纯函数：iterations 均分、余数给前 r 个（总数守恒）；并发每 shard
 * max(1, floor(C/n))、余数给前 r 个（每 shard 至少 1）；duration 模式各 shard 同截止各自跑满。
 * maxRps 仅保留单 shard 直传，多 shard 组合在此之前 fail-fast，绝不拆成独立 limiter。
 * 非法入参抛错：shards 非正整数、终止条件缺失、iterations 少于 shards（无法保证每 shard 至少 1 迭代）。
 */
export function planShards(
  share: { concurrency: number; maxIterations?: number; durationMs?: number; maxRps?: number },
  shards: number,
): ShardPlan[] {
  if (!Number.isSafeInteger(shards) || shards < 1) {
    throw new Error(`shards 必须为正整数，收到 ${shards}`);
  }
  if (!Number.isSafeInteger(share.concurrency) || share.concurrency < 1) {
    throw new Error(`concurrency 必须为正 safe integer，收到 ${share.concurrency}`);
  }
  if (share.maxIterations === undefined && share.durationMs === undefined) {
    // 与 StressRunner 口径同文案。
    throw new Error("压测终止条件缺失：maxIterations 与 durationMs 必须给其一");
  }
  if (share.maxRps !== undefined && (!Number.isFinite(share.maxRps) || share.maxRps <= 0)) {
    throw new Error(`maxRps 必须为正数，收到 ${share.maxRps}`);
  }
  if (shards > share.concurrency) {
    throw new Error(`shards 不能大于 concurrency（${share.concurrency}）`);
  }
  if (shards > 1 && share.maxRps !== undefined) {
    throw new Error("多 shard + maxRps 不受支持：无法证明全局滑动窗口上限");
  }
  if (share.durationMs !== undefined && (!Number.isFinite(share.durationMs) || share.durationMs <= 0 || share.durationMs > Number.MAX_SAFE_INTEGER)) {
    throw new Error(`durationMs 必须为有限正数且不可溢出，收到 ${share.durationMs}`);
  }
  if (share.maxIterations !== undefined && (!Number.isSafeInteger(share.maxIterations) || share.maxIterations <= 0)) {
    throw new Error(`maxIterations 必须为正 safe integer，收到 ${share.maxIterations}`);
  }
  if (share.maxIterations !== undefined && share.maxIterations < shards) {
    // 防 0 迭代 shard（均分后空份额会违反 StressWorkerSpecSchema 正整数约束），fail-fast。
    throw new Error(`shards 不能大于总迭代数（${share.maxIterations}）`);
  }
  const iterBase = share.maxIterations === undefined ? 0 : Math.floor(share.maxIterations / shards);
  const iterRemainder = share.maxIterations === undefined ? 0 : share.maxIterations % shards;
  const plans: ShardPlan[] = [];
  for (let i = 0; i < shards; i += 1) {
    plans.push({
      concurrency: Math.max(1, Math.floor(share.concurrency / shards) + (i < share.concurrency % shards ? 1 : 0)),
      ...(share.maxIterations !== undefined ? { maxIterations: iterBase + (i < iterRemainder ? 1 : 0) } : {}),
      ...(share.durationMs !== undefined ? { durationMs: share.durationMs } : {}),
      ...(share.maxRps !== undefined
        ? { maxRps: share.maxRps }
        : {}),
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
  safetyRun?: Partial<StressSafetyRun>;
}

/** 协调器 specBase：除 protocolVersion/shardId 外的完整 worker 规格（并发与终止条件为总额，按 shard 拆分）。 */
export type StressWorkerSpecBase = Omit<StressWorkerSpec, "protocolVersion" | "shardId">;

function specBaseToThresholds(spec: StressWorkerSpecBase): StressThresholds | undefined {
  const thresholds: StressThresholds = {
    ...(spec.maxErrorRate !== undefined ? { maxErrorRate: spec.maxErrorRate } : {}),
    ...(spec.maxAssertionFailureRate !== undefined ? { maxAssertionFailureRate: spec.maxAssertionFailureRate } : {}),
    ...(spec.maxP95Ms !== undefined ? { maxP95Ms: spec.maxP95Ms } : {}),
    ...(spec.minRps !== undefined ? { minRps: spec.minRps } : {}),
  };
  return Object.keys(thresholds).length > 0 ? thresholds : undefined;
}

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

/** 报告组装（D1/D6）：合并样本一次 computeReport（跨 shard 分位精确）+ 挂 distributed 段；无失败时省略 shardErrors。 */
export function mergeStressReport(
  samples: StressSample[],
  distributed: StressDistributed,
  meta: ComputeReportOptions,
): StressReport {
  const report = computeReport(samples, meta);
  report.distributed = {
    protocolVersion: 2,
    dataComplete: distributed.dataComplete,
    shards: distributed.shards,
    perShard: distributed.perShard,
    ...(distributed.shardErrors !== undefined && distributed.shardErrors.length > 0
      ? { shardErrors: distributed.shardErrors }
      : {}),
  };
  const safetyTargets = samples
    .map((sample) => sample.safety)
    .filter((target): target is NonNullable<typeof target> => target !== undefined);
  const uniqueSafety = safetyTargets.filter((target, index, all) => all.findIndex((candidate) => candidate.origin === target.origin) === index);
  const safetyRun: StressSafetyRun = {
    requestedConcurrency: meta.safetyRun?.requestedConcurrency ?? meta.concurrency,
    effectiveConcurrency: meta.safetyRun?.effectiveConcurrency ?? meta.concurrency,
    requestedMaxRps: meta.safetyRun?.requestedMaxRps ?? null,
    effectiveMaxRps: meta.safetyRun?.effectiveMaxRps ?? null,
    connectionMode: meta.safetyRun?.connectionMode ?? meta.connectionMode ?? "pooled",
  };
  report.safety = {
    targetOrigins: uniqueSafety,
    availability: uniqueSafety.length === 0 ? "unavailable" : (distributed.dataComplete ? "available" : "partial"),
    ...(uniqueSafety.length === 0 ? { unavailableReason: "没有成功 shard 提供目标安全采集" } : {}),
    run: safetyRun,
  };
  return report;
}

/**
 * 多 shard 协调器：planShards 拆份额 → 并发 spawn 全部（allSettled 收集，单 shard 超时/抛错/
 * 协议坏输出均归入该 shard 失败，D4）→ 成功样本合并挂 distributed 段。任一 shard 失败不抛，
 * 失败数随结果返回供 CLI 决定退出码。
 * 顺序口径：perShard 与 shardErrors 均按 shard 下标序（shard-0、shard-1…）稳定输出，与完成时序无关。
 */
export class DistributedStressCoordinator {
  async run(specBase: StressWorkerSpecBase, opts: DistributedRunOptions): Promise<CoordinatorRunResult> {
    const { shards, spawnWorker } = opts;
    const shardTimeoutMs = opts.shardTimeoutMs ?? 300_000;
    const plans = planShards(specBase, shards);

    const specs = plans.map((plan, i): StressWorkerSpec => {
      const spec: StressWorkerSpec = { ...specBase, protocolVersion: 2, shardId: `shard-${i}`, concurrency: plan.concurrency };
      if (plan.maxIterations !== undefined) spec.maxIterations = plan.maxIterations;
      if (plan.durationMs !== undefined) spec.durationMs = plan.durationMs;
      if (plan.maxRps !== undefined) spec.maxRps = plan.maxRps;
      // 自产协议消息过 schema：specBase 非法（如终止条件缺失）在此暴露。
      return StressWorkerSpecSchema.parse(spec);
    });

    // Promise.resolve 包一层：spawnWorker 同步抛错同样进入 rejected，归入该 shard 失败。
    const attempts = await Promise.allSettled(
      specs.map((spec) => withTimeout(Promise.resolve().then(() => spawnWorker(spec)), spec.shardId, shardTimeoutMs)),
    );
    const merged: StressSample[] = [];
    const perShard: StressDistributed["perShard"] = [];
    const shardErrors: { shardId: string; error: string }[] = [];
    const generators: StressGeneratorMetrics[] = [];
    let unavailableGeneratorCount = 0;
    const measurementWindows: StressMeasurementWindow[] = [];
    const seenShardIds = new Set<string>();
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
        } else if (parsed.data.shardId !== spec.shardId) {
          attempt = { ok: false, error: `协议错误[shard_id_mismatch]：期望 ${spec.shardId}，实际 ${parsed.data.shardId}` };
        } else if (seenShardIds.has(parsed.data.shardId)) {
          attempt = { ok: false, error: `协议错误[duplicate_shard_id]：重复回传 ${parsed.data.shardId}` };
        } else if (!parsed.data.ok) {
          attempt = { ok: false, error: parsed.data.error };
        } else {
          seenShardIds.add(parsed.data.shardId);
          attempt = { ok: true, result: parsed.data };
        }
      }

      if (!attempt.ok) {
        shardErrors.push({ shardId: spec.shardId, error: attempt.error });
        return;
      }
      const samples = attempt.result.samples;
      const expectedEligible = samples.filter(isEligibleCompletedAttempt).length;
      if (attempt.result.measurementWindow.eligibleCompletedAttempts !== expectedEligible) {
        shardErrors.push({
          shardId: spec.shardId,
          error: `协议错误[eligible_count_mismatch]：声明 ${attempt.result.measurementWindow.eligibleCompletedAttempts}，实际 ${expectedEligible}`,
        });
        return;
      }
      if (samples.length === 0) {
        // Empty successful shard still has a real Task-5 collector snapshot;
        // preserve it so the no-data report remains a valid current report.
        if (attempt.result.generator.availability === "unavailable") unavailableGeneratorCount += 1;
        else generators.push(attempt.result.generator);
        perShard.push({
          shardId: spec.shardId,
          totalRequests: 0,
          ok: 0,
          failed: 0,
          rps: 0,
          generator: attempt.result.generator,
          measurementWindow: attempt.result.measurementWindow,
          safety: { targetOrigins: [] },
        });
        shardErrors.push({ shardId: spec.shardId, error: `协议错误[NO_DATA]：shard ${spec.shardId} 未返回可评估样本` });
        return;
      }
      merged.push(...samples);
      if (attempt.result.generator.availability === "unavailable") unavailableGeneratorCount += 1;
      else generators.push(attempt.result.generator);
      measurementWindows.push(attempt.result.measurementWindow);
      const okCount = samples.filter((s) => s.ok).length;
      perShard.push({
        shardId: spec.shardId,
        totalRequests: samples.length,
        ok: okCount,
        failed: samples.length - okCount,
        rps: measurementWindowDurationMs(attempt.result.measurementWindow) > 0
          ? expectedEligible / (measurementWindowDurationMs(attempt.result.measurementWindow) / 1000)
          : 0,
        generator: attempt.result.generator,
        measurementWindow: attempt.result.measurementWindow,
        safety: safetyForSamples(samples) ?? { targetOrigins: [] },
      });
      successConcurrency += plans[i].concurrency;
    });

    // 报告 concurrency = 各成功 shard 分得并发之和；无成功 shard 时回退为分配总额
    // （StressReportSchema 要求正整数，D4 要求全失败仍落盘可回读）。
    const concurrency = successConcurrency > 0
      ? successConcurrency
      : plans.reduce((sum, plan) => sum + plan.concurrency, 0);

    const dataComplete = shardErrors.length === 0;
    const measurementWindow = unionMeasurementWindows(measurementWindows);
    const startedAt = measurementWindow?.startWallMs ?? 0;
    const finishedAt = measurementWindow?.endWallMs ?? 0;
    const report = mergeStressReport(
      merged,
      { shards, perShard, shardErrors, dataComplete, protocolVersion: 2 },
      {
        concurrency, startedAt, finishedAt,
        thresholds: specBaseToThresholds(specBase),
        connectionMode: specBase.connectionMode,
        ...(measurementWindow ? { measurementWindow } : {}),
        safetyRun: {
          requestedConcurrency: opts.safetyRun?.requestedConcurrency ?? specBase.concurrency,
          effectiveConcurrency: opts.safetyRun?.effectiveConcurrency ?? concurrency,
          requestedMaxRps: opts.safetyRun?.requestedMaxRps ?? specBase.maxRps ?? null,
          effectiveMaxRps: opts.safetyRun?.effectiveMaxRps ?? specBase.maxRps ?? null,
          connectionMode: opts.safetyRun?.connectionMode ?? specBase.connectionMode ?? "pooled",
        },
      },
    );
    if (generators.length > 0) {
      report.generator = aggregateGeneratorMetrics(generators, dataComplete && unavailableGeneratorCount === 0 ? "available" : "partial");
    } else {
      report.generator = { availability: "unavailable", unavailableReason: "所有 shard 均未返回可用 generator 指标" };
    }
    if (!dataComplete || (report.eligibleCompletedAttempts ?? 0) === 0) {
      const violations = report.verdict?.violations ?? [];
      const noDataViolation = (report.eligibleCompletedAttempts ?? 0) === 0 && !violations.some((violation) => violation.metric === "noData")
        ? [{ metric: "noData" as const, actual: 0, expected: 1, message: "NO_DATA: 没有可评估的压测样本" }]
        : [];
      report.verdict = {
        passed: false,
        violations: [
          ...violations,
          ...noDataViolation,
          ...(!dataComplete ? [{ metric: "businessFailures" as const, actual: shardErrors.length, expected: 0, message: `${shardErrors.length} shard(s) failed; report data is incomplete` }] : []),
        ],
      };
    }
    const current = CurrentStressReportSchema.safeParse(report);
    if (!current.success) {
      const detail = current.error.issues.map((issue) => `${issue.path.join(".") || "(根字段)"}: ${issue.message}`).join("; ");
      throw new Error(`压测报告契约校验失败[current_report_invalid]：${detail}`);
    }
    return { report: current.data, shardFailureCount: shardErrors.length };
  }
}

function safetyForSamples(samples: StressSample[]): StressDistributed["perShard"][number]["safety"] {
  const targets = samples
    .map((sample) => sample.safety)
    .filter((target): target is NonNullable<typeof target> => target !== undefined);
  const unique = targets.filter((target, index, all) => all.findIndex((candidate) => candidate.origin === target.origin) === index);
  return unique.length > 0 ? { targetOrigins: unique } : undefined;
}

/** Union worker-owned windows using comparable wall timestamps.  If a worker's
 * wall clock moves backwards, its monotonic duration supplies a synthetic end. */
function unionMeasurementWindows(windows: StressMeasurementWindow[]): StressMeasurementWindow | undefined {
  if (windows.length === 0) return undefined;
  const intervals = windows.map((window) => ({
    start: window.startWallMs,
    end: window.endWallMs >= window.startWallMs
      ? window.endWallMs
      : window.startWallMs + window.monotonicDurationMs,
    monotonicDurationMs: window.monotonicDurationMs,
    eligibleCompletedAttempts: window.eligibleCompletedAttempts,
  })).sort((a, b) => a.start - b.start);
  let unionStart = intervals[0]!.start;
  let unionEnd = intervals[0]!.end;
  let eligibleCompletedAttempts = intervals[0]!.eligibleCompletedAttempts;
  for (const interval of intervals.slice(1)) {
    unionStart = Math.min(unionStart, interval.start);
    unionEnd = Math.max(unionEnd, interval.end);
    eligibleCompletedAttempts += interval.eligibleCompletedAttempts;
  }
  const wallDuration = Math.max(0, unionEnd - unionStart);
  const monotonicDurationMs = wallDuration > 0
    ? wallDuration
    : Math.max(...intervals.map((interval) => interval.monotonicDurationMs));
  return {
    startWallMs: unionStart,
    endWallMs: unionEnd,
    monotonicDurationMs,
    eligibleCompletedAttempts,
  };
}

/** Aggregate independent process metrics without averaging resource peaks. */
function aggregateGeneratorMetrics(generators: StressGeneratorMetrics[], availability: "available" | "partial"): StressGeneratorMetrics {
  const reasons: StressGeneratorMetrics["reasons"] = [];
  for (const generator of generators) {
    for (const reason of generator.reasons ?? []) if (!reasons.includes(reason)) reasons.push(reason);
  }
  return {
    availability,
    cpuUserMs: generators.reduce((sum, generator) => sum + (generator.cpuUserMs ?? 0), 0),
    cpuSystemMs: generators.reduce((sum, generator) => sum + (generator.cpuSystemMs ?? 0), 0),
    cpuPercent: Math.max(...generators.map((generator) => generator.cpuPercent ?? 0)),
    // RSS start describes the combined baseline footprint; peak is explicitly a process peak.
    rssStartBytes: generators.reduce((sum, generator) => sum + (generator.rssStartBytes ?? 0), 0),
    rssPeakBytes: Math.max(...generators.map((generator) => generator.rssPeakBytes ?? 0)),
    eventLoopDelayP95Ms: Math.max(...generators.map((generator) => generator.eventLoopDelayP95Ms ?? 0)),
    schedulerBacklogMax: Math.max(...generators.map((generator) => generator.schedulerBacklogMax ?? 0)),
    saturated: generators.some((generator) => generator.saturated === true),
    reasons,
    limits: {
      cpuPercent: Math.max(...generators.map((generator) => generator.limits?.cpuPercent ?? 0)),
      eventLoopDelayP95Ms: Math.max(...generators.map((generator) => generator.limits?.eventLoopDelayP95Ms ?? 0)),
      schedulerBacklog: Math.max(...generators.map((generator) => generator.limits?.schedulerBacklog ?? 0)),
    },
  };
}
