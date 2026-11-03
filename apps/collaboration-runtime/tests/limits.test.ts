import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeLimits, runtimeFromDeployment } from "../src/limits.js";
import { deploymentEnvironment } from "../src/main.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

it("uses 64MiB cache and 32MiB actual wire default", () => {
  expect(runtimeLimits()).toMatchObject({ cacheBytes: 67_108_864, maxWireBytes: 33_554_432 });
});
it('resource values remain unconfigured until supplied; explicit zero flight is retained', () => {
  expect(runtimeLimits()).not.toHaveProperty('inFlightBytes');
  expect(runtimeLimits({ inFlightBytes: 0 })).toHaveProperty('inFlightBytes', 0);
});
it.each([
  { inFlightBytes: -1 }, { inFlightBytes: 1.5 }, { headroomBytes: -1 },
  { totalMemoryBytes: 268435455 }, { totalMemoryBytes: 8589934593 },
  { heapBytes: 134217727 }, { heapBytes: 4294967297 },
  { totalMemoryBytes: 268435456, heapBytes: 134217728, cacheBytes: 67108864, inFlightBytes: 67108864, headroomBytes: 1 },
])('rejects resource ranges and a reached complete budget conflict %j', value => {
  expect(() => runtimeLimits(value)).toThrow('RPC_CONFIGURATION_INVALID');
});
it('accepts the existing memory/heap endpoints and exact complete sum without adding defaults', () => {
  expect(runtimeLimits({ totalMemoryBytes: 268435456, heapBytes: 134217728, inFlightBytes: 67108864, headroomBytes: 0 })).toMatchObject({ totalMemoryBytes: 268435456, heapBytes: 134217728, inFlightBytes: 67108864, headroomBytes: 0 });
  expect(runtimeLimits({ totalMemoryBytes: 8589934592, heapBytes: 4294967296 })).toMatchObject({ totalMemoryBytes: 8589934592, heapBytes: 4294967296 });
});
it.each([
  ["cacheBytes", 8_388_607], ["cacheBytes", 1_073_741_825], ["cacheBytes", 8_388_608.5],
  ["maxWireBytes", 1_048_575], ["maxWireBytes", 134_217_729], ["maxWireBytes", 1_048_576.5],
])("rejects invalid %s=%s without clamping", (key, value) => {
  expect(() => runtimeLimits({ [key]: value })).toThrow("RPC_CONFIGURATION_INVALID");
});
it.each([[8_388_608, 1_048_576], [1_073_741_824, 134_217_728]])("accepts range endpoints %s/%s", (cacheBytes, maxWireBytes) => {
  expect(runtimeLimits({ cacheBytes, maxWireBytes })).toMatchObject({ cacheBytes, maxWireBytes });
});
it("disabled deployment does not read a missing secret file or create listener", async () => {
  expect(await runtimeFromDeployment({ enabled: false, secretFile: "nonexistent" })).toEqual({ enabled: false });
});
it.each(["missing", "empty", "short"])("enabled deployment refuses %s secret file", async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-runtime-"));
  const secretFile = join(directory, "key");
  try {
    if (kind !== "missing") await writeFile(secretFile, kind === "empty" ? "" : "short");
    await expect(runtimeFromDeployment({ enabled: true, secretFile })).rejects.toThrow("RPC_SECRET_FILE_INVALID");
  } finally { await rm(directory, { recursive: true }); }
});
it("valid synthetic secret file enables a real listener", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-runtime-"));
  const secretFile = join(directory, "key");
  let deployment: unknown;
  try {
    await writeFile(secretFile, "synthetic-secret-0123456789abcdef\n");
    deployment = await runtimeFromDeployment({ enabled: true, secretFile, port: 0 });
    expect(deployment).toMatchObject({ enabled: true, url: expect.stringMatching(/^http:/) });
  } finally {
    if (deployment && typeof deployment === "object" && "close" in deployment) await (deployment.close as () => Promise<void>)();
    await rm(directory, { recursive: true });
  }
});
it("deployment environment defaults off and explicitly maps configured limits", () => {
  expect(deploymentEnvironment({})).toEqual({ enabled: false });
  expect(deploymentEnvironment({ APICC_COLLABORATION_RUNTIME_ENABLED: "true", APICC_COLLABORATION_RUNTIME_SECRET_FILE: "synthetic-key", APICC_COLLABORATION_RUNTIME_PORT: "3210", APICC_COLLABORATION_RUNTIME_CACHE_BYTES: "8388608", APICC_COLLABORATION_RUNTIME_MAX_WIRE_BYTES: "1048576" })).toMatchObject({ enabled: true, secretFile: "synthetic-key", port: 3210, cacheBytes: 8388608, maxWireBytes: 1048576 });
});
it("rejects invalid enable flag instead of silently treating it as disabled", () => {
  expect(() => deploymentEnvironment({ APICC_COLLABORATION_RUNTIME_ENABLED: "typo" })).toThrow("RPC_CONFIGURATION_INVALID");
});
it.each(["\nsecond-line", "\u0000suffix", "\tsuffix", "非ASCII"])("refuses unportable authentication secret suffix %j", async suffix => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-runtime-")); const secretFile = join(directory, "key");
  let runtime: Awaited<ReturnType<typeof runtimeFromDeployment>> | undefined;
  try {
    await writeFile(secretFile, "synthetic-secret-0123456789abcdef" + suffix);
    await expect(runtimeFromDeployment({ enabled: true, secretFile, port: 0 }).then(value => { runtime = value; return value; })).rejects.toThrow("RPC_SECRET_FILE_INVALID");
  } finally { if (runtime?.enabled) await runtime.close(); await rm(directory, { recursive: true }); }
});
it("rejects an occupied listener through the startup Promise", async () => {
  const blocker = createServer(); await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address(); if (!address || typeof address === "string") throw new Error("loopback setup failed");
  try {
    const entry = new URL("../src/server.ts", import.meta.url).href;
    const root = new URL("../src/", import.meta.url).href;
    // Test-only Node22 loader maps this package's TS source import specifiers;
    // ordinary tests require only the established Core build, not runtime dist.
    const code = `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(context.parentURL?.startsWith(${JSON.stringify(root)})&&specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.slice(0,-3)+'.ts',context);return next(specifier,context);}});const {startCollaborationRuntime}=await import(${JSON.stringify(entry)}); try { await startCollaborationRuntime({secret:'synthetic-secret-0123456789abcdef',port:${address.port}});process.exit(2); } catch(error) { if(error.code==='EADDRINUSE'){console.log('RPC_STARTUP_REJECTED:EADDRINUSE');process.exit(0);}process.exit(3); }`;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", code]); let output = "";
      child.on("error", reject); child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; }); child.on("exit", code => resolve({ code, output }));
    });
    expect(result.output).toContain("EADDRINUSE"); // Actual listener branch, never a loader/setup failure.
    expect.soft(result.code).toBe(0); expect(result.output).toContain("RPC_STARTUP_REJECTED");
  } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
});
