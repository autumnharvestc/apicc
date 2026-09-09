/**
 * adminClient（M4-A 任务 1，M4 规格 §2 D4）：浏览器管理控制台 API 客户端——baseUrl + token +
 * 统一错误归一 + 15s 超时。逻辑与桌面端 onlineClient 同构（原生 fetch 封装，零新 HTTP 库）；
 * 包隔离下同构重写，不 import desktop 代码。与桌面端的两处环境差异（裁定③④）：
 * - baseUrl 默认同源相对路径 `/api/v1`（可经 VITE_API_BASE 覆盖供分离部署）——URL 拼装为
 *   字符串拼接（相对地址无法经 new URL 解析，也无跨源校验诉求），查询串经 URLSearchParams；
 * - token 的 localStorage 持久化由会话 store（任务 2）负责，本客户端只持有内存态。
 * fetch 以形依赖注入（生产 = globalThis.fetch，测试 = 假 fetch），未传时运行时取全局。
 *
 * 错误归一（裁定④：同 desktop onlineClient 语义）：
 * - HTTP 层按 status + body `{code,message}` → AdminApiError（保留 status/code/message）；
 * - body 非 JSON / 成功体 safeParse 不符 → AdminProtocolError（code=protocol_error）；
 * - 网络层（连接失败/超时）→ AdminApiError(status=0, code=network_error)。
 *
 * 会话失效事件：带 token 的请求收到 401 时触发 onUnauthorized（登录/注册请求自身的 401
 * 不触发——此时无会话可言）；登录成功后 token 注入，后续请求自动带头。
 */
import { z } from "zod";
import {
  AdminAccountSchema,
  AdminAclEntrySchema,
  AdminErrorSchema,
  AdminGroupSchema,
  AdminLoginResultSchema,
  AdminMemberSchema,
  AdminProjectSchema,
  AdminRegisterInputSchema,
  AdminTreeSchema,
  AdminUserCandidateSchema,
  AdminUserSchema,
  AdminWorkspaceCreatedSchema,
  AdminWorkspaceDetailSchema,
  AdminWorkspaceSummarySchema,
  type AdminAccount,
  type AdminAclEntry,
  type AdminAclRole,
  type AdminGroup,
  type AdminLoginResult,
  type AdminMember,
  type AdminProject,
  type AdminRegisterInput,
  type AdminRole,
  type AdminTree,
  type AdminUser,
  type AdminUserCandidate,
  type AdminWorkspaceCreated,
  type AdminWorkspaceDetail,
  type AdminWorkspaceSummary,
} from "./contract.js";

/** 服务端统一错误（HTTP 层）：status=0 且 code=network_error 表示网络层失败（含超时）。 */
export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AdminApiError";
  }
}

/** 契约形状不符（错误体/成功体均可能）：对端不是本规格的服务端。 */
export class AdminProtocolError extends Error {
  readonly code = "protocol_error";
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AdminProtocolError";
  }
}

/** API 根地址默认值（裁定③）：同源 `/api/v1`，分离部署经 VITE_API_BASE 覆盖。 */
export function defaultApiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE || "/api/v1";
}

export interface AdminClientDeps {
  /** API 根地址（尾随 / 归一掉）；缺省 = defaultApiBaseUrl()。 */
  baseUrl?: string;
  /** 传输层注入（生产=globalThis.fetch；测试=假 fetch）。 */
  fetch?: typeof fetch;
  /** 请求超时毫秒数，默认 15_000（与桌面端同裁定）。 */
  timeoutMs?: number;
  /** 初始 token（恢复登录态用）；后续经 setToken/clearToken 管理。 */
  token?: string;
  /** 会话失效事件：带 token 的请求 401 时触发（登录/注册 401 不触发）。 */
  onUnauthorized?: () => void;
}

/** 管理面端点（裁定⑤子集）：auth 四端点 + §3.2 工作区/成员 + §3.3 ACL（含 DELETE 修订）+ tree + 规格 2026-09-08 §2 账号管理（任务 5）。 */
export interface AdminClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  setToken(token: string): void;
  clearToken(): void;
  /** 运行期接线/覆盖会话失效钩子（组合根先建 client 后建 session store 的装配顺序需要）。 */
  setOnUnauthorized(fn: () => void): void;
  authConfig(): Promise<{ allowRegistration: boolean }>;
  register(input: AdminRegisterInput): Promise<AdminUser>;
  login(credentials: { username: string; password: string }): Promise<AdminLoginResult>;
  logout(): Promise<void>;
  me(): Promise<AdminUser>;
  listWorkspaces(): Promise<AdminWorkspaceSummary[]>;
  createWorkspace(input: { name: string }): Promise<AdminWorkspaceCreated>;
  getWorkspace(workspaceId: string): Promise<AdminWorkspaceDetail>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  listMembers(workspaceId: string): Promise<AdminMember[]>;
  /** GET /workspaces/{id}/member-candidates?q=&limit=：非成员候选（ADMIN+；400/403 由服务端裁决）。 */
  searchUserCandidates(workspaceId: string, q: string, limit?: number): Promise<AdminUserCandidate[]>;
  setMemberRole(workspaceId: string, userId: string, role: AdminRole): Promise<void>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
  getTree(workspaceId: string): Promise<AdminTree>;
  listAcl(workspaceId: string, projectId: string): Promise<AdminAclEntry[]>;
  /** PUT ACL 行：NONE=拒之门外（§3.3）。 */
  setAclEntry(workspaceId: string, projectId: string, input: { userId: string; role: AdminAclRole }): Promise<void>;
  /** DELETE ACL 行 ?userId=：删行=恢复工作区角色继承（契约修订 2026-09-04）。 */
  deleteAclEntry(workspaceId: string, projectId: string, userId: string): Promise<void>;
  // —— 平台账号管理（规格 2026-09-08 §2，超管专属；403/401 由服务端裁决）——
  /** GET /admin/users：账号清单（不含 password）。 */
  adminListUsers(): Promise<AdminAccount[]>;
  /** POST /admin/users：创建账号（校验口径同注册；409 username_taken / 400 validation_failed）。 */
  adminCreateUser(input: { username: string; password: string; displayName: string }): Promise<AdminAccount>;
  /** POST /admin/users/{id}/password-reset { newPassword }：重置并踢下线（204）。 */
  adminResetPassword(userId: string, newPassword: string): Promise<void>;
  /** POST /admin/users/{id}/disable | /enable：停用/启用（204；停用同时吊销全部令牌）。 */
  adminSetDisabled(userId: string, disabled: boolean): Promise<void>;
  /** PUT /admin/users/{id}/workspace-role { workspaceId, role }：入区定角色（204）。 */
  adminSetWorkspaceRole(userId: string, workspaceId: string, role: AdminRole): Promise<void>;
  // —— 组织管理（规格 2026-09-08 §4，计划 B 任务 2 端点逐字对齐；清单成员可读，写动作 ADMIN+，
  // 403/400/404/409 由服务端裁决，错误形状 {code,message}）——
  /** GET /workspaces/{id}/groups：分组清单。 */
  orgListGroups(workspaceId: string): Promise<AdminGroup[]>;
  /** POST /workspaces/{id}/groups { name }：建分组（201；409 group_name_taken）。 */
  orgCreateGroup(workspaceId: string, input: { name: string }): Promise<AdminGroup>;
  /** POST /workspaces/{id}/groups/{gid}/rename { name }：分组改名（200；400 default_group_immutable）。 */
  orgRenameGroup(workspaceId: string, groupId: string, name: string): Promise<AdminGroup>;
  /** DELETE /workspaces/{id}/groups/{gid}：删分组（204；400 default_group_immutable / 409 group_not_empty）。 */
  orgDeleteGroup(workspaceId: string, groupId: string): Promise<void>;
  /** GET /workspaces/{id}/projects：项目清单。 */
  orgListProjects(workspaceId: string): Promise<AdminProject[]>;
  /** POST /workspaces/{id}/projects { groupId, name }：建项目（201；同名允许）。 */
  orgCreateProject(workspaceId: string, input: { groupId: string; name: string }): Promise<AdminProject>;
  /** POST /workspaces/{id}/projects/{pid}/rename { name }：项目改名（200；同名允许）。 */
  orgRenameProject(workspaceId: string, projectId: string, name: string): Promise<AdminProject>;
  /** POST /workspaces/{id}/projects/{pid}/move { groupId }：移动项目（204）。 */
  orgMoveProject(workspaceId: string, projectId: string, groupId: string): Promise<void>;
  /** DELETE /workspaces/{id}/projects/{pid}：删项目（204；级联内容版本行与 ACL 行）。 */
  orgDeleteProject(workspaceId: string, projectId: string): Promise<void>;
}

/** 默认超时 15s（与桌面端 onlineClient 同裁定）。 */
const DEFAULT_TIMEOUT_MS = 15_000;

export function createAdminClient(deps: AdminClientDeps = {}): AdminClient {
  const baseUrl = (deps.baseUrl ?? defaultApiBaseUrl()).replace(/\/+$/, "");
  const doFetch = deps.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  let token: string | undefined = deps.token;
  /** 会话失效钩子：deps.onUnauthorized 为初值，可经 setOnUnauthorized 运行期覆盖（组合根接线）。 */
  let onUnauthorized: (() => void) | undefined = deps.onUnauthorized;

  /** URL 拼装：字符串拼接（baseUrl 可为同源相对路径，裁定③）+ 查询串经 URLSearchParams 编码。 */
  function buildUrl(path: string, query?: Record<string, string>): string {
    let url = `${baseUrl}${path}`;
    if (query !== undefined && Object.keys(query).length > 0) {
      url += `?${new URLSearchParams(query).toString()}`;
    }
    return url;
  }

  async function request(opts: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    /** 成功体 schema；省略 = 无内容端点（204）不做出口校验。 */
    schema?: z.ZodTypeAny;
  }): Promise<unknown> {
    const url = buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const tokenAttached = token !== undefined;
    if (tokenAttached) headers["Authorization"] = `Bearer ${token}`;

    let response: Response;
    try {
      response = await doFetch(url, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      // 网络层失败（连接拒绝/DNS/超时 abort）统一归一 network_error。
      throw new AdminApiError(0, "network_error", e instanceof Error ? e.message : String(e));
    }

    if (!response.ok) {
      const text = await response.text();
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        throw new AdminProtocolError(`错误响应体不是 JSON（HTTP ${response.status}）`, response.status);
      }
      const parsed = AdminErrorSchema.safeParse(body);
      if (!parsed.success) throw new AdminProtocolError(`错误响应缺少 { code, message }（HTTP ${response.status}）`, response.status);
      if (response.status === 401 && tokenAttached) onUnauthorized?.();
      throw new AdminApiError(response.status, parsed.data.code, parsed.data.message);
    }

    if (opts.schema === undefined) return undefined; // 204 等无内容端点
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AdminProtocolError(`响应体不是 JSON（HTTP ${response.status}）`, response.status);
    }
    const parsed = opts.schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "未知错误";
      throw new AdminProtocolError(`响应形状不符契约（HTTP ${response.status}）: ${where}`, response.status);
    }
    return parsed.data;
  }

  function requireToken(): string {
    if (token === undefined) throw new Error("尚未登录管理服务器");
    return token;
  }

  /** 端点路径相对 API 根（baseUrl 含 /api/v1 段，裁定③），段内逐个编码。 */
  function workspacePath(workspaceId: string, suffix: string): string {
    return `/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
  }

  function aclPath(workspaceId: string, projectId: string): string {
    return workspacePath(workspaceId, `/projects/${encodeURIComponent(projectId)}/acl`);
  }

  /** 账号管理子路径（规格 §2，段内逐个编码，同 workspacePath 口径）。 */
  function adminUserPath(userId: string, suffix: string): string {
    return `/admin/users/${encodeURIComponent(userId)}${suffix}`;
  }

  /** 组织面子路径（规格 §4，分组段；段内逐个编码，同 adminUserPath 口径）。 */
  function orgGroupPath(workspaceId: string, groupId: string, suffix: string): string {
    return workspacePath(workspaceId, `/groups/${encodeURIComponent(groupId)}${suffix}`);
  }

  /** 组织面子路径（规格 §4，项目段）。 */
  function orgProjectPath(workspaceId: string, projectId: string, suffix: string): string {
    return workspacePath(workspaceId, `/projects/${encodeURIComponent(projectId)}${suffix}`);
  }

  return {
    baseUrl,
    get token() {
      return token;
    },
    setToken(next: string) {
      token = next;
    },
    clearToken() {
      token = undefined;
    },
    setOnUnauthorized(fn: () => void) {
      onUnauthorized = fn;
    },

    async authConfig() {
      return (await request({ method: "GET", path: "/auth/config", schema: z.object({ allowRegistration: z.boolean() }) })) as { allowRegistration: boolean };
    },

    async register(input) {
      AdminRegisterInputSchema.parse(input); // 入参护栏：非法形状不发请求（§3.1 校验前置）
      return (await request({ method: "POST", path: "/auth/register", body: input, schema: AdminUserSchema })) as AdminUser;
    },

    async login(credentials) {
      const result = (await request({ method: "POST", path: "/auth/login", body: credentials, schema: AdminLoginResultSchema })) as AdminLoginResult;
      token = result.token; // 登录成功即持 token（会话串联：后续请求自动带头）
      return result;
    },

    async logout() {
      requireToken();
      await request({ method: "POST", path: "/auth/logout" });
      token = undefined; // 服务端已吊销，本地同步清除
    },

    async me() {
      return (await request({ method: "GET", path: "/me", schema: AdminUserSchema })) as AdminUser;
    },

    async listWorkspaces() {
      return (await request({ method: "GET", path: "/workspaces", schema: z.array(AdminWorkspaceSummarySchema) })) as AdminWorkspaceSummary[];
    },

    async createWorkspace(input) {
      return (await request({ method: "POST", path: "/workspaces", body: input, schema: AdminWorkspaceCreatedSchema })) as AdminWorkspaceCreated;
    },

    async getWorkspace(workspaceId) {
      return (await request({ method: "GET", path: workspacePath(workspaceId, ""), schema: AdminWorkspaceDetailSchema })) as AdminWorkspaceDetail;
    },

    async deleteWorkspace(workspaceId) {
      await request({ method: "DELETE", path: workspacePath(workspaceId, "") });
    },

    async listMembers(workspaceId) {
      return (await request({ method: "GET", path: workspacePath(workspaceId, "/members"), schema: z.array(AdminMemberSchema) })) as AdminMember[];
    },

    async searchUserCandidates(workspaceId, q, limit) {
      const query: Record<string, string> = { q };
      if (limit !== undefined) query["limit"] = String(limit);
      return (await request({
        method: "GET",
        path: workspacePath(workspaceId, "/member-candidates"),
        query,
        schema: z.array(AdminUserCandidateSchema),
      })) as AdminUserCandidate[];
    },

    async setMemberRole(workspaceId, userId, role) {
      await request({ method: "PUT", path: workspacePath(workspaceId, `/members/${encodeURIComponent(userId)}`), body: { role } });
    },

    async removeMember(workspaceId, userId) {
      await request({ method: "DELETE", path: workspacePath(workspaceId, `/members/${encodeURIComponent(userId)}`) });
    },

    async getTree(workspaceId) {
      return (await request({ method: "GET", path: workspacePath(workspaceId, "/tree"), schema: AdminTreeSchema })) as AdminTree;
    },

    async listAcl(workspaceId, projectId) {
      return (await request({ method: "GET", path: aclPath(workspaceId, projectId), schema: z.array(AdminAclEntrySchema) })) as AdminAclEntry[];
    },

    async setAclEntry(workspaceId, projectId, input) {
      await request({ method: "PUT", path: aclPath(workspaceId, projectId), body: input });
    },

    async deleteAclEntry(workspaceId, projectId, userId) {
      await request({ method: "DELETE", path: aclPath(workspaceId, projectId), query: { userId } });
    },

    // —— 平台账号管理（规格 2026-09-08 §2）——
    async adminListUsers() {
      return (await request({ method: "GET", path: "/admin/users", schema: z.array(AdminAccountSchema) })) as AdminAccount[];
    },

    async adminCreateUser(input) {
      AdminRegisterInputSchema.parse(input); // 入参护栏：校验口径同注册（§2「校验同注册」，非法形状不发请求）
      return (await request({ method: "POST", path: "/admin/users", body: input, schema: AdminAccountSchema })) as AdminAccount;
    },

    async adminResetPassword(userId, newPassword) {
      await request({ method: "POST", path: adminUserPath(userId, "/password-reset"), body: { newPassword } });
    },

    async adminSetDisabled(userId, disabled) {
      await request({ method: "POST", path: adminUserPath(userId, disabled ? "/disable" : "/enable") });
    },

    async adminSetWorkspaceRole(userId, workspaceId, role) {
      await request({ method: "PUT", path: adminUserPath(userId, "/workspace-role"), body: { workspaceId, role } });
    },

    // —— 组织管理（规格 2026-09-08 §4，端点逐字对齐计划 B 任务 2）——
    async orgListGroups(workspaceId) {
      return (await request({ method: "GET", path: workspacePath(workspaceId, "/groups"), schema: z.array(AdminGroupSchema) })) as AdminGroup[];
    },

    async orgCreateGroup(workspaceId, input) {
      return (await request({ method: "POST", path: workspacePath(workspaceId, "/groups"), body: input, schema: AdminGroupSchema })) as AdminGroup;
    },

    async orgRenameGroup(workspaceId, groupId, name) {
      return (await request({ method: "POST", path: orgGroupPath(workspaceId, groupId, "/rename"), body: { name }, schema: AdminGroupSchema })) as AdminGroup;
    },

    async orgDeleteGroup(workspaceId, groupId) {
      await request({ method: "DELETE", path: orgGroupPath(workspaceId, groupId, "") });
    },

    async orgListProjects(workspaceId) {
      return (await request({ method: "GET", path: workspacePath(workspaceId, "/projects"), schema: z.array(AdminProjectSchema) })) as AdminProject[];
    },

    async orgCreateProject(workspaceId, input) {
      return (await request({ method: "POST", path: workspacePath(workspaceId, "/projects"), body: input, schema: AdminProjectSchema })) as AdminProject;
    },

    async orgRenameProject(workspaceId, projectId, name) {
      return (await request({ method: "POST", path: orgProjectPath(workspaceId, projectId, "/rename"), body: { name }, schema: AdminProjectSchema })) as AdminProject;
    },

    async orgMoveProject(workspaceId, projectId, groupId) {
      await request({ method: "POST", path: orgProjectPath(workspaceId, projectId, "/move"), body: { groupId } });
    },

    async orgDeleteProject(workspaceId, projectId) {
      await request({ method: "DELETE", path: orgProjectPath(workspaceId, projectId, "") });
    },
  };
}
