import type { ExecutableRequest, ProtocolClient } from "../plugin/types.js";
import { computeReport } from "./aggregate.js";
import type { StressReport, StressSample } from "./model.js";

/**
 * StressRunner 构造参数。buildRequest 为工厂函数：每次采样调用一次产出新请求对象，
 * 调用方闭包内做变量解析（动态变量如 {{$uuid}} 每请求变化）。
 */
export interface StressRunnerOptions {
  client: ProtocolClient;
  buildRequest: () => ExecutableRequest;
}

export interface StressRunOptions {
  concurrency: number;
  /** 总迭代数上限；与 durationMs 至少给其一（都给时先到先停）。 */
  maxIterations?: number;
  /** 持续时长毫秒；与 maxIterations 至少给其一（都给时先到先停）。 */
  durationMs?: number;
  /** aborted → 停止发起新采样（MVP 简化：不中断进行中的请求）。 */
  signal?: AbortSignal;
}

/** 采样执行超时口径：连接 10s、整体 30s。 */
const EXECUTE_OPTS = { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 };

/**
 * 并发池执行器：N 个异步 worker 共享剩余迭代计数与截止时间，逐采样执行请求并记录样本，
 * 全部 worker 结束后 computeReport 聚合。
 * 已知边界：样本全量驻留内存（十万条 × ~64B ≈ 6MB 量级），MVP 可接受。
 */
export class StressRunner {
  constructor(private readonly opts: StressRunnerOptions) {}

  async run(runOpts: StressRunOptions): Promise<StressReport> {
    const { concurrency, maxIterations, durationMs, signal } = runOpts;
    if (maxIterations === undefined && durationMs === undefined) {
      throw new Error("压测终止条件缺失：maxIterations 与 durationMs 必须给其一");
    }
    // 报告 schema 要求 concurrency 为正整数（StressReportSchema），前置拦截避免产出非法报告。
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`concurrency 必须为正整数，收到 ${concurrency}`);
    }

    const startedAt = Date.now();
    const deadline = durationMs === undefined ? Number.POSITIVE_INFINITY : startedAt + durationMs;
    // 迭代模式剩余数：检查与递减之间无 await（JS 单线程），同步计数天然原子。
    let remaining = maxIterations;
    const samples: StressSample[] = [];

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal?.aborted) break;
        if (remaining !== undefined) {
          if (remaining <= 0) break;
          remaining -= 1; // 先占坑再执行：保证恰好发起 maxIterations 次
        }
        if (Date.now() >= deadline) break;
        const request = this.opts.buildRequest(); // 工厂抛错（如变量循环引用）→ run 整体失败（fail-fast）
        const t0 = performance.now();
        try {
          const res = await this.opts.client.execute(request, EXECUTE_OPTS);
          // ok 口径 = 2xx 且无 error（任务 1 交接统一）；非 2xx 不写 error，HTTP_${status} 分类由 aggregate 派生。
          samples.push({
            timeMs: performance.now() - t0,
            status: res.status,
            // M5 D3：WS 响应 status=握手 HTTP 状态，101 即成功——豁免于 HTTP 2xx 口径。
            ok: (res.status >= 200 && res.status < 300) || res.status === 101,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          samples.push({ timeMs: performance.now() - t0, status: 0, ok: false, error: message });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return computeReport(samples, { concurrency, startedAt, finishedAt: Date.now() });
  }
}
