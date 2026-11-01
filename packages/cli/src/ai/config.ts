import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  builtinAiProviderCatalog, createAiConfigRepository, createAiPersonalConfigHost, loadAiProviderCatalog,
  selectAiCompatibilityInput, resolveAiInvocation, createDefaultAiConfigDocument, aiCredentialAudience,
  type AiProviderConfig, type AiSecretBackend, type AiPurpose, type AiCredentialResolver,
} from "@apicc/core";

export interface CliAiConfigDeps {
  aiEnv?: Record<string, string | undefined>;
  aiHomeDir?: string;
  aiSecretBackend?: AiSecretBackend;
  aiSecretInput?: (signal?: AbortSignal) => Promise<string>;
  aiSignal?: AbortSignal;
  aiFetch?: typeof fetch;
  /** External OS storage seam; never a project CredentialScope or renderer API. */
  aiKeyringEntry?: (service: string, account: string) => AiOsEntry;
}
export interface AiOsEntry { getPassword(): Promise<string | null | undefined>; setPassword(value: string): Promise<void>; deleteCredential(): Promise<boolean> }
export function legacyAiFile(homeDir = homedir()): unknown {
  const file = join(homeDir, ".apicc", "ai.json");
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("AI 配置文件不是合法 JSON"); }
}
/** Compatibility API only. New commands resolve purpose bindings separately. */
export function resolveAiConfig(input: { env?: Record<string, string | undefined>; homeDir?: string }): AiProviderConfig {
  const env = input.env ?? process.env;
  const values = [env.APICC_AI_BASE_URL, env.APICC_AI_API_KEY, env.APICC_AI_MODEL];
  if (values.some(v => v !== undefined)) {
    if (values.every(v => typeof v === "string" && v.length > 0)) return { baseUrl: values[0]!, apiKey: values[1]!, model: values[2]! };
    throw new Error("AI 配置不完整：env 三件套须同时设置 APICC_AI_BASE_URL、APICC_AI_API_KEY、APICC_AI_MODEL");
  }
  const raw = legacyAiFile(input.homeDir) as Record<string, unknown> | undefined;
  if (raw !== undefined) {
    if (raw && typeof raw.baseUrl === "string" && raw.baseUrl && typeof raw.apiKey === "string" && raw.apiKey && typeof raw.model === "string" && raw.model) return { baseUrl: raw.baseUrl, apiKey: raw.apiKey, model: raw.model };
    throw new Error("AI 配置文件不完整：须含 baseUrl/apiKey/model 字符串字段");
  }
  throw new Error("未找到 AI 配置：设置 APICC_AI_BASE_URL、APICC_AI_API_KEY、APICC_AI_MODEL，或迁移 ~/.apicc/ai.json");
}
export async function personalAiHost(deps: CliAiConfigDeps) {
  const privateRoot = join(deps.aiHomeDir ?? homedir(), ".apicc", "ai");
  const repository = createAiConfigRepository({ privateRoot });
  const secretBackend = deps.aiSecretBackend ?? await createCliAiSecretBackend(privateRoot, deps.aiKeyringEntry);
  const host = createAiPersonalConfigHost({ repository, secretBackend, catalog: loadAiProviderCatalog(builtinAiProviderCatalog, []).catalog });
  return { repository, host, secretBackend };
}
/** R21 selects a source; Core remains the sole effective-budget resolver. */
export async function resolveCliAiInvocation(deps: CliAiConfigDeps, input: { purpose: AiPurpose; modelProfileId?: string; projectKey: string; insecureLocalTest?: boolean }) {
  let selection = await selectAiCompatibilityInput({ modelProfileId: input.modelProfileId, environment: deps.aiEnv ?? process.env });
  if (selection?.kind === "profile" || !selection) {
    const personal = await personalAiHost(deps);
    const { document } = await personal.host.snapshot();
    if (selection?.kind === "profile" || document.bindings.some(b => b.purpose === input.purpose)
      || document.projectOverrides.some(b => b.projectKey === input.projectKey && b.purpose === input.purpose)) {
      return { resolved: resolveAiInvocation({ document, purpose: input.purpose, projectKey: input.projectKey, modelProfileId: input.modelProfileId }), credentials: personal.host.credentialResolver, personal };
    }
    selection = await selectAiCompatibilityInput({ readLegacyFile: async () => legacyAiFile(deps.aiHomeDir) });
  }
  if (!selection || selection.kind !== "legacy") throw new Error("未找到 AI 配置：配置个人用途绑定，或设置 APICC_AI_BASE_URL、APICC_AI_API_KEY、APICC_AI_MODEL，或迁移 ~/.apicc/ai.json");
  const legacy = selection.configuration;
  const document = createDefaultAiConfigDocument();
  document.connections = [{ id: "legacy", revision: 1, name: "legacy", owner: { kind: "personal" }, baseUrl: legacy.baseUrl,
    auth: { kind: "bearer" }, protocols: ["openai-chat-completions"], headers: {}, ...(input.insecureLocalTest ? { insecureLocalTest: true } : {}) }];
  document.models = [{ id: "legacy", revision: 1, connectionId: "legacy", modelId: legacy.model, protocol: "openai-chat-completions",
    structuredOutput: "json-object", streaming: false, supportedParameters: [], capabilities: { status: "unconfirmed", source: `legacy-${selection.source}` }, budgets: {}, purposeBudgets: {} }];
  document.bindings = [{ purpose: input.purpose, modelProfileId: "legacy", budgets: {} }];
  const resolved = resolveAiInvocation({ document, purpose: input.purpose });
  const credentials: AiCredentialResolver = { async resolve(connection) {
    if (aiCredentialAudience(connection) !== aiCredentialAudience(resolved.connection)) throw new Error("AI 凭据受众已改变");
    return { audience: aiCredentialAudience(connection), headers: { Authorization: `Bearer ${legacy.apiKey}` } };
  } };
  return { resolved, credentials };
}
export async function readAiSecret(options: { secretEnv?: string; secretStdin?: boolean }, deps: CliAiConfigDeps, signal?: AbortSignal): Promise<string> {
  if (Number(Boolean(options.secretEnv)) + Number(Boolean(options.secretStdin)) !== 1) throw new Error("需选择一个秘密来源：--secret-env <变量名> 或 --secret-stdin；不接受 key argv");
  if (signal?.aborted) throw new Error("AI 操作已取消");
  if (options.secretEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.secretEnv)) throw new Error("秘密环境变量名无效");
    const value = (deps.aiEnv ?? process.env)[options.secretEnv];
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("秘密环境变量缺失或无效");
    return value;
  }
  if (deps.aiSecretInput) return deps.aiSecretInput(signal);
  if (process.stdin.isTTY) throw new Error("请使用受控 stdin 管道传入秘密");
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { process.stdin.off("data", data); process.stdin.off("end", end); process.stdin.off("error", fail); signal?.removeEventListener("abort", abort); process.stdin.pause(); };
    const fail = () => { cleanup(); reject(new Error("AI 秘密 stdin 读取失败")); };
    const abort = () => { cleanup(); reject(new Error("AI 操作已取消")); };
    const data = (chunk: Buffer | string) => { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16384) { fail(); return; } chunks.push(bytes); };
    const end = () => { cleanup(); const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, ""); if (!value || /[\x00-\x1f\x7f]/.test(value)) reject(new Error("AI 秘密 stdin 无效")); else resolve(value); };
    process.stdin.on("data", data); process.stdin.once("end", end); process.stdin.once("error", fail); signal?.addEventListener("abort", abort, { once: true }); process.stdin.resume();
  });
}
const unavailableAiBackend: AiSecretBackend = {
  availability: "unavailable", async get() { return undefined; },
  async put() { throw new Error("secure-backend-unavailable"); }, async remove() {},
};
/** OS entries contain a versioned audience envelope; every put allocates a new account. */
export async function createCliAiSecretBackend(privateRoot: string, factory?: CliAiConfigDeps["aiKeyringEntry"]): Promise<AiSecretBackend> {
  let entry = factory;
  if (!entry) {
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      entry = (service, account) => new AsyncEntry(service, account, { linux: { store: "secret-service" } });
    } catch { return unavailableAiBackend; }
  }
  const service = `apicc.ai.personal.v1:${createHash("sha256").update(privateRoot).digest("hex")}`;
  const validRef = (ref: string) => /^ai-secret:[0-9a-f-]{36}$/.test(ref);
  const get = async (ref: string, audience: string) => {
    if (!validRef(ref)) return undefined;
    try {
      const text = await entry!(service, ref).getPassword();
      if (!text) return undefined;
      const envelope = JSON.parse(text);
      if (envelope.formatVersion !== 1 || envelope.audience !== audience || typeof envelope.value !== "string" || !envelope.value || /[\x00-\x1f\x7f]/.test(envelope.value)) return undefined;
      return envelope.value as string;
    } catch { throw new Error("AI 安全存储不可用"); }
  };
  return { availability: "available", get,
    async put(value, audience, mode) {
      if (mode !== "persistent" || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("AI 安全存储输入无效");
      const ref = `ai-secret:${randomUUID()}`;
      try { await entry!(service, ref).setPassword(JSON.stringify({ formatVersion: 1, audience, value })); }
      catch { throw new Error("AI 安全存储不可用"); }
      return ref;
    },
    async remove(ref, audience) {
      if (await get(ref, audience) === undefined) return;
      try { await entry!(service, ref).deleteCredential(); } catch { throw new Error("AI 安全存储不可用"); }
    },
  };
}
