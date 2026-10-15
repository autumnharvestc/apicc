#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDir, "../..");
const cliDirectory = join(repositoryRoot, "packages", "cli");
const cliEntry = join(cliDirectory, "dist", "bin.js");
const args = process.argv.slice(2);
let packageDir;
let executable;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--package-dir" && args[index + 1]) packageDir = args[++index];
  else if (args[index] === "--exe" && args[index + 1]) executable = args[++index];
  else throw new Error(`未知或缺少参数: ${args[index]}`);
}
if (packageDir && executable) throw new Error("--package-dir 与 --exe 不能同时使用");
executable = resolve(executable ?? (packageDir ? join(packageDir, "apicc.exe") : join(desktopDir, "release", "win-unpacked", "apicc.exe")));
if (process.platform !== "win32" || !existsSync(executable)) throw new Error(`Windows 打包应用不存在: ${executable}`);

const failures = [];
const ok = (message) => console.log(`[PASS] ${message}`);
const fail = (message) => { failures.push(message); console.error(`[FAIL] ${message}`); };
const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function allocatePort() {
  return new Promise((resolvePort, rejectPort) => {
    const listener = createServer();
    listener.once("error", rejectPort);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") return rejectPort(new Error("port_unavailable"));
      listener.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  const opened = new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("cdp_socket_failed")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(new Error(`cdp_command_failed:${message.error.message ?? "unknown"}`));
    else waiter.resolve(message.result ?? {});
  });
  socket.addEventListener("close", () => {
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("cdp_connection_closed"));
    }
    pending.clear();
  });
  async function command(method, params = {}) {
    await opened;
    if (closed) throw new Error("cdp_connection_closed");
    const id = ++nextId;
    return new Promise((resolveCommand, rejectCommand) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectCommand(new Error(`cdp_command_timeout:${method}`));
      }, 15_000);
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "renderer_ipc_operation_failed";
      throw new Error(detail);
    }
    return result.result?.value;
  }
  return { command, evaluate, close: () => { if (!closed) socket.close(); } };
}

async function waitForTarget(port, child, selector, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not_ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("packed_app_exited_before_debugger_ready");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find(selector);
      if (target?.webSocketDebuggerUrl) return connectCdp(target.webSocketDebuggerUrl);
    } catch (error) {
      lastError = error instanceof Error ? error.name : "cdp_request_failed";
    }
    await sleep(250);
  }
  throw new Error(`debugger_target_timeout:${lastError}`);
}

async function waitForRendererMount(renderer, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const serialized = await renderer.evaluate("JSON.stringify({title:document.title,readyState:document.readyState,mounted:(document.querySelector('#app')?.children.length ?? 0)})");
      lastState = JSON.parse(serialized);
      if (lastState.title.toLowerCase().includes("apicc") && lastState.mounted >= 1) return lastState;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`renderer_not_mounted:${JSON.stringify({ lastState, lastError })}`);
}

async function startPackedApp(executablePath, roots) {
  const remotePort = await allocatePort();
  const inspectorPort = await allocatePort();
  const environment = {
    ...process.env,
    APICC_SMOKE_DIR: roots.workspace,
    APICC_SMOKE_ISOLATED_ROOT: roots.root,
    APICC_SMOKE_HIDE_WINDOW: "1",
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executablePath, [
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${roots.profile}`,
    `--inspect=127.0.0.1:${inspectorPort}`,
  ], { cwd: desktopDir, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-32_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-32_000); });
  try {
    const renderer = await waitForTarget(remotePort, child, (target) => target.type === "page" && String(target.url).includes("dist-renderer/index.html"));
    const inspector = await waitForTarget(inspectorPort, child, (target) => target.type === "node" || String(target.title).toLowerCase().includes("apicc"));
    let runtime;
    try {
      runtime = await inspector.evaluate("JSON.stringify({node:process.version,electron:process.versions.electron,platform:process.platform,arch:process.arch})");
    } finally {
      inspector.close();
    }
    const versions = JSON.parse(runtime);
    if (typeof versions.electron !== "string" || versions.platform !== "win32" || versions.arch !== "x64") {
      throw new Error("unexpected_electron_runtime_or_platform");
    }
    return { child, renderer, runtime: versions, output: () => output };
  } catch (error) {
    await stopPackedApp(child).catch(() => undefined);
    throw error;
  }
}

async function stopProcessTree(child, owner) {
  if (!child?.pid || child.exitCode !== null) return;
  const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  await new Promise((resolveKill) => { killer.once("exit", resolveKill); killer.once("error", resolveKill); });
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      sleep(5_000),
    ]);
  }
  if (child.exitCode === null) throw new Error(`${owner}_process_tree_did_not_exit`);
}

async function stopPackedApp(child) {
  return stopProcessTree(child, "packed_app");
}

async function runCliCase(apiPath, caseId, scope, roots) {
  if (!existsSync(cliEntry)) throw new Error(`built_cli_entry_missing:${cliEntry}`);
  const child = spawn(process.execPath, [
    cliEntry,
    "debug",
    apiPath,
    "--root",
    roots.workspace,
    "--case",
    caseId,
    "--scope",
    scope,
  ], {
    cwd: cliDirectory,
    env: {
      ...process.env,
      APPDATA: roots["cli-appdata"],
      USERPROFILE: roots["user-home"],
      HOME: roots["user-home"],
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-64_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-64_000); });
  const completed = new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  let timedOut = false;
  let timeoutHandle;
  const timeout = new Promise((resolveTimeout) => {
    timeoutHandle = setTimeout(async () => {
      timedOut = true;
      await stopProcessTree(child, "cli_debug").catch(() => undefined);
      resolveTimeout({ code: null, signal: null });
    }, 30_000);
  });
  try {
    const outcome = await Promise.race([completed, timeout]);
    if (timedOut) throw new Error("cli_debug_child_timed_out_after_30s");
    if (outcome.code !== 0) {
      throw new Error(`cli_debug_child_failed:exit=${outcome.code}:signal=${outcome.signal}:stderr=${stderr}`);
    }
    return { ...outcome, stdout, stderr };
  } catch (error) {
    await stopProcessTree(child, "cli_debug").catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function assertPrivateRoots(root, paths) {
  const canonicalRoot = realpathSync(root);
  const systemTemp = realpathSync(tmpdir());
  if (dirname(canonicalRoot) !== systemTemp || !/^apicc-p7-host-[a-z0-9-]+$/i.test(canonicalRoot.slice(systemTemp.length + 1))) {
    throw new Error("private_root_not_direct_child_of_system_temp");
  }
  const canonical = paths.map((path) => realpathSync(path));
  const distinct = new Set(canonical.map((path) => path.toLowerCase()));
  if (distinct.size !== paths.length) throw new Error("private_roots_are_not_distinct");
  const prefix = `${canonicalRoot}\\`.toLowerCase();
  for (const path of canonical) if (!path.toLowerCase().startsWith(prefix)) throw new Error("private_root_escaped_test_root");
  return { canonicalRoot, systemTemp };
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "apicc-p7-host-"));
const roots = Object.fromEntries(["profile", "workspace", "history", "credentials", "user-home", "cli-appdata"].map((name) => [name, join(temporaryRoot, name)]));
for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });
const { canonicalRoot, systemTemp } = assertPrivateRoots(temporaryRoot, Object.values(roots));
const pluginManifest = join(roots["user-home"], ".apicc", "plugins.json");
if (existsSync(pluginManifest)) throw new Error("test_plugin_manifest_must_start_absent");

let server;
let activeApp;
let preserveTemporaryRoot = false;
let observedPaths = [];
let phaseOneResult;

try {
  server = createServer((request, response) => {
    observedPaths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, source: "p7-local-synthetic-server" }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local_server_address_unavailable");

  let packed = await startPackedApp(executable, { ...roots, root: canonicalRoot });
  activeApp = packed.child;
  let renderer = packed.renderer;
  console.log(`[RUNTIME:1] ${JSON.stringify(packed.runtime)}`);
  ok("真实 Electron 主进程运行时由 Node inspector 读取");

  try {
    const pageState = await waitForRendererMount(renderer);
    ok(`新包 renderer 已加载并挂载：${JSON.stringify(pageState)}`);
    const plugins = await renderer.evaluate("window.apicc.pluginsList()");
    if (!plugins || plugins.plugins.length !== 0) throw new Error("user_plugins_not_empty_or_plugins_list_unavailable");
    ok("插件列表从新建的隔离 home 加载且为零用户插件");

    const smoke = {
      workspace: roots.workspace,
      baseUrl: `http://127.0.0.1:${address.port}`,
    };
    const expression = `(async()=>{
      const api = window.apicc;
      const args = ${JSON.stringify(smoke)};
      const opened = await api.wsCreate(args.workspace, "P7 packaged host smoke");
      const tree = await api.treeGet();
      if (tree.kind !== "root" || !tree.children.some((node) => node.kind === "group")) throw new Error("workspace_tree_missing_group");
      const group = tree.children.find((node) => node.kind === "group");
      const projectNode = await api.nodeCreate({ kind: "project", parent: group.locator, name: "P7 Project" });
      const collectionNode = await api.nodeCreate({ kind: "collection", parent: projectNode.locator, name: "P7 Collection" });
      const apiNode = await api.nodeCreate({ kind: "api", parent: collectionNode.locator, api: { name: "P7 API", protocol: "http", method: "GET", baseUrl: args.baseUrl, path: "/initial" } });
      const before = await api.apiGet(apiNode.locator);
      const dirtyRequest = JSON.parse(JSON.stringify(before.api.contract.request));
      dirtyRequest.path = "/dirty-send";
      const started = await api.debugStart({ mode: "request", locator: apiNode.locator, request: dirtyRequest, parameters: {}, fields: [] });
      const result = await api.debugWait({ runId: started.runId });
      if (!result || result.run.failed !== 0 || result.run.passed !== 1 || result.exchanges[0]?.response?.status !== 200) throw new Error("dirty_request_send_failed");
      const historyPage = await api.debugHistoryList({ limit: 10, offset: 0 });
      const history = historyPage.items.find((item) => item.runId === result.runId);
      if (!history) throw new Error("history_summary_missing_after_wait");
      const loaded = await api.debugHistoryGet(history.historyId);
      if (!loaded.record || loaded.record.result.runId !== result.runId) throw new Error("history_reopen_failed");
      const restored = await api.debugHistoryRestore({ historyId: history.historyId, exchangeOrder: 1 });
      if (!restored.sourceAvailable || restored.invocation.mode !== "request" || restored.invocation.request.path !== "/dirty-send") throw new Error("history_restore_failed");
      const targetCase = JSON.parse(JSON.stringify(before.api.cases[0]));
      if (!targetCase) throw new Error("default_case_missing");
      targetCase.requestOverride = restored.invocation.request;
      const caseLocator = { ...apiNode.locator, caseId: targetCase.id, scope: targetCase.scope };
      await api.caseDraftSave(caseLocator, targetCase, before.sourceApiRevision, [], []);
      const reopened = await api.wsOpen(args.workspace);
      const after = await api.apiGet(apiNode.locator);
      const savedCase = after.api.cases.find((item) => item.id === targetCase.id && item.scope === targetCase.scope);
      if (!reopened || !savedCase?.requestOverride || savedCase.requestOverride.path !== "/dirty-send") throw new Error("case_override_missing_after_workspace_reopen");
      return JSON.stringify({
        workspaceRoot: reopened.root,
        locator: apiNode.locator,
        runId: result.runId,
        historyId: history.historyId,
        caseId: targetCase.id,
        scope: targetCase.scope,
        status: result.exchanges[0].response.status,
        sentRequestUrl: result.exchanges[0].request.url,
        savedCasePath: savedCase.requestOverride.path,
        sourceAvailable: restored.sourceAvailable,
        sourceChanged: restored.sourceChanged,
      });
    })()`;
    const resultJson = await renderer.evaluate(expression);
    phaseOneResult = JSON.parse(resultJson);
    if (!observedPaths.includes("/dirty-send")) throw new Error(`local_server_did_not_observe_dirty_path:${JSON.stringify(observedPaths)}`);
    if (!phaseOneResult.sentRequestUrl.includes("/dirty-send") || phaseOneResult.savedCasePath !== "/dirty-send") throw new Error("bridge_result_does_not_match_saved_dirty_request");
    console.log(`[HOST:1] ${JSON.stringify({ ...phaseOneResult, observedLocalPaths: observedPaths })}`);
    ok("真实 packaged bridge 完成 dirty request IPC 发送、history restore、保存 case 与工作区重开");
    ok("合成本地 HTTP server 收到 dirty path；未调用 native picker/save 对话框");
  } finally {
    renderer.close();
  }

  if (/FATAL|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(packed.output())) throw new Error("packed_app_output_contains_fatal_or_module_error");
  await stopPackedApp(packed.child);
  activeApp = undefined;

  packed = await startPackedApp(executable, { ...roots, root: canonicalRoot });
  activeApp = packed.child;
  renderer = packed.renderer;
  console.log(`[RUNTIME:2] ${JSON.stringify(packed.runtime)}`);
  try {
    const restartCheck = {
      workspace: roots.workspace,
      historyId: phaseOneResult.historyId,
      apiLocator: phaseOneResult.locator,
      caseId: phaseOneResult.caseId,
      scope: phaseOneResult.scope,
    };
    const restarted = await renderer.evaluate(`(async()=>{
      const api = window.apicc;
      const args = ${JSON.stringify(restartCheck)};
      await api.wsOpen(args.workspace);
      const history = await api.debugHistoryGet(args.historyId);
      if (!history.record || history.record.result.exchanges[0]?.request?.url?.includes("/dirty-send") !== true) throw new Error("history_missing_after_process_restart");
      const restored = await api.debugHistoryRestore({ historyId: args.historyId, exchangeOrder: 1 });
      const detail = await api.apiGet(args.apiLocator);
      const testCase = detail.api.cases.find((item) => item.id === args.caseId && item.scope === args.scope);
      if (!restored.sourceAvailable || restored.invocation.mode !== "request" || restored.invocation.request.path !== "/dirty-send") throw new Error("restore_missing_after_process_restart");
      if (!testCase?.requestOverride || testCase.requestOverride.path !== "/dirty-send") throw new Error("saved_case_missing_after_process_restart");
      return JSON.stringify({ historyId: history.record.historyId, historyPath: restored.invocation.request.path, casePath: testCase.requestOverride.path, sourceAvailable: restored.sourceAvailable });
    })()`);
    const restartedResult = JSON.parse(restarted);
    const plugins = await renderer.evaluate("window.apicc.pluginsList()");
    if (plugins.plugins.length !== 0) throw new Error("user_plugins_not_empty_after_process_restart");
    console.log(`[HOST:2] ${JSON.stringify(restartedResult)}`);
    ok("独立第二个 Electron 进程重开同一临时 workspace/history root，仍读取 history、restore 和已保存 case");
  } finally {
    renderer.close();
  }
  if (/FATAL|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(packed.output())) throw new Error("restarted_packed_app_output_contains_fatal_or_module_error");
  await stopPackedApp(packed.child);
  activeApp = undefined;

  const cliApiPath = [
    "groups", phaseOneResult.locator.groupId,
    "projects", phaseOneResult.locator.projectId,
    "collections", phaseOneResult.locator.collectionId,
    "apis", phaseOneResult.locator.apiId,
  ].join("/");
  const cliOutcome = await runCliCase(cliApiPath, phaseOneResult.caseId, phaseOneResult.scope, roots);
  const cliResult = JSON.parse(cliOutcome.stdout);
  const cliRequestUrl = cliResult.exchanges?.[0]?.request?.url;
  const cliResponseStatus = cliResult.exchanges?.[0]?.response?.status;
  if (cliResult.run?.failed !== 0 || cliResult.run?.passed !== 1
    || cliResponseStatus !== 200 || !String(cliRequestUrl).endsWith("/dirty-send")) {
    throw new Error("cli_did_not_consume_saved_case_from_restarted_workspace");
  }
  if (observedPaths.filter((path) => path === "/dirty-send").length < 2) {
    throw new Error(`synthetic_server_did_not_observe_both_bridge_and_cli_requests:${JSON.stringify(observedPaths)}`);
  }
  console.log(`[CLI:1] ${JSON.stringify({ node: process.version, executable: process.execPath, exitCode: cliOutcome.code, caseId: phaseOneResult.caseId, scope: phaseOneResult.scope, requestUrl: cliRequestUrl, responseStatus: cliResponseStatus })}`);
  ok("独立 Node 子进程中的 CLI 从第二 Electron 进程保存的同一 workspace/case 读取并向合成本地 server 成功发包");

  const verified = assertPrivateRoots(temporaryRoot, Object.values(roots));
  console.log(`[ISOLATION] ${JSON.stringify({ root: verified.canonicalRoot, profile: realpathSync(roots.profile), workspace: realpathSync(roots.workspace), history: realpathSync(roots.history), credentials: realpathSync(roots.credentials), pluginHome: realpathSync(roots["user-home"]), cliAppData: realpathSync(roots["cli-appdata"]), userPlugins: 0 })}`);
  ok("profile、workspace、history、credential、plugin roots 独立且都在本次私有临时根内");
} catch (error) {
  preserveTemporaryRoot = true;
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (activeApp?.pid && activeApp.exitCode === null) await stopPackedApp(activeApp).catch((error) => fail(`process_cleanup_failed:${error instanceof Error ? error.message : String(error)}`));
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  await sleep(500);
  if (!preserveTemporaryRoot) {
    const resolvedRoot = realpathSync(temporaryRoot);
    const stat = lstatSync(resolvedRoot);
    if (dirname(resolvedRoot) === systemTemp && stat.isDirectory() && !stat.isSymbolicLink()
      && /^apicc-p7-host-[a-z0-9-]+$/i.test(resolvedRoot.slice(systemTemp.length + 1))) {
      rmSync(resolvedRoot, { recursive: true, force: false });
    } else {
      fail(`安全检查失败，保留临时根：${temporaryRoot}`);
    }
  } else {
    console.log(`[PRESERVED] failed smoke roots: ${temporaryRoot}`);
  }
}

if (failures.length) process.exit(1);
console.log("P7 packaged Electron debug-loop host smoke passed");
