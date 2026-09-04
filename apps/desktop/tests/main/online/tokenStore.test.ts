// M3-B 任务 2（裁定 A/B）：tokenStore 按 baseUrl 索引多凭据 + 形状守卫测试——
// safeStorage 可用（密文）/不可用（明文 + console.warn 降级）两路，storage 替身注入，
// 文件落在临时目录（真实 fs 往返 + 重启读回）。旧单凭据格式（无 servers 字段）作废重登
// （裁定 A 选型：实现简单者——旧文件校验失败本就降级 null，直接作废不迁移）。
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
const SERVER_A = "http://127.0.0.1:8080";
const SERVER_B = "http://192.168.1.10:8080";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tokenStore（按 baseUrl 索引多凭据，任务 2 裁定 A）", () => {
  it("save/load 按 baseUrl 隔离：两服务器各自存取互不影响，文件不含明文", () => {
    const dir = newDir();
    const store = createTokenStore({ dir, storage: availableStorage });
    store.save(SERVER_A, "tok-a");
    store.save(SERVER_B, "tok-b");
    const raw = readFileSync(join(dir, "online-token.json"), "utf8");
    expect(raw).not.toContain("tok-a");
    expect(raw).not.toContain("tok-b");
    expect(store.load(SERVER_A)).toBe("tok-a");
    expect(store.load(SERVER_B)).toBe("tok-b");
    expect(store.load("http://unknown:1")).toBeNull();
  });

  it("同 baseUrl 重复 save 覆盖旧凭据；跨实例（重启语义）读回", () => {
    const dir = newDir();
    createTokenStore({ dir, storage: availableStorage }).save(SERVER_A, "tok-old");
    createTokenStore({ dir, storage: availableStorage }).save(SERVER_A, "tok-new");
    expect(createTokenStore({ dir, storage: availableStorage }).load(SERVER_A)).toBe("tok-new");
  });

  it("不可用：save 降级明文 + console.warn，load 读回原 token", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createTokenStore({ dir, storage: unavailableStorage });
    store.save(SERVER_A, "tok-plain-456");
    const persisted = JSON.parse(readFileSync(join(dir, "online-token.json"), "utf8")) as { servers: Record<string, { encrypted: boolean; token: string }> };
    expect(persisted.servers[SERVER_A]).toMatchObject({ encrypted: false, token: "tok-plain-456" });
    expect(store.load(SERVER_A)).toBe("tok-plain-456");
    expect(warn).toHaveBeenCalled();
  });

  it("clear(baseUrl) 只清该服务器凭据：另一服务器保留；全部清空后文件移除", () => {
    const dir = newDir();
    const store = createTokenStore({ dir, storage: availableStorage });
    store.save(SERVER_A, "tok-a");
    store.save(SERVER_B, "tok-b");
    store.clear(SERVER_A);
    expect(store.load(SERVER_A)).toBeNull();
    expect(store.load(SERVER_B)).toBe("tok-b");
    store.clear(SERVER_B);
    expect(existsSync(join(dir, "online-token.json"))).toBe(false);
    // 清空后再 clear（文件不存在）不抛
    expect(() => store.clear(SERVER_A)).not.toThrow();
  });

  it("load：文件缺失 / 非 JSON（损坏）/ 旧单凭据格式（无 servers 字段）→ null + warn（旧文件作废重登）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createTokenStore({ dir, storage: availableStorage });
    expect(store.load(SERVER_A)).toBeNull();
    // 非 JSON
    writeFileSync(join(dir, "online-token.json"), "not-json{", "utf8");
    expect(store.load(SERVER_A)).toBeNull();
    // 旧格式（任务 1 单凭据文件：顶层 {encrypted,token,checksum}）：作废重登，不抛不迁移
    writeFileSync(join(dir, "online-token.json"), JSON.stringify({ encrypted: false, token: "legacy", checksum: "x" }), "utf8");
    expect(store.load(SERVER_A)).toBeNull();
    expect(warn).toHaveBeenCalled();
    // 作废后 save 正常写入新格式
    store.save(SERVER_A, "tok-fresh");
    expect(store.load(SERVER_A)).toBe("tok-fresh");
  });

  it("形状守卫（裁定 B①）：合法 JSON 但 servers 条目缺字段 / servers 不是对象 → null + warn 不抛", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createTokenStore({ dir, storage: availableStorage });
    // servers 内条目缺 checksum 字段
    writeFileSync(join(dir, "online-token.json"), JSON.stringify({ servers: { [SERVER_A]: { encrypted: false, token: "t" } } }), "utf8");
    expect(store.load(SERVER_A)).toBeNull();
    // servers 不是对象（数组）
    writeFileSync(join(dir, "online-token.json"), JSON.stringify({ servers: [] }), "utf8");
    expect(store.load(SERVER_A)).toBeNull();
    expect(warn).toHaveBeenCalled();
    // 守卫后 save 不被坏数据污染
    store.save(SERVER_A, "tok-after-guard");
    expect(store.load(SERVER_A)).toBe("tok-after-guard");
  });

  it("密文解密失败（跨机器 profile 挪动等）/ checksum 不符 → 该服务器 null + warn，其它服务器不受影响", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = newDir();
    const store = createTokenStore({ dir, storage: availableStorage });
    store.save(SERVER_A, "tok-a");
    store.save(SERVER_B, "tok-b");
    // 篡改 A 的密文为非法 base64 密文（checksum 仍是 A 的，解密先失败）
    const persisted = JSON.parse(readFileSync(join(dir, "online-token.json"), "utf8")) as { servers: Record<string, { token: string }> };
    persisted.servers[SERVER_A]!.token = "!!!不是base64密文!!!";
    writeFileSync(join(dir, "online-token.json"), JSON.stringify(persisted), "utf8");
    expect(store.load(SERVER_A)).toBeNull();
    expect(store.load(SERVER_B)).toBe("tok-b");
    expect(warn).toHaveBeenCalled();
  });
});
