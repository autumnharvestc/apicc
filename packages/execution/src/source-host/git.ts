import type { SourceHostOptions, SourceReadInput, SourceReadResult, SourceMaterialLease } from "./types.js";
import { SourceReadInputSchema } from "@apicc/core/sync";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { runOwnedProcess, runPrivateSourceRead, type PrivateSourceReadOwner } from "./process.js";
import { probeSourceGitTools, sourceToolEnvironment } from "./tools.js";
import { SourceHostError, readLifetime } from "./limits.js";
import { approvedAddress, connectionTLS } from "./network.js";
import { sourceHeaders } from "./materials.js";
import { createGitHttpAdapter } from "./gitCredentials.js";
import { prepareGitSshTransport } from "./ssh.js";

export interface GitSourceTransport {
  readonly repositoryUrl: string;
  readonly bindingIdentity: string;
  readonly configuration: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly failureCode?: string;
  readonly failureStatus?: number;
  classifyFailure?(stderr: Buffer): SourceHostError;
  close(): Promise<void>;
}
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r") + '"';
const oidFormat = (oid: string): "sha1" | "sha256" => { if (/^[a-f0-9]{40}$/.test(oid)) return "sha1"; if (/^[a-f0-9]{64}$/.test(oid)) return "sha256"; throw new SourceHostError("SYNC_GIT_OBJECT_INVALID"); };

async function sampledBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    try { bytes += entry.isDirectory() ? await sampledBytes(path) : (await lstat(path)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return bytes;
}

async function httpsTransport(input: SourceReadInput, lease: SourceMaterialLease, options: SourceHostOptions, signal: AbortSignal): Promise<GitSourceTransport> {
  if (input.source.kind !== "git-https") throw new SourceHostError("SYNC_INPUT_INVALID");
  const url = new URL(input.source.repositoryUrl); const context = await options.captureNetwork(input.source, signal);
  const resolution = context.prepared.resolveForOrigin(url);
  if (resolution.route.kind !== "direct") throw new SourceHostError("SYNC_PROXY_UNSUPPORTED");
  const tls = connectionTLS(resolution, lease.tls); const address = await approvedAddress(url, context, options, signal);
  const token = randomBytes(32).toString("hex");
  const adapter = await createGitHttpAdapter({ repositoryUrl: url, address, targetTLS: tls, headers: sourceHeaders(input, lease), token, signal, connectTimeoutMs: input.budget.connectTimeoutMs, deadlineAtMs: input.deadlineAtMs, ...options.git?.adapterLimits });
  return {
    repositoryUrl: adapter.repositoryUrl, bindingIdentity: sha256(JSON.stringify(["apicc-git-source-v1", input.source, context.prepared.identity, context.policyIdentity, context.materialIdentity])),
    configuration: `[protocol "http"]\n allow = always\n[http]\n proxy =\n followRedirects = false\n version = HTTP/1.1\n maxRequests = 1\n extraHeader = ${quote("X-Apicc-Source-Token: " + token)}\n`,
    get failureCode() { return adapter.failureCode; }, get failureStatus() { return adapter.failureStatus; }, close: () => adapter.close(),
  };
}

async function readObjects(input: SourceReadInput, lease: SourceMaterialLease, options: SourceHostOptions, owner: PrivateSourceReadOwner, lifetime: ReturnType<typeof readLifetime>): Promise<SourceReadResult> {
  if (input.source.kind === "url" || !options.git) throw new SourceHostError("SYNC_INPUT_INVALID");
  const source = input.source; const tools = options.git.tools;
  const monitor = async () => { if (await sampledBytes(owner.directory) > input.budget.gitDiskThresholdBytes) throw new SourceHostError("SYNC_GIT_DISK_LIMIT"); };
  await monitor(); lifetime.check();
  await probeSourceGitTools(tools, lifetime.signal, source.kind, owner.directory); lifetime.check();
  const template = join(owner.directory, "empty-template"); await mkdir(template);
  const repository = join(owner.directory, "objects.git"); const config = join(owner.directory, "private-git-config");
  const baseConfig = `[core]\n hooksPath = ${quote(template)}\n[credential]\n helper =\n[protocol]\n allow = never\n[fetch]\n recurseSubmodules = false\n[transfer]\n fsckObjects = true\n`;
  let pinned: string | undefined; let format: "sha1" | "sha256" | undefined; let initialized = false;
  for (let attempt = 0; attempt < input.budget.maxAttempts; attempt++) {
    lifetime.check();
    const transport = source.kind === "git-https" ? await httpsTransport(input, lease, options, lifetime.signal) : await prepareGitSshTransport(input, lease, options, owner, lifetime.signal);
    try {
      await writeFile(config, baseConfig + transport.configuration, { mode: 0o600 });
      const env = { ...sourceToolEnvironment(tools, owner.directory), GIT_NO_REPLACE_OBJECTS: "1", GIT_LITERAL_PATHSPECS: "1", ...transport.env };
      const run = async (args: string[], cwd: string, failureCode = "SYNC_GIT_READ_FAILED", outputLimit = 512 * 1024, remote = false) => {
        lifetime.check();
        let result;
        try { result = await runOwnedProcess({ toolPath: tools.gitPath, args: ["-c", `include.path=${config}`, ...args], cwd, env, maxOutputBytes: outputLimit, signal: lifetime.signal, monitor }); }
        catch (error) { if ((error as { code?: string })?.code === "SYNC_PROCESS_UNCOLLECTED") throw error; lifetime.check(); if ((error as { code?: string })?.code === "SYNC_PROCESS_OUTPUT_LIMIT" && outputLimit === input.budget.maxSourceBytes) throw new SourceHostError("SYNC_SOURCE_TOO_LARGE"); throw error; }
        lifetime.check();
        if (result.exitCode) {
          if (remote && transport.classifyFailure) throw transport.classifyFailure(result.stderr);
          if (remote && transport.failureCode) throw new SourceHostError(transport.failureCode, transport.failureCode === "SYNC_READ_FAILED");
          if (remote && (transport.failureStatus === 401 || transport.failureStatus === 403)) throw new SourceHostError("SYNC_GIT_AUTH_FAILED");
          throw new SourceHostError(failureCode, remote && (transport.failureStatus === 408 || transport.failureStatus === 429 || (transport.failureStatus !== undefined && transport.failureStatus >= 500)));
        }
        return result.stdout;
      };
      if (!pinned) {
        if (/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(source.ref)) pinned = source.ref;
        else {
          const refs = (await run(["ls-remote", "--exit-code", ...(source.ref === "HEAD" ? [] : ["--refs"]), transport.repositoryUrl, source.ref], owner.directory, "SYNC_GIT_REF_NOT_FOUND", 512 * 1024, true)).toString().trim().split(/\r?\n/);
          if (refs.length !== 1 || !/^([a-f0-9]{40}|[a-f0-9]{64})\t\S+$/.test(refs[0]!)) throw new SourceHostError("SYNC_GIT_REF_NOT_FOUND");
          pinned = refs[0]!.split("\t")[0]!;
        }
        format = oidFormat(pinned);
      }
      if (!initialized) { await run(["init", "--bare", `--object-format=${format}`, `--template=${template}`, repository], owner.directory); initialized = true; }
      await run(["fetch", "--force", "--no-tags", "--no-recurse-submodules", "--no-auto-gc", "--depth=1", transport.repositoryUrl, pinned], repository, "SYNC_GIT_READ_FAILED", 512 * 1024, true);
      const commit = (await run(["rev-parse", "--verify", `${pinned}^{commit}`], repository, "SYNC_GIT_OBJECT_INVALID")).toString().trim();
      if (oidFormat(commit) !== format) throw new SourceHostError("SYNC_GIT_OBJECT_INVALID");
      const tree = await run(["ls-tree", "-z", commit, "--", source.filePath], repository, "SYNC_GIT_OBJECT_INVALID");
      if (!tree.length) throw new SourceHostError("SYNC_GIT_PATH_NOT_FOUND");
      const entries = tree.toString("utf8").split("\0"); const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entries[0]!);
      if (entries.length !== 2 || entries[1] !== "" || !match || match[3] !== source.filePath || oidFormat(match[2]!) !== format) throw new SourceHostError("SYNC_GIT_OBJECT_INVALID");
      const blob = match[2]!;
      const size = (await run(["cat-file", "-s", blob], repository, "SYNC_GIT_OBJECT_INVALID")).toString().trim();
      if (!/^\d+$/.test(size)) throw new SourceHostError("SYNC_GIT_OBJECT_INVALID");
      if (BigInt(size) > BigInt(input.budget.maxSourceBytes)) throw new SourceHostError("SYNC_SOURCE_TOO_LARGE");
      const bytes = await run(["cat-file", "blob", blob], repository, "SYNC_GIT_OBJECT_INVALID", input.budget.maxSourceBytes);
      let rawText: string; try { rawText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new SourceHostError("SYNC_ENCODING_INVALID"); }
      if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(rawText)) throw new SourceHostError("SYNC_GIT_LFS_UNSUPPORTED");
      const upstream = format === "sha1" ? { kind: "git" as const, objectFormat: "sha1" as const, commitOid: commit, blobOid: blob, rawSha256: sha256(bytes) } : { kind: "git" as const, objectFormat: "sha256" as const, commitOid: commit, blobOid: blob, rawSha256: sha256(bytes) };
      await monitor(); lifetime.check(); await options.onContent?.(Object.freeze({ rawText, upstream: Object.freeze({ ...upstream }), bindingIdentity: transport.bindingIdentity }), lifetime.signal); lifetime.check();
      return { formatVersion: 1, status: "read", upstream, rawText, diagnostics: [] };
    } catch (error) {
      if ((error as { code?: string })?.code === "SYNC_PROCESS_UNCOLLECTED") throw error;
      lifetime.check(); if (!(error instanceof SourceHostError && error.retryable) || attempt + 1 >= input.budget.maxAttempts) throw error;
    } finally { await transport.close(); }
  }
  throw new SourceHostError("SYNC_GIT_READ_FAILED");
}

/** Every Git outcome collects the owned tree/material before its one lease release. */
export async function readGitSource(rawInput: SourceReadInput, lease: SourceMaterialLease, signal: AbortSignal | undefined, options: SourceHostOptions): Promise<SourceReadResult> {
  let lifetime: ReturnType<typeof readLifetime> | undefined; let handedOff = false;
  try {
    const parsed = SourceReadInputSchema.safeParse(rawInput);
    if (!parsed.success || parsed.data.source.kind === "url") throw new SourceHostError("SYNC_INPUT_INVALID");
    const input = parsed.data; lifetime = readLifetime(input.deadlineAtMs, signal); lifetime.check();
    if (!options.git) throw new SourceHostError("SYNC_GIT_UNAVAILABLE");
    const headers = sourceHeaders(input, lease);
    if (input.source.kind === "git-https" && input.source.authRef && !lease.httpHeaders?.length) throw new SourceHostError("SYNC_MATERIAL_MISSING");
    if (Object.hasOwn(headers, "x-apicc-source-token")) throw new SourceHostError("SYNC_MATERIAL_INVALID");
    const owner = await options.git.createPrivateRead(lifetime.signal); handedOff = true;
    const result = await runPrivateSourceRead(owner, lease, () => readObjects(input, lease, options, owner, lifetime!)); lifetime.check(); return result;
  } catch (error) {
    if ((error as { code?: string })?.code === "SYNC_PROCESS_UNCOLLECTED" || (error as { code?: string })?.code === "SYNC_MATERIAL_RELEASE_FAILED") throw error;
    lifetime?.check(); if (error instanceof SourceHostError) throw error; throw new SourceHostError("SYNC_GIT_READ_FAILED");
  } finally {
    try { if (!handedOff) { try { await lease.release(); } catch { throw new SourceHostError("SYNC_MATERIAL_RELEASE_FAILED"); } lifetime?.check(); } }
    finally { lifetime?.dispose(); }
  }
}
