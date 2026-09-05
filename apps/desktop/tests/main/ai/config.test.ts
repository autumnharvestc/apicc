// M6-C 任务 1（规格 §2 D2 密钥边界）：AI key 安全存储单测——沿用 online tokenStore
// 先例（safeStorage 形依赖注入、userData 目录、SHA-256 checksum 读回校验、不可用降级
// 明文 + warn）。差异：AI 配置单端点，文件恒单凭据（无 baseUrl 索引）。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiKeyStore } from "../../../src/main/ai/config.js";
import type { SafeStorageLike } from "../../../src/main/online/tokenStore.js";

/** 可用替身：encryptString 产出 base64 密文（与明文可区分），decryptString 逆向。 */
const availableStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(Buffer.from(plain, "utf8").toString("base64"), "utf8"),
  decryptString: (encrypted) => Buffer.from(encrypted.toString("utf8"), "base64").toString("utf8"),
};

/** 不可用替身：isEncryptionAvailable 恒 false（encrypt/decrypt 不应被调用）。 */
const unavailableStorage: SafeStorageLike = {
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

  it("safeStorage 不可用：save 降级明文 + console.warn，load 读回原 key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createAiKeyStore({ dir, storage: unavailableStorage });
    store.save("sk-plain-456");
    const persisted = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as { encrypted: boolean; token: string };
    expect(persisted).toMatchObject({ encrypted: false, token: "sk-plain-456" });
    expect(store.load()).toBe("sk-plain-456");
    expect(warn).toHaveBeenCalled();
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
