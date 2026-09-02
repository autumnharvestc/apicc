import type { ApiDefinition, Environment, Project, RunResult, CaseOutcome } from "@apicc/core";
import { CollectionRunner, createDefaultRegistry, createEventBus } from "@apicc/core";
import { join } from "node:path";
import type { createSession } from "./session.js";
import type { ResponseSnapshot } from "../shared/types.js";

type Session = ReturnType<typeof createSession>;

const registry = createDefaultRegistry();
const timeouts = { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 };

export interface DebugResult { run: RunResult; outcome: CaseOutcome; response?: ResponseSnapshot }

/** 运行历史落盘目录：固定于工作区根 .apicc/runs（与 CLI 默认 runsDir 一致，规格 §8）。 */
export function workspaceRunsDir(root: string): string {
  return join(root, ".apicc", "runs");
}

/**
 * 集合运行（任务 6）：完整集合走 CollectionRunner（前置/后置脚本、断言、数据驱动、
 * 环境继承语义与 CLI 一致），结果经 opts.runsDir 固定落盘 .apicc/runs 供历史读回。
 */
export async function runCollection(
  session: Session,
  input: { collectionId: string; envName?: string },
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
 */
function resolveEnv(project: Project, envName: string | undefined): Environment | undefined {
  if (!envName) return undefined;
  const env = project.environments.find((e) => e.name === envName);
  if (!env) throw new Error(`未找到环境: ${envName}`);
  return env;
}

/** 调试 = 用合成单接口集合走完整 Runner 语义（前置/后置脚本、断言、变量解析一致，规格 §7.1）。 */
export async function sendDebug(
  session: Session,
  input: { apiId: string; caseId: string; envName?: string },
): Promise<DebugResult> {
  const loc = session.locateApi(input.apiId);
  if (!loc) throw new Error(`未找到接口: ${input.apiId}`);
  const api: ApiDefinition = { ...loc.api, cases: loc.api.cases.filter((c) => c.id === input.caseId) };
  if (api.cases.length === 0) throw new Error(`用例不存在: ${input.caseId}`);
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
    const outcome = run.cases[0]!;
    return { run, outcome, response };
  } finally {
    off();
  }
}
