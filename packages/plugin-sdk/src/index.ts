export type * from "./types.js";
export {
  validatePluginManifest, validatePluginConfig, validatePluginContribution,
} from "./manifest.js";
export type {
  PluginProblemV1, PluginManifestValidationV1, PluginConfigValidationV1,
} from "./manifest.js";
import type { PluginDefinitionV1 } from "./types.js";

/** Preserve author inference without importing or initializing a host. */
export function definePlugin<T extends PluginDefinitionV1>(definition: T): T {
  return definition;
}
