// M3-B 任务 1：online:* 频道 IPC 接线测试——zod 校验、登录→存 token→请求自动带头、
// 409 冲突经处理器转为冲突结果对象、401 会话失效清 token、未登录可读错误。
import { describe, expect, it, vi } from "vitest";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import type { OnlineClient } from "../../../src/main/online/client.js";
import type { TokenStore } from "../../../src/main/online/tokenStore.js";

const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const USER = { id: "u-1", username: "alice", displayName: "Alice" };

interface CapturedRequest { url: string; method: string; headers: Record<string, string>; body?: unknown }

/** 组合：createIpcDeps + 注入假 fetch 的 createClient 工厂 + 内存 tokenStore。 */
function setup(handler: (req: CapturedRequest) => Response) {
  const calls: CapturedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    const req: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    return handler(req);
  };
  const savedTokens = new Map<string, string>();
  let cleared: string[] = [];
  const tokenStore: TokenStore = {
    save: (baseUrl, token) => {
      savedTokens.set(baseUrl, token);
    },
    load: (baseUrl) => savedTokens.get(baseUrl) ?? null,
    clear: (baseUrl) => {
      cleared = [...cleared, baseUrl];
      savedTokens.delete(baseUrl);
    },
  };
  const deps = createIpcDeps({
    session: createSession(),
    pickDirectory: async () => "",
    saveFile: async () => "",
    online: {
      createClient: (baseUrl, hooks): OnlineClient =>
        createOnlineClient({ baseUrl, fetch: impl, timeoutMs: 5_000, onUnauthorized: hooks.onUnauthorized }),
      tokenStore,
    },
  });
  return { deps, calls, savedTokens, tokenStore, getCleared: () => cleared };
}

describe("online:* 频道接线", () => {
  it("online:login → 请求拼装正确、token 入库、返回不含 token（token 不出 main 进程）；后续 me 自动带头", async () => {
    const { deps, calls, savedTokens } = setup((req) =>
      req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, USER),
    );
    const result = await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    expect(result).toEqual({ expiresAt: "2026-10-03T00:00:00Z", user: USER });
    expect(result).not.toHaveProperty("token");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/api/v1/auth/login");
    expect(savedTokens.get("http://127.0.0.1:8080")).toBe("tok-1");
    expect(await deps.handle("online:me", {})).toEqual(USER);
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("online:register 不建立会话（不存 token）", async () => {
    const { deps, savedTokens } = setup(() => json(201, USER));
    const user = await deps.handle("online:register", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8", displayName: "Alice" });
    expect(user).toEqual(USER);
    expect(savedTokens.size).toBe(0);
  });

  it("online:files:put 遇 409 → 处理器返回 { outcome: conflict, conflict }（冲突对象过 IPC 不丢字段）", async () => {
    const conflict = { code: "version_conflict", currentVersion: 9, currentHash: "h9" };
    const { deps } = setup((req) => (req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(409, conflict)));
    await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    const result = await deps.handle("online:files:put", {}, { workspaceId: "ws-1", path: "a.yaml", content: "x", baseVersion: 7 });
    expect(result).toEqual({ outcome: "conflict", conflict });
  });

  it("online:files:put 成功 → { outcome: pushed, result }；delete → { outcome: deleted }", async () => {
    const { deps } = setup((req) => {
      if (req.url.endsWith("/auth/login")) return json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER });
      if (req.method === "PUT") return json(201, { path: "a.yaml", version: 8, hash: "h8" });
      return new Response(null, { status: 204 });
    });
    await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    expect(await deps.handle("online:files:put", {}, { workspaceId: "ws-1", path: "a.yaml", content: "x", baseVersion: 7 }))
      .toEqual({ outcome: "pushed", result: { path: "a.yaml", version: 8, hash: "h8" } });
    expect(await deps.handle("online:files:delete", {}, { workspaceId: "ws-1", path: "a.yaml", baseVersion: 8 }))
      .toEqual({ outcome: "deleted" });
  });

  it("带 token 请求 401 → 会话失效：token 清除 + 后续调用抛「尚未登录」", async () => {
    const { deps, getCleared } = setup((req) => (req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(401, { code: "token_expired", message: "登录已过期" })));
    await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    await expect(deps.handle("online:me", {})).rejects.toMatchObject({ message: "登录已过期" });
    expect(getCleared()).toEqual(["http://127.0.0.1:8080"]);
    await expect(deps.handle("online:me", {})).rejects.toThrow(/尚未登录/);
  });

  it("online:logout → 调用服务端吊销并清 token；后续调用抛「尚未登录」", async () => {
    const { deps, calls, getCleared } = setup((req) => (req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : new Response(null, { status: 204 })));
    await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    await deps.handle("online:logout", {});
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url).toBe("http://127.0.0.1:8080/api/v1/auth/logout");
    expect(getCleared()).toEqual(["http://127.0.0.1:8080"]);
    await expect(deps.handle("online:me", {})).rejects.toThrow(/尚未登录/);
  });

  it("未登录时内容频道抛「尚未登录」；入参非法走 zod 校验错误", async () => {
    const { deps } = setup(() => json(200, []));
    await expect(deps.handle("online:workspaces:list", {})).rejects.toThrow(/尚未登录/);
    await expect(deps.handle("online:login", {}, { baseUrl: "ftp://x", username: "a", password: "b" })).rejects.toThrow(/入参校验失败/);
    await expect(deps.handle("online:files:put", {}, { workspaceId: "ws-1", path: "../x", content: "", baseVersion: 0 })).rejects.toThrow(/入参校验失败/);
  });

  it("online 依赖未注入 → 可读错误（在线功能未配置）", async () => {
    const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "" });
    await expect(deps.handle("online:me", {})).rejects.toThrow(/在线功能未配置/);
  });

  // —— 任务 2 裁定 A：online:resume 恢复链路频道 ——
  it("online:resume：登录后有存档 → restored 携用户；换新 deps（重启语义）→ me 带恢复 token", async () => {
    const first = setup((req) => (req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, USER)));
    await first.deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    // 重启语义：同一 tokenStore 存档 + 全新 ipc deps（main 进程重新组装）
    const second = setup(() => json(200, USER));
    second.tokenStore.save("http://127.0.0.1:8080", "tok-1");
    const out = await second.deps.handle("online:resume", {}, { baseUrl: "http://127.0.0.1:8080" });
    expect(out).toEqual({ outcome: "restored", user: USER });
    const meCall = second.calls.find((c) => c.url.endsWith("/me"))!;
    expect(meCall.headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("online:resume：过期存档 → signed-out（已清档）；无存档 → signed-out；入参非法走 zod 校验", async () => {
    const expired = setup((req) => (req.url.endsWith("/me") ? json(401, { code: "token_expired", message: "登录已过期" }) : json(200, USER)));
    expired.tokenStore.save("http://127.0.0.1:8080", "tok-stale");
    await expect(expired.deps.handle("online:resume", {}, { baseUrl: "http://127.0.0.1:8080" })).resolves.toEqual({ outcome: "signed-out" });
    expect(expired.getCleared()).toEqual(["http://127.0.0.1:8080"]);
    const guest = setup(() => json(200, USER));
    await expect(guest.deps.handle("online:resume", {}, { baseUrl: "http://127.0.0.1:8080" })).resolves.toEqual({ outcome: "signed-out" });
    await expect(guest.deps.handle("online:resume", {}, { baseUrl: "ftp://x" })).rejects.toThrow(/入参校验失败/);
  });
});
