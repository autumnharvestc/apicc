// M3-B 任务 2（裁定 A）：online session resume——token 恢复链路。
// 重启语义：login 存档 → 新 session 实例（生产 = 应用重启后 main 进程新建）→ resume →
// GET /me 验活 → 登录态恢复；过期 token（401）/网络错误/无存档 → 清档并保持登出态。
// login/logout 按 baseUrl 存取凭据（tokenStore 已改造为按 baseUrl 索引）。
import { describe, expect, it } from "vitest";
import { createOnlineSession } from "../../../src/main/online/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import type { TokenStore } from "../../../src/main/online/tokenStore.js";

const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const SERVER_A = "http://127.0.0.1:8080";
const SERVER_B = "http://192.168.1.10:8080";
const LOGIN_OK = (): Response => json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER });

interface CapturedRequest { url: string; method: string; headers: Record<string, string> }

/** 组合：可切换回包的假 fetch + 内存按 baseUrl 索引 tokenStore（记录 save/clear 供断言）。 */
function setup(initial: (req: CapturedRequest) => Response) {
  let handler = initial;
  const setHandler = (next: (req: CapturedRequest) => Response) => {
    handler = next;
  };
  const calls: CapturedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    const req: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(req);
    return handler(req);
  };
  const memory = new Map<string, string>();
  const saved: Array<[string, string]> = [];
  const cleared: string[] = [];
  const tokenStore: TokenStore = {
    save: (baseUrl, token) => {
      saved.push([baseUrl, token]);
      memory.set(baseUrl, token);
    },
    load: (baseUrl) => memory.get(baseUrl) ?? null,
    clear: (baseUrl) => {
      cleared.push(baseUrl);
      memory.delete(baseUrl);
    },
  };
  const makeSession = () =>
    createOnlineSession({
      createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: impl, timeoutMs: 5_000, onUnauthorized: hooks.onUnauthorized }),
      tokenStore,
    });
  return { makeSession, setHandler, calls, saved, cleared, getSaved: (baseUrl: string) => memory.get(baseUrl) ?? null, getClearedCount: () => cleared.length };
}

const route = (req: CapturedRequest): Response => {
  if (req.url.endsWith("/auth/login")) return LOGIN_OK();
  if (req.url.endsWith("/auth/logout")) return new Response(null, { status: 204 });
  return json(200, USER);
};

describe("online session resume（任务 2 裁定 A）", () => {
  it("重启语义：存档 → 新 session 实例 → resume → 登录态恢复（me 验活带头，后续请求可用）", async () => {
    const { makeSession, calls } = setup(route);
    await makeSession().login({ baseUrl: SERVER_A, username: "alice", password: "password8" });
    // 全新 session 实例（同一 tokenStore 存档）
    const fresh = makeSession();
    expect(fresh.current).toBeNull();
    const out = await fresh.resume(SERVER_A);
    expect(out.outcome).toBe("restored");
    if (out.outcome === "restored") expect(out.user).toEqual(USER);
    expect(fresh.current).toEqual({ baseUrl: SERVER_A });
    // 恢复后的会话可用：me 自动带恢复的 token（验活请求即带头）
    const meCall = calls.find((c) => c.url.endsWith("/me"))!;
    expect(meCall.headers["Authorization"]).toBe("Bearer tok-1");
    expect(await fresh.me()).toEqual(USER);
  });

  it("过期 token（resume 验活 401）→ 清档登出：tokenStore.clear(baseUrl)、current 为 null、后续调用抛「尚未登录」", async () => {
    const { makeSession, setHandler, cleared, getSaved } = setup(route);
    await makeSession().login({ baseUrl: SERVER_A, username: "alice", password: "password8" });
    // 重启后服务端 token 已过期：/me 401
    setHandler((req) => (req.url.endsWith("/me") ? json(401, { code: "token_expired", message: "登录已过期" }) : route(req)));
    const fresh = makeSession();
    const out = await fresh.resume(SERVER_A);
    expect(out).toEqual({ outcome: "signed-out" });
    // 401 钩子与 resume 失败收口都按捕获的 baseUrl 清档（幂等）：A 的凭据不再被持有
    expect(cleared.every((b) => b === SERVER_A)).toBe(true);
    expect(getSaved(SERVER_A)).toBeNull();
    expect(fresh.current).toBeNull();
    await expect(fresh.me()).rejects.toThrow(/尚未登录/);
  });

  it("resume 验活 401 只清目标服务器存档，不串档清当前会话存档（审查重要 1）", async () => {
    const { makeSession, setHandler, cleared, getSaved } = setup(route);
    const session = makeSession();
    await session.login({ baseUrl: SERVER_A, username: "alice", password: "password8" }); // A 存档 + current=A
    await makeSession().login({ baseUrl: SERVER_B, username: "alice", password: "password8" }); // B 存档（此前登录过）
    // B 的 token 已过期：仅对 B 的 /me 回 401
    setHandler((req) => (req.url === `${SERVER_B}/api/v1/me` ? json(401, { code: "token_expired", message: "登录已过期" }) : route(req)));
    // 修复前：resume 的 onUnauthorized 经 current 反查 → 把 A 的有效存档误清
    await expect(session.resume(SERVER_B)).resolves.toEqual({ outcome: "signed-out" });
    expect(getSaved(SERVER_B)).toBeNull(); // B 存档已清
    expect(getSaved(SERVER_A)).toBe("tok-1"); // A 存档仍在
    expect(cleared.every((b) => b === SERVER_B)).toBe(true); // 清档只落在目标 baseUrl
    // 活动会话 A 也不被 resume 失败破坏：me 仍带 A 的 token
    expect(await session.me()).toEqual(USER);
  });

  it("网络错误（服务端不可达）→ 清档保持登出态，resume 不抛（错误归一为结果对象）", async () => {
    const { makeSession, setHandler, cleared } = setup(route);
    await makeSession().login({ baseUrl: SERVER_A, username: "alice", password: "password8" });
    setHandler(() => {
      throw new TypeError("fetch failed");
    });
    const fresh = makeSession();
    await expect(fresh.resume(SERVER_A)).resolves.toEqual({ outcome: "signed-out" });
    expect(cleared).toEqual([SERVER_A]);
    expect(fresh.current).toBeNull();
  });

  it("无存档（该 baseUrl 从未登录）→ signed-out 且不清档（无凭据可清）", async () => {
    const { makeSession, cleared } = setup(route);
    const fresh = makeSession();
    await expect(fresh.resume(SERVER_A)).resolves.toEqual({ outcome: "signed-out" });
    expect(cleared).toEqual([]);
    expect(fresh.current).toBeNull();
  });

  it("login 按 baseUrl 存档、logout 只清对应 baseUrl（多服务器凭据互不影响）", async () => {
    const { makeSession, saved, cleared, calls } = setup(route);
    const session = makeSession();
    await session.login({ baseUrl: SERVER_A, username: "alice", password: "password8" });
    expect(saved).toEqual([[SERVER_A, "tok-1"]]);
    // 直接向 tokenStore 注入 B 的存档（模拟此前登录过 B）
    await makeSession().login({ baseUrl: SERVER_B, username: "alice", password: "password8" });
    await session.resume(SERVER_B);
    await session.logout();
    // logout 清当前激活 baseUrl（B），A 的存档保留
    expect(cleared).toEqual([SERVER_B]);
    expect(calls.at(-1)!.url).toBe(`${SERVER_B}/api/v1/auth/logout`);
  });
});
