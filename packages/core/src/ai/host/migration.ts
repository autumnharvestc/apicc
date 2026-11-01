import { z } from "zod";
import { AiConnectionSchema, AiModelProfileSchema, AiPurposeSchema, aiCredentialAudience, type AiPurpose } from "../config.js";
import { AiConfigHostError, type AiConfigRepository } from "./repository.js";
import { isAiSecretValue, type AiSecretBackend, type AiSecretState } from "./secrets.js";
export interface AiLegacyConfiguration { baseUrl: string; model: string; purposes?: AiPurpose[] }
export interface AiLegacyMigrationSource {
  kind: "desktop-v1" | "cli-file-v1";
  /** Host-owned captures. Never delegate these callbacks or confirmation authority to renderer input. */
  readConfiguration(): Promise<unknown>;
  readSecret(): Promise<{ state: "available"; value: string } | { state: "missing" | "unavailable" }>;
}
export interface AiLegacyMigrationOptions {
  repository: AiConfigRepository; secretBackend: AiSecretBackend; source: AiLegacyMigrationSource;
  /** A current explicit trusted-host local-test choice; never inherited from legacy configuration. */
  insecureLocalTest?: boolean;
  /** Trusted host confirmation of the captured original API root, not a renderer boolean. */
  confirmOriginalAddress(baseUrl: string): Promise<string | undefined>;
}
export interface AiLegacyMigrationResult {
  status: "migrated" | "already-migrated" | "confirmation-required" | "needs-configuration";
  credentialState: AiSecretState; connectionId?: string; modelProfileId?: string;
}
const legacyConfiguration = z.object({ baseUrl: z.string().min(1), model: z.string().trim().min(1).max(256), purposes: z.array(AiPurposeSchema).optional() });
export async function migrateLegacyAiConfig(input: AiLegacyMigrationOptions): Promise<AiLegacyMigrationResult> {
  const connectionId = `legacy:${input.source.kind}:connection`, modelProfileId = `legacy:${input.source.kind}:model`;
  const document = await input.repository.read();
  const existingConnection = document.connections.find(c => c.id === connectionId), existingModel = document.models.find(m => m.id === modelProfileId);
  if (existingConnection && existingModel?.connectionId === connectionId) {
    let credentialState: AiSecretState = "missing";
    if (existingConnection.credentialRef) {
      credentialState = "unavailable";
      if (input.secretBackend.availability === "available") {
        try { credentialState = await input.secretBackend.get(existingConnection.credentialRef, aiCredentialAudience(existingConnection)) === undefined ? "missing" : "available"; }
        catch { /* Backend failures remain unavailable, never serialized. */ }
      }
    }
    return { status: "already-migrated", credentialState, connectionId, modelProfileId };
  }
  if (existingConnection || existingModel) throw new AiConfigHostError("migration-conflict");
  let raw: unknown;
  try { raw = await input.source.readConfiguration(); } catch { return { status: "needs-configuration", credentialState: "missing" }; }
  const parsed = legacyConfiguration.safeParse(raw);
  if (!parsed.success) return { status: "needs-configuration", credentialState: "missing" };
  const configuration = parsed.data;
  const connectionResult = AiConnectionSchema.safeParse({ id: connectionId, revision: 1, name: "Imported AI connection", owner: { kind: "personal" },
    baseUrl: configuration.baseUrl, auth: { kind: "bearer" }, protocols: ["openai-chat-completions"], headers: {},
    ...(input.insecureLocalTest === true ? { insecureLocalTest: true } : {}),
  });
  if (!connectionResult.success) return { status: "needs-configuration", credentialState: "missing" };
  const connection = connectionResult.data;
  const confirmation = await input.confirmOriginalAddress(connection.baseUrl);
  let confirmedRoot: string | undefined;
  try { confirmedRoot = confirmation ? new URL(confirmation).href.replace(/\/+$/, "") : undefined; } catch { /* Not a confirmation. */ }
  if (confirmedRoot !== new URL(connection.baseUrl).href.replace(/\/+$/, "")) return { status: "confirmation-required", credentialState: "missing" };
  let secret: Awaited<ReturnType<AiLegacyMigrationSource["readSecret"]>>;
  try { secret = await input.source.readSecret(); } catch { secret = { state: "unavailable" }; }
  let credentialState: AiSecretState = secret.state;
  if (secret.state === "available") {
    if (input.secretBackend.availability === "available" && isAiSecretValue(secret.value)) {
      try { connection.credentialRef = await input.secretBackend.put(secret.value, aiCredentialAudience(connection), "persistent"); }
      catch { credentialState = "unavailable"; }
    }
    else credentialState = "unavailable";
  }
  document.connections.push(connection);
  document.models.push(AiModelProfileSchema.parse({ id: modelProfileId, revision: 1, connectionId, modelId: configuration.model,
    protocol: "openai-chat-completions", structuredOutput: "prompt-json", streaming: false, supportedParameters: [],
    capabilities: { status: "unconfirmed", source: "legacy-migration" }, budgets: {}, purposeBudgets: {},
  }));
  document.bindings.push(...(configuration.purposes ?? ["case-suggestion", "assertion-suggestion", "report-analysis"] as const).filter(purpose => !document.bindings.some(binding => binding.purpose === purpose)).map(purpose => ({ purpose, modelProfileId, budgets: {} })));
  try { await input.repository.write(document, document.revision); }
  catch (error) {
    if (connection.credentialRef) await input.secretBackend.remove(connection.credentialRef, aiCredentialAudience(connection)).catch(() => undefined);
    throw error;
  }
  return { status: "migrated", credentialState, connectionId, modelProfileId };
}
export interface AiLegacyCliConfiguration { baseUrl: string; apiKey: string; model: string }
export type AiCompatibilitySelection = { kind: "profile"; modelProfileId: string } | { kind: "legacy"; source: "environment" | "file"; configuration: AiLegacyCliConfiguration };
/** Trusted compatibility seam only: returned legacy values contain a secret, never a renderer DTO. */
export async function selectAiCompatibilityInput(input: {
  modelProfileId?: string; environment?: Record<string, string | undefined>; readLegacyFile?: () => Promise<unknown>;
}): Promise<AiCompatibilitySelection | undefined> {
  if (input.modelProfileId) return { kind: "profile", modelProfileId: input.modelProfileId };
  const env = input.environment ?? {};
  const triple = { baseUrl: env.APICC_AI_BASE_URL, apiKey: env.APICC_AI_API_KEY, model: env.APICC_AI_MODEL };
  function complete(raw: unknown): AiLegacyCliConfiguration {
    const parsed = z.object({ baseUrl: z.string().min(1), apiKey: z.string().min(1), model: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) throw new AiConfigHostError("incomplete-legacy-configuration");
    return parsed.data;
  }
  if (Object.values(triple).some(v => v !== undefined)) return { kind: "legacy", source: "environment", configuration: complete(triple) };
  let file: unknown;
  try { file = await input.readLegacyFile?.(); } catch { throw new AiConfigHostError("invalid-legacy-file"); }
  if (file === undefined) return undefined;
  return { kind: "legacy", source: "file", configuration: complete(file) };
}
