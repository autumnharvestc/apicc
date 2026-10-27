import { beforeAll, afterAll, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeContractProjectFiles, type ContractProject } from "@apicc/core";
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
const image = process.env.APICC_RUNNER_E2E_IMAGE ?? "apicc-f7b-t11-agent:candidate";
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
function run(target: TaskTarget, kind: "local" | "agent", extra: Record<string, unknown> = {}) {
  return { operation: "run", runId: randomUUID(), location: kind === "local" ? { kind } : { kind, agentId }, target, expectedVersion: assets.version, environmentId: semanticIds.environment, runConfig: { jobTimeoutMs: 30000 }, materials: { projectId, credentials: [{ refId: "synthetic-credential", version: "1" }], attachments: [] }, localOnlyRefIds: [], ...extra };
}
async function report(job: { jobId: string }) {
  await until(() => api("GET", `jobs/${job.jobId}`), status => status.state === "ended" && status.executionReleased && status.reportState === "archived");
  return api("GET", `jobs/${job.jobId}/report`);
}
beforeAll(async () => {
  server = await serverFixture();
  console.log(`T11 private resources ${JSON.stringify({ root: server.root, baseUrl: server.baseUrl, name, volume, image })}`);
  target = createServer((request, response) => {
    let body = ""; request.on("data", bytes => { body += bytes; }); request.on("end", () => {
      seen.push({ path: request.url!, data: request.headers["x-data"] as string, environment: request.headers["x-environment"] as string, cookie: request.headers.cookie, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json"); response.setHeader("set-cookie", "t11=synthetic-cookie; Path=/");
      if (request.url!.startsWith("/hold")) gates.set(request.url!, response); else response.end('{"token":"fixed-token"}');
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
  await api("PUT", `${projectPath()}/credentials/synthetic-credential`, { expectedVersion: "0", value: "t11-synthetic-secret" });
  writeFileSync(join(server.root, "context.json"), JSON.stringify({ baseUrl: server.baseUrl, origin, ws, group, projectId, agentId, ownerId, image, name, volume, identity, javaVersion: server.javaVersion }, null, 2));
}, 600000);

afterAll(async () => {
  const errors: unknown[] = [];
  const attempt = async (action: () => unknown) => { try { await action(); } catch (error) { errors.push(error); } };
  for (const response of gates.values()) await attempt(() => response.end('{"token":"fixed-token"}'));
  gates.clear();
  let stopped = false, copied = false, removed = false;
  if (containerCreated) {
    await attempt(() => {
      const closure = command("docker", ["exec", name, "node", "--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/data/execution-ledger.sqlite',{readOnly:true}); console.log(JSON.stringify({runtime:process.versions,pid:process.pid,uid:process.getuid(),sqlite:db.prepare('select sqlite_version() version').get(),integrity:db.prepare('pragma integrity_check').get()}));db.close();"]);
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
}, 60000);

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
  const ledger = () => JSON.parse(command("docker", ["exec", name, "node", "-e", `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/execution-ledger.sqlite',{readOnly:true});const state=JSON.parse(db.prepare('select state from ledger where id=1').get().state);console.log(JSON.stringify(state.intents.find(value=>value.executionId===${JSON.stringify(offline.executionId)})));db.close();`]));
  await until(async () => ledger(), value => value.settled && !!value.report);
  server.faults.offline = false; expect((await report(offline)).verdict).toBe("passed");
  await until(async () => ledger(), value => value.archived && !value.report);
  expect(server.faults.dropped).toBe(2); expect(server.faults.archives - beforeArchive).toBeGreaterThanOrEqual(2);
  expect(seen.filter(row => row.path === "/hold-offline")).toHaveLength(1);
  const beforeRestart = await api("GET", `agents/${agentId}`);
  await server.stop(); await server.start({ APICC_EXECUTION_AGENT_CHILDMAXOLDSPACEMIB: "128" });
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
