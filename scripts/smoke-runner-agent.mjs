#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const agentImage = process.env.APICC_RUNNER_SMOKE_AGENT_IMAGE ?? "apicc-runner-agent:local";
const serverImage = process.env.APICC_RUNNER_SMOKE_SERVER_IMAGE ?? "apicc-server:local";
const id = randomUUID().slice(0, 8), prefix = `apicc-runner-smoke-${id}`;
const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
const result = { resources: { root, prefix }, images: {}, checks: [], cleanup: [] };
const containers = new Set(), volumes = new Set();
let composeArgs, composeEnv;
const output = resolve(repo, "local/f7b-t11", `${prefix}.json`); mkdirSync(dirname(output), { recursive: true });
function run(file, args, cwd = root, env = process.env) {
  console.log(`[RUN] ${file} ${args.join(" ")}`);
  const command = spawnSync(file, args, { cwd, env, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (command.error || command.status !== 0) throw new Error(`exit=${command.status}: ${command.stdout}\n${command.stderr}\n${command.error ?? ""}`);
  if (command.stderr) process.stderr.write(command.stderr);
  return command.stdout.trim();
}
const docker = args => run("docker", args);
function removeContainer(name) { docker(["stop", "--time", "30", name]); const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", name])); if (state.Running) throw new Error(`Owned container did not stop: ${name}`); result.cleanup.push({ name, state, finalLogs: docker(["logs", "--tail", "20", name]) }); docker(["rm", name]); containers.delete(name); }
async function healthy(name) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", name]));
    if (state.Health?.Status === "healthy") { result.checks.push({ name, init: JSON.parse(docker(["inspect", "--format", "{{json .HostConfig.Init}}", name])), health: state.Health }); return; }
    if (!state.Running || state.Health?.Status === "unhealthy") throw new Error(`Container health failed: ${JSON.stringify(state)}\n${docker(["logs", name])}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Health deadline: ${name}\n${docker(["logs", name])}`);
}
let passed = false;
try {
  for (const image of [agentImage, serverImage]) result.images[image] = JSON.parse(docker(["image", "inspect", "--format", "{{json .}}", image])).Id;
  const data = `${prefix}-agent-data`; docker(["volume", "create", data]); volumes.add(data);
  const probe = `const {DatabaseSync}=await import('node:sqlite'); const db=new DatabaseSync('/data/smoke.sqlite'); db.exec('CREATE TABLE evidence(value TEXT)'); db.prepare('INSERT INTO evidence VALUES(?)').run('linux-closure'); if(db.prepare('SELECT value FROM evidence').get().value!=='linux-closure')throw Error('sqlite'); db.close(); const {createRequire}=await import('node:module'); const {pathToFileURL}=await import('node:url'); const req=createRequire(pathToFileURL('/app/packages/core/package.json')); const Sqlite=req('better-sqlite3'); const native=new Sqlite(':memory:'); native.prepare('SELECT 1').get();native.close(); await import('./apps/runner-agent/dist/bootstrap.js'); const {readBuildIdentity}=await import('./packages/execution/dist/buildIdentity.js'); const identity=await readBuildIdentity(); const {runtimeCompatibilityIdForRuntime}=await import('./packages/execution/dist/contract/runtime.js'); console.log(JSON.stringify({runtime:process.versions,uid:process.getuid(),pid:process.pid,coreBuildId:identity.coreBuildId,compatibility:runtimeCompatibilityIdForRuntime(process.versions.node,process.versions.v8,identity.scriptApiId)}));`;
  result.checks.push({ linuxClosure: JSON.parse(docker(["run", "--rm", "--init", "--network", "none", "--mount", `type=volume,source=${data},target=/data`, "--entrypoint", "node", agentImage, "--input-type=module", "-e", probe])) });
  const controlData = `${prefix}-control-data`; docker(["volume", "create", controlData]); volumes.add(controlData);
  const http = `${prefix}-http`;
  docker(["run", "-d", "--init", "--network", "none", "--name", http, "-e", "APICC_SERVER_ADMIN_USERNAME=smoke-admin", "-e", "APICC_SERVER_ADMIN_PASSWORD=synthetic-password8", "--mount", `type=volume,source=${controlData},target=/data`, serverImage]); containers.add(http);
  await healthy(http); removeContainer(http);
  if (!process.env.JAVA_HOME) throw new Error("JAVA_HOME must identify JDK21 for private test certificates");
  const keytool = join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "keytool.exe" : "keytool"), password = "synthetic-tls-store";
  const key = args => run(keytool, args);
  key(["-genkeypair", "-alias", "ca", "-dname", "CN=apicc smoke private CA", "-ext", "bc:c", "-keyalg", "RSA", "-keystore", "ca.p12", "-storepass", password, "-validity", "7"]);
  key(["-exportcert", "-rfc", "-alias", "ca", "-keystore", "ca.p12", "-storepass", password, "-file", "control-ca.pem"]);
  key(["-genkeypair", "-alias", "control", "-dname", "CN=localhost", "-keyalg", "RSA", "-keystore", "control.p12", "-storepass", password]);
  key(["-certreq", "-alias", "control", "-keystore", "control.p12", "-storepass", password, "-file", "control.csr"]);
  key(["-gencert", "-rfc", "-alias", "ca", "-keystore", "ca.p12", "-storepass", password, "-infile", "control.csr", "-outfile", "control.pem", "-ext", "SAN=dns:localhost,dns:control,ip:127.0.0.1", "-ext", "EKU=serverAuth", "-validity", "7"]);
  key(["-importcert", "-noprompt", "-alias", "ca", "-keystore", "control.p12", "-storepass", password, "-file", "control-ca.pem"]);
  key(["-importcert", "-alias", "control", "-keystore", "control.p12", "-storepass", password, "-file", "control.pem"]);
  writeFileSync(join(root, "materials-key"), randomBytes(32));
  const tls = join(root, "tls"); mkdirSync(tls);
  for (const file of ["control.p12", "control-ca.pem"]) copyFileSync(join(root, file), join(tls, file));
  // Only control is started here; real agent enrollment and dispatch use the unified E2E.
  writeFileSync(join(root, "deployment.json"), "{}"); writeFileSync(join(root, "agent-token"), "not-enrolled-smoke-placeholder");
  const https = `${prefix}-https`, override = join(root, "compose.override.json");
  writeFileSync(override, JSON.stringify({ services: { control: { container_name: https } }, volumes: { "control-data": { name: controlData, external: true } } }));
  composeArgs = ["compose", "--project-name", prefix, "-f", join(repo, "deploy/runner-agent/compose.yml"), "-f", override];
  composeEnv = { ...process.env, APICC_SERVER_IMAGE: serverImage, APICC_AGENT_IMAGE: agentImage, APICC_HTTPS_PORT: "0", APICC_TLS_STORE_PASSWORD: password,
    APICC_SERVER_ADMIN_USERNAME: "smoke-admin", APICC_SERVER_ADMIN_PASSWORD: "synthetic-password8", APICC_CONTROL_BASE_URL: "https://control:8443/api/v1",
    APICC_TLS_DIRECTORY: tls, APICC_MASTER_KEY_FILE: join(root, "materials-key"), APICC_AGENT_CONFIG_FILE: join(root, "deployment.json"), APICC_AGENT_TOKEN_FILE: join(root, "agent-token"), APICC_AGENT_CA_FILE: join(root, "control-ca.pem") };
  run("docker", [...composeArgs, "config", "--quiet"], root, composeEnv);
  run("docker", [...composeArgs, "up", "-d", "control"], root, composeEnv); containers.add(https);
  result.resources.composeProject = prefix;
  await healthy(https); removeContainer(https); passed = true;
} finally {
  for (const name of [...containers]) { try { removeContainer(name); } catch (error) { result.cleanup.push({ name, error: String(error) }); } }
  if (composeArgs && containers.size === 0) { try { run("docker", [...composeArgs, "down"], root, composeEnv); result.cleanup.push({ removedComposeProject: prefix }); } catch (error) { passed = false; result.cleanup.push({ composeError: String(error) }); } }
  if (containers.size === 0) { for (const name of [...volumes]) { try { docker(["volume", "rm", name]); volumes.delete(name); result.cleanup.push({ removedVolume: name }); } catch (error) { passed = false; result.cleanup.push({ volume: name, error: String(error) }); } } }
  result.passed = passed && containers.size === 0 && volumes.size === 0;
  if (!result.passed) process.exitCode = 1;
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n"); console.log(`Evidence: ${output}`);
  if (result.passed && dirname(realpathSync(root)) === realpathSync(tmpdir())) rmSync(root, { recursive: true, force: true });
  else console.error(`Private evidence/materials preserved: ${root}`);
}
