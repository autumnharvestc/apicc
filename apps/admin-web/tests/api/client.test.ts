// M4-A 任务 1：adminClient 测试——注入假 fetch 钉住请求拼装（方法/路径/JSON 体/Authorization 头/
// 查询串）与错误归一（HTTP 按 status+{code,message}；body 非 JSON → protocol_error；
// 网络层 → network_error；401 → 会话失效回调，登录自身 401 不触发——裁定④同 desktop 语义）。
import { describe, expect, it, vi } from "vitest";
import { createAdminClient, AdminApiError, AdminProtocolError } from "../../src/api/client.js";

interface CapturedRequest { url: string; method: string; headers: Record<string, string>; body?: unknown; signal: AbortSignal }
type FetchHandler = (req: CapturedRequest) => Response | Promise<Response>;

/** 假 fetch：记录 (url/init) 供断言，按 handler 回包。 */
function fetchStub(handler: FetchHandler) {
  const calls: CapturedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const req: CapturedRequest = { url: String(input), method: init?.method ?? "GET", headers: rawHeaders, body, signal: init?.signal as AbortSignal };
    calls.push(req);
    return handler(req);
  };
  return { calls, impl };
}

const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const noContent = (): Response => new Response(null, { status: 204 });
// baseUrl 语义 = API 根（含 /api/v1 段，裁定③；分离部署即 VITE_API_BASE 覆盖值），
// 端点路径相对该根拼装。
const BASE = "http://127.0.0.1:8080/api/v1";
const USER = { id: "u-1", username: "alice", displayName: "Alice" };

describe("adminClient 请求拼装", () => {
  it("register：POST /auth/register + JSON 体 + Content-Type（无 Authorization）", async () => {
    const { calls, impl } = fetchStub(() => json(201, USER));
    const client = createAdminClient({ baseUrl: BASE + "/", fetch: impl });
    const user = await client.register({ username: "alice", password: "password8", displayName: "Alice" });
    expect(user).toEqual(USER);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/auth/register`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
    expect(calls[0]!.body).toEqual({ username: "alice", password: "password8", displayName: "Alice" });
  });

  it("register 入参护栏：违规用户名/密码不发请求（§3.1 校验前置）", async () => {
    const { calls, impl } = fetchStub(() => json(201, USER));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl });
    await expect(client.register({ username: "a.b", password: "password8", displayName: "x" })).rejects.toThrow();
    await expect(client.register({ username: "alice", password: "short", displayName: "x" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("login：存 token；后续请求自动带 Authorization: Bearer", async () => {
    const { calls, impl } = fetchStub((req) =>
      req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, USER),
    );
    const client = createAdminClient({ baseUrl: BASE, fetch: impl });
    const result = await client.login({ username: "alice", password: "password8" });
    expect(result.token).toBe("tok-1");
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
    await client.me();
    expect(calls[1]!.url).toBe(`${BASE}/me`);
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("logout：POST 204 → void 且清除 token（后续请求不再带头）", async () => {
    const { calls, impl } = fetchStub((req) => (req.url.endsWith("/auth/logout") ? noContent() : json(200, USER)));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    await client.logout();
    expect(calls[0]!.url).toBe(`${BASE}/auth/logout`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-1");
    await client.me();
    expect(calls[1]!.headers["Authorization"]).toBeUndefined();
  });

  it("listWorkspaces / createWorkspace：GET/POST /api/v1/workspaces", async () => {
    const rows = [{ id: "ws-1", name: "团队空间", myRole: "OWNER", createdAt: "2026-09-03T00:00:00Z" }];
    const { calls, impl } = fetchStub((req) => (req.method === "GET" ? json(200, rows) : json(201, { id: "ws-2", name: "新空间", myRole: "OWNER" })));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.listWorkspaces()).toEqual(rows);
    expect(calls[0]!.url).toBe(`${BASE}/workspaces`);
    expect(await client.createWorkspace({ name: "新空间" })).toEqual({ id: "ws-2", name: "新空间", myRole: "OWNER" });
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.body).toEqual({ name: "新空间" });
  });

  it("getWorkspace / deleteWorkspace：GET/DELETE /api/v1/workspaces/{id}（id 逐段编码）", async () => {
    const detail = { id: "ws 1", name: "团队空间", myRole: "OWNER", memberCount: 3 };
    const { calls, impl } = fetchStub((req) => (req.method === "GET" ? json(200, detail) : noContent()));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.getWorkspace("ws 1")).toEqual(detail);
    expect(calls[0]!.url).toBe(`${BASE}/workspaces/ws%201`);
    await client.deleteWorkspace("ws 1");
    expect(calls[1]!.method).toBe("DELETE");
    expect(calls[1]!.url).toBe(`${BASE}/workspaces/ws%201`);
  });

  it("成员管理：listMembers GET；setMemberRole PUT { role }；removeMember DELETE（§3.2）", async () => {
    const members = [{ userId: "u-2", username: "bob", displayName: "Bob", role: "EDITOR" }];
    const { calls, impl } = fetchStub((req) => (req.method === "GET" ? json(200, members) : noContent()));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.listMembers("ws-1")).toEqual(members);
    expect(calls[0]!.url).toBe(`${BASE}/workspaces/ws-1/members`);
    await client.setMemberRole("ws-1", "u-2", "ADMIN");
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.url).toBe(`${BASE}/workspaces/ws-1/members/u-2`);
    expect(calls[1]!.body).toEqual({ role: "ADMIN" });
    await client.removeMember("ws-1", "u-2");
    expect(calls[2]!.method).toBe("DELETE");
    expect(calls[2]!.url).toBe(`${BASE}/workspaces/ws-1/members/u-2`);
  });

  it("searchUserCandidates：GET member-candidates 携 q/limit 并解析数组", async () => {
    const { calls, impl } = fetchStub(() => json(200, [{ id: "u-9", username: "dave", displayName: "Dave" }]));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.searchUserCandidates("ws-1", "da", 10)).toEqual([{ id: "u-9", username: "dave", displayName: "Dave" }]);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${BASE}/workspaces/ws-1/member-candidates?q=da&limit=10`);
  });

  it("getTree：GET /api/v1/workspaces/{id}/tree（管理面项目清单来源，projects[].path 必备）", async () => {
    const tree = { workspaceId: "ws-1", rootVersion: 42, files: [], projects: [{ id: "p-1", name: "订单", path: "groups/订单/projects/订单", myRole: "EDITOR" }] };
    const { calls, impl } = fetchStub(() => json(200, tree));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.getTree("ws-1")).toEqual(tree);
    expect(calls[0]!.url).toBe(`${BASE}/workspaces/ws-1/tree`);
  });

  it("项目 ACL：listAcl GET；setAclEntry PUT { userId, role }（NONE=拒之门外）；deleteAclEntry DELETE ?userId=（契约修订 2026-09-04：删行=恢复工作区角色继承）", async () => {
    const entries = [{ userId: "u-2", role: "VIEWER" }, { userId: "u-3", role: "NONE" }];
    const { calls, impl } = fetchStub((req) => (req.method === "GET" ? json(200, entries) : noContent()));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.listAcl("ws-1", "p-1")).toEqual(entries);
    expect(calls[0]!.url).toBe(`${BASE}/workspaces/ws-1/projects/p-1/acl`);
    await client.setAclEntry("ws-1", "p-1", { userId: "u-3", role: "NONE" });
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.body).toEqual({ userId: "u-3", role: "NONE" });
    await client.deleteAclEntry("ws-1", "p-1", "u-3");
    expect(calls[2]!.method).toBe("DELETE");
    expect(calls[2]!.url).toBe(`${BASE}/workspaces/ws-1/projects/p-1/acl?userId=u-3`);
  });

  it("setToken/clearToken：注入与清除会话令牌", async () => {
    const { calls, impl } = fetchStub(() => json(200, USER));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl });
    client.setToken("tok-9");
    await client.me();
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-9");
    client.clearToken();
    await client.me();
    expect(calls[1]!.headers["Authorization"]).toBeUndefined();
  });

  it("默认 baseUrl 同源 /api/v1（裁定③）；VITE_API_BASE 覆盖生效（裁定 A：stub env 免疫 CI 环境）", async () => {
    const { calls, impl } = fetchStub(() => json(200, USER));
    vi.stubEnv("VITE_API_BASE", "https://stub.example.com/api/v1");
    try {
      const overridden = createAdminClient({ fetch: impl, token: "tok-1" });
      expect(overridden.baseUrl).toBe("https://stub.example.com/api/v1");
      await overridden.me();
      expect(calls[0]!.url).toBe("https://stub.example.com/api/v1/me");
    } finally {
      vi.unstubAllEnvs();
    }
    const fallback = createAdminClient({ fetch: impl });
    expect(fallback.baseUrl).toBe("/api/v1");
    await fallback.me();
    expect(calls[1]!.url).toBe("/api/v1/me");
  });

  it("setOnUnauthorized：运行期接线/覆盖会话失效钩子（组合根先建 client 后建 store 的装配顺序）", async () => {
    const early = vi.fn();
    const late = vi.fn();
    const { impl } = fetchStub(() => json(401, { code: "token_expired", message: "登录已过期" }));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, token: "tok-1", onUnauthorized: early });
    client.setOnUnauthorized(late);
    await expect(client.me()).rejects.toMatchObject({ status: 401 });
    expect(early).not.toHaveBeenCalled();
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe("adminClient 错误归一（裁定④：同 desktop onlineClient 语义）", () => {
  it("错误体 { code, message } → AdminApiError 保留 status/code/message", async () => {
    const { impl } = fetchStub(() => json(400, { code: "validation_failed", message: "校验失败" }));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("validation_failed");
    expect(err.message).toBe("校验失败");
  });

  it("403 registration_disabled 与 409 username_taken 均按统一错误形状携带（管理面无冲突特判）", async () => {
    const { impl } = fetchStub(() => json(409, { code: "username_taken", message: "用户名已被占用" }));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl });
    const err = await client.register({ username: "alice", password: "password8", displayName: "Alice" }).catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("username_taken");
  });

  it("错误体非 JSON（网关 HTML 等）→ protocol_error", async () => {
    const { impl } = fetchStub(() => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(AdminProtocolError);
    expect(err.code).toBe("protocol_error");
  });

  it("错误体缺 { code, message }（如仅 { code }）→ protocol_error", async () => {
    const { impl } = fetchStub(() => json(404, { code: "not_found" }));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(AdminProtocolError);
  });

  it("成功体形状不符（safeParse 失败）→ protocol_error", async () => {
    const { impl } = fetchStub(() => json(200, { unexpected: true }));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(AdminProtocolError);
    expect(err.code).toBe("protocol_error");
  });

  it("网络层异常 → network_error（status=0）", async () => {
    const { impl } = fetchStub(() => {
      throw new TypeError("fetch failed");
    });
    const client = createAdminClient({ baseUrl: BASE, fetch: impl });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("network_error");
  });

  it("超时（AbortSignal.timeout 触发 abort）→ network_error", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    const client = createAdminClient({ baseUrl: BASE, fetch: hanging, timeoutMs: 20 });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.code).toBe("network_error");
  });

  it("带 token 的请求 401 → 触发会话失效事件一次（并仍拒绝 AdminApiError 401）", async () => {
    const onUnauthorized = vi.fn();
    const { impl } = fetchStub(() => json(401, { code: "token_expired", message: "登录已过期" }));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, token: "tok-1", onUnauthorized });
    await expect(client.me()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("登录 401（未带 token）→ 不触发会话失效事件（裁定④）", async () => {
    const onUnauthorized = vi.fn();
    const { impl } = fetchStub(() => json(401, { code: "invalid_credentials", message: "用户名或密码错误" }));
    const client = createAdminClient({ baseUrl: BASE, fetch: impl, onUnauthorized });
    const err = await client.login({ username: "alice", password: "wrong" }).catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_credentials");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
