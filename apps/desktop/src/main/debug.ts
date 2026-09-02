import type { ApiDefinition, Environment, Project, RunResult, CaseOutcome } from "@apicc/core";
import { CollectionRunner, createDefaultRegistry, createEventBus } from "@apicc/core";
import type { createSession } from "./session.js";

type Session = ReturnType<typeof createSession>;

const registry = createDefaultRegistry();
const timeouts = { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 };

export interface DebugResult { run: RunResult; outcome: CaseOutcome }

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
  const env: Environment | undefined = input.envName
    ? loc.project.environments.find((e) => e.name === input.envName)
    : undefined;
  const project: Project = loc.project;
  const runner = new CollectionRunner({ registry, bus: createEventBus(), timeouts, failFast: false });
  const run = await runner.run(collection, env, project, session.workspace!, {});
  const outcome = run.cases[0]!;
  return { run, outcome };
}
