import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createAiConfigRepository, createAiPersonalConfigHost, builtinAiProviderCatalog, loadAiProviderCatalog, migrateLegacyAiConfig, type AiConfigRepository, type AiPersonalConfigHost, type AiSecretBackend } from "@apicc/core";
import { aiEncryptionAvailable, createAiKeyStore, type AiSafeStorageLike, type AiKeyStore } from "./config.js";
import { AiPublicConnectionSchema } from "../../shared/ai/contract.js";
import type { AiSettingsView, AiSettingsWriteInput, AiMigrationResultDto, AiCatalogDto, AiCatalogImportInput } from "../../shared/ai/contract.js";

export interface ConfirmedLegacyAi {
  configuration: { baseUrl: string; model: string };
  originalAddress: string; insecureLocalTest: boolean;
  isCurrent(): Promise<boolean>;
}
export function createLegacyAiConfirmation(ports: {
  readConfiguration(owner: object): Promise<unknown>;
  confirmAddress(owner: object, originalAddress: string): Promise<{ confirmed: boolean; insecureLocalTest: boolean }>;
  isAlive(owner: object): boolean;
}): (owner: object) => Promise<ConfirmedLegacyAi | undefined> {
  const capture = (raw: unknown): ConfirmedLegacyAi["configuration"] | undefined => {
    if (!raw || typeof raw !== "object") return undefined;
    const { baseUrl, model } = raw as { baseUrl?: unknown; model?: unknown };
    if (typeof baseUrl !== "string" || typeof model !== "string" || !model.trim() || model.length > 256) return undefined;
    try {
      const url = new URL(baseUrl);
      if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) return undefined;
      return Object.freeze({ baseUrl: url.href.replace(/\/+$/, ""), model });
    } catch { return undefined; }
  };
  return async owner => {
    if (!ports.isAlive(owner)) return undefined;
    const configuration = capture(await ports.readConfiguration(owner));
    if (!configuration || !ports.isAlive(owner)) return undefined;
    const choice = await ports.confirmAddress(owner, configuration.baseUrl);
    if (!choice.confirmed || !ports.isAlive(owner)) return undefined;
    const current = capture(await ports.readConfiguration(owner));
    if (!current || current.baseUrl !== configuration.baseUrl || current.model !== configuration.model || !ports.isAlive(owner)) return undefined;
    return { configuration, originalAddress: configuration.baseUrl, insecureLocalTest: choice.insecureLocalTest === true,
      async isCurrent() {
        if (!ports.isAlive(owner)) return false;
        const latest = capture(await ports.readConfiguration(owner));
        return ports.isAlive(owner) && latest?.baseUrl === configuration.baseUrl && latest.model === configuration.model;
      },
    };
  };
}
export interface DesktopAiPersonalOptions {
  privateRoot: string; storage: AiSafeStorageLike; platform?: NodeJS.Platform;
  legacyKeyStore?: AiKeyStore; legacyAvailable?: () => boolean;
  confirmLegacy?: (owner: object) => Promise<ConfirmedLegacyAi | undefined>;
}
export interface DesktopAiPersonal {
  repository: AiConfigRepository; host: AiPersonalConfigHost; backend: AiSecretBackend;
  read(): Promise<AiSettingsView>;
  write(input: AiSettingsWriteInput, owner: object): Promise<AiSettingsView | AiMigrationResultDto>;
  catalog(input?: AiCatalogImportInput): Promise<AiCatalogDto>;
}
export function createDesktopAiSecretBackend(options: Pick<DesktopAiPersonalOptions, "privateRoot" | "storage" | "platform">): AiSecretBackend {
  const directory = join(options.privateRoot, "secrets");
  const valid = (ref: string) => /^ai-desktop-secret:[0-9a-f-]{36}$/.test(ref);
  const store = (ref: string) => createAiKeyStore({ dir: directory, storage: options.storage, platform: options.platform, fileName: `${ref.slice("ai-desktop-secret:".length)}.json` });
  return {
    get availability() { return aiEncryptionAvailable(options.storage, options.platform) ? "available" : "unavailable"; },
    async get(ref, audience) {
      if (!valid(ref)) return undefined;
      if (this.availability !== "available") throw new Error("secure-backend-unavailable");
      const raw = store(ref).load();
      if (!raw) return undefined;
      try { const envelope = JSON.parse(raw); return envelope.formatVersion === 1 && envelope.audience === audience && typeof envelope.value === "string" ? envelope.value as string : undefined; }
      catch { return undefined; }
    },
    async put(value, audience, mode) {
      if (mode !== "persistent") throw new Error("invalid-secret-mode");
      const ref = `ai-desktop-secret:${randomUUID()}`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // The same guarded encrypted writer rechecks OS availability at the write.
      store(ref).save(JSON.stringify({ formatVersion: 1, audience, value }));
      return ref;
    },
    async remove(ref, audience) { if (await this.get(ref, audience) !== undefined) store(ref).clear(); },
  };
}
export function createDesktopAiPersonal(options: DesktopAiPersonalOptions): DesktopAiPersonal {
  const repository = createAiConfigRepository({ privateRoot: options.privateRoot });
  const backend = createDesktopAiSecretBackend(options);
  const host = createAiPersonalConfigHost({ repository, secretBackend: backend, catalog: loadAiProviderCatalog(builtinAiProviderCatalog, []).catalog });
  async function read(): Promise<AiSettingsView> {
    const { document, credentials } = await host.snapshot();
    return { scope: "desktop-device-personal", revision: document.revision, application: structuredClone(document.application),
      connections: document.connections.map(c => ({ ...AiPublicConnectionSchema.parse({ id: c.id, revision: c.revision, name: c.name, owner: { kind: "personal" }, baseUrl: c.baseUrl, auth: c.auth, headers: c.headers, protocols: c.protocols,
        ...(c.templateSource ? { templateSource: c.templateSource } : {}), ...(c.insecureLocalTest !== undefined ? { insecureLocalTest: c.insecureLocalTest } : {}), ...(c.networkProfileId ? { networkProfileId: c.networkProfileId } : {}) }), credentialState: credentials.find(s => s.connectionId === c.id)!.state })),
      models: structuredClone(document.models), bindings: structuredClone(document.bindings), projectOverrides: structuredClone(document.projectOverrides),
      backend: backend.availability, legacyAvailable: options.legacyAvailable?.() ?? false,
    };
  }
  return { repository, host, backend, read,
    async write(input, owner) {
      if (input.operation === "connection") await host.saveConnection(input.connection, input.expectedRevision);
      else if (input.operation === "credential") await host.setCredential(input.connectionId, input.value, input.mode, input.expectedRevision);
      else if (input.operation === "preferences") {
        const document = await repository.read();
        await repository.write({ ...document,
          ...(input.application ? { application: input.application } : {}), ...(input.models ? { models: input.models.map(model => ({ ...model, revision: (document.models.find(old => old.id === model.id)?.revision ?? 0) + 1 })) } : {}),
          ...(input.bindings ? { bindings: input.bindings } : {}), ...(input.projectOverrides ? { projectOverrides: input.projectOverrides } : {}),
        }, input.expectedRevision);
      } else {
        const document = await repository.read();
        const existing = document.connections.some(c => c.id === "legacy:desktop-v1:connection") && document.models.some(m => m.id === "legacy:desktop-v1:model");
        const confirmed = existing ? undefined : await options.confirmLegacy?.(owner);
        if (!existing && !confirmed) return { status: "confirmation-required", credentialState: "missing" };
        return migrateLegacyAiConfig({ repository, secretBackend: backend, insecureLocalTest: confirmed?.insecureLocalTest === true,
          source: { kind: "desktop-v1", async readConfiguration() { return confirmed?.configuration; }, async readSecret() {
            if (!confirmed || !await confirmed.isCurrent()) return { state: "unavailable" };
            const value = options.legacyKeyStore?.load(); return value ? { state: "available", value } : { state: "missing" };
          } }, confirmOriginalAddress: async () => confirmed && await confirmed.isCurrent() ? confirmed.originalAddress : undefined,
        });
      }
      return read();
    },
    async catalog(input) {
      const result = !input ? await host.reloadCatalog() : input.apply ? await host.applyCatalogImport({ file: input.file, document: input.document }, { confirmConflicts: input.confirmConflicts }) : await host.previewCatalogImport({ file: input.file, document: input.document });
      return { catalog: result.catalog, errors: result.errors, diff: result.diff, ...("conflicts" in result ? { conflicts: result.conflicts as string[] } : {}) };
    },
  };
}
