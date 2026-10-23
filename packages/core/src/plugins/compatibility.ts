import { createRequire } from "node:module";
import type { PluginManifestV1 } from "@apicc/plugin-sdk";

// semver is an explicit runtime dependency. Its CJS package does not ship types.
const semver = createRequire(import.meta.url)("semver") as {
  valid(value: string): string | null;
  validRange(value: string): string | null;
  satisfies(version: string, range: string): boolean;
};
export class PluginLoadError extends Error {
  constructor(readonly code: string, message: string, readonly stage = "manifest",
    readonly actual?: string | number, readonly required?: string | number) {
    super(message); this.name = "PluginLoadError";
  }
}
export const validProductVersion = (version: string): boolean => semver.valid(version) !== null;

/** Preserve raw API/capability values before the SDK's V1 literal checks. */
export function checkRawCompatibility(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const raw = input as Record<string, unknown>;
  if (Number.isInteger(raw.apiVersion) && (raw.apiVersion as number) > 0 && raw.apiVersion !== 1) {
    throw new PluginLoadError("api_incompatible", `插件 API ${raw.apiVersion} 不兼容；宿主要求 API 1`, "compatibility", raw.apiVersion as number, 1);
  }
  if (Array.isArray(raw.capabilities) && raw.capabilities.every(c => typeof c === "string")) {
    const unknown = raw.capabilities.find(c => !["protocol", "auth", "assert", "importer", "reporter"].includes(c));
    if (unknown !== undefined) throw new PluginLoadError("unsupported_capability", `不支持插件能力 ${unknown}`, "compatibility", unknown, "protocol|auth|assert|importer|reporter");
  }
}
export function checkVersions(manifest: PluginManifestV1, hostVersion: string): void {
  if (!semver.valid(manifest.version) || !semver.validRange(manifest.engines.apicc)) {
    throw new PluginLoadError("manifest_invalid", "插件版本或宿主兼容范围不是合法 SemVer", "compatibility");
  }
  if (!semver.valid(hostVersion) || !semver.satisfies(hostVersion, manifest.engines.apicc)) {
    throw new PluginLoadError("host_incompatible", `实际宿主版本 ${hostVersion} 不满足要求 ${manifest.engines.apicc}`, "compatibility", hostVersion, manifest.engines.apicc);
  }
}
