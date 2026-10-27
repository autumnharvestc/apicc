import type { ExecutionProfile } from "../contract/index.js";
import type { BuildIdentity } from "../buildIdentity.js";

export const BUILTIN_EXECUTION_CAPABILITIES = Object.freeze(["protocol:http", "protocol:soap", "protocol:websocket", "script:trusted-core", "task:debug", "task:suite", "task:workflow"]);
/** The existing synchronous pm surface; no third-party API compatibility is implied. */
export const CORE_SCRIPT_API = Object.freeze(["pm.variables.get", "pm.variables.set", "pm.environment.get", "pm.request", "pm.response", "pm.assert"]);
export function executionCapabilities(profile: ExecutionProfile): readonly string[] {
  return BUILTIN_EXECUTION_CAPABILITIES.filter(capability => profile === "trusted-core-script" || capability !== "script:trusted-core");
}
export function describeExecutionRuntime(identity: BuildIdentity, profile: ExecutionProfile) {
  const capabilities = executionCapabilities(profile);
  if (capabilities.some(capability => !identity.capabilities.includes(capability))) throw new Error("Build identity does not support execution capabilities");
  return { coreBuildId: identity.coreBuildId, scriptApiId: identity.scriptApiId, nodeVersion: process.versions.node, v8Version: process.versions.v8, executionProfile: profile, capabilities, scriptApi: profile === "trusted-core-script" ? CORE_SCRIPT_API : [] };
}
