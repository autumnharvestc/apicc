#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDirectory, "../..");
const executable = join(desktopDirectory, "release", "win-unpacked", "apicc.exe");
const appDirectory = dirname(executable);
const resourcesDirectory = join(appDirectory, "resources");
const unpackedDirectory = join(resourcesDirectory, "app.asar.unpacked");
const appArchive = join(resourcesDirectory, "app.asar");
const cliEntry = join(repositoryRoot, "packages", "cli", "dist", "bin.js");
const node22 = process.execPath;
const syntheticValue = `apicc-f1-packed-smoke:${randomUUID()}`;
const reference = { id: `f1-packed-smoke-${randomUUID()}`, policy: "test-auto" };
const failures = [];
let server;
let temporaryRoot;
let activeApp;
let identity;
let credentialPutAttempted = false;
let cliCleanupSucceeded = false;
let authorizedRequests = 0;
let rejectedRequests = 0;

function fail(code) {
  failures.push(code);
}

function removeTemporaryRoot(path) {
  const resolvedPath = realpathSync(path);
  const tempRoot = realpathSync(tmpdir());
  const stat = lstatSync(resolvedPath);
  if (dirname(resolvedPath) !== tempRoot
    || !/^apicc-f1-credentials-[a-z0-9-]+$/i.test(resolvedPath.slice(tempRoot.length + 1))
    || !stat.isDirectory()
    || stat.isSymbolicLink()) {
    throw new Error("unsafe_temp_cleanup_target");
  }
  rmSync(resolvedPath, { recursive: true, force: false });
}

function findUnpackedKeyringBindings(directory, parent = "") {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = join(parent, entry.name);
    if (entry.isDirectory()) matches.push(...findUnpackedKeyringBindings(join(directory, entry.name), relative));
    else if (entry.isFile() && extname(entry.name) === ".node" && /keyring/i.test(relative)) matches.push(relative);
  }
  return matches;
}

function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") return reject(new Error("server_port_unavailable"));
      listener.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForCdp(port, child, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not_ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("packed_app_exited_before_cdp");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && String(target.url).includes("dist-renderer/index.html"));
      if (page?.webSocketDebuggerUrl) return connectCdp(page.webSocketDebuggerUrl);
    } catch (error) {
      lastError = error instanceof Error ? error.name : "cdp_request_failed";
    }
    await sleep(250);
  }
  throw new Error(`renderer_cdp_timeout:${lastError}`);
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
    try { message = JSON.parse(String(event.data)); }
    catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(new Error("cdp_command_failed"));
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
        rejectCommand(new Error("cdp_command_timeout"));
      }, 15_000);
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error("renderer_ipc_operation_failed");
    return result.result?.value;
  }

  return { command, evaluate, close: () => { if (!closed) socket.close(); } };
}

async function startPackedApp() {
  const remotePort = await allocatePort();
  const inspectorPort = await allocatePort();
  const environment = { ...process.env, APICC_SMOKE_DIR: join(temporaryRoot, "workspace") };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${join(temporaryRoot, "electron-profile")}`,
    `--inspect=127.0.0.1:${inspectorPort}`,
  ], { cwd: desktopDirectory, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-32_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-32_000); });
  const context = { child, renderer: undefined, inspector: undefined, output };
  activeApp = context;
  try {
    context.inspector = await waitForInspector(inspectorPort, child);
    context.renderer = await waitForCdp(remotePort, child);
    return context;
  } catch (error) {
    await stopPackedApp();
    throw error;
  }
}

async function waitForInspector(port, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("packed_app_exited_before_inspector");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.webSocketDebuggerUrl);
      if (target) {
        const inspector = connectCdp(target.webSocketDebuggerUrl);
        const runtime = await inspector.evaluate("({ node: process.version, electron: process.versions.electron, platform: process.platform, arch: process.arch })");
        if (!runtime?.electron || typeof runtime.node !== "string") throw new Error("packed_runtime_not_electron");
        return { inspector, runtime };
      }
    } catch (error) {
      if (error instanceof Error && error.message === "packed_runtime_not_electron") throw error;
    }
    await sleep(200);
  }
  throw new Error("packed_main_inspector_timeout");
}

function waitForChild(child, timeoutMs = 15_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(null), timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

async function stopPackedApp() {
  if (!activeApp) return null;
  const current = activeApp;
  activeApp = undefined;
  if (current.renderer) {
    try { await current.renderer.evaluate("window.close(); true"); }
    catch { /* the page may already be closing */ }
    current.renderer.close();
  }
  current.inspector?.inspector.close();
  let exitCode = await waitForChild(current.child);
  if (exitCode === null && current.child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(current.child.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
    exitCode = await waitForChild(current.child, 5_000);
  }
  if (exitCode === null) fail("packed_app_process_did_not_close");
  if (exitCode !== null && exitCode !== 0) fail("packed_app_closed_with_nonzero_exit");
  return { exitCode, outputBytes: current.output.length };
}

function expressionForSetup(root, baseUrl) {
  return `(async () => {
    const state = { stage: "start" };
    try {
      state.stage = "workspace-create";
      const opened = await window.apicc.wsCreate(${JSON.stringify(root)}, "F1 credential smoke");
      state.workspaceId = opened.workspace.id;
      const group = opened.workspace.groups[0];
      if (!group) throw new Error("missing_group");
      state.stage = "project-create";
      const project = await window.apicc.nodeCreate({ kind: "project", parent: { workspaceId: state.workspaceId, groupId: group.id }, name: "credential smoke project" });
      state.projectId = project.id;
      state.groupId = group.id;
      state.stage = "collection-create";
      const collection = await window.apicc.nodeCreate({ kind: "collection", parent: project.locator, name: "credential smoke collection" });
      state.collectionId = collection.id;
      state.stage = "api-create";
      const api = await window.apicc.nodeCreate({ kind: "api", parent: collection.locator, api: { name: "credential smoke", protocol: "http", method: "GET", baseUrl: ${JSON.stringify(baseUrl)}, path: "/credential" } });
      state.apiId = api.id;
      state.apiLocator = api.locator;
      const detail = await window.apicc.apiGet(api.locator);
      state.caseId = detail.api.cases[0].id;
      const environment = await window.apicc.envCreate({ locator: project.locator, name: "credential-smoke" });
      state.environmentId = environment.id;
      state.stage = "complete";
    } catch (error) {
      state.failureStage = state.stage;
    }
    return state;
  })()`;
}

function expressionForCredentialRequest(apiLocator, caseId, environmentName) {
  return `(async () => {
    const state = { stage: "credential-put", put: false };
    try {
      const ref = ${JSON.stringify(reference)};
      const locator = { workspaceId: ${JSON.stringify(identity.workspaceId)}, groupId: ${JSON.stringify(identity.groupId)}, projectId: ${JSON.stringify(identity.projectId)} };
      const put = await window.apicc.credentialPut({ locator, ref, value: ${JSON.stringify(syntheticValue)} });
      state.put = put.ok === true;
      state.stage = "credential-status";
      const status = await window.apicc.credentialStatus({ locator, ref });
      state.status = status.ok ? status.status : status.error.code;
      state.stage = "request-execution";
      const execution = await window.apicc.debugSend({ locator: ${JSON.stringify(apiLocator)}, caseId: ${JSON.stringify(caseId)}, envName: ${JSON.stringify(environmentName)} });
      state.executionPassed = execution.outcome.passed;
      state.responseStatus = execution.response?.status ?? null;
      state.stage = "complete";
    } catch (error) {
      state.failureStage = state.stage;
    }
    return state;
  })()`;
}

function expressionForReopen(root, expectedWorkspaceId, groupId, projectId, apiLocator, caseId, environmentName) {
  return `(async () => {
    const state = { stage: "workspace-open" };
    try {
      const opened = await window.apicc.wsOpen(${JSON.stringify(root)});
      state.workspaceOpened = opened.workspace.id === ${JSON.stringify(expectedWorkspaceId)};
      state.stage = "credential-status";
      const ref = ${JSON.stringify(reference)};
      const projectLocator = { workspaceId: ${JSON.stringify(expectedWorkspaceId)}, groupId: ${JSON.stringify(groupId)}, projectId: ${JSON.stringify(projectId)} };
      const status = await window.apicc.credentialStatus({ locator: projectLocator, ref });
      state.status = status.ok ? status.status : status.error.code;
      state.stage = "request-execution";
      const execution = await window.apicc.debugSend({ locator: ${JSON.stringify(apiLocator)}, caseId: ${JSON.stringify(caseId)}, envName: ${JSON.stringify(environmentName)} });
      state.executionPassed = execution.outcome.passed;
      state.responseStatus = execution.response?.status ?? null;
      state.stage = "complete";
    } catch (error) {
      state.failureStage = state.stage;
    }
    return state;
  })()`;
}

function runCli(args, cwd, timeout = 60_000) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun({ ...result, stdout, stderr });
    };
    const append = (current, chunk) => `${current}${chunk.toString("utf8")}`.slice(-2 * 1024 * 1024);
    let child;
    try {
      child = spawn(node22, [cliEntry, ...args], {
        cwd,
        env: environment,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ status: null, error });
      return;
    }
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish({ status: null, error }));
    child.once("close", (status, signal) => finish({
      status: timedOut ? null : status,
      signal,
      ...(timedOut ? { error: Object.assign(new Error("CLI process timed out"), { code: "ETIMEDOUT" }) } : {}),
    }));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
  });
}

function summarizeCliRun(runsDirectory) {
  if (!existsSync(runsDirectory)) return { reportFiles: 0, total: 0, passed: 0, failed: 0, failureCategories: [] };
  const files = readdirSync(runsDirectory).filter((name) => /^run-.*\.json$/i.test(name));
  const reports = files.map((name) => JSON.parse(readFileSync(join(runsDirectory, name), "utf8")));
  const failures = reports.flatMap((report) => (report.cases ?? [])
    .filter((result) => result.passed !== true)
    .map((result) => {
      const error = typeof result.error === "string" ? result.error.toLowerCase() : "";
      const failureCategory = /econnrefused|econnreset|socket|fetch failed|connection/.test(error)
        ? "connection"
        : /timeout|timed out|etimedout/.test(error)
          ? "timeout"
          : "other";
      return { failureKind: typeof result.failureKind === "string" ? result.failureKind : "unknown", failureCategory };
    }));
  return {
    reportFiles: reports.length,
    total: reports.reduce((sum, report) => sum + (Number.isInteger(report.total) ? report.total : 0), 0),
    passed: reports.reduce((sum, report) => sum + (Number.isInteger(report.passed) ? report.passed : 0), 0),
    failed: reports.reduce((sum, report) => sum + (Number.isInteger(report.failed) ? report.failed : 0), 0),
    failureCategories: failures,
  };
}

function sanitizedOutput(result) {
  return `${typeof result.stdout === "string" ? result.stdout : ""}${typeof result.stderr === "string" ? result.stderr : ""}`
    .replaceAll(syntheticValue, "[credential-redacted]");
}

function credentialLeakedInOutput(result) {
  return `${typeof result.stdout === "string" ? result.stdout : ""}${typeof result.stderr === "string" ? result.stderr : ""}`
    .includes(syntheticValue);
}

function runLeakDetectorProbe() {
  const checks = [
    { name: "detects-raw-leak", result: { stdout: syntheticValue, stderr: "" }, expected: true },
    { name: "accepts-clean-output", result: { stdout: "safe output", stderr: "" }, expected: false },
  ].map(({ name, result, expected }) => ({ name, passed: credentialLeakedInOutput(result) === expected }));
  process.stdout.write(`${JSON.stringify({ passed: checks.every((check) => check.passed), checks })}\n`);
  if (checks.some((check) => !check.passed)) process.exitCode = 1;
}

async function closeServer() {
  if (!server?.listening) return;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
}

async function main() {
  if (process.platform !== "win32") throw new Error("packed_credential_smoke_requires_windows");
  if (!existsSync(executable) || !existsSync(appArchive) || !existsSync(cliEntry)) throw new Error("packed_app_or_cli_output_missing");
  const unpackedKeyringFiles = findUnpackedKeyringBindings(unpackedDirectory);
  if (unpackedKeyringFiles.length === 0) throw new Error("keyring_native_binding_not_unpacked");
  temporaryRoot = mkdtempSync(join(tmpdir(), "apicc-f1-credentials-"));
  const workspaceRoot = join(temporaryRoot, "workspace");
  const report = {
    cwd: process.cwd(),
    argv: [executable, "<packed-app-path>", "--remote-debugging-port=<ephemeral>", "--user-data-dir=<temporary-profile>", "--inspect=127.0.0.1:<ephemeral>"],
    controllerRuntime: { execPath: process.execPath, node: process.version, platform: process.platform, arch: process.arch },
    packedNativeBindingsUnpacked: unpackedKeyringFiles.length,
    packedNativeBindingPaths: unpackedKeyringFiles,
    steps: [],
  };

  server = createServer((request, response) => {
    if (request.headers.authorization === `Bearer ${syntheticValue}`) authorizedRequests += 1;
    else rejectedRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    activeApp = await startPackedApp();
    report.electronRuntime = activeApp.inspector.runtime;
    const first = await activeApp.renderer.evaluate(expressionForSetup(workspaceRoot, baseUrl));
    report.steps.push({ step: "packed-electron-ipc-project-setup", result: first });
    identity = first;
    if (first?.failureStage || !first?.workspaceId || !first?.groupId || !first?.projectId || !first?.apiLocator || !first?.caseId) {
      fail(`packed_ipc_initial_setup:${first?.failureStage ?? "assertion_failed"}`);
    } else {
      const saved = await activeApp.renderer.evaluate(`(async()=>{ const detail=await window.apicc.apiGet(${JSON.stringify(first.apiLocator)}); detail.api.contract.request.auth={kind:"bearer",token:${JSON.stringify(reference)}}; await window.apicc.apiSave(${JSON.stringify(first.apiLocator)},detail.api); return true; })()`);
      if (!saved) fail("packed_ipc_auth_contract_save_failed");
      credentialPutAttempted = true;
      const initialRequest = await activeApp.renderer.evaluate(expressionForCredentialRequest(first.apiLocator, first.caseId, "credential-smoke"));
      report.steps.push({ step: "packed-electron-ipc-put-and-request", result: initialRequest });
      if (initialRequest?.failureStage || !initialRequest?.put || initialRequest.status !== "available" || !initialRequest.executionPassed || initialRequest.responseStatus !== 200) {
        fail(`packed_ipc_initial_run:${initialRequest?.failureStage ?? "assertion_failed"}`);
      }
    }
    const firstAppExit = await stopPackedApp();
    report.steps.push({ step: "packed-electron-close-after-initial-run", result: firstAppExit });

    if (identity?.workspaceId && identity?.apiLocator && identity?.groupId && identity?.projectId) {
      activeApp = await startPackedApp();
      report.electronRuntimeAfterRestart = activeApp.inspector.runtime;
      const second = await activeApp.renderer.evaluate(expressionForReopen(
        workspaceRoot,
        identity.workspaceId,
        identity.groupId,
        identity.projectId,
        identity.apiLocator,
        identity.caseId,
        "credential-smoke",
      ));
      report.steps.push({ step: "packed-electron-reopen-and-request", result: second });
      if (second?.failureStage || !second?.workspaceOpened || second.status !== "available" || !second.executionPassed || second.responseStatus !== 200) {
        fail(`packed_ipc_reopen_run:${second?.failureStage ?? "assertion_failed"}`);
      }
      const secondAppExit = await stopPackedApp();
      report.steps.push({ step: "packed-electron-close-after-reopen", result: secondAppExit });
    } else {
      fail("packed_ipc_workspace_identity_unavailable");
    }

    if (identity?.workspaceId && identity?.groupId && identity?.projectId && identity?.collectionId) {
      const projectPath = `groups/${identity.groupId}/projects/${identity.projectId}`;
      const collectionPath = `${projectPath}/collections/${identity.collectionId}`;
      const cliRunsDirectory = join(temporaryRoot, "cli-runs");
      const cliRun = await runCli(["run", collectionPath, "--env", "credential-smoke", "--runs-dir", cliRunsDirectory], workspaceRoot);
      const cliOutput = sanitizedOutput(cliRun);
      const credentialLeaked = credentialLeakedInOutput(cliRun);
      report.steps.push({
        step: "independent-cli-execution-after-desktop-close",
        exitCode: cliRun.status,
        errorCode: cliRun.error?.code ?? null,
        output: cliOutput.slice(-4_000),
        runSummary: summarizeCliRun(cliRunsDirectory),
        credentialValueNotPrinted: !credentialLeaked,
      });
      if (cliRun.status !== 0 || credentialLeaked) fail("independent_cli_execution_failed_or_leaked");

      const privateRootModule = await import(pathToFileURL(join(repositoryRoot, "packages/core/dist/index.js")).href);
      const privateRoot = privateRootModule.defaultCredentialPrivateRoot();
      const acl = spawnSync("icacls.exe", [privateRoot], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      const aclText = `${acl.stdout ?? ""}${acl.stderr ?? ""}`;
      const broadReadAccess = /(?:Everyone|Authenticated Users|BUILTIN\\Users):[^\r\n]*(?:\(F\)|\(M\)|\(RX\)|\(R\))/i.test(aclText);
      report.privateRoot = privateRoot;
      report.privateRootAcl = { exitCode: acl.status, broadReadAccess, inspected: acl.status === 0 };
      if (acl.status !== 0) fail("private_root_acl_inspection_failed");
      if (broadReadAccess) fail("private_root_acl_grants_broad_read_access");

      const remove = await runCli(["credentials", "remove", projectPath, reference.id], workspaceRoot);
      cliCleanupSucceeded = remove.status === 0;
      const status = await runCli(["credentials", "status", projectPath, reference.id], workspaceRoot);
      report.steps.push({
        step: "synthetic-credential-cleanup-and-missing-status",
        removeExitCode: remove.status,
        missingStatusExitCode: status.status,
        missingStatusObserved: sanitizedOutput(status).includes("凭据状态：missing"),
      });
      if (!cliCleanupSucceeded || status.status !== 0 || !sanitizedOutput(status).includes("凭据状态：missing")) fail("synthetic_credential_cleanup_failed");
    } else {
      fail("cli_project_identity_unavailable");
    }

    if (authorizedRequests < 3 || rejectedRequests > 0) fail("credentialed_request_observation_mismatch");
    report.authorizedRequestsObserved = authorizedRequests;
    report.rejectedRequestsObserved = rejectedRequests;
  } finally {
    if (activeApp) {
      const exit = await stopPackedApp();
      report.steps.push({ step: "packed-electron-final-close", result: exit });
    }
    if (credentialPutAttempted && identity?.workspaceId && identity?.groupId && identity?.projectId && !cliCleanupSucceeded) {
      const projectPath = `groups/${identity.groupId}/projects/${identity.projectId}`;
      const cleanup = await runCli(["credentials", "remove", projectPath, reference.id], workspaceRoot);
      cliCleanupSucceeded = cleanup.status === 0;
      if (!cliCleanupSucceeded) fail("synthetic_credential_cleanup_failed");
    }
    await closeServer();
    if (temporaryRoot) removeTemporaryRoot(temporaryRoot);
  }

  report.failures = failures;
  report.crossHostCredentialRoundTrip = failures.length === 0;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[2] === "--probe-leak-detector") runLeakDetectorProbe();
else {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "smoke_failed", runtime: { node: process.version, platform: process.platform, arch: process.arch } })}\n`);
    process.exitCode = 1;
  });
}
