// Own synthetic services for centralized manual UI acceptance; no native/UI automation.
import { serverFixture, command, until, repo } from "./server-fixture.ts";
import { semanticProject, semanticTarget, semanticIds } from "./runtime-semantics.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { encodeContractProjectFiles } from "@apicc/core";
import { prepareProjectFiles } from "@apicc/execution/host";

const server = await serverFixture({ artifactJar: process.env.APICC_RUNNER_UI_JAR });
const suffix = basename(server.root).toLowerCase(), name = `apicc-f7b-t11-ui-${suffix}`, volume = `${name}-data`;
let token = "", container = false, volumeMade = false, held = false, finish;
let serviceFailure;
const stopped = new Promise(resolve => { finish = resolve; });
const gates = new Set();
const target = createServer((request, response) => {
  if (request.url === "/_t11/hold-next") { held = true; response.end("armed"); return; }
  if (request.url === "/_t11/release") { for (const gate of gates) gate.end('{"token":"fixed-token"}'); gates.clear(); response.end("released"); return; }
  if (request.url === "/_t11/stop") { response.end("stopping"); finish(); return; }
  request.resume(); request.on("end", () => { response.setHeader("content-type", "application/json"); if (held) { held = false; gates.add(response); } else response.end('{"token":"fixed-token"}'); });
});
await new Promise(resolve => target.listen(0, "0.0.0.0", resolve)); const origin = `http://${server.authorityHost}:${target.address().port}`;
async function api(method, path, body, auth = token) {
  const response = await server.trustedFetch(`${server.baseUrl}/api/v1/${path}`, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${text}`); return text ? JSON.parse(text) : null;
}
try {
  const owner = await api("POST", "auth/login", { username: "t11-owner", password: "t11-password8" }, ""); token = owner.token;
  const ws = (await api("GET", "connect")).workspaceId, group = (await api("GET", `workspaces/${ws}/groups`))[0].id;
  const projectId = (await api("POST", `workspaces/${ws}/projects`, { groupId: group, name: "F7b 集中验收 / Synthetic" })).id;
  const path = `workspaces/${ws}/projects/${projectId}`;
  const users = [{ username: "t11-owner", password: "t11-password8", role: "SUPERADMIN / OWNER" }];
  for (const [username, role] of [["t11-admin", "ADMIN"], ["t11-editor", "EDITOR"], ["t11-viewer", "VIEWER"]]) {
    const user = await api("POST", "auth/register", { username, password: "t11-password8", displayName: `Synthetic ${role}` }, "");
    await api("PUT", `workspaces/${ws}/members/${user.id}`, { role }); users.push({ username, password: "t11-password8", role });
  }
  const agentId = (await api("POST", "agents", { name: "F7b Linux / 独立代理" })).id;
  await api("PUT", `agents/${agentId}/workspace-grants`, { workspaceIds: [ws] });
  await api("PUT", `workspaces/${ws}/agent-project-allocations`, { agentId, projectIds: [projectId] });
  await api("PUT", `${path}/execution-settings`, { expectedVersion: "0", agentIds: [agentId], defaultAgentId: agentId, policy: { cancelGraceMs: 200 } });
  await api("PATCH", `agents/${agentId}`, { expectedVersion: "0", config: { maxConcurrentJobs: 2, scriptMode: "trusted-core", minFreeDiskBytes: 1, transferRetryCycleMs: 1000 } });
  const enrollment = await api("POST", `agents/${agentId}/enrollments`), enrolled = await api("POST", "runner/enroll", { enrollmentToken: enrollment.enrollmentToken }, "");
  writeFileSync(join(server.root, "agent-token"), enrolled.agentToken);
  writeFileSync(join(server.root, "deployment.json"), JSON.stringify({ baseUrl: `${server.baseUrl}/api/v1`, agentId, tokenFile: "/run/apicc/agent-token", dataDirectory: "/data", trustedCaFile: "/run/apicc/control-ca.pem" }));
  command("docker", ["volume", "create", volume]); volumeMade = true;
  command("docker", ["run", "-d", "--init", "--name", name, "--mount", `type=volume,source=${volume},target=/data`, ...["deployment.json", "agent-token", "control-ca.pem"].flatMap(file => ["--mount", `type=bind,source=${join(server.root, file)},target=/run/apicc/${file},readonly`]), process.env.APICC_RUNNER_E2E_IMAGE ?? "apicc-f7b-t11-agent:candidate"]); container = true;
  const registered = await until(() => api("GET", `agents/${agentId}`), value => value.runtime && value.status === "applied");
  const project = semanticProject(origin, true); const assets = await api("PUT", `${path}/assets`, { format: "contract-files-v1", contractProjectId: project.id, expectedVersion: "0", changes: [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content })), deletes: [] });
  await api("PUT", `${path}/credentials/synthetic-credential`, { expectedVersion: "0", value: "t11-synthetic-secret" });
  const prepared = await prepareProjectFiles(assets, { target: semanticTarget("workflow"), environmentId: semanticIds.environment, profile: "trusted-core-script" });
  await api("PUT", `${path}/script-grants`, { agentId, expectedVersion: "0", scope: "script-version", scripts: prepared.scriptRequirements.map(({ scriptId, contentHash }) => ({ scriptId, contentHash })), riskConfirmed: true });
  const operations = ["debug", "workflow"].map(kind => ({ operation: "run", runId: randomUUID(), location: { kind: "agent", agentId }, target: semanticTarget(kind), expectedVersion: assets.version, environmentId: semanticIds.environment, runConfig: { jobTimeoutMs: 120000 }, materials: { projectId, credentials: [{ refId: "synthetic-credential", version: "1" }], attachments: [] }, localOnlyRefIds: [] }));
  const input = join(server.root, "seed.input.json"), output = join(server.root, "seed.output.json");
  writeFileSync(input, JSON.stringify({ baseUrl: server.baseUrl, username: "t11-owner", password: "t11-password8", privateRoot: server.root, scope: { workspaceId: ws, groupId: group, projectId }, operations }));
  const child = spawn(join(repo, "apps/desktop/node_modules/electron/dist/electron.exe"), [join(repo, "apps/desktop/tests/main/online/electron-execution-probe.mjs"), input, output, `--user-data-dir=${join(server.root, "seed-profile")}`], { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(server.root, "control-ca.pem"), ELECTRON_RUN_AS_NODE: undefined }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => appendFileSync(join(server.root, "seed.log"), bytes));
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); if (code !== 0) throw Error(`Synthetic seed Electron exited ${code}`);
  const jobs = JSON.parse(readFileSync(output, "utf8")).results;
  for (const job of jobs) await until(() => api("GET", `jobs/${job.jobId}`), value => value.reportState === "archived");
  const context = { root: server.root, baseUrl: server.baseUrl, apiBase: `${server.baseUrl}/api/v1`, targetOrigin: origin, users, ws, group, projectId, agentId, jobs: jobs.map(value => value.jobId), container: name, volume, javaPid: server.serverPid(), nodePid: process.pid, caFile: join(server.root, "control-ca.pem"), jar: server.jar, jarSha256: createHash("sha256").update(readFileSync(server.jar)).digest("hex"), coreBuildId: registered.runtime.coreBuildId, stopUrl: `${origin}/_t11/stop`, holdNextUrl: `${origin}/_t11/hold-next`, releaseUrl: `${origin}/_t11/release` };
  writeFileSync(join(server.root, "ui-context.json"), JSON.stringify(context, null, 2)); console.log(JSON.stringify(context));
  process.once("SIGINT", finish); process.once("SIGTERM", finish); await stopped;
} catch (error) {
  serviceFailure = error;
  throw error;
} finally {
  const errors = [];
  const attempt = async action => { try { await action(); } catch (error) { errors.push(error); } };
  for (const gate of gates) await attempt(() => gate.end('{"token":"fixed-token"}'));
  let agentStopped = false, removed = false;
  if (container) {
    await attempt(() => command("docker", ["stop", "--time", "30", name]));
    await attempt(() => {
      const state = JSON.parse(command("docker", ["inspect", "--format", "{{json .State}}", name]));
      if (state.Running !== false) throw Error(`Owned UI agent stop unconfirmed; preserve ${name}/${volume}`);
      agentStopped = true;
      appendFileSync(join(server.root, "lifecycle.log"), `UI agent stopped ${JSON.stringify(state)}\n`);
    });
    await attempt(() => appendFileSync(join(server.root, "agent.log"), command("docker", ["logs", name])));
    if (agentStopped) await attempt(() => { command("docker", ["rm", name]); removed = true; });
  }
  if (volumeMade) {
    if (agentStopped && removed) await attempt(() => command("docker", ["volume", "rm", volume]));
    else errors.push(Error(`Preserved owned UI volume ${volume}: stop/removal not confirmed`));
  }
  await attempt(async () => { target.closeAllConnections(); await new Promise((resolve, reject) => target.close(error => error ? reject(error) : resolve())); });
  await attempt(() => server.close());
  await attempt(() => appendFileSync(join(server.root, "lifecycle.log"), `UI cleanup finished; failures=${errors.length}\n`));
  if (errors.length) {
    const failures = serviceFailure === undefined ? errors : [serviceFailure, ...errors];
    await attempt(() => appendFileSync(join(server.root, "cleanup-errors.log"), failures.map(String).join("\n") + "\n"));
    throw new AggregateError(failures, `Owned UI cleanup failed: ${failures.map(String).join("; ")}`);
  }
}
