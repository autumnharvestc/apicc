import type { SyncCandidate, SyncDiagnostic, SyncHistoryEntry, SyncIdentityMap, SyncReceipt, SyncSource } from "./types.js";
import { z } from "zod";
import { SyncCandidateSchema, SyncContentRefSchema, SyncDiagnosticSchema, SyncHashSchema, SyncHistoryEntrySchema, SyncIdentityMapSchema, SyncReceiptSchema, SyncRevisionSchema, SyncSourceSchema } from "./types.js";

export interface SyncContentRef { digest: string; bytes: number; contentType: "application/vnd.apicc.sync-files+json" }
export interface SyncSourceState {
  source: SyncSource;
  mapping: SyncIdentityMap;
  baselineRevision: string;
  baselineContent: SyncContentRef | null;
}
export interface StoredSyncCandidate {
  candidate: SyncCandidate;
  createdAtMs: number;
  expiresAtMs: number;
  baselineContent: SyncContentRef;
  localContent: SyncContentRef;
  remoteContent: SyncContentRef;
  mapping: SyncIdentityMap;
  normalizationDiagnostics: SyncDiagnostic[];
}
export interface SyncWorkspaceState {
  formatVersion: 1;
  projectId: string;
  sources: SyncSourceState[];
  candidates: StoredSyncCandidate[];
  history: SyncHistoryEntry[];
  operations: { requestDigest: string; receipt: SyncReceipt }[];
}

const sourceState = z.object({ source: SyncSourceSchema, mapping: SyncIdentityMapSchema, baselineRevision: SyncRevisionSchema, baselineContent: SyncContentRefSchema.nullable() }).strict();
const storedCandidate = z.object({
  candidate: SyncCandidateSchema, createdAtMs: z.number().int().nonnegative(), expiresAtMs: z.number().int().nonnegative(),
  baselineContent: SyncContentRefSchema, localContent: SyncContentRefSchema, remoteContent: SyncContentRefSchema,
  mapping: SyncIdentityMapSchema, normalizationDiagnostics: z.array(SyncDiagnosticSchema),
}).strict();
export const SyncWorkspaceStateSchema: z.ZodType<SyncWorkspaceState> = z.object({
  formatVersion: z.literal(1), projectId: z.string().uuid(), sources: z.array(sourceState), candidates: z.array(storedCandidate),
  history: z.array(SyncHistoryEntrySchema), operations: z.array(z.object({ requestDigest: SyncHashSchema, receipt: SyncReceiptSchema }).strict()),
}).strict();

/** References only: opening an index never expands historical file payloads. */
export function syncContentReferences(state: SyncWorkspaceState): SyncContentRef[] {
  return [
    ...state.sources.flatMap(s => s.baselineContent ? [s.baselineContent] : []),
    ...state.candidates.flatMap(c => [c.baselineContent, c.localContent, c.remoteContent]),
    ...state.history.flatMap(h => [h.rollback.beforeContent, h.rollback.afterContent]),
  ];
}
