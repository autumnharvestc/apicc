import { collectCredentialRefsForRequests, prepareTestData, selectCredentialRequests, testDataSelectionsForRequests,
  collectNetworkDependencies, createFileNetworkProfileStore, defaultNetworkPrivateRoot, readNetworkCertificateFile, prepareCredentialBindings, prepareNetworkRun, CredentialError, HttpFileError, NetworkProfileError,
  prepareRequestFiles, type PreparedRequestFiles, type PreparedTestData, type CredentialScope, type SecretRef, type SecretStore, type NetworkConfiguration, type NetworkScope, type NetworkSelection, type NetworkTLSSettings } from "@apicc/core";
import { invokeExecution, prepareExecution, type PreparedExecution } from "@apicc/execution/host";
import { RunConfigSchema } from "@apicc/execution/contract";
import type { McpLocalExecutionHost } from "./execution.js";
import { createCredentialHostStore, type CredentialHostOptions } from "../credentials.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpLocalExecutionFailure, safeRunFailure } from "./ownedRuns.js";

interface LocalMaterialMetadata {
  readonly materialVersions: Readonly<Record<string, string>>;
  readonly dataDigest: string;
  readonly networkRevision: string;
  readonly networkSelection: NetworkSelection;
}
interface FixedLocalMaterials {
  data: PreparedTestData;
  preparedRequestFiles: PreparedRequestFiles;
  workspaceRoot: string;
  scope: CredentialScope;
  networkScope: NetworkScope;
  refs: readonly SecretRef[];
  configuration: NetworkConfiguration;
  certificates: readonly string[];
  metadata: LocalMaterialMetadata;
}

/** Only the already-authorized binding is visible to Core's network preparation, never a newer store generation. */
function fixedBindingStore(fixed: FixedLocalMaterials, bindings: Awaited<ReturnType<typeof prepareCredentialBindings>>): SecretStore {
  const refs = new Map(fixed.refs.map(ref => [ref.id, ref]));
  const version = (scope: CredentialScope, ref: SecretRef) => {
    if (scope.workspaceId !== fixed.scope.workspaceId || scope.groupId !== fixed.scope.groupId || scope.projectId !== fixed.scope.projectId
      || refs.get(ref.id)?.policy !== ref.policy || !Object.hasOwn(bindings.versions, ref.id)) throw new CredentialError("CREDENTIAL_UNAVAILABLE", ref.id);
    return bindings.versions[ref.id]!;
  };
  return {
    async version(scope, ref) { return version(scope, ref); },
    async resolve(scope, ref, expected) {
      if (expected !== undefined && expected !== version(scope, ref)) throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
      version(scope, ref);
      return bindings.resolve(ref);
    },
    async status(scope, ref) { version(scope, ref); return "available"; },
    async put() { throw new Error("mcp-fixed-credential-store-read-only"); },
    async remove() { throw new Error("mcp-fixed-credential-store-read-only"); },
  };
}

/** Rebind the captured public bytes in the same dependency order consumed by Core. */
async function stageCertificates(fixed: FixedLocalMaterials, directory: string): Promise<NetworkConfiguration> {
  const configuration = structuredClone(fixed.configuration);
  const selection = fixed.metadata.networkSelection;
  const profile = selection.kind === "profile" ? configuration.profiles.find(profile => profile.id === selection.profileId) : undefined;
  let index = 0;
  const stageTLS = async (tls: NetworkTLSSettings) => {
    for (const key of ["caCertificatePaths", "clientCertificatePaths"] as const) {
      if (!tls[key]) continue;
      const paths: string[] = [];
      for (const _path of tls[key]!) {
        const path = join(directory, `${index}.pem`);
        await writeFile(path, fixed.certificates[index++]!, { flag: "wx", mode: 0o600 });
        paths.push(path);
      }
      tls[key] = paths;
    }
  };
  if (profile) {
    for (const binding of profile.targetTlsBindings) await stageTLS(binding.tls);
    if (profile.kind === "proxy" && profile.proxyUrl.startsWith("https:") && profile.proxyTLS) await stageTLS(profile.proxyTLS);
  }
  return configuration;
}

/** Fixed local materials never leave this host or replace the Core-owned prepared object. */
export function createMcpLocalExecutionHost(options: Pick<CredentialHostOptions, "secretStore" | "credentialPrivateRoot" | "networkPrivateRoot"> = {}): McpLocalExecutionHost & { discard(prepared: PreparedExecution): Promise<void>; metadata(prepared: PreparedExecution): LocalMaterialMetadata } {
  const materials = new WeakMap<PreparedExecution, FixedLocalMaterials>();
  const secretStore = createCredentialHostStore(options);
  return {
    async prepare(snapshot, target, environmentId, _limits, context) {
      context.signal.throwIfAborted();
      if (context.scope.projectId !== snapshot.project.id) throw new Error("mcp-local-target-scope-mismatch");
      if (target.kind === "debug") {
        for (const locator of [target.invocation.locator, target.invocation.case]) {
          if (locator.workspaceId !== context.scope.workspaceId || locator.groupId !== context.scope.groupId || locator.projectId !== context.scope.projectId) {
            throw new Error("mcp-local-target-scope-mismatch");
          }
        }
        if (environmentId !== undefined && environmentId !== target.invocation.environmentId) throw new Error("mcp-local-environment-selection-mismatch");
      }
      const runConfig = RunConfigSchema.parse(context.runConfig);
      if (runConfig.stress !== undefined) throw new Error("mcp-local-run-config-unsupported");
      const prepared = prepareExecution({ snapshot, target, environmentId, profile: context.profile,
        requestSettings: runConfig.requestSettings, scriptTimeoutMs: runConfig.scriptTimeoutMs });
      const requests = selectCredentialRequests(prepared.snapshot, prepared.selections);
      let data: PreparedTestData;
      try {
        data = await prepareTestData(prepared.snapshot, prepared.suitePlan?.selections ?? testDataSelectionsForRequests(prepared.snapshot, prepared.selections, prepared.environmentId), { workspaceRoot: context.workspaceRoot });
      } catch {
        context.signal.throwIfAborted();
        throw new Error("mcp-local-test-data-material-unavailable");
      }
      if (data.sources.some(source => source.diagnostics.some(item => item.code !== "legacy-empty-fallback"))) throw new Error("mcp-local-test-data-material-unavailable");
      const networkScope: NetworkScope = { canonicalRoot: context.workspaceRoot, project: { ...context.scope }, ...(prepared.environmentId === undefined ? {} : { environmentId: prepared.environmentId }) };
      const loaded = await createFileNetworkProfileStore({ privateRoot: options.networkPrivateRoot ?? defaultNetworkPrivateRoot() }).load(networkScope);
      const configuration = structuredClone(loaded.configuration);
      const dependencies = collectNetworkDependencies({ configuration, environmentId: prepared.environmentId });
      const refs = [...collectCredentialRefsForRequests(prepared.snapshot.project, requests), ...dependencies.secretNeeds.map(need => need.ref)];
      const versions = new Map<string, string>();
      for (const ref of refs) {
        if (versions.has(ref.id)) continue;
        try {
          const version = await secretStore.version(context.scope, ref);
          if (typeof version !== "string" || !version.length) throw new CredentialError("CREDENTIAL_READ_FAILED", ref.id);
          versions.set(ref.id, version);
        } catch (error) {
          context.signal.throwIfAborted();
          if (error instanceof CredentialError) throw error;
          throw new Error("mcp-local-credential-material-unavailable");
        }
      }
      const certificates: string[] = [], budget = { bytesRead: 0 };
      for (const certificate of dependencies.certificatePaths) {
        certificates.push(await readNetworkCertificateFile(certificate.path, dependencies.profile!.id, certificate.field, budget, context.signal));
      }
      const preparedRequestFiles = await prepareRequestFiles(prepared.snapshot, prepared.selections, { workspaceRoot: context.workspaceRoot, signal: context.signal,
        requestSettings: { ...(prepared.target.kind === "debug" ? prepared.target.invocation.settings : {}), ...prepared.requestSettings } });
      try {
      context.signal.throwIfAborted();
      const metadata: LocalMaterialMetadata = Object.freeze({ materialVersions: Object.freeze(Object.fromEntries(versions)), dataDigest: data.digest,
        networkRevision: loaded.revision, networkSelection: Object.freeze({ ...dependencies.selection }) });
      materials.set(prepared, { data, preparedRequestFiles, workspaceRoot: context.workspaceRoot, scope: { ...context.scope }, networkScope, refs, configuration, certificates, metadata });
      return prepared;
      } catch (error) { await preparedRequestFiles.close(); throw error; }
    },
    async start(prepared, _runId, signal) {
      const fixed = materials.get(prepared);
      if (!fixed) throw new Error("mcp-local-input-material-unavailable");
      let directory: string | undefined;
      let invoked = false;
      try {
        signal.throwIfAborted();
        await fixed.preparedRequestFiles.assertUnchanged();
        signal.throwIfAborted();
        const credentialBindings = await prepareCredentialBindings(fixed.scope, fixed.refs, secretStore, fixed.metadata.materialVersions);
        signal.throwIfAborted();
        let configuration = fixed.configuration;
        if (fixed.certificates.length) {
          directory = await mkdtemp(join(tmpdir(), "apicc-mcp-network-"));
          configuration = await stageCertificates(fixed, directory);
        }
        signal.throwIfAborted();
        const network = await prepareNetworkRun({ scope: fixed.networkScope, selection: fixed.metadata.networkSelection, signal,
          secretStore: fixedBindingStore(fixed, credentialBindings), store: {
            async load() { return { revision: fixed.metadata.networkRevision, configuration }; },
            async save() { throw new Error("mcp-fixed-network-store-read-only"); },
          } });
        signal.throwIfAborted();
        invoked = true;
        return await invokeExecution(prepared, { preparedTestData: fixed.data, preparedRequestFiles: fixed.preparedRequestFiles, workspaceRoot: fixed.workspaceRoot, credentialBindings, network }, { signal });
      } catch (error) {
        const reason = error instanceof CredentialError || error instanceof HttpFileError || error instanceof NetworkProfileError ? error.code : undefined;
        throw new McpLocalExecutionFailure(safeRunFailure(reason, invoked ? "uncertain" : "not-started"));
      } finally {
        try { await fixed.preparedRequestFiles.close(); }
        finally { try { if (directory) await rm(directory, { recursive: true, force: true }); }
          finally { materials.delete(prepared); } }
      }
    },
    metadata(prepared) {
      const fixed = materials.get(prepared);
      if (!fixed) throw new Error("mcp-local-input-material-unavailable");
      return fixed.metadata;
    },
    async discard(prepared) { const fixed = materials.get(prepared); materials.delete(prepared); await fixed?.preparedRequestFiles.close(); },
  };
}
