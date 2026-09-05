// @vitest-environment jsdom
// M4-A 任务 2：LoginView 组件测试——经 App 装配（router-view + 路由 props 注入 store）驱动：
// 登录成功回跳 redirect 目标或 /、登录失败错误上屏留登录页、本地校验先行（裁定 D：不发请求
// 不经 error 通道）、注册成功提示并回登录页签（不建立登录态，desktop 同语义）、注册失败 409 上屏、
// 提交 loading。antd 适配沿用 desktop 先例：matchMedia 桩、flushPromises 驱动异步表单链。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from "@vue/test-utils";
import { createAdminI18n } from "../../src/i18n/index.js";
import { createAdminClient } from "../../src/api/client.js";
import { createSessionStore } from "../../src/stores/session.js";
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
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const LOGIN_OK = { token: "tok-abc123", expiresAt: "2026-10-03T00:00:00Z", user: USER };

/** 默认路由表：登录/me/工作区清单（登录成功落到 /workspaces 时清单拉取不失败）。 */
function defaultHandler(req: CapturedRequest): Response {
  if (req.url.endsWith("/auth/login")) return json(200, LOGIN_OK);
  if (req.url.endsWith("/workspaces") && req.method === "GET") return json(200, []);
  return json(200, USER);
}

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

interface Mounted {
  wrapper: VueWrapper;
  router: ReturnType<typeof createAppRouter>;
  session: ReturnType<typeof createSessionStore>;
  calls: CapturedRequest[];
}

/** 挂装配根 App（真实路由/store/i18n；jsdom 初始 URL = http://localhost/ → 守卫送 /login）。 */
async function mountApp(handler: FetchHandler = defaultHandler): Promise<Mounted> {
  localStorage.clear();
  const stub = fetchStub(handler);
  const client = createAdminClient({ baseUrl: "http://127.0.0.1:8080/api/v1", fetch: stub.impl });
  const session = createSessionStore({ client, storage: localStorage });
  const workspaces = createWorkspacesStore({ client });
  const router = createAppRouter({ session, workspaces });
  const { i18n } = createAdminI18n();
  const wrapper = mount(App, { global: { plugins: [i18n, router] } });
  await router.isReady();
  await flushPromises();
  return { wrapper, router, session, calls: stub.calls };
}

async function fillLogin(wrapper: VueWrapper, username: string, password: string) {
  await wrapper.find("[data-testid=login-username]").setValue(username);
  await wrapper.find("[data-testid=login-password]").setValue(password);
}

async function fillRegister(wrapper: VueWrapper, username: string, displayName: string, password: string) {
  await wrapper.find("[data-testid=register-tab]").trigger("click");
  await flushPromises();
  await wrapper.find("[data-testid=register-username]").setValue(username);
  await wrapper.find("[data-testid=register-display-name]").setValue(displayName);
  await wrapper.find("[data-testid=register-password]").setValue(password);
}

describe("LoginView 登录流", () => {
  it("登录成功 → 回跳 redirect 目标（守卫带来的原路径）", async () => {
    const { wrapper, router, session, calls } = await mountApp();
    // 初始导航 / → 守卫送 /login?redirect=/
    expect(router.currentRoute.value.name).toBe("login");
    await fillLogin(wrapper, "alice", "password8");
    await wrapper.find("[data-testid=login-submit]").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.url.endsWith("/auth/login"))).toBe(true);
    expect(session.isAuthenticated).toBe(true);
    expect(localStorage.getItem("apicc.admin.token")).toBe("tok-abc123");
    // 回跳 redirect 目标 "/"：经布局壳 index 重定向落到工作区列表（任务 3 起）
    expect(router.currentRoute.value.path).toBe("/workspaces");
    expect(wrapper.find("[data-testid=workspaces-view]").exists()).toBe(true);
  });

  it("登录成功（无 redirect）→ 默认回 /", async () => {
    const { wrapper, router } = await mountApp();
    await router.push("/login");
    await flushPromises();
    await fillLogin(wrapper, "alice", "password8");
    await wrapper.find("[data-testid=login-submit]").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/workspaces");
  });

  it("登录失败 401 → 错误上屏（api 通道）、留在登录页、不落 token", async () => {
    const { wrapper, router, session } = await mountApp(() => json(401, { code: "invalid_credentials", message: "用户名或密码错误" }));
    await fillLogin(wrapper, "alice", "wrong");
    await wrapper.find("[data-testid=login-submit]").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(wrapper.find("[data-testid=login-api-error]").exists()).toBe(true);
    expect(wrapper.find("[data-testid=login-api-error]").text()).toContain("用户名或密码错误");
    expect(session.isAuthenticated).toBe(false);
    expect(localStorage.getItem("apicc.admin.token")).toBeNull();
    expect(router.currentRoute.value.name).toBe("login");
  });

  it("提交在途 → 提交按钮 loading（deferred fetch 钉住中间态）", async () => {
    let release!: () => void;
    const gate = new Promise<Response>((resolve) => {
      release = () => resolve(json(200, LOGIN_OK));
    });
    const { wrapper, session } = await mountApp(() => gate);
    await fillLogin(wrapper, "alice", "password8");
    const click = wrapper.find("[data-testid=login-submit]").trigger("click");
    await flushPromises();
    expect(session.submitting).toBe(true);
    expect(wrapper.find("[data-testid=login-submit]").classes()).toContain("ant-btn-loading");
    release();
    await click;
    await flushPromises();
    expect(session.isAuthenticated).toBe(true);
  });
});

describe("LoginView 本地校验（裁定 D：不经 error 通道、不发请求）", () => {
  it("空用户名提交 → 表单错误上屏，零请求", async () => {
    const { wrapper, calls } = await mountApp();
    await fillLogin(wrapper, "", "");
    await wrapper.find("[data-testid=login-submit]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid=login-form-error]").exists()).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("注册页签：非法用户名（a.b）→ 表单错误，零请求", async () => {
    const { wrapper, calls } = await mountApp();
    await fillRegister(wrapper, "a.b", "Alice", "password8");
    await wrapper.find("[data-testid=register-submit]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid=login-form-error]").exists()).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("注册页签：密码过短 / 显示名称空白 → 表单错误，零请求", async () => {
    const { wrapper, calls } = await mountApp();
    await fillRegister(wrapper, "alice", "Alice", "short");
    await wrapper.find("[data-testid=register-submit]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid=login-form-error]").exists()).toBe(true);
    await fillRegister(wrapper, "alice", "   ", "password8");
    await wrapper.find("[data-testid=register-submit]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid=login-form-error]").exists()).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("LoginView 注册流（不建立登录态）", () => {
  it("注册成功 → 提示上屏 + 切回登录页签 + 用户名保留 + 会话仍为空", async () => {
    const { wrapper, router, session, calls } = await mountApp((req) => (req.url.endsWith("/auth/register") ? json(201, USER) : json(200, LOGIN_OK)));
    await fillRegister(wrapper, "alice", "Alice", "password8");
    await wrapper.find("[data-testid=register-submit]").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.url.endsWith("/auth/register"))).toBe(true);
    expect(wrapper.find("[data-testid=register-ok]").exists()).toBe(true);
    // 切回登录页签：激活 class（ant-tabs-tab-active）在页签容器上，不在 #tab slot 的 span 上
    const loginTabContainer = wrapper.find("[data-testid=login-tab]").element.closest(".ant-tabs-tab");
    expect(loginTabContainer?.classList.contains("ant-tabs-tab-active")).toBe(true);
    expect((wrapper.find("[data-testid=login-username]").element as HTMLInputElement).value).toBe("alice");
    expect(session.isAuthenticated).toBe(false);
    expect(localStorage.getItem("apicc.admin.token")).toBeNull();
    expect(router.currentRoute.value.name).toBe("login");
  });

  it("注册失败 409 username_taken → api 错误上屏", async () => {
    const { wrapper, session } = await mountApp(() => json(409, { code: "username_taken", message: "用户名已被占用" }));
    await fillRegister(wrapper, "alice", "Alice", "password8");
    await wrapper.find("[data-testid=register-submit]").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(wrapper.find("[data-testid=login-api-error]").text()).toContain("用户名已被占用");
    expect(session.isAuthenticated).toBe(false);
  });
});
