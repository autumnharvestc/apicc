// M6-C 任务 1（规格 §2 D2 密钥边界）：AI key 安全存储单测——沿用 online tokenStore
// 形依赖注入、SHA-256 checksum 读回校验；T9 不可用时拒绝新持久化，不降级明文。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiKeyStore, type AiSafeStorageLike } from "../../../src/main/ai/config.js";

/** 可用替身：encryptString 产出 base64 密文（与明文可区分），decryptString 逆向。 */
const availableStorage: AiSafeStorageLike = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString: (plain) => Buffer.from(Buffer.from(plain, "utf8").toString("base64"), "utf8"),
  decryptString: (encrypted) => Buffer.from(encrypted.toString("utf8"), "base64").toString("utf8"),
};

/** 不可用替身：isEncryptionAvailable 恒 false（encrypt/decrypt 不应被调用）。 */
const unavailableStorage: AiSafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("不应调用 encryptString");
  },
  decryptString: () => {
    throw new Error("不应调用 decryptString");
  },
};

const newDir = () => mkdtempSync(join(tmpdir(), "apicc-aikey-"));
const FILE = "ai-key.json";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AiKeyStore（AI key 安全存储，D2）", () => {
  // Final I7: reuse the unchanged positive mock with explicit Linux intent.
  it("final I7 positive storage fixture can persist on the Linux production branch", () => {
    const dir = newDir(), store = createAiKeyStore({ dir, storage: availableStorage, platform: "linux" });
    try {
      let failure: unknown;
      try { store.save("SYNTHETIC_LINUX_POSITIVE_KEY"); } catch (error) { failure = error; }
      expect(failure).toBeUndefined();
      expect(store.load()).toBe("SYNTHETIC_LINUX_POSITIVE_KEY");
      expect(readFileSync(join(dir, FILE), "utf8")).not.toContain("SYNTHETIC_LINUX_POSITIVE_KEY");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("final I7 unknown Linux backend continues to refuse persistent credentials", () => {
    const dir = newDir(), store = createAiKeyStore({ dir, storage: { ...availableStorage, getSelectedStorageBackend: () => "unknown" }, platform: "linux" });
    try { expect(() => store.save("SYNTHETIC_UNKNOWN_BACKEND_KEY")).toThrow(/安全存储不可用/); expect(existsSync(join(dir, FILE))).toBe(false); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // Catch a new secret being persisted when encryption is absent or only Linux basic_text.
  // The OS keyring is the sole external seam; file writes and reads remain real.
  it.each([
    { name: "unavailable", storage: unavailableStorage },
    { name: "Linux basic_text", storage: { ...availableStorage, getSelectedStorageBackend: () => "basic_text" } },
  ])("T9 $name must not persist a newly supplied key", ({ storage }) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createAiKeyStore({ dir, storage, platform: "linux" });
    try {
      let failure: unknown;
      try { store.save("sk-t9-new-secret"); } catch (error) { failure = error; }
      expect(existsSync(join(dir, FILE))).toBe(false);
      expect(failure).toBeInstanceOf(Error);
      expect(store.load()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("save/load 往返：加密可用时文件不含明文 key", () => {
    const dir = newDir();
    const store = createAiKeyStore({ dir, storage: availableStorage });
    store.save("sk-secret-123");
    const raw = readFileSync(join(dir, FILE), "utf8");
    expect(raw).not.toContain("sk-secret-123");
    expect(store.load()).toBe("sk-secret-123");
  });

  it("重复 save 覆盖旧 key；跨实例（重启语义）读回", () => {
    const dir = newDir();
    createAiKeyStore({ dir, storage: availableStorage }).save("sk-old");
    createAiKeyStore({ dir, storage: availableStorage }).save("sk-new");
    expect(createAiKeyStore({ dir, storage: availableStorage }).load()).toBe("sk-new");
  });

  it("safeStorage 不可用：save 拒绝，且没有可读的新明文文件", () => {
    const dir = newDir();
    const store = createAiKeyStore({ dir, storage: unavailableStorage });
    expect(() => store.save("sk-plain-456")).toThrow(/安全存储不可用/);
    expect(existsSync(join(dir, FILE))).toBe(false); expect(store.load()).toBeNull();
  });

  it("clear 移除凭据文件；文件缺失时 clear 不抛", () => {
    const dir = newDir();
    const store = createAiKeyStore({ dir, storage: availableStorage });
    store.save("sk-a");
    store.clear();
    expect(existsSync(join(dir, FILE))).toBe(false);
    expect(store.load()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });

  it("load：文件缺失 / 非 JSON（损坏）→ null + warn，不抛", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createAiKeyStore({ dir, storage: availableStorage });
    expect(store.load()).toBeNull();
    writeFileSync(join(dir, FILE), "not-json{", "utf8");
    expect(store.load()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("形状守卫：合法 JSON 但缺字段 / 非对象 → null + warn，不抛", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createAiKeyStore({ dir, storage: availableStorage });
    writeFileSync(join(dir, FILE), JSON.stringify({ encrypted: false, token: "t" }), "utf8");
    expect(store.load()).toBeNull();
    writeFileSync(join(dir, FILE), JSON.stringify([1, 2]), "utf8");
    expect(store.load()).toBeNull();
    expect(warn).toHaveBeenCalled();
    // 守卫后 save 不被坏数据污染
    store.save("sk-after-guard");
    expect(store.load()).toBe("sk-after-guard");
  });

  it("密文解密失败 / checksum 不符 → null + warn（跨机器挪动 profile 引导重新配置）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createAiKeyStore({ dir, storage: availableStorage });
    store.save("sk-a");
    const persisted = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as { token: string; checksum: string };
    // 篡改密文为非法 base64 密文（checksum 仍是原 key 的，解密先失败）
    persisted.token = "!!!不是base64密文!!!";
    writeFileSync(join(dir, FILE), JSON.stringify(persisted), "utf8");
    expect(store.load()).toBeNull();
    // 篡改 checksum（解密成功但对不上）
    const fresh = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as { checksum: string };
    store.save("sk-b");
    const persistedB = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as { checksum: string };
    persistedB.checksum = "0".repeat(64);
    writeFileSync(join(dir, FILE), JSON.stringify(persistedB), "utf8");
    expect(store.load()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
