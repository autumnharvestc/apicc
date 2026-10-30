import { beforeAll, afterAll, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { encodeContractProjectFiles, type ContractProject } from "@apicc/core";
import { acceptanceStress } from "./helpers/acceptanceStress.js";
import { prepareProjectFiles, type InvocationOutput } from "@apicc/execution/host";
import { readBuildIdentity } from "@apicc/execution/buildIdentity";
import { defaultAgentConfig, runtimeCompatibilityIdForRuntime, type ProjectAssets, type TaskTarget } from "@apicc/execution/contract";
import { semanticProject, semanticTarget, semanticSummary, semanticIds } from "./runtime-semantics.mjs";
import { serverFixture, command, until, repo } from "./server-fixture.js";

let server: Awaited<ReturnType<typeof serverFixture>>;
let target: ReturnType<typeof createServer>;
const seen: Array<{ path: string; data?: string; environment?: string; cookie?: string; authorization?: string }> = [];
const gates = new Map<string, ServerResponse>();
let origin = "", token = "", ownerId = "", ws = "", group = "", projectId = "", agentId = "", assets: ProjectAssets;
const name = `apicc-f7b-t11-agent-${process.pid}`, volume = `apicc-f7b-t11-data-${process.pid}`;
let containerCreated = false, volumeCreated = false;
let uiReady = false;
const image = process.env.APICC_RUNNER_E2E_IMAGE ?? "apicc-f7b-t11-agent:candidate";
const ledgerProbeSource = readFileSync(new URL("./helpers/ledgerProbe.mjs", import.meta.url), "utf8");
async function api(method: string, path: string, body?: unknown, auth = token): Promise<any> {
  const response = await server.trustedFetch(`${server.baseUrl}/api/v1/${path}`, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await response.text(); if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`); return text ? JSON.parse(text) : null;
}
const projectPath = () => `workspaces/${ws}/projects/${projectId}`;
async function publish(project: ContractProject) {
  const files = [...encodeContractProjectFiles(project).files];
  const old = assets?.files.map(file => file.path) ?? [];
  assets = await api("PUT", `${projectPath()}/assets`, { format: "contract-files-v1", contractProjectId: project.id, expectedVersion: assets?.version ?? "0", changes: files.map(([path, content]) => ({ path, content })), deletes: old.filter(path => !files.some(([next]) => next === path)) });
}
async function approve(target: TaskTarget) {
  const prepared = await prepareProjectFiles(assets, { target, environmentId: semanticIds.environment!, profile: "trusted-core-script" });
  const current = await api("GET", `${projectPath()}/script-grants?agentId=${agentId}`);
  await api("PUT", `${projectPath()}/script-grants`, { agentId, expectedVersion: current.version, scope: "script-version", scripts: prepared.scriptRequirements.map(({ scriptId, contentHash }) => ({ scriptId, contentHash })), riskConfirmed: true });
}
async function electron(operations: unknown[], cleanup: unknown[] = []) {
  const id = randomUUID(); const input = join(server.root, `electron-${id}.input.json`), output = join(server.root, `electron-${id}.output.json`);
  writeFileSync(input, JSON.stringify({ baseUrl: server.baseUrl, username: "t11-owner", password: "t11-password8", privateRoot: server.root, scope: { workspaceId: ws, groupId: group, projectId }, operations, cleanup }));
  // Windows acceptance uses the actual Electron main. Headless Linux CI uses the same desktop host under Node.
  const executable = process.platform === "win32" ? join(repo, "apps/desktop/node_modules/electron/dist/electron.exe") : process.execPath;
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_EXTRA_CA_CERTS: join(server.root, "control-ca.pem") }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [join(repo, "apps/desktop/tests/main/online/electron-execution-probe.mjs"), input, output, `--user-data-dir=${join(server.root, "electron-profile")}`], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; for (const stream of [child.stdout, child.stderr]) stream?.on("data", bytes => { logs += bytes; appendFileSync(join(server.root, "electron.log"), bytes); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  expect(code, logs).toBe(0); return JSON.parse(readFileSync(output, "utf8"));
}
/** Network probes must leave this process's actual HTTPS proxy and HTTP target event loop live. */
async function networkProbe(label: string, executable: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const startedAt = new Date().toISOString();
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", code: number | null = null, signal: NodeJS.Signals | null = null;
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  try { code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", (value, exitSignal) => { signal = exitSignal; resolve(value); }); }); }
  finally {
    writeFileSync(join(server.root, `${label}.stdout.log`), stdout);
    writeFileSync(join(server.root, `${label}.stderr.log`), stderr);
    writeFileSync(join(server.root, `${label}.process.json`), JSON.stringify({ cwd: process.cwd(), executable, args, pid: child.pid, startedAt, endedAt: new Date().toISOString(), code, signal }, null, 2));
  }
  expect(code, `${stdout}\n${stderr}`).toBe(0); return stdout.trim();
}
function run(target: TaskTarget, kind: "local" | "agent", extra: Record<string, unknown> = {}) {
  return { operation: "run", runId: randomUUID(), location: kind === "local" ? { kind } : { kind, agentId }, target, expectedVersion: assets.version, environmentId: semanticIds.environment, runConfig: { jobTimeoutMs: 30000 }, materials: { projectId, credentials: [{ refId: "synthetic-credential", version: "1" }], attachments: [] }, localOnlyRefIds: [], ...extra };
}
async function report(job: { jobId: string }) {
  await until(() => api("GET", `jobs/${job.jobId}`), status => status.state === "ended" && status.executionReleased && status.reportState === "archived");
  return api("GET", `jobs/${job.jobId}/report`);
}
async function ledgerIntent(executionId: string): Promise<any> {
  return JSON.parse(command("docker", ["exec", name, "node", "--input-type=module", "-e", `${ledgerProbeSource}\nconsole.log(JSON.stringify(await readLedgerIntent('/data/execution-ledger.sqlite',${JSON.stringify(executionId)})));`]));
}
async function configureStress(config: Record<string, unknown>) {
  const current = await api("GET", `agents/${agentId}`);
  await api("PATCH", `agents/${agentId}`, { expectedVersion: current.configVersion, config });
  return until(() => api("GET", `agents/${agentId}`), value => value.status === "applied" && value.runtime.configuration.appliedConfigVersion === value.configVersion);
}
beforeAll(async () => {
  server = await serverFixture({ artifactJar: process.env.APICC_RUNNER_E2E_JAR });
  console.log(`T11 private resources ${JSON.stringify({ root: server.root, baseUrl: server.baseUrl, name, volume, image })}`);
  target = createServer((request, response) => {
    let body = ""; request.on("data", bytes => { body += bytes; }); request.on("end", () => {
      seen.push({ path: request.url!, data: request.headers["x-data"] as string, environment: request.headers["x-environment"] as string, cookie: request.headers.cookie, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json"); response.setHeader("set-cookie", "t11=synthetic-cookie; Path=/");
      if (request.url!.startsWith("/hold")) gates.set(request.url!, response); else {
        if (request.url === "/stress-recovered") response.statusCode = 500;
        response.end('{"token":"fixed-token"}');
      }
    });
  });
  await new Promise<void>(resolve => target.listen(0, "0.0.0.0", resolve)); origin = `http://${server.authorityHost}:${(target.address() as { port: number }).port}`;
  const login = await api("POST", "auth/login", { username: "t11-owner", password: "t11-password8" }, ""); token = login.token; ownerId = login.user.id;
  ws = (await api("GET", "connect")).workspaceId;
  group = (await api("GET", `workspaces/${ws}/groups`))[0].id;
  projectId = (await api("POST", `workspaces/${ws}/projects`, { groupId: group, name: "T11 synthetic shared project" })).id;
  agentId = (await api("POST", "agents", { name: "T11 isolated Linux" })).id;
  await api("PUT", `agents/${agentId}/workspace-grants`, { workspaceIds: [ws] });
  await api("PUT", `workspaces/${ws}/agent-project-allocations`, { agentId, projectIds: [projectId] });
  await api("PUT", `${projectPath()}/execution-settings`, { expectedVersion: "0", agentIds: [agentId], defaultAgentId: agentId, policy: { cancelGraceMs: 200 } });
  await api("PATCH", `agents/${agentId}`, { expectedVersion: "0", config: { maxConcurrentJobs: 2, scriptMode: "trusted-core", minFreeDiskBytes: 1, sharedDebugIdleMs: 250, heartbeatIntervalMs: 100, longPollWaitMs: 200, pollTimeoutMarginMs: 100, controlRequestTimeoutMs: 1000, reconnectMinMs: 50, reconnectMaxMs: 100, reconnectJitterRatio: 0, transferRetryMinMs: 50, transferRetryMaxMs: 100, transferRetryCycleMs: 200 } });
  const enrollment = await api("POST", `agents/${agentId}/enrollments`);
  const enrolled = await api("POST", "runner/enroll", { enrollmentToken: enrollment.enrollmentToken }, "");
  writeFileSync(join(server.root, "agent-token"), enrolled.agentToken);
  writeFileSync(join(server.root, "deployment.json"), JSON.stringify({ baseUrl: `${server.baseUrl}/api/v1`, agentId, tokenFile: "/run/apicc/agent-token", dataDirectory: "/data", trustedCaFile: "/run/apicc/control-ca.pem", bootstrapConfig: { ...defaultAgentConfig, minFreeDiskBytes: 1 } }));
  command("docker", ["volume", "create", volume]); volumeCreated = true;
  command("docker", ["run", "--detach", "--init", "--name", name, "--mount", `type=volume,source=${volume},target=/data`, ...["deployment.json", "agent-token", "control-ca.pem"].flatMap(file => ["--mount", `type=bind,source=${join(server.root, file)},target=/run/apicc/${file},readonly`]), image]); containerCreated = true;
  const registered = await until(() => api("GET", `agents/${agentId}`), value => value.runtime && value.status === "applied" && value.runtime.configuration.appliedConfigVersion === value.configVersion);
  const identity = await readBuildIdentity(); expect(registered.runtime.coreBuildId).toBe(identity.coreBuildId);
  expect(registered.runtime.runtimeCompatibilityId).toBe(runtimeCompatibilityIdForRuntime("22.19.0", "12.4.254.21-node.29", identity.scriptApiId));
  const wrongCa = await networkProbe("wrong-ca-bootstrap", "docker", ["exec", name, "node", "--input-type=module", "-e", `import assert from 'node:assert/strict';import {bootstrapAgent} from './apps/runner-agent/dist/bootstrap.js';const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),3000);let rejected;try{await bootstrapAgent({baseUrl:${JSON.stringify(`${server.baseUrl}/api/v1`)},agentId:${JSON.stringify(agentId)},tokenFile:'/run/apicc/agent-token',trustedCaFile:'/app/packages/core/tests/http/fixtures/network/synthetic-target-ca.pem',dataDirectory:'/tmp/t8-wrong-ca'},controller.signal);}catch(error){rejected=error;}finally{clearTimeout(timer);}const codes=[];for(let error=rejected;error;error=error.cause)if(error.code)codes.push(error.code);assert.ok(codes.some(code=>['UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code)),String(rejected));console.log(JSON.stringify({wrongCaRejected:true,codes,runtime:process.versions}));`]);
  writeFileSync(join(server.root, "linux-wrong-ca.json"), wrongCa + "\n");
  await api("PUT", `${projectPath()}/credentials/synthetic-credential`, { expectedVersion: "0", value: "t11-synthetic-secret" });
  writeFileSync(join(server.root, "context.json"), JSON.stringify({ baseUrl: server.baseUrl, origin, ws, group, projectId, agentId, ownerId, image, name, volume, identity, javaPid: server.serverPid(), javaVersion: server.javaVersion }, null, 2));
}, 600000);

afterAll(async () => {
  const errors: unknown[] = [];
  const attempt = async (action: () => unknown) => { try { await action(); } catch (error) { errors.push(error); } };
  await attempt(async () => { if (server && uiReady && process.env.APICC_RUNNER_E2E_HOLD_FOR_UI === "1") {
    const context = JSON.parse(readFileSync(join(server.root, "context.json"), "utf8"));
    writeFileSync(join(server.root, "ui-context.json"), JSON.stringify({ ...context, expectedVersion: assets.version, username: "t11-owner", password: "t11-password8", releaseFile: join(server.root, "ui-release"), profile: join(server.root, "native-profile"), isolatedRoot: join(server.root, "native-isolation"), nodeExtraCaCerts: join(server.root, "control-ca.pem"), executable: process.env.APICC_RUNNER_E2E_PACKAGED_EXE }, null, 2));
    console.log(`T8_UI_READY ${join(server.root, "ui-context.json")}`);
    const deadline = Date.now() + 1800000;
    while (!existsSync(join(server.root, "ui-release")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
    if (!existsSync(join(server.root, "ui-release"))) appendFileSync(join(server.root, "lifecycle.log"), "UI hold deadline elapsed; continue owned cleanup\n");
  } });
  for (const response of gates.values()) await attempt(() => response.end('{"token":"fixed-token"}'));
  gates.clear();
  let stopped = false, copied = false, removed = false;
  if (containerCreated) {
    await attempt(() => {
      const closure = command("docker", ["exec", name, "node", "--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); try { console.log(JSON.stringify({runtime:process.versions,pid:process.pid,uid:process.getuid(),sqlite:db.prepare('select sqlite_version() version').get()})); } finally { db.close(); }"]);
      writeFileSync(join(server.root, "linux-closure.json"), closure);
    });
    await attempt(() => command("docker", ["stop", "--time", "30", name]));
    await attempt(() => {
      const state = JSON.parse(command("docker", ["inspect", "--format", "{{json .State}}", name]));
      if (state.Running !== false) throw new Error(`Owned agent stop unconfirmed; preserve ${name}/${volume}`);
      stopped = true;
      appendFileSync(join(server.root, "lifecycle.log"), `Agent stopped ${JSON.stringify(state)}\n`);
    });
    await attempt(() => {
      const logs = spawnSync("docker", ["logs", name], { encoding: "utf8", windowsHide: true });
      appendFileSync(join(server.root, "agent.log"), `${logs.stdout}\n${logs.stderr}`);
      if (logs.error || logs.status !== 0) throw logs.error ?? new Error(`Owned agent logs failed: ${logs.stderr}`);
    });
    if (stopped) await attempt(() => { command("docker", ["cp", `${name}:/data/execution-ledger.sqlite`, join(server.root, "execution-ledger.sqlite")]); copied = true; });
    if (stopped && copied) await attempt(() => {
      // A full integrity scan must not hold a read lock against the live agent's zero-wait writer.
      const database = new DatabaseSync(join(server.root, "execution-ledger.sqlite"), { readOnly: true });
      try {
        const integrity = database.prepare("PRAGMA integrity_check").get();
        writeFileSync(join(server.root, "ledger-integrity.json"), JSON.stringify(integrity));
        expect(integrity).toEqual({ integrity_check: "ok" });
      } finally { database.close(); }
    });
    if (stopped && copied) await attempt(() => { command("docker", ["rm", name]); removed = true; });
  }
  if (volumeCreated && process.env.APICC_RUNNER_E2E_PRESERVE_VOLUME !== "1") {
    if (stopped && copied && removed) await attempt(() => command("docker", ["volume", "rm", volume]));
    else errors.push(new Error(`Preserved owned volume ${volume}: stop/copy/removal not all confirmed`));
  }
  await attempt(async () => { if (target) { target.closeAllConnections(); await new Promise<void>(resolve => target.close(error => { if (error) errors.push(error); resolve(); })); } });
  await attempt(() => server?.close());
  if (errors.length) {
    if (server) await attempt(() => appendFileSync(join(server.root, "cleanup-errors.log"), errors.map(String).join("\n") + "\n"));
    throw new AggregateError(errors, `Owned E2E cleanup failed: ${errors.map(String).join("; ")}`);
  }
}, process.env.APICC_RUNNER_E2E_HOLD_FOR_UI === "1" ? 1860000 : 60000);

it("uses the same project and actual desktop host versus independent Linux main over verified HTTPS", async () => {
  for (const [label, kind, scripts, failing] of [["plain", "debug", false, false], ["trusted", "debug", true, false], ["suite", "suite", true, false], ["workflow-v2", "workflow", true, false], ["failure", "debug", true, true]] as const) {
    await publish(semanticProject(origin, scripts, failing)); const selected = semanticTarget(kind);
    if (scripts) await approve(selected);
    const start = seen.length;
    const local = await electron([run(selected, "local")]);
    const submitted = await electron([run(selected, "agent")]);
    const remote = await report(submitted.results[0]);
    if (process.platform === "win32") { expect(local.runtime.electron).toBe("44.1.0"); expect(local.runtime.node).toBe("24.19.0"); }
    else expect(local.runtime.node).toBe("22.19.0");
    expect(semanticSummary(remote.output as InvocationOutput)).toEqual(semanticSummary(local.results[0].output));
    expect(remote.verdict).toBe(failing ? "failed" : "passed");
    const actual = seen.slice(start); expect(actual).toHaveLength(kind === "workflow" ? 4 : 2);
    expect(actual.every(row => row.authorization === "Bearer t11-synthetic-secret")).toBe(true);
    expect(actual.every(row => row.environment === "environment-one" && row.data === (kind === "suite" ? "dataset-one" : "row-one"))).toBe(true);
    expect(JSON.stringify({ local, remote })).not.toContain("t11-synthetic-secret");
    appendFileSync(join(server.root, "semantic-results.jsonl"), JSON.stringify({ label, local: local.results[0], remote, requests: actual.map(({ authorization: _auth, ...request }) => request) }) + "\n");
  }
}, 120000);

it("mixes total slots, cancellation, session scope, one worker exit, real lost ACKs and restart defaults", async () => {
  const configure = async (config: Record<string, unknown>) => {
    const current = await api("GET", `agents/${agentId}`);
    await api("PATCH", `agents/${agentId}`, { expectedVersion: current.configVersion, config });
    return until(() => api("GET", `agents/${agentId}`), value => value.status === "applied" && value.runtime.configuration.appliedConfigVersion === value.configVersion);
  };
  await configure({ maxConcurrentJobs: 2, sharedDebugIdleMs: 10000 });
  const publishPath = async (path: string) => { const project = semanticProject(origin, false); project.variables.path = path; await publish(project); };
  const submit = async (path: string, kind = "debug", extra: Record<string, unknown> = {}) => { await publishPath(path); return (await electron([run(semanticTarget(kind), "agent", extra)])).results[0]; };
  const warm = await report(await submit("warm-worker")); expect(warm.pid).toBeGreaterThan(0);
  const start = seen.length;
  const a = await submit("hold-shared-a"), b = await submit("hold-dedicated-b", "suite"), stale = await submit("hold-shared-c");
  await until(async () => seen.slice(start).map(row => row.path), paths => paths.includes("/hold-shared-a") && paths.includes("/hold-dedicated-b"));
  expect(seen.slice(start).map(row => row.path)).not.toContain("/hold-shared-c");
  await configure({ maxConcurrentJobs: 1 });
  await api("POST", `jobs/${a.jobId}/cancel`, {}); expect((await report(a)).verdict).toBe("cancelled");
  expect((await api("GET", `jobs/${b.jobId}`)).state).toBe("running"); expect(seen.slice(start).map(row => row.path)).not.toContain("/hold-shared-c");
  await configure({ maxConcurrentJobs: 2 });
  // Queued snapshots retain their policy revision; configuration changes require explicit fresh preparation.
  const rejected = await until(() => api("GET", `jobs/${stale.jobId}`), value => value.state === "ended");
  expect(rejected.summary.reasonCode).toBe("policy_changed");
  const c = await submit("hold-shared-c");
  await until(async () => gates.has("/hold-shared-c"), Boolean);
  // PID was observed in a real successful shared report from this same owned container/generation.
  command("docker", ["exec", name, "node", "-e", `const fs=require('node:fs'); const pid=${Number(warm.pid)}; if(!fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes('taskChild.js'))throw Error('Unexpected owned worker');process.kill(pid,'SIGTERM');`]);
  expect((await report(c)).verdict).toBe("interrupted"); expect((await api("GET", `jobs/${b.jobId}`)).state).toBe("running");
  gates.get("/hold-dedicated-b")!.end('{"token":"fixed-token"}'); gates.delete("/hold-dedicated-b"); expect((await report(b)).verdict).toBe("passed");
  const first = await submit("session-first"); const firstReport = await report(first); expect(firstReport.pid).not.toBe(warm.pid);
  const same = await submit("session-same", "debug", { debugSessionId: first.task.debugSessionId }); await report(same);
  const other = await submit("session-other"); await report(other);
  expect(seen.find(row => row.path === "/session-same")!.cookie).toBe("t11=synthetic-cookie"); expect(seen.find(row => row.path === "/session-other")!.cookie).toBeUndefined();
  const beforeArchive = server.faults.archives; server.faults.dropMessageAck = 1; server.faults.dropArchiveAck = 1;
  const offline = await submit("hold-offline"); await until(async () => gates.has("/hold-offline"), Boolean);
  server.faults.offline = true; gates.get("/hold-offline")!.end('{"token":"fixed-token"}'); gates.delete("/hold-offline");
  const ledger = () => ledgerIntent(offline.executionId);
  await until(async () => ledger(), value => value.settled && !!value.report);
  server.faults.offline = false; expect((await report(offline)).verdict).toBe("passed");
  await until(async () => ledger(), value => value.archived && !value.report);
  expect(server.faults.dropped).toBe(2); expect(server.faults.archives - beforeArchive).toBeGreaterThanOrEqual(2);
  expect(seen.filter(row => row.path === "/hold-offline")).toHaveLength(1);
  // The archive ACK above is the durability boundary, not a graceful shutdown or a new Job.
  const originalStatus = await api("GET", `jobs/${offline.jobId}`);
  const originalReport = Buffer.from(JSON.stringify(await api("GET", `jobs/${offline.jobId}/report`)));
  const ledgerIdentity = (value: any) => ({ jobId: value.jobId, executionId: value.executionId, settled: value.settled, archived: value.archived, reportPresent: !!value.report });
  const originalLedger = ledgerIdentity(await ledger());
  const beforeJavaPid = server.serverPid();
  const reportIdentity = (bytes: Buffer) => ({ sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  expect(originalStatus).toMatchObject({ jobId: offline.jobId, executionId: offline.executionId, state: "ended", executionReleased: true, reportState: "archived" });
  const beforeRestart = await api("GET", `agents/${agentId}`);
  await server.stop(); await server.start({ APICC_EXECUTION_AGENT_CHILDMAXOLDSPACEMIB: "128" });
  const recoveredStatus = await api("GET", `jobs/${offline.jobId}`);
  const recoveredReport = Buffer.from(JSON.stringify(await api("GET", `jobs/${offline.jobId}/report`)));
  const recoveredLedger = ledgerIdentity(await ledger());
  writeFileSync(join(server.root, "acked-restart-durability.json"), JSON.stringify({ jobId: offline.jobId, executionId: offline.executionId, beforeJavaPid, afterJavaPid: server.serverPid(), before: { status: originalStatus, report: reportIdentity(originalReport), ledger: originalLedger }, after: { status: recoveredStatus, report: reportIdentity(recoveredReport), ledger: recoveredLedger }, offlineTargetHits: seen.filter(row => row.path === "/hold-offline").length }, null, 2));
  expect(server.serverPid()).not.toBe(beforeJavaPid);
  expect(recoveredStatus).toEqual(originalStatus);
  expect(reportIdentity(recoveredReport)).toEqual(reportIdentity(originalReport));
  expect(recoveredLedger).toEqual(originalLedger);
  expect(recoveredLedger).toMatchObject({ jobId: offline.jobId, executionId: offline.executionId, settled: true, archived: true, reportPresent: false });
  expect(seen.filter(row => row.path === "/hold-offline")).toHaveLength(1);
  const applied = await until(() => api("GET", `agents/${agentId}`), value => value.config.childMaxOldSpaceMiB === 128 && value.configVersion !== beforeRestart.configVersion && value.status === "applied" && value.runtime.configuration.appliedConfigVersion === value.configVersion);
  expect(applied.config.maxConcurrentJobs).toBe(2); expect(applied.sources.childMaxOldSpaceMiB).toBe("deployment");
  appendFileSync(join(server.root, "control-results.json"), JSON.stringify({ sharedWorkerPid: warm.pid, successorPid: firstReport.pid, cancelled: a.jobId, dedicated: b.jobId, interrupted: c.jobId, faults: server.faults, offlineTargetHits: seen.filter(row => row.path === "/hold-offline").length, beforeRestart: beforeRestart.configVersion, afterRestart: applied.configVersion, applied: applied.appliedConfigVersion }, null, 2));
}, 120000);

it.runIf(process.platform === "win32")("keeps an actual Windows personal credential local and rejects agent routing before requests", async () => {
  const personal = semanticProject(origin, false); personal.variables.path = "personal-local-only";
  personal.collections[0]!.apis[0]!.contract.request.auth = { kind: "bearer", token: { id: "t11-local-only", policy: "test-auto" } };
  await publish(personal); const credential = { operation: "credential", storage: "local", contractProjectId: semanticIds.project, ref: { id: "t11-local-only", policy: "test-auto" } };
  const extra = { materials: { projectId, credentials: [], attachments: [] }, localOnlyRefIds: ["t11-local-only"] };
  await electron([{ ...credential, action: "put", value: "t11-synthetic-secret" }]);
  const personalResult = await electron([run(semanticTarget("debug"), "local", extra), { expectError: "local-material-required", input: run(semanticTarget("debug"), "agent", extra) }], [{ ...credential, action: "remove" }]);
  expect(personalResult.results[0].output.result.run.passed).toBe(1);
  expect(seen.filter(row => row.path === "/personal-local-only")).toHaveLength(1);
  expect((await api("GET", `${projectPath()}/credentials`)).some((value: { refId: string }) => value.refId === "t11-local-only")).toBe(false);
}, 30000);

// Break caught: an admitted stress task loses its fixed worker/lifecycle binding at the real Java/agent/desktop boundary.
it("runs bounded case and recovered lifecycle workflow stress on the same actual desktop and Linux agent", async () => {
  for (const workflow of [false, true]) {
    const fixture = acceptanceStress(origin, workflow ? "stress-recovered" : "stress-case", workflow);
    await publish(fixture.project);
    const workerCount = workflow ? 2 : 1, start = seen.length;
    const config = { runConfig: { jobTimeoutMs: 30000, stress: { workerCount, confirmedTargetOrigins: [origin] } } };
    const local = await electron([run(fixture.target, "local", config)]);
    const submitted = (await electron([run(fixture.target, "agent", config)])).results[0];
    const remote = await report(submitted);
    expect(local.results[0].output).toMatchObject({ kind: "stress", result: { iterations: { completed: 4 }, requests: { completed: 4, failed: workflow ? 4 : 0 } } });
    expect(remote.output).toMatchObject({ kind: "stress", result: { iterations: { completed: 4 }, requests: { completed: 4, failed: workflow ? 4 : 0 } } });
    const facts = seen.slice(start);
    // Per run: 4 measurement HTTP calls; workflow additionally has setup/teardown and two VU setup/teardown calls.
    expect(facts).toHaveLength(workflow ? 20 : 8);
    if (workflow) {
      expect(remote.output.result.lifecycle).toHaveLength(6);
      expect(remote.output.result.verdict.passed).toBe(true);
      expect(remote.output.result.distributed.workers).toBe(2);
    }
    expect(JSON.stringify({ local, remote })).not.toContain("t11-synthetic-secret");
    appendFileSync(join(server.root, "stress-semantic-results.jsonl"), JSON.stringify({ workflow, workerCount, local, submitted, remote, targetRequests: facts.map(({ authorization: _auth, ...row }) => row) }) + "\n");
  }
  const linux = command("docker", ["exec", name, "node", "apps/runner-agent/tests/fixtures/linux-process-evidence.mjs"]);
  writeFileSync(join(server.root, "linux-process-evidence.json"), linux + "\n");
}, 120000);

// Break caught: authority releases a stress reservation before Linux descendants exit, or an ACK retry reexecutes HTTP.
it("keeps Linux stress reservations through controlled derating, cancellation, worker exit and lost report ACK", async () => {
  const treeRecorded = (value: any) => value?.processes?.length === 3
    && value.processes.map((row: any) => row.role).sort().join(",") === "coordinator,worker,worker"
    && value.processes.every((row: any) => Number.isSafeInteger(row.pid) && row.pid > 0 && !row.exited
      && (row.role === "coordinator" || typeof row.birth === "string" && /^[1-9]\d*$/.test(row.birth)));
  const captureOwnedTree = (intent: any) => {
    const actual = JSON.parse(command("docker", ["exec", name, "node", "--input-type=module", "-e", `import assert from 'node:assert/strict';import {readProcessIdentity,matchesStressWorkerProcess} from './apps/runner-agent/dist/processIdentity.js';const intent=${JSON.stringify(intent)};const scope=${JSON.stringify({ workspaceId: ws, groupId: group, projectId })};const rows=intent.processes;assert.equal(rows.length,3);assert.equal(new Set(rows.map(row=>row.pid)).size,3);assert.equal(new Set(rows.map(row=>row.id)).size,3);assert.deepEqual(rows.map(row=>row.role).sort(),['coordinator','worker','worker']);const coordinator=rows.find(row=>row.role==='coordinator');const result=[];for(const row of rows){const fixed=intent.processIntents.find(value=>value.id===row.id);assert.ok(fixed);assert.deepEqual(row.scope,scope);assert.deepEqual(fixed.scope,scope);assert.equal(row.role,fixed.role);assert.equal(row.epoch,fixed.epoch);assert.equal(row.exited,false);const identity=await readProcessIdentity(row.pid);assert.ok(identity);assert.equal(identity.pid,row.pid);assert.equal(identity.executable,process.execPath);assert.ok(matchesStressWorkerProcess(identity.commandLine,fixed));if(row.role==='worker'){assert.equal(identity.birth,row.birth);assert.equal(identity.parentPid,coordinator.pid);}result.push({id:row.id,role:row.role,scope:row.scope,recordedBirth:row.birth,identity});}console.log(JSON.stringify(result));`]));
    writeFileSync(join(server.root, `stress-owned-processes-${intent.executionId}.json`), JSON.stringify(actual, null, 2));
    return actual;
  };
  const fixture = acceptanceStress(origin, "hold-stress-capacity", true);
  await publish(fixture.project);
  const config = { runConfig: { jobTimeoutMs: 30000, stress: { workerCount: 2, confirmedTargetOrigins: [origin] } } };
  const start = seen.length;
  const first = (await electron([run(fixture.target, "agent", config)])).results[0];
  const active = await until(async () => ledgerIntent(first.executionId), treeRecorded);
  const activeIdentities = captureOwnedTree(active);
  await until(async () => seen.slice(start).filter(row => row.path === "/hold-stress-capacity").length, count => count === 2);
  const second = (await electron([run(fixture.target, "agent", config)])).results[0];
  const waiting = await until(() => api("GET", `jobs/${second.jobId}`), value => value.state === "queued" && !!value.capacityWaitReason);
  expect((await ledgerIntent(second.executionId))?.processes ?? []).toEqual([]);
  const neighborTarget = semanticTarget("debug") as Extract<TaskTarget, { kind: "debug" }>;
  if (neighborTarget.invocation.mode !== "case") throw new Error("Case fixture required");
  neighborTarget.invocation.locator.apiId = "10000000-0000-4000-8000-000000000099";
  neighborTarget.invocation.case.apiId = "10000000-0000-4000-8000-000000000099";
  const neighbor = (await electron([run(neighborTarget, "agent")])).results[0];
  await until(async () => gates.has("/hold-packaged-disconnect"), Boolean);
  await configureStress({ maxConcurrentStressJobs: 0 });
  expect((await api("GET", `jobs/${first.jobId}`)).state).toBe("running");
  expect((await ledgerIntent(second.executionId))?.processes ?? []).toEqual([]);
  await api("POST", `jobs/${second.jobId}/cancel`, {});
  await api("POST", `jobs/${first.jobId}/cancel`, {});
  await report(first);
  const released = await ledgerIntent(first.executionId);
  expect(released.processes).toHaveLength(3); expect(released.processes.every((row: any) => row.exited)).toBe(true);
  const physical = JSON.parse(command("docker", ["exec", name, "node", "--input-type=module", "-e", `import {readProcessIdentity} from './apps/runner-agent/dist/processIdentity.js';console.log(JSON.stringify(await Promise.all(${JSON.stringify(active.processes.map((row: any) => row.pid))}.map(async pid=>({pid,identity:await readProcessIdentity(pid)??null})))));`]));
  expect(physical.every((row: any) => row.identity === null)).toBe(true);
  expect((await api("GET", `jobs/${neighbor.jobId}`)).state).toBe("running");
  gates.get("/hold-packaged-disconnect")!.end('{"token":"fixed-token"}'); gates.delete("/hold-packaged-disconnect");
  expect((await report(neighbor)).verdict).toBe("passed");
  await configureStress({ maxConcurrentStressJobs: 1 });
  const faulted = (await electron([run(fixture.target, "agent", config)])).results[0];
  const faultProcesses = await until(async () => ledgerIntent(faulted.executionId), treeRecorded);
  const faultIdentities = captureOwnedTree(faultProcesses);
  const worker = faultProcesses.processes.find((row: any) => row.role === "worker");
  command("docker", ["exec", name, "node", "--input-type=module", "-e", `import {readProcessIdentity} from './apps/runner-agent/dist/processIdentity.js';const row=await readProcessIdentity(${worker.pid});if(!row||row.birth!==${JSON.stringify(worker.birth)})throw Error('Owned Linux worker identity changed');process.kill(row.pid,'SIGKILL');`]);
  const faultReport = await report(faulted); expect(faultReport.verdict).not.toBe("passed");
  expect((await ledgerIntent(faulted.executionId)).processes.every((row: any) => row.exited)).toBe(true);
  const plain = acceptanceStress(origin, "stress-lost-ack"); await publish(plain.project);
  const before = seen.length, archives = server.faults.archives, drops = server.faults.dropped;
  server.faults.dropMessageAck = 1; server.faults.dropArchiveAck = 1;
  const retry = (await electron([run(plain.target, "agent", { runConfig: { jobTimeoutMs: 30000, stress: { workerCount: 1, confirmedTargetOrigins: [origin] } } })])).results[0];
  expect((await report(retry)).output).toMatchObject({ kind: "stress", result: { requests: { completed: 4 } } });
  await until(async () => ledgerIntent(retry.executionId), value => value.archived && !value.report);
  expect(seen.slice(before).filter(row => row.path === "/stress-lost-ack")).toHaveLength(4);
  expect(server.faults.dropped - drops).toBe(2); expect(server.faults.archives - archives).toBeGreaterThanOrEqual(2);
  writeFileSync(join(server.root, "stress-control-results.json"), JSON.stringify({ first, second, neighbor, waiting, active, activeIdentities, released, physical, faulted, faultProcesses, faultIdentities, faultReport, retry, faults: server.faults, requests: seen.slice(start).map(({ authorization: _auth, ...row }) => row) }, null, 2));
}, 120000);

it.runIf(process.platform === "win32" && !!process.env.APICC_RUNNER_E2E_PACKAGED_EXE)("uses actual asar packaged Electron Node-mode workers and cleans children on main IPC disconnect", async () => {
  const fixture = acceptanceStress(origin, "stress-recovered", true); await publish(fixture.project);
  const operations = [run(fixture.target, "local", { runConfig: { jobTimeoutMs: 30000, stress: { workerCount: 2, confirmedTargetOrigins: [origin] } } })];
  const input = join(server.root, "packaged-stress.input.json"), output = join(server.root, "packaged-stress.output.json");
  writeFileSync(input, JSON.stringify({ executable: process.env.APICC_RUNNER_E2E_PACKAGED_EXE, baseUrl: server.baseUrl, username: "t11-owner", password: "t11-password8", privateRoot: server.root, scope: { workspaceId: ws, groupId: group, projectId }, context: { serverId: `${server.baseUrl}/api/v1`, ownerId, scope: { workspaceId: ws, groupId: group, projectId } }, operations, expectedProcesses: 3, disconnectOperation: run(fixture.heldTarget, "local", { runConfig: { jobTimeoutMs: 30000, stress: { workerCount: 2, confirmedTargetOrigins: [origin] } } }) }));
  await networkProbe("packaged-stress-driver", process.execPath, [join(repo, "apps/desktop/tests/main/online/packaged-stress-probe.mjs"), input, output], { ...process.env, NODE_EXTRA_CA_CERTS: join(server.root, "control-ca.pem") });
  const actual = JSON.parse(readFileSync(output, "utf8"));
  expect(actual.results[0].output).toMatchObject({ kind: "stress", result: { requests: { completed: 4, failed: 4 }, lifecycle: expect.any(Array) } });
  expect(actual.results[0].localStress.runtime.nodeVersion).toBe("24.19.0");
  expect(actual.disconnectExit.every((row: any) => !row.alive)).toBe(true);
  uiReady = true;
}, 120000);
