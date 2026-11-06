import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, chmod, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { readBuildIdentity } from '@apicc/execution/buildIdentity';
import { SyncHeaderCredentialSchema } from '@apicc/execution/contract';
import { defaultSyncPolicyValues, resolveSyncPolicy, SyncPolicyValuesSchema, hash, loadSyncState, type SyncSource } from '@apicc/core/sync';
import type { SourceNetworkContext, SourceAddress } from '@apicc/execution/source-host';
import { openLocalSync } from './local.js';
import { atomicWriteFile } from '../atomicFile.js';
import type { LocalSyncDependencies, LocalSync } from './types.js';
import type { ProjectLocator } from '../../shared/locations.js';
import type { SyncHostSettings } from '../../shared/synchronization.js';
import type { createSession } from '../session.js';
import type { createDesktopCredentialHost } from '../credentials.js';

export interface SyncProviderOptions {
  session: ReturnType<typeof createSession>;
  credentials: ReturnType<typeof createDesktopCredentialHost>;
  privateRoot: string;
  confirmDestination(origin: string, addresses: readonly string[], locale?: 'zh-CN' | 'en'): Promise<boolean>;
  pickTool(tool: 'git' | 'ssh', locale?: 'zh-CN' | 'en'): Promise<string | null>;
}
const exec = promisify(execFile);
const fail = (code: string) => Object.assign(Error(code), { code });
const knownOwners = new Set<string>();
const nativeSettings = z.object({ revision: z.string().regex(/^(?:0|[1-9][0-9]*)$/), maxRedirects: z.number().int().min(0).max(20), policy: SyncPolicyValuesSchema, gitPath: z.string(), sshPath: z.string() }).strict();
const destination = (url: URL) => `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'ssh:' ? '22' : '80')}`;
const installed = async (path: string) => { try { return isAbsolute(path) && (await stat(path)).isFile(); } catch { return false; } };

/** Native owner follows the existing source runner's collection proof. Unknown
 * crash/retained markers fail closed, including after a policy rebind/restart. */
async function privateOwner(rootValue: string) {
  const root = resolve(rootValue); await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'read-'));
  try {
    if (process.platform === 'win32') {
      const system = process.env.SystemRoot ?? 'C:/Windows';
      const result = await exec(join(system, 'System32/whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000, maxBuffer: 8192 });
      const sid = result.stdout.match(/S-1-[0-9-]+/)?.[0]; if (!sid) throw fail('SYNC_HOST_CONFIG_INVALID');
      await exec(join(system, 'System32/icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true, timeout: 5000, maxBuffer: 8192 });
    } else await chmod(directory, 0o700);
  } catch { await rm(directory, { recursive: true, force: true }); throw fail('SYNC_HOST_CONFIG_INVALID'); }
  const marker = join(root, 'owner-' + randomUUID()); await writeFile(marker, directory, { flag: 'wx', mode: 0o600 }); knownOwners.add(marker);
  return { directory, async collect() {
    const child = relative(root, resolve(directory)); if (!child || child.startsWith('..') || isAbsolute(child)) throw fail('SYNC_PROCESS_UNCOLLECTED');
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }); await rm(marker); knownOwners.delete(marker);
  }, async retainUncollected() { knownOwners.delete(marker); } };
}

/** All I/O is lazy. Paths only originate in main's installed defaults/native
 * picker; imported source DTOs cannot choose tools or private storage. */
export function createDesktopSyncProviders(options: SyncProviderOptions) {
  const root = resolve(options.privateRoot), file = join(root, 'host-settings.json');
  const services = new Map<string, Promise<LocalSync>>(); let serviceEpoch = '';
  const defaults = () => ({ revision: '0', maxRedirects: 5, policy: { ...defaultSyncPolicyValues },
    gitPath: process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : '/usr/bin/git',
    sshPath: process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/OpenSSH/ssh.exe') : '/usr/bin/ssh' });
  async function settings() { try { return nativeSettings.parse(JSON.parse(await readFile(file, 'utf8'))); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults(); throw fail('SYNC_HOST_CONFIG_INVALID'); } }
  async function publicSettings(): Promise<SyncHostSettings> { const value = await settings(); return { revision: value.revision, maxRedirects: value.maxRedirects, policy: value.policy, git: await installed(value.gitPath) ? 'available' : 'missing', ssh: await installed(value.sshPath) ? 'available' : 'missing' }; }
  async function save(value: z.infer<typeof nativeSettings>) { await mkdir(root, { recursive: true, mode: 0o700 }); await atomicWriteFile(file, JSON.stringify({ ...value, revision: (BigInt(value.revision) + 1n).toString() })); services.clear(); return publicSettings(); }
  async function dependencies(locator: ProjectLocator, locale: 'zh-CN' | 'en' = 'zh-CN'): Promise<LocalSyncDependencies> {
    const context = options.session.captureDraftWriteContext(), config = await settings();
    const assertContext = () => { const current = options.session.captureDraftWriteContext(); if (current.root !== context.root || current.generation !== context.generation || !options.session.locateProject(locator)) throw fail('SYNC_CONTEXT_CHANGED'); };
    assertContext();
    try { for (const name of await readdir(root)) if (name.startsWith('owner-') && !knownOwners.has(join(root, name))) throw fail('SYNC_PROCESS_UNCOLLECTED'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    assertContext();
    const alive = (signal?: AbortSignal) => { assertContext(); if (signal?.aborted) throw fail('SYNC_CANCELLED'); };
    const providerResult = async <T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> => { try { return await pending; } finally { alive(signal); } };
    const captures = new Map<string, SourceNetworkContext & { addresses: readonly SourceAddress[]; hostname: string }>();
    const access = () => options.credentials.sourceAccess(locator);
    const capture = async (source: SyncSource, signal?: AbortSignal) => { alive(signal); const result = captures.get(source.id); if (!result) throw fail('SYNC_NETWORK_SNAPSHOT_INVALID'); return result; };
    return { session: options.session, policy: config.policy,
      readCoreBuildId: async () => (await providerResult(readBuildIdentity())).coreBuildId,
      async authorize(_projectId, signal) {
        alive(signal); const material = await providerResult(access(), signal);
        const state = await providerResult(loadSyncState(context.root!, locator), signal);
        const versions: string[][] = [];
        for (const entry of state?.sources ?? []) {
          const s = entry.source, refs = s.kind === 'git-ssh' ? [s.privateKeyRef, s.knownHostsRef, s.passphraseRef] : [s.authRef];
          for (const id of refs.filter((id): id is string => !!id)) { let version = 'missing'; try { version = await providerResult(material.secretStore.version(material.scope, { id, policy: 'test-auto' }), signal); } catch { alive(signal); } versions.push([id, version]); }
        }
        const network = await providerResult(material.host.store.load(material.host.scope), signal);
        for (const profile of network.configuration.profiles) {
          const refs = [...profile.targetTlsBindings.flatMap(b => [b.tls.clientPrivateKeyRef, b.tls.clientKeyPassphraseRef]), ...(profile.kind === 'proxy' ? [profile.passwordRef, profile.proxyTLS?.clientPrivateKeyRef, profile.proxyTLS?.clientKeyPassphraseRef] : [])];
          for (const ref of refs) if (ref) { let version = 'missing'; try { version = await providerResult(material.secretStore.version(material.scope, ref), signal); } catch { alive(signal); } versions.push([ref.id, version]); }
        }
        for (const entry of state?.sources ?? []) { try { const prepared = await providerResult(material.host.prepare({ ...(entry.source.networkProfileRef ? { selection: { kind: 'profile' as const, profileId: entry.source.networkProfileRef } } : {}), ...(signal ? { signal } : {}) }), signal); versions.push([entry.source.id, prepared.identity]); } catch { alive(signal); versions.push([entry.source.id, 'network-unavailable']); } }
        const current = await providerResult(settings(), signal);
        return { generation: BigInt('0x' + hash([current.revision, network.revision, versions.sort()])).toString(), actor: { id: 'local', name: 'Local user' } };
      },
      sourceHost: { maxRedirects: config.maxRedirects, git: { tools: { gitPath: config.gitPath, sshPath: config.sshPath }, createPrivateRead: async () => privateOwner(root) },
        captureNetwork: capture,
        captureSshRoute: async (source, signal) => { const result = await providerResult(capture(source, signal), signal); return { ...result, route: result.prepared.resolveForOrigin(new URL('https://' + new URL(source.repositoryUrl).host)).route }; },
        resolveAddresses: async (hostname, signal) => { alive(signal); for (const captured of captures.values()) if (captured.hostname === hostname) return captured.addresses; return []; },
      },
      async acquireMaterial(source, signal) {
        alive(signal);
        const material = await providerResult(access(), signal), url = new URL(source.kind === 'url' ? source.url : source.repositoryUrl), hostname = url.hostname.replace(/^\[|\]$/g, '');
        const family = isIP(hostname), addresses = family ? [{ address: hostname, family: family as 4 | 6 }] : await providerResult(lookup(hostname, { all: true, verbatim: true }), signal) as SourceAddress[];
        const prepared = await providerResult(material.host.prepare({ ...(source.networkProfileRef ? { selection: { kind: 'profile' as const, profileId: source.networkProfileRef } } : {}), signal }), signal);
        const versions: Record<string, string> = {};
        const secret = async (id: string) => { const ref = { id, policy: 'test-auto' as const }, version = await providerResult(material.secretStore.version(material.scope, ref), signal); versions[id] = version; const value = await providerResult(material.secretStore.resolve(material.scope, ref, version), signal); if (Buffer.byteLength(value) > 1048576) throw fail('SYNC_MATERIAL_INVALID'); return value; };
        let owner: Awaited<ReturnType<typeof privateOwner>> | undefined;
        try {
          let httpHeaders: { name: string; value: string }[] | undefined, ssh: { privateKeyPath: string; knownHostsPath: string; passphrase?: string } | undefined;
          if (source.kind !== 'git-ssh' && source.authRef) { try { httpHeaders = SyncHeaderCredentialSchema.parse(JSON.parse(await secret(source.authRef))).headers; } catch { alive(signal); throw fail('SYNC_MATERIAL_INVALID'); } }
          if (source.kind === 'git-ssh') {
            const key = await secret(source.privateKeyRef), hosts = await secret(source.knownHostsRef), passphrase = source.passphraseRef ? await secret(source.passphraseRef) : undefined;
            owner = await privateOwner(root); alive(signal); const privateKeyPath = join(owner.directory, 'private-key'), knownHostsPath = join(owner.directory, 'known-hosts');
            await providerResult(writeFile(privateKeyPath, key, { mode: 0o600 }), signal); await providerResult(writeFile(knownHostsPath, hosts, { mode: 0o600 }), signal); ssh = { privateKeyPath, knownHostsPath, ...(passphrase === undefined ? {} : { passphrase }) };
          }
          alive(signal);
          if (!addresses.length || !await providerResult(options.confirmDestination(destination(url), addresses.map(a => a.address), locale), signal)) throw fail('SYNC_DESTINATION_REJECTED');
          assertContext(); if (signal.aborted) throw fail('SYNC_CANCELLED');
          const identity = hash([source.id, source.revision, versions, prepared.identity]), approved = destination(url);
          captures.set(source.id, { prepared, policyIdentity: hash([approved, addresses]), materialIdentity: identity, addresses, hostname,
            approveDestination: (target, address) => destination(target) === approved && addresses.some(a => a.address === address.address && a.family === address.family) });
          return { leaseId: randomUUID(), ...(httpHeaders ? { httpHeaders } : {}), ...(ssh ? { ssh } : {}), async release() { captures.delete(source.id); await owner?.collect(); } };
        } catch (error) { if (owner) { try { await owner.collect(); } catch { await owner.retainUncollected(); throw fail('SYNC_MATERIAL_RELEASE_FAILED'); } } throw error; }
      },
    };
  }
  return { dependencies, settings: publicSettings,
    async materials(locator: ProjectLocator) {
      const access = await options.credentials.sourceAccess(locator), state = await loadSyncState(options.session.root!, locator), ids = new Set<string>();
      for (const entry of state?.sources ?? []) { const s = entry.source; for (const id of s.kind === 'git-ssh' ? [s.privateKeyRef, s.knownHostsRef, s.passphraseRef] : [s.authRef]) if (id) ids.add(id); }
      const result: import('../../shared/synchronization.js').SyncMaterialStatus[] = [];
      for (const refId of ids) { try { const status = await access.secretStore.status(access.scope, { id: refId, policy: 'test-auto' }); let version: string | null = null; if (status === 'available') version = await access.secretStore.version(access.scope, { id: refId, policy: 'test-auto' }); result.push({ refId, kind: 'credential', status, version }); } catch { result.push({ refId, kind: 'credential', status: 'unavailable', version: null }); } }
      const network = await access.host.store.load(access.host.scope); for (const profile of network.configuration.profiles) result.push({ refId: profile.id, kind: 'network-profile', status: 'registered', version: network.revision });
      return result;
    },
    async configureTool(tool: 'git' | 'ssh', locale?: 'zh-CN' | 'en') { const path = await options.pickTool(tool, locale); if (!path) return publicSettings(); if (!await installed(path)) throw fail('SYNC_TOOL_UNAVAILABLE'); const value = await settings(); return save({ ...value, [tool === 'git' ? 'gitPath' : 'sshPath']: path }); },
    async saveSettings(input: { maxRedirects: number; policy: typeof defaultSyncPolicyValues }) { const value = nativeSettings.parse({ ...await settings(), maxRedirects: input.maxRedirects, policy: input.policy }); resolveSyncPolicy({ formatVersion: 1, scope: 'workspace', revision: value.revision, ...value.policy }, { maxWireBytes: 64 * 1048576, envelopeReserveBytes: 0 }); return save(value); },
    async open(locator: ProjectLocator, locale: 'zh-CN' | 'en' = 'zh-CN') { const context = options.session.captureDraftWriteContext(), value = await settings(), key = JSON.stringify([context.root, context.generation, locator, value.revision, locale]); const epoch = JSON.stringify([context.root, context.generation, value.revision]); if (serviceEpoch !== epoch) { services.clear(); serviceEpoch = epoch; } let service = services.get(key); if (!service) { service = dependencies(locator, locale).then(deps => openLocalSync(context.root!, deps)); services.set(key, service); while (services.size > 32) services.delete(services.keys().next().value!); service.catch(() => services.delete(key)); } return service; },
  };
}
