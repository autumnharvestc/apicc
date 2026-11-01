import type { MemberExecutionClient, MemberExecutionContext, OnlineJob } from "@apicc/execution/client";
import type { McpSource, McpRun, McpReport, McpProjectRead } from "./source.js";

interface OnlineCapability {
  kind: "online";
  generation: string;
  authenticate(signal: AbortSignal): Promise<void>;
  isInvalid(): boolean;
  contextFor(projectId: string): MemberExecutionContext;
  member: MemberExecutionClient;
  rememberAgentJob(projectId: string, job: OnlineJob): void;
}
interface LocalCapability {
  kind: "local";
  root: string;
  authenticate(signal: AbortSignal): Promise<void>;
  isInvalid(): boolean;
}
export type McpExecutionCapability = OnlineCapability | LocalCapability;
const capabilities = new WeakMap<McpSource, McpExecutionCapability>();
export interface OwnedRunReader {
  revision(): number;
  list(projectId: string): McpRun[];
  get(runId: string): McpRun | undefined;
  report(runId: string, project: McpProjectRead, signal: AbortSignal): Promise<McpReport>;
}
const readers = new WeakMap<McpSource, Set<OwnedRunReader>>();
export function registerOwnedRunReader(source: McpSource, reader: OwnedRunReader): () => void {
  const owned = readers.get(source) ?? new Set<OwnedRunReader>();
  readers.set(source, owned); owned.add(reader);
  return () => { owned.delete(reader); };
}
export function ownedRunReadersFor(source: McpSource): readonly OwnedRunReader[] { return [...(readers.get(source) ?? [])]; }

// Trusted Node wiring only: never a source DTO, tool parameter or tool result.
export function registerExecutionCapability(source: McpSource, capability: McpExecutionCapability): void {
  capabilities.set(source, capability);
}
export function executionCapabilityFor(source: McpSource): McpExecutionCapability {
  const capability = capabilities.get(source);
  if (!capability) throw new Error("mcp-execution-source-unavailable");
  return capability;
}
