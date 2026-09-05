// M4-A 任务 2：session store 工厂测试（裁定 B）——登录成功（token 入 localStorage + user 态）、
// 登录失败（error 通道不清旧态，desktop 同语义）、注册（不建立登录态）、登出（先吊销后清本地，
// 吊销失败不阻断）、initialize 验活恢复（成功 → authenticated；401/网络错误 → 清档登出态）；
// 401 拦截钩子由工厂接装到 client（setOnUnauthorized）→ 清会话 + 注入回调。storage 注入内存
// 替身保证隔离（desktop online.test.ts 先例）；client 用假 fetch 替身（任务 1 先例）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "../../src/api/client.js";
import { createSessionStore, TOKEN_KEY } from "../../src/stores/session.js";

interface CapturedRequest { url: string; method: string; headers: Record<string, string>; body?: unknown }
type FetchHandler = (req: CapturedRequest) => Response | Promise<Response>;

function fetchStub(handler: FetchHandler) {
  const calls: CapturedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const req: CapturedRequest = { url: String(input), method: init?.method ?? "GET", headers: rawHeaders, body };
    calls.push(req);
    return handler(req);
  };
  return { calls, impl };
}

const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const noContent = (): Response => new Response(null, { status: 204 });

const BASE = "http://127.0.0.1:8080/api/v1";
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const LOGIN_OK = { token: "tok-abc123", expiresAt: "2026-10-03T00:00:00Z", user: USER };

/** 内存 Storage 替身：与 localStorage 同形，实例间互不共享（工厂隔离断言用）。 */
function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function setup(handler: FetchHandler) {
  const stub = fetchStub(handler);
  const client = createAdminClient({ baseUrl: BASE, fetch: stub.impl });
  const storage = memStorage();
  const onSessionExpired = vi.fn();
  const store = createSessionStore({ client, storage, onSessionExpired });
  return { calls: stub.calls, client, storage, onSessionExpired, store };
}

/** 预置登录态：真实走一遍 login（成功路径）。 */
async function loginAs(handler: FetchHandler = () => json(200, LOGIN_OK)) {
  const ctx = setup(handler);
  await ctx.store.login({ username: "alice", password: "password8" });
  return ctx;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sessionStore 工厂隔离", () => {
  it("两实例（各自 storage/client）登录态互不可见", async () => {
    const a = setup(() => json(200, LOGIN_OK));
    const b = setup(() => json(200, LOGIN_OK));
    await a.store.login({ username: "alice", password: "password8" });
    expect(a.store.isAuthenticated).toBe(true);
    expect(a.storage.getItem(TOKEN_KEY)).toBe("tok-abc123");
    expect(b.store.isAuthenticated).toBe(false);
    expect(b.store.user).toBeNull();
    expect(b.storage.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe("login（裁定 B：成功入 localStorage；失败 error 通道不清旧态）", () => {
  it("登录成功：token 持久化 + user 态 + status=authenticated", async () => {
    const { calls, store, storage } = await loginAs();
    expect(calls[0]!.url).toBe(`${BASE}/auth/login`);
    expect(calls[0]!.body).toEqual({ username: "alice", password: "password8" });
    expect(store.token).toBe("tok-abc123");
    expect(storage.getItem(TOKEN_KEY)).toBe("tok-abc123");
    expect(store.user).toEqual(USER);
    expect(store.status).toBe("authenticated");
    expect(store.isAuthenticated).toBe(true);
    expect(store.error).toBeNull();
  });

  it("登录失败（无既有会话）：error 上屏、不落 token、status 回 idle", async () => {
    const { store, storage } = setup(() => json(401, { code: "invalid_credentials", message: "用户名或密码错误" }));
    await store.login({ username: "alice", password: "wrong" });
    expect(store.error).toBe("用户名或密码错误");
    expect(store.status).toBe("idle");
    expect(store.token).toBeUndefined();
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("登录失败（已有会话，网络错误）：error 上屏且不清旧态（沿用 desktop 语义）", async () => {
    let calls = 0;
    const ctx = setup(() => {
      calls += 1;
      if (calls === 1) return json(200, LOGIN_OK); // 首次登录成功建立会话
      throw new TypeError("fetch failed"); // 二次登录网络失败
    });
    await ctx.store.login({ username: "alice", password: "password8" });
    const savedToken = ctx.store.token;
    const savedUser = ctx.store.user;
    await ctx.store.login({ username: "alice", password: "password8" });
    expect(ctx.store.error).toContain("fetch failed");
    expect(ctx.store.status).toBe("authenticated"); // 旧态完整
    expect(ctx.store.token).toBe(savedToken);
    expect(ctx.store.user).toEqual(savedUser);
    expect(ctx.storage.getItem(TOKEN_KEY)).toBe("tok-abc123");
  });

  it("防重复提交：submitting 在途时再次 login 直接忽略", async () => {
    let release!: () => void;
    const gate = new Promise<Response>((resolve) => {
      release = () => resolve(json(200, LOGIN_OK));
    });
    const { calls, store } = setup(() => gate);
    const first = store.login({ username: "alice", password: "password8" });
    await vi.waitFor(() => expect(store.submitting).toBe(true));
    await store.login({ username: "alice", password: "password8" }); // 在途调用应被忽略
    release();
    await first;
    expect(calls.filter((c) => c.url.endsWith("/auth/login"))).toHaveLength(1);
    expect(store.isAuthenticated).toBe(true);
  });
});

describe("register（不建立登录态，契约语义 desktop 同）", () => {
  it("注册成功：返回 true、发 POST /auth/register、不建会话", async () => {
    const { calls, store, storage } = setup((req) => (req.url.endsWith("/auth/register") ? json(201, USER) : json(200, LOGIN_OK)));
    const ok = await store.register({ username: "alice", password: "password8", displayName: "Alice" });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe(`${BASE}/auth/register`);
    expect(calls[0]!.body).toEqual({ username: "alice", password: "password8", displayName: "Alice" });
    expect(store.status).toBe("idle");
    expect(store.token).toBeUndefined();
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("注册失败（409 username_taken）：返回 false + error 上屏", async () => {
    const { store } = setup(() => json(409, { code: "username_taken", message: "用户名已被占用" }));
    const ok = await store.register({ username: "alice", password: "password8", displayName: "Alice" });
    expect(ok).toBe(false);
    expect(store.error).toBe("用户名已被占用");
    expect(store.status).toBe("idle");
  });
});

describe("logout（先吊销后清本地；吊销失败不阻断）", () => {
  it("登出：POST /auth/logout 被吊销、本地态与存储清空", async () => {
    const { calls, store, storage } = await loginAs((req) => (req.url.endsWith("/auth/logout") ? noContent() : json(200, LOGIN_OK)));
    await store.logout();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/auth/logout"))).toBe(true);
    expect(store.status).toBe("idle");
    expect(store.token).toBeUndefined();
    expect(store.user).toBeNull();
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("吊销失败（网络错误）：本地登出照常完成（token 留服务端自然过期）", async () => {
    let calls = 0;
    const ctx = setup(() => {
      calls += 1;
      if (calls === 1) return json(200, LOGIN_OK);
      throw new TypeError("fetch failed");
    });
    await ctx.store.login({ username: "alice", password: "password8" });
    await ctx.store.logout();
    expect(ctx.store.status).toBe("idle");
    expect(ctx.storage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("未登录登出：不发请求直接幂等返回", async () => {
    const { calls, store } = setup(() => noContent());
    await store.logout();
    expect(calls).toHaveLength(0);
    expect(store.status).toBe("idle");
  });
});

describe("initialize（启动验活：desktop resume 语义对齐）", () => {
  it("无存档：保持登出态且不发请求", async () => {
    const { calls, store } = setup(() => json(200, USER));
    await store.initialize();
    expect(calls).toHaveLength(0);
    expect(store.status).toBe("idle");
    expect(store.isAuthenticated).toBe(false);
  });

  it("有存档 + /me 验活成功：恢复 authenticated + user", async () => {
    const { calls, store, storage, onSessionExpired } = setup((req) => (req.url.endsWith("/me") ? json(200, USER) : json(200, LOGIN_OK)));
    storage.setItem(TOKEN_KEY, "tok-saved");
    await store.initialize();
    expect(calls[0]!.url).toBe(`${BASE}/me`);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-saved");
    expect(store.status).toBe("authenticated");
    expect(store.user).toEqual(USER);
    expect(store.token).toBe("tok-saved");
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it("有存档 + /me 401：清档登出态 + 会话失效回调触发（钩子随验活请求触发）", async () => {
    const { calls, store, storage, onSessionExpired } = setup(() => json(401, { code: "token_expired", message: "登录已过期" }));
    storage.setItem(TOKEN_KEY, "tok-dead");
    await store.initialize();
    expect(calls[0]!.url).toBe(`${BASE}/me`);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-dead");
    expect(store.status).toBe("idle");
    expect(store.token).toBeUndefined();
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it("有存档 + /me 网络错误：清档登出态（不经 401 钩子，回调不触发）", async () => {
    const { calls, store, storage, onSessionExpired } = setup(() => {
      throw new TypeError("fetch failed");
    });
    storage.setItem(TOKEN_KEY, "tok-saved");
    await store.initialize();
    expect(calls[0]!.url).toBe(`${BASE}/me`);
    expect(store.status).toBe("idle");
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});

describe("401 拦截钩子接线（工厂装到 client.setOnUnauthorized）", () => {
  it("带 token 请求 401（登录后过期）→ 清会话 + onSessionExpired 一次", async () => {
    let mode: "ok" | "expired" = "ok";
    const ctx = setup(() => (mode === "ok" ? json(200, LOGIN_OK) : json(401, { code: "token_expired", message: "登录已过期" })));
    await ctx.store.login({ username: "alice", password: "password8" });
    mode = "expired";
    // initialize 重验活：token 在档 → GET /me 401 → 钩子链
    await ctx.store.initialize();
    expect(ctx.store.isAuthenticated).toBe(false);
    expect(ctx.storage.getItem(TOKEN_KEY)).toBeNull();
    expect(ctx.onSessionExpired).toHaveBeenCalledTimes(1);
  });
});
