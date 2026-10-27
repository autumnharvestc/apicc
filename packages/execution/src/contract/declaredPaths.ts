import { ProjectRelativePathSchema } from "./task.js";
/** Stable wire encoding only: never read this path on the host filesystem. */
export const DECLARED_NETWORK_PATH_PREFIX = "/apicc-declared/";
export function declaredNetworkPath(logicalPath: string): string { return DECLARED_NETWORK_PATH_PREFIX + ProjectRelativePathSchema.parse(logicalPath); }
export function logicalNetworkPath(encoded: string): string {
  if (!encoded.startsWith(DECLARED_NETWORK_PATH_PREFIX)) throw new Error("Network certificate must use a declared logical path");
  return ProjectRelativePathSchema.parse(encoded.slice(DECLARED_NETWORK_PATH_PREFIX.length));
}
