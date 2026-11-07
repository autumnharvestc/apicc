import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { OwnedProcessInput } from "../../src/source-host/process.js";
import { buildSourceHostResources } from "../../scripts/build-source-host-resources.mjs";
const exec = promisify(execFile);
const powershellPath = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
let applicationDirectory: string;
let application: typeof import("../../src/source-host/process.js");
beforeAll(async () => {
  applicationDirectory = await mkdtemp(join(tmpdir(), "apicc-process-application-"));
  const sourceDirectory = fileURLToPath(new URL("../../src/source-host/", import.meta.url));
  for (const name of await readdir(sourceDirectory)) if (name.endsWith(".ts")) await writeFile(join(applicationDirectory, name.slice(0, -3) + ".js"), ts.transpileModule(await readFile(join(sourceDirectory, name), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  await writeFile(join(applicationDirectory, "package.json"), '{"type":"module"}');
  await buildSourceHostResources({ outputDirectory: applicationDirectory, platform: process.platform, powershellPath });
  application = await import(/* @vite-ignore */ pathToFileURL(join(applicationDirectory, "process.js")).href);
}, 30000);
afterAll(async () => { if (applicationDirectory) await rm(applicationDirectory, { recursive: true, force: true }); });
const runOwnedProcess: typeof import("../../src/source-host/process.js").runOwnedProcess = input => application.runOwnedProcess(input);
const runPrivateSourceRead: typeof import("../../src/source-host/process.js").runPrivateSourceRead = (owner, lease, operation) => application.runPrivateSourceRead(owner, lease, operation);
const base = (cwd: string, script: string, changes: Partial<OwnedProcessInput> = {}): OwnedProcessInput => ({ toolPath: process.execPath, args: ["-e", script], cwd, env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}, signal: new AbortController().signal, maxOutputBytes: 1024, ...changes });
async function fixture(callback: (directory: string) => Promise<void>) { const directory = await mkdtemp(join(tmpdir(), "apicc-owned-process-")); try { await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); } }
async function readPid(file: string) { for (let i = 0; i < 100; i++) { try { return Number(await readFile(file, "utf8")); } catch { await new Promise(r => setTimeout(r, 20)); } } throw Error("Actual descendant prerequisite did not start"); }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function reap(pid: number) { if (!alive(pid)) return; if (process.platform === "win32") await exec("C:/Windows/System32/taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined); else { try { process.kill(pid, "SIGKILL"); } catch {} } }
describe("owned process boundary", () => {
  it("collects a real POSIX descendant in an owned init container", async () => fixture(async directory => {
    const sourceDirectory = fileURLToPath(new URL("../../src/source-host/", import.meta.url));
    for (const name of await readdir(sourceDirectory)) if (name.endsWith(".ts")) await writeFile(join(directory, name.slice(0, -3) + ".js"), ts.transpileModule(await readFile(join(sourceDirectory, name), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const runner = `import {runOwnedProcess} from '/app/process.js';import {readFile,rm} from 'node:fs/promises';const file='/tmp/owned-posix-child.pid';let pid;const script=\`const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify("require('node:fs').writeFileSync('/tmp/owned-posix-child.pid',String(process.pid));setTimeout(()=>{},10000)")}],{stdio:'ignore'});child.unref();setInterval(()=>{if(require('node:fs').existsSync('/tmp/owned-posix-child.pid'))process.exit(0)},10);\`;try{const result=await runOwnedProcess({toolPath:process.execPath,args:['-e',script],cwd:'/tmp',env:{},maxOutputBytes:1024,signal:new AbortController().signal});pid=Number(await readFile(file,'utf8'));let alive=true;try{process.kill(pid,0)}catch{alive=false}console.log(JSON.stringify({collected:result.collected,descendantAlive:alive}));}finally{if(pid){try{process.kill(pid,'SIGKILL')}catch{}}await rm(file,{force:true});}`;
    const result = await exec(process.env.APICC_TEST_DOCKER || "docker", ["run", "--rm", "--init", "--network", "none", "--mount", `type=bind,source=${directory},target=/app,readonly`, "--entrypoint", "/usr/local/bin/node", process.env.APICC_GIT_FIXTURE_IMAGE || "apicc-f7g-ssh-fixture:node22", "--input-type=module", "-e", runner], { windowsHide: true, timeout: 20000 });
    expect(JSON.parse(result.stdout)).toEqual({ collected: true, descendantAlive: false });
  }), 30000);
  // Breakage caught: returning on root exit while an inherited descendant still runs.
  it("collects an actual child after its parent exits before settling", async () => fixture(async directory => {
    const file = join(directory, "child.pid"); let pid: number | undefined;
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setTimeout(()=>{},10000)`)}],{stdio:'ignore'});c.unref();setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(file)}))process.exit(0)},10);`;
    try { const result = await runOwnedProcess(base(directory, script)); pid = await readPid(file); expect({ collected: result.collected, descendantAlive: alive(pid) }).toEqual({ collected: true, descendantAlive: false }); }
    finally { pid ??= await readPid(file); await reap(pid); }
  }));
  // Breakage caught: cancellation returned before collecting the real process tree.
  it("cancels an actual active child tree and waits for collection", async () => fixture(async directory => {
    const file = join(directory, "child.pid"); const controller = new AbortController(); let pid: number | undefined;
    const childScript = `require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setTimeout(()=>{},10000)`;
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});c.unref();setTimeout(()=>{},500);`;
    const pending = runOwnedProcess(base(directory, script, { signal: controller.signal }));
    try { pid = await readPid(file); controller.abort(); await expect(pending).rejects.toMatchObject({ code: "SYNC_INTERRUPTED" }); expect(alive(pid)).toBe(false); }
    finally { if (pid) await reap(pid); await pending.catch(() => undefined); }
  }));
  // Breakage caught: unbounded stdout or a failed disk sampler silently succeeds.
  it.each([{ script: "process.stdout.write('x'.repeat(4096))", monitor: undefined, code: "SYNC_PROCESS_OUTPUT_LIMIT" }, { script: "setTimeout(()=>{},300)", monitor: async () => { throw Error("owned sampler failure"); }, code: "SYNC_DISK_MONITOR_FAILED" }])("fails and collects on $code", async ({ script, monitor, code }) => fixture(async directory => {
    await expect(runOwnedProcess(base(directory, script, { monitor }))).rejects.toMatchObject({ code });
  }));
  // Breakage caught: a monitor rejection after native close arms a dead helper's
  // cancellation timer and keeps the real host alive after its Promise settles.
  it.runIf(process.platform === "win32")("does not keep the host alive when an in-flight monitor fails after native close", async () => fixture(async directory => {
    const runner = fileURLToPath(new URL("./fixtures/lateMonitorHost.mjs", import.meta.url));
    const result = await exec(process.execPath, [runner, applicationDirectory, directory], { windowsHide: true, timeout: 25000 });
    const observation = JSON.parse(result.stdout);
    expect(observation).toMatchObject({ nativeClosed: true, nativeExitCode: 0, errorCode: "SYNC_DISK_MONITOR_FAILED" });
    expect(observation.exitAfterSettlementMs).toBeLessThan(2000);
  }), 30000);
  // Breakage caught: killing the helper between native creation and assignment
  // leaves its suspended root alive even though no user script has resumed.
  it.runIf(process.platform === "win32" && process.arch === "x64")("owns the suspended root atomically when the helper dies at native CreateProcess return", async () => fixture(async directory => {
    const source = fileURLToPath(new URL("./fixtures/startupWindow.cs", import.meta.url));
    const executable = join(directory, "startup-window-probe.exe"), report = join(directory, "startup-window.json");
    const bootstrap = '$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";Add-Type -Path $env:APICC_TEST_WINDOW_SOURCE -OutputAssembly $env:APICC_TEST_WINDOW_EXE -OutputType ConsoleApplication -ReferencedAssemblies System.Web.Extensions,System,System.Core';
    await exec(powershellPath, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 15000, env: { SystemRoot: process.env.SystemRoot, PROGRAMDATA: process.env.PROGRAMDATA, TEMP: directory, TMP: directory, APICC_TEST_WINDOW_SOURCE: source, APICC_TEST_WINDOW_EXE: executable },
    });
    await exec(executable, [join(applicationDirectory, "owned-process.exe"), process.execPath, directory, report], { windowsHide: true, timeout: 20000, env: { SystemRoot: process.env.SystemRoot, PROGRAMDATA: process.env.PROGRAMDATA } });
    const observation = JSON.parse(await readFile(report, "utf8"));
    expect(observation).toMatchObject({ injectedAtCreateReturn: true, helperExited: true, rootExecuted: false, fixtureToolCollected: true, fixtureJobEmpty: true, failure: null });
    expect(observation.toolStillActiveAfterHelperExit).toBe(false);
  }), 30000);
  it("passes literal arguments and never invokes a shell", async () => fixture(async directory => {
    const result = await runOwnedProcess({ ...base(directory, "process.stdout.write(process.argv[1])"), args: ["-e", "process.stdout.write(process.argv[1])", "literal $() & | ; value"] });
    expect(result.stdout.toString()).toBe("literal $() & | ; value"); expect(result.exitCode).toBe(0);
  }));
  // Breakage caught: a native launch error leaks host paths/raw native detail.
  it("reports a stable collected launch error for a missing absolute tool", async () => fixture(async directory => {
    const input = base(directory, "");
    await expect(runOwnedProcess({ ...input, toolPath: join(directory, "missing-owned-tool.exe") })).rejects.toMatchObject({ code: "SYNC_PROCESS_START_FAILED" });
  }));
  // Breakage caught: an oversized descriptor reaches OS argv limits unsafely.
  it("refuses an oversized process descriptor before launching", async () => fixture(async directory => {
    await expect(runOwnedProcess({ ...base(directory, ""), args: ["-e", "", "x".repeat(70000)] })).rejects.toMatchObject({ code: "SYNC_PROCESS_INPUT_LIMIT" });
  }));
});

describe("private read collection and lease ownership", () => {
  it.runIf(process.platform === "win32")("retains actual material and lease when the native helper dies without collection proof", async () => fixture(async directory => {
    const material = join(directory, "private-material"); const record = join(directory, "owned-tree.json"); const childFile = join(directory, "descendant.pid");
    await writeFile(material, "synthetic-secret"); let released = 0; let retained = 0; let collected = 0;
    const owner = { directory, collect: async () => { collected++; await rm(material); }, retainUncollected: async () => { retained++; } };
    const lease = { leaseId: "native-helper-death", release: async () => { released++; } };
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(childFile)},String(process.pid));setTimeout(()=>{},10000)`;
    const script = `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{if(fs.existsSync(${JSON.stringify(childFile)}))fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({helper:process.ppid,root:process.pid,descendant:c.pid}))},20);`;
    const pending = runPrivateSourceRead(owner, lease, () => runOwnedProcess(base(directory, script)));
    let tree: { helper: number; root: number; descendant: number } | undefined;
    try {
      for (let i = 0; i < 100; i++) { try { tree = JSON.parse(await readFile(record, "utf8")); break; } catch { await new Promise(r => setTimeout(r, 20)); } }
      if (!tree) throw Error("Actual native helper/tree prerequisite did not start");
      expect(tree.helper).not.toBe(process.pid); process.kill(tree.helper, "SIGKILL");
      await expect(pending).rejects.toMatchObject({ code: "SYNC_PROCESS_UNCOLLECTED" });
      expect({ retained, released, collected, exists: await access(material).then(() => true, () => false) }).toEqual({ retained: 1, released: 0, collected: 0, exists: true });
      for (let i = 0; i < 100 && (alive(tree.root) || alive(tree.descendant)); i++) await new Promise(r => setTimeout(r, 20));
      expect({ rootAlive: alive(tree.root), descendantAlive: alive(tree.descendant) }).toEqual({ rootAlive: false, descendantAlive: false });
    } finally { if (tree) { await reap(tree.root); await reap(tree.descendant); } await pending.catch(() => undefined); }
  }), 15000);
  // These are lifecycle unit cases with real files; native helper death is a separate later case.
  it("removes actual private material before releasing its lease exactly once", async () => fixture(async directory => {
    const material = join(directory, "private-material"); await writeFile(material, "synthetic-secret");
    const order: string[] = [];
    const owner = { directory, collect: async () => { await rm(material); order.push("collected"); }, retainUncollected: async () => { order.push("retained"); } };
    const lease = { leaseId: "private-fixture", release: async () => { expect(await access(material).then(() => true, () => false)).toBe(false); order.push("released"); } };
    await expect(runPrivateSourceRead(owner, lease, async () => { expect(await readFile(material, "utf8")).toBe("synthetic-secret"); order.push("operation"); return "fixed-result"; })).resolves.toBe("fixed-result");
    expect(order).toEqual(["operation", "collected", "released"]);
  }));
  it("collects actual files before releasing and preserving a normal operation error", async () => fixture(async directory => {
    const material = join(directory, "private-material"); await writeFile(material, "synthetic-secret"); const order: string[] = [];
    const owner = { directory, collect: async () => { await rm(material); order.push("collected"); }, retainUncollected: async () => { order.push("retained"); } };
    const lease = { leaseId: "private-fixture", release: async () => { expect(await access(material).then(() => true, () => false)).toBe(false); order.push("released"); } };
    await expect(runPrivateSourceRead(owner, lease, async () => { order.push("operation"); throw Object.assign(new Error("SYNC_READ_FAILED"), { code: "SYNC_READ_FAILED" }); })).rejects.toMatchObject({ code: "SYNC_READ_FAILED" });
    expect(order).toEqual(["operation", "collected", "released"]);
  }));
  it("normalizes lease release errors only after actual private collection", async () => fixture(async directory => {
    const material = join(directory, "private-material"); await writeFile(material, "synthetic-secret");
    const owner = { directory, collect: async () => { await rm(material); }, retainUncollected: async () => undefined };
    const lease = { leaseId: "private-fixture", release: async () => { expect(await access(material).then(() => true, () => false)).toBe(false); throw Error("native secret lease detail"); } };
    await expect(runPrivateSourceRead(owner, lease, async () => "fixed-result")).rejects.toMatchObject({ code: "SYNC_MATERIAL_RELEASE_FAILED" });
  }));
  it("retains the actual private directory and unreleased lease on uncollected process outcome", async () => fixture(async directory => {
    const material = join(directory, "private-material"); await writeFile(material, "synthetic-secret"); let released = 0; let retained = 0; let collected = 0;
    const owner = { directory, collect: async () => { collected++; await rm(material); }, retainUncollected: async () => { retained++; } };
    const lease = { leaseId: "private-fixture", release: async () => { released++; } };
    await expect(runPrivateSourceRead(owner, lease, async () => { throw Object.assign(new Error("SYNC_PROCESS_UNCOLLECTED"), { code: "SYNC_PROCESS_UNCOLLECTED" }); })).rejects.toMatchObject({ code: "SYNC_PROCESS_UNCOLLECTED" });
    expect({ released, retained, collected, exists: await access(material).then(() => true, () => false) }).toEqual({ released: 0, retained: 1, collected: 0, exists: true });
  }));
  it("retains occupancy and lease when actual private file collection fails", async () => fixture(async directory => {
    const material = join(directory, "private-material"); await writeFile(material, "synthetic-secret"); let released = 0; let retained = 0;
    const owner = { directory, collect: async () => { await readFile(join(directory, "missing-owned-collection-proof")); }, retainUncollected: async () => { retained++; } };
    const lease = { leaseId: "private-fixture", release: async () => { released++; } };
    await expect(runPrivateSourceRead(owner, lease, async () => "fixed-result")).rejects.toMatchObject({ code: "SYNC_PROCESS_UNCOLLECTED" });
    expect({ released, retained, exists: await access(material).then(() => true, () => false) }).toEqual({ released: 0, retained: 1, exists: true });
  }));
});
