import type { ContractProject } from "@apicc/core";
import type { TaskTarget } from "@apicc/execution/contract";
import type { InvocationOutput } from "@apicc/execution/host";
export const semanticIds: Record<string, string>;
export function semanticProject(baseUrl: string, scripts?: boolean, failing?: boolean): ContractProject;
export function semanticTarget(kind: string): TaskTarget;
export function semanticSummary(output: InvocationOutput): unknown;
export function collectRuntimeSemantics(): Promise<unknown>;
