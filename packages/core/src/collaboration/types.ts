import type { JsonValue, SchemaNode } from "../contract/schemaNode.js";
import type { RunResult } from "../report/types.js";
import type { ReadableStressReport, StressReportV2 } from "../stress/reportV2.js";
import type { StressComparison } from "../stress/compare.js";
import type { DebugHistoryRecord } from "../debug/model.js";
import type { z } from 'zod';
import type { ArchivedRunExecutionWireSchema, ArchivedStressExecutionWireSchema } from './shared.js';

export type ArtifactKind = "document" | "report" | "debug-history" | "mock";
export type SourceTrust = "server-archive" | "member-claim" | "saved-contract";
export interface ProjectionPolicy {
  revision: number; includeEvidence: boolean;
  maxFieldBytes: number; maxEvidenceBytes: number; maxArtifactBytes: number;
  extraSensitiveHeaders: readonly string[]; extraSensitiveQuery: readonly string[];
  extraSensitiveFields: readonly string[]; extraSensitivePointers: readonly string[];
}
export interface PublicationSource { trust: SourceTrust; revision: string; digest: string }
export interface Limitation { code: string; path?: string }
export interface PublicParameter {
  id: string; location: "path" | "query" | "header" | "cookie"; name: string; schema: SchemaNode;
  required: boolean; enabled: boolean; description: string; value?: string;
}
export interface PublicExample { id: string; name: string; value: JsonValue }
export interface PublicResponse {
  id: string; status: string; description: string; headers: { name: string; value: string }[];
  content: { mediaType: string; schema?: SchemaNode; examples: PublicExample[] }[];
}
export interface PublicBody {
  kind: "none" | "json" | "xml" | "text" | "graphql" | "urlencoded" | "multipart" | "binary";
  content?: string; schema?: SchemaNode; fields?: { name: string; value: string; enabled: boolean }[];
}
export interface PublicDocumentApi {
  id: string; name: string; description: string; tags: string[]; version: string;
  status: "draft" | "published" | "deprecated"; collection: string; folders: string[];
  request: { protocol: "http" | "websocket" | "soap"; method?: string; path: string; parameters: PublicParameter[]; body?: PublicBody };
  responses: PublicResponse[]; documentation: string;
  caseSummaries: { name: string; scope: string; assertionCount: number }[];
  modelIds: string[]; componentIds: string[];
}
export type PublicComponent = { id: string; name: string; description: string } & (
  | { kind: "parameter"; parameter: Omit<PublicParameter, "id" | "enabled" | "value"> }
  | { kind: "response"; response: Omit<PublicResponse, "id"> }
  | { kind: "example"; example: Omit<PublicExample, "id"> }
  | { kind: "auth"; scheme: "none" | "bearer" | "basic" | "apikey" | "unresolved" }
);
export interface DocumentViewDto {
  apis: PublicDocumentApi[];
  models: { id: string; name: string; description: string; schema: SchemaNode }[];
  components: PublicComponent[];
}
export interface ReportViewDto {
  sourceCategory: "run" | "stress" | "debug";
  startedAt: string; finishedAt: string; verdict: string;
  counts: { labelCode: string; total: number; passed?: number; failed?: number; skipped?: number }[];
  failures: { category: string; count: number }[];
  nodes: { id: string; name: string; state: string; durationMs?: number; failureKind?: string; message?: string }[];
  trace: { nodeId?: string; type: string; state?: string; message?: string; delayMs?: number; attempt?: number }[];
  evidence: { nodeId: string; status: "available" | "missing" | "not-collected" | "masked" | "truncated" | "unsupported"; requestBody?: string; responseBody?: string }[];
  stress?: Pick<StressReportV2, "iterations" | "requests" | "httpExchanges" | "caseRows" | "phases" | "timeline" | "nodes" | "lifecycle" | "load" | "statistics" | "completeness" | "rps" | "latency" | "scriptLatency" | "iterationLatency">;
  comparison?: StressComparison;
}
export interface PublicArtifactDto {
  formatVersion: 1; kind: Exclude<ArtifactKind, "mock">; title: string;
  source: PublicationSource;
  summary: readonly { labelCode: string; value: string | number | boolean | null; unit?: string }[];
  limitations: readonly Limitation[];
  document?: DocumentViewDto; report?: ReportViewDto;
}
export type PublicationScope =
  | { kind: "project" }
  | { kind: "collections"; collectionIds: string[] }
  | { kind: "apis"; contractIds: string[] }
  | { kind: "tags"; tags: string[] }
  | { kind: "folders"; folders: { collectionId: string; folderIds: string[] }[] };
export type DocumentPublicationInput = {
  sourceKind: "saved-contract"; title: string; source: { revision: string; digest: string };
  files: { path: string; content: string }[]; scope: PublicationScope;
};
export type MemberPublicationInput = { sourceKind: "member-upload"; artifact: PublicArtifactDto };
export type ArchiveReport = { format: "run"; body: RunResult } | { format: "stress"; body: ReadableStressReport; baseline?: ReadableStressReport } | { format: "debug"; body: DebugHistoryRecord };
export type ArchivePublicationInput = { sourceKind: "server-archive"; title: string; source: { revision: string; digest: string };
  report: ArchiveReport; redaction: "verified" | "unavailable"; privateMarkers: string[] };
export type ArchivedExecutionPublicationInput = Omit<ArchivePublicationInput, 'report'> & { report:
  | { format: 'run'; body: z.infer<typeof ArchivedRunExecutionWireSchema> }
  | { format: 'stress'; body: z.infer<typeof ArchivedStressExecutionWireSchema>; baseline?: ReadableStressReport } };
export type PublicationInput = DocumentPublicationInput | MemberPublicationInput | ArchivePublicationInput | ArchivedExecutionPublicationInput;
export interface SharedMockPolicy {
  maxResponseBytes: number; maxDelayMs: number; requestDeadlineMs: number;
  extraSensitiveHeaders: readonly string[]; extraSensitiveQuery: readonly string[];
  extraSensitiveFields: readonly string[]; extraSensitivePointers: readonly string[];
}
