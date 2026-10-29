// Test-only driver: launches the real directory package and invokes its public preload/IPC.
// Hidden CDP checks exercise packaging and process ownership; they are not visual acceptance.
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { waitForRendererReady } from "../../../scripts/smoke-readiness.mjs";
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const profile = join(input.privateRoot, "packaged-probe-profile"), root = join(input.privateRoot, "packaged-probe-isolation");
await mkdir(profile, { recursive: true }); await mkdir(root, { recursive: true });
const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const env = { ...process.env, APICC_SMOKE_ISOLATED_ROOT: root, APICC_SMOKE_HIDE_WINDOW: "1" }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(input.executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
let output = "", ws, sequence = 0; const pending = new Map(), observed = new Map();
for (const stream of [child.stdout, child.stderr]) stream.on("data", value => { output += value; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = { executable: input.executable, pid: child.pid, profile, root, observations: [], results: [] };
function descendants() {
  const command = `@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq '${input.executable.replaceAll("'", "''")}' } | Select-Object ProcessId,ParentProcessId,CommandLine,@{n='birth';e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}}) | ConvertTo-Json -Compress`;
  const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true });
  return text.trim() ? [].concat(JSON.parse(text)).filter(row => row.ParentProcessId === child.pid && row.CommandLine.includes("stressChild.js")) : [];
}
async function evaluate(expression, timeout = 45000) {
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error("Packaged IPC deadline")); }, timeout);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (response.error || response.result?.exceptionDetails) throw Error(JSON.stringify(response.error ?? response.result.exceptionDetails));
  return response.result.result.value;
}
let observation;
try {
  const deadline = Date.now() + 30000; let page;
  while (Date.now() < deadline && !page) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(value => value.type === "page" && value.url.includes("dist-renderer/index.html")); } catch {}
    if (!page) await sleep(100);
  }
  assert.ok(page, "Directory package must load its own asar renderer");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Packaged CDP connection deadline")), Math.max(1, deadline - Date.now()));
    ws.onopen = () => { clearTimeout(timer); resolve(); }; ws.onerror = error => { clearTimeout(timer); reject(error); };
  });
  ws.onmessage = event => { const message = JSON.parse(event.data); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } };
  await waitForRendererReady({ deadline, isAlive: () => child.exitCode === null && child.signalCode === null,
    observe: async budget => {
      result.document = await evaluate("({url:location.href,title:document.title,readyState:document.readyState,children:document.querySelector('#app')?.children.length??-1,bridge:typeof window.apicc?.onlineExecution})", budget);
      if (result.document.bridge !== "function") throw Error(`Packaged public bridge not ready; last observation=${JSON.stringify(result.document)}`);
      return result.document;
    } });
  assert.equal(result.document.bridge, "function"); assert.match(result.document.url, /app\.asar/);
  await evaluate(`window.apicc.onlineLogin(${JSON.stringify({ baseUrl: input.baseUrl, username: input.username, password: input.password })})`);
  await evaluate(`window.apicc.onlineWorkspaceOpen(${JSON.stringify({ workspaceId: input.scope.workspaceId, name: "T8 synthetic", myRole: "OWNER" })})`);
  observation = setInterval(() => { for (const row of descendants()) observed.set(row.ProcessId, row); }, 150);
  for (const operation of input.operations) {
    const value = await evaluate(`window.apicc.onlineExecution(${JSON.stringify({ ...operation, context: input.context })})`);
    result.results.push(value);
  }
  clearInterval(observation); observation = undefined;
  result.observations = [...observed.values()];
  assert.equal(result.observations.length, input.expectedProcesses);
  assert.ok(result.observations.every(row => row.CommandLine.includes("app.asar") && row.birth));
  assert.equal(descendants().length, 0, "Every packaged stress child must exit before returning its result");
  // Tear down main during a held local run; IPC disconnect must stop all actual children.
  if (input.disconnectOperation) {
    const operation = { ...input.disconnectOperation, context: input.context };
    void evaluate(`window.apicc.onlineExecution(${JSON.stringify(operation)})`).catch(() => {});
    const stopDeadline = Date.now() + 15000; let active = [];
    while (Date.now() < stopDeadline) { active = descendants(); if (active.length === 3) break; await sleep(100); }
    assert.equal(active.length, 3); result.disconnectChildren = active;
    child.kill("SIGKILL"); result.mainExit = await exited;
    const exitDeadline = Date.now() + 10000;
    while (Date.now() < exitDeadline) {
      const remaining = active.filter(row => { try { process.kill(row.ProcessId, 0); return true; } catch { return false; } });
      if (!remaining.length) break;
      await sleep(100);
    }
    result.disconnectExit = active.map(row => { let alive = false; try { process.kill(row.ProcessId, 0); alive = true; } catch {} return { pid: row.ProcessId, alive }; });
    assert.ok(result.disconnectExit.every(row => !row.alive), "Main IPC disconnect must not leave packaged children running");
  }
  assert.doesNotMatch(output, /FATAL|Cannot find module|ERR_MODULE_NOT_FOUND/);
} finally {
  clearInterval(observation); ws?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); result.mainExit = await exited; }
  await appendFile(join(input.privateRoot, "packaged-probe.log"), output);
  await writeFile(process.argv[3], JSON.stringify(result, null, 2) + "\n");
}
