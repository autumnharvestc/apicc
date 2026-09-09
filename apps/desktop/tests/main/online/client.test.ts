// M3-B 任务 1：onlineClient 测试——注入假 fetch 钉住请求拼装（方法/路径/JSON 体/Authorization 头）
// 与错误归一（HTTP 按 status+{code,message}；body 非 JSON → protocol_error；网络层 → network_error）。
import { describe, expect, it, vi } from "vitest";
import { createOnlineClient, OnlineApiError, OnlineConflictError, OnlineProtocolError } from "../../../src/main/online/client.js";

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
const BASE = "http://127.0.0.1:8080";
const USER = { id: "u-1", username: "alice", displayName: "Alice" };

describe("onlineClient 请求拼装", () => {
  it("register：POST /api/v1/auth/register + JSON 体 + Content-Type（无 Authorization）", async () => {
    const { calls, impl } = fetchStub(() => json(201, USER));
    const client = createOnlineClient({ baseUrl: BASE + "/", fetch: impl });
    const user = await client.register({ username: "alice", password: "password8", displayName: "Alice" });
    expect(user).toEqual(USER);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/auth/register`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
    expect(calls[0]!.body).toEqual({ username: "alice", password: "password8", displayName: "Alice" });
  });

  it("login：存 token；后续请求自动带 Authorization: Bearer", async () => {
    const { calls, impl } = fetchStub((req) =>
      req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, USER),
    );
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl });
    const result = await client.login({ username: "alice", password: "password8" });
    expect(result.token).toBe("tok-1");
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
    await client.me();
    expect(calls[1]!.url).toBe(`${BASE}/api/v1/me`);
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("logout：POST 204 → void 且清除 token（后续请求不再带头）", async () => {
    const { calls, impl } = fetchStub((req) => (req.url.endsWith("/auth/logout") ? new Response(null, { status: 204 }) : json(200, USER)));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    await client.logout();
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/auth/logout`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-1");
    await client.me();
    expect(calls[1]!.headers["Authorization"]).toBeUndefined();
  });

  it("listWorkspaces / createWorkspace：GET/POST /api/v1/workspaces", async () => {
    const rows = [{ id: "ws-1", name: "团队空间", myRole: "OWNER", createdAt: "2026-09-03T00:00:00Z" }];
    const { calls, impl } = fetchStub((req) => (req.method === "GET" ? json(200, rows) : json(201, { id: "ws-2", name: "新空间", myRole: "OWNER" })));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.listWorkspaces()).toEqual(rows);
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/workspaces`);
    expect(await client.createWorkspace({ name: "新空间" })).toEqual({ id: "ws-2", name: "新空间", myRole: "OWNER" });
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.body).toEqual({ name: "新空间" });
  });

  it("getTree：GET /api/v1/workspaces/{id}/tree", async () => {
    const tree = { workspaceId: "ws-1", rootVersion: 42, files: [], projects: [{ id: "p-1", name: "订单", path: "groups/后端/projects/订单", myRole: "EDITOR" }] };
    const { calls, impl } = fetchStub(() => json(200, tree));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.getTree("ws-1")).toEqual(tree);
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/tree`);
  });

  it("getFiles：paths 逗号拼接并整体 URL 编码", async () => {
    const result = { files: [{ path: "a.yaml", content: "x", version: 1, hash: "h" }], missing: [] };
    const { calls, impl } = fetchStub(() => json(200, result));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.getFiles("ws-1", ["groups/订单/a.yaml", "b.yaml"])).toEqual(result);
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/files?paths=${encodeURIComponent("groups/订单/a.yaml,b.yaml")}`);
  });

  it("putFile：PUT 逐段编码路径 + { content, baseVersion } 体；新文件 baseVersion=0", async () => {
    const { calls, impl } = fetchStub(() => json(201, { path: "groups/订单/a.yaml", version: 8, hash: "h" }));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    const r = await client.putFile("ws-1", { path: "groups/订单/a.yaml", content: "id: a\n", baseVersion: 7 });
    expect(r).toEqual({ path: "groups/订单/a.yaml", version: 8, hash: "h" });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/files/${encodeURIComponent("groups")}/${encodeURIComponent("订单")}/a.yaml`);
    expect(calls[0]!.body).toEqual({ content: "id: a\n", baseVersion: 7 });
  });

  it("putFile 拒绝非法路径（..、绝对路径、反斜杠）；冒号不再客户端预拦（任务 7 对齐服务端实体化，盘符形态由服务端首段规则拦）", async () => {
    const { calls, impl } = fetchStub(() => json(201, { path: "a", version: 1, hash: "h" }));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl });
    await expect(client.putFile("ws-1", { path: "../x", content: "", baseVersion: 0 })).rejects.toThrow(/path/);
    await expect(client.putFile("ws-1", { path: "/abs", content: "", baseVersion: 0 })).rejects.toThrow(/path/);
    await expect(client.putFile("ws-1", { path: "a\\b", content: "", baseVersion: 0 })).rejects.toThrow(/path/);
    expect(calls).toHaveLength(0);
    // 含冒号路径客户端放行照发（服务端 400 path_invalid 为准）
    await expect(client.putFile("ws-1", { path: "C:/x", content: "", baseVersion: 0 })).resolves.toEqual({ path: "a", version: 1, hash: "h" });
    expect(calls).toHaveLength(1);
  });

  it("batchPush：POST /files/batch + { files: [...] } 体", async () => {
    const result = { results: [{ path: "a.yaml", status: "pushed", version: 3 }] };
    const { calls, impl } = fetchStub(() => json(200, result));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.batchPush("ws-1", { files: [{ path: "a.yaml", content: "x", baseVersion: 0 }] })).toEqual(result);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/files/batch`);
    expect(calls[0]!.body).toEqual({ files: [{ path: "a.yaml", content: "x", baseVersion: 0 }] });
  });

  it("onlineProjectMapping：POST /workspaces/{id}/project-mapping + { entries: [...] } 体（迁移映射桥，计划 C 任务 1 契约）", async () => {
    // 响应行三态：建成行（created 标记本轮新建）+ 缺失行 + 越权行（NON_NULL 缺席字段不序列化）
    const result = {
      mappings: [
        { group: "电商", project: "宠物商店", groupId: "g-1", projectId: "p-1", created: true },
        { group: "电商", project: "缺项目", missing: true },
        { group: "电商", project: "无权项目", forbidden: true },
      ],
    };
    const { calls, impl } = fetchStub(() => json(200, result));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    const entries = [
      { group: "电商", project: "宠物商店", createIfMissing: true },
      { group: "电商", project: "缺项目", createIfMissing: false },
    ];
    expect(await client.onlineProjectMapping("ws-1", entries)).toEqual(result);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/project-mapping`);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-1");
    expect(calls[0]!.body).toEqual({ entries });
  });

  it("listGroups：GET /workspaces/{id}/groups（迁移拉取 groupId → 组名反查数据源）", async () => {
    const rows = [{ id: "g-1", name: "默认分组", isDefault: true, createdAt: "2026-09-09T00:00:00Z" }];
    const { calls, impl } = fetchStub(() => json(200, rows));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.listGroups("ws-1")).toEqual(rows);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/groups`);
  });

  it("deleteFile：DELETE ?baseVersion= → 204 → void", async () => {
    const { calls, impl } = fetchStub(() => new Response(null, { status: 204 }));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    await expect(client.deleteFile("ws-1", { path: "a.yaml", baseVersion: 3 })).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/files/a.yaml?baseVersion=3`);
  });

  it("manageMembers：role → PUT；remove → DELETE", async () => {
    const { calls, impl } = fetchStub(() => new Response(null, { status: 204 }));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    await client.manageMembers("ws-1", { userId: "u-2", role: "EDITOR" });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/members/u-2`);
    expect(calls[0]!.body).toEqual({ role: "EDITOR" });
    await client.manageMembers("ws-1", { userId: "u-2", op: "remove" });
    expect(calls[1]!.method).toBe("DELETE");
    expect(calls[1]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/members/u-2`);
  });

  it("manageAcl：无 body → GET；带 { userId, role } → PUT；{ userId, op: 'remove' } → DELETE ?userId=（契约修订：删 ACL 行=恢复工作区角色继承）", async () => {
    const entries = [{ userId: "u-2", role: "VIEWER" }];
    const { calls, impl } = fetchStub((req) => (req.method === "GET" ? json(200, entries) : new Response(null, { status: 204 })));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    expect(await client.manageAcl("ws-1", "p-1")).toEqual(entries);
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/projects/p-1/acl`);
    await client.manageAcl("ws-1", "p-1", { userId: "u-2", role: "NONE" });
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.body).toEqual({ userId: "u-2", role: "NONE" });
    await client.manageAcl("ws-1", "p-1", { userId: "u-2", op: "remove" });
    expect(calls[2]!.method).toBe("DELETE");
    expect(calls[2]!.url).toBe(`${BASE}/api/v1/workspaces/ws-1/projects/p-1/acl?userId=u-2`);
    expect(await client.manageAcl("ws-1", "p-1", { userId: "u-2", op: "remove" })).toBeUndefined(); // 204 归一为 void
  });
});

describe("onlineClient 错误归一", () => {
  it("错误体 { code, message } → OnlineApiError 保留 status/code/message", async () => {
    const { impl } = fetchStub(() => json(400, { code: "validation_failed", message: "校验失败" }));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(OnlineApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("validation_failed");
    expect(err.message).toBe("校验失败");
  });

  it("409 version_conflict → OnlineConflictError 冲突对象原样携带", async () => {
    const conflict = { code: "version_conflict", currentVersion: 9, currentHash: "h9" };
    const { impl } = fetchStub(() => json(409, conflict));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    const err = await client.putFile("ws-1", { path: "a.yaml", content: "x", baseVersion: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(OnlineConflictError);
    expect(err.conflict).toEqual(conflict);
  });

  // M3-C 前置对齐①：服务端新文件并发删除场景 409 带 currentHash:null（真实响应形状取自
  // GlobalExceptionHandler.ConflictError 序列化）。strict schema 修前 safeParse 失败会退化
  // 为普通 OnlineApiError，冲突对话框不出现——修后必须走通冲突路径。
  it("409 冲突 currentHash 为 null（服务端新文件并发删除）→ 仍走 OnlineConflictError（M3-C 前置对齐①）", async () => {
    const conflict = { code: "version_conflict", message: "baseVersion 与服务端现状不一致", currentVersion: 0, currentHash: null };
    const { impl } = fetchStub(() => json(409, conflict));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    const err = await client.putFile("ws-1", { path: "a.yaml", content: "x", baseVersion: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(OnlineConflictError);
    expect(err.conflict).toEqual(conflict);
    expect(err.conflict.currentHash).toBeNull();
  });

  it("409 但 body 非 version_conflict → 按统一错误形状处理", async () => {
    const { impl } = fetchStub(() => json(409, { code: "workspace_deleted", message: "工作区已删除" }));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    const err = await client.putFile("ws-1", { path: "a.yaml", content: "x", baseVersion: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(OnlineApiError);
    expect(err.code).toBe("workspace_deleted");
  });

  it("错误体非 JSON（网关 HTML 等）→ protocol_error", async () => {
    const { impl } = fetchStub(() => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(OnlineProtocolError);
    expect(err.code).toBe("protocol_error");
  });

  it("成功体形状不符（safeParse 失败）→ protocol_error", async () => {
    const { impl } = fetchStub(() => json(200, { unexpected: true }));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1" });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(OnlineProtocolError);
    expect(err.code).toBe("protocol_error");
  });

  it("网络层异常 → network_error", async () => {
    const { impl } = fetchStub(() => {
      throw new TypeError("fetch failed");
    });
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(OnlineApiError);
    expect(err.code).toBe("network_error");
  });

  it("baseUrl 不可解析 → network_error 归一（不裸抛 TypeError，任务 2 裁定 B②）", async () => {
    const { impl } = fetchStub(() => json(200, USER));
    const client = createOnlineClient({ baseUrl: "::not a url::", fetch: impl });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(OnlineApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("network_error");
  });

  it("超时（AbortSignal.timeout 触发）→ network_error", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    const client = createOnlineClient({ baseUrl: BASE, fetch: hanging, timeoutMs: 20 });
    const err = await client.me().catch((e) => e);
    expect(err.code).toBe("network_error");
  });

  it("带 token 的请求 401 → 触发会话失效事件一次", async () => {
    const onUnauthorized = vi.fn();
    const { impl } = fetchStub(() => json(401, { code: "token_expired", message: "登录已过期" }));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, token: "tok-1", onUnauthorized });
    await expect(client.me()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("登录 401（未带 token）→ 不触发会话失效事件", async () => {
    const onUnauthorized = vi.fn();
    const { impl } = fetchStub(() => json(401, { code: "invalid_credentials", message: "用户名或密码错误" }));
    const client = createOnlineClient({ baseUrl: BASE, fetch: impl, onUnauthorized });
    const err = await client.login({ username: "alice", password: "wrong" }).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_credentials");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
