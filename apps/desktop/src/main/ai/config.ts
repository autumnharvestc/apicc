/**
 * AI key 安全存储（M6-C 任务 1，规格 §2 D2 密钥边界）：Electron safeStorage 加密存取
 * AI API key，不可用时降级明文 + console.warn（沿用 online tokenStore 先例，D9 原文裁定）。
 * safeStorage 为形依赖——生产组合根（main.ts）传 `import { safeStorage } from "electron"`
 * 的真身，测试注入替身；本模块不直接 import electron，保证 vitest（node 环境）可加载。
 *
 * 与 online tokenStore 的差异：AI 配置单端点（一次一套 baseUrl/model/key，无 baseUrl
 * 索引），文件恒单凭据 `{encrypted,token,checksum}`。其余语义逐字对齐 tokenStore：
 * 存储位置 userData（dir 由组合根注入）；checksum = 明文 key 的 SHA-256，读回校验
 * （跨机器挪动 profile 解密不出原 key → null 引导重新配置，不把坏 key 当有效凭据）；
 * 文件缺失/非 JSON/形状不符一律 null + warn，不抛。baseUrl/model 不落本文件——它们是
 * 非敏感配置，由渲染层 localStorage 持久化（规格 §2 D2 桌面侧裁定）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SafeStorageLike } from "../online/tokenStore.js";

export interface AiKeyStoreDeps {
  /** 存储目录（生产 = app.getPath("userData")，测试 = 临时目录）。 */
  dir: string;
  /** safeStorage 实现（生产 = electron safeStorage，测试 = 替身）。 */
  storage: SafeStorageLike;
  /** 文件名（默认 ai-key.json）。 */
  fileName?: string;
}

export interface AiKeyStore {
  /** 保存 key（safeStorage 可用 → 密文；不可用 → 明文 + console.warn 降级）；重复保存覆盖。 */
  save(key: string): void;
  /** 读回 key；文件缺失/损坏/形状不符/校验不符 → null（引导重新配置，不抛）。 */
  load(): string | null;
  /** 清除凭据（文件随之移除）；无凭据时静默。 */
  clear(): void;
}

interface PersistedKey {
  encrypted: boolean;
  token: string;
  /** 明文 key 的 SHA-256 hex，用于读回完整性校验。 */
  checksum: string;
}

const DEFAULT_FILE_NAME = "ai-key.json";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 持久化条目形状守卫：字段缺失/类型不符 → null（损坏一律 null + warn，不抛）。 */
function asPersistedKey(value: unknown): PersistedKey | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PersistedKey>;
  if (typeof candidate.encrypted !== "boolean") return null;
  if (typeof candidate.token !== "string") return null;
  if (typeof candidate.checksum !== "string") return null;
  return { encrypted: candidate.encrypted, token: candidate.token, checksum: candidate.checksum };
}

export function createAiKeyStore(deps: AiKeyStoreDeps): AiKeyStore {
  const file = join(deps.dir, deps.fileName ?? DEFAULT_FILE_NAME);

  /** 读持久化条目；文件缺失 → null（静默）；非 JSON / 形状不符 → null + warn。 */
  function readKey(): PersistedKey | null {
    if (!existsSync(file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      console.warn(`AI 密钥文件损坏，已忽略（${file}）: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    const persisted = asPersistedKey(parsed);
    if (!persisted) {
      console.warn("AI 密钥文件形状不符，已忽略（请重新配置 AI 设置）");
      return null;
    }
    return persisted;
  }

  return {
    save(key: string): void {
      const checksum = sha256(key);
      let persisted: PersistedKey;
      if (deps.storage.isEncryptionAvailable()) {
        persisted = { encrypted: true, token: deps.storage.encryptString(key).toString("base64"), checksum };
      } else {
        console.warn("safeStorage 不可用，AI 密钥将以明文存储（建议检查系统钥匙串/密钥环环境）");
        persisted = { encrypted: false, token: key, checksum };
      }
      writeFileSync(file, JSON.stringify(persisted, null, 2), "utf8");
    },

    load(): string | null {
      const persisted = readKey();
      if (!persisted) return null;
      let key: string;
      if (persisted.encrypted) {
        try {
          key = deps.storage.decryptString(Buffer.from(persisted.token, "base64"));
        } catch (e) {
          console.warn(`AI 密钥解密失败，请重新配置: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }
      } else {
        key = persisted.token;
      }
      // 完整性校验：跨机器密钥不匹配会解密出垃圾串，sha256 对不上 → 视为无凭据。
      if (sha256(key) !== persisted.checksum) {
        console.warn("AI 密钥校验不符（可能跨机器挪动），请重新配置");
        return null;
      }
      return key;
    },

    clear(): void {
      if (!existsSync(file)) return;
      try {
        rmSync(file, { force: true });
      } catch (e) {
        console.warn(`AI 密钥清理失败（${file}）: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
