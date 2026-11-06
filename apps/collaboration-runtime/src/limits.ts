import { readFile } from "node:fs/promises";
import { startCollaborationRuntime } from "./server.js";
import { SourceDeploymentSchema } from "./sourceHost.js";

export interface RuntimeLimits {
  cacheBytes?: number; maxWireBytes?: number;
  inFlightBytes?: number; headroomBytes?: number; totalMemoryBytes?: number; heapBytes?: number;
}
export function runtimeLimits(input: RuntimeLimits = {}) {
  const cacheBytes = input.cacheBytes ?? 67_108_864;
  const maxWireBytes = input.maxWireBytes ?? 33_554_432;
  if (!Number.isInteger(cacheBytes) || cacheBytes < 8_388_608 || cacheBytes > 1_073_741_824
    || !Number.isInteger(maxWireBytes) || maxWireBytes < 1_048_576 || maxWireBytes > 134_217_728) throw new Error("RPC_CONFIGURATION_INVALID");
  const resources: Pick<RuntimeLimits, 'inFlightBytes'|'headroomBytes'|'totalMemoryBytes'|'heapBytes'> = {};
  for (const name of ['inFlightBytes','headroomBytes','totalMemoryBytes','heapBytes'] as const) {
    const value = input[name]; if (value === undefined) continue;
    const minimum = name === 'totalMemoryBytes' ? 268435456 : name === 'heapBytes' ? 134217728 : 0;
    const maximum = name === 'totalMemoryBytes' ? 8589934592 : name === 'heapBytes' ? 4294967296 : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('RPC_CONFIGURATION_INVALID');
    resources[name] = value;
  }
  if (resources.totalMemoryBytes !== undefined && resources.heapBytes !== undefined && resources.inFlightBytes !== undefined && resources.headroomBytes !== undefined
    && BigInt(resources.heapBytes) + BigInt(cacheBytes) + BigInt(resources.inFlightBytes) + BigInt(resources.headroomBytes) > BigInt(resources.totalMemoryBytes)) throw new Error('RPC_CONFIGURATION_INVALID');
  return { cacheBytes, maxWireBytes, ...resources };
}
export async function runtimeFromDeployment(input: RuntimeLimits & { enabled?: boolean; secretFile?: string; sourceConfigFile?: string; host?: string; port?: number }) {
  if (!input.enabled) return { enabled: false as const };
  let secret: string;
  try {
    secret = (await readFile(input.secretFile ?? "", "utf8")).replace(/^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g, "");
    if (secret.length < 32 || !/^[\x20-\x7e]+$/.test(secret)) throw new Error();
  } catch { throw new Error("RPC_SECRET_FILE_INVALID"); }
  const limits = runtimeLimits(input);
  let source;
  if (input.sourceConfigFile !== undefined) {
    try { source = SourceDeploymentSchema.parse(JSON.parse(await readFile(input.sourceConfigFile, "utf8"))); }
    catch { throw new Error("SYNC_HOST_CONFIG_INVALID"); }
  }
  return { enabled: true as const, ...await startCollaborationRuntime({ secret, host: input.host, port: input.port, source, ...limits }) };
}
