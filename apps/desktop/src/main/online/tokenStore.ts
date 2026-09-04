/**
 * token 安全存储（M3-B 任务 1，规格 §2 D9）：Electron safeStorage 加密存取登录 token，
 * 不可用时降级明文 + console.warn（D9 原文裁定）。safeStorage 为形依赖（简报裁定 ④）——
 * 生产组合根（main.ts）传 `import { safeStorage } from "electron"` 的真身，测试注入替身；
 * 本模块不直接 import electron，保证 vitest（node 环境）可加载。
 *
 * 存储位置裁定（简报裁定 ⑤）：文件放 `app.getPath("userData")`（dir 由组合根注入）——
 * 与既有会话偏好（渲染层 localStorage 存主题/语言）不同层：token 是 main 进程敏感凭据，
 * 必须留在 main 侧且随用户数据目录漫游/备份隔离，不能进渲染层 localStorage（XSS 面大、
 * 无加密）。文件内容 `{ encrypted, token, checksum }`：checksum = 明文 token 的 SHA-256，
 * 读回时校验——跨机器挪动 profile 导致密钥不匹配、解密出垃圾串时返回 null 引导重新登录，
 * 而不是把坏 token 当有效凭据发出去。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Electron safeStorage 的结构同形子集（生产传 electron 的 safeStorage 真身）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface TokenStoreDeps {
  /** 存储目录（生产 = app.getPath("userData")，测试 = 临时目录）。 */
  dir: string;
  /** safeStorage 实现（生产 = electron safeStorage，测试 = 替身）。 */
  storage: SafeStorageLike;
  /** 文件名（默认 online-token.json）。 */
  fileName?: string;
}

export interface TokenStore {
  /** 保存 token（可用 → 密文；不可用 → 明文 + console.warn 降级）。 */
  save(token: string): void;
  /** 读回 token；文件缺失/损坏/校验不符 → null（引导重新登录，不抛）。 */
  load(): string | null;
  /** 清除（吊销后/会话失效时调用）；文件不存在时静默。 */
  clear(): void;
}

interface PersistedToken {
  encrypted: boolean;
  token: string;
  /** 明文 token 的 SHA-256 hex，用于读回完整性校验。 */
  checksum: string;
}

const DEFAULT_FILE_NAME = "online-token.json";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function createTokenStore(deps: TokenStoreDeps): TokenStore {
  const file = join(deps.dir, deps.fileName ?? DEFAULT_FILE_NAME);

  function persist(persisted: PersistedToken): void {
    writeFileSync(file, JSON.stringify(persisted, null, 2), "utf8");
  }

  function readRaw(): PersistedToken | null {
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as PersistedToken;
    } catch (e) {
      console.warn(`在线 token 文件损坏，已忽略（${file}）: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  return {
    save(token: string): void {
      const checksum = sha256(token);
      if (deps.storage.isEncryptionAvailable()) {
        persist({ encrypted: true, token: deps.storage.encryptString(token).toString("base64"), checksum });
        return;
      }
      console.warn("safeStorage 不可用，在线 token 将以明文存储（建议检查系统钥匙串/密钥环环境）");
      persist({ encrypted: false, token, checksum });
    },

    load(): string | null {
      const persisted = readRaw();
      if (persisted === null) return null;
      let token: string;
      if (persisted.encrypted) {
        try {
          token = deps.storage.decryptString(Buffer.from(persisted.token, "base64"));
        } catch (e) {
          console.warn(`在线 token 解密失败，请重新登录: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }
      } else {
        token = persisted.token;
      }
      // 完整性校验：跨机器密钥不匹配会解密出垃圾串，sha256 对不上 → 视为无凭据。
      if (sha256(token) !== persisted.checksum) {
        console.warn("在线 token 校验不符（可能跨机器挪动），请重新登录");
        return null;
      }
      return token;
    },

    clear(): void {
      try {
        rmSync(file, { force: true });
      } catch (e) {
        console.warn(`在线 token 清理失败（${file}）: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
