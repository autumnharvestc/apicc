import { beforeAll, afterAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildSourceHostResources } from "../../../packages/execution/scripts/build-source-host-resources.mjs";
import { packagedSourceHostProbe } from "../scripts/source-host-package-probe.mjs";

const exec = promisify(execFile);
let applicationDirectory: string;
let resources: string;
beforeAll(async () => {
  applicationDirectory = await mkdtemp(join(tmpdir(), "apicc-package-probe-"));
  resources = join(applicationDirectory, "resources");
  // Use the real packaged resource paths and native helper without rebuilding a
  // desktop directory package for each failure-path test. Actual ASAR execution
  // remains a separate package smoke check.
  const execution = join(resources, "app.asar/node_modules/@apicc/execution");
  const sourceHost = join(execution, "dist/source-host");
  await mkdir(sourceHost, { recursive: true });
  await writeFile(join(resources, "app.asar/package.json"), '{"type":"module"}');
  await copyFile(fileURLToPath(new URL("../../../packages/execution/package.json", import.meta.url)), join(execution, "package.json"));
  const sourceDirectory = fileURLToPath(new URL("../../../packages/execution/src/source-host/", import.meta.url));
  for (const name of await readdir(sourceDirectory)) if (name.endsWith(".ts")) {
    await writeFile(join(sourceHost, name.slice(0, -3) + ".js"), ts.transpileModule(await readFile(join(sourceDirectory, name), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  }
  await buildSourceHostResources({ outputDirectory: join(resources, "app.asar.unpacked/node_modules/@apicc/execution/dist/source-host"), platform: process.platform });
}, 30000);
afterAll(async () => { if (applicationDirectory) await rm(applicationDirectory, { recursive: true, force: true }); });

async function runProbe(privateRoot: string, prefix = "") {
  const script = prefix + packagedSourceHostProbe(resources, privateRoot);
  return exec(process.execPath, ["-e", script], { windowsHide: true, timeout: 25000 }).then(
    result => ({ code: 0, ...result }),
    error => ({ code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) }),
  );
}
function expectSafeEvents(events: Record<string, unknown>[]) {
  const allowedKeys = new Set(["ms", "kind", "pid", "activeZero", "exitCode", "code"]);
  const allowedKinds = new Set(["helper-spawn", "started", "collected-frame", "uncollected-frame", "helper-error", "helper-exit", "helper-close", "kill-requested", "observation-limit", "unexpected-frame", "invalid-frame"]);
  expect(events.length).toBeGreaterThan(0); expect(events.length).toBeLessThanOrEqual(16);
  for (const event of events) {
    expect(Object.keys(event).every(key => allowedKeys.has(key))).toBe(true);
    expect(allowedKinds.has(event.kind as string)).toBe(true);
    for (const [key, value] of Object.entries(event)) if (key !== "kind") {
      expect(value === null || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value))).toBe(true);
    }
  }
}

it.runIf(process.platform === "win32")("checks a real descendant and cleans a fixture after proved collection", async () => {
  const privateRoot = join(applicationDirectory, "normal"); await mkdir(privateRoot);
  const result = await runProbe(privateRoot);
  expect(result.code).toBe(0); expect(result.stdout).toContain("PACKAGED_SOURCE_HOST_READY");
  const events = result.stdout.split(/\r?\n/).filter(line => line.startsWith("PACKAGED_SOURCE_HOST_LIFECYCLE ")).map(line => JSON.parse(line.slice("PACKAGED_SOURCE_HOST_LIFECYCLE ".length)));
  expectSafeEvents(events);
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "collected-frame", activeZero: true }), expect.objectContaining({ kind: "helper-close", code: 0 })]));
  expect(await readdir(privateRoot)).toEqual([]);
}, 30000);

// Breakage caught: an actual helper death without collection proof deletes the
// only fixture and loses bounded lifecycle evidence before reporting failure.
it.runIf(process.platform === "win32")("retains the fixture and only safe lifecycle evidence when the native helper dies without proof", async () => {
  const privateRoot = join(applicationDirectory, "uncollected"); await mkdir(privateRoot);
  const terminateHelper = `(()=>{const cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=function(...args){const child=spawn(...args);if(require('node:path').basename(args[0])==='owned-process.exe')child.once('spawn',()=>child.kill());return child;};require('node:module').syncBuiltinESMExports();})();`;
  const result = await runProbe(privateRoot, terminateHelper);
  expect(result.code).toBe(1); expect(result.stderr).toContain("SYNC_PROCESS_UNCOLLECTED");
  const retained = await readdir(privateRoot);
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatch(/^packaged-source-/);
  const bytes = await readFile(join(privateRoot, retained[0]!, "source-host-lifecycle.json"), "utf8");
  expect(Buffer.byteLength(bytes)).toBeLessThan(8192);
  const observation = JSON.parse(bytes);
  expect(observation).toMatchObject({ code: "SYNC_PROCESS_UNCOLLECTED", collectionUnknown: true, privateFixtureRetained: true });
  expect(observation.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "helper-spawn" }), expect.objectContaining({ kind: "helper-close" })]));
  expectSafeEvents(observation.events);
  const allowedKeys = new Set(["code", "stage", "collectionUnknown", "privateFixtureRetained", "events"]);
  expect(Object.keys(observation).every(key => allowedKeys.has(key))).toBe(true);
  expect(bytes).not.toContain(privateRoot);
  expect(bytes).not.toContain("toolPath"); expect(bytes).not.toContain("SystemRoot");
  expect(bytes).not.toContain("stdout"); expect(bytes).not.toContain("stderr");
}, 30000);
