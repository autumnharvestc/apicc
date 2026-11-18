import type { DeepReadonly } from "../assets/snapshot.js";
import type { ContractProject } from "../contract/workspace.js";
import type { Environment } from "./common.js";
import { environmentLayers } from "./envChain.js";

export interface ExecutionEnvironment {
  readonly environment?: DeepReadonly<Environment>;
  readonly chain: readonly string[];
  readonly variables: Record<string, string>;
  readonly baseUrl?: string;
}

export function selectEffectiveCases<T extends { readonly id: string; readonly scope: string }>(
  cases: readonly T[],
  chain: readonly string[],
  caseId?: string,
): T[] {
  const scopeRank = (scope: string): number => {
    if (scope === "base") return Number.MAX_SAFE_INTEGER;
    const index = chain.indexOf(scope);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const byId = new Map<string, T>();
  for (const testCase of cases) {
    if (testCase.scope !== "base" && !chain.includes(testCase.scope)) continue;
    if (caseId !== undefined && testCase.id !== caseId) continue;
    const previous = byId.get(testCase.id);
    if (!previous || scopeRank(testCase.scope) < scopeRank(previous.scope)) byId.set(testCase.id, testCase);
  }
  return [...byId.values()];
}

export function resolveExecutionEnvironment(
  project: DeepReadonly<ContractProject>,
  collectionId: string,
  environmentId?: string,
): ExecutionEnvironment {
  if (environmentId === undefined) return { chain: [], variables: {} };
  const environment = project.environments.find((candidate) => candidate.id === environmentId);
  if (!environment) throw new Error(`配置错误: 项目快照中不存在环境 ${environmentId}`);

  const layers = environmentLayers(environment, project);
  const chain = layers.map(layer => layer.name);
  const variables: Record<string, string> = {};
  let baseUrl: string | undefined;
  for (const layer of layers.reverse()) {
    Object.assign(variables, layer.variables);
    const candidate = layer.baseUrls[collectionId];
    if (candidate !== undefined) baseUrl = candidate;
  }
  if (baseUrl !== undefined) variables.baseUrl = baseUrl;

  return {
    environment,
    chain,
    variables,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}
