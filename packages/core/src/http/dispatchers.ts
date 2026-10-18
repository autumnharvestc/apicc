import { createHash } from "node:crypto";
import type { LookupFunction } from "node:net";
import * as tls from "node:tls";
import { Agent, ProxyAgent } from "undici";
import type { Dispatcher } from "undici";
import type { PreparedNetworkResolution, PreparedNetworkTLS } from "../network/prepare.js";

const MAX_IDLE_DISPATCHERS = 16;

export interface HttpDispatcherSettings {
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface HttpDispatcherConfiguration {
  origin: string;
  networkRevision?: string;
  credentialVersions: Readonly<Record<string, string>>;
  settings: HttpDispatcherSettings;
  resolution: PreparedNetworkResolution;
  lookup?: LookupFunction;
}

export type HttpDispatcherFactory = (configuration: HttpDispatcherConfiguration) => Dispatcher;

export interface HttpDispatcherLease {
  readonly dispatcher: Dispatcher;
  release(options?: { destroy?: boolean; reason?: Error }): Promise<void>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tlsIdentity(value: PreparedNetworkTLS | undefined): unknown {
  if (value === undefined) return undefined;
  return {
    verify: value.verify,
    caMode: value.caMode,
    caCertificates: [...tls.getCACertificates("default"), ...value.caCertificates].map(digest),
    clientCertificates: value.clientCertificates.map(digest),
    clientPrivateKey: value.clientPrivateKey === undefined ? undefined : digest(value.clientPrivateKey),
    clientKeyPassphrase: value.clientKeyPassphrase === undefined ? undefined : digest(value.clientKeyPassphrase),
  };
}

export function httpDispatcherIdentity(configuration: HttpDispatcherConfiguration): string {
  const route = configuration.resolution.route;
  const identity = {
    origin: configuration.origin,
    resolvedOrigin: configuration.resolution.origin,
    networkRevision: configuration.networkRevision,
    credentialVersions: Object.entries(configuration.credentialVersions).sort(([left], [right]) => left.localeCompare(right)),
    settings: configuration.settings,
    route: route.kind === "direct"
      ? { kind: "direct" }
      : {
        kind: "proxy",
        url: route.url,
        username: route.username,
        password: route.password === undefined ? undefined : digest(route.password),
      },
    targetTLS: tlsIdentity(configuration.resolution.targetTLS),
    proxyTLS: tlsIdentity(configuration.resolution.proxyTLS),
  };
  return digest(JSON.stringify(identity));
}

function connectorTLS(value: PreparedNetworkTLS): Record<string, unknown> {
  const configured = value.caCertificates;
  const roots = tls.getCACertificates("default");
  return {
    rejectUnauthorized: value.verify,
    ca: [...roots, ...configured],
    ...(value.clientCertificates.length === 0 ? {} : { cert: value.clientCertificates.join("\n") }),
    ...(value.clientPrivateKey === undefined ? {} : { key: value.clientPrivateKey }),
    ...(value.clientKeyPassphrase === undefined ? {} : { passphrase: value.clientKeyPassphrase }),
  };
}

export function createHttpDispatcher(configuration: HttpDispatcherConfiguration): Dispatcher {
  const { settings, resolution } = configuration;
  const lookup = configuration.lookup;
  const connect = {
    timeout: settings.connectTimeoutMs,
    ...(lookup === undefined ? {} : { lookup }),
  };
  if (resolution.route.kind === "direct") {
    return new Agent({
      connectTimeout: settings.connectTimeoutMs,
      connect: { ...connect, ...connectorTLS(resolution.targetTLS) },
      headersTimeout: settings.headersTimeoutMs,
      bodyTimeout: settings.bodyTimeoutMs,
    });
  }

  const proxy = new URL(resolution.route.url);
  const token = resolution.route.username === undefined || resolution.route.password === undefined
    ? undefined
    : `Basic ${Buffer.from(`${resolution.route.username}:${resolution.route.password}`, "utf8").toString("base64")}`;
  const proxyTLS = resolution.proxyTLS;
  const proxyConnectorTLS = proxy.protocol === "https:"
    ? connectorTLS(proxyTLS ?? {
      verify: true, caMode: "append-runtime-defaults", caCertificates: [], clientCertificates: [],
    })
    : {};
  return new ProxyAgent({
    uri: resolution.route.url,
    ...(token === undefined ? {} : { token }),
    connectTimeout: settings.connectTimeoutMs,
    headersTimeout: settings.headersTimeoutMs,
    bodyTimeout: settings.bodyTimeoutMs,
    requestTls: connectorTLS(resolution.targetTLS),
    proxyTls: {
      ...proxyConnectorTLS,
      ...(lookup === undefined ? {} : { lookup }),
    },
  });
}

interface DispatcherEntry {
  readonly key: string;
  readonly dispatcher: Dispatcher;
  readonly fresh: boolean;
  leases: number;
  idleAt: number;
  disposed: boolean;
}

export class HttpDispatcherPool {
  private readonly entries = new Set<DispatcherEntry>();
  private readonly pooled = new Map<string, DispatcherEntry>();
  private readonly pendingCloses = new Set<Promise<void>>();
  private sequence = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly mode: "pooled" | "fresh",
    private readonly factory: HttpDispatcherFactory = createHttpDispatcher,
  ) {}

  acquire(configuration: HttpDispatcherConfiguration): HttpDispatcherLease {
    if (this.closed) throw new Error("The HTTP dispatcher pool is closed.");
    const key = `${this.mode}:${httpDispatcherIdentity(configuration)}`;
    let entry = this.mode === "pooled" ? this.pooled.get(key) : undefined;
    if (!entry) {
      entry = {
        key,
        dispatcher: this.factory(configuration),
        fresh: this.mode === "fresh",
        leases: 0,
        idleAt: 0,
        disposed: false,
      };
      this.entries.add(entry);
      if (!entry.fresh) this.pooled.set(key, entry);
    }
    entry.leases += 1;
    entry.idleAt = 0;
    let released = false;
    return {
      dispatcher: entry.dispatcher,
      release: async (options = {}) => {
        if (released) return;
        released = true;
        if (entry!.disposed) return;
        entry!.leases = Math.max(0, entry!.leases - 1);
        if (entry!.fresh) {
          await this.dispose(entry!, options.destroy === true, options.reason);
          return;
        }
        if (entry!.leases > 0) return;
        if (this.closed) {
          await this.dispose(entry!, false, options.reason);
          return;
        }
        entry!.idleAt = ++this.sequence;
        await this.evictExcessIdle();
      },
    };
  }

  private async evictExcessIdle(): Promise<void> {
    const idle = [...this.entries]
      .filter((entry) => !entry.fresh && !entry.disposed && entry.leases === 0)
      .sort((left, right) => left.idleAt - right.idleAt);
    while (idle.length > MAX_IDLE_DISPATCHERS) {
      const oldest = idle.shift()!;
      await this.dispose(oldest, false);
    }
  }

  private dispose(entry: DispatcherEntry, destroy: boolean, reason?: Error): Promise<void> {
    if (entry.disposed) return Promise.resolve();
    entry.disposed = true;
    this.entries.delete(entry);
    if (this.pooled.get(entry.key) === entry) this.pooled.delete(entry.key);
    const operation = destroy
      ? entry.dispatcher.destroy(reason ?? new Error("The HTTP attempt was aborted."))
      : entry.dispatcher.close();
    let pending: Promise<void>;
    pending = operation.finally(() => this.pendingCloses.delete(pending));
    this.pendingCloses.add(pending);
    return pending;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.pooled.clear();
    const closing = [...this.entries].map((entry) => this.dispose(
      entry,
      entry.leases > 0,
      new Error("The HTTP client is closed."),
    ));
    this.closePromise = Promise.all([...this.pendingCloses, ...closing]).then(() => undefined);
    return this.closePromise;
  }
}
