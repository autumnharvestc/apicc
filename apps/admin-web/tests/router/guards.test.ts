// M4-A 任务 2/3：路由守卫测试（裁定 C）——受保护路由（meta.requiresAuth，父路由 "/" 上声明、
// 子路由随 meta 合并继承）无 token 重定向 /login 且携带 redirect=原 fullPath（回到原目标）；
// 登录后放行落到工作区列表（任务 3 起 "/" 由布局壳接管，index 重定向 /workspaces）。
// 真实 createAppRouter + 真实 session/workspaces store（隔离 storage）+ 假 fetch。
import { describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/api/client.js";
import { createAppRouter } from "../../src/router/index.js";
import { createSessionStore, TOKEN_KEY } from "../../src/stores/session.js";
import { createWorkspacesStore } from "../../src/stores/workspaces.js";
import { createUsersStore } from "../../src/stores/users.js";

interface CapturedRequest { url: string; method: string; headers: Record<string, string>; body?: unknown }

function fetchStub(handler: (req: CapturedRequest) => Response | Promise<Response>) {
  const impl: typeof fetch = async (input, init) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const req: CapturedRequest = { url: String(input), method: init?.method ?? "GET", headers: rawHeaders, body };
    return handler(req);
  };
  return impl;
}

const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const LOGIN_OK = { token: "tok-abc123", expiresAt: "2026-10-03T00:00:00Z", user: USER };

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

function setup() {
  const client = createAdminClient({
    baseUrl: "http://127.0.0.1:8080/api/v1",
    fetch: fetchStub((req) =>
      req.url.endsWith("/auth/login")
        ? json(200, LOGIN_OK)
        : req.url.endsWith("/workspaces") && req.method === "GET"
          ? json(200, [])
          : json(200, USER),
    ),
  });
  const session = createSessionStore({ client, storage: memStorage() });
  const workspaces = createWorkspacesStore({ client });
  const users = createUsersStore({ client });
  const router = createAppRouter({ session, workspaces, users });
  return { session, workspaces, router };
}

describe("路由守卫（裁定 C：requiresAuth + redirect 回跳）", () => {
  it("未登录访问受保护路由 / → 重定向 /login 且 query.redirect 携带原目标", async () => {
    const { router } = setup();
    await router.push("/");
    // vue-router 在守卫前解析 index 重定向：守卫见到的是解析后目标 /workspaces
    expect(router.currentRoute.value.name).toBe("login");
    expect(router.currentRoute.value.query.redirect).toBe("/workspaces");
  });

  it("未登录访问带查询串的受保护路径 → redirect 保留完整 fullPath", async () => {
    const { router } = setup();
    await router.push("/?x=1");
    expect(router.currentRoute.value.name).toBe("login");
    expect(router.currentRoute.value.query.redirect).toBe("/workspaces?x=1");
  });

  it("登录后访问 / → 放行经布局壳 index 重定向落到工作区列表（任务 3 起）", async () => {
    const { session, router } = setup();
    await session.login({ username: "alice", password: "password8" });
    expect(session.isAuthenticated).toBe(true);
    await router.push("/");
    expect(router.currentRoute.value.name).toBe("workspaces");
  });

  it("未登录访问 /login 本身 → 不重定向（登录页可直达）", async () => {
    const { router } = setup();
    await router.push("/login");
    expect(router.currentRoute.value.name).toBe("login");
    expect(router.currentRoute.value.query.redirect).toBeUndefined();
  });

  it("token 键名钉住：apicc.admin.token（裁定 B）", async () => {
    expect(TOKEN_KEY).toBe("apicc.admin.token");
  });
});
