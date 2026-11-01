import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createMemberExecutionRequest, type MemberSession, type MemberExecutionContext } from "@apicc/execution/client";
import { EntityIdSchema, ServerProjectScopeSchema } from "@apicc/execution/contract";
import type { Command } from "commander";

export interface McpOsEntry { getPassword(): Promise<string | null | undefined>; setPassword(value: string): Promise<void>; deleteCredential(): Promise<boolean> }
export interface McpProfileDeps { mcpHomeDir?: string; mcpEnv?: Record<string, string | undefined>; mcpFetch?: typeof fetch; mcpKeyringEntry?: (service: string, account: string) => McpOsEntry; mcpSecretInput?: (signal?: AbortSignal) => Promise<string> }
const profileSchema = z.object({ id: z.string().min(1).max(128), server: z.string(), memberId: EntityIdSchema, scopes: z.array(ServerProjectScopeSchema).min(1).max(200), generation: z.string().uuid(), credentialRef: z.string(), tokenEnv: z.string().optional() }).strict();
export type McpProfile = z.infer<typeof profileSchema>;
const documentSchema = z.object({ formatVersion: z.literal(1), profiles: z.array(profileSchema).max(100) }).strict();
const userSchema = z.object({ id: EntityIdSchema, username: z.string(), displayName: z.string(), role: z.string() });
const profilePath = (deps: McpProfileDeps) => join(deps.mcpHomeDir ?? homedir(), ".apicc", "mcp", "profiles.json");
function readDocument(deps: McpProfileDeps) {
  const path = profilePath(deps);
  return existsSync(path) ? documentSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : { formatVersion: 1 as const, profiles: [] as McpProfile[] };
}
function writeDocument(deps: McpProfileDeps, document: z.infer<typeof documentSchema>) {
  const path = profilePath(deps); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(documentSchema.parse(document)), { flag: "wx", mode: 0o600 }); renameSync(temporary, path);
}
async function entryFor(deps: McpProfileDeps, account: string) {
  const service = `apicc.mcp.member.v1:${createHash("sha256").update(profilePath(deps)).digest("hex")}`;
  if (deps.mcpKeyringEntry) return deps.mcpKeyringEntry(service, account);
  try { const { AsyncEntry } = await import("@napi-rs/keyring"); return new AsyncEntry(service, account, { linux: { store: "secret-service" } }); }
  catch { throw new Error("MCP 成员安全存储不可用；可显式注入进程 token 环境变量"); }
}
function canonicalServer(server: string): string {
  const url = new URL(server);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("MCP 成员服务必须使用无内嵌凭据的 HTTPS 地址");
  return url.href.replace(/\/$/, "").replace(/\/api\/v1$/, "");
}
export interface McpLoginInput { id: string; server: string; username: string; password: string; scopes: McpProfile["scopes"]; tokenEnv?: string }
async function bootstrapLogin(server: string, input: McpLoginInput, deps: McpProfileDeps, parentSignal: AbortSignal) {
  const controller = new AbortController(); const signal = AbortSignal.any([parentSignal, controller.signal]);
  const deadline = setTimeout(() => controller.abort(new Error("MCP login timeout")), 30000);
  try {
    signal.throwIfAborted();
    const response = await (deps.mcpFetch ?? fetch)(`${server}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: input.username, password: input.password }), signal, redirect: "error", cache: "no-store" });
    signal.throwIfAborted();
    if (!response.ok) { await response.body?.cancel(); throw new Error(`MCP 成员登录失败：HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("MCP 登录响应为空");
    const chunks: Uint8Array[] = []; let bytes = 0;
    const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 64 * 1024) { await reader.cancel(); throw new Error("MCP login-response-too-large：登录响应超过预算"); }
        chunks.push(part.value);
      }
      try {
        return z.object({ token: z.string().min(1), user: userSchema, expiresAt: z.string() }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch { throw new Error("MCP login-response-invalid：登录响应格式无效；请检查成员服务后重新登录"); }
    } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  } finally { clearTimeout(deadline); }
}
export async function loginMcpProfile(input: McpLoginInput, deps: McpProfileDeps = {}, signal = new AbortController().signal): Promise<McpProfile> {
  const server = canonicalServer(input.server);
  const login = await bootstrapLogin(server, input, deps, signal);
  const user = await createMemberExecutionRequest({ serverId: `${server}/api/v1`, token: () => login.token, assertCurrent() {} }, deps.mcpFetch, signal)("GET", "me", undefined, userSchema);
  if (user.id !== login.user.id) throw new Error("MCP login member identity/身份不匹配");
  const profile = profileSchema.parse({ id: input.id, server, memberId: login.user.id, scopes: input.scopes, generation: randomUUID(), credentialRef: `member:${randomUUID()}`, ...(input.tokenEnv ? { tokenEnv: input.tokenEnv } : {}) });
  if (!profile.tokenEnv) {
    const entry = await entryFor(deps, profile.credentialRef);
    await entry.setPassword(JSON.stringify({ server, memberId: profile.memberId, generation: profile.generation, token: login.token }));
  }
  const document = readDocument(deps); document.profiles = [...document.profiles.filter(p => p.id !== profile.id), profile]; writeDocument(deps, document);
  return profile;
}
export async function openMcpProfile(id: string, deps: McpProfileDeps = {}, signal = new AbortController().signal) {
  const profile = readDocument(deps).profiles.find(p => p.id === id);
  if (!profile) throw new Error("MCP 成员 profile 不存在；请先登录");
  for (const scope of profile.scopes) Object.freeze(scope);
  Object.freeze(profile.scopes); Object.freeze(profile);
  let token: unknown;
  if (profile.tokenEnv) token = (deps.mcpEnv ?? process.env)[profile.tokenEnv];
  else {
    const envelope = JSON.parse((await (await entryFor(deps, profile.credentialRef)).getPassword()) ?? "null");
    if (!envelope || envelope.server !== profile.server || envelope.memberId !== profile.memberId || envelope.generation !== profile.generation) throw new Error("MCP 成员安全存储 audience/受众不匹配；请重新登录");
    token = envelope.token;
  }
  if (typeof token !== "string" || !token) throw new Error("MCP 成员 token 不可用；请重新登录");
  canonicalServer(profile.server);
  const signature = JSON.stringify(profile);
  let invalid = false;
  const binding = { serverId: `${profile.server}/api/v1`, userId: profile.memberId, token: () => token, assertCurrent() {
    if (invalid || profile.tokenEnv && (deps.mcpEnv ?? process.env)[profile.tokenEnv] !== token || JSON.stringify(readDocument(deps).profiles.find(p => p.id === id)) !== signature) {
      invalid = true;
      throw new Error("MCP profile changed/已失效；请重新登录");
    }
  } };
  const session: MemberSession = { captureExecution(context: MemberExecutionContext) {
    binding.assertCurrent();
    if (context.serverId !== binding.serverId || context.ownerId !== profile.memberId || !profile.scopes.some(scope => scope.workspaceId === context.scope.workspaceId && scope.groupId === context.scope.groupId && scope.projectId === context.scope.projectId)) throw new Error("MCP profile scope/身份不匹配");
    return binding;
  } };
  const authenticatedFetch: typeof fetch = async (input, init) => {
    const response = await (deps.mcpFetch ?? fetch)(input, init);
    if (response.status === 401 || response.status === 403) invalid = true;
    return response;
  };
  const authenticate = async (requestSignal: AbortSignal) => {
    const user = await createMemberExecutionRequest(binding, authenticatedFetch, requestSignal)("GET", "me", undefined, userSchema);
    if (user.id !== profile.memberId) { invalid = true; throw new Error("MCP member identity/身份已改变；请重新登录"); }
    return user;
  };
  await authenticate(signal);
  return { profile, session, authenticate, fetch: authenticatedFetch, isInvalid: () => invalid };
}
export async function logoutMcpProfile(id: string, deps: McpProfileDeps = {}): Promise<void> {
  const profile = readDocument(deps).profiles.find(profile => profile.id === id);
  if (!profile) throw new Error("MCP 成员 profile 不存在；请先登录");
  try {
    const opened = await openMcpProfile(id, deps);
    const context = { serverId: `${opened.profile.server}/api/v1`, ownerId: opened.profile.memberId, scope: opened.profile.scopes[0]! };
    const binding = opened.session.captureExecution(context);
    await createMemberExecutionRequest(binding, opened.fetch)("POST", "auth/logout", undefined, z.undefined());
  } finally {
    const document = readDocument(deps); document.profiles = document.profiles.filter(candidate => candidate.id !== id || candidate.generation !== profile.generation); writeDocument(deps, document);
    if (!profile.tokenEnv) await (await entryFor(deps, profile.credentialRef)).deleteCredential();
  }
}

async function readMemberPassword(deps: McpProfileDeps): Promise<string> {
  if (deps.mcpSecretInput) return deps.mcpSecretInput();
  if (process.stdin.isTTY) throw new Error("MCP 成员密码须通过独立登录命令的受控 stdin 管道输入");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { process.stdin.off("data", data); process.stdin.off("end", end); process.stdin.off("error", fail); process.stdin.pause(); };
    const fail = () => { cleanup(); reject(new Error("MCP 成员密码输入失败")); };
    const data = (chunk: Buffer | string) => { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16384) { fail(); return; } chunks.push(bytes); };
    const end = () => { cleanup(); const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, ""); if (!value || /[\x00-\x1f\x7f]/.test(value)) reject(new Error("MCP 成员密码输入无效")); else resolve(value); };
    process.stdin.on("data", data); process.stdin.once("end", end); process.stdin.once("error", fail); process.stdin.resume();
  });
}
export function registerMcpProfileCommands(program: Command, deps: McpProfileDeps, log: (line: string) => void) {
  const command = program.command("mcp-profile").description("独立的在线成员来源登录；与个人 AI 模型配置分开");
  command.command("login").argument("<id>").requiredOption("--server <url>", "HTTPS 服务根地址")
    .requiredOption("--username <name>").requiredOption("--workspace <id>").requiredOption("--group <id>").requiredOption("--project <id>")
    .requiredOption("--password-stdin", "在启动 MCP 前通过独立受控 stdin 输入密码；不接受密码 argv")
    .option("--token-env <name>", "后续仅从显式进程环境变量注入成员 token，替代 OS 存储")
    .action(async (id: string, opts) => {
      const password = await readMemberPassword(deps);
      const profile = await loginMcpProfile({ id, server: opts.server, username: opts.username, password, scopes: [{ workspaceId: opts.workspace, groupId: opts.group, projectId: opts.project }], tokenEnv: opts.tokenEnv }, deps);
      log(`MCP 成员来源已登录：${profile.id}；成员 ${profile.memberId}；固定项目 ${opts.project}；密码未保存`);
    });
  command.command("logout").argument("<id>").action(async (id: string) => { await logoutMcpProfile(id, deps); log("MCP 成员来源已注销；旧连接与游标已失效"); });
}
