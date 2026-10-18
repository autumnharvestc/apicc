#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDir, "../..");
const cliDirectory = join(repositoryRoot, "packages", "cli");
const cliEntry = join(cliDirectory, "dist", "bin.js");
const args = process.argv.slice(2);
let packageDir;
let executable;
let keepRoot = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--package-dir" && args[index + 1]) packageDir = args[++index];
  else if (args[index] === "--exe" && args[index + 1]) executable = args[++index];
  else if (args[index] === "--keep-root") keepRoot = true;
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

async function runCliCase(apiPath, caseId, scope, roots, options = {}) {
  if (!existsSync(cliEntry)) throw new Error(`built_cli_entry_missing:${cliEntry}`);
  const cliArgs = [
    cliEntry,
    "debug",
    apiPath,
    "--root",
    roots.workspace,
    "--case",
    caseId,
    "--scope",
    scope,
  ];
  let child;
  if (options.sharedOAuthRoots === true) {
    const cliModuleUrl = pathToFileURL(join(cliDirectory, "dist", "main.js")).href;
    const ownedDeps = {
      loadPlugins: false,
      pluginsHomeDir: roots["user-home"],
      credentialPrivateRoot: roots.credentials,
      networkPrivateRoot: roots.network,
      oauthPrivateRoot: roots.oauth,
      debugHistoryAppDataDirectory: roots["cli-appdata"],
    };
    const embeddedRunner = `
import { runCli } from ${JSON.stringify(cliModuleUrl)};
import { createDefaultRegistry } from "@apicc/core";
const output = [];
const code = await runCli(${JSON.stringify(cliArgs.slice(1))}, createDefaultRegistry(), (line) => output.push(line), ${JSON.stringify(ownedDeps)});
for (const line of output) console.log(line);
process.exitCode = code;
`;
    child = spawn(process.execPath, ["--input-type=module", "-e", embeddedRunner], {
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
  } else {
    child = spawn(process.execPath, cliArgs, {
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
  }
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

async function cleanupOAuthFixture(fixture, roots) {
  if (!fixture) return { status: "not-needed", cleanupAttempted: false, profile: { attempted: false, outcome: "not-needed" }, credentialRefs: [] };
  const { createOAuthProfileHost, createSystemSecretStore } = await import("@apicc/core");
  const secretStore = createSystemSecretStore({ privateRoot: roots.credentials });
  const result = {
    status: "attempted",
    cleanupAttempted: true,
    profile: { attempted: false, outcome: "not-needed" },
    credentialRefs: [],
  };
  const failures = [];
  if (fixture.profileAttempted) {
    result.profile = { attempted: true, outcome: "attempted" };
    try {
      const host = await createOAuthProfileHost({
        workspaceRoot: roots.workspace,
        project: fixture.scope.project,
        privateRoot: roots.oauth,
        secretStore,
      });
      const unlinked = await host.unlinkProfile(fixture.profileId);
      if (unlinked.status === "success") result.profile.outcome = "unlinked";
      else if (unlinked.errorCode === "OAUTH_PROFILE_NOT_FOUND") result.profile.outcome = "not-needed";
      else throw new Error(`oauth_fixture_unlink_failed:${unlinked.errorCode ?? unlinked.status}`);
    } catch (error) {
      result.profile.outcome = "failed";
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const ref of fixture.ownedRefs) {
    const entry = { id: ref.id, attempted: false, outcome: "not-needed" };
    result.credentialRefs.push(entry);
    try {
      const before = await secretStore.status(fixture.scope.project, ref);
      if (before === "missing") continue;
      if (before !== "available") throw new Error(`credential_ref_status_${before}:${ref.id}`);
      entry.attempted = true;
      entry.outcome = "attempted";
      await secretStore.remove(fixture.scope.project, ref);
      const after = await secretStore.status(fixture.scope.project, ref);
      if (after !== "missing") throw new Error(`credential_ref_cleanup_not_confirmed:${ref.id}:${after}`);
      entry.outcome = "removed";
    } catch (error) {
      entry.outcome = "failed";
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    result.status = "failed";
    const error = new Error(failures.join("; "));
    error.cleanupState = result;
    throw error;
  }
  result.status = result.profile.outcome === "unlinked" || result.credentialRefs.some((ref) => ref.outcome === "removed")
    ? "confirmed"
    : "not-needed";
  return result;
}

function assertPrivateRoots(root, paths) {
  const canonicalRoot = realpathSync(root);
  const systemTemp = realpathSync(tmpdir());
  if (dirname(canonicalRoot) !== systemTemp || !/^apicc-f2b-host-[a-z0-9-]+$/i.test(canonicalRoot.slice(systemTemp.length + 1))) {
    throw new Error("private_root_not_direct_child_of_system_temp");
  }
  const canonical = paths.map((path) => realpathSync(path));
  const distinct = new Set(canonical.map((path) => path.toLowerCase()));
  if (distinct.size !== paths.length) throw new Error("private_roots_are_not_distinct");
  const prefix = `${canonicalRoot}\\`.toLowerCase();
  for (const path of canonical) if (!path.toLowerCase().startsWith(prefix)) throw new Error("private_root_escaped_test_root");
  return { canonicalRoot, systemTemp };
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "apicc-f2b-host-"));
const roots = Object.fromEntries(["profile", "workspace", "history", "credentials", "network", "oauth", "user-home", "cli-appdata"].map((name) => [name, join(temporaryRoot, name)]));
for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });
const { canonicalRoot, systemTemp } = assertPrivateRoots(temporaryRoot, Object.values(roots));
const pluginManifest = join(roots["user-home"], ".apicc", "plugins.json");
if (existsSync(pluginManifest)) throw new Error("test_plugin_manifest_must_start_absent");

let server;
let oauthServer;
let activeApp;
let preserveTemporaryRoot = keepRoot;
let observedPaths = [];
const oauthObservations = { token: [], business: [] };
let oauthFixture;
let phaseOneResult;
let freePhaseOneResult;
let oauthPhaseOneResult;

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

    const freeSmoke = {
      project: {
        workspaceId: phaseOneResult.locator.workspaceId,
        groupId: phaseOneResult.locator.groupId,
        projectId: phaseOneResult.locator.projectId,
      },
      targetParent: {
        workspaceId: phaseOneResult.locator.workspaceId,
        groupId: phaseOneResult.locator.groupId,
        projectId: phaseOneResult.locator.projectId,
        collectionId: phaseOneResult.locator.collectionId,
      },
      baseUrl: smoke.baseUrl,
      draftId: randomUUID(),
    };
    const freeResultJson = await renderer.evaluate(`(async()=>{
      const api = window.apicc;
      const args = ${JSON.stringify(freeSmoke)};
      const request = {
        protocol: "http", method: "GET", baseUrl: args.baseUrl, path: "/free-from-history",
        pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" },
      };
      const started = await api.debugStart({ mode: "free", project: args.project, draftId: args.draftId, request, parameters: {}, fields: [] });
      const result = await api.debugWait({ runId: started.runId });
      if (!result || result.run.failed !== 0 || result.run.passed !== 1 || result.exchanges[0]?.response?.status !== 200) throw new Error("free_request_send_failed");
      const historyPage = await api.debugHistoryList({ sourceKind: "free", limit: 20, offset: 0 });
      const history = historyPage.items.find((item) => item.runId === result.runId);
      if (!history) throw new Error("free_history_summary_missing_after_wait");
      const restored = await api.debugHistoryRestore({ historyId: history.historyId, exchangeOrder: 1, project: args.project });
      if (!restored.sourceAvailable || restored.invocation.mode !== "free" || restored.invocation.project.projectId !== args.project.projectId
        || restored.invocation.request.path !== "/free-from-history") throw new Error("free_history_restore_failed");
      const projectContext = await api.debugProjectContext(args.project);
      const saved = await api.apiCreateFromRequestDraft({
        project: args.project,
        targetParent: args.targetParent,
        name: "Free request saved from history",
        request: restored.invocation.request,
        sourceProjectRevision: projectContext.sourceProjectRevision,
        fields: [],
      });
      const targetCase = saved.detail.api.cases[0];
      if (!targetCase || saved.detail.api.contract.request.path !== "/free-from-history") throw new Error("saved_free_request_missing_from_api");
      return JSON.stringify({
        project: args.project,
        runId: result.runId,
        historyId: history.historyId,
        locator: saved.locator,
        caseId: targetCase.id,
        scope: targetCase.scope,
        responseStatus: result.exchanges[0].response.status,
        savedPath: saved.detail.api.contract.request.path,
      });
    })()`);
    freePhaseOneResult = JSON.parse(freeResultJson);
    if (!observedPaths.includes("/free-from-history")) throw new Error(`local_server_did_not_observe_free_path:${JSON.stringify(observedPaths)}`);
    console.log(`[FREE:1] ${JSON.stringify({ ...freePhaseOneResult, observedLocalPaths: observedPaths })}`);
    ok("真实 packaged bridge 完成 free 请求、history restore 与保存为正式接口");

    const project = freeSmoke.project;
    const oauthFixtureFiles = join(repositoryRoot, "packages", "core", "tests", "http", "fixtures", "network");
    const targetCa = readFileSync(join(oauthFixtureFiles, "synthetic-target-ca.pem"));
    const targetCertificate = readFileSync(join(oauthFixtureFiles, "synthetic-target-server.pem"));
    const targetKey = readFileSync(join(oauthFixtureFiles, "synthetic-target-server.key"));
    const caPath = join(roots.network, "synthetic-target-ca.pem");
    writeFileSync(caPath, targetCa, { flag: "wx" });
    const oauthClientId = "f2b-smoke-client";
    const oauthClientSecret = `synthetic-${randomUUID()}`;
    const oauthAccessToken = `synthetic-${randomUUID()}`;
    const oauthProfileId = `f2b-smoke-${randomUUID()}`;
    const oauthBearerRef = { id: `f2b-smoke-bearer-${randomUUID()}`, policy: "test-auto" };
    const oauthClientSecretRef = { id: `f2b-smoke-client-secret-${randomUUID()}`, policy: "test-auto" };
    const expectedClientAuthorization = `Basic ${Buffer.from(`${oauthClientId}:${oauthClientSecret}`, "utf8").toString("base64")}`;
    oauthFixture = {
      scope: {
        canonicalRoot: realpathSync(roots.workspace),
        project: {
          workspaceId: project.workspaceId,
          groupId: project.groupId,
          projectId: project.projectId,
        },
      },
      profileId: oauthProfileId,
      ownedRefs: [oauthClientSecretRef, oauthBearerRef],
      profileAttempted: false,
      cleanupAttempted: false,
    };
    oauthServer = createHttpsServer({ cert: targetCertificate, key: targetKey }, async (request, response) => {
      const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname === "/oauth/token") {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const clientAuthenticated = request.headers.authorization === expectedClientAuthorization;
        const grantType = form.get("grant_type");
        oauthObservations.token.push({ path: url.pathname, grantType, clientAuthenticated });
        if (grantType !== "client_credentials" || !clientAuthenticated) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_client" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: oauthAccessToken, token_type: "Bearer", expires_in: 3600 }));
        return;
      }
      if (url.pathname === "/oauth-business") {
        for await (const _chunk of request) { /* consume request */ }
        const bearerAuthenticated = request.headers.authorization === `Bearer ${oauthAccessToken}`;
        oauthObservations.business.push({ path: url.pathname, bearerAuthenticated });
        response.writeHead(bearerAuthenticated ? 200 : 401, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: bearerAuthenticated }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolveListen, rejectListen) => {
      oauthServer.once("error", rejectListen);
      oauthServer.listen(0, "127.0.0.1", resolveListen);
    });
    const oauthAddress = oauthServer.address();
    if (!oauthAddress || typeof oauthAddress === "string") throw new Error("oauth_tls_server_address_unavailable");
    const oauthBaseUrl = `https://127.0.0.1:${oauthAddress.port}`;
    const oauthSetup = {
      project,
      baseUrl: oauthBaseUrl,
      caPath,
      profileId: oauthProfileId,
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      clientSecretRef: oauthClientSecretRef,
      bearerRef: oauthBearerRef,
    };
    const networkAndSecret = JSON.parse(await renderer.evaluate(`(async()=>{
      const api = window.apicc;
      const args = ${JSON.stringify(oauthSetup)};
      const current = await api.networkProfilesGet(args.project);
      const configuration = {
        formatVersion: 1,
        profiles: [{
          id: "f2b-smoke-target-ca",
          name: "F2b smoke target CA",
          kind: "direct",
          targetTlsBindings: [{ origin: args.baseUrl, tls: { caCertificatePaths: [args.caPath] } }],
        }],
        projectSelection: { kind: "profile", profileId: "f2b-smoke-target-ca" },
        environmentSelections: [],
      };
      const savedNetwork = await api.networkProfilesSave({ locator: args.project, revision: current.revision, configuration });
      if (!savedNetwork.revision) throw new Error("oauth_network_profile_save_failed");
      const stored = await api.credentialPut({ locator: args.project, ref: args.clientSecretRef, value: args.clientSecret });
      if (!stored.ok) throw new Error("oauth_client_secret_credential_put_failed:" + stored.error.code);
      const selected = await api.networkProfilesGet(args.project);
      const selectedProfile = selected.configuration.profiles.find((profile) => profile.id === "f2b-smoke-target-ca");
      if (selected.configuration.projectSelection.kind !== "profile"
        || selected.configuration.projectSelection.profileId !== "f2b-smoke-target-ca"
        || selectedProfile?.kind !== "direct"
        || selectedProfile.targetTlsBindings[0]?.origin !== args.baseUrl
        || selectedProfile.targetTlsBindings[0]?.tls.caCertificatePaths[0] !== args.caPath) {
        throw new Error("oauth_ca_profile_selection_missing");
      }
      return JSON.stringify({ profileId: selected.configuration.projectSelection.profileId, caPath: selectedProfile.targetTlsBindings[0].tls.caCertificatePaths[0] });
    })()`));
    oauthFixture.profileAttempted = true;
    const profileSave = JSON.parse(await renderer.evaluate(`(async()=>{
      const api = window.apicc;
      const args = ${JSON.stringify(oauthSetup)};
      const current = await api.oauthProfilesGet({ locator: args.project });
      const saved = await api.oauthProfileSave({
        locator: args.project,
        expectedRevision: current.revision,
        profile: {
          profileId: args.profileId,
          flow: "client_credentials",
          tokenEndpoint: args.baseUrl + "/oauth/token",
          clientId: args.clientId,
          clientAuthentication: "client_secret_basic",
          clientSecretRef: args.clientSecretRef,
          bearerRef: args.bearerRef,
        },
      });
      return JSON.stringify({ result: saved.result, profileSnapshot: saved.profileSnapshot });
    })()`));
    if (profileSave.result.status !== "success"
      || profileSave.profileSnapshot.status !== "available"
      || !profileSave.profileSnapshot.profiles.some((profile) => profile.profile.profileId === oauthProfileId)) {
      throw new Error("oauth_profile_save_failed");
    }

    const acquired = JSON.parse(await renderer.evaluate(`(async()=>{
      const result = await window.apicc.oauthProfileAcquire({ locator: ${JSON.stringify(project)}, profileId: ${JSON.stringify(oauthProfileId)} });
      return JSON.stringify({ result: result.result, profileSnapshot: result.profileSnapshot });
    })()`));
    if (acquired.result.status !== "success" || acquired.profileSnapshot.status !== "available") throw new Error("oauth_client_credentials_acquire_failed");
    const acquiredProfile = acquired.profileSnapshot.profiles.find((profile) => profile.profile.profileId === oauthProfileId);
    if (acquiredProfile?.status !== "connected") throw new Error("oauth_acquired_profile_not_connected");
    if (oauthObservations.token.length !== 1 || oauthObservations.token[0].grantType !== "client_credentials"
      || !oauthObservations.token[0].clientAuthenticated) throw new Error("oauth_tls_token_request_not_observed");
    console.log(`[OAUTH:SETUP] ${JSON.stringify({ networkProfileId: networkAndSecret.profileId, caPath: networkAndSecret.caPath, oauthProfileId, tokenRequests: oauthObservations.token.length, clientAuthenticated: oauthObservations.token[0].clientAuthenticated })}`);
    ok("真实 packaged bridge 已保存 network CA、credentialPut/client_credentials profile 并完成 TLS token acquire");

    const oauthFree = {
      project,
      baseUrl: oauthBaseUrl,
      bearerRef: oauthBearerRef,
      draftId: randomUUID(),
    };
    const oauthFreeJson = await renderer.evaluate(`(async()=>{
      const api = window.apicc;
      const args = ${JSON.stringify(oauthFree)};
      const request = {
        protocol: "http", method: "GET", baseUrl: args.baseUrl, path: "/oauth-business",
        pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "bearer", token: args.bearerRef }, body: { kind: "none" },
      };
      const started = await api.debugStart({ mode: "free", project: args.project, draftId: args.draftId, request, parameters: {}, fields: [] });
      const result = await api.debugWait({ runId: started.runId });
      if (!result || result.run.failed !== 0 || result.run.passed !== 1 || result.exchanges[0]?.response?.status !== 200) throw new Error("oauth_free_business_request_failed");
      const historyPage = await api.debugHistoryList({ sourceKind: "free", limit: 30, offset: 0 });
      const history = historyPage.items.find((item) => item.runId === result.runId);
      if (!history) throw new Error("oauth_free_history_missing");
      const restored = await api.debugHistoryRestore({ historyId: history.historyId, exchangeOrder: 1, project: args.project });
      if (!restored.sourceAvailable || restored.invocation.mode !== "free"
        || restored.invocation.request.path !== "/oauth-business"
        || restored.invocation.request.auth.kind !== "bearer"
        || restored.invocation.request.auth.token.id !== args.bearerRef.id) throw new Error("oauth_free_history_restore_failed");
      const projectContext = await api.debugProjectContext(args.project);
      const saved = await api.apiCreateFromRequestDraft({
        project: args.project,
        targetParent: { ...args.project, collectionId: ${JSON.stringify(phaseOneResult.locator.collectionId)} },
        name: "OAuth free request saved from history",
        request: restored.invocation.request,
        sourceProjectRevision: projectContext.sourceProjectRevision,
        fields: [],
      });
      const targetCase = saved.detail.api.cases[0];
      if (!targetCase || saved.detail.api.contract.request.path !== "/oauth-business"
        || saved.detail.api.contract.request.auth.kind !== "bearer"
        || saved.detail.api.contract.request.auth.token.id !== args.bearerRef.id) throw new Error("oauth_free_request_save_failed");
      return JSON.stringify({ project: args.project, runId: result.runId, historyId: history.historyId, locator: saved.locator,
        caseId: targetCase.id, scope: targetCase.scope, responseStatus: result.exchanges[0].response.status,
        savedPath: saved.detail.api.contract.request.path, bearerRefId: args.bearerRef.id });
    })()`);
    oauthPhaseOneResult = JSON.parse(oauthFreeJson);
    const oauthBusinessProof = oauthObservations.business[0];
    if (oauthObservations.business.length !== 1 || oauthBusinessProof?.path !== "/oauth-business" || !oauthBusinessProof.bearerAuthenticated) {
      throw new Error("oauth_tls_business_bearer_not_observed");
    }
    console.log(`[OAUTH:FREE:1] ${JSON.stringify({ ...oauthPhaseOneResult, tokenRequests: oauthObservations.token.length, businessRequests: oauthObservations.business.length, bearerAuthenticated: oauthBusinessProof.bearerAuthenticated })}`);
    ok("free Bearer 请求经已选 CA profile 实际发送，随后恢复历史并保存为正式 API/case");
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
      freeProject: freePhaseOneResult.project,
      freeHistoryId: freePhaseOneResult.historyId,
      freeRunId: freePhaseOneResult.runId,
      freeApiLocator: freePhaseOneResult.locator,
      oauthProject: oauthPhaseOneResult.project,
      oauthHistoryId: oauthPhaseOneResult.historyId,
      oauthRunId: oauthPhaseOneResult.runId,
      oauthApiLocator: oauthPhaseOneResult.locator,
      oauthCaseId: oauthPhaseOneResult.caseId,
      oauthScope: oauthPhaseOneResult.scope,
      oauthProfileId: oauthFixture.profileId,
      oauthBearerRefId: oauthFixture.ownedRefs.find((ref) => ref.id.startsWith("f2b-smoke-bearer-"))?.id,
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
      const freeHistory = await api.debugHistoryGet(args.freeHistoryId);
      if (!freeHistory.record || freeHistory.record.result.runId !== args.freeRunId) throw new Error("free_history_missing_after_process_restart");
      const freeRestored = await api.debugHistoryRestore({ historyId: args.freeHistoryId, exchangeOrder: 1, project: args.freeProject });
      const freeApi = await api.apiGet(args.freeApiLocator);
      if (!freeRestored.sourceAvailable || freeRestored.invocation.mode !== "free" || freeRestored.invocation.request.path !== "/free-from-history"
        || freeApi.api.contract.request.path !== "/free-from-history") throw new Error("saved_free_history_chain_missing_after_process_restart");
      const oauthHistory = await api.debugHistoryGet(args.oauthHistoryId);
      if (!oauthHistory.record || oauthHistory.record.result.runId !== args.oauthRunId) throw new Error("oauth_history_missing_after_process_restart");
      const oauthRestored = await api.debugHistoryRestore({ historyId: args.oauthHistoryId, exchangeOrder: 1, project: args.oauthProject });
      const oauthApi = await api.apiGet(args.oauthApiLocator);
      const oauthProfiles = await api.oauthProfilesGet({ locator: args.oauthProject });
      const oauthProfile = oauthProfiles.profiles.find((item) => item.profile.profileId === args.oauthProfileId);
      if (!oauthRestored.sourceAvailable || oauthRestored.invocation.mode !== "free"
        || oauthRestored.invocation.request.path !== "/oauth-business"
        || oauthApi.api.contract.request.path !== "/oauth-business"
        || oauthApi.api.contract.request.auth.kind !== "bearer"
        || oauthApi.api.contract.request.auth.token.id !== args.oauthBearerRefId
        || oauthProfile?.status !== "connected") throw new Error("oauth_saved_state_missing_after_process_restart");
      const oauthStarted = await api.debugStart({ mode: "request", locator: args.oauthApiLocator, request: oauthApi.api.contract.request, parameters: {}, fields: [] });
      const oauthResult = await api.debugWait({ runId: oauthStarted.runId });
      if (!oauthResult || oauthResult.run.failed !== 0 || oauthResult.run.passed !== 1
        || oauthResult.exchanges[0]?.response?.status !== 200) throw new Error("oauth_persisted_token_business_request_failed_after_restart");
      return JSON.stringify({
        historyId: history.record.historyId, historyPath: restored.invocation.request.path, casePath: testCase.requestOverride.path, sourceAvailable: restored.sourceAvailable,
        freeHistoryId: freeHistory.record.historyId, freeHistoryPath: freeRestored.invocation.request.path, freeApiPath: freeApi.api.contract.request.path,
        oauthHistoryId: oauthHistory.record.historyId, oauthHistoryPath: oauthRestored.invocation.request.path, oauthApiPath: oauthApi.api.contract.request.path,
        oauthProfileStatus: oauthProfile.status, oauthRestartResponseStatus: oauthResult.exchanges[0].response.status,
      });
    })()`);
    const restartedResult = JSON.parse(restarted);
    if (oauthObservations.token.length !== 1 || oauthObservations.business.length !== 2
      || oauthObservations.business.some((entry) => !entry.bearerAuthenticated)) {
      throw new Error("oauth_persisted_token_not_reused_after_desktop_restart");
    }
    const plugins = await renderer.evaluate("window.apicc.pluginsList()");
    if (plugins.plugins.length !== 0) throw new Error("user_plugins_not_empty_after_process_restart");
    console.log(`[HOST:2] ${JSON.stringify(restartedResult)}`);
    console.log(`[OAUTH:RESTART] ${JSON.stringify({ tokenRequests: oauthObservations.token.length, businessRequests: oauthObservations.business.length, bearerAuthenticated: oauthObservations.business.every((entry) => entry.bearerAuthenticated) })}`);
    ok("第二个 Electron 进程用同一 owned credential/network/oauth roots 重读连接状态，并用持久 token 完成正式 API 请求");
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

  const freeApiPath = [
    "groups", freePhaseOneResult.locator.groupId,
    "projects", freePhaseOneResult.locator.projectId,
    "collections", freePhaseOneResult.locator.collectionId,
    "apis", freePhaseOneResult.locator.apiId,
  ].join("/");
  const freeCliOutcome = await runCliCase(freeApiPath, freePhaseOneResult.caseId, freePhaseOneResult.scope, roots);
  const freeCliResult = JSON.parse(freeCliOutcome.stdout);
  const freeCliRequestUrl = freeCliResult.exchanges?.[0]?.request?.url;
  const freeCliStatus = freeCliResult.exchanges?.[0]?.response?.status;
  if (freeCliResult.run?.failed !== 0 || freeCliResult.run?.passed !== 1
    || freeCliStatus !== 200 || !String(freeCliRequestUrl).endsWith("/free-from-history")) {
    throw new Error("cli_did_not_consume_api_saved_from_free_history");
  }
  if (observedPaths.filter((path) => path === "/free-from-history").length < 2) {
    throw new Error(`synthetic_server_did_not_observe_free_bridge_and_cli_requests:${JSON.stringify(observedPaths)}`);
  }
  console.log(`[CLI:2] ${JSON.stringify({ node: process.version, executable: process.execPath, exitCode: freeCliOutcome.code, caseId: freePhaseOneResult.caseId, scope: freePhaseOneResult.scope, requestUrl: freeCliRequestUrl, responseStatus: freeCliStatus })}`);
  ok("独立 Node CLI 消费 free history 保存的同一正式接口并向合成本地 server 发包");

  const oauthApiPath = [
    "groups", oauthPhaseOneResult.locator.groupId,
    "projects", oauthPhaseOneResult.locator.projectId,
    "collections", oauthPhaseOneResult.locator.collectionId,
    "apis", oauthPhaseOneResult.locator.apiId,
  ].join("/");
  const oauthCliOutcome = await runCliCase(oauthApiPath, oauthPhaseOneResult.caseId, oauthPhaseOneResult.scope, roots, { sharedOAuthRoots: true });
  const oauthCliResult = JSON.parse(oauthCliOutcome.stdout);
  const oauthCliRequestUrl = oauthCliResult.exchanges?.[0]?.request?.url;
  const oauthCliStatus = oauthCliResult.exchanges?.[0]?.response?.status;
  if (oauthCliResult.run?.failed !== 0 || oauthCliResult.run?.passed !== 1
    || oauthCliStatus !== 200 || !String(oauthCliRequestUrl).endsWith("/oauth-business")) {
    throw new Error("programmatic_cli_did_not_consume_oauth_free_history_api");
  }
  if (oauthObservations.token.length !== 1 || oauthObservations.business.length !== 3
    || oauthObservations.business.some((entry) => !entry.bearerAuthenticated)) {
    throw new Error("oauth_cli_did_not_reuse_persisted_token_from_shared_owned_roots");
  }
  console.log(`[CLI:OAUTH] ${JSON.stringify({
    node: process.version,
    executable: process.execPath,
    entry: "runCli-programmatic-not-bin",
    exitCode: oauthCliOutcome.code,
    caseId: oauthPhaseOneResult.caseId,
    scope: oauthPhaseOneResult.scope,
    requestUrl: oauthCliRequestUrl,
    responseStatus: oauthCliStatus,
    tokenRequests: oauthObservations.token.length,
    businessRequests: oauthObservations.business.length,
    bearerAuthenticated: oauthObservations.business.every((entry) => entry.bearerAuthenticated),
    sharedRoots: {
      credentials: realpathSync(roots.credentials),
      network: realpathSync(roots.network),
      oauth: realpathSync(roots.oauth),
    },
  })}`);
  ok("桌面关闭后独立 Node 进程经 runCli 编程入口显式注入同一 credential/network/oauth roots 消费 OAuth Bearer API；两条标准 bin 无凭据链保留");

  const verified = assertPrivateRoots(temporaryRoot, Object.values(roots));
  console.log(`[ISOLATION] ${JSON.stringify({ root: verified.canonicalRoot, profile: realpathSync(roots.profile), workspace: realpathSync(roots.workspace), history: realpathSync(roots.history), credentials: realpathSync(roots.credentials), network: realpathSync(roots.network), oauth: realpathSync(roots.oauth), pluginHome: realpathSync(roots["user-home"]), cliAppData: realpathSync(roots["cli-appdata"]), userPlugins: 0 })}`);
  ok("profile、workspace、history、credential、plugin roots 独立且都在本次私有临时根内");
} catch (error) {
  preserveTemporaryRoot = true;
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (activeApp?.pid && activeApp.exitCode === null) await stopPackedApp(activeApp).catch((error) => fail(`process_cleanup_failed:${error instanceof Error ? error.message : String(error)}`));
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  if (oauthServer && oauthServer.listening) await new Promise((resolveClose) => oauthServer.close(resolveClose));
  if (oauthFixture && !oauthFixture.cleanupAttempted) {
    oauthFixture.cleanupAttempted = true;
    try {
      const cleanup = await cleanupOAuthFixture(oauthFixture, roots);
      console.log(`[OAUTH:CLEANUP] ${JSON.stringify(cleanup)}`);
    } catch (error) {
      preserveTemporaryRoot = true;
      const cleanupState = error instanceof Error ? error.cleanupState ?? {} : {};
      console.error(`[OAUTH:CLEANUP-FAILED] ${JSON.stringify(cleanupState)}`);
      fail(`oauth_fixture_cleanup_failed:${JSON.stringify(cleanupState)}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await sleep(500);
  if (!preserveTemporaryRoot) {
    const resolvedRoot = realpathSync(temporaryRoot);
    const stat = lstatSync(resolvedRoot);
    if (dirname(resolvedRoot) === systemTemp && stat.isDirectory() && !stat.isSymbolicLink()
      && /^apicc-f2b-host-[a-z0-9-]+$/i.test(resolvedRoot.slice(systemTemp.length + 1))) {
      rmSync(resolvedRoot, { recursive: true, force: false });
    } else {
      fail(`安全检查失败，保留临时根：${temporaryRoot}`);
    }
  } else {
    console.log(`[PRESERVED] smoke roots: ${temporaryRoot}`);
  }
}

if (failures.length) process.exit(1);
console.log("F2b packaged Electron debug-loop host smoke passed (P7 plus free history/save, OAuth CA/Bearer, restart, and shared-root CLI chains)");
