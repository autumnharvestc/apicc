import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAiConfigRepository } from "../../../src/ai/host/repository.js";
import { createAiPersonalConfigHost } from "../../../src/ai/host/personal.js";
import { migrateLegacyAiConfig, selectAiCompatibilityInput, type AiLegacyMigrationOptions } from "../../../src/ai/host/migration.js";
import type { AiSecretBackend } from "../../../src/ai/host/secrets.js";
import { fixture as configuredDocument } from "../config.fixture.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "apicc-ai-t4-migrate-")); roots.push(root);
  const privateRoot = join(root, "private-ai"); await mkdir(privateRoot);
  const repository = createAiConfigRepository({ privateRoot });
  const values = new Map<string, { audience: string; value: string }>();
  let nextRef = 0;
  const secretBackend: AiSecretBackend = { availability: "available",
    async get(ref, audience) { const item = values.get(ref); return item?.audience === audience ? item.value : undefined; },
    async put(value, audience) { const ref = `legacy-secret-${++nextRef}`; values.set(ref, { value, audience }); return ref; },
    async remove(ref, audience) { if (values.get(ref)?.audience === audience) values.delete(ref); },
  };
  const input: AiLegacyMigrationOptions = { repository, secretBackend,
    source: { kind: "desktop-v1", async readConfiguration() { return { baseUrl: "https://old.test/gateway/v1/", model: "old-model" }; }, async readSecret() { return { state: "available", value: "synthetic-old-key" }; } },
    async confirmOriginalAddress() { return "https://old.test/gateway/v1"; },
  };
  return { root, privateRoot, repository, secretBackend, input };
}
// Catches protocol drift, missing purpose defaults, key disclosure, and key audience loss during migration.
it("migrates the confirmed original desktop root into a personal Chat Completions model and secure credential", async () => {
  const { input, repository, secretBackend } = await fixture();
  const result = await migrateLegacyAiConfig(input);
  expect(result).toMatchObject({ status: "migrated", credentialState: "available" });
  const document = await repository.read();
  expect(document.connections[0]).toMatchObject({ baseUrl: "https://old.test/gateway/v1", owner: { kind: "personal" }, protocols: ["openai-chat-completions"], revision: 1 });
  expect(document.models[0]).toMatchObject({ modelId: "old-model", protocol: "openai-chat-completions", connectionId: result.connectionId });
  expect(document.bindings).toEqual([
    { purpose: "case-suggestion", modelProfileId: result.modelProfileId, budgets: {} },
    { purpose: "assertion-suggestion", modelProfileId: result.modelProfileId, budgets: {} },
    { purpose: "report-analysis", modelProfileId: result.modelProfileId, budgets: {} },
  ]);
  expect(JSON.stringify({ result, document })).not.toContain("synthetic-old-key");
  const host = createAiPersonalConfigHost({ repository, secretBackend, catalog: [] });
  expect((await host.credentialResolver.resolve(document.connections[0]!)).headers).toEqual({ Authorization: "Bearer synthetic-old-key" });
});
// Catches duplicate migration or re-reading/rebinding an unbound legacy key after the first successful transfer.
it("is idempotent without re-reading the legacy key or incrementing revisions", async () => {
  const { input, repository } = await fixture();
  await migrateLegacyAiConfig(input);
  const before = await repository.read();
  input.source.readSecret = async () => { throw new Error("legacy secret must not be read again"); };
  expect(await migrateLegacyAiConfig(input)).toMatchObject({ status: "already-migrated" });
  expect(await repository.read()).toEqual(before);
});
// Catches acquiring an unbound legacy key on a renderer-supplied different root or missing confirmation.
it.each([undefined, "https://new.test/v1", "https://old.test/other/v1"])("does not read the legacy key without matching original-address confirmation: %j", async confirmation => {
  const { input, privateRoot } = await fixture();
  input.confirmOriginalAddress = async () => confirmation;
  input.source.readSecret = async () => { throw new Error("legacy key accessed before confirmation"); };
  expect(await migrateLegacyAiConfig(input)).toEqual({ status: "confirmation-required", credentialState: "missing" });
  expect(await readdir(privateRoot)).toEqual([]);
});
// Catches silently dropping legacy non-sensitive settings when encrypted credentials cannot be decrypted.
it("migrates non-sensitive settings and asks for a replacement when the old ciphertext is unavailable", async () => {
  const { input, repository } = await fixture();
  input.source.readSecret = async () => ({ state: "unavailable" });
  expect(await migrateLegacyAiConfig(input)).toMatchObject({ status: "migrated", credentialState: "unavailable" });
  expect((await repository.read()).connections[0]!.credentialRef).toBeUndefined();
});
// Catches creating partially configured models or reading secrets for unusable legacy settings.
it("reports incomplete legacy settings without reading the key or writing", async () => {
  const { input, privateRoot } = await fixture();
  input.source.readConfiguration = async () => ({ baseUrl: "https://old.test/v1" });
  input.source.readSecret = async () => { throw new Error("must not read incomplete source key"); };
  expect(await migrateLegacyAiConfig(input)).toEqual({ status: "needs-configuration", credentialState: "missing" });
  expect(await readdir(privateRoot)).toEqual([]);
});
// Catches automatic new plaintext persistence when the destination secure store is unavailable.
it("does not create a plaintext migration file when the secure backend is unavailable", async () => {
  const { input, privateRoot } = await fixture();
  input.secretBackend = { availability: "unavailable", async get() { return undefined; }, async put() { throw new Error("no fallback"); }, async remove() {} };
  expect(await migrateLegacyAiConfig(input)).toMatchObject({ status: "migrated", credentialState: "unavailable" });
  expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
  expect(await readFile(join(privateRoot, "config.v1.json"), "utf8")).not.toContain("synthetic-old-key");
});
// Catches deleting or copying legacy plaintext into a workspace as a side effect of explicit safe migration.
it("keeps an explicitly supplied old CLI plaintext file and never copies it into a project", async () => {
  const { input, root, repository, privateRoot } = await fixture();
  const legacyPath = join(root, "legacy-ai.json"), project = join(root, "synthetic-project"); await mkdir(project);
  const legacy = { baseUrl: "https://old.test/gateway/v1", apiKey: "synthetic-cli-key", model: "old-cli-model" };
  await writeFile(legacyPath, JSON.stringify(legacy));
  input.source = { kind: "cli-file-v1", async readConfiguration() { const raw = JSON.parse(await readFile(legacyPath, "utf8")); return { baseUrl: raw.baseUrl, model: raw.model }; }, async readSecret() { return { state: "available", value: JSON.parse(await readFile(legacyPath, "utf8")).apiKey }; } };
  expect(await migrateLegacyAiConfig(input)).toMatchObject({ status: "migrated", credentialState: "available" });
  expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual(legacy);
  expect(await readdir(project)).toEqual([]);
  expect((await repository.read()).models[0]!.modelId).toBe("old-cli-model");
  expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
});
// Catches reading fallback files or key material despite an explicit model selection.
it("prioritizes explicit profile selection without reading legacy file input", async () => {
  expect(await selectAiCompatibilityInput({ modelProfileId: "personal-profile", environment: { APICC_AI_BASE_URL: "partial" }, async readLegacyFile() { throw new Error("must not read fallback"); } })).toEqual({ kind: "profile", modelProfileId: "personal-profile" });
});
// Catches mixing file fields with environment fields rather than selecting one complete source.
it("uses the complete legacy environment triple before a legacy file", async () => {
  expect(await selectAiCompatibilityInput({ environment: { APICC_AI_BASE_URL: "https://env.test/v1", APICC_AI_API_KEY: "env-secret", APICC_AI_MODEL: "env-model" }, async readLegacyFile() { throw new Error("must not read lower source"); } })).toEqual({ kind: "legacy", source: "environment", configuration: { baseUrl: "https://env.test/v1", apiKey: "env-secret", model: "env-model" } });
});
// Catches a partial environment silently borrowing a key/model from the old file.
it.each([
  { APICC_AI_BASE_URL: "https://env.test/v1" },
  { APICC_AI_API_KEY: "env-secret", APICC_AI_MODEL: "env-model" },
])("rejects a mixed/partial legacy environment source: %j", async environment => {
  await expect(selectAiCompatibilityInput({ environment, async readLegacyFile() { return { baseUrl: "https://file.test/v1", apiKey: "file-secret", model: "file-model" }; } })).rejects.toMatchObject({ code: "incomplete-legacy-configuration" });
});
// Catches ignoring file compatibility when no explicit/environment input is present.
it("uses only a complete explicitly injected legacy file when higher priority inputs are absent", async () => {
  const configuration = { baseUrl: "https://file.test/v1", apiKey: "file-secret", model: "file-model" };
  expect(await selectAiCompatibilityInput({ environment: {}, async readLegacyFile() { return configuration; } })).toEqual({ kind: "legacy", source: "file", configuration });
});
// Catches treating an incomplete file as an empty new configuration.
it("rejects an incomplete injected legacy file", async () => {
  await expect(selectAiCompatibilityInput({ async readLegacyFile() { return { apiKey: "file-secret" }; } })).rejects.toMatchObject({ code: "incomplete-legacy-configuration" });
});
// Catches propagating decrypted/ciphertext exception text or aborting a settings-only recovery.
it("preserves settings and reports unavailable when the injected old key reader throws", async () => {
  const { input, repository } = await fixture();
  input.source.readSecret = async () => { throw new Error("synthetic-secret-reader-detail"); };
  const result = await migrateLegacyAiConfig(input);
  expect(result).toMatchObject({ status: "migrated", credentialState: "unavailable" });
  expect((await repository.read()).connections[0]!.credentialRef).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("synthetic-secret-reader-detail");
});
// Catches losing usable settings or leaking backend exception data when secure transfer fails.
it("records no secret reference when the destination secure backend fails", async () => {
  const { input, repository } = await fixture();
  input.secretBackend.put = async () => { throw new Error("synthetic-backend-key-detail"); };
  expect(await migrateLegacyAiConfig(input)).toMatchObject({ status: "migrated", credentialState: "unavailable" });
  expect((await repository.read()).connections[0]!.credentialRef).toBeUndefined();
});
// Catches replacing an existing user's purpose selection with the migrated model.
it("fills only unbound purposes and preserves existing personal defaults", async () => {
  const { input, repository } = await fixture();
  await repository.write(configuredDocument(), 1);
  expect(await migrateLegacyAiConfig(input)).toMatchObject({ status: "migrated" });
  const document = await repository.read();
  expect(document.bindings.find(b => b.purpose === "case-suggestion")!.modelProfileId).toBe("a");
  expect(document.bindings).toHaveLength(3);
});
// Catches treating a reserved-ID collision as a completed migration or overwriting user data.
it("rejects partial reserved migration identities without reading the old key", async () => {
  const { input, repository } = await fixture();
  const document = configuredDocument();
  document.connections.push({ ...document.connections[0]!, id: "legacy:desktop-v1:connection" });
  const before = await repository.write(document, 1);
  input.source.readSecret = async () => { throw new Error("must not acquire key for conflicting identity"); };
  await expect(migrateLegacyAiConfig(input)).rejects.toMatchObject({ code: "migration-conflict" });
  expect(await repository.read()).toEqual(before);
});
// Catches reporting a removed legacy credential as available merely because its reference persists.
it("checks current secure credential state on an idempotent migration", async () => {
  const { input, repository } = await fixture();
  await migrateLegacyAiConfig(input);
  const connection = (await repository.read()).connections[0]!;
  await input.secretBackend.remove(connection.credentialRef!, '[1,"legacy:desktop-v1:connection","https://old.test/gateway/v1","bearer",""]');
  expect(await migrateLegacyAiConfig(input)).toMatchObject({ status: "already-migrated", credentialState: "missing" });
});
// Catches writing invalid legacy plaintext as an HTTP credential during migration.
it("requires a replacement for an invalid legacy secret instead of persisting it", async () => {
  const { input, repository } = await fixture();
  input.source.readSecret = async () => ({ state: "available", value: "bad\r\nInjected: yes" });
  expect(await migrateLegacyAiConfig(input)).toMatchObject({ status: "migrated", credentialState: "unavailable" });
  expect((await repository.read()).connections[0]!.credentialRef).toBeUndefined();
});
// Catches leaving a transferred secret behind after repository revision rejection.
it("rolls back the newly transferred secret when migration loses the configuration CAS", async () => {
  const { input, repository } = await fixture();
  const put = input.secretBackend.put.bind(input.secretBackend);
  input.secretBackend.put = async (...args) => { const ref = await put(...args); await repository.write(await repository.read(), 1); return ref; };
  await expect(migrateLegacyAiConfig(input)).rejects.toMatchObject({ code: "revision-conflict" });
  expect(await input.secretBackend.get("legacy-secret-1", '[1,"legacy:desktop-v1:connection","https://old.test/gateway/v1","bearer",""]')).toBeUndefined();
  expect((await repository.read()).connections).toEqual([]);
});
// Catches leaking malformed legacy-file contents through an injected reader error.
it("reports unreadable legacy configuration without leaking its reader exception", async () => {
  const { input, privateRoot } = await fixture();
  input.source.readConfiguration = async () => { throw new Error("synthetic-secret-in-bad-json"); };
  expect(await migrateLegacyAiConfig(input)).toEqual({ status: "needs-configuration", credentialState: "missing" });
  expect(await readdir(privateRoot)).toEqual([]);
});
// Catches exposing private file parsing text through compatibility selection.
it("sanitizes a failed injected legacy file read", async () => {
  await expect(selectAiCompatibilityInput({ async readLegacyFile() { throw new Error("synthetic-secret-in-file"); } })).rejects.toMatchObject({ code: "invalid-legacy-file", message: expect.not.stringContaining("synthetic-secret") });
});
// Catches repeated legacy IO/confirmation prompts after the first completed migration.
it("recognizes a completed migration before reading old configuration or asking for confirmation again", async () => {
  const { input, repository } = await fixture();
  await migrateLegacyAiConfig(input);
  const before = await repository.read();
  input.source.readConfiguration = async () => { throw new Error("old file is no longer present"); };
  input.confirmOriginalAddress = async () => { throw new Error("must not ask again"); };
  expect(await migrateLegacyAiConfig(input)).toMatchObject({ status: "already-migrated", credentialState: "available" });
  expect(await repository.read()).toEqual(before);
});
// Catches refusing a current explicit loopback test choice or silently upgrading the legacy URL.
it("preserves an explicitly selected loopback HTTP test URL during migration", async () => {
  const { input, repository } = await fixture();
  input.insecureLocalTest = true;
  input.source.readConfiguration = async () => ({ baseUrl: "http://localhost:12345/gateway/v1/", model: "local-model" });
  input.confirmOriginalAddress = async () => "http://localhost:12345/gateway/v1";
  expect(await migrateLegacyAiConfig(input)).toMatchObject({ status: "migrated", credentialState: "available" });
  expect((await repository.read()).connections[0]).toMatchObject({ baseUrl: "http://localhost:12345/gateway/v1", insecureLocalTest: true });
});
// Catches inheriting a stale insecure flag from the old object instead of requiring the current host choice.
it("does not inherit an insecure local test flag from legacy data", async () => {
  const { input, privateRoot } = await fixture();
  input.source.readConfiguration = async () => ({ baseUrl: "http://localhost:12345/v1", model: "local-model", insecureLocalTest: true });
  input.source.readSecret = async () => { throw new Error("must not read key for unapproved HTTP"); };
  expect(await migrateLegacyAiConfig(input)).toEqual({ status: "needs-configuration", credentialState: "missing" });
  expect(await readdir(privateRoot)).toEqual([]);
});
// Catches treating the local-test choice as permission for production HTTP endpoints.
it("does not allow remote HTTP migration even with explicit local-test selection", async () => {
  const { input, privateRoot } = await fixture();
  input.insecureLocalTest = true;
  input.source.readConfiguration = async () => ({ baseUrl: "http://remote.test/v1", model: "remote-model" });
  input.source.readSecret = async () => { throw new Error("must not read key for remote HTTP"); };
  expect(await migrateLegacyAiConfig(input)).toEqual({ status: "needs-configuration", credentialState: "missing" });
  expect(await readdir(privateRoot)).toEqual([]);
});
// Catches local-test selection bypassing original-address confirmation.
it("still requires the confirmed original address for an explicit loopback HTTP migration", async () => {
  const { input, privateRoot } = await fixture();
  input.insecureLocalTest = true;
  input.source.readConfiguration = async () => ({ baseUrl: "http://localhost:12345/v1", model: "local-model" });
  input.source.readSecret = async () => { throw new Error("must not read key for a different confirmed root"); };
  input.confirmOriginalAddress = async () => "http://localhost:54321/v1";
  expect(await migrateLegacyAiConfig(input)).toEqual({ status: "confirmation-required", credentialState: "missing" });
  expect(await readdir(privateRoot)).toEqual([]);
});
