import type { SyncCandidate, SyncCandidateView, SyncFixedDetailRequest, SyncFixedDetail, SyncDecisions, SyncHistoryEntry, SyncPolicyValues, SyncReceipt, SyncSource, SourceMaterialLease, SyncStorageLimits, WriteFaultInjector } from "@apicc/core/sync";
import type { SourceHostOptions } from "@apicc/execution/source-host";
import type { createSession } from "../session.js";

export interface LocalSyncLocation { groupId: string; projectId: string }
export interface LocalSyncAuthorization { generation: string; actor: { id: string; name: string } }
export interface LocalSyncReadSlot { release(): void; retain(): void }
export interface LocalSyncAdmission { acquire(projectKey: string, projectLimit: number, hostLimit: number): LocalSyncReadSlot }
/** Main-only trusted ports. Secrets, route identities and tool/private roots never enter a project DTO. */
export interface LocalSyncDependencies {
  session: ReturnType<typeof createSession>;
  sourceHost: Omit<SourceHostOptions, "cache" | "onContent" | "maxRedirects"> & { maxRedirects: number };
  acquireMaterial(source: SyncSource, signal: AbortSignal): Promise<SourceMaterialLease>;
  authorize(projectId: string, signal?: AbortSignal): Promise<LocalSyncAuthorization>;
  readCoreBuildId(): Promise<string>;
  policy?: SyncPolicyValues;
  storageLimits?: SyncStorageLimits;
  now?: () => number;
  writeFault?: WriteFaultInjector;
  admission?: LocalSyncAdmission;
}
export interface LocalSync {
  sources(location: LocalSyncLocation): Promise<SyncSource[]>;
  saveSource(location: LocalSyncLocation, source: SyncSource, expectedRevision: string): Promise<SyncSource>;
  check(location: LocalSyncLocation, sourceId: string, signal?: AbortSignal): Promise<SyncCandidateView>;
  detail(location: LocalSyncLocation, request: SyncFixedDetailRequest): Promise<SyncFixedDetail>;
  candidate(location: LocalSyncLocation, candidateId: string): Promise<SyncCandidateView>;
  apply(location: LocalSyncLocation, candidate: Pick<SyncCandidate, "id" | "candidateDigest">, decisions: SyncDecisions, intentId: string): Promise<SyncReceipt>;
  rollback(location: LocalSyncLocation, historyId: string, intentId: string): Promise<SyncReceipt>;
  operation(location: LocalSyncLocation, intentId: string): Promise<SyncReceipt | null>;
  history(location: LocalSyncLocation): Promise<SyncHistoryEntry[]>;
}
