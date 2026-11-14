/**
 * onlineClient（M3-B 任务 1，规格 §2 D9）：main 进程在线 API 客户端——baseUrl + token +
 * 统一错误归一 + 15s 超时。传输层裁定：全局 fetch（Node 22 内置，undici 驱动），零新依赖；
 * fetch 以形依赖注入（生产 = globalThis.fetch，测试 = 假 fetch），未传时运行时取全局。
 *
 * 错误归一（简报裁定 ③）：
 * - HTTP 层按 status + body `{code,message}` → OnlineApiError（保留 status/code/message）；
 * - 409 且 body 为 `{code: version_conflict,...}` → OnlineConflictError（冲突对象原样携带）；
 * - body 非 JSON / 成功体 safeParse 不符 → OnlineProtocolError（code=protocol_error）；
 * - 网络层（连接失败/超时）→ OnlineApiError(status=0, code=network_error)。
 *
 * 会话失效事件：带 token 的请求收到 401 时触发 onUnauthorized（登录 401 不触发——
 * 此时无会话可言）；登录成功后 token 经 setToken 注入，请求自动带头。
 */
import {
  OnlineAclEntrySchema,
  OnlineMemberMutationSchema,
  OnlineAclMutationSchema,
  OnlineAuthConfigSchema,
  OnlineBatchInputSchema,
  OnlineBatchResultSchema,
  OnlineErrorSchema,
  OnlineFilesResultSchema,
  OnlineGetFilesInputSchema,
  OnlineGroupSchema,
  OnlineLoginResultSchema,
  OnlineMappingInputSchema,
  OnlineMappingResultSchema,
  OnlinePathSchema,
  OnlinePutFileResultSchema,
  OnlineRegisterInputSchema,
  OnlineTreeSchema,
  OnlineUserSchema,
  OnlineVersionConflictSchema,
  OnlineWorkspaceCreatedSchema,
  OnlineWorkspaceDetailSchema,
  OnlineWorkspaceSummarySchema,
  type OnlineAclEntry,
  type OnlineAclRole,
  type OnlineBatchInput,
  type OnlineBatchResult,
  type OnlineFilesResult,
  type OnlineGroup,
  type OnlineLoginResult,
  type OnlineMappingEntry,
  type OnlineMappingResult,
  type OnlinePutFileResult,
  type OnlineRegisterInput,
  type OnlineRole,
  type OnlineTree,
  type OnlineUser,
  type OnlineVersionConflict,
  type OnlineWorkspaceCreated,
  type OnlineWorkspaceDetail,
  type OnlineWorkspaceSummary,
} from "../../shared/online/contract.js";
import { z } from "zod";
import { createMemberExecutionRequest, ExecutionHttpError } from "@apicc/execution/client";

/** 服务端统一错误（HTTP 层）：status=0 且 code=network_error 表示网络层失败（含超时）。 */
export class OnlineApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OnlineApiError";
  }
}

/** Only known member categories cross the desktop boundary; never upstream text. */
const memberErrorMessages: Readonly<Record<string, string>> = {
  forbidden: "权限不足 / Permission denied（forbidden）", unauthorized: "当前登录授权失效，请重新登录 / Authorization expired; sign in again（unauthorized）",
  script_approval_required: "保存脚本需要批准 / Saved scripts require approval（script_approval_required）", script_permission_denied: "没有保存脚本执行权限 / Saved-script execution permission denied（script_permission_denied）",
  script_grant_changed: "保存脚本批准版本已改变 / Saved-script approval changed（script_grant_changed）", material_version_conflict: "固定材料版本已变化 / Captured material version changed（material_version_conflict）",
  credential_version_conflict: "固定凭据版本已变化 / Captured credential version changed（credential_version_conflict）", intent_conflict: "意图与原固定输入冲突，请查询原运行 / Intent conflicts with the captured input; inspect the original run（intent_conflict）",
  version_conflict: "项目版本冲突，请重新读取 / Project version conflict; reload（version_conflict）", job_not_found: "运行不存在或当前成员无权读取 / Run unavailable or not readable by this member（job_not_found）",
  invalid_project_assets: "首次保存需要完整有效的项目资产 / Initial save requires valid project assets（invalid_project_assets）",
  report_expired: "报告已到期或已清理 / Report expired or removed（report_expired）", report_not_archived: "报告尚未归档 / Report not archived yet（report_not_archived）",
};
export function adaptMemberExecutionError(error: unknown): unknown {
  if (!(error instanceof ExecutionHttpError)) return error;
  const code = error.code && Object.hasOwn(memberErrorMessages, error.code) ? error.code : "execution-request-failed";
  return new OnlineApiError(error.status, code, memberErrorMessages[code] ?? "成员执行请求失败，请检查当前权限与来源 / Member execution request failed; check permissions and source（execution-request-failed）");
}

/** Execution uses the canonical HTTPS API base; legacy browsing keeps its service-root client. */
export function createExecutionRequest(binding: { serverId: string; token(): string; assertCurrent(): void }, fetcher: typeof fetch = globalThis.fetch, parentSignal?: AbortSignal) {
  const request = createMemberExecutionRequest(binding, fetcher, parentSignal);
  return async <T>(method: string, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> => {
    try { return await request(method,path,body,schema); }
    catch(error) { throw adaptMemberExecutionError(error); }
  };
}

/** 契约形状不符（错误体/成功体均可能）：服务端不是本规格的对端。 */
export class OnlineProtocolError extends Error {
  readonly code = "protocol_error";
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OnlineProtocolError";
  }
}

/** 409 乐观并发冲突：conflict 为服务端冲突对象原样解析值（{code, currentVersion, currentHash[, message]}）。 */
export class OnlineConflictError extends Error {
  readonly code = "version_conflict";
  constructor(readonly conflict: OnlineVersionConflict) {
    super(`版本冲突：服务端当前版本 ${conflict.currentVersion}`);
    this.name = "OnlineConflictError";
  }
}

export interface OnlineClientDeps {
  /** 自托管服务端根地址（尾随 / 归一掉）。 */
  baseUrl: string;
  /** 传输层注入（生产=globalThis.fetch；测试=假 fetch）。 */
  fetch?: typeof fetch;
  /** 请求超时毫秒数，默认 15_000（计划任务 1 裁定）。 */
  timeoutMs?: number;
  /** 初始 token（恢复登录态用）；后续经 setToken/clearToken 管理。 */
  token?: string;
  /** 会话失效事件：带 token 的请求 401 时触发（登录 401 不触发）。 */
  onUnauthorized?: () => void;
}

export interface OnlineClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  setToken(token: string): void;
  clearToken(): void;
  authConfig(): Promise<{ allowRegistration: boolean }>;
  register(input: OnlineRegisterInput): Promise<OnlineUser>;
  login(credentials: { username: string; password: string }): Promise<OnlineLoginResult>;
  logout(): Promise<void>;
  me(): Promise<OnlineUser>;
  listWorkspaces(): Promise<OnlineWorkspaceSummary[]>;
  createWorkspace(input: { name: string }): Promise<OnlineWorkspaceCreated>;
  getWorkspace(workspaceId: string): Promise<OnlineWorkspaceDetail>;
  getTree(workspaceId: string): Promise<OnlineTree>;
  getFiles(workspaceId: string, paths: string[]): Promise<OnlineFilesResult>;
  putFile(workspaceId: string, input: { path: string; content: string; baseVersion: number }): Promise<OnlinePutFileResult>;
  batchPush(workspaceId: string, input: OnlineBatchInput): Promise<OnlineBatchResult>;
  deleteFile(workspaceId: string, input: { path: string; baseVersion: number }): Promise<void>;
  /**
   * 迁移映射桥（计划 C 任务 1/2）：本地名称目录二元组清单 → 服务端实体（≤200 条/批）。
   * 响应行三态（解析/建成、missing、forbidden——部分成功）见 OnlineMappingResultSchema。
   */
  onlineProjectMapping(workspaceId: string, entries: OnlineMappingEntry[]): Promise<OnlineMappingResult>;
  /** 组织分组只读清单（§4 GET groups，成员可读；迁移拉取 groupId → 组名反查数据源）。 */
  listGroups(workspaceId: string): Promise<OnlineGroup[]>;
  /** 成员管理：role → PUT 变更角色；op=remove → DELETE 移除（§3.2，M3-B UI 不消费，契约面保留）。 */
  manageMembers(workspaceId: string, input: z.input<typeof OnlineMemberMutationSchema>): Promise<void>;
  /**
   * 项目 ACL（§3.3）：无 input → GET 清单；{ userId, role } → PUT 设角色（NONE=拒之门外）；
   * { userId, op: "remove" } → DELETE ?userId=（契约修订 2026-09-03，删 ACL 行=恢复工作区
   * 角色继承）。M3-B UI 不消费，契约面保留。
   */
  manageAcl(workspaceId: string, projectId: string, input?: z.input<typeof OnlineAclMutationSchema>): Promise<OnlineAclEntry[] | void>;
}

/** 默认超时 15s（计划任务 1 裁定）。 */
const DEFAULT_TIMEOUT_MS = 15_000;

export function createOnlineClient(deps: OnlineClientDeps): OnlineClient {
  const baseUrl = deps.baseUrl.replace(/\/+$/, "");
  const doFetch = deps.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  let token: string | undefined = deps.token;

  /** path 逐段编码拼 URL（`/` 分隔相对路径，段内中文/空格/特殊字符安全）。 */
  function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  async function request(opts: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    /** 成功体 schema；省略 = 无内容端点（204）不做出口校验。 */
    schema?: z.ZodTypeAny;
  }): Promise<unknown> {
    // URL 拼装同样归一进 network_error（任务 2 裁定 B②）：baseUrl 不可解析时 new URL
    // 裸抛 TypeError 会越过错误契约，UI 拿不到可辨别的失败码。
    let url: URL;
    try {
      url = new URL(`${baseUrl}${opts.path}`);
    } catch (e) {
      throw new OnlineApiError(0, "network_error", e instanceof Error ? e.message : String(e));
    }
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const tokenAttached = token !== undefined;
    if (tokenAttached) headers["Authorization"] = `Bearer ${token}`;

    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      // 网络层失败（连接拒绝/DNS/超时 abort）统一归一 network_error（简报裁定 ③）。
      throw new OnlineApiError(0, "network_error", e instanceof Error ? e.message : String(e));
    }

    if (!response.ok) {
      const text = await response.text();
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        throw new OnlineProtocolError(`错误响应体不是 JSON（HTTP ${response.status}）`, response.status);
      }
      if (response.status === 409) {
        const conflict = OnlineVersionConflictSchema.safeParse(body);
        if (conflict.success) throw new OnlineConflictError(conflict.data);
      }
      const parsed = OnlineErrorSchema.safeParse(body);
      if (!parsed.success) throw new OnlineProtocolError(`错误响应缺少 { code, message }（HTTP ${response.status}）`, response.status);
      if (response.status === 401 && tokenAttached) deps.onUnauthorized?.();
      throw new OnlineApiError(response.status, parsed.data.code, parsed.data.message);
    }

    if (opts.schema === undefined) return undefined; // 204 等无内容端点
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OnlineProtocolError(`响应体不是 JSON（HTTP ${response.status}）`, response.status);
    }
    const parsed = opts.schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "未知错误";
      throw new OnlineProtocolError(`响应形状不符契约（HTTP ${response.status}）: ${where}`, response.status);
    }
    return parsed.data;
  }

  function requireToken(): string {
    if (token === undefined) throw new Error("尚未登录在线服务器");
    return token;
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

    async authConfig() {
      return (await request({ method: "GET", path: "/api/v1/auth/config", schema: OnlineAuthConfigSchema })) as { allowRegistration: boolean };
    },

    async register(input) {
      OnlineRegisterInputSchema.parse(input);
      return (await request({ method: "POST", path: "/api/v1/auth/register", body: input, schema: OnlineUserSchema })) as OnlineUser;
    },

    async login(credentials) {
      const result = (await request({ method: "POST", path: "/api/v1/auth/login", body: credentials, schema: OnlineLoginResultSchema })) as OnlineLoginResult;
      token = result.token; // 登录成功即持 token（会话串联：后续请求自动带头）
      return result;
    },

    async logout() {
      requireToken();
      await request({ method: "POST", path: "/api/v1/auth/logout" });
      token = undefined; // 服务端已吊销，本地同步清除
    },

    async me() {
      return (await request({ method: "GET", path: "/api/v1/me", schema: OnlineUserSchema })) as OnlineUser;
    },

    async listWorkspaces() {
      return (await request({ method: "GET", path: "/api/v1/workspaces", schema: z.array(OnlineWorkspaceSummarySchema) })) as OnlineWorkspaceSummary[];
    },

    async createWorkspace(input) {
      return (await request({ method: "POST", path: "/api/v1/workspaces", body: input, schema: OnlineWorkspaceCreatedSchema })) as OnlineWorkspaceCreated;
    },

    async getWorkspace(workspaceId) {
      return (await request({ method: "GET", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, schema: OnlineWorkspaceDetailSchema })) as OnlineWorkspaceDetail;
    },

    async getTree(workspaceId) {
      return (await request({ method: "GET", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tree`, schema: OnlineTreeSchema })) as OnlineTree;
    },

    async getFiles(workspaceId, paths) {
      OnlineGetFilesInputSchema.parse({ paths }); // ≤200 路径/批（§3.4）
      return (await request({
        method: "GET",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files`,
        query: { paths: paths.join(",") },
        schema: OnlineFilesResultSchema,
      })) as OnlineFilesResult;
    },

    async putFile(workspaceId, input) {
      OnlinePathSchema.parse(input.path); // path 规则护栏（§3.4），非法不发请求
      return (await request({
        method: "PUT",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files/${encodePath(input.path)}`,
        body: { content: input.content, baseVersion: input.baseVersion },
        schema: OnlinePutFileResultSchema,
      })) as OnlinePutFileResult;
    },

    async batchPush(workspaceId, input) {
      OnlineBatchInputSchema.parse(input); // ≤200 条/批 + 逐条 path 规则
      return (await request({
        method: "POST",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files/batch`,
        body: input,
        schema: OnlineBatchResultSchema,
      })) as OnlineBatchResult;
    },

    async onlineProjectMapping(workspaceId, entries) {
      OnlineMappingInputSchema.parse({ entries }); // ≤200 条/批 + 名称约束护栏
      return (await request({
        method: "POST",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/project-mapping`,
        body: { entries },
        schema: OnlineMappingResultSchema,
      })) as OnlineMappingResult;
    },

    async listGroups(workspaceId) {
      return (await request({
        method: "GET",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/groups`,
        schema: z.array(OnlineGroupSchema),
      })) as OnlineGroup[];
    },

    async deleteFile(workspaceId, input) {
      OnlinePathSchema.parse(input.path);
      await request({
        method: "DELETE",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files/${encodePath(input.path)}`,
        query: { baseVersion: String(input.baseVersion) },
      });
    },

    async manageMembers(workspaceId, raw) {
      const parsed = OnlineMemberMutationSchema.safeParse(raw);
      if (!parsed.success) throw new OnlineApiError(0, 'access_upgrade_required', '访问协议需要实际期望修订，请同步升级并刷新后保留草稿重试 / Upgrade the access client and refresh the actual revision; keep your draft.');
      const input = parsed.data;
      if ("role" in input) {
        await request({ method: "PUT", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(input.userId)}`, body: { role: input.role, expectedRevision: input.expectedRevision, ...(input.expectedActorRevision === undefined ? {} : { expectedActorRevision: input.expectedActorRevision }) } });
        return;
      }
      await request({ method: "DELETE", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(input.userId)}`, query: { expectedRevision: String(input.expectedRevision) } });
    },

    async manageAcl(workspaceId, projectId, raw) {
      const path = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/acl`;
      if (raw === undefined) {
        return (await request({ method: "GET", path, schema: z.array(OnlineAclEntrySchema) })) as OnlineAclEntry[];
      }
      const parsed = OnlineAclMutationSchema.safeParse(raw);
      if (!parsed.success) throw new OnlineApiError(0, 'access_upgrade_required', '访问协议需要实际期望修订，请同步升级并刷新后保留草稿重试 / Upgrade the access client and refresh the actual revision; keep your draft.');
      const input = parsed.data;
      if ("op" in input) {
        // DELETE 行 = 恢复工作区角色继承（契约修订 2026-09-03）；与 manageMembers 的 remove 同构
        await request({ method: "DELETE", path, query: { userId: input.userId, expectedRevision: String(input.expectedRevision) } });
        return;
      }
      await request({ method: "PUT", path, body: input });
    },
  };
}
