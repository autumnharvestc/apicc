// M3-B 任务 1：tokenStore 测试——safeStorage 可用（密文）/不可用（明文 + console.warn 降级）两路，
// storage 替身注入，文件落在临时目录（真实 fs 往返 + 重启读回）。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTokenStore, type SafeStorageLike } from "../../../src/main/online/tokenStore.js";

/** 可用替身：encryptString 产出 base64 密文 Buffer（与明文可区分），decryptString 逆向。 */
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

const newDir = () => mkdtempSync(join(tmpdir(), "apicc-token-"));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tokenStore（safeStorage 注入替身）", () => {
  it("可用：save 落密文文件（不含明文），load 读回原 token，跨实例（重启语义）可读", () => {
    const dir = newDir();
    const store = createTokenStore({ dir, storage: availableStorage });
    store.save("tok-secret-123");
    const file = join(dir, "online-token.json");
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("tok-secret-123");
    const persisted = JSON.parse(raw) as { encrypted: boolean; token: string };
    expect(persisted.encrypted).toBe(true);
    expect(store.load()).toBe("tok-secret-123");
    // 重启语义：新实例同目录读回
    expect(createTokenStore({ dir, storage: availableStorage }).load()).toBe("tok-secret-123");
  });

  it("不可用：save 降级明文 + console.warn，load 读回原 token", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createTokenStore({ dir, storage: unavailableStorage });
    store.save("tok-plain-456");
    const persisted = JSON.parse(readFileSync(join(dir, "online-token.json"), "utf8")) as { encrypted: boolean; token: string };
    expect(persisted.encrypted).toBe(false);
    expect(persisted.token).toBe("tok-plain-456");
    expect(store.load()).toBe("tok-plain-456");
    expect(warn).toHaveBeenCalled();
  });

  it("clear 删除文件；load 缺失/损坏返回 null（损坏附 warn），clear 不存在文件不抛", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createTokenStore({ dir, storage: availableStorage });
    expect(store.load()).toBeNull();
    store.save("tok-1");
    store.clear();
    expect(store.load()).toBeNull();
    expect(() => store.clear()).not.toThrow();
    // 损坏文件：不是 JSON → null + warn（不崩溃，用户重新登录即可）
    writeFileSync(join(dir, "online-token.json"), "not-json{", "utf8");
    expect(store.load()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("密文文件在解密失败（跨机器 profile 挪动等）时返回 null + warn，不抛", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    writeFileSync(join(dir, "online-token.json"), JSON.stringify({ encrypted: true, token: "!!!不是base64密文!!!" }), "utf8");
    const store = createTokenStore({ dir, storage: availableStorage });
    expect(store.load()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
