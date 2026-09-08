// @vitest-environment jsdom
// 任务 5：UsersView（控制台「用户管理」，超管专属）测试——清单渲染（username/displayName/平台角色
// tag/状态/createdAt）、创建 a-modal（client 载荷逐字断言 + 本地校验同注册口径 + 409 就近上屏）、
// 行内动作（停用/启用 POST disable|enable、重置密码受控 modal POST { newPassword }）、错误上屏
// 不抛出；LayoutView 菜单显隐（session.role=USER 无「用户管理」入口）与非超管直达 /users 守卫弹回。
// fetch 桩模式与 MembersView 测试同款；antd Modal 恒经传送门渲染于 body → 模态内元素 body 作用域查询。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { createAdminI18n } from "../../src/i18n/index.js";
import { createAdminClient } from "../../src/api/client.js";
import { createSessionStore, TOKEN_KEY } from "../../src/stores/session.js";
import { createWorkspacesStore } from "../../src/stores/workspaces.js";
import { createUsersStore } from "../../src/stores/users.js";
import { createOrgStore } from "../../src/stores/org.js";
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
const notFound = (): Response => json(404, { code: "not_found", message: "未匹配的测试路由" });

const BASE = "http://127.0.0.1:8080/api/v1";
const ME_SUPER = { id: "ad", username: "admin", displayName: "管理员", role: "SUPERADMIN" };
const ME_USER = { id: "u1", username: "alice", displayName: "Alice", role: "USER" };
const USERS = [
  { id: "u1", username: "alice", displayName: "Alice", role: "USER", disabled: false, createdAt: "2026-09-01T00:00:00Z" },
  { id: "ad", username: "admin", displayName: "管理员", role: "SUPERADMIN", disabled: false, createdAt: "2026-08-01T00:00:00Z" },
];

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

function bodyFind(testid: string): DOMWrapper<Element> | null {
  const el = document.body.querySelector(`[data-testid="${testid}"]`);
  return el ? new DOMWrapper(el) : null;
}

function expectBody(testid: string): DOMWrapper<Element> {
  const w = bodyFind(testid);
  if (!w) throw new Error(`document.body 中找不到 [data-testid="${testid}"]（Modal 传送门未渲染？）`);
  return w;
}

/** 默认账号管理链路：清单 + 行内动作（可变 list 模拟 disable/enable 后的刷新结果）。 */
function usersHandler(opts?: {
  onCreate?: (req: CapturedRequest) => Response;
  onDisable?: (req: CapturedRequest) => Response;
  onEnable?: (req: CapturedRequest) => Response;
  onReset?: (req: CapturedRequest) => Response;
}): FetchHandler {
  const list = USERS.map((u) => ({ ...u }));
  return (req) => {
    const { method, url } = req;
    if (url === `${BASE}/admin/users` && method === "GET") return json(200, list);
    if (url === `${BASE}/admin/users` && method === "POST") {
      if (opts?.onCreate) return opts.onCreate(req);
      const body = req.body as { username: string; displayName: string };
      list.push({ id: body.username, username: body.username, displayName: body.displayName, role: "USER", disabled: false, createdAt: "2026-09-06T00:00:00Z" });
      return json(201, { ...list[list.length - 1] });
    }
    if (url === `${BASE}/admin/users/u1/disable` && method === "POST") {
      if (opts?.onDisable) return opts.onDisable(req);
      const i = list.findIndex((u) => u.id === "u1");
      list[i] = { ...list[i]!, disabled: true };
      return noContent();
    }
    if (url === `${BASE}/admin/users/u1/enable` && method === "POST") {
      if (opts?.onEnable) return opts.onEnable(req);
      const i = list.findIndex((u) => u.id === "u1");
      list[i] = { ...list[i]!, disabled: false };
      return noContent();
    }
    if (url === `${BASE}/admin/users/u1/password-reset` && method === "POST") {
      return opts?.onReset ? opts.onReset(req) : noContent();
    }
    if (url === `${BASE}/workspaces` && method === "GET") return json(200, []); // 列表页兜底（菜单显隐用例落点）
    return notFound();
  };
}

/** 直达 URL 装配：replaceState 到目标路径 → mount（initialize + 初始导航即目标页）。 */
async function mountUsers(
  handler: FetchHandler,
  opts: { me?: typeof ME_SUPER | typeof ME_USER; path?: string; productionTiming?: boolean } = {},
) {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, "tok-abc123");
  localStorage.setItem("apicc.admin.locale", "zh-CN"); // 钉住 zh 文案断言（jsdom navigator 为 en-US）
  window.history.replaceState(null, "", opts.path ?? "/users");
  const stub = fetchStub((req) => (req.url === `${BASE}/me` ? json(200, opts.me ?? ME_SUPER) : handler(req)));
  const client = createAdminClient({ baseUrl: BASE, fetch: stub.impl });
  const session = createSessionStore({ client, storage: localStorage });
  const workspaces = createWorkspacesStore({ client });
  const users = createUsersStore({ client });
  const org = createOrgStore({ client });
  // productionTiming=true 模拟 main.ts 真实时序（任务 5 审查重要 1 回归锚点）：initialize 不等待
  // 即装配路由，守卫 await 其收口后再评估 requiresSuperadmin；缺省 = 先 await initialize 再 mount
  // （首航前会话已确定的便捷时序）。
  let sessionReady: Promise<void> | undefined;
  if (opts.productionTiming === true) {
    sessionReady = session.initialize(); // 不等待
  } else {
    await session.initialize(); // 验活落 token + role，守卫首航即见确定态
  }
  const router = createAppRouter({ session, workspaces, users, org, sessionReady });
  const { i18n } = createAdminI18n();
  const wrapper: VueWrapper = mount(App, { global: { plugins: [i18n, router] } });
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return { wrapper, router, session, users, calls: stub.calls };
}

describe("UsersView 清单与行内动作（任务 5）", () => {
  it("清单渲染：username/displayName/平台角色 tag/状态/创建时间", async () => {
    const { wrapper, calls } = await mountUsers(usersHandler());
    expect(calls.some((c) => c.method === "GET" && c.url === `${BASE}/admin/users`)).toBe(true);
    expect(wrapper.find("[data-testid=users-view]").exists()).toBe(true);
    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("alice");
    expect(rows[0]!.text()).toContain("Alice");
    expect(rows[0]!.text()).toContain("USER");
    expect(rows[0]!.text()).toContain("正常");
    expect(rows[1]!.text()).toContain("admin");
    expect(rows[1]!.text()).toContain("SUPERADMIN");
    expect(rows[1]!.text()).toContain("2026-08-01T00:00:00Z");
  });

  it("创建账号：空表单本地校验零请求；合法载荷逐字 POST /admin/users + 清单刷新 + 关闭", async () => {
    let posted: unknown;
    const list = USERS.map((u) => ({ ...u }));
    const { wrapper, calls } = await mountUsers((req) => {
      if (req.url === `${BASE}/admin/users` && req.method === "GET") return json(200, list);
      if (req.url === `${BASE}/admin/users` && req.method === "POST") {
        posted = req.body;
        const created = { id: "u2", username: "bob", displayName: "Bob", role: "USER", disabled: false, createdAt: "2026-09-06T00:00:00Z" };
        list.push(created);
        return json(201, created);
      }
      return notFound();
    });
    await wrapper.find('[data-testid="users-create"]').trigger("click");
    await flushPromises();
    expectBody("users-form-username"); // 模态已开（内层元素判定）
    // 空表单：本地校验拦下，零 POST
    await expectBody("users-form-save").trigger("click");
    await flushPromises();
    expect(expectBody("users-form-error").text()).toContain("请输入用户名");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    // 合法表单：POST 载荷逐字断言 + 自动刷新 + 关闭
    await expectBody("users-form-username").setValue("bob");
    await expectBody("users-form-password").setValue("password123");
    await expectBody("users-form-display").setValue("Bob");
    await expectBody("users-form-save").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(posted).toEqual({ username: "bob", password: "password123", displayName: "Bob" });
    expect(wrapper.findAll("tbody tr")).toHaveLength(3);
    expect(bodyFind("users-form-username")).toBeNull(); // 成功关窗
  });

  it("停用 → POST disable + 清单刷新显示已停用（行内动作切换为启用）；启用 → POST enable", async () => {
    const { wrapper, calls } = await mountUsers(usersHandler());
    await wrapper.find('[data-testid="user-disable-u1"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/admin/users/u1/disable`)).toBe(true);
    expect(wrapper.findAll("tbody tr")[0]!.text()).toContain("已停用");
    expect(wrapper.find('[data-testid="user-enable-u1"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="user-disable-u1"]').exists()).toBe(false);
    await wrapper.find('[data-testid="user-enable-u1"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/admin/users/u1/enable`)).toBe(true);
    expect(wrapper.findAll("tbody tr")[0]!.text()).toContain("正常");
  });

  it("重置密码：空新密码本地校验零请求；填新密码 → POST password-reset { newPassword } + 关闭", async () => {
    let resetBody: unknown;
    const { wrapper, calls } = await mountUsers((req) => {
      if (req.url === `${BASE}/admin/users` && req.method === "GET") return json(200, USERS);
      if (req.url === `${BASE}/admin/users/u1/password-reset` && req.method === "POST") {
        resetBody = req.body;
        return noContent();
      }
      return notFound();
    });
    await wrapper.find('[data-testid="user-reset-u1"]').trigger("click");
    await flushPromises();
    expectBody("users-reset-password"); // 模态已开
    await expectBody("users-reset-save").trigger("click");
    await flushPromises();
    expect(expectBody("users-reset-error").text()).toContain("密码至少 8 位");
    expect(calls.filter((c) => c.url.endsWith("/password-reset"))).toHaveLength(0);
    await expectBody("users-reset-password").setValue("newpassword8");
    await expectBody("users-reset-save").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(resetBody).toEqual({ newPassword: "newpassword8" });
    expect(bodyFind("users-reset-password")).toBeNull(); // 成功关窗
  });
});

describe("UsersView 错误面（上屏不抛出）", () => {
  it("创建 409 username_taken → modal 内就近上屏、不关窗；取消后可再开", async () => {
    const { wrapper } = await mountUsers(usersHandler({ onCreate: () => json(409, { code: "username_taken", message: "用户名已存在" }) }));
    await wrapper.find('[data-testid="users-create"]').trigger("click");
    await flushPromises();
    await expectBody("users-form-username").setValue("alice");
    await expectBody("users-form-password").setValue("password123");
    await expectBody("users-form-display").setValue("Alice");
    await expectBody("users-form-save").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(expectBody("users-form-api-error").text()).toContain("用户名已存在");
    expect(bodyFind("users-form-username")).not.toBeNull(); // 失败不关窗
    await expectBody("users-form-cancel").trigger("click");
    await flushPromises();
    expect(bodyFind("users-form-username")).toBeNull(); // 取消关窗
  });

  it("停用失败（cannot_disable_self 模拟）→ 页顶 error 通道上屏、清单不动", async () => {
    const { wrapper, users } = await mountUsers(usersHandler({ onDisable: () => json(400, { code: "cannot_disable_self", message: "不能停用自己" }) }));
    await wrapper.find('[data-testid="user-disable-u1"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(users.error).toBe("不能停用自己");
    expect(wrapper.find('[data-testid="users-error"]').text()).toContain("不能停用自己");
    expect(wrapper.findAll("tbody tr")).toHaveLength(2); // 清单不动
  });

  it("清单拉取失败 → 页顶 error 上屏", async () => {
    const { wrapper } = await mountUsers(() => json(500, { code: "boom", message: "服务端故障" }));
    await flushPromises();
    expect(wrapper.find('[data-testid="users-error"]').text()).toContain("服务端故障");
  });
});

describe("用户管理入口显隐与守卫（session.role）", () => {
  it("SUPERADMIN：菜单含「用户管理」项，点击进入 /users 视图", async () => {
    const { wrapper, router } = await mountUsers(usersHandler(), { path: "/" });
    expect(wrapper.find('[data-testid="menu-users"]').exists()).toBe(true);
    await wrapper.find('[data-testid="menu-users"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/users");
    expect(wrapper.find('[data-testid="users-view"]').exists()).toBe(true);
  });

  it("USER：菜单无「用户管理」项；直达 /users 被守卫弹回工作区列表", async () => {
    const { wrapper, router, session } = await mountUsers(usersHandler(), { me: ME_USER, path: "/" });
    expect(session.role).toBe("USER");
    expect(wrapper.find('[data-testid="menu-users"]').exists()).toBe(false);
    await router.push("/users");
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("workspaces"); // 守卫重定向
    expect(wrapper.find('[data-testid="users-view"]').exists()).toBe(false);
  });

  it("生产装配时序（审查重要 1 回归）：超管深链 /users——守卫等验活收口，稳定落在 /users 不弹回", async () => {
    // mount 前不预先 await initialize（main.ts 真实时序）：首航时 /me 尚未落地
    const { wrapper, router, session } = await mountUsers(usersHandler(), { path: "/users", productionTiming: true });
    expect(session.role).toBe("SUPERADMIN"); // 验活已收口
    expect(router.currentRoute.value.path).toBe("/users"); // 未被弹回工作区列表
    expect(wrapper.find('[data-testid="users-view"]').exists()).toBe(true);
    expect(wrapper.findAll("tbody tr")).toHaveLength(2); // 清单已渲染
  });

  it("生产装配时序：普通用户深链 /users 验活落地后仍被守卫弹回工作区列表", async () => {
    const { router, session } = await mountUsers(usersHandler(), { me: ME_USER, path: "/users", productionTiming: true });
    expect(session.role).toBe("USER");
    expect(router.currentRoute.value.name).toBe("workspaces"); // role 落地判 USER → 弹回
    expect(router.currentRoute.value.path).toBe("/workspaces");
  });
});
