import type { AuthKindV1, ProtocolKindV1, ReadonlyJsonObject } from "@apicc/plugin-sdk";
import type { LoadProblem } from "../plugin/types.js";
import type { PluginCatalog } from "../plugin/catalog.js";
import type { PluginRegistry } from "../plugin/registry.js";

export interface UserPluginEntry { source: string; enabled?: boolean; config?: unknown }
export interface UserPluginBindings {
  protocols: Partial<Record<ProtocolKindV1, string>>;
  auths: Partial<Record<AuthKindV1, string>>;
}
/** User-owned ~/.apicc/plugins.json. Never read from project assets. */
export interface PluginManifest {
  plugins: (string | UserPluginEntry)[];
  bindings?: Partial<UserPluginBindings>;
}
export interface PluginContributionSummary {
  protocols: number; auths: number; asserts: number; scriptEngines: number;
  reporters: number; importers: number; storage: number;
}
export interface PluginLoadEntry {
  source: string; pluginId: string; name: string; version: string; apiVersion: number;
  engines: { apicc: string }; contributions: PluginContributionSummary;
  contributionIds: string[];
}
export interface PluginLoadResult {
  loaded: PluginLoadEntry[]; problems: LoadProblem[];
  bindings: UserPluginBindings;
  disabled?: { source: string }[];
}
export interface PluginLoaderOptions {
  homeDir?: string;
  /** Supplied by the product composition root, never inferred from SDK/Core. */
  hostVersion?: string;
  enabled?: boolean;
  /** Optional composition-root base; preserves embedded storage and extensions. */
  registry?: PluginRegistry;
  importFn?: (specifier: string) => Promise<unknown>;
}
export interface PluginRuntimeEntryV1 {
  /** Fixed absolute static manifest path, independent of worker HOME/cwd. */
  source: string; pluginId: string; version: string; apiVersion: 1;
  manifestDigest: string; entryDigest: string; config: ReadonlyJsonObject;
}
export interface PluginRuntimeSnapshotV1 {
  pluginRuntimeVersion: 1; enabled: boolean; hostVersion: string; digest: string;
  entries: PluginRuntimeEntryV1[]; bindings: UserPluginBindings;
}
export interface UserPluginHost {
  registry(): Promise<PluginRegistry>;
  summary(): Promise<PluginLoadResult>;
  snapshot(): Promise<PluginRuntimeSnapshotV1>;
}
/** Internal assembly state; not part of public list/IPC output. */
export interface PluginLoadState {
  catalog: PluginCatalog; entries: PluginRuntimeEntryV1[];
}
