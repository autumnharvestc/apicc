import type { ApiDefinition, Environment, PluginRegistry, Project, RunResult, CaseOutcome } from "@apicc/core";
import { CollectionRunner, createDefaultRegistry, createEventBus } from "@apicc/core";
import { join } from "node:path";
import type { createSession } from "./session.js";
import type { ResponseSnapshot } from "../shared/types.js";

type Session = ReturnType<typeof createSession>;

/** 默认运行注册中心（内置；M7-B 任务 2 起运行频道由 ipc 层注入插件扩展 registry 覆盖）。 */
const defaultRegistry = createDefaultRegistry();
const timeouts = { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 };

export interface DebugResult { run: RunResult; outcome: CaseOutcome; response?: ResponseSnapshot }

/** 运行历史落盘目录：固定于工作区根 .apicc/runs（与 CLI 默认 runsDir 一致，规格 §8）。 */
export function workspaceRunsDir(root: string): string {
  return join(root, ".apicc", "runs");
}

/**
 * 集合运行（任务 6）：完整集合走 CollectionRunner（前置/后置脚本、断言、数据驱动、
 * 环境继承语义与 CLI 一致），结果经 opts.runsDir 固定落盘 .apicc/runs 供历史读回。
 * registry 可注入（M7-B 任务 2）：ipc 层传插件运行时 registry（内置 + 插件贡献），
 * 缺省内置注册中心（既有测试零扰动）。
 */
export async function runCollection(
  session: Session,
  input: { collectionId: string; envName?: string },
  registry: PluginRegistry = defaultRegistry,
): Promise<RunResult> {
  const loc = session.locateCollection(input.collectionId);
  if (!loc) throw new Error(`未找到集合: ${input.collectionId}`);
  const env = resolveEnv(loc.project, input.envName);
  const runner = new CollectionRunner({ registry, bus: createEventBus(), timeouts, failFast: false });
  // locateCollection 内 ensureOpen 已保证会话打开，root/workspace 非空（与 sendDebug 同款断言）。
  return runner.run(loc.collection, env, loc.project, session.workspace!, { runsDir: workspaceRunsDir(session.root!) });
}

/**
 * 按环境名解析项目环境（审查修复）：envName 为 undefined/空 = 无环境运行；
 * 提供了 envName 却未命中时显式抛「未找到环境」——静默降级为无环境运行会让用户
 * 误信已按所选环境完成验证（与 session「未找到」错误契约对齐）。
 * 导出复用（M2-D3 任务 1）：stress.ts 的环境解析与此同源，不复制实现。
 */
export function resolveEnv(project: Project, envName: string | undefined): Environment | undefined {
  if (!envName) return undefined;
  const env = project.environments.find((e) => e.name === envName);
  if (!env) throw new Error(`未找到环境: ${envName}`);
  return env;
}

/** 调试 = 用合成单接口集合走完整 Runner 语义（前置/后置脚本、断言、变量解析一致，规格 §7.1）。
 *  registry 可注入（M7-B 任务 2）：ipc 层传插件运行时 registry，缺省内置（既有测试零扰动）。 */
export async function sendDebug(
  session: Session,
  input: { apiId: string; caseId: string; envName?: string },
  registry: PluginRegistry = defaultRegistry,
): Promise<DebugResult> {
  const loc = session.locateApi(input.apiId);
  if (!loc) throw new Error(`未找到接口: ${input.apiId}`);
  const api: ApiDefinition = { ...loc.api, cases: loc.api.cases.filter((c) => c.id === input.caseId) };
  if (api.cases.length === 0) throw new Error(`用例不存在: ${input.caseId}`);
  const target = api.cases[0]!;
  const collection = {
    id: loc.collection.id, name: loc.collection.name, variables: loc.collection.variables,
    scripts: loc.collection.scripts, folders: [], apis: [api],
  };
  const env = resolveEnv(loc.project, input.envName);
  const project: Project = loc.project;
  // 单用例调试只取最后一次 afterResponse 快照（事件可选增量 headers/bodyText，规格 §5.2）。
  let response: ResponseSnapshot | undefined;
  const bus = createEventBus();
  const off = bus.on("afterResponse", (p) => {
    response = { status: p.status, headers: p.headers ?? {}, bodyText: p.bodyText ?? "", timeMs: p.timeMs };
  });
  const runner = new CollectionRunner({ registry, bus, timeouts, failFast: false });
  try {
    const run = await runner.run(collection, env, project, session.workspace!, {});
    // env-scope 用例防护（宽审查修复 1）：无环境时 Runner 过滤掉非 base 用例 → run.cases
    // 为空，直接取 [0] 会把 undefined 经 IPC 传给渲染层，打穿 ResponseViewer 模板。
    if (run.cases.length === 0) {
      const why = env ? `当前环境「${env.name}」的继承链不含该 scope` : "未选择环境";
      throw new Error(
        `用例「${target.name}」的 scope（${target.scope}）不适用于当前调试环境（${why}）` +
          `——请在用例面板将其 scope 改为 base，或为调试选择环境`,
      );
    }
    const outcome = run.cases[0]!;
    return { run, outcome, response };
  } finally {
    off();
  }
}
