import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { prepareCredentialBindings } from "../credentials/bindings.js";
import { CredentialError, type SecretStore } from "../credentials/types.js";
import {
  NetworkConfigurationSchema,
  NetworkProfileError,
  NetworkScopeSchema,
  NetworkSelectionSchema,
  type NetworkConfiguration,
  type NetworkProfile,
  type NetworkScope,
  type NetworkSelection,
  type NetworkTLSSettings,
} from "./profiles.js";
import type { NetworkProfileStore } from "./privateStore.js";

const MAX_CERTIFICATE_FILE_BYTES = 1024 * 1024;
const MAX_CERTIFICATE_TOTAL_BYTES = 4 * 1024 * 1024;

export interface PrepareNetworkRunOptions {
  scope: NetworkScope;
  store: NetworkProfileStore;
  secretStore: SecretStore;
  selection?: NetworkSelection;
  signal?: AbortSignal;
}

export interface PreparedNetworkTLS {
  readonly verify: boolean;
  readonly caMode: "append-runtime-defaults";
  readonly caCertificates: readonly string[];
  readonly clientCertificates: readonly string[];
  readonly clientPrivateKey?: string;
  readonly clientKeyPassphrase?: string;
}

export type PreparedNetworkRoute =
  | { readonly kind: "direct" }
  | { readonly kind: "proxy"; readonly url: string; readonly username?: string; readonly password?: string };

export interface PreparedNetworkResolution {
  readonly origin: string;
  readonly route: PreparedNetworkRoute;
  readonly targetTLS: PreparedNetworkTLS;
  readonly proxyTLS?: PreparedNetworkTLS;
}

export interface PreparedNetworkRun {
  readonly revision: string;
  /** Non-secret digest of the captured scope, selection, config revision, public certificate bytes and secret versions. */
  readonly identity: string;
  readonly credentialVersions: Readonly<Record<string, string>>;
  /** True only when the selected profile requires the HTTP transport adapter. */
  readonly requiresHttpAdapter: boolean;
  /** Host-only values for existing error and output redaction boundaries. */
  readonly outputMarkers: readonly string[];
  resolveForOrigin(origin: URL): PreparedNetworkResolution;
}

interface CertificateBudget {
  bytesRead: number;
}

interface PendingTLS {
  settings: NetworkTLSSettings;
  profileId: string;
  field: string;
  origin?: string;
  caCertificates: string[];
  clientCertificates: string[];
}

interface SecretNeed {
  ref: { id: string; policy: string };
  field: string;
}

function abortIfNeeded(signal: AbortSignal | undefined, profileId?: string, field?: string): void {
  if (signal?.aborted) throw new NetworkProfileError("NETWORK_PREPARATION_ABORTED", profileId, field);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function hasValidCertificateChain(contents: string): boolean {
  const blockPattern = /-----BEGIN CERTIFICATE-----\s*[\s\S]*?\s*-----END CERTIFICATE-----/g;
  const blocks = [...contents.matchAll(blockPattern)];
  if (blocks.length === 0 || contents.replace(blockPattern, "").trim().length > 0) return false;
  try {
    for (const block of blocks) new X509Certificate(block[0]);
    return true;
  } catch {
    return false;
  }
}

async function readCertificateFile(
  path: string,
  profileId: string,
  field: string,
  budget: CertificateBudget,
  signal?: AbortSignal,
): Promise<string> {
  abortIfNeeded(signal, profileId, field);
  if (!isAbsolute(path)) throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", profileId, field);

  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isMissing(error)) throw new NetworkProfileError("NETWORK_CERTIFICATE_MISSING", profileId, field);
    throw new NetworkProfileError("NETWORK_CERTIFICATE_READ_FAILED", profileId, field);
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new NetworkProfileError("NETWORK_CERTIFICATE_INVALID", profileId, field);
    if (info.size > MAX_CERTIFICATE_FILE_BYTES) {
      throw new NetworkProfileError("NETWORK_CERTIFICATE_TOO_LARGE", profileId, field);
    }

    const remainingBudget = MAX_CERTIFICATE_TOTAL_BYTES - budget.bytesRead;
    const readCapacity = Math.max(1, Math.min(MAX_CERTIFICATE_FILE_BYTES, remainingBudget) + 1);
    const buffer = Buffer.alloc(readCapacity);
    let actualBytes = 0;
    while (actualBytes < buffer.length) {
      abortIfNeeded(signal, profileId, field);
      const { bytesRead } = await handle.read(buffer, actualBytes, buffer.length - actualBytes, actualBytes);
      if (bytesRead === 0) break;
      actualBytes += bytesRead;
    }
    budget.bytesRead += actualBytes;
    if (actualBytes > MAX_CERTIFICATE_FILE_BYTES) {
      throw new NetworkProfileError("NETWORK_CERTIFICATE_TOO_LARGE", profileId, field);
    }
    if (actualBytes > remainingBudget) {
      throw new NetworkProfileError("NETWORK_CERTIFICATE_BUDGET_EXCEEDED", profileId, field);
    }
    if (actualBytes !== info.size) {
      throw new NetworkProfileError("NETWORK_CERTIFICATE_READ_FAILED", profileId, field);
    }

    const contents = buffer.subarray(0, actualBytes).toString("utf8");
    if (!hasValidCertificateChain(contents)) {
      throw new NetworkProfileError("NETWORK_CERTIFICATE_INVALID", profileId, field);
    }
    return contents;
  } catch (error) {
    if (error instanceof NetworkProfileError) throw error;
    throw new NetworkProfileError("NETWORK_CERTIFICATE_READ_FAILED", profileId, field);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readTLSCertificates(
  settings: NetworkTLSSettings,
  profileId: string,
  field: string,
  budget: CertificateBudget,
  signal?: AbortSignal,
  origin?: string,
): Promise<PendingTLS> {
  const caCertificates: string[] = [];
  const clientCertificates: string[] = [];
  for (const path of settings.caCertificatePaths ?? []) {
    caCertificates.push(await readCertificateFile(path, profileId, field, budget, signal));
  }
  for (const path of settings.clientCertificatePaths ?? []) {
    clientCertificates.push(await readCertificateFile(path, profileId, field, budget, signal));
  }
  return { settings, profileId, field, ...(origin === undefined ? {} : { origin }), caCertificates, clientCertificates };
}

function collectSecretNeeds(profile: NetworkProfile): SecretNeed[] {
  const needs: SecretNeed[] = [];
  if (profile.kind === "proxy" && profile.passwordRef) {
    needs.push({ ref: profile.passwordRef, field: "passwordRef" });
  }
  for (const binding of profile.targetTlsBindings) {
    const field = "targetTlsBindings";
    if (binding.tls.clientPrivateKeyRef) needs.push({ ref: binding.tls.clientPrivateKeyRef, field });
    if (binding.tls.clientKeyPassphraseRef) needs.push({ ref: binding.tls.clientKeyPassphraseRef, field });
  }
  if (profile.kind === "proxy" && profile.proxyTLS) {
    if (profile.proxyTLS.clientPrivateKeyRef) needs.push({ ref: profile.proxyTLS.clientPrivateKeyRef, field: "proxyTLS" });
    if (profile.proxyTLS.clientKeyPassphraseRef) needs.push({ ref: profile.proxyTLS.clientKeyPassphraseRef, field: "proxyTLS" });
  }
  return needs;
}

function mapSecretError(error: unknown, profileId: string, field: string): NetworkProfileError {
  if (error instanceof CredentialError) {
    if (error.code === "CREDENTIAL_MISSING") return new NetworkProfileError("NETWORK_SECRET_MISSING", profileId, field);
    if (error.code === "CREDENTIAL_VERSION_CONFLICT") return new NetworkProfileError("NETWORK_SECRET_VERSION_CONFLICT", profileId, field);
    if (error.code === "CREDENTIAL_UNAVAILABLE") return new NetworkProfileError("NETWORK_SECRET_UNAVAILABLE", profileId, field);
  }
  return new NetworkProfileError("NETWORK_SECRET_INVALID", profileId, field);
}

function preparedTLS(
  pending: PendingTLS,
  values: ReadonlyMap<string, string>,
): PreparedNetworkTLS {
  const settings = pending.settings;
  const keyRef = settings.clientPrivateKeyRef;
  const passphraseRef = settings.clientKeyPassphraseRef;
  const clientPrivateKey = keyRef ? values.get(keyRef.id) : undefined;
  const clientKeyPassphrase = passphraseRef ? values.get(passphraseRef.id) : undefined;

  if (keyRef && clientPrivateKey === undefined) {
    throw new NetworkProfileError("NETWORK_SECRET_MISSING", pending.profileId, pending.field);
  }
  if (passphraseRef && clientKeyPassphrase === undefined) {
    throw new NetworkProfileError("NETWORK_SECRET_MISSING", pending.profileId, pending.field);
  }
  if (clientPrivateKey !== undefined) {
    try {
      const keyOptions: { key: string; passphrase?: string } = { key: clientPrivateKey };
      if (clientKeyPassphrase !== undefined) keyOptions.passphrase = clientKeyPassphrase;
      const key = createPrivateKey(keyOptions);
      if (pending.clientCertificates.length > 0 && !new X509Certificate(pending.clientCertificates[0]!).checkPrivateKey(key)) {
        throw new Error("client key does not match certificate");
      }
    } catch {
      throw new NetworkProfileError("NETWORK_SECRET_INVALID", pending.profileId, pending.field);
    }
  }

  const output: PreparedNetworkTLS = {
    verify: settings.verify ?? true,
    caMode: "append-runtime-defaults",
    caCertificates: Object.freeze([...pending.caCertificates]),
    clientCertificates: Object.freeze([...pending.clientCertificates]),
    ...(clientPrivateKey === undefined ? {} : { clientPrivateKey }),
    ...(clientKeyPassphrase === undefined ? {} : { clientKeyPassphrase }),
  };
  return Object.freeze(output);
}

function withHostOnlyCarrier<T extends object>(value: T): T {
  Object.defineProperty(value, "toJSON", {
    value() { throw new TypeError("Prepared network material is host-only and cannot be serialized."); },
    enumerable: false,
  });
  const frozen = Object.freeze(value);
  // Keep the host API directly readable, while making structuredClone reject the carrier.
  return new Proxy(frozen, {});
}

function selectedProfile(configuration: NetworkConfiguration, selection: NetworkSelection): NetworkProfile | undefined {
  if (selection.kind === "direct") return undefined;
  const profile = configuration.profiles.find((item) => item.id === selection.profileId);
  if (!profile) throw new NetworkProfileError("NETWORK_PROFILE_NOT_FOUND", selection.profileId, "selection");
  return profile;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function networkIdentity(input: {
  scope: NetworkScope;
  revision: string;
  selection: NetworkSelection;
  credentialVersions: Readonly<Record<string, string>>;
  certificates: readonly { field: string; origin?: string; kind: "ca" | "client"; index: number; digest: string }[];
  requiresHttpAdapter: boolean;
}): string {
  const credentials = Object.keys(input.credentialVersions).sort().map((id) => [id, input.credentialVersions[id]]);
  const certificates = [...input.certificates].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const identity = JSON.stringify({
    scope: input.scope,
    revision: input.revision,
    selection: input.selection,
    credentialVersions: credentials,
    certificates,
    requiresHttpAdapter: input.requiresHttpAdapter,
  });
  return `sha256:${sha256(identity)}`;
}

function certificateIdentity(pending: readonly PendingTLS[]): Array<{
  field: string; origin?: string; kind: "ca" | "client"; index: number; digest: string;
}> {
  const output: Array<{ field: string; origin?: string; kind: "ca" | "client"; index: number; digest: string }> = [];
  for (const entry of pending) {
    for (const [kind, contents] of [["ca", entry.caCertificates], ["client", entry.clientCertificates]] as const) {
      contents.forEach((value, index) => output.push({
        field: entry.field,
        ...(entry.origin === undefined ? {} : { origin: entry.origin }),
        kind,
        index,
        digest: sha256(value),
      }));
    }
  }
  return output;
}

function outputMarkers(profile: NetworkProfile, values: ReadonlyMap<string, string>, pending: readonly PendingTLS[]): readonly string[] {
  const markers = new Set<string>();
  for (const value of values.values()) if (value.length > 0) markers.add(value);
  for (const entry of pending) {
    for (const value of [...entry.caCertificates, ...entry.clientCertificates]) if (value.length > 0) markers.add(value);
  }
  if (profile.kind === "proxy" && profile.passwordRef && profile.username !== undefined) {
    const password = values.get(profile.passwordRef.id);
    if (password !== undefined) {
      markers.add(`${profile.username}:${password}`);
      markers.add(`Basic ${Buffer.from(`${profile.username}:${password}`, "utf8").toString("base64")}`);
    }
  }
  return Object.freeze([...markers].sort((left, right) => right.length - left.length || left.localeCompare(right)));
}

function validateConfiguration(value: unknown): NetworkConfiguration {
  const parsed = NetworkConfigurationSchema.safeParse(value);
  if (!parsed.success) throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", undefined, "configuration");
  return parsed.data;
}

export async function prepareNetworkRun(options: PrepareNetworkRunOptions): Promise<PreparedNetworkRun> {
  const scopeResult = NetworkScopeSchema.safeParse(options?.scope);
  if (!scopeResult.success) throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", undefined, "scope");
  const scope = scopeResult.data;
  abortIfNeeded(options.signal);

  let loaded: Awaited<ReturnType<NetworkProfileStore["load"]>>;
  try {
    loaded = await options.store.load(scope);
  } catch (error) {
    if (error instanceof NetworkProfileError) throw error;
    throw new NetworkProfileError("NETWORK_STORAGE_FAILED", undefined, "configuration");
  }
  if (typeof loaded?.revision !== "string" || loaded.revision.length === 0) {
    throw new NetworkProfileError("NETWORK_STORAGE_FAILED", undefined, "revision");
  }
  const configuration = validateConfiguration(loaded.configuration);
  const explicit = options.selection === undefined
    ? undefined
    : NetworkSelectionSchema.safeParse(options.selection);
  if (explicit && !explicit.success) throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", undefined, "selection");
  const environmentSelection = scope.environmentId === undefined
    ? undefined
    : configuration.environmentSelections.find((item) => item.environmentId === scope.environmentId)?.selection;
  const selection = explicit?.data ?? environmentSelection ?? configuration.projectSelection ?? { kind: "direct" as const };
  const profile = selectedProfile(configuration, selection);
  if (!profile) {
    const defaultTLS: PreparedNetworkTLS = Object.freeze({
      verify: true,
      caMode: "append-runtime-defaults",
      caCertificates: Object.freeze([]),
      clientCertificates: Object.freeze([]),
    });
    const requiresHttpAdapter = false;
    const run: PreparedNetworkRun = {
      revision: loaded.revision,
      identity: networkIdentity({ scope, revision: loaded.revision, selection, credentialVersions: {}, certificates: [], requiresHttpAdapter }),
      credentialVersions: Object.freeze({}),
      requiresHttpAdapter,
      outputMarkers: Object.freeze([]),
      resolveForOrigin(originValue) {
        const origin = originValue.origin;
        if (origin === "null") throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", undefined, "origin");
        return withHostOnlyCarrier({
          origin,
          route: Object.freeze({ kind: "direct" as const }),
          targetTLS: defaultTLS,
        });
      },
    };
    return withHostOnlyCarrier(run);
  }

  abortIfNeeded(options.signal, profile.id);
  const budget: CertificateBudget = { bytesRead: 0 };
  const pendingTarget = new Map<string, PendingTLS>();
  for (const binding of profile.targetTlsBindings) {
    pendingTarget.set(binding.origin, await readTLSCertificates(
      binding.tls, profile.id, "targetTlsBindings", budget, options.signal, binding.origin,
    ));
  }
  let pendingProxy: PendingTLS | undefined;
  if (profile.kind === "proxy" && profile.proxyUrl.startsWith("https://")) {
    pendingProxy = await readTLSCertificates(profile.proxyTLS ?? {}, profile.id, "proxyTLS", budget, options.signal);
  }

  const needs = collectSecretNeeds(profile);
  const uniqueNeeds = new Map<string, SecretNeed>();
  for (const need of needs) {
    if (!uniqueNeeds.has(need.ref.id)) uniqueNeeds.set(need.ref.id, need);
  }
  let bindings: Awaited<ReturnType<typeof prepareCredentialBindings>>;
  try {
    bindings = await prepareCredentialBindings(
      scope.project,
      needs.map((need) => need.ref),
      options.secretStore,
    );
  } catch (error) {
    const refId = error instanceof CredentialError ? error.refId : undefined;
    const need = refId === undefined ? [...uniqueNeeds.values()][0] : uniqueNeeds.get(refId);
    throw mapSecretError(error, profile.id, need?.field ?? "secretRefs");
  }

  const values = new Map<string, string>();
  for (const [refId, need] of uniqueNeeds) {
    try {
      values.set(refId, bindings.resolve(need.ref));
    } catch (error) {
      throw mapSecretError(error, profile.id, need.field);
    }
  }

  const targetTls = new Map<string, PreparedNetworkTLS>();
  for (const [origin, pending] of pendingTarget) targetTls.set(origin, preparedTLS(pending, values));
  const proxyTLS = pendingProxy ? preparedTLS(pendingProxy, values) : undefined;
  const requiresHttpAdapter = profile.kind === "proxy" || profile.targetTlsBindings.length > 0;
  const pendingCertificates = [...pendingTarget.values(), ...(pendingProxy === undefined ? [] : [pendingProxy])];
  const route: PreparedNetworkRoute = profile.kind === "proxy"
    ? Object.freeze({
      kind: "proxy",
      url: profile.proxyUrl,
      ...(profile.username === undefined ? {} : { username: profile.username }),
      ...(profile.passwordRef === undefined ? {} : { password: values.get(profile.passwordRef.id)! }),
    })
    : Object.freeze({ kind: "direct" });
  const defaultTLS: PreparedNetworkTLS = Object.freeze({
    verify: true,
    caMode: "append-runtime-defaults",
    caCertificates: Object.freeze([]),
    clientCertificates: Object.freeze([]),
  });
  const run: PreparedNetworkRun = {
    revision: loaded.revision,
    identity: networkIdentity({
      scope,
      revision: loaded.revision,
      selection,
      credentialVersions: bindings.versions,
      certificates: certificateIdentity(pendingCertificates),
      requiresHttpAdapter,
    }),
    credentialVersions: bindings.versions,
    requiresHttpAdapter,
    outputMarkers: outputMarkers(profile, values, pendingCertificates),
    resolveForOrigin(originValue) {
      const origin = originValue.origin;
      if (origin === "null") throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", profile.id, "origin");
      return withHostOnlyCarrier({
        origin,
        route,
        targetTLS: targetTls.get(origin) ?? defaultTLS,
        ...(proxyTLS === undefined ? {} : { proxyTLS }),
      });
    },
  };
  return withHostOnlyCarrier(run);
}
