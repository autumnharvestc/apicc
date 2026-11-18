import type { Environment, Project } from "./model.js";
import type { DeepReadonly } from "../assets/context.js";

/** The selected leaf is identified by ID. Only the extends reference uses a name. */
export function environmentLayers(env: DeepReadonly<Environment>, project: DeepReadonly<Project>): DeepReadonly<Environment>[] {
  const chain: DeepReadonly<Environment>[] = [];
  const seen = new Set<string>([env.name]);
  let cur: DeepReadonly<Environment> | undefined = env;
  while (cur) {
    chain.push(cur);
    const parentName: string | undefined = cur.extends;
    if (!parentName || seen.has(parentName)) break;
    seen.add(parentName);
    const parents: DeepReadonly<Environment>[] = project.environments.filter(item => item.name === parentName);
    if (parents.length > 1) throw new Error(`Ambiguous parent environment: ${parentName}`);
    cur = parents[0];
  }
  return chain;
}
export function envChain(env: DeepReadonly<Environment>, project: DeepReadonly<Project>): string[] {
  return environmentLayers(env, project).map(layer => layer.name);
}

/**
 * 按继承链从根到叶合并各环境变量为一层（子环境同名变量覆盖父环境）。
 * 未选环境时返回空对象。这是环境变量的唯一合并口径（规格 §3.1/§6）：
 * CollectionRunner 的解析层/pm.environment 与工作流条件求值上下文 env 必须同源，杜绝继承链在条件中断裂。
 */
export function mergedEnvVars(env: DeepReadonly<Environment> | undefined, project: DeepReadonly<Project>): Record<string, string> {
  if (!env) return {};
  const vars: Record<string, string> = {};
  for (const layer of environmentLayers(env, project).reverse()) {
    Object.assign(vars, layer.variables);
  }
  return vars;
}
