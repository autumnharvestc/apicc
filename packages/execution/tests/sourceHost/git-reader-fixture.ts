import { prepareNetworkRun } from "@apicc/core";
import { SourceReadInputSchema } from "@apicc/core/sync";
import type { SourceHostOptions, SourceMaterialLease, SourceReadInput } from "../../src/source-host/types.js";
import { mkdtemp, mkdir, rm, access, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitSourceFixture } from "./git-fixture.mjs";
import type { installGitApplication } from "./git-application.js";
const exec = promisify(execFile);
export const gitTools = process.platform === "win32" ? { gitPath: "D:/env/Git/cmd/git.exe", sshPath: "C:/Windows/System32/OpenSSH/ssh.exe" } : { gitPath: "/usr/bin/git", sshPath: "/usr/bin/ssh" };
export function prepareGitFixtureNetwork(f: GitSourceFixture, proxy = false) {
  return prepareNetworkRun({ scope: { canonicalRoot: f.directory, project: { workspaceId: "owned", groupId: "owned", projectId: "owned" } }, store: { load: async () => ({ revision: "1", configuration: { formatVersion: 1, profiles: proxy ? [{ id: "owned-proxy", name: "Owned proxy", kind: "proxy" as const, proxyUrl: "http://127.0.0.1:1", targetTlsBindings: [] }] : [], environmentSelections: [] } }), save: async () => "1" }, secretStore: {} as never, selection: proxy ? { kind: "profile", profileId: "owned-proxy" } : { kind: "direct" } });
}
export async function gitReaderFixture(f: GitSourceFixture, application: Awaited<ReturnType<typeof installGitApplication>>) {
  const prepared = await prepareGitFixtureNetwork(f);
  let released = 0; let retained = 0; let captures = 0; let sshCaptures = 0; let content = 0;
  const directories: string[] = []; const releases: { exists: boolean; retained: number }[] = [];
  const options: SourceHostOptions = {
    git: { tools: gitTools, createPrivateRead: async () => {
      const directory = await mkdtemp(join(f.directory, "read-")); directories.push(directory);
      if (process.platform === "win32") { const sid = (await exec("C:/Windows/System32/whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true })).stdout.trim().split(",")[1].replaceAll('"', ""); await exec("C:/Windows/System32/icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { windowsHide: true }); }
      return { directory, collect: () => rm(directory, { recursive: true, force: true }), retainUncollected: async () => { retained++; } };
    } },
    captureNetwork: async () => { captures++; return { prepared, policyIdentity: "owned-policy-v1", materialIdentity: "owned-material-v1", approveDestination: () => true }; },
    captureSshRoute: async () => { sshCaptures++; return { prepared, policyIdentity: "owned-policy-v1", materialIdentity: "owned-material-v1", route: { kind: "direct" }, approveDestination: () => true }; },
    resolveAddresses: async () => [{ address: f.address, family: 4 }],
    onContent: async () => { content++; },
  };
  const input = (kind: "git-https" | "git-ssh" = "git-https", changes: Record<string, unknown> = {}): SourceReadInput => SourceReadInputSchema.parse({ formatVersion: 1, source: { formatVersion: 1, id: "00000000-0000-4000-8000-000000000001", revision: "1", moduleId: "00000000-0000-4000-8000-000000000002", kind, repositoryUrl: kind === "git-https" ? f.httpsUrl : f.sshUrl, ref: "refs/heads/main", filePath: "openapi.yaml", ...(kind === "git-https" ? { authRef: "owned-http-material" } : { privateKeyRef: "owned-key", knownHostsRef: "owned-host", passphraseRef: "owned-passphrase" }), ...changes }, deadlineAtMs: Date.now() + 30000, budget: { connectTimeoutMs: 1000, maxAttempts: 1, maxSourceBytes: 65536, gitDiskThresholdBytes: 33554432 } });
  const read = (value: SourceReadInput, optionChanges: Partial<SourceHostOptions> = {}, materialChanges: Partial<SourceMaterialLease> = {}, signal?: AbortSignal) => application.api.createSourceHost({ ...options, ...optionChanges }).readSource(value, { leaseId: "owned-material-lease", httpHeaders: [{ name: "Authorization", value: "Basic b3duZWQ6c3ludGhldGlj" }], tls: { caPem: f.caPem }, ssh: { privateKeyPath: f.privateKeyPath, knownHostsPath: f.knownHostsPath, passphrase: f.passphrase }, ...materialChanges, release: async () => { const exists = directories.length ? await access(directories.at(-1)!).then(() => true, () => false) : false; releases.push({ exists, retained }); released++; await materialChanges.release?.(); } }, signal);
  return { options, input, read, prepared, directories, releases, released: () => released, retained: () => retained, captures: () => captures, sshCaptures: () => sshCaptures, contentsDelivered: () => content };
}
