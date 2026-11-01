import type { AiSourceBinding, PluginRegistry, ProjectSnapshot, AiReadableReport } from "@apicc/core";
import { createLocalSource } from "./localSource.js";
import { createOnlineSource } from "./onlineSource.js";
import type { McpProfileDeps } from "./profiles.js";

export interface McpPage { limit?: number; cursor?: string }
export interface McpReportDiagnostic { code: "unreadable" | "unattributable"; count: number; scope: "source" }
export interface McpPageResult<T> { items: T[]; nextCursor?: string; diagnostics?: McpReportDiagnostic[] }
export interface McpProjectRead { snapshot: ProjectSnapshot; binding: AiSourceBinding; revision: string; preferenceKey: string; workspaceId: string; groupId: string; projectId: string }
export interface McpProjectRef { projectId: string; name: string; workspaceId: string; groupId: string }
export interface McpRun { runId: string; projectId: string; state: string; reportState: string; startedAt?: string | number; finishedAt?: string | number; definitionRevision?: string }
export interface McpReportSelection { bodySelection?: readonly string[] }
export interface McpRunFailure { reasonCode: string; executionFact: "not-started" | "uncertain" }
export type McpReport = { reportId: string; revision: string; project: McpProjectRead } &
  ({ report: AiReadableReport; failure?: never } | { failure: McpRunFailure; report?: never });
export interface McpSource {
  readonly identity: Readonly<{ kind: "local" | "online"; bindingId: string; rootIdentity?: string; serverIdentity?: string; memberIdentity?: string }>;
  projects(signal: AbortSignal): Promise<McpProjectRef[]>;
  readProject(projectId: string, signal: AbortSignal): Promise<McpProjectRead>;
  listRuns(projectId: string, page: McpPage, signal: AbortSignal): Promise<McpPageResult<McpRun>>;
  getRun(runId: string, signal: AbortSignal): Promise<McpRun>;
  getReport(runId: string, selection: McpReportSelection, signal: AbortSignal): Promise<McpReport>;
  close(): Promise<void>;
}
export type McpSourceOptions = McpProfileDeps & { registry?: PluginRegistry } & ({ workspace: string; onlineProfile?: never } | { workspace?: never; onlineProfile: string });
export async function createMcpSource(options: McpSourceOptions): Promise<McpSource> {
  if (Number(Boolean(options.workspace)) + Number(Boolean(options.onlineProfile)) !== 1) throw new Error("workspace 与 onlineProfile 互斥，必须选择 exactly one source");
  if (options.workspace) return createLocalSource(options.workspace, options.registry);
  return createOnlineSource(options.onlineProfile!, options);
}
