// @vitest-environment jsdom
// M4-A 任务 3：WorkspacesView 测试（裁定 B）——a-table 清单（name/myRole/createdAt + 操作列）、
// 创建 a-modal（name 必填 1-64 本地校验、提交 loading、api 错误上屏、成功后刷新清单并关闭）、
// 删除（仅 OWNER 行可见；受控 a-modal 二次输入工作区名确认，名字不匹配禁确定——不可逆操作；
// 成功后刷新清单）。经 App 装配（真实路由/store）驱动；seed token 建立登录态。
// antd 适配沿用 desktop 约定：a-modal 恒经传送门渲染于 body → 模态内元素用 body 作用域查询。
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

const BASE = "http://127.0.0.1:8080/api/v1";
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const LIST = [
  { id: "ws-1", name: "团队空间", myRole: "OWNER", createdAt: "2026-09-03T00:00:00Z" },
  { id: "ws-2", name: "访客空间", myRole: "VIEWER", createdAt: "2026-09-04T00:00:00Z" },
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

function authOnly(req: CapturedRequest): Response {
  if (req.url === `${BASE}/me`) return json(200, USER);
  return json(404, { code: "not_found", message: "未匹配的测试路由" });
}

/** 已登录装配（handler 可按用例覆写工作区端点行为）；initialize 同 main.ts 装配。 */
async function mountWorkspaces(workspaceHandler: FetchHandler = () => json(200, LIST)) {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, "tok-abc123");
  window.history.replaceState(null, "", "/"); // 重置 jsdom URL（跨用例残留会改变初始路由）
  const stub = fetchStub((req) => (req.url === `${BASE}/me` ? json(200, USER) : workspaceHandler(req)));
  const client = createAdminClient({ baseUrl: BASE, fetch: stub.impl });
  const session = createSessionStore({ client, storage: localStorage });
  const workspaces = createWorkspacesStore({ client });
  const users = createUsersStore({ client });
  const org = createOrgStore({ client });
  const router = createAppRouter({ session, workspaces, users, org, client });
  const { i18n } = createAdminI18n();
  await session.initialize(); // main.ts 装配同款：验活落 token，守卫放行
  const wrapper: VueWrapper = mount(App, { global: { plugins: [i18n, router] } });
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return { wrapper, router, session, workspaces, calls: stub.calls };
}

describe("WorkspacesView 清单", () => {
  it("挂载拉取清单：行渲染 name/myRole/createdAt", async () => {
    const { wrapper, calls } = await mountWorkspaces((req) => (req.method === "GET" && req.url === `${BASE}/workspaces` ? json(200, LIST) : authOnly(req)));
    expect(calls.some((c) => c.method === "GET" && c.url === `${BASE}/workspaces`)).toBe(true);
    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("团队空间");
    expect(rows[0]!.text()).toContain("OWNER");
    expect(rows[0]!.text()).toContain("2026-09-03T00:00:00Z");
    expect(rows[1]!.text()).toContain("VIEWER");
  });

  it("清单拉取失败 → 错误上屏", async () => {
    const { wrapper } = await mountWorkspaces((req) => (req.method === "GET" && req.url === `${BASE}/workspaces` ? json(500, { code: "boom", message: "服务端故障" }) : authOnly(req)));
    await flushPromises();
    expect(wrapper.find("[data-testid=ws-error]").text()).toContain("服务端故障");
  });
});

describe("WorkspacesView 创建（a-modal）", () => {
  it("空名称提交 → 本地校验错误、零请求；填名提交 → POST + 清单刷新 + 关闭", async () => {
    const list = [...LIST];
    const { wrapper, calls } = await mountWorkspaces((req) => {
      if (req.url === `${BASE}/workspaces` && req.method === "GET") return json(200, list);
      if (req.url === `${BASE}/workspaces` && req.method === "POST") {
        list.push({ id: "ws-3", name: String((req.body as { name: string }).name), myRole: "OWNER", createdAt: "2026-09-05T00:00:00Z" });
        return json(201, { id: "ws-3", name: "新空间", myRole: "OWNER" });
      }
      return authOnly(req);
    });
    await wrapper.find("[data-testid=ws-create-open]").trigger("click");
    await flushPromises();
    // a-modal 根节点 testid 不透传到 body（desktop 同经验）：模态开合以内层元素判定
    expectBody("ws-create-name");
    // 空名称：本地校验拦下，零请求
    await expectBody("ws-create-submit").trigger("click");
    await flushPromises();
    expectBody("ws-create-error");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    // 合法名称：POST + 自动刷新 + 关闭
    await expectBody("ws-create-name").setValue("新空间");
    await expectBody("ws-create-submit").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/workspaces`)).toBe(true);
    expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/workspaces`)).toHaveLength(2);
    expect(wrapper.findAll("tbody tr")).toHaveLength(3);
    expect(bodyFind("ws-create-name")).toBeNull();
  });

  it("名称超 64 字符 → 本地校验错误、零请求", async () => {
    const { wrapper, calls } = await mountWorkspaces();
    await wrapper.find("[data-testid=ws-create-open]").trigger("click");
    await flushPromises();
    await expectBody("ws-create-name").setValue("长".repeat(65));
    await expectBody("ws-create-submit").trigger("click");
    await flushPromises();
    expectBody("ws-create-error");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("创建失败（400）→ api 错误上屏、modal 不关", async () => {
    const { wrapper } = await mountWorkspaces((req) => {
      if (req.url === `${BASE}/workspaces` && req.method === "GET") return json(200, LIST);
      if (req.url === `${BASE}/workspaces` && req.method === "POST") return json(400, { code: "validation_failed", message: "名称不合法" });
      return authOnly(req);
    });
    await wrapper.find("[data-testid=ws-create-open]").trigger("click");
    await flushPromises();
    await expectBody("ws-create-name").setValue("新空间");
    await expectBody("ws-create-submit").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(expectBody("ws-create-api-error").text()).toContain("名称不合法");
    expect(bodyFind("ws-create-name")).not.toBeNull(); // 失败不关窗
  });
});

describe("WorkspacesView 删除（仅 OWNER 行；二次输入名确认）", () => {
  it("OWNER 行显示删除按钮、非 OWNER 行无；确认 modal 名字不匹配禁确定", async () => {
    const { wrapper, calls } = await mountWorkspaces((req) => {
      if (req.url === `${BASE}/workspaces` && req.method === "GET") return json(200, LIST);
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "DELETE") return noContent();
      return authOnly(req);
    });
    expect(wrapper.findAll("[data-testid=ws-delete]")).toHaveLength(1); // 仅 ws-1（OWNER）
    await wrapper.find("[data-testid=ws-delete]").trigger("click");
    await flushPromises();
    expectBody("ws-delete-name"); // 模态已开（内层元素判定）
    expect(expectBody("ws-delete-confirm").attributes("disabled")).toBeDefined(); // 未输入 → 禁用
    await expectBody("ws-delete-name").setValue("错误的名称");
    await flushPromises();
    expect(expectBody("ws-delete-confirm").attributes("disabled")).toBeDefined();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("输入工作区名匹配 → 确定启用 → 删除 + 清单刷新 + 关闭", async () => {
    const list = [...LIST];
    const { wrapper, calls } = await mountWorkspaces((req) => {
      if (req.url === `${BASE}/workspaces` && req.method === "GET") return json(200, list);
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "DELETE") {
        list.splice(list.findIndex((w) => w.id === "ws-1"), 1);
        return noContent();
      }
      return authOnly(req);
    });
    await wrapper.find("[data-testid=ws-delete]").trigger("click");
    await flushPromises();
    await expectBody("ws-delete-name").setValue("团队空间");
    await flushPromises();
    const confirm = expectBody("ws-delete-confirm");
    expect(confirm.attributes("disabled")).toBeUndefined();
    await confirm.trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/workspaces/ws-1`)).toBe(true);
    expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/workspaces`)).toHaveLength(2);
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
    expect(bodyFind("ws-delete-name")).toBeNull();
  });

  it("删除失败（403）→ api 错误上屏、modal 不关", async () => {
    const { wrapper } = await mountWorkspaces((req) => {
      if (req.url === `${BASE}/workspaces` && req.method === "GET") return json(200, LIST);
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "DELETE") return json(403, { code: "forbidden", message: "仅 OWNER 可删除" });
      return authOnly(req);
    });
    await wrapper.find("[data-testid=ws-delete]").trigger("click");
    await flushPromises();
    await expectBody("ws-delete-name").setValue("团队空间");
    await flushPromises();
    await expectBody("ws-delete-confirm").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(expectBody("ws-delete-api-error").text()).toContain("仅 OWNER 可删除");
    expect(bodyFind("ws-delete-name")).not.toBeNull(); // 失败不关窗
  });
});
