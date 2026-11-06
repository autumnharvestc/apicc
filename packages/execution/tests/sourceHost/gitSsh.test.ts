import { it, expect, beforeAll, afterAll } from "vitest";
import { readFile, writeFile, readdir, stat, rm, access } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { createServer, type Socket } from "node:net";
import { userInfo } from "node:os";
import { installGitApplication, holdGitSource, observeOwnedPeerReset } from "./git-application.js";
import { gitReaderFixture } from "./git-reader-fixture.js";
import type { SourceMaterialLease } from "../../src/source-host/types.js";

let application: Awaited<ReturnType<typeof installGitApplication>>;
let held: Awaited<ReturnType<typeof holdGitSource>>;
beforeAll(async () => { application = await installGitApplication(); held = await holdGitSource(); if (process.platform === "win32") await held.fixture.positiveWindowsControls(["ssh"]); else await held.fixture.positiveControls(["ssh"]); }, 30000);
afterAll(async () => { await held?.close(); await application?.close(); });
const objects = {
  sha1: { kind: "git", objectFormat: "sha1", commitOid: "f9fbd710b4a0772621ad5c76fb5393938a67b8e2", blobOid: "f77ca262872d149b637048a2aa365bc8794cd8db", rawSha256: "6dc57b202bb79a3f2c1d12dcb9a52e8cfd13f8fc3ba1cc76f5e372779ad48cce" },
  sha256: { kind: "git", objectFormat: "sha256", commitOid: "5676e6ffaca4b6d841a76fa19e918e3e718f7e3ee241c6c1f5de618a2c662eb2", blobOid: "25c556ea9234296a727d63dc4eb6f56cf4b4c2f90274dec965897933d8d3b4b0", rawSha256: "6dc57b202bb79a3f2c1d12dcb9a52e8cfd13f8fc3ba1cc76f5e372779ad48cce" },
};
it.each(["sha1", "sha256"] as const)("C reads actual SSH %s using an encrypted key, passphrase and explicit direct-route capture", async format => {
  const f = held.fixture; const r = await gitReaderFixture(f, application);
  expect(() => r.prepared.resolveForOrigin(new URL(f.sshUrl))).toThrow();
  await expect(r.read(r.input("git-ssh", { repositoryUrl: f.sshUrl.replace("repo-sha1", `repo-${format}`) }), { captureNetwork: async () => { throw Error("SSH must not call HTTP capture"); } })).resolves.toMatchObject({ status: "read", upstream: objects[format], rawText: f.repositories[format].rawText });
  expect(r.sshCaptures()).toBe(1); expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
}, 30000);
it("C peels an SSH annotated tag through the shared fixed-object reader", async () => {
  const r = await gitReaderFixture(held.fixture, application);
  await expect(r.read(r.input("git-ssh", { ref: "refs/tags/owned-tag" }))).resolves.toMatchObject({ upstream: objects.sha1 });
}, 30000);
it("C preserves local wrong-object diagnostics after a successful SSH fetch", async () => {
  const r = await gitReaderFixture(held.fixture, application);
  await expect(r.read(r.input("git-ssh", { ref: "refs/tags/owned-blob" }))).rejects.toMatchObject({ code: "SYNC_GIT_OBJECT_INVALID" });
  expect(r.contentsDelivered()).toBe(0); expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
}, 30000);
it("C accepts an unencrypted leased key without a passphrase reference", async () => {
  const f = held.fixture; const r = await gitReaderFixture(f, application); const plain = join(f.directory, "owned-plain-key");
  await f.exec(["/bin/cp", "/fixture/client", "/fixture/plain-client"]);
  await f.exec(["/usr/bin/ssh-keygen", "-p", "-P", f.passphrase, "-N", "", "-f", "/fixture/plain-client"]);
  await f.command(["cp", `${f.container}:/fixture/plain-client`, plain]);
  await expect(r.read(r.input("git-ssh", { passphraseRef: undefined }), {}, { ssh: { privateKeyPath: plain, knownHostsPath: f.knownHostsPath } })).resolves.toMatchObject({ status: "read", upstream: objects.sha1 });
  expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
}, 30000);

it.each([
  { scenario: "missing key lease", code: "SYNC_MATERIAL_MISSING" },
  { scenario: "missing passphrase", code: "SYNC_MATERIAL_MISSING" },
  { scenario: "relative key path", code: "SYNC_MATERIAL_INVALID" },
  { scenario: "missing hosts file", code: "SYNC_MATERIAL_INVALID" },
  { scenario: "oversized key file", code: "SYNC_MATERIAL_INVALID" },
  { scenario: "linebreak passphrase", code: "SYNC_MATERIAL_INVALID" },
  { scenario: "oversized passphrase", code: "SYNC_MATERIAL_INVALID" },
  { scenario: "changed host key", code: "SYNC_HOST_KEY_MISMATCH" },
  { scenario: "wrong passphrase", code: "SYNC_SSH_AUTH_FAILED" },
])("C refuses $scenario without delivering content or leaking material", async ({ scenario, code }) => {
  const f = held.fixture; const r = await gitReaderFixture(f, application); const before = (await f.uploads()).length;
  let ssh: SourceMaterialLease["ssh"] = { privateKeyPath: f.privateKeyPath, knownHostsPath: f.knownHostsPath, passphrase: f.passphrase };
  if (scenario === "missing key lease") ssh = undefined;
  if (scenario === "missing passphrase") ssh = { ...ssh!, passphrase: undefined };
  if (scenario === "relative key path") ssh = { ...ssh!, privateKeyPath: "relative-private-key" };
  if (scenario === "missing hosts file") ssh = { ...ssh!, knownHostsPath: join(f.directory, "owned-missing-hosts") };
  if (scenario === "oversized key file") { const path = join(f.directory, "owned-large-key"); await writeFile(path, Buffer.alloc(1048577)); ssh = { ...ssh!, privateKeyPath: path }; }
  if (scenario === "linebreak passphrase") ssh = { ...ssh!, passphrase: "owned\npassphrase" };
  if (scenario === "oversized passphrase") ssh = { ...ssh!, passphrase: "x".repeat(65537) };
  if (scenario === "changed host key") ssh = { ...ssh!, knownHostsPath: f.wrongHostKeyRef };
  if (scenario === "wrong passphrase") ssh = { ...ssh!, passphrase: "wrong-owned-secret" };
  const error = await r.read(r.input("git-ssh"), {}, { ssh }).catch(value => value);
  expect(error).toMatchObject({ code }); expect(String(error)).not.toMatch(/wrong-owned-secret|owned-passphrase|BEGIN OPENSSH|[A-Z]:\\/);
  expect(r.contentsDelivered()).toBe(0); expect((await f.uploads()).length - before).toBe(0); expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
}, 30000);

it.each(["missing route", "proxy route", "denied address"])("C refuses %s without implicit direct or HTTP fallback", async scenario => {
  const r = await gitReaderFixture(held.fixture, application); const input = r.input("git-ssh");
  if (input.source.kind !== "git-ssh") throw Error("Valid SSH fixture required");
  const context = await r.options.captureSshRoute!(input.source, new AbortController().signal);
  const captureSshRoute = scenario === "missing route" ? undefined : async () => ({ ...context, ...(scenario === "proxy route" ? { route: { kind: "proxy" as const, url: "http://127.0.0.1:1" } } : { approveDestination: () => false }) });
  await expect(r.read(input, { captureSshRoute })).rejects.toMatchObject({ code: scenario === "missing route" ? "SYNC_SSH_ROUTE_UNAVAILABLE" : scenario === "proxy route" ? "SYNC_PROXY_UNSUPPORTED" : "SYNC_NETWORK_DENIED" });
  expect(r.contentsDelivered()).toBe(0); expect(r.released()).toBe(1);
}, 30000);

it("C copies leased material into the exclusive private ACL owner and leaves original files intact", async () => {
  const f = held.fixture; const r = await gitReaderFixture(f, application); const originalKey = await readFile(f.privateKeyPath); const originalHosts = await readFile(f.knownHostsPath); let keyCopies = 0; let hostsCopies = 0; let privatePosixMode = true;
  const git = { ...r.options.git!, createPrivateRead: async (signal: AbortSignal) => { const owner = await r.options.git!.createPrivateRead(signal); return { ...owner, collect: async () => {
    const visit = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else { const value = await readFile(path); if (value.equals(originalKey)) { keyCopies++; if (process.platform !== "win32") privatePosixMode &&= ((await stat(path)).mode & 0o777) === 0o600; } if (value.equals(originalHosts)) hostsCopies++; } } };
    await visit(owner.directory); await owner.collect();
  } }; } };
  await expect(r.read(r.input("git-ssh"), { git })).resolves.toMatchObject({ status: "read" });
  expect({ keyCopies, hostsCopies, privatePosixMode }).toEqual({ keyCopies: 1, hostsCopies: 1, privatePosixMode: true });
  expect(await readFile(f.privateKeyPath)).toEqual(originalKey); expect(await readFile(f.knownHostsPath)).toEqual(originalHosts); expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
}, 30000);

it("C ignores inherited Git SSH commands and configuration", async () => {
  const f = held.fixture; const r = await gitReaderFixture(f, application); const marker = join(f.directory, "must-not-execute");
  const names = ["GIT_SSH_COMMAND", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "SSH_AUTH_SOCK"] as const; const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')"`;
  Object.assign(process.env, { GIT_SSH_COMMAND: command, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: command, SSH_AUTH_SOCK: join(f.directory, "unowned-agent") });
  try { await expect(r.read(r.input("git-ssh"))).resolves.toMatchObject({ status: "read" }); expect(await access(marker).then(() => true, () => false)).toBe(false); }
  finally { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } }
}, 30000);

it.each(["cancel", "deadline"])("C collects actual Git/SSH descendants and private copies on %s", async reason => {
  const f = held.fixture; const r = await gitReaderFixture(f, application); const controller = new AbortController(); const input = r.input("git-ssh"); if (reason === "deadline") input.deadlineAtMs = Date.now() + 5000;
  await f.pauseUploads(); const before = (await f.uploads()).length; let settled = false; let started = false;
  const pending = r.read(input, {}, {}, controller.signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error })); pending.then(() => { settled = true; });
  try { while (!settled && Date.now() < input.deadlineAtMs) { if ((await f.uploads()).length > before) { started = true; if (reason === "cancel") controller.abort(); break; } await new Promise(resolve => setTimeout(resolve, 25)); } if (!started && !settled) controller.abort(); const outcome = await pending;
    expect({ started, code: outcome.error?.code, released: r.released(), retained: r.retained() }).toEqual({ started: true, code: reason === "cancel" ? "SYNC_CANCELLED" : "SYNC_DEADLINE", released: 1, retained: 0 }); expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
  } finally { controller.abort(); await f.resumeUploads(); await pending; }
}, 45000);

it("C applies the connection budget to a real stalled SSH banner exchange", async () => {
  let bannerBytes = 0; const sockets = new Set<Socket>(); const blackhole = createServer(socket => { sockets.add(socket); observeOwnedPeerReset(socket); socket.on("data", chunk => { bannerBytes += chunk.length; }); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => blackhole.listen(0, "127.0.0.1", resolve));
  const port = (blackhole.address() as import("node:net").AddressInfo).port; const r = await gitReaderFixture(held.fixture, application);
  try {
    const input = r.input("git-ssh", { repositoryUrl: `ssh://ownedgit@owned.git.test:${port}/fixture/repo-sha1.git` });
    const error = await r.read(input).catch(value => value);
    expect({ attempted: bannerBytes > 0, code: error.code, released: r.released() }).toEqual({ attempted: true, code: "SYNC_CONNECT_TIMEOUT", released: 1 });
    expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => blackhole.close(() => resolve())); }
}, 45000);

it.runIf(process.platform === "win32")("C native askpass outputs exact UTF-8 secret bytes without JSON or command-line secrets", async () => {
  const file = join(held.fixture.directory, "native-askpass-value"); await writeFile(file, "owned 秘密 🔒");
  const result = await application.processApi.runOwnedProcess({ toolPath: join(application.directory, "owned-process.exe"), args: ["owned prompt"], cwd: held.fixture.directory, env: { SystemRoot: process.env.SystemRoot, PROGRAMDATA: process.env.PROGRAMDATA, APICC_SOURCE_BRIDGE_MODE: "askpass", APICC_SOURCE_ASKPASS_FILE: file }, maxOutputBytes: 4096, signal: new AbortController().signal });
  expect({ exitCode: result.exitCode, stdout: result.stdout.toString("utf8") }).toEqual({ exitCode: 0, stdout: "owned 秘密 🔒" });
});
it.runIf(process.platform === "win32")("C native askpass preserves a leading U+FEFF secret code point", async () => {
  const file = join(held.fixture.directory, "native-askpass-bom-value"); await writeFile(file, "\uFEFFowned-bom-secret");
  const result = await application.processApi.runOwnedProcess({ toolPath: join(application.directory, "owned-process.exe"), args: ["owned prompt"], cwd: held.fixture.directory, env: { SystemRoot: process.env.SystemRoot, PROGRAMDATA: process.env.PROGRAMDATA, APICC_SOURCE_BRIDGE_MODE: "askpass", APICC_SOURCE_ASKPASS_FILE: file }, maxOutputBytes: 4096, signal: new AbortController().signal });
  expect(result.exitCode).toBe(0); expect(result.stdout.toString("hex")).toBe("efbbbf6f776e65642d626f6d2d736563726574");
});
it.runIf(process.platform === "win32")("C native SSH bridge preserves its actual stdout and stderr pipes", async () => {
  const config = join(held.fixture.directory, "stdio-config"); await writeFile(config, "Host *\n HostName 127.0.0.1\n Port 2222\n");
  const run = (args: string[]) => application.processApi.runOwnedProcess({ toolPath: join(application.directory, "owned-process.exe"), args, cwd: held.fixture.directory, env: { SystemRoot: process.env.SystemRoot, PROGRAMDATA: process.env.PROGRAMDATA, APICC_SOURCE_BRIDGE_MODE: "ssh", APICC_SOURCE_SSH_TOOL: "C:/Windows/System32/OpenSSH/ssh.exe", APICC_SOURCE_SSH_CONFIG: config }, maxOutputBytes: 512 * 1024, signal: new AbortController().signal });
  const configuration = await run(["-G", "owned.invalid"]); const invalid = await run(["-Z"]);
  expect({ stdoutHasPort: configuration.stdout.toString().includes("port 2222"), stderrPresent: invalid.stderr.length > 0 }).toEqual({ stdoutHasPort: true, stderrPresent: true });
});
it.runIf(process.platform === "win32").each(["missing", "oversized"])("C native askpass rejects %s private input without output", async scenario => {
  const file = join(held.fixture.directory, `native-askpass-${scenario}`); if (scenario === "oversized") await writeFile(file, "x".repeat(65537));
  const result = await application.processApi.runOwnedProcess({ toolPath: join(application.directory, "owned-process.exe"), args: ["owned prompt"], cwd: held.fixture.directory, env: { SystemRoot: process.env.SystemRoot, PROGRAMDATA: process.env.PROGRAMDATA, APICC_SOURCE_BRIDGE_MODE: "askpass", APICC_SOURCE_ASKPASS_FILE: file }, maxOutputBytes: 4096, signal: new AbortController().signal });
  expect({ exitCode: result.exitCode, stdoutBytes: result.stdout.length }).toEqual({ exitCode: 1, stdoutBytes: 0 });
});
it.runIf(process.platform === "win32").each(["ssh", "unknown"])("C native bridge refuses incomplete or unsupported %s mode without protocol output", async mode => {
  const result = await application.processApi.runOwnedProcess({ toolPath: join(application.directory, "owned-process.exe"), args: ["owned.git.test"], cwd: held.fixture.directory, env: { SystemRoot: process.env.SystemRoot, PROGRAMDATA: process.env.PROGRAMDATA, APICC_SOURCE_BRIDGE_MODE: mode }, maxOutputBytes: 4096, signal: new AbortController().signal });
  expect({ exitCode: result.exitCode, stdoutBytes: result.stdout.length }).toEqual({ exitCode: mode === "ssh" ? 255 : 1, stdoutBytes: 0 });
});
