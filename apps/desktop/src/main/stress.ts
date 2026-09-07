import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  builtinAuthProviders,
  buildStressRequest,
  createVariableResolver,
  httpClient,
  mergedEnvVars,
  StressRunner,
  type ApiDefinition,
  type ProtocolClient,
  type StressReport,
} from "@apicc/core";
import { resolveEnv, workspaceRunsDir } from "./debug.js";
import type { createSession } from "./session.js";
import type { StressRunInput, StressRunOutput } from "../shared/types.js";

type Session = ReturnType<typeof createSession>;

/**
 * 控制器依赖：client/writeReport 供测试注入假实现（默认真实 httpClient 与 writeFileSync），
 * 生产无需关心。writeReport 只包写盘动作（降级口径在 persist 内统一处理）。
 */
export interface StressControllerDeps { client?: ProtocolClient; writeReport?: (path: string, content: string) => void }

/**
 * 压测控制器（M2-D3 任务 1，规格 §2 D10）：main 进程执行接口级压测，闭包持单活动 run
 * 的 AbortController。变量 resolver 组装对照 CLI run-stress action（环境继承层序一致：
 * [环境(继承链经 mergedEnvVars 合并), 集合, 项目, 全局]），全部用 core 导出实现，
 * 不依赖 cli 包。stop 走 StressRunner 既有 signal 语义：abort = 停止发起新采样、
 * 等在途请求完成后聚合出部分报告。
 */
export function createStressController(session: Session, deps: StressControllerDeps = {}) {
  // 单活动 run（D10 并发二次启动拒绝）：finished 在落盘后 resolve，run/stop 共享同一收尾。
  let active: { controller: AbortController; finished: Promise<StressRunOutput> } | null = null;

  /** 收尾清理：仅当仍是本次 run 时清空（防误清新活动）；独立函数避免闭包内 let 收窄问题。 */
  function clearActive(controller: AbortController): void {
    if (active?.controller === controller) active = null;
  }

  /**
   * 报告落盘 runs 目录（D11，与 CLI 约定一致：stress-<apiId>-<Date.now()>.json）。
   * 落盘降级不影响报告返回，与集合运行口径一致（core Runner 落盘失败仅告警仍返回完整
   * 结果）：写盘异常 console.warn（含文件路径与原因）后 file 省略返回报告。
   * runsDir 在 run 启动时快照，工作区切换后部分报告仍落回原工作区目录。
   * 返回前深拷贝报告（IPC 载荷 DataCloneError 防御，全局约束）。
   */
  function persist(root: string, apiId: string, report: StressReport): StressRunOutput {
    const clone: StressReport = structuredClone(report);
    const runsDir = workspaceRunsDir(root);
    const file = `stress-${apiId}-${Date.now()}.json`;
    try {
      mkdirSync(runsDir, { recursive: true });
      (deps.writeReport ?? ((path: string, content: string) => writeFileSync(path, content, "utf8")))(join(runsDir, file), JSON.stringify(report, null, 2));
      return { report: clone, file };
    } catch (e) {
      console.warn(`压测报告落盘失败（${join(runsDir, file)}）: ${e instanceof Error ? e.message : String(e)}`);
      return { report: clone };
    }
  }

  async function run(input: StressRunInput): Promise<StressRunOutput> {
    if (active) throw new Error("已有压测进行中");
    const loc = session.locateApi(input.apiId);
    if (!loc) throw new Error(`未找到接口: ${input.apiId}`);
    // 用例门（同 sendDebug 断言口径）：压测请求构造只依赖接口定义，但目标用例必须存在。
    const api: ApiDefinition = { ...loc.api, cases: loc.api.cases.filter((c) => c.id === input.caseId) };
    if (api.cases.length === 0) throw new Error(`用例不存在: ${input.caseId}`);
    const env = resolveEnv(loc.project, input.envName ?? undefined);
    // locateApi 内 ensureOpen 已保证会话打开，root/workspace 非空（与 debug.ts 运行链路同款断言）。
    const root = session.root!;
    // M9-B 与集合运行同口径：环境按集合的前置 URL 注入 baseUrl 变量；工作区全局变量为最低层。
    const baseUrl = env?.baseUrls?.[loc.collection.id];
    const envVars = { ...mergedEnvVars(env, loc.project), ...(baseUrl ? { baseUrl } : {}) };
    const resolver = createVariableResolver({
      layers: [envVars, loc.collection.variables, loc.project.variables, session.workspace!.variables, session.workspace!.globals?.variables ?? {}],
    });
    // 桌面压测面协议守卫（M5 终审）：StressRunner 是单 client 面，桌面控制器钉死
    // httpClient（协议感知的按 protocol 分发只有 CLI run-stress 有），而
    // buildStressRequest 已透传 protocol/envelope/soapAction——非 HTTP 接口若放行，
    // SOAP 会以空 body/无 SOAPAction 的普通 POST 错协议执行且可能产出绿色报告，
    // WS 则逐样本抛 scheme 错误。此处 fail-fast 拒绝，与「压测面板仅 HTTP」备案口径
    // （M5 规格 D9）及 CLI 侧协议感知 fail-fast 对齐。
    if ((api.protocol ?? "http") !== "http") {
      throw new Error("桌面压测面板当前仅支持 HTTP 接口（WS/SOAP 压测请使用 CLI run-stress）");
    }
    const runner = new StressRunner({
      client: deps.client ?? httpClient,
      // 每次采样重跑工厂：动态变量（如 {{$uuid}}）逐请求变化，与 CLI run-stress 同口径。
      buildRequest: () => buildStressRequest(api, resolver, builtinAuthProviders, loc.project.globals),
    });
    const controller = new AbortController();
    const finished = (async (): Promise<StressRunOutput> => {
      try {
        // maxIterations/durationMs 的 null（渲染层「清空」惯例）归一为 undefined；
        // 二者都缺时 StressRunner 抛「压测终止条件缺失：maxIterations 与 durationMs 必须给其一」。
        const report = await runner.run({
          concurrency: input.concurrency,
          maxIterations: input.maxIterations ?? undefined,
          durationMs: input.durationMs ?? undefined,
          signal: controller.signal,
        });
        return persist(root, api.id, report);
      } finally {
        clearActive(controller);
      }
    })();
    active = { controller, finished };
    return finished;
  }

  async function stop(): Promise<StressRunOutput> {
    if (!active) throw new Error("没有进行中的压测");
    active.controller.abort();
    // 等在途请求完成 → StressRunner 聚合部分报告 → 落盘（finished 内单一收尾）。
    return active.finished;
  }

  /** 会话关闭/工作区切换（ipc 层 ws:open/ws:create 清理点）时中止活动 run；不等待收尾。 */
  function abortActive(): void {
    active?.controller.abort();
  }

  return { run, stop, abortActive };
}
