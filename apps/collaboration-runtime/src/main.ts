import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runtimeFromDeployment } from "./limits.js";
import type { RuntimeLimits } from './limits.js';

export function deploymentEnvironment(environment: NodeJS.ProcessEnv): RuntimeLimits & { enabled: boolean; secretFile?: string; sourceConfigFile?: string; port?: number; host?: string } {
  const enabled = environment.APICC_COLLABORATION_RUNTIME_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") throw new Error("RPC_CONFIGURATION_INVALID");
  if (enabled === "false") return { enabled: false };
  return { enabled: true, secretFile: environment.APICC_COLLABORATION_RUNTIME_SECRET_FILE,
    sourceConfigFile: environment.APICC_COLLABORATION_RUNTIME_SOURCE_CONFIG_FILE,
    host: environment.APICC_COLLABORATION_RUNTIME_HOST ?? "127.0.0.1", port: Number(environment.APICC_COLLABORATION_RUNTIME_PORT ?? "3210"),
    cacheBytes: Number(environment.APICC_COLLABORATION_RUNTIME_CACHE_BYTES ?? "67108864"), maxWireBytes: Number(environment.APICC_COLLABORATION_RUNTIME_MAX_WIRE_BYTES ?? "33554432"),
    ...Object.fromEntries(([
      ['inFlightBytes', 'APICC_COLLABORATION_RUNTIME_IN_FLIGHT_BYTES'], ['headroomBytes', 'APICC_COLLABORATION_RUNTIME_HEADROOM_BYTES'],
      ['totalMemoryBytes', 'APICC_COLLABORATION_RUNTIME_TOTAL_MEMORY_BYTES'], ['heapBytes', 'APICC_COLLABORATION_RUNTIME_HEAP_BYTES'],
    ] as const).filter(([, key]) => environment[key] !== undefined).map(([key, name]) => [key, Number(environment[name])])) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const runtime = await runtimeFromDeployment(deploymentEnvironment(process.env));
    console.log(runtime.enabled ? "RPC_RUNTIME_READY" : "RPC_RUNTIME_DISABLED");
    if (runtime.enabled) {
      const shutdown = () => { void runtime.close().then(() => { process.exitCode = 0; }).catch(() => { console.error("SYNC_PROCESS_UNCOLLECTED"); process.exitCode = 1; }); };
      process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    }
  } catch (error) {
    const code = error instanceof Error && ["RPC_CONFIGURATION_INVALID", "RPC_SECRET_FILE_INVALID", "SYNC_HOST_CONFIG_INVALID"].includes(error.message) ? error.message : "RPC_STARTUP_FAILED";
    console.error(code); process.exitCode = 1;
  }
}
