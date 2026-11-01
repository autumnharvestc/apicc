import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { AiConnectionSchema, aiCredentialAudience, type AiConnection, type AiConfigDocument, type AiProviderTemplate } from "../config.js";
import type { AiCredentialResolver, AiResolvedCredentials } from "../types.js";
import { loadAiProviderCatalog, type AiCatalogLoadResult } from "../catalog.js";
import { AiConfigHostError, type AiConfigRepository, type AiProviderFile } from "./repository.js";
import { isAiSecretValue, type AiSecretBackend, type AiSecretMode, type AiSecretState } from "./secrets.js";
export type AiPersonalProjectLocation =
  | { kind: "local"; root: string; workspaceId: string; groupId: string; projectId: string }
  | { kind: "online"; serverUrl: string; memberId: string; workspaceId: string; groupId: string; projectId: string };
/** Identity only. Trusted hosts capture this location; it grants no read, login, or credential authority. */
export function aiPersonalProjectKey(location: AiPersonalProjectLocation): string {
  const parts = [location.workspaceId, location.groupId, location.projectId];
  if (parts.some(part => typeof part !== "string" || !part.trim())) throw new AiConfigHostError("invalid-project-location");
  let identity: unknown[];
  if (location.kind === "local") {
    if (!isAbsolute(location.root)) throw new AiConfigHostError("invalid-project-location");
    const root = resolve(location.root);
    identity = [1, "local", process.platform === "win32" ? root.toLowerCase() : root, ...parts];
  } else {
    if (!location.memberId?.trim()) throw new AiConfigHostError("invalid-project-location");
    let url: URL;
    try { url = new URL(location.serverUrl); } catch { throw new AiConfigHostError("invalid-project-location"); }
    if (url.username || url.password) throw new AiConfigHostError("invalid-project-location");
    identity = [1, "online", url.href.replace(/\/+$/, ""), location.memberId, ...parts];
  }
  return `ai-project:v1:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}
export interface AiPersonalConfigHost {
  snapshot(): Promise<{ document: AiConfigDocument; credentials: { connectionId: string; state: AiSecretState }[] }>;
  saveConnection(connection: AiConnection, expectedRevision: number): Promise<AiConfigDocument>;
  setCredential(connectionId: string, value: string, mode: AiSecretMode, expectedRevision: number): Promise<AiConfigDocument>;
  credentialResolver: AiCredentialResolver;
  reloadCatalog(): Promise<AiCatalogLoadResult>;
  previewCatalogImport(file: AiProviderFile): Promise<AiCatalogLoadResult & { conflicts: string[] }>;
  applyCatalogImport(file: AiProviderFile, options?: { confirmConflicts?: boolean }): Promise<AiCatalogLoadResult>;
}
/** Trusted Node API: renderer adapters must explicitly project their own safe DTO. */
export function createAiPersonalConfigHost(options: { repository: AiConfigRepository; secretBackend: AiSecretBackend; catalog: readonly AiProviderTemplate[] }): AiPersonalConfigHost {
  const { repository, secretBackend } = options;
  const builtin = structuredClone({ formatVersion: 1, providers: options.catalog });
  let lastCatalog = loadAiProviderCatalog(builtin, []).catalog;
  function loadCatalog(files: AiProviderFile[], previous = lastCatalog): AiCatalogLoadResult {
    const result = loadAiProviderCatalog(builtin, files.map(f => f.document), previous);
    result.errors = result.errors.map(error => {
      const match = /^overrides\[(\d+)\]$/.exec(error.file);
      if (!match) return error;
      const file = files[Number(match[1])]!;
      if (file.readError) return { file: file.readError === "directory-unreadable" ? "providers.d" : `providers.d/${file.file}`, field: "read",
        message: file.readError === "directory-unreadable" ? "无法读取供应商模板目录" : "无法读取供应商模板文件" };
      return { ...error, file: `providers.d/${file.file}` };
    });
    return result;
  }
  const sessions = new Map<string, { audience: string; revision: number; value: string }>();
  async function secret(connection: AiConnection): Promise<{ state: AiSecretState; value?: string }> {
    const audience = aiCredentialAudience(connection);
    const session = sessions.get(connection.id);
    if (session?.audience === audience && session.revision === connection.revision) return { state: "session-only", value: session.value };
    if (session) sessions.delete(connection.id);
    if (!connection.credentialRef) return { state: "missing" };
    if (secretBackend.availability !== "available") return { state: "unavailable" };
    try {
      const value = await secretBackend.get(connection.credentialRef, audience);
      return value === undefined ? { state: "missing" } : { state: "available", value };
    } catch { return { state: "unavailable" }; }
  }
  return {
    async reloadCatalog() {
      const result = loadCatalog(await repository.readProviderFiles());
      lastCatalog = structuredClone(result.catalog);
      return result;
    },
    async previewCatalogImport(file) {
      const files = await repository.readProviderFiles();
      const current = loadCatalog(files);
      if (files.some(f => f.readError)) return { ...current, conflicts: [] };
      const result = loadCatalog([...files.filter(f => f.file !== file.file), file].sort((a, b) => a.file.localeCompare(b.file)), current.catalog);
      return { ...result, conflicts: [...result.diff.updated] };
    },
    async applyCatalogImport(file, input = {}) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(file.file)) throw new AiConfigHostError("invalid-catalog");
      const files = await repository.readProviderFiles();
      const current = loadCatalog(files);
      if (files.some(f => f.readError)) throw new AiConfigHostError("invalid-catalog");
      const result = loadCatalog([...files.filter(f => f.file !== file.file), file].sort((a, b) => a.file.localeCompare(b.file)), current.catalog);
      if (result.errors.length) throw new AiConfigHostError("invalid-catalog");
      if (result.diff.updated.length && !input.confirmConflicts) throw new AiConfigHostError("catalog-conflict");
      await repository.writeProviderFile(file);
      lastCatalog = structuredClone(result.catalog);
      return result;
    },
    async snapshot() {
      const document = await repository.read();
      const credentials = await Promise.all(document.connections.map(async connection => ({ connectionId: connection.id, state: (await secret(connection)).state })));
      return { document, credentials };
    },
    async saveConnection(input, expectedRevision) {
      const parsed = AiConnectionSchema.safeParse(input);
      if (!parsed.success) throw new AiConfigHostError("invalid-configuration");
      const connection = parsed.data;
      const document = await repository.read();
      const previous = document.connections.find(c => c.id === connection.id);
      const session = sessions.get(connection.id);
      connection.revision = previous ? previous.revision + 1 : 1;
      delete connection.credentialRef;
      if (previous && aiCredentialAudience(previous) === aiCredentialAudience(connection) && previous.credentialRef) connection.credentialRef = previous.credentialRef;
      document.connections = previous ? document.connections.map(c => c.id === connection.id ? connection : c) : [...document.connections, connection];
      const saved = await repository.write(document, expectedRevision);
      // Only this host's known-current same-audience edit may carry RAM authorization forward.
      if (session && sessions.get(connection.id) === session) {
        if (previous && session.revision === previous.revision && session.audience === aiCredentialAudience(previous) && session.audience === aiCredentialAudience(connection)) {
          sessions.set(connection.id, { ...session, revision: connection.revision });
        } else sessions.delete(connection.id);
      }
      if (previous && aiCredentialAudience(previous) !== aiCredentialAudience(connection)) {
        if (previous.credentialRef) await secretBackend.remove(previous.credentialRef, aiCredentialAudience(previous)).catch(() => undefined);
      }
      return saved;
    },
    async setCredential(connectionId, value, mode, expectedRevision) {
      if (mode !== "persistent" && mode !== "session-only") throw new AiConfigHostError("invalid-secret-mode");
      if (!isAiSecretValue(value)) throw new AiConfigHostError("invalid-credential");
      const session = sessions.get(connectionId);
      const document = await repository.read();
      if (document.revision !== expectedRevision) throw new AiConfigHostError("revision-conflict");
      const connection = document.connections.find(c => c.id === connectionId);
      if (!connection) throw new AiConfigHostError("connection-missing");
      if (connection.auth.kind === "none") throw new AiConfigHostError("credential-not-required");
      const audience = aiCredentialAudience(connection);
      if (mode === "session-only") { sessions.set(connectionId, { audience, revision: connection.revision, value }); return document; }
      if (secretBackend.availability !== "available") throw new AiConfigHostError("secure-backend-unavailable");
      let ref: string;
      try { ref = await secretBackend.put(value, audience, mode); }
      catch { throw new AiConfigHostError("secure-backend-unavailable"); }
      const previousRef = connection.credentialRef;
      connection.credentialRef = ref;
      connection.revision++;
      let saved: AiConfigDocument;
      try { saved = await repository.write(document, expectedRevision); }
      catch (error) { await secretBackend.remove(ref, audience).catch(() => undefined); throw error; }
      if (sessions.get(connectionId) === session) sessions.delete(connectionId);
      if (previousRef) await secretBackend.remove(previousRef, audience).catch(() => undefined);
      return saved;
    },
    credentialResolver: { async resolve(connection): Promise<AiResolvedCredentials> {
      const document = await repository.read();
      const current = document.connections.find(c => c.id === connection.id);
      if (!current || aiCredentialAudience(current) !== aiCredentialAudience(connection)) throw new AiConfigHostError("credential-audience-mismatch");
      const audience = aiCredentialAudience(current);
      if (current.auth.kind === "none") return { audience, headers: {} };
      const resolved = await secret(current);
      if (resolved.value === undefined) throw new AiConfigHostError("credential-missing");
      if (!isAiSecretValue(resolved.value)) throw new AiConfigHostError("invalid-credential");
      return { audience, headers: current.auth.kind === "bearer" ? { Authorization: `Bearer ${resolved.value}` } : { [current.auth.header]: resolved.value } };
    } },
  };
}
