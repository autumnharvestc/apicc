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
