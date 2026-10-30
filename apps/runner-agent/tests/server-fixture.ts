import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, isIP } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { Agent, fetch as dispatcherFetch } from "undici";

export const repo = resolve(import.meta.dirname, "../../..");
export function advertisedHost(): string {
  if (process.env.APICC_RUNNER_E2E_HOST) return process.env.APICC_RUNNER_E2E_HOST;
  if (process.platform === "win32") return "host.docker.internal";
  // The Linux host and its bridge containers can both reach this actual gateway IP.
  return command("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]);
}
export function command(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const batch = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  const quote = (text: string) => /\s/.test(text) ? `"${text}"` : text;
  const result = batch
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", `"${[file, ...args].map(quote).join(" ")}"`], { ...options, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true })
    : spawnSync(file, args, { ...options, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Command failed (${result.status}): ${file} ${args.join(" ")}\n${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  return result.stdout.trim();
}
export async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
export async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, budgetMs = 30000): Promise<T> {
  const deadline = Date.now() + budgetMs; let last: unknown;
  while (Date.now() < deadline) { try { const value = await read(); if (accept(value)) return value; last = value; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Readiness not reached: ${JSON.stringify(last, Object.getOwnPropertyNames(last ?? {}))}`);
}
/** Own private Maven output/data/certs/cwd; stop confirmation precedes any optional cleanup. */
export async function serverFixture(options: { artifactJar?: string; evidenceParent?: string; variables?: NodeJS.ProcessEnv; dataDirectory?: string; proxyPort?: number } = {}) {
  const parent = options.evidenceParent ?? join(repo, "local/f7b-t11"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "e2e-"));
  const javaHome = process.env.JAVA_HOME; if (!javaHome) throw new Error("JAVA_HOME must name the JDK21 root");
  const exe = (name: string) => join(javaHome, "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`);
  const java = spawnSync(exe("java"), ["-version"], { encoding: "utf8", windowsHide: true });
  if (java.status !== 0 || !/version "21\./.test(java.stderr)) throw new Error(`JDK21 required: ${java.stderr}`);
  const build = join(root, "maven");
  let jar = options.artifactJar;
  if (!jar) {
    const buildArgs = ["-s", join(repo, "server/.mvn/settings.xml"), "-f", join(repo, "server/pom.xml"), `-Dapicc.build.directory=${build}`, "-DskipTests", "package"];
    writeFileSync(join(root, "maven-build.log"), `cwd=${root}\nJDK=${javaHome}\nargs=${JSON.stringify(buildArgs)}\n` + command(join(repo, "server", process.platform === "win32" ? "mvnw.cmd" : "mvnw"), buildArgs, { cwd: root }) + "\nexit=0\n");
    jar = join(build, readdirSync(build).find(name => /^apicc-server-.+\.jar$/.test(name))!);
  } else writeFileSync(join(root, "maven-build.log"), `Reuse the explicitly selected private server artifact: ${jar}\n`);
  const password = "t11-synthetic-store";
  const host = advertisedHost(); const authorityHost = isIP(host) === 6 ? `[${host}]` : host;
  const key = (args: string[]) => command(exe("keytool"), args, { cwd: root });
  key(["-genkeypair", "-alias", "ca", "-dname", "CN=apicc T11 synthetic CA", "-ext", "bc:c", "-keyalg", "RSA", "-keysize", "2048", "-validity", "7", "-keystore", "ca.p12", "-storepass", password]);
  key(["-exportcert", "-rfc", "-alias", "ca", "-keystore", "ca.p12", "-storepass", password, "-file", "control-ca.pem"]);
  key(["-genkeypair", "-alias", "control", "-dname", "CN=localhost", "-keyalg", "RSA", "-keysize", "2048", "-validity", "7", "-keystore", "control.p12", "-storepass", password]);
  key(["-certreq", "-alias", "control", "-keystore", "control.p12", "-storepass", password, "-file", "control.csr"]);
  key(["-gencert", "-rfc", "-alias", "ca", "-keystore", "ca.p12", "-storepass", password, "-infile", "control.csr", "-outfile", "control.pem", "-validity", "7", "-ext", `SAN=dns:localhost,dns:control,ip:127.0.0.1,${isIP(host) ? "ip" : "dns"}:${host}`, "-ext", "KU=digitalSignature,keyEncipherment", "-ext", "EKU=serverAuth"]);
  key(["-importcert", "-noprompt", "-alias", "ca", "-keystore", "control.p12", "-storepass", password, "-file", "control-ca.pem"]);
  key(["-importcert", "-alias", "control", "-keystore", "control.p12", "-storepass", password, "-file", "control.pem"]);
  writeFileSync(join(root, "materials-key"), Buffer.alloc(32, 11));
  const port = await freePort(), proxyPort = options.proxyPort ?? await freePort(); const baseUrl = `https://${authorityHost}:${proxyPort}`;
  const dispatcher = new Agent({ connect: { ca: readFileSync(join(root, "control-ca.pem"), "utf8"), rejectUnauthorized: true } });
  const installedFetch = dispatcherFetch as unknown as typeof fetch;
  const trustedFetch: typeof fetch = (input, init) => installedFetch(input, { ...init, dispatcher } as RequestInit);
  const faults = { offline: false, dropMessageAck: 0, dropArchiveAck: 0, messages: 0, archives: 0, dropped: 0 };
  const proxy = createHttpsServer({ pfx: readFileSync(join(root, "control.p12")), passphrase: password }, async (request, response) => {
    try {
      const path = request.url!;
      if (faults.offline && path.startsWith("/api/v1/runner/")) { response.writeHead(503); response.end("synthetic control outage"); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value !== undefined && !["host", "connection", "content-length", "transfer-encoding"].includes(key)) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const upstream = await trustedFetch(`https://localhost:${port}${path}`, { method: request.method, headers, ...(bytes.length ? { body: bytes } : {}), redirect: "error" });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (path.endsWith("/runner/messages")) { faults.messages++; if (faults.dropMessageAck > 0) { faults.dropMessageAck--; faults.dropped++; response.destroy(); return; } }
      if (/\/runner\/jobs\/[^/]+\/report\?/.test(path)) { faults.archives++; if (faults.dropArchiveAck > 0) { faults.dropArchiveAck--; faults.dropped++; response.destroy(); return; } }
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }); response.end(body);
    } catch (error) { appendFileSync(join(root, "proxy.log"), `${String(error)}\n`); if (!response.destroyed) { response.writeHead(502); response.end("synthetic upstream unavailable"); } }
  });
  await new Promise<void>(resolve => proxy.listen(proxyPort, "0.0.0.0", resolve));
  let child: ChildProcess | undefined;
  const start = async (variables: NodeJS.ProcessEnv = {}) => {
    appendFileSync(join(root, "process-environment.jsonl"), JSON.stringify({startedAt:new Date().toISOString(),variables,selectedEnvironment:Object.fromEntries(Object.entries({...process.env,...variables}).filter(([key])=>/^(SPRING_|APICC_SCHEDULER|APICC_NOTIFICATION|JAVA_HOME)/i.test(key)))})+"\n");
    child = spawn(exe("java"), ["-jar", jar, `--server.port=${port}`, "--server.ssl.enabled=true", `--server.ssl.key-store=${join(root, "control.p12")}`, "--server.ssl.key-store-type=PKCS12", `--server.ssl.key-store-password=${password}`, `--apicc.server.data-dir=${options.dataDirectory ?? join(root, "data")}`, `--apicc.execution.materials.master-key-file=${join(root, "materials-key")}`, `--apicc.execution.control-base-url=${baseUrl}/api/v1`, "--apicc.server.allow-registration=true", "--apicc.server.admin-username=t11-owner", "--apicc.server.admin-password=t11-password8", `--apicc.server.console-dir=${join(repo, "apps/admin-web/dist")}`], { cwd: root, env: { ...process.env, ...variables }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", bytes => appendFileSync(join(root, "server.log"), bytes));
    await until(() => trustedFetch(`${baseUrl}/api/v1/ping`).then(async response => response.ok && (await response.json() as { status: string }).status === "ok"), Boolean, 60000);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
    let forced = false;
    child.kill("SIGTERM");
    const stopped = await Promise.race([exited.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!stopped) { forced = true; if (process.platform === "win32") command("taskkill", ["/PID", String(child.pid), "/T", "/F"]); else child.kill("SIGKILL"); await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("Private Java did not exit; preserve root")), 5000))]); }
    appendFileSync(join(root, "lifecycle.log"), `Java stopped pid=${child.pid} exit=${child.exitCode} signal=${child.signalCode} requested=SIGTERM forcedFallback=${forced}\n`);
  };
  const close = async () => {
    const errors: unknown[] = [];
    try { await stop(); } catch (error) { errors.push(error); }
    try { proxy.closeAllConnections(); await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } catch (error) { errors.push(error); }
    try { await dispatcher.close(); } catch (error) { errors.push(error); }
    if (errors.length) {
      try { appendFileSync(join(root, "cleanup-errors.log"), errors.map(String).join("\n") + "\n"); } catch (error) { errors.push(error); }
      throw new AggregateError(errors, `Private HTTPS cleanup failed; preserved ${root}: ${errors.map(String).join("; ")}`);
    }
  };
  try { await start(options.variables); }
  catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `Private HTTPS startup and cleanup failed; preserved ${root}: ${String(error)}; ${String(cleanupError)}`); }
    throw new Error(`Private HTTPS fixture failed; preserved ${root}: ${String(error)}`, { cause: error });
  }
  return { root, baseUrl, authorityHost, trustedFetch, start, stop, faults, serverPid: () => child?.pid, close, jar, javaVersion: java.stderr };
}
