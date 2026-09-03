import type { Environment, Project } from "./model.js";

/** 返回环境名称及其全部祖先名称（extends 按环境名引用）。无环保障由调用方 schema 外校验。 */
export function envChain(env: Environment, project: Project): string[] {
  const byName = new Map(project.environments.map((e) => [e.name, e]));
  const chain: string[] = [];
  const seen = new Set<string>([env.name]);
  let cur: Environment | undefined = env;
  while (cur) {
    chain.push(cur.name);
    const parentName = cur.extends;
    if (!parentName || seen.has(parentName)) break;
    seen.add(parentName);
    cur = byName.get(parentName);
  }
  return chain;
}

/**
 * 按继承链从根到叶合并各环境变量为一层（子环境同名变量覆盖父环境）。
 * 未选环境时返回空对象。这是环境变量的唯一合并口径（规格 §3.1/§6）：
 * CollectionRunner 的解析层/pm.environment 与工作流条件求值上下文 env 必须同源，杜绝继承链在条件中断裂。
 */
export function mergedEnvVars(env: Environment | undefined, project: Project): Record<string, string> {
  if (!env) return {};
  const byName = new Map(project.environments.map((e) => [e.name, e]));
  const vars: Record<string, string> = {};
  for (const name of [...envChain(env, project)].reverse()) {
    Object.assign(vars, byName.get(name)?.variables ?? {});
  }
  return vars;
}
