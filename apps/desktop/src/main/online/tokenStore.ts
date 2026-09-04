/**
 * token 安全存储（M3-B 任务 2 裁定 A/B，规格 §2 D9）：Electron safeStorage 加密存取登录
 * token，不可用时降级明文 + console.warn（D9 原文裁定）。safeStorage 为形依赖——生产组合根
 * （main.ts）传 `import { safeStorage } from "electron"` 的真身，测试注入替身；本模块不直接
 * import electron，保证 vitest（node 环境）可加载。
 *
 * 任务 2 裁定 A：文件改造为按 baseUrl 索引多凭据 `{ servers: { [baseUrl]: {encrypted,token,checksum} } }`——
 * 多服务器档案并存时各自凭据互不覆盖，logout 只吊销/清除当前服务器的 token。文件格式向后兼容
 * 选型：旧单凭据文件（无 servers 字段）**直接作废重登**（不迁移）——实现简单，且旧文件解密/
 * 校验失败本就降级 null，作废可接受。存储位置维持 userData（dir 由组合根注入）：token 是
 * main 进程敏感凭据，不能进渲染层 localStorage。每条凭据 checksum = 明文 token 的 SHA-256，
 * 读回校验——跨机器挪动 profile 导致密钥不匹配时返回 null 引导重新登录，而不是把坏 token
 * 当有效凭据发出去。裁定 B①：合法 JSON 但缺字段（形状守卫不过）一律 null + warn，不抛。
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
  /** 保存该服务器的 token（可用 → 密文；不可用 → 明文 + console.warn 降级）；同 baseUrl 覆盖。 */
  save(baseUrl: string, token: string): void;
  /** 读回该服务器的 token；文件缺失/损坏/旧格式/形状不符/校验不符 → null（引导重新登录，不抛）。 */
  load(baseUrl: string): string | null;
  /** 清除该服务器的凭据（吊销后/会话失效时调用）；该服务器无凭据时静默。 */
  clear(baseUrl: string): void;
}

interface PersistedCredential {
  encrypted: boolean;
  token: string;
  /** 明文 token 的 SHA-256 hex，用于读回完整性校验。 */
  checksum: string;
}

interface PersistedTokens {
  servers: Record<string, PersistedCredential>;
}

const DEFAULT_FILE_NAME = "online-token.json";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 凭据条目形状守卫：字段缺失/类型不符 → null（裁定 B①，缺失/损坏一律 null + warn）。 */
function asCredential(value: unknown): PersistedCredential | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PersistedCredential>;
  if (typeof candidate.encrypted !== "boolean") return null;
  if (typeof candidate.token !== "string") return null;
  if (typeof candidate.checksum !== "string") return null;
  return { encrypted: candidate.encrypted, token: candidate.token, checksum: candidate.checksum };
}

export function createTokenStore(deps: TokenStoreDeps): TokenStore {
  const file = join(deps.dir, deps.fileName ?? DEFAULT_FILE_NAME);

  /** 读全部凭据；文件缺失 / 非 JSON / 旧格式（无 servers 字段，裁定 A 作废重登）/ servers 非对象 → null + warn。 */
  function readAll(): PersistedTokens | null {
    if (!existsSync(file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      console.warn(`在线 token 文件损坏，已忽略（${file}）: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || !("servers" in parsed)) {
      console.warn("在线 token 文件为旧版单凭据格式，已作废（请重新登录）");
      return null;
    }
    const rawServers = (parsed as { servers: unknown }).servers;
    if (typeof rawServers !== "object" || rawServers === null || Array.isArray(rawServers)) {
      console.warn("在线 token 文件形状不符（servers 非对象），已忽略（请重新登录）");
      return null;
    }
    const servers: Record<string, PersistedCredential> = {};
    for (const [baseUrl, value] of Object.entries(rawServers as Record<string, unknown>)) {
      const credential = asCredential(value);
      if (credential) servers[baseUrl] = credential;
    }
    return { servers };
  }

  function persistAll(persisted: PersistedTokens): void {
    writeFileSync(file, JSON.stringify(persisted, null, 2), "utf8");
  }

  return {
    save(baseUrl: string, token: string): void {
      const all = readAll() ?? { servers: {} };
      const checksum = sha256(token);
      if (deps.storage.isEncryptionAvailable()) {
        all.servers[baseUrl] = { encrypted: true, token: deps.storage.encryptString(token).toString("base64"), checksum };
      } else {
        console.warn("safeStorage 不可用，在线 token 将以明文存储（建议检查系统钥匙串/密钥环环境）");
        all.servers[baseUrl] = { encrypted: false, token, checksum };
      }
      persistAll(all);
    },

    load(baseUrl: string): string | null {
      const all = readAll();
      const persisted = all?.servers[baseUrl];
      if (!persisted) return null;
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

    clear(baseUrl: string): void {
      const all = readAll();
      if (all === null || !(baseUrl in all.servers)) return;
      delete all.servers[baseUrl];
      if (Object.keys(all.servers).length === 0) {
        // 全部凭据已清：移除文件（保持 userData 干净；与「从无凭据」状态等价）。
        try {
          rmSync(file, { force: true });
        } catch (e) {
          console.warn(`在线 token 清理失败（${file}）: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      persistAll(all);
    },
  };
}
