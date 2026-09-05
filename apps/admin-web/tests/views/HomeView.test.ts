// @vitest-environment jsdom
// M4-A 任务 2：HomeView（受保护着陆页占位）组件测试——已登录渲染当前用户；登出 → 服务端吊销 +
// 本地清 + 回登录页。经 App 装配（真实路由/store）驱动。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from "@vue/test-utils";
import { createAdminI18n } from "../../src/i18n/index.js";
import { createAdminClient } from "../../src/api/client.js";
import { createSessionStore } from "../../src/stores/session.js";
import { createAppRouter } from "../../src/router/index.js";
import App from "../../src/App.vue";

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
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const LOGIN_OK = { token: "tok-abc123", expiresAt: "2026-10-03T00:00:00Z", user: USER };

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
  });
});

enableAutoUnmount(afterEach);

/** 已登录装配：mount App → push / 落 home。 */
async function mountHome(handler: FetchHandler) {
  localStorage.clear();
  const stub = fetchStub(handler);
  const client = createAdminClient({ baseUrl: "http://127.0.0.1:8080/api/v1", fetch: stub.impl });
  const session = createSessionStore({ client, storage: localStorage });
  const router = createAppRouter({ session });
  const { i18n } = createAdminI18n();
  const wrapper: VueWrapper = mount(App, { global: { plugins: [i18n, router] } });
  await router.isReady();
  await session.login({ username: "alice", password: "password8" });
  await flushPromises();
  await router.push("/");
  await flushPromises();
  return { wrapper, router, session, calls: stub.calls };
}

describe("HomeView（受保护着陆页）", () => {
  it("已登录渲染当前用户 displayName", async () => {
    const { wrapper } = await mountHome((req) => (req.url.endsWith("/auth/login") ? json(200, LOGIN_OK) : json(200, USER)));
    expect(wrapper.find("[data-testid=home-view]").exists()).toBe(true);
    expect(wrapper.find("[data-testid=home-user]").text()).toContain("Alice");
  });

  it("登出 → POST /auth/logout、本地清、回登录页", async () => {
    const { wrapper, router, session, calls } = await mountHome((req) =>
      req.url.endsWith("/auth/logout") ? noContent() : req.url.endsWith("/auth/login") ? json(200, LOGIN_OK) : json(200, USER),
    );
    await wrapper.find("[data-testid=home-logout]").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/auth/logout"))).toBe(true);
    expect(session.isAuthenticated).toBe(false);
    expect(localStorage.getItem("apicc.admin.token")).toBeNull();
    expect(router.currentRoute.value.name).toBe("login");
  });
});
