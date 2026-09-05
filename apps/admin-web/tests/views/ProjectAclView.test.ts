// @vitest-environment jsdom
// M4-A 任务 5：ProjectAclView 测试（裁定 A/B/C）——项目选择来自 tree.projects（name+path+myRole
// 展示，裁定 C）；NONE 与「删行恢复继承」语义显式区分（NONE 行仍在显示 NONE；DELETE 行消失；
// 页面 noneHint 文案钉住，裁定 B/i18n 审校点）；添加行（成员下拉 + 手输非成员 userId，§3.3 可预设）。
// 直达 URL 挂载（replaceState 到 ACL 路径）；antd 传送门走 body 作用域查询 + waitForBody 轮询；
// a-select 经组件实例事件驱动（desktop 先例）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper, type VueWrapper } from "@vue/test-utils";
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
const TREE = {
  workspaceId: "ws-1",
  rootVersion: 7,
  files: [],
  projects: [
    { id: "p-1", name: "订单", path: "groups/后端/projects/订单", myRole: "OWNER" },
    { id: "p-2", name: "库存", path: "groups/后端/projects/库存", myRole: "EDITOR" },
  ],
};
const MEMBERS = [
  { userId: "u-1", username: "alice", displayName: "Alice", role: "OWNER" },
  { userId: "u-2", username: "bob", displayName: "Bob", role: "EDITOR" },
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
  if (!w) throw new Error(`document.body 中找不到 [data-testid="${testid}"]（传送门未渲染？）`);
  return w;
}

/** 轮询等待传送门元素出现（气泡挂载跨宏任务，先例同 MembersView）。 */
async function waitForBody(testid: string): Promise<DOMWrapper<Element>> {
  for (let i = 0; i < 40; i += 1) {
    const w = bodyFind(testid);
    if (w) return w;
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`document.body 中未出现 [data-testid="${testid}"]（轮询超时）`);
}

function antdSelect(wrapper: VueWrapper, testid: string) {
  const found = wrapper.findAllComponents({ name: "ASelect" }).find((c) => c.attributes("data-testid") === testid);
  if (!found) throw new Error(`ASelect 未找到: ${testid}`);
  return found;
}

/** ACL 面可变链路：P2 的 ACL 行与 tree.projects[].myRole 随 PUT/DELETE 联动。 */
function aclHandler(opts?: { onPut?: (req: CapturedRequest) => Response | Promise<Response> }): FetchHandler {
  let p2Denied = false;
  const aclByProject: Record<string, Array<{ userId: string; role: string }>> = { "p-1": [], "p-2": [{ userId: "u-2", role: "VIEWER" }] };
  return (req) => {
    const { method, url } = req;
    if (url === `${BASE}/me`) return json(200, USER);
    if (url === `${BASE}/workspaces/ws-1` && method === "GET") return json(200, { id: "ws-1", name: "团队空间", myRole: "OWNER", memberCount: 2 });
    if (url === `${BASE}/workspaces/ws-1/members` && method === "GET") return json(200, MEMBERS);
    if (url === `${BASE}/workspaces/ws-1/tree` && method === "GET") {
      return json(200, {
        ...TREE,
        projects: TREE.projects.map((p) => (p.id === "p-2" ? { ...p, myRole: p2Denied ? "NONE" : p.myRole } : p)),
      });
    }
    if (url === `${BASE}/workspaces/ws-1/projects/p-1/acl` && method === "GET") return json(200, aclByProject["p-1"]!);
    if (url === `${BASE}/workspaces/ws-1/projects/p-1/acl` && method === "PUT") {
      if (opts?.onPut) return opts.onPut(req);
      const body = req.body as { userId: string; role: string };
      const row = aclByProject["p-1"]!.find((r) => r.userId === body.userId);
      if (row) row.role = body.role;
      else aclByProject["p-1"]!.push({ userId: body.userId, role: body.role });
      return noContent();
    }
    if (url === `${BASE}/workspaces/ws-1/projects/p-2/acl` && method === "GET") return json(200, aclByProject["p-2"]!);
    if (url === `${BASE}/workspaces/ws-1/projects/p-2/acl` && method === "PUT") {
      if (opts?.onPut) return opts.onPut(req);
      const body = req.body as { userId: string; role: string };
      const row = aclByProject["p-2"]!.find((r) => r.userId === body.userId);
      if (row) row.role = body.role;
      else aclByProject["p-2"]!.push({ userId: body.userId, role: body.role });
      p2Denied = body.role === "NONE" && body.userId === "u-2";
      return noContent();
    }
    if (url.startsWith(`${BASE}/workspaces/ws-1/projects/p-2/acl`) && method === "DELETE") {
      const userId = new URL(url).searchParams.get("userId");
      const idx = aclByProject["p-2"]!.findIndex((r) => r.userId === userId);
      if (idx >= 0) aclByProject["p-2"]!.splice(idx, 1);
      p2Denied = false;
      return noContent();
    }
    return json(404, { code: "not_found", message: "未匹配的测试路由" });
  };
}

/** 直达 URL 装配：replaceState 到 ACL 路径 → mount（initialize + 初始导航即 ACL 页）。 */
async function mountAcl(handler: FetchHandler = aclHandler()) {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, "tok-abc123");
  localStorage.setItem("apicc.admin.locale", "zh-CN"); // 钉住 zh 文案断言（jsdom navigator 为 en-US）
  window.history.replaceState(null, "", "/workspaces/ws-1/acl");
  const stub = fetchStub((req) => (req.url === `${BASE}/me` ? json(200, USER) : handler(req)));
  const client = createAdminClient({ baseUrl: BASE, fetch: stub.impl });
  const session = createSessionStore({ client, storage: localStorage });
  const workspaces = createWorkspacesStore({ client });
  const router = createAppRouter({ session, workspaces });
  const { i18n } = createAdminI18n();
  await session.initialize();
  const wrapper: VueWrapper = mount(App, { global: { plugins: [i18n, router] } });
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return { wrapper, router, workspaces, calls: stub.calls };
}

describe("ProjectAclView 项目选择（裁定 A/C）", () => {
  it("项目下拉来自 tree.projects：默认选第一个项目，选项含 name/path/myRole；ACL 行表渲染", async () => {
    const { wrapper, workspaces, calls } = await mountAcl();
    expect(wrapper.find("[data-testid=acl-view]").exists()).toBe(true);
    expect(workspaces.tree?.projects).toHaveLength(2);
    const options = antdSelect(wrapper, "acl-project-select").props("options") as Array<{ value: string; label: string }>;
    expect(options.map((o) => o.value)).toEqual(["p-1", "p-2"]);
    expect(options[0]!.label).toContain("订单");
    expect(options[0]!.label).toContain("groups/后端/projects/订单"); // path 必显（契约修订 2026-09-03）
    expect(options[0]!.label).toContain("OWNER"); // myRole 展示（裁定 C）
    // 默认选中第一个项目 → GET acl → 行渲染
    expect(calls.some((c) => c.method === "GET" && c.url === `${BASE}/workspaces/ws-1/projects/p-1/acl`)).toBe(true);
    // p-1 无 ACL 行 → 空表：antd 渲染「暂无数据」行（zh locale），无数据行
    expect(workspaces.aclEntries).toHaveLength(0);
    expect(wrapper.text()).toContain("暂无数据");
  });

  it("切换项目 → 加载对应 ACL 行（p-2 一行 VIEWER）", async () => {
    const { wrapper } = await mountAcl();
    antdSelect(wrapper, "acl-project-select").vm.$emit("update:value", "p-2");
    await flushPromises();
    await flushPromises();
    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("u-2");
    expect(rows[0]!.text()).toContain("VIEWER");
  });
});

describe("ProjectAclView NONE 与删行语义（裁定 B：显式区分）", () => {
  it("NONE：改角色选「拒绝访问（NONE）」→ PUT role=NONE → 行仍在且显示 NONE 文案", async () => {
    const { wrapper, calls } = await mountAcl();
    antdSelect(wrapper, "acl-project-select").vm.$emit("update:value", "p-2");
    await flushPromises();
    await flushPromises();
    antdSelect(wrapper, "acl-role-u-2").vm.$emit("change", "NONE");
    await flushPromises();
    await flushPromises();
    const put = calls.find((c) => c.method === "PUT" && c.url === `${BASE}/workspaces/ws-1/projects/p-2/acl`);
    expect(put!.body).toEqual({ userId: "u-2", role: "NONE" });
    // 行仍在（NONE 是明确拒绝，非删除）且文案显式
    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("拒绝访问（NONE）");
    // 项目 myRole 联动更新（tree 重载后 NONE）
    expect(wrapper.find("[data-testid=acl-project-myrole]").text()).toContain("NONE");
  });

  it("删行（popconfirm 确认）→ DELETE ?userId= → 行消失（恢复继承）", async () => {
    const { wrapper, workspaces, calls } = await mountAcl();
    antdSelect(wrapper, "acl-project-select").vm.$emit("update:value", "p-2");
    await flushPromises();
    await flushPromises();
    await wrapper.find("[data-testid=acl-delete-u-2]").trigger("click");
    await waitForBody("acl-delete-confirm");
    await expectBody("acl-delete-confirm").trigger("click");
    await flushPromises();
    await flushPromises();
    const del = calls.find((c) => c.method === "DELETE" && c.url.startsWith(`${BASE}/workspaces/ws-1/projects/p-2/acl`));
    expect(del!.url).toBe(`${BASE}/workspaces/ws-1/projects/p-2/acl?userId=u-2`);
    expect(workspaces.aclEntries).toHaveLength(0); // 行消失 = 恢复工作区角色继承
    expect(wrapper.text()).toContain("暂无数据");
  });

  it("NONE 与继承的语义区分文案上屏（i18n 审校点，裁定 B）", async () => {
    const { wrapper } = await mountAcl();
    const hint = wrapper.find("[data-testid=acl-none-hint]").text();
    expect(hint).toContain("NONE");
    expect(hint).toContain("明确拒绝");
    expect(hint).toContain("恢复工作区角色继承");
  });
});

describe("ProjectAclView 添加行（裁定 A：成员下拉 + 手输非成员 userId）", () => {
  it("手输非成员 userId + 角色 → PUT { userId, role } → 行出现", async () => {
    const { wrapper, calls } = await mountAcl();
    antdSelect(wrapper, "acl-project-select").vm.$emit("update:value", "p-1"); // p-1 无行
    await flushPromises();
    await flushPromises();
    await wrapper.find("[data-testid=acl-add-userid] input").setValue("u-9");
    antdSelect(wrapper, "acl-add-role").vm.$emit("change", "VIEWER");
    await wrapper.find("[data-testid=acl-add-submit]").trigger("click");
    await flushPromises();
    await flushPromises();
    const put = calls.find((c) => c.method === "PUT" && c.url === `${BASE}/workspaces/ws-1/projects/p-1/acl`);
    expect(put!.body).toEqual({ userId: "u-9", role: "VIEWER" });
    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("u-9");
  });

  it("添加行角色选项含 NONE 不含 OWNER（ACL 角色域 NONE/VIEWER/EDITOR/ADMIN）；空 userId 本地校验", async () => {
    const { wrapper, calls } = await mountAcl();
    const options = antdSelect(wrapper, "acl-add-role").props("options") as Array<{ value: string }>;
    expect(options.map((o) => o.value)).toEqual(["NONE", "VIEWER", "EDITOR", "ADMIN"]);
    await wrapper.find("[data-testid=acl-add-submit]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid=acl-add-error]").exists()).toBe(true);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
});
