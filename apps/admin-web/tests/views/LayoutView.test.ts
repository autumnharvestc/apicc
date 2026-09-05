// @vitest-environment jsdom
// M4-A 任务 3：LayoutView（布局壳）测试——侧栏导航（工作区项常显；成员/项目 ACL 入口仅当前
// 选中工作区 myRole ∈ {OWNER, ADMIN} 可见，详情未拉取时隐藏防闪烁，裁定 A/C）、顶栏当前用户 +
// 登出、子路由挂内容区、路由参数驱动的选中（直接 URL 进成员/ACL 占位 → 布局按 :id 选中）。
// 经 App 装配（真实路由/store/i18n）驱动；seed token 走 initialize 验活建立登录态。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from "@vue/test-utils";
import { createAdminI18n } from "../../src/i18n/index.js";
import { createAdminClient } from "../../src/api/client.js";
import { createSessionStore, TOKEN_KEY } from "../../src/stores/session.js";
import { createWorkspacesStore } from "../../src/stores/workspaces.js";
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

const BASE = "http://127.0.0.1:8080/api/v1";
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const LOGIN_OK = { token: "tok-abc123", expiresAt: "2026-10-03T00:00:00Z", user: USER };
const LIST = [
  { id: "ws-1", name: "团队空间", myRole: "OWNER", createdAt: "2026-09-03T00:00:00Z" },
  { id: "ws-2", name: "访客空间", myRole: "VIEWER", createdAt: "2026-09-04T00:00:00Z" },
];
const DETAIL_OWNER = { id: "ws-1", name: "团队空间", myRole: "OWNER", memberCount: 3 };
const DETAIL_VIEWER = { id: "ws-2", name: "访客空间", myRole: "VIEWER", memberCount: 1 };

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

function defaultHandler(req: CapturedRequest): Response {
  const { method, url } = req;
  if (url === `${BASE}/me`) return json(200, USER);
  if (url === `${BASE}/auth/logout`) return noContent();
  if (url === `${BASE}/workspaces` && method === "GET") return json(200, LIST);
  if (url === `${BASE}/workspaces/ws-1` && method === "GET") return json(200, DETAIL_OWNER);
  if (url === `${BASE}/workspaces/ws-2` && method === "GET") return json(200, DETAIL_VIEWER);
  return json(404, { code: "not_found", message: "未匹配的测试路由" });
}

/** 已登录装配：seed token → initialize 验活（main.ts 装配同款）→ mount → 落在 /workspaces 列表。 */
async function mountLayout(handler: FetchHandler = defaultHandler) {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, "tok-abc123");
  window.history.replaceState(null, "", "/"); // 重置 jsdom URL（跨用例残留会改变初始路由）
  const stub = fetchStub(handler);
  const client = createAdminClient({ baseUrl: BASE, fetch: stub.impl });
  const session = createSessionStore({ client, storage: localStorage });
  const workspaces = createWorkspacesStore({ client });
  const router = createAppRouter({ session, workspaces });
  const { i18n } = createAdminI18n();
  await session.initialize(); // main.ts 装配同款：验活同步前缀落 token，守卫首航即见确定态
  const wrapper: VueWrapper = mount(App, { global: { plugins: [i18n, router] } });
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return { wrapper, router, session, workspaces, calls: stub.calls };
}

describe("LayoutView 布局壳（裁定 A）", () => {
  it("已登录渲染：顶栏当前用户 + 工作区菜单项；默认落在工作区列表；未选中时成员/ACL 入口隐藏（防闪烁）", async () => {
    const { wrapper, router, session } = await mountLayout();
    expect(session.isAuthenticated).toBe(true);
    expect(router.currentRoute.value.name).toBe("workspaces");
    expect(wrapper.find("[data-testid=layout-user]").text()).toContain("Alice");
    expect(wrapper.find("[data-testid=layout-menu]").exists()).toBe(true);
    expect(wrapper.find("[data-testid=menu-workspaces]").exists()).toBe(true);
    expect(wrapper.find("[data-testid=workspaces-view]").exists()).toBe(true);
    expect(wrapper.find("[data-testid=menu-members]").exists()).toBe(false);
    expect(wrapper.find("[data-testid=menu-acl]").exists()).toBe(false);
  });

  it("选中 OWNER 工作区 → 成员/ACL 入口可见；点击成员入口 → 占位路由", async () => {
    const { wrapper, router } = await mountLayout();
    await wrapper.find("[data-testid=ws-open]").trigger("click"); // 第一行 ws-1（OWNER）
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("workspaces"); // 选中不换页
    expect(wrapper.find("[data-testid=menu-members]").exists()).toBe(true);
    expect(wrapper.find("[data-testid=menu-acl]").exists()).toBe(true);
    await wrapper.find("[data-testid=menu-members]").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/workspaces/ws-1/members");
    expect(wrapper.find("[data-testid=members-view]").exists()).toBe(true);
  });

  it("点击 ACL 入口 → /workspaces/{id}/acl 占位", async () => {
    const { wrapper, router } = await mountLayout();
    await wrapper.find("[data-testid=ws-open]").trigger("click");
    await flushPromises();
    await wrapper.find("[data-testid=menu-acl]").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/workspaces/ws-1/acl");
    expect(wrapper.find("[data-testid=acl-view]").exists()).toBe(true);
  });

  it("选中 VIEWER 工作区 → 成员/ACL 入口不可见（非 ADMIN 隐藏，裁定 A/D6）", async () => {
    const { wrapper } = await mountLayout();
    const opens = wrapper.findAll("[data-testid=ws-open]");
    await opens[1]!.trigger("click"); // 第二行 ws-2（VIEWER）
    await flushPromises();
    await flushPromises();
    expect(wrapper.find("[data-testid=menu-members]").exists()).toBe(false);
    expect(wrapper.find("[data-testid=menu-acl]").exists()).toBe(false);
  });

  it("直接 URL 进入成员占位 → 布局按 :id 参数选中工作区（菜单随角色显隐）", async () => {
    const { wrapper, router } = await mountLayout();
    await router.push("/workspaces/ws-2/members"); // VIEWER 工作区
    await flushPromises();
    await flushPromises();
    expect(wrapper.find("[data-testid=members-view]").exists()).toBe(true);
    expect(wrapper.find("[data-testid=menu-members]").exists()).toBe(false);
    await router.push("/workspaces/ws-1/members"); // OWNER 工作区
    await flushPromises();
    await flushPromises();
    expect(wrapper.find("[data-testid=menu-members]").exists()).toBe(true);
    expect(wrapper.find("[data-testid=menu-acl]").exists()).toBe(true);
  });

  it("点击工作区菜单项 → 回列表路由", async () => {
    const { wrapper, router } = await mountLayout();
    await router.push("/workspaces/ws-1/members");
    await flushPromises();
    await wrapper.find("[data-testid=menu-workspaces]").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("workspaces");
  });

  it("顶栏登出 → POST /auth/logout + 回登录页", async () => {
    const { wrapper, router, session, calls } = await mountLayout();
    await wrapper.find("[data-testid=layout-logout]").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/auth/logout"))).toBe(true);
    expect(session.isAuthenticated).toBe(false);
    expect(router.currentRoute.value.name).toBe("login");
  });
});
