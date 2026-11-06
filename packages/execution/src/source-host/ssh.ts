import type { SourceReadInput, SourceMaterialLease, SourceHostOptions } from "./types.js";
import type { PrivateSourceReadOwner } from "./process.js";
import type { GitSourceTransport } from "./git.js";
import { open, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { SourceHostError } from "./limits.js";
import { approvedAddress } from "./network.js";
import { resolveOwnedProcessHelper, sourceSshSettings } from "./tools.js";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const configQuote = (value: string) => '"' + (process.platform === "win32" ? value.replaceAll("\\", "/") : value.replaceAll("\\", "\\\\")).replaceAll('"', '\\"') + '"';
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** Host leases are bounded while copying; the lease's original files are never chmodded/deleted. */
async function materialBytes(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new SourceHostError("SYNC_MATERIAL_INVALID");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r"); const info = await handle.stat();
    if (!info.isFile() || info.size > 1048576) throw new Error();
    const bytes = Buffer.alloc(1048577); let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > 1048576) throw new Error(); return bytes.subarray(0, length);
  } catch { throw new SourceHostError("SYNC_MATERIAL_INVALID"); }
  finally { await handle?.close(); }
}
export async function prepareGitSshTransport(input: SourceReadInput, lease: SourceMaterialLease, options: SourceHostOptions, owner: PrivateSourceReadOwner, signal: AbortSignal): Promise<GitSourceTransport> {
  const source = input.source;
  if (source.kind !== "git-ssh" || !options.git) throw new SourceHostError("SYNC_INPUT_INVALID");
  if (!lease.ssh?.privateKeyPath || !lease.ssh.knownHostsPath || (source.passphraseRef && lease.ssh.passphrase === undefined)) throw new SourceHostError("SYNC_MATERIAL_MISSING");
  const passphrase = lease.ssh.passphrase ?? "";
  if (/[\r\n\0]/.test(passphrase) || Buffer.byteLength(passphrase) > 65536) throw new SourceHostError("SYNC_MATERIAL_INVALID");
  const key = await materialBytes(lease.ssh.privateKeyPath); const hosts = await materialBytes(lease.ssh.knownHostsPath);
  if (!options.captureSshRoute) throw new SourceHostError("SYNC_SSH_ROUTE_UNAVAILABLE");
  const context = await options.captureSshRoute(source, signal);
  if (context.route.kind !== "direct") throw new SourceHostError("SYNC_PROXY_UNSUPPORTED");
  const url = new URL(source.repositoryUrl); const address = await approvedAddress(url, context, options, signal);
  const hostname = url.hostname.replace(/^\[|\]$/g, ""); const port = Number(url.port || 22);
  const privateKey = join(owner.directory, "ssh-private-key"); const knownHosts = join(owner.directory, "ssh-known-hosts");
  const secretFile = join(owner.directory, "ssh-passphrase"); const configuration = join(owner.directory, "ssh-config");
  await writeFile(privateKey, key, { mode: 0o600 }); await writeFile(knownHosts, hosts, { mode: 0o600 }); await writeFile(secretFile, passphrase, { mode: 0o600 });
  const lines = ["Host *", ` HostName ${configQuote(address.address)}`, ` Port ${port}`, ` HostKeyAlias ${configQuote(port === 22 ? hostname : `[${hostname}]:${port}`)}`, ...(url.username ? [` User ${configQuote(url.username)}`] : []),
    ` IdentityFile ${configQuote(privateKey)}`, ` UserKnownHostsFile ${configQuote(knownHosts)}`, ` GlobalKnownHostsFile ${process.platform === "win32" ? "NUL" : "/dev/null"}`, " CheckHostIP no", ` ConnectTimeout ${Math.max(1, Math.floor(input.budget.connectTimeoutMs / 1000))}`,
    ...sourceSshSettings.map(([name, value]) => ` ${name} ${value}`), "",
  ];
  await writeFile(configuration, lines.join("\n"), { mode: 0o600 });
  let bridge: string; let askpass: string; let env: NodeJS.ProcessEnv;
  if (process.platform === "win32") {
    bridge = await resolveOwnedProcessHelper(import.meta.url); askpass = bridge;
    env = { APICC_SOURCE_BRIDGE_MODE: "ssh", APICC_SOURCE_SSH_TOOL: options.git.tools.sshPath!, APICC_SOURCE_SSH_CONFIG: configuration, APICC_SOURCE_ASKPASS_FILE: secretFile };
  } else {
    bridge = join(owner.directory, "ssh-bridge"); askpass = join(owner.directory, "ssh-askpass");
    await writeFile(bridge, `#!/bin/sh\nexec ${shellQuote(options.git.tools.sshPath!)} -F ${shellQuote(configuration)} "$@"\n`, { mode: 0o700 });
    await writeFile(askpass, `#!/bin/sh\nIFS= read -r value < ${shellQuote(secretFile)} || :\nprintf '%s' "$value"\n`, { mode: 0o700 }); env = {};
  }
  return {
    repositoryUrl: source.repositoryUrl,
    bindingIdentity: sha256(JSON.stringify(["apicc-git-ssh-source-v1", source, context.prepared.identity, context.policyIdentity, context.materialIdentity, sha256(key), sha256(hosts), passphrase])),
    configuration: '[protocol "ssh"]\n allow = always\n',
    env: { ...env, GIT_SSH: bridge, GIT_SSH_VARIANT: "ssh", SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "apicc:0" },
    classifyFailure(stderr) {
      const text = stderr.toString("utf8");
      if (/HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .+ host key is known/i.test(text)) return new SourceHostError("SYNC_HOST_KEY_MISMATCH");
      if (/timed out|Connection timeout/i.test(text)) return new SourceHostError("SYNC_CONNECT_TIMEOUT", true);
      if (/Permission denied|incorrect passphrase|bad passphrase|Load key|sign_and_send_pubkey/i.test(text)) return new SourceHostError("SYNC_SSH_AUTH_FAILED");
      return new SourceHostError("SYNC_GIT_READ_FAILED", /Connection refused|Connection reset/i.test(text));
    },
    async close() { /* Every SSH/bridge/askpass child belongs to its Git Job/process group. */ },
  };
}
