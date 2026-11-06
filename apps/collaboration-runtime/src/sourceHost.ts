import { createSourceHost, type SourceHostOptions, type SourceCacheEntry } from "@apicc/execution/source-host";
import { syncErrorCodeValues } from "@apicc/execution/contract";
import { prepareNetworkRun, type NetworkConfiguration, type NetworkTLSSettings, type SecretStore, type PreparedNetworkRun } from "@apicc/core";
import type { SyncCandidate, SyncPlanInput, SourceMaterialLease } from "@apicc/core/sync";
import type { SyncReadPayload, SyncReadOutput } from "./protocol.js";
export type { SyncReadPayload, SyncReadOutput, SyncPlanPayload } from "./protocol.js";
import { mkdtemp, rm, chmod, lstat, mkdir, readdir, writeFile, realpath, stat, open, type FileHandle } from "node:fs/promises";
import { resolve, join, isAbsolute, relative } from "node:path";
import { BlockList, isIP } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { z } from "zod";

export interface SyncPlanOutput { candidate: SyncCandidate; planInput: SyncPlanInput }
export type SyncNetworkTLS = Extract<SyncReadPayload["network"], { kind: "profile" }>["profile"]["targetTlsBindings"][number]["tls"];
export interface PrivateReadOwner { directory: string; collect(): Promise<void>; retainUncollected(): Promise<void> }
export interface RuntimeSourceOptions {
  privateRoot: string; tools?: { gitPath: string; sshPath?: string };
  allowedOrigins: string[]; allowedCidrs: string[]; maxRedirects?: number;
  maxConcurrency?: number; maxProjectConcurrency?: number; cacheBytes?: number;
  maxTrackedSources?: number; maxGenerationBytes?: number;
  createPrivateRead?: (signal: AbortSignal) => Promise<PrivateReadOwner>;
  /** Trusted host capture; administrator destination approval is always composed with it. */
  captureNetwork?: SourceHostOptions["captureNetwork"];
}
export const SourceDeploymentSchema = z.object({
  privateRoot: z.string(), tools: z.object({ gitPath: z.string(), sshPath: z.string().optional() }).strict().optional(),
  allowedOrigins: z.array(z.string()), allowedCidrs: z.array(z.string()), maxRedirects: z.number().int().min(0).max(20).optional(),
  maxConcurrency: z.number().int().min(1).max(16).optional(), maxProjectConcurrency: z.number().int().min(1).max(4).optional(),
  cacheBytes: z.number().int().min(0).max(64 * 1048576).optional(),
  maxTrackedSources: z.number().int().min(1).max(65536).optional(), maxGenerationBytes: z.number().int().min(1024).max(64 * 1048576).optional(),
}).strict();
const exec = promisify(execFile);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (code: string) => Object.assign(new Error(code), { code });
const certificateFileBytes = 1048576, certificateTotalBytes = 4 * 1048576;
function bundles(values: readonly string[]): string[] {
  const result: string[] = []; let current = "";
  for (const value of values) {
    if (Buffer.byteLength(value) > certificateFileBytes) throw failure("SYNC_MATERIAL_INVALID");
    const joined = current ? current + "\n" + value : value;
    if (Buffer.byteLength(joined) > certificateFileBytes) { result.push(current); current = value; } else current = joined;
  }
  if (current) result.push(current); return result;
}
/** Early native-staging bound; Core's actual prepare remains the final TLS authority. */
export function preflightSourceTLS(bindings: readonly SyncNetworkTLS[]): void {
  let bytes = 0;
  for (const tls of bindings) for (const group of [tls.caPems, tls.clientCertPems]) for (const bundle of bundles(group)) bytes += Buffer.byteLength(bundle);
  if (bytes > certificateTotalBytes) throw failure("SYNC_MATERIAL_INVALID");
  const pattern = /-----BEGIN CERTIFICATE-----\s*[\s\S]*?\s*-----END CERTIFICATE-----/g;
  try { for (const tls of bindings) for (const pem of [...tls.caPems, ...tls.clientCertPems]) {
    const blocks = [...pem.matchAll(pattern)];
    if (!blocks.length || pem.replace(pattern, "").trim()) throw Error();
    for (const block of blocks) new X509Certificate(block[0]);
  } } catch { throw failure("SYNC_MATERIAL_INVALID"); }
}

interface Occupancy { project: string; provider: symbol; retained: boolean; controller: AbortController; owner?: PrivateReadOwner }
interface Generation { revision: string; authorization: string; bytes: number }
interface RootCoordinator { rootHandle: FileHandle; providers: number; slots: Map<string, Occupancy>; generations: Map<string, Generation>; generationBytes: number }
const coordinators = new Map<string, RootCoordinator>();
const compareRevision = (left: string, right: string) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);

async function preparedSnapshot(payload: SyncReadPayload, root: string, owner: PrivateReadOwner, signal: AbortSignal): Promise<PreparedNetworkRun> {
  const network = payload.network, values = new Map<string, string>(); let index = 0;
  const secret = (value: string) => { const id = "private-network-" + index++; values.set(id, value); return { id, policy: "test-auto" as const }; };
  let configuration: NetworkConfiguration = { formatVersion: 1, profiles: [], environmentSelections: [] };
  if (network.kind === "profile") {
    const profile = network.profile;
    const allTLS = [...profile.targetTlsBindings.map(binding => binding.tls), ...(profile.kind === "proxy" && profile.proxyTLS ? [profile.proxyTLS] : [])];
    preflightSourceTLS(allTLS);
    const stage = async (tls: SyncNetworkTLS): Promise<NetworkTLSSettings> => {
      const files = async (pems: string[]) => { const paths: string[] = []; for (const text of bundles(pems)) {
        if (signal.aborted) throw failure("SYNC_CANCELLED");
        const path = join(owner.directory, "network-cert-" + index++ + ".pem"); await writeFile(path, text, { mode: 0o600, flag: "wx" }); paths.push(path);
      } return paths; };
      return { caCertificatePaths: await files(tls.caPems), clientCertificatePaths: await files(tls.clientCertPems),
        ...(tls.clientKeyPem === undefined ? {} : { clientPrivateKeyRef: secret(tls.clientKeyPem) }), ...(tls.clientKeyPassphrase === undefined ? {} : { clientKeyPassphraseRef: secret(tls.clientKeyPassphrase) }) };
    };
    const targetTlsBindings = [];
    for (const binding of profile.targetTlsBindings) targetTlsBindings.push({ origin: binding.origin, tls: await stage(binding.tls) });
    configuration = { ...configuration, profiles: [{ id: profile.id, name: profile.name, targetTlsBindings,
      ...(profile.kind === "direct" ? { kind: "direct" as const } : { kind: "proxy" as const, proxyUrl: profile.proxyUrl,
        ...(profile.username === undefined ? {} : { username: profile.username }), ...(profile.password === undefined ? {} : { passwordRef: secret(profile.password) }), ...(profile.proxyTLS ? { proxyTLS: await stage(profile.proxyTLS) } : {}) }) }] };
  }
  const unavailable = async () => { throw failure("SYNC_NETWORK_SNAPSHOT_INVALID"); };
  const secretStore: SecretStore = { put: unavailable, remove: unavailable, status: async (_scope, ref) => values.has(ref.id) ? "available" : "missing",
    version: async (_scope, ref) => { if (!values.has(ref.id)) throw failure("SYNC_NETWORK_SNAPSHOT_INVALID"); return payload.material.identity; },
    resolve: async (_scope, ref, version) => { if (version !== payload.material.identity || !values.has(ref.id)) throw failure("SYNC_NETWORK_SNAPSHOT_INVALID"); return values.get(ref.id)!; } };
  try { return await prepareNetworkRun({ scope: { canonicalRoot: root, project: { workspaceId: payload.context.workspaceId, groupId: "0", projectId: payload.context.projectId } },
    store: { load: async () => ({ revision: network.revision, configuration }), save: unavailable }, secretStore,
    selection: network.kind === "direct" ? { kind: "direct" } : { kind: "profile", profileId: network.profile.id }, signal }); }
  catch (error) { if (signal.aborted) throw failure("SYNC_CANCELLED"); if (syncErrorCodes.has((error as { code: string }).code)) throw error; throw failure("SYNC_NETWORK_SNAPSHOT_INVALID"); }
}

/** Only application-allocated children of an absolute deployment root are deleted. */
export async function createPrivateReadOwner(privateRoot: string): Promise<PrivateReadOwner> {
  const root = resolve(privateRoot), directory = await mkdtemp(join(root, "read-"));
  try {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? "C:/Windows";
      const identity = await exec(join(systemRoot, "System32/whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 5000, maxBuffer: 8192 });
      const sid = identity.stdout.match(/S-1-[0-9-]+/)?.[0];
      if (!sid) throw failure("SYNC_HOST_CONFIG_INVALID");
      await exec(join(systemRoot, "System32/icacls.exe"), [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { windowsHide: true, timeout: 5000, maxBuffer: 8192 });
    } else await chmod(directory, 0o700);
  } catch { await rm(directory, { recursive: true, force: true }); throw failure("SYNC_HOST_CONFIG_INVALID"); }
  const collect = async () => {
    const child = relative(root, resolve(directory));
    if (!child || child.startsWith("..") || isAbsolute(child)) throw failure("SYNC_PROCESS_UNCOLLECTED");
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
  };
  return { directory, collect, retainUncollected: async () => undefined };
}

function destinationOrigin(url: URL) { return url.protocol === "ssh:" ? `ssh://${url.hostname}:${url.port || "22"}` : url.origin; }
function approval(options: RuntimeSourceOptions) {
  const origins = new Set<string>(), ranges = new BlockList();
  try {
    for (const value of options.allowedOrigins) {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash || !["http:", "https:", "ssh:"].includes(url.protocol) || !["", "/"].includes(url.pathname)) throw Error();
      origins.add(destinationOrigin(url));
    }
    for (const value of options.allowedCidrs) {
      const parts = value.split("/"), family = isIP(parts[0]!); const prefix = Number(parts[1]);
      if (parts.length !== 2 || !family || !/^\d+$/.test(parts[1]!) || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw Error();
      ranges.addSubnet(parts[0]!, prefix, family === 4 ? "ipv4" : "ipv6");
    }
  } catch { throw failure("SYNC_HOST_CONFIG_INVALID"); }
  return { identity: hash([options.allowedOrigins, options.allowedCidrs]), allows: (url: URL, address: { address: string; family: 4 | 6 }) => origins.has(destinationOrigin(url)) && ranges.check(address.address, address.family === 4 ? "ipv4" : "ipv6") };
}

/** One private provider per runtime. No source material or native path is public state. */
export async function createRuntimeSourceHost(options: RuntimeSourceOptions) {
  if (!isAbsolute(options.privateRoot)) throw failure("SYNC_HOST_CONFIG_INVALID");
  try { const info = await lstat(options.privateRoot); if (!info.isDirectory() || info.isSymbolicLink()) throw Error(); }
  catch { throw failure("SYNC_HOST_CONFIG_INVALID"); }
  const chosen = SourceDeploymentSchema.safeParse(Object.fromEntries(Object.entries(options).filter(([key]) => !["createPrivateRead", "captureNetwork"].includes(key))));
  if (!chosen.success) throw failure("SYNC_HOST_CONFIG_INVALID");
  const root = await realpath(options.privateRoot), physicalRoot = await stat(root, { bigint: true });
  const rootKey = hash([physicalRoot.dev.toString(), physicalRoot.ino.toString()]);
  const currentApproval = approval(options), markers = join(root, ".apicc-sync-owners");
  let candidateRoot: FileHandle | undefined = await open(root, "r"), state: RootCoordinator;
  try {
    const heldRoot = await candidateRoot.stat({ bigint: true });
    if (!heldRoot.isDirectory() || heldRoot.dev !== physicalRoot.dev || heldRoot.ino !== physicalRoot.ino) throw failure("SYNC_HOST_CONFIG_INVALID");
    let coordinator = coordinators.get(rootKey);
    if (!coordinator) {
      let hasMarkers = false;
      try { hasMarkers = (await readdir(markers)).length > 0; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Another initializer may have published while the real directory scan ran.
      // Acquiring the final state and its provider reference has no intervening await.
      coordinator = coordinators.get(rootKey);
      if (!coordinator) {
        if (hasMarkers) throw failure("SYNC_PROCESS_UNCOLLECTED");
        // Pin the physical directory while its ownership is known. External removal
        // must not let a new directory reuse this retained coordinator's dev+ino.
        coordinator = { rootHandle: candidateRoot, providers: 0, slots: new Map(), generations: new Map(), generationBytes: 0 }; coordinators.set(rootKey, coordinator);
        candidateRoot = undefined;
      }
    }
    if ([...coordinator.slots.values()].some(slot => slot.retained)) throw failure("SYNC_PROCESS_UNCOLLECTED");
    state = coordinator; state.providers++;
  } finally { await candidateRoot?.close(); }
  const maxConcurrency = options.maxConcurrency ?? 4, maxProjectConcurrency = options.maxProjectConcurrency ?? 1;
  const maxTrackedSources = options.maxTrackedSources ?? 4096, maxGenerationBytes = options.maxGenerationBytes ?? 2 * 1048576;
  const cache = new Map<string, { entry: SourceCacheEntry; bytes: number }>(); let cacheBytes = 0;
  const maxCacheBytes = options.cacheBytes ?? 8 * 1048576;
  let closed = false; const provider = Symbol("private-source-provider");
  return { capacity: () => ({ held: state.slots.size, retained: [...state.slots.values()].filter(slot => slot.retained).length }),
    close: async () => {
      for (const slot of state.slots.values()) if (slot.provider === provider) slot.controller.abort();
      if (!closed) { closed = true; state.providers--; }
      if ([...state.slots.values()].some(slot => slot.provider === provider)) throw failure("SYNC_PROCESS_UNCOLLECTED");
      if (!state.providers && !state.slots.size && coordinators.get(rootKey) === state) { coordinators.delete(rootKey); await state.rootHandle.close(); }
      cache.clear(); cacheBytes = 0;
    }, async readSource(payload: SyncReadPayload, signal?: AbortSignal): Promise<SyncReadOutput> {
    if (payload.context.sourceRevision !== payload.input.source.revision) throw failure("SYNC_CONTEXT_STALE");
    const selectedRef = payload.network.kind === "profile" ? payload.network.profile.id : undefined;
    if (payload.input.source.networkProfileRef !== selectedRef) throw failure("SYNC_NETWORK_SNAPSHOT_INVALID");
    const key = hash([payload.context.workspaceId, payload.context.projectId, payload.input.source.id]), project = hash([payload.context.workspaceId, payload.context.projectId]);
    const prior = state.generations.get(key), generation = { revision: payload.context.sourceRevision, authorization: payload.context.authorizationGeneration, bytes: Buffer.byteLength(key + payload.context.sourceRevision + payload.context.authorizationGeneration) };
    if (prior && (compareRevision(generation.revision, prior.revision) < 0 || compareRevision(generation.authorization, prior.authorization) < 0)) throw failure("SYNC_CONTEXT_STALE");
    if ((!prior && state.generations.size >= maxTrackedSources) || state.generationBytes - (prior?.bytes ?? 0) + generation.bytes > maxGenerationBytes) throw failure("SYNC_BUSY");
    state.generationBytes += generation.bytes - (prior?.bytes ?? 0); state.generations.set(key, generation);
    if (closed || state.slots.has(key) || state.slots.size >= Math.min(maxConcurrency, payload.context.hostConcurrency)
      || [...state.slots.values()].filter(slot => slot.project === project).length >= Math.min(maxProjectConcurrency, payload.context.projectConcurrency)) throw failure("SYNC_BUSY");
    const controller = new AbortController(), cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    const occupancy: Occupancy = { project, provider, retained: false, controller }; state.slots.set(key, occupancy);
    const marker = join(markers, randomUUID() + ".json"); let markerWritten = false, released = false, collected = false;
    let ownerPromise: Promise<PrivateReadOwner> | undefined;
    let lease: SourceMaterialLease;
    const retain = async () => {
      if (occupancy.retained) return; occupancy.retained = true;
      try { if (markerWritten) await writeFile(marker, JSON.stringify({ formatVersion: 1, status: "uncollected" })); } catch { /* Existing active marker remains fail-closed. */ }
    };
    const ensureOwner = (ownedSignal: AbortSignal): Promise<PrivateReadOwner> => ownerPromise ??= (async () => {
      let actual: PrivateReadOwner;
      try { actual = await (options.createPrivateRead ? options.createPrivateRead(AbortSignal.any([ownedSignal, controller.signal])) : createPrivateReadOwner(root)); }
      catch { await retain(); throw failure("SYNC_PROCESS_UNCOLLECTED"); }
      const owner: PrivateReadOwner = { directory: actual.directory,
        collect: async () => { if (collected) return; try { await actual.collect(); collected = true; } catch { await retain(); throw failure("SYNC_PROCESS_UNCOLLECTED"); } },
        retainUncollected: async () => { await retain(); await actual.retainUncollected(); } };
      occupancy.owner = owner;
      if (payload.material.ssh) {
        const privateKeyPath = join(owner.directory, "material-key"), knownHostsPath = join(owner.directory, "material-hosts");
        await writeFile(privateKeyPath, payload.material.ssh.privateKeyPem, { mode: 0o600, flag: "wx" });
        await writeFile(knownHostsPath, payload.material.ssh.knownHostsText, { mode: 0o600, flag: "wx" });
        (lease as { ssh?: SourceMaterialLease["ssh"] }).ssh = { privateKeyPath, knownHostsPath, ...(payload.material.ssh.passphrase === undefined ? {} : { passphrase: payload.material.ssh.passphrase }) };
      }
      return owner;
    })();
    lease = { leaseId: payload.material.leaseId, httpHeaders: payload.material.httpHeaders, tls: payload.material.tls, release: async () => {
      if (released) return;
      if (occupancy.retained) throw failure("SYNC_PROCESS_UNCOLLECTED");
      if (ownerPromise) await (await ownerPromise).collect();
      try { if (markerWritten) await rm(marker); } catch { await retain(); throw failure("SYNC_PROCESS_UNCOLLECTED"); }
      released = true; state.slots.delete(key);
    } };
    try {
      await mkdir(markers, { recursive: true, mode: 0o700 });
      if ((await lstat(markers)).isSymbolicLink()) throw failure("SYNC_HOST_CONFIG_INVALID");
      await writeFile(marker, JSON.stringify({ formatVersion: 1, status: "active" }), { flag: "wx", mode: 0o600 }); markerWritten = true;
      const scope = hash([payload.context.workspaceId, payload.context.projectId, payload.input.source.id, payload.context.sourceRevision, payload.context.authorizationGeneration]);
      let content: { rawText: string } | undefined;
      const captureNetwork: SourceHostOptions["captureNetwork"] = async (source, ownedSignal) => {
        const owner = await ensureOwner(ownedSignal);
        const captured = options.captureNetwork ? await options.captureNetwork(source, ownedSignal) : await (async () => {
          const prepared = await preparedSnapshot(payload, root, owner, ownedSignal);
          return { prepared, policyIdentity: currentApproval.identity, materialIdentity: payload.material.identity, approveDestination: currentApproval.allows };
        })();
        return { ...captured, policyIdentity: hash([captured.policyIdentity, currentApproval.identity]),
          approveDestination: (url, address) => currentApproval.allows(url, address) && captured.approveDestination(url, address) };
      };
      const host = createSourceHost({ captureNetwork, maxRedirects: options.maxRedirects,
        ...(options.tools ? { git: { tools: options.tools, createPrivateRead: ensureOwner } } : {}),
        captureSshRoute: async (source, ownedSignal) => { const captured = await captureNetwork(source, ownedSignal); const profile = payload.network.kind === "profile" ? payload.network.profile : undefined;
          return { ...captured, route: profile?.kind === "proxy" ? { kind: "proxy", url: profile.proxyUrl, ...(profile.username === undefined ? {} : { username: profile.username }), ...(profile.password === undefined ? {} : { password: profile.password }) } : { kind: "direct" } }; },
        cache: {
          get: async binding => cache.get(scope + ":" + binding)?.entry,
          put: async entry => {
            const key = scope + ":" + entry.binding, bytes = Buffer.byteLength(JSON.stringify(entry));
            const previous = cache.get(key); if (previous) { cacheBytes -= previous.bytes; cache.delete(key); }
            if (bytes > maxCacheBytes) return;
            while (cacheBytes + bytes > maxCacheBytes && cache.size) { const first = cache.keys().next().value!; cacheBytes -= cache.get(first)!.bytes; cache.delete(first); }
            cache.set(key, { entry, bytes }); cacheBytes += bytes;
          },
        }, onContent: async value => { content = value; } });
      const result = await host.readSource(payload.input, lease, controller.signal);
      const latest = state.generations.get(key)!;
      if (latest.revision !== generation.revision || latest.authorization !== generation.authorization) throw failure("SYNC_CONTEXT_STALE");
      if (!content) throw failure("SYNC_CONTENT_HANDOFF_FAILED");
      return { ...result, rawText: content.rawText };
    } catch (error) {
      if (occupancy.retained) throw failure("SYNC_PROCESS_UNCOLLECTED");
      try { await lease.release(); } catch { await retain(); throw failure("SYNC_PROCESS_UNCOLLECTED"); }
      throw error;
    } finally { signal?.removeEventListener("abort", cancel); }
  } };
}

/** Exact codes only; native messages/paths and arbitrary exception text never enter the envelope. */
export const syncErrorCodes = new Set<string>(syncErrorCodeValues);
