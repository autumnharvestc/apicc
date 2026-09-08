// @vitest-environment jsdom
// M4-A 任务 4：MembersView 测试（裁定 A/B/C）——成员清单（displayName/username/role a-tag 色分
// + 操作列）、改角色（a-select 即改、OWNER 行禁用）、移除（popconfirm、OWNER 行禁用）、添加成员
// （userId + 角色，§3.2 对非成员即创建）、OWNER 转让受控确认（输入工作区名，文案明示降为 ADMIN
// 且不可逆）、403 直达回列表（原因仅在成员面 membersError 通道呈现）、后端错误码 membersError 上屏。
// 直达 URL 挂载（history.replaceState 到成员路径）；antd 传送门元素走 body 作用域查询；
// a-select 经组件实例 update:value/change 事件驱动（desktop OnlineLoginDialog.test 先例）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { createAdminI18n } from "../../src/i18n/index.js";
import { createAdminClient } from "../../src/api/client.js";
import { createSessionStore, TOKEN_KEY } from "../../src/stores/session.js";
import { createWorkspacesStore } from "../../src/stores/workspaces.js";
import { createUsersStore } from "../../src/stores/users.js";
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
const MEMBERS = [
  { userId: "u-1", username: "alice", displayName: "Alice", role: "OWNER" },
  { userId: "u-2", username: "bob", displayName: "Bob", role: "EDITOR" },
  { userId: "u-3", username: "carol", displayName: "Carol", role: "VIEWER" },
];
const DETAIL_OWNER = { id: "ws-1", name: "团队空间", myRole: "OWNER", memberCount: 3 };
const DETAIL_AFTER_TRANSFER = { id: "ws-1", name: "团队空间", myRole: "ADMIN", memberCount: 3 };

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

/** 轮询等待传送门元素出现（气泡/弹层挂载跨宏任务，单次 flush 不保证可见）。 */
async function waitForBody(testid: string): Promise<DOMWrapper<Element>> {
  for (let i = 0; i < 40; i += 1) {
    const w = bodyFind(testid);
    if (w) return w;
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`document.body 中未出现 [data-testid="${testid}"]（轮询超时）`);
}

/** a-select 非原生控件：按 testid 找组件实例后经事件驱动（desktop 先例）。 */
function antdSelect(wrapper: VueWrapper, testid: string) {
  const found = wrapper.findAllComponents({ name: "ASelect" }).find((c) => c.attributes("data-testid") === testid);
  if (!found) throw new Error(`ASelect 未找到: ${testid}`);
  return found;
}

/** 直达 URL 装配：replaceState 到成员路径 → mount（initialize + 初始导航即成员页）。 */
async function mountMembers(handler: FetchHandler) {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, "tok-abc123");
  localStorage.setItem("apicc.admin.locale", "zh-CN"); // 钉住 zh 文案断言（jsdom navigator 为 en-US）
  window.history.replaceState(null, "", "/workspaces/ws-1/members");
  const stub = fetchStub((req) => (req.url === `${BASE}/me` ? json(200, USER) : handler(req)));
  const client = createAdminClient({ baseUrl: BASE, fetch: stub.impl });
  const session = createSessionStore({ client, storage: localStorage });
  const workspaces = createWorkspacesStore({ client });
  const users = createUsersStore({ client });
  const router = createAppRouter({ session, workspaces, users });
  const { i18n } = createAdminI18n();
  await session.initialize();
  const wrapper: VueWrapper = mount(App, { global: { plugins: [i18n, router] } });
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return { wrapper, router, session, workspaces, calls: stub.calls };
}

/** 默认成员链路：清单 + 详情（可变 transferred 标记模拟转让后自身降为 ADMIN）。 */
function memberHandler(opts?: { onPut?: (req: CapturedRequest) => Response | Promise<Response>; onDelete?: (req: CapturedRequest) => Response | Promise<Response> }): FetchHandler {
  let transferred = false;
  const members = [...MEMBERS];
  return (req) => {
    const { method, url } = req;
    if (url === `${BASE}/workspaces/ws-1/members` && method === "GET") return json(200, members);
    if (url === `${BASE}/workspaces/ws-1/members/u-2` && method === "PUT") {
      if (opts?.onPut) return opts.onPut(req);
      transferred = true;
      return noContent();
    }
    if (url === `${BASE}/workspaces/ws-1/members/u-3` && method === "DELETE") {
      if (opts?.onDelete) return opts.onDelete(req);
      members.splice(members.findIndex((m) => m.userId === "u-3"), 1);
      return noContent();
    }
    if (url === `${BASE}/workspaces/ws-1` && method === "GET") return json(200, transferred ? DETAIL_AFTER_TRANSFER : DETAIL_OWNER);
    return json(404, { code: "not_found", message: "未匹配的测试路由" });
  };
}

describe("MembersView 清单与权限化操作（裁定 A/D6）", () => {
  it("清单渲染：displayName/username/role；OWNER 行改角色与移除均禁用，非 OWNER 行可用", async () => {
    const { wrapper } = await mountMembers(memberHandler());
    expect(wrapper.find("[data-testid=members-view]").exists()).toBe(true);
    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain("Alice");
    expect(rows[0]!.text()).toContain("alice");
    expect(rows[0]!.text()).toContain("OWNER");
    // OWNER 行（u-1）：改角色 select 与移除按钮均禁用
    expect(antdSelect(wrapper, "members-role-u-1").classes()).toContain("ant-select-disabled");
    expect(wrapper.find("[data-testid=members-remove-u-1]").attributes("disabled")).toBeDefined();
    // 非 OWNER 行可用
    expect(antdSelect(wrapper, "members-role-u-2").classes()).not.toContain("ant-select-disabled");
    expect(wrapper.find("[data-testid=members-remove-u-2]").attributes("disabled")).toBeUndefined();
  });

  it("路由参数变化 → 重拉对应工作区成员（终审 Important 1：显示与操作目标不错位）", async () => {
    const { wrapper, router, calls } = await mountMembers((req) => {
      const { method, url } = req;
      if (url === `${BASE}/workspaces/ws-1/members` && method === "GET") return json(200, MEMBERS);
      if (url === `${BASE}/workspaces/ws-2/members` && method === "GET") {
        return json(200, [{ userId: "u-9", username: "zoe", displayName: "Zoe", role: "ADMIN" }]);
      }
      if (url === `${BASE}/workspaces/ws-1` && method === "GET") return json(200, DETAIL_OWNER);
      if (url === `${BASE}/workspaces/ws-2` && method === "GET") return json(200, { id: "ws-2", name: "另一空间", myRole: "OWNER", memberCount: 1 });
      return json(404, { code: "not_found", message: "x" });
    });
    expect(wrapper.findAll("tbody tr")[0]!.text()).toContain("Alice"); // ws-1 清单
    await router.push("/workspaces/ws-2/members");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.method === "GET" && c.url === `${BASE}/workspaces/ws-2/members`)).toBe(true);
    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("Zoe"); // 显示切换为 ws-2 成员
  });

  it("改角色（a-select 即改）→ PUT { role } + members 刷新", async () => {
    const { wrapper, workspaces, calls } = await mountMembers(memberHandler());
    antdSelect(wrapper, "members-role-u-2").vm.$emit("change", "ADMIN");
    await flushPromises();
    await flushPromises();
    const put = calls.find((c) => c.method === "PUT" && c.url === `${BASE}/workspaces/ws-1/members/u-2`);
    expect(put!.body).toEqual({ role: "ADMIN" });
    expect(workspaces.memberBusyId).toBeNull();
    // 刷新后清单仍在（GET members 再次发生）
    expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/workspaces/ws-1/members`).length).toBeGreaterThanOrEqual(2);
  });

  it("改角色为 OWNER → 转让受控确认：名字不匹配禁确定；匹配后 PUT role=OWNER 并关闭", async () => {
    const { wrapper, workspaces, calls } = await mountMembers(memberHandler());
    antdSelect(wrapper, "members-role-u-2").vm.$emit("change", "OWNER");
    await flushPromises();
    // 弹窗出现：文案明示降为 ADMIN 且不可逆 + 工作区名
    const hint = expectBody("members-transfer-hint");
    expect(hint.text()).toContain("ADMIN");
    expect(hint.text()).toContain("不可逆");
    expect(hint.text()).toContain("团队空间");
    expect(expectBody("members-transfer-confirm").attributes("disabled")).toBeDefined();
    await expectBody("members-transfer-name").setValue("错误的名称");
    await flushPromises();
    expect(expectBody("members-transfer-confirm").attributes("disabled")).toBeDefined();
    await expectBody("members-transfer-name").setValue("团队空间");
    await flushPromises();
    await expectBody("members-transfer-confirm").trigger("click");
    await flushPromises();
    await flushPromises();
    const put = calls.find((c) => c.method === "PUT" && c.url === `${BASE}/workspaces/ws-1/members/u-2`);
    expect(put!.body).toEqual({ role: "OWNER" });
    expect(bodyFind("members-transfer-name")).toBeNull(); // 成功关闭
    // 自身 myRole 联动：current 重选为 ADMIN（Layout 显隐随之）
    expect(workspaces.current?.myRole).toBe("ADMIN");
  });

  it("移除（popconfirm 确认）→ DELETE + members 刷新", async () => {
    const { wrapper, calls } = await mountMembers(memberHandler());
    await wrapper.find("[data-testid=members-remove-u-3]").trigger("click");
    await waitForBody("members-remove-confirm");
    await expectBody("members-remove-confirm").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/workspaces/ws-1/members/u-3`)).toBe(true);
    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
  });
});

describe("MembersView 添加成员（§3.2 对非成员即创建）", () => {
  it("空 userId 提交 → 本地校验错误、零请求；填 userId + 角色 → PUT + 刷新", async () => {
    const members = [...MEMBERS];
    const { wrapper, calls } = await mountMembers((req) => {
      if (req.url === `${BASE}/workspaces/ws-1/members` && req.method === "GET") return json(200, members);
      if (req.url === `${BASE}/workspaces/ws-1/members/u-9` && req.method === "PUT") {
        members.push({ userId: "u-9", username: "zoe", displayName: "Zoe", role: "VIEWER" });
        return noContent();
      }
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "GET") return json(200, DETAIL_OWNER);
      return json(404, { code: "not_found", message: "x" });
    });
    await wrapper.find("[data-testid=members-add-submit]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid=members-add-error]").exists()).toBe(true);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    await wrapper.find("[data-testid=members-add-userid]").setValue("u-9");
    antdSelect(wrapper, "members-add-role").vm.$emit("change", "VIEWER");
    await wrapper.find("[data-testid=members-add-submit]").trigger("click");
    await flushPromises();
    await flushPromises();
    const put = calls.find((c) => c.method === "PUT" && c.url === `${BASE}/workspaces/ws-1/members/u-9`);
    expect(put!.body).toEqual({ role: "VIEWER" });
    expect(wrapper.findAll("tbody tr")).toHaveLength(4);
  });
});

describe("MembersView 错误面（裁定 C）", () => {
  it("403 直达（非 ADMIN）→ membersError 上屏并弹回 /workspaces（裁定 C）", async () => {
    const { router, workspaces } = await mountMembers((req) => {
      if (req.url === `${BASE}/workspaces/ws-1/members` && req.method === "GET") return json(403, { code: "forbidden", message: "仅 ADMIN 可管理成员" });
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "GET") return json(200, DETAIL_OWNER);
      if (req.url === `${BASE}/workspaces` && req.method === "GET") return json(200, []);
      return json(404, { code: "not_found", message: "x" });
    });
    await flushPromises();
    await flushPromises();
    expect(workspaces.membersError).toBe("仅 ADMIN 可管理成员");
    expect(router.currentRoute.value.name).toBe("workspaces"); // 已弹回列表
  });

  it("后端错误码（owner_immutable 模拟）→ 顶部 membersError alert 上屏、清单不动", async () => {
    const { wrapper, workspaces } = await mountMembers(memberHandler({ onPut: () => json(400, { code: "owner_immutable", message: "不能变更 OWNER 的角色" }) }));
    antdSelect(wrapper, "members-role-u-2").vm.$emit("change", "VIEWER");
    await flushPromises();
    await flushPromises();
    expect(workspaces.membersError).toBe("不能变更 OWNER 的角色");
    expect(wrapper.find("[data-testid=members-error]").text()).toContain("不能变更 OWNER 的角色");
    expect(wrapper.findAll("tbody tr")).toHaveLength(3); // 清单不动
  });
});

describe("MembersView 顺修（任务 5 审查）", () => {
  it("添加成员角色下拉排除 OWNER（直接授 OWNER 必须经行内转让确认）", async () => {
    const { wrapper } = await mountMembers(memberHandler());
    const options = antdSelect(wrapper, "members-add-role").props("options") as Array<{ value: string }>;
    expect(options.map((o) => o.value)).toEqual(["ADMIN", "EDITOR", "VIEWER"]);
    expect(options.map((o) => o.value)).not.toContain("OWNER");
  });

  it("popconfirm 受控模式：openChange(false) → 受控状态关闭（点外关闭接线）", async () => {
    const { wrapper } = await mountMembers(memberHandler());
    await wrapper.find("[data-testid=members-remove-u-3]").trigger("click");
    await waitForBody("members-remove-confirm");
    const pc = wrapper.findAllComponents({ name: "APopconfirm" }).find((c) => c.props("open") === true);
    expect(pc).toBeDefined();
    pc!.vm.$emit("openChange", false);
    await flushPromises();
    await flushPromises();
    expect(wrapper.findAllComponents({ name: "APopconfirm" }).every((c) => c.props("open") === false)).toBe(true);
  });

  it("转让失败 → Modal 内就近呈现 membersError（备案顺手项：Modal 遮罩会挡住页面级 alert）", async () => {
    const { wrapper } = await mountMembers(memberHandler({ onPut: () => json(400, { code: "owner_immutable", message: "不能变更 OWNER 的角色" }) }));
    antdSelect(wrapper, "members-role-u-2").vm.$emit("change", "OWNER");
    await flushPromises();
    await expectBody("members-transfer-name").setValue("团队空间");
    await flushPromises();
    await expectBody("members-transfer-confirm").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(expectBody("members-transfer-error").text()).toContain("不能变更 OWNER 的角色");
    expect(bodyFind("members-transfer-name")).not.toBeNull(); // Modal 不关，错误可见
  });
});
