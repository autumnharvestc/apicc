import { createDefaultAiConfigDocument, loadAiProviderCatalog, type AiProviderTemplate } from "@apicc/core";
import { AiConfigDocumentSchema } from "@apicc/core/schema";
import { AiCatalogImportSchema, AiSettingsWriteSchema, type AiCredentialState, type AiSettingsView } from "../../../src/shared/ai/contract.js";
import type { ApiccApi } from "../../../src/shared/types.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";

/** Test-only trusted-host boundary: immutable public DTOs, CAS, no secret readback. */
export function createSafeAiSettingsFixture(options: {
  backend?: "available" | "unavailable";
  catalog?: AiProviderTemplate[];
  templateSource?: { id: string; revision: number };
  legacyAvailable?: boolean;
} = {}) {
  let document = AiConfigDocumentSchema.parse({
    ...createDefaultAiConfigDocument(),
    connections: [{
      id: "personal-primary", revision: 1, name: "个人主连接", owner: { kind: "personal" },
      baseUrl: "https://models.example.test/gateway/v1", auth: { kind: "bearer" },
      headers: {}, protocols: ["openai-chat-completions"],
      ...(options.templateSource ? { templateSource: options.templateSource } : {}),
    }],
    models: [
      {
        id: "model-a", revision: 1, connectionId: "personal-primary", modelId: "manual-model-A",
        protocol: "openai-chat-completions", structuredOutput: "json-schema", streaming: true,
        supportedParameters: [], capabilities: {
          status: "confirmed", source: "用户手工确认", contextWindowTokens: 32768,
          maxInputTokens: 24576, maxOutputTokens: 8192, sharedContextWindow: true, outputIncludesReasoning: false,
        }, budgets: { maxOutputTokens: 8192, totalOutputTokens: 24576 }, purposeBudgets: {},
      },
      {
        id: "model-b", revision: 1, connectionId: "personal-primary", modelId: "manual-model-B",
        protocol: "openai-chat-completions", structuredOutput: "json-schema", streaming: true,
        supportedParameters: ["reasoning"], capabilities: {
          status: "confirmed", source: "用户手工确认", contextWindowTokens: 131072,
          maxInputTokens: 98304, maxOutputTokens: 32768, sharedContextWindow: true, outputIncludesReasoning: true,
        }, budgets: { maxOutputTokens: 32768, totalOutputTokens: 98304 }, purposeBudgets: {},
      },
    ],
    bindings: [{ purpose: "case-suggestion", modelProfileId: "model-a", budgets: {} }],
  });
  const credentialStates = new Map<string, AiCredentialState>([["personal-primary", "available"]]);
  const read = (): AiSettingsView => structuredClone({
    scope: "desktop-device-personal", revision: document.revision, application: document.application,
    connections: document.connections.map(({ credentialRef: _ref, ...connection }) => ({
      ...connection, credentialState: credentialStates.get(connection.id) === "available" && options.backend === "unavailable"
        ? "unavailable" : credentialStates.get(connection.id) ?? "missing",
    })),
    models: document.models, bindings: document.bindings, projectOverrides: document.projectOverrides,
    backend: options.backend ?? "available", legacyAvailable: options.legacyAvailable ?? false,
  });
  const networkActions: string[] = [];
  const providerFiles = new Map<string, unknown>();
  const builtinCatalog = { formatVersion: 1, providers: options.catalog ?? [] };
  let lastCatalog = loadAiProviderCatalog(builtinCatalog, []).catalog;
  const catalogActions: { operation: "reload" | "import"; apply?: boolean; confirmConflicts?: boolean }[] = [];
  const safeMethods = {
    aiSettingsRead: async () => read(),
    aiSettingsWrite: async (raw) => {
      const input = AiSettingsWriteSchema.parse(raw);
      if (input.operation === "migrate-legacy") return { status: "already-migrated", credentialState: "missing" };
      if (input.expectedRevision !== document.revision) throw new Error("AI personal configuration: revision-conflict");
      if (input.operation === "connection") {
        const previous = document.connections.find((value) => value.id === input.connection.id);
        if (previous && (previous.baseUrl !== input.connection.baseUrl || JSON.stringify(previous.auth) !== JSON.stringify(input.connection.auth))) {
          credentialStates.set(input.connection.id, "missing");
        }
        document = AiConfigDocumentSchema.parse({ ...document, revision: document.revision + 1,
          connections: [...document.connections.filter((value) => value.id !== input.connection.id), { ...input.connection, revision: (previous?.revision ?? 0) + 1 }] });
      } else if (input.operation === "credential") {
        if (!document.connections.some((value) => value.id === input.connectionId)) throw new Error("连接不存在");
        if (input.mode === "persistent" && options.backend === "unavailable") throw new Error("AI personal configuration: secure-backend-unavailable");
        credentialStates.set(input.connectionId, input.mode === "session-only" ? "session-only" : "available");
        if (input.mode === "persistent") document = { ...document, revision: document.revision + 1,
          connections: document.connections.map(value => value.id === input.connectionId ? { ...value, revision: value.revision + 1 } : value) };
      } else {
        const { operation: _operation, expectedRevision: _expectedRevision, ...preferences } = input;
        document = AiConfigDocumentSchema.parse({ ...document, ...preferences,
          ...(preferences.models ? { models: preferences.models.map(value => ({ ...value, revision: (document.models.find(old => old.id === value.id)?.revision ?? 0) + 1 })) } : {}),
          revision: document.revision + 1 });
      }
      return read();
    },
    aiCatalogReload: async () => {
      catalogActions.push({ operation: "reload" });
      const result = loadAiProviderCatalog(builtinCatalog, [...providerFiles.values()], lastCatalog);
      lastCatalog = result.catalog;
      return result;
    },
    aiCatalogImport: async raw => {
      const input = AiCatalogImportSchema.parse(raw);
      catalogActions.push({ operation: "import", apply: input.apply, confirmConflicts: input.confirmConflicts });
      const current = loadAiProviderCatalog(builtinCatalog, [...providerFiles.values()], lastCatalog);
      const nextFiles = new Map(providerFiles);
      nextFiles.set(input.file, input.document);
      const result = loadAiProviderCatalog(builtinCatalog, [...nextFiles.values()], current.catalog);
      if (!input.apply) return { ...result, conflicts: [...result.diff.updated] };
      if (result.errors.length) throw new Error("AI personal configuration: invalid-catalog");
      if (result.diff.updated.length && !input.confirmConflicts) throw new Error("AI personal configuration: catalog-conflict");
      providerFiles.set(input.file, structuredClone(input.document));
      lastCatalog = result.catalog;
      return result;
    },
    aiConnectionTest: async ({ modelProfileId }) => {
      if (!document.models.some((value) => value.id === modelProfileId)) throw new Error("模型不存在");
      networkActions.push(`test:${modelProfileId}`);
      return { ok: true };
    },
    aiDiscover: async ({ connectionId }) => {
      if (!document.connections.some((value) => value.id === connectionId)) throw new Error("连接不存在");
      networkActions.push(`discover:${connectionId}`);
      return { status: "unsupported", models: [], reason: "manual-model-configuration-required" };
    },
    aiCancel: async () => ({ cancelled: true }),
  } satisfies Pick<ApiccApi, "aiSettingsRead" | "aiSettingsWrite" | "aiCatalogReload" | "aiCatalogImport" | "aiConnectionTest" | "aiDiscover" | "aiCancel">;
  const api = createMemoryApi();
  Object.assign(api, safeMethods);
  return { api, read, networkActions, catalogActions };
}
