import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createAiKeyStore } from "../../../src/main/ai/config.js";
const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(), userData: "", decrypts: 0,
  confirm: undefined as undefined | ((options: Record<string, unknown>) => Promise<{ response: number; checkboxChecked?: boolean }>) }));
vi.mock("electron", () => {
  class BrowserWindow {
    webContents = { send() {}, ipc: { on() {}, removeListener() {} } };
    loadURL() {} loadFile() {} on() { return this; } destroy() {}
    static getAllWindows() { return []; }
    static fromWebContents() { return {}; }
  }
  return { app: { whenReady: () => Promise.resolve(), on() {}, getPath: () => electron.userData, quit() {} }, BrowserWindow,
    ipcMain: { handle(channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) { electron.handlers.set(channel, handler); } },
    dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }), showMessageBox: async (_parent: unknown, options: Record<string, unknown>) => electron.confirm?.(options) ?? { response: 0 } },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret", encryptString: (v: string) => Buffer.from(Buffer.from(v).toString("base64")), decryptString: (v: Buffer) => { electron.decrypts++; return Buffer.from(v.toString(), "base64").toString(); } }, shell: { openExternal: async () => {} },
  };
});
it.each(["win32", "linux"] as const)("final I7 the real main composition persists under its isolated root on %s", async platform => {
  const root = mkdtempSync(join(tmpdir(), "apicc-t9-main-")), previous = process.env.APICC_SMOKE_ISOLATED_ROOT;
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  electron.userData = join(root, "must-not-touch-real-userData"); process.env.APICC_SMOKE_ISOLATED_ROOT = join(root, "isolated");
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    electron.handlers.clear(); vi.resetModules();
    await import("../../../src/main/main.js");
    await vi.waitFor(() => expect(electron.handlers.has("ai:settings-write")).toBe(true));
    const event = { sender: new EventEmitter() }, write = electron.handlers.get("ai:settings-write")!;
    await write(event, { operation: "connection", expectedRevision: 1, connection: { id: "c", revision: 1, name: "Main", owner: { kind: "personal" }, baseUrl: "https://ai.example/v1", protocols: ["openai-chat-completions"], auth: { kind: "bearer" }, headers: {} } });
    let failure: unknown;
    try { await write(event, { operation: "credential", expectedRevision: 2, connectionId: "c", value: "sk-main-synthetic", mode: "persistent" }); } catch (error) { failure = error; }
    expect(failure).toBeUndefined();
    expect(existsSync(join(root, "isolated", "ai", "config.v1.json"))).toBe(true);
    expect(existsSync(electron.userData)).toBe(false);
    const secretRoot = join(root, "isolated", "ai", "secrets");
    expect(readFileSync(join(secretRoot, readdirSync(secretRoot)[0]!), "utf8")).not.toContain("sk-main-synthetic");
  } finally { Object.defineProperty(process, "platform", descriptor); if (previous === undefined) delete process.env.APICC_SMOKE_ISOLATED_ROOT; else process.env.APICC_SMOKE_ISOLATED_ROOT = previous; rmSync(root, { recursive: true, force: true }); }
});

// Final I10: exercise the actual main dialog composition and migration IPC.
// The native modal is the only external seam; no renderer confirmation is trusted.
it("final I10 main legacy confirmation is bilingual, complete, default cancelled and reads no old key before confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "apicc-final-confirm-")), previous = process.env.APICC_SMOKE_ISOLATED_ROOT;
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalAddress = `http://127.0.0.1:65432/${"long-gateway/".repeat(20)}v1`;
  let options!: Record<string, unknown>, enter!: () => void, finish!: (choice: { response: number; checkboxChecked?: boolean }) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), choice = new Promise<{ response: number; checkboxChecked?: boolean }>(resolve => { finish = resolve; });
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    electron.handlers.clear(); electron.decrypts = 0; vi.resetModules();
    electron.userData = join(root, "must-not-touch-userData"); process.env.APICC_SMOKE_ISOLATED_ROOT = join(root, "isolated");
    mkdirSync(join(root, "isolated", "legacy-ai"), { recursive: true });
    createAiKeyStore({ dir: join(root, "isolated", "legacy-ai"), platform: "win32", storage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(Buffer.from(value).toString("base64")), decryptString: value => Buffer.from(value.toString(), "base64").toString() } }).save("SYNTHETIC_OLD_MAIN_KEY");
    electron.confirm = async value => { options = value; enter(); return choice; };
    await import("../../../src/main/main.js");
    await vi.waitFor(() => expect(electron.handlers.has("ai:settings-write")).toBe(true));
    const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: async () => ({ baseUrl: originalAddress, model: "legacy-model" }) });
    const pending = electron.handlers.get("ai:settings-write")!({ sender: owner }, { operation: "migrate-legacy" });
    await entered;
    expect(electron.decrypts).toBe(0);
    expect(options.detail).toBe(originalAddress); expect(options.defaultId).toBe(0); expect(options.cancelId).toBe(0); expect(options.checkboxChecked).toBe(false);
    finish({ response: 0, checkboxChecked: false });
    expect(await pending).toMatchObject({ status: "confirmation-required" }); expect(electron.decrypts).toBe(0);
    expect.soft(options.title).toMatch(/迁移/); expect.soft(options.title).toMatch(/migrat/i);
    expect.soft(options.message).toMatch(/原先|原地址/); expect.soft(options.message).toMatch(/original|previous/i);
    expect.soft(String((options.buttons as string[])[0])).toMatch(/cancel/i);
    expect.soft(String((options.buttons as string[])[1])).toMatch(/confirm|migrat/i);
    expect.soft(options.checkboxLabel).toMatch(/loopback/i); expect.soft(options.checkboxLabel).toContain("localhost / 127.0.0.1 / ::1");
    expect(existsSync(electron.userData)).toBe(false);
  } finally {
    finish?.({ response: 0 }); electron.confirm = undefined; Object.defineProperty(process, "platform", descriptor);
    if (previous === undefined) delete process.env.APICC_SMOKE_ISOLATED_ROOT; else process.env.APICC_SMOKE_ISOLATED_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
