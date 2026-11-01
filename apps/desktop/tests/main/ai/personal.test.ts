import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopAiPersonal, createDesktopAiSecretBackend, createLegacyAiConfirmation } from "../../../src/main/ai/personal.js";

const dirs: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), "apicc-t9-personal-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
export const storage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(Buffer.from(value).toString("base64")), decryptString: (value: Buffer) => Buffer.from(value.toString(), "base64").toString() };
export const connection = { id: "c", revision: 1, name: "Personal", owner: { kind: "personal" as const }, baseUrl: "https://ai.example/v1", auth: { kind: "bearer" as const }, protocols: ["openai-chat-completions" as const], headers: {} };

describe("desktop personal AI host", () => {
  it("uses Windows sync encryption without invoking the Linux-only backend selector", async () => {
    let selections = 0;
    const win = createDesktopAiSecretBackend({ privateRoot: root(), platform: "win32", storage: { ...storage, getSelectedStorageBackend() { selections++; throw new Error("Linux-only API"); } } });
    const ref = await win.put("sk-win-synthetic", "a", "persistent"); expect(await win.get(ref, "a")).toBe("sk-win-synthetic"); expect(selections).toBe(0);
  });
  it("requires a recognized secure Linux backend instead of treating an arbitrary selector value as safe", async () => {
    const linux = createDesktopAiSecretBackend({ privateRoot: root(), platform: "linux", storage: { ...storage, getSelectedStorageBackend: () => "unexpected-backend" } });
    expect(linux.availability).toBe("unavailable"); await expect(linux.put("sk-not-safe", "a", "persistent")).rejects.toThrow();
    const secure = createDesktopAiSecretBackend({ privateRoot: root(), platform: "linux", storage: { ...storage, getSelectedStorageBackend: () => "gnome_libsecret" } });
    const linuxRef = await secure.put("sk-linux-synthetic", "a", "persistent"); expect(await secure.get(linuxRef, "a")).toBe("sk-linux-synthetic");
  });
  // Catch persistence losing either the audience binding or ciphertext round-trip.
  it("stores an encrypted fresh reference bound to its audience across backend instances", async () => {
    const privateRoot = root();
    const backend = createDesktopAiSecretBackend({ privateRoot, storage, platform: "win32" });
    const ref = await backend.put("sk-personal-synthetic", "audience-a", "persistent");
    expect(await createDesktopAiSecretBackend({ privateRoot, storage, platform: "win32" }).get(ref, "audience-a")).toBe("sk-personal-synthetic");
    expect(await backend.get(ref, "audience-b")).toBeUndefined();
    const files = readdirSync(join(privateRoot, "secrets"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(privateRoot, "secrets", files[0]!), "utf8")).not.toContain("sk-personal-synthetic");
  });

  // Catch public serialization of credentialRef/key, blind replacement of the
  // authoritative connections during preferences CAS, and cross-host root writes.
  it("saves device settings without a project and preserves refs through preferences CAS in an isolated desktop root", async () => {
    const parent = root(), privateRoot = join(parent, "desktop-userData", "ai"), cliRoot = join(parent, "home", ".apicc", "ai");
    mkdirSync(cliRoot, { recursive: true });
    const cliSentinel = '{"credentialRef":"ai-secret:cli-unchanged"}';
    writeFileSync(join(cliRoot, "config.v1.json"), cliSentinel);
    const personal = createDesktopAiPersonal({ privateRoot, storage, platform: "win32" });
    expect((await personal.read()).connections).toEqual([]);
    await personal.write({ operation: "connection", expectedRevision: 1, connection }, {});
    await personal.write({ operation: "credential", expectedRevision: 2, connectionId: "c", value: "sk-host-synthetic", mode: "persistent" }, {});
    const before = await personal.repository.read();
    expect(before.connections[0]!.credentialRef).toBeTruthy();
    await personal.write({ operation: "preferences", expectedRevision: 3, models: [] }, {});
    expect((await personal.repository.read()).connections[0]!.credentialRef).toBe(before.connections[0]!.credentialRef);
    const view = await personal.read();
    expect(view).toMatchObject({ scope: "desktop-device-personal", revision: 4, connections: [{ id: "c", credentialState: "available" }] });
    expect(JSON.stringify(view)).not.toMatch(/credentialRef|sk-host-synthetic|ai-secret:/);
    expect(readFileSync(join(cliRoot, "config.v1.json"), "utf8")).toBe(cliSentinel);
    await expect(personal.write({ operation: "preferences", expectedRevision: 3, models: [] }, {})).rejects.toThrow(/revision-conflict/);
    expect(existsSync(join(privateRoot, "config.v1.json"))).toBe(true);
  });

  it("never reads the old key before native confirmation; changed captured address or closed owner cancels migration", async () => {
    const owner = {}; let oldReads = 0, candidate = { baseUrl: "https://old.example/v1", model: "old-model" }, alive = true;
    let accept = false, mutate = false;
    const confirmLegacy = createLegacyAiConfirmation({ readConfiguration: async () => candidate, isAlive: () => alive,
      confirmAddress: async (_owner, address) => { expect(address).toBe("https://old.example/v1"); if (mutate) candidate = { ...candidate, baseUrl: "https://changed.example/v1" }; return accept ? { confirmed: true, insecureLocalTest: false } : { confirmed: false, insecureLocalTest: false }; } });
    const personal = createDesktopAiPersonal({ privateRoot: root(), storage, platform: "win32", confirmLegacy, legacyKeyStore: { load() { oldReads++; return "sk-old-synthetic"; }, clear() {}, save() {} } });
    expect(await personal.write({ operation: "migrate-legacy" }, owner)).toMatchObject({ status: "confirmation-required" });
    expect(oldReads).toBe(0);
    accept = true; mutate = true;
    expect(await personal.write({ operation: "migrate-legacy" }, owner)).toMatchObject({ status: "confirmation-required" });
    expect(oldReads).toBe(0);
    mutate = false; candidate = { baseUrl: "https://old.example/v1", model: "old-model" }; alive = false;
    expect(await personal.write({ operation: "migrate-legacy" }, owner)).toMatchObject({ status: "confirmation-required" }); expect(oldReads).toBe(0);
    alive = true;
    expect(await personal.write({ operation: "migrate-legacy" }, owner)).toMatchObject({ status: "migrated", credentialState: "available" });
    expect(oldReads).toBe(1);
    expect(await personal.write({ operation: "migrate-legacy" }, owner)).toMatchObject({ status: "already-migrated" }); expect(oldReads).toBe(1);
    expect((await personal.read()).connections[0]!.baseUrl).toBe("https://old.example/v1");
  });

  it("rechecks storage when put actually runs and supports explicit RAM-only credentials without a secure backend", async () => {
    let available = true;
    const privateRoot = root(), mutable = { ...storage, isEncryptionAvailable: () => available };
    const backend = createDesktopAiSecretBackend({ privateRoot, storage: mutable, platform: "win32" });
    expect(backend.availability).toBe("available"); available = false;
    await expect(backend.put("sk-not-written", "a", "persistent")).rejects.toThrow();
    expect(readdirSync(join(privateRoot, "secrets"))).toEqual([]);
    const personal = createDesktopAiPersonal({ privateRoot, storage: mutable, platform: "win32" });
    await personal.write({ operation: "connection", expectedRevision: 1, connection }, {});
    await expect(personal.write({ operation: "credential", expectedRevision: 2, connectionId: "c", value: "sk-not-written", mode: "persistent" }, {})).rejects.toThrow(/secure-backend-unavailable/);
    await personal.write({ operation: "credential", expectedRevision: 2, connectionId: "c", value: "sk-ram-synthetic", mode: "session-only" }, {});
    expect((await personal.read()).connections[0]!.credentialState).toBe("session-only");
    expect(readFileSync(join(privateRoot, "config.v1.json"), "utf8")).not.toContain("sk-ram-synthetic");
  });
  it("rechecks native confirmation at the actual legacy-key read after asynchronous repository work", async () => {
    let alive = true, reads = 0, repositoryReads = 0;
    const confirmLegacy = createLegacyAiConfirmation({ readConfiguration: async () => ({ baseUrl: "https://old.example/v1", model: "old" }), isAlive: () => alive,
      confirmAddress: async () => ({ confirmed: true, insecureLocalTest: false }) });
    const personal = createDesktopAiPersonal({ privateRoot: root(), storage, platform: "win32", confirmLegacy, legacyKeyStore: { load() { reads++; return "sk-race-synthetic"; }, clear() {}, save() {} } });
    const original = personal.repository.read;
    personal.repository.read = async () => { const value = await original(); if (++repositoryReads === 2) alive = false; return value; };
    await personal.write({ operation: "migrate-legacy" }, {});
    expect(reads).toBe(0);
  });
});
