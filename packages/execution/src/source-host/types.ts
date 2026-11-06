import type { PreparedNetworkRun, PreparedNetworkRoute } from "@apicc/core";
import type { SourceGitTools } from "./tools.js";
import type { PrivateSourceReadOwner } from "./process.js";
import type { GitHttpAdapterOptions } from "./gitCredentials.js";
import type { SourceMaterialLease, SourceReadInput, SourceReadResult, SyncSource, SyncUpstream } from "@apicc/core/sync";
export type { SourceMaterialLease, SourceReadInput, SourceReadResult };

/** Trusted host policy, separate from routing/TLS profiles. Never comes from wire input. */
export interface SourceNetworkContext {
  readonly prepared: PreparedNetworkRun;
  readonly policyIdentity: string;
  readonly materialIdentity: string;
  approveDestination(url: URL, address: SourceAddress): boolean;
}
export interface SourceAddress { readonly address: string; readonly family: 4 | 6 }
/** SSH is captured explicitly; its null URL origin never enters the HTTP prepared resolver. */
export interface SourceSshNetworkContext extends SourceNetworkContext { readonly route: PreparedNetworkRoute }
export interface SourceGitConfiguration {
  readonly tools: SourceGitTools;
  /** Must allocate an exclusive, private host-owned directory (including a private Windows ACL). */
  createPrivateRead(signal: AbortSignal): Promise<PrivateSourceReadOwner>;
  readonly adapterLimits?: Pick<GitHttpAdapterOptions, "maxHeaderBytes" | "maxConcurrentRequests" | "maxRequestBytes">;
}
export interface SourceCacheEntry {
  readonly binding: string;
  readonly contentIdentity: string;
  readonly upstream: Extract<SyncUpstream, { kind: "url" }>;
  readonly rawText: string;
  readonly etag?: string;
  readonly lastModified?: string;
}
/** Private, bounded storage and eviction are owned by the calling host. */
export interface SourceContentCache {
  get(binding: string): Promise<SourceCacheEntry | undefined>;
  put(entry: SourceCacheEntry): Promise<void>;
}
export interface SourceHostOptions {
  /** Trusted host redirect budget per attempt: integer 0–20, default 5. */
  readonly maxRedirects?: number;
  readonly git?: SourceGitConfiguration;
  captureNetwork(source: SyncSource, signal: AbortSignal): Promise<SourceNetworkContext>;
  captureSshRoute?(source: Extract<SyncSource, { kind: "git-ssh" }>, signal: AbortSignal): Promise<SourceSshNetworkContext>;
  resolveAddresses?(hostname: string, signal: AbortSignal): Promise<readonly SourceAddress[]>;
  readonly cache?: SourceContentCache;
  onContent?(content: SourceValidatedContent, signal: AbortSignal): Promise<void>;
}
/** Per-check private handoff, also usable by future Git readers. Never log or expose in UI. */
export interface SourceValidatedContent {
  readonly rawText: string;
  readonly upstream: Readonly<SyncUpstream>;
  readonly bindingIdentity: string;
}
export interface SourceHost {
  readSource(input: SourceReadInput, materialLease: SourceMaterialLease, signal?: AbortSignal): Promise<SourceReadResult>;
}
