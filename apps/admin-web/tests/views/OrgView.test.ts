// @vitest-environment jsdom
// 任务 6：OrgView（控制台「组织管理」页）测试——左分组清单（「默认」标记 + isDefault 判据的
// 改名/删除按钮禁用 + 点击选中过滤右侧项目卡片网格）、新建分组/改名/删除确认（受控 a-modal，
// UsersView 同款传送门 body 作用域查询）、新建项目（groupId 预选当前分组）/项目改名/移动
// （move 载荷 { groupId } 断言）/删除确认、409 弹窗内就近上屏不关窗、myRole 非 ADMIN+ 操作
// 按钮显隐、菜单「组织管理」所有成员可见（LayoutView）。fetch 桩模式与 UsersView 测试同款。
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
const ME = { id: "u-1", username: "alice", displayName: "Alice", role: "USER" };
const DETAIL_OWNER = { id: "ws-1", name: "团队空间", myRole: "OWNER", memberCount: 3 };
const DETAIL_EDITOR = { id: "ws-1", name: "团队空间", myRole: "EDITOR", memberCount: 3 };
const DETAIL_VIEWER = { id: "ws-1", name: "团队空间", myRole: "VIEWER", memberCount: 3 };
const GROUPS = [
  { id: "g-default", name: "默认分组", isDefault: true, createdAt: "2026-09-01T00:00:00Z" },
  { id: "g-dev", name: "研发", isDefault: false, createdAt: "2026-09-02T00:00:00Z" },
];
const PROJECTS = [
  { id: "p1", groupId: "g-default", name: "订单", createdAt: "2026-09-03T00:00:00Z" },
  { id: "p2", groupId: "g-dev", name: "库存", createdAt: "2026-09-04T00:00:00Z" },
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

/** a-select 非原生控件：按 testid 找组件实例后经 update:value 事件驱动（MembersView 先例）。 */
function antdSelect(wrapper: VueWrapper, testid: string) {
  const found = wrapper.findAllComponents({ name: "ASelect" }).find((c) => c.attributes("data-testid") === testid);
  if (!found) throw new Error(`ASelect 未找到: ${testid}`);
  return found;
}

/** 服务端视图夹具形状（对齐 AdminGroup/AdminProject 契约字段）。 */
type GroupFixture = { id: string; name: string; isDefault: boolean; createdAt: string };
type ProjectFixture = { id: string; groupId: string; name: string; createdAt: string };

/** 默认组织链路：详情（myRole 可覆写）+ 分组/项目清单 + 写动作注入点（清单可变模拟刷新结果）。 */
function orgHandler(opts: {
  detail?: typeof DETAIL_OWNER | typeof DETAIL_EDITOR | typeof DETAIL_VIEWER;
  groups?: GroupFixture[];
  projects?: ProjectFixture[];
  onCreateGroup?: (req: CapturedRequest) => Response | Promise<Response>;
  onRenameGroup?: (req: CapturedRequest) => Response | Promise<Response>;
  onDeleteGroup?: (req: CapturedRequest) => Response | Promise<Response>;
  onCreateProject?: (req: CapturedRequest) => Response | Promise<Response>;
  onRenameProject?: (req: CapturedRequest) => Response | Promise<Response>;
  onMoveProject?: (req: CapturedRequest) => Response | Promise<Response>;
  onDeleteProject?: (req: CapturedRequest) => Response | Promise<Response>;
  workspaceList?: unknown[];
} = {}): FetchHandler {
  const groups = (opts.groups ?? GROUPS).map((g) => ({ ...g }));
  const projects = (opts.projects ?? PROJECTS).map((p) => ({ ...p }));
  return (req) => {
    const { method, url } = req;
    if (url === `${BASE}/workspaces/ws-1` && method === "GET") return json(200, opts.detail ?? DETAIL_OWNER);
    if (url === `${BASE}/workspaces` && method === "GET") return json(200, opts.workspaceList ?? []);
    if (url === `${BASE}/workspaces/ws-1/groups` && method === "GET") return json(200, groups);
    if (url === `${BASE}/workspaces/ws-1/groups` && method === "POST") {
      if (opts.onCreateGroup) return opts.onCreateGroup(req);
      const created = { id: "g3", name: (req.body as { name: string }).name, isDefault: false, createdAt: "2026-09-06T00:00:00Z" };
      groups.push(created);
      return json(201, created);
    }
    if (url === `${BASE}/workspaces/ws-1/groups/g-dev/rename` && method === "POST") {
      if (opts.onRenameGroup) return opts.onRenameGroup(req);
      groups[1]!.name = (req.body as { name: string }).name;
      return json(200, groups[1]);
    }
    if (url === `${BASE}/workspaces/ws-1/groups/g-dev` && method === "DELETE") {
      if (opts.onDeleteGroup) return opts.onDeleteGroup(req);
      groups.splice(1, 1);
      return noContent();
    }
    if (url === `${BASE}/workspaces/ws-1/projects` && method === "GET") return json(200, projects);
    if (url === `${BASE}/workspaces/ws-1/projects` && method === "POST") {
      if (opts.onCreateProject) return opts.onCreateProject(req);
      const created = { id: "p3", groupId: (req.body as { groupId: string }).groupId, name: (req.body as { name: string }).name, createdAt: "2026-09-06T00:00:00Z" };
      projects.push(created);
      return json(201, created);
    }
    if (url === `${BASE}/workspaces/ws-1/projects/p1/rename` && method === "POST") {
      if (opts.onRenameProject) return opts.onRenameProject(req);
      projects[0]!.name = (req.body as { name: string }).name;
      return json(200, projects[0]);
    }
    if (url === `${BASE}/workspaces/ws-1/projects/p1/move` && method === "POST") {
      if (opts.onMoveProject) return opts.onMoveProject(req);
      projects[0]!.groupId = (req.body as { groupId: string }).groupId;
      return noContent();
    }
    if (url === `${BASE}/workspaces/ws-1/projects/p1` && method === "DELETE") {
      if (opts.onDeleteProject) return opts.onDeleteProject(req);
      projects.splice(0, 1);
      return noContent();
    }
    return notFound();
  };
}

/** 直达 URL 装配：replaceState 到目标路径 → mount（initialize + 初始导航即目标页）。 */
async function mountOrg(
  handler: FetchHandler,
  opts: { path?: string } = {},
) {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, "tok-abc123");
  localStorage.setItem("apicc.admin.locale", "zh-CN"); // 钉住 zh 文案断言（jsdom navigator 为 en-US）
  window.history.replaceState(null, "", opts.path ?? "/workspaces/ws-1/org");
  const stub = fetchStub((req) => (req.url === `${BASE}/me` ? json(200, ME) : handler(req)));
  const client = createAdminClient({ baseUrl: BASE, fetch: stub.impl });
  const session = createSessionStore({ client, storage: localStorage });
  const workspaces = createWorkspacesStore({ client });
  const users = createUsersStore({ client });
  const org = createOrgStore({ client });
  const router = createAppRouter({ session, workspaces, users, org });
  const { i18n } = createAdminI18n();
  await session.initialize();
  const wrapper: VueWrapper = mount(App, { global: { plugins: [i18n, router] } });
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return { wrapper, router, session, workspaces, org, calls: stub.calls };
}

describe("OrgView 清单与过滤", () => {
  it("分组清单渲染：名称 + isDefault「默认」标记；默认组改名/删除禁用（isDefault 判据），非默认组可用", async () => {
    const { wrapper } = await mountOrg(orgHandler());
    expect(wrapper.find("[data-testid=org-view]").exists()).toBe(true);
    const itemDefault = wrapper.find('[data-testid="org-group-item-g-default"]');
    const itemDev = wrapper.find('[data-testid="org-group-item-g-dev"]');
    expect(itemDefault.exists()).toBe(true);
    expect(itemDefault.text()).toContain("默认分组");
    expect(itemDefault.find('[data-testid="org-group-default-g-default"]').exists()).toBe(true); // 「默认」标记
    expect(itemDev.exists()).toBe(true);
    expect(itemDev.text()).toContain("研发");
    expect(itemDev.find('[data-testid="org-group-default-g-dev"]').exists()).toBe(false); // 非默认无标记
    // 默认组：改名/删除禁用（前端提前禁用，服务端 400 兜底双保险）
    expect(itemDefault.find('[data-testid="org-group-rename-g-default"]').attributes("disabled")).toBeDefined();
    expect(itemDefault.find('[data-testid="org-group-delete-g-default"]').attributes("disabled")).toBeDefined();
    // 非默认组：可用
    expect(itemDev.find('[data-testid="org-group-rename-g-dev"]').attributes("disabled")).toBeUndefined();
    expect(itemDev.find('[data-testid="org-group-delete-g-dev"]').attributes("disabled")).toBeUndefined();
  });

  it("右项目卡片网格按选中分组过滤：默认选中默认分组，点击「研发」组切换过滤", async () => {
    const { wrapper } = await mountOrg(orgHandler());
    // 初始（默认分组被自动选中）：仅 g-default 的「订单」
    let cards = wrapper.findAll('[data-testid^="org-project-card-"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text()).toContain("订单");
    // 切到研发组：仅「库存」
    await wrapper.find('[data-testid="org-group-item-g-dev"]').trigger("click");
    await flushPromises();
    cards = wrapper.findAll('[data-testid^="org-project-card-"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text()).toContain("库存");
    expect(cards[0]!.text()).not.toContain("订单");
  });
});

describe("OrgView 分组操作（受控 a-modal）", () => {
  it("新建分组：空名称本地校验零请求；合法载荷逐字 POST /groups { name } + 清单刷新 + 关窗", async () => {
    const { wrapper, calls } = await mountOrg(orgHandler());
    await wrapper.find('[data-testid="org-group-create"]').trigger("click");
    await flushPromises();
    expectBody("org-group-create-name"); // 模态已开
    await expectBody("org-group-create-save").trigger("click");
    await flushPromises();
    expect(expectBody("org-group-create-error").text()).toContain("请输入名称");
    expect(calls.filter((c) => c.method === "POST" && c.url === `${BASE}/workspaces/ws-1/groups`)).toHaveLength(0);
    await expectBody("org-group-create-name").setValue("市场");
    await expectBody("org-group-create-save").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.find((c) => c.method === "POST" && c.url === `${BASE}/workspaces/ws-1/groups`)!.body).toEqual({ name: "市场" });
    expect(wrapper.find('[data-testid="org-group-item-g3"]').exists()).toBe(true); // 清单刷新出新分组
    expect(bodyFind("org-group-create-name")).toBeNull(); // 成功关窗
  });

  it("新建分组 409 group_name_taken → modal 内就近上屏、不关窗", async () => {
    const { wrapper } = await mountOrg(orgHandler({ onCreateGroup: () => json(409, { code: "group_name_taken", message: "分组名称已存在" }) }));
    await wrapper.find('[data-testid="org-group-create"]').trigger("click");
    await flushPromises();
    await expectBody("org-group-create-name").setValue("研发");
    await expectBody("org-group-create-save").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(expectBody("org-group-create-api-error").text()).toContain("分组名称已存在");
    expect(bodyFind("org-group-create-name")).not.toBeNull(); // 失败不关窗
    await expectBody("org-group-create-cancel").trigger("click");
    await flushPromises();
    expect(bodyFind("org-group-create-name")).toBeNull(); // 取消关窗
  });

  it("分组改名：modal 预填现名 → POST /groups/{gid}/rename { name } + 清单刷新 + 关窗", async () => {
    const { wrapper, calls } = await mountOrg(orgHandler());
    await wrapper.find('[data-testid="org-group-rename-g-dev"]').trigger("click");
    await flushPromises();
    const nameInput = expectBody("org-group-rename-name").element as HTMLInputElement;
    expect(nameInput.value).toBe("研发"); // 预填
    await expectBody("org-group-rename-name").setValue("后端组");
    await expectBody("org-group-rename-save").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.find((c) => c.method === "POST" && c.url === `${BASE}/workspaces/ws-1/groups/g-dev/rename`)!.body).toEqual({ name: "后端组" });
    expect(wrapper.find('[data-testid="org-group-item-g-dev"]').text()).toContain("后端组"); // 刷新生效
    expect(bodyFind("org-group-rename-name")).toBeNull(); // 成功关窗
  });

  it("删除分组：确认 modal 文案含组名 → DELETE /groups/{gid} + 清单刷新；409 group_not_empty → 确认窗内上屏不关窗", async () => {
    const { wrapper, calls } = await mountOrg(orgHandler());
    await wrapper.find('[data-testid="org-group-delete-g-dev"]').trigger("click");
    await flushPromises();
    expect(expectBody("org-group-delete-hint").text()).toContain("研发");
    await expectBody("org-group-delete-confirm").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/workspaces/ws-1/groups/g-dev`)).toBe(true);
    expect(wrapper.find('[data-testid="org-group-item-g-dev"]').exists()).toBe(false); // 刷新后消失
    expect(bodyFind("org-group-delete-hint")).toBeNull(); // 确认窗关闭

    const fail = await mountOrg(orgHandler({ onDeleteGroup: () => json(409, { code: "group_not_empty", message: "分组内仍有项目" }) }));
    await fail.wrapper.find('[data-testid="org-group-delete-g-dev"]').trigger("click");
    await flushPromises();
    await expectBody("org-group-delete-confirm").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(expectBody("org-group-delete-api-error").text()).toContain("分组内仍有项目");
    expect(bodyFind("org-group-delete-hint")).not.toBeNull(); // 失败不关窗
  });
});

describe("OrgView 项目操作（受控 a-modal）", () => {
  it("新建项目：groupId 预选当前选中分组；空名称本地校验零请求；载荷逐字 POST /projects { groupId, name }", async () => {
    let posted: unknown;
    const { wrapper, calls } = await mountOrg(orgHandler({
      onCreateProject: (req) => {
        posted = req.body;
        return json(201, { id: "p9", groupId: (req.body as { groupId: string }).groupId, name: (req.body as { name: string }).name, createdAt: "2026-09-06T00:00:00Z" });
      },
    }));
    await wrapper.find('[data-testid="org-project-create"]').trigger("click");
    await flushPromises();
    expectBody("org-project-create-name"); // 模态已开
    await expectBody("org-project-create-save").trigger("click");
    await flushPromises();
    expect(expectBody("org-project-create-error").text()).toContain("请输入名称");
    expect(calls.filter((c) => c.method === "POST" && c.url === `${BASE}/workspaces/ws-1/projects`)).toHaveLength(0);
    await expectBody("org-project-create-name").setValue("结算");
    await expectBody("org-project-create-save").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(posted).toEqual({ groupId: "g-default", name: "结算" }); // 预选当前选中（默认）分组
    expect(bodyFind("org-project-create-name")).toBeNull(); // 成功关窗
  });

  it("新建项目：切换目标分组（a-select）→ 载荷 groupId 跟随", async () => {
    let posted: unknown;
    const { wrapper } = await mountOrg(orgHandler({
      onCreateProject: (req) => {
        posted = req.body;
        return json(201, { id: "p9", groupId: (req.body as { groupId: string }).groupId, name: (req.body as { name: string }).name, createdAt: "2026-09-06T00:00:00Z" });
      },
    }));
    await wrapper.find('[data-testid="org-project-create"]').trigger("click");
    await flushPromises();
    antdSelect(wrapper, "org-project-create-group").vm.$emit("update:value", "g-dev");
    await flushPromises();
    await expectBody("org-project-create-name").setValue("结算");
    await expectBody("org-project-create-save").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(posted).toEqual({ groupId: "g-dev", name: "结算" });
  });

  it("项目改名：modal 预填现名 → POST /projects/{pid}/rename { name }", async () => {
    const { wrapper, calls } = await mountOrg(orgHandler());
    await wrapper.find('[data-testid="org-project-rename-p1"]').trigger("click");
    await flushPromises();
    const nameInput = expectBody("org-project-rename-name").element as HTMLInputElement;
    expect(nameInput.value).toBe("订单"); // 预填
    await expectBody("org-project-rename-name").setValue("订单改");
    await expectBody("org-project-rename-save").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.find((c) => c.method === "POST" && c.url === `${BASE}/workspaces/ws-1/projects/p1/rename`)!.body).toEqual({ name: "订单改" });
    expect(bodyFind("org-project-rename-name")).toBeNull(); // 成功关窗
  });

  it("移动项目：modal 预选项目现分组 → 改选目标分组 → POST /projects/{pid}/move { groupId } 载荷断言", async () => {
    let posted: unknown;
    const { wrapper, calls } = await mountOrg(orgHandler({
      onMoveProject: (req) => {
        posted = req.body;
        return noContent();
      },
    }));
    await wrapper.find('[data-testid="org-project-move-p1"]').trigger("click");
    await flushPromises();
    expectBody("org-project-move-group"); // 模态已开
    antdSelect(wrapper, "org-project-move-group").vm.$emit("update:value", "g-dev");
    await flushPromises();
    await expectBody("org-project-move-save").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(posted).toEqual({ groupId: "g-dev" });
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/workspaces/ws-1/projects/p1/move`)).toBe(true);
    expect(bodyFind("org-project-move-group")).toBeNull(); // 成功关窗
  });

  it("删除项目：确认 modal 文案含项目名 → DELETE /projects/{pid} + 卡片消失", async () => {
    const { wrapper, calls } = await mountOrg(orgHandler());
    await wrapper.find('[data-testid="org-project-delete-p1"]').trigger("click");
    await flushPromises();
    expect(expectBody("org-project-delete-hint").text()).toContain("订单");
    await expectBody("org-project-delete-confirm").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/workspaces/ws-1/projects/p1`)).toBe(true);
    expect(wrapper.find('[data-testid="org-project-card-p1"]').exists()).toBe(false); // 刷新后卡片消失
    expect(bodyFind("org-project-delete-hint")).toBeNull(); // 确认窗关闭
  });
});

describe("OrgView 权限显隐与菜单入口", () => {
  it("myRole=EDITOR：页面可达（成员可读），但新建/改名/移动/删除操作按钮全部隐藏", async () => {
    const { wrapper } = await mountOrg(orgHandler({ detail: DETAIL_EDITOR }));
    expect(wrapper.find("[data-testid=org-view]").exists()).toBe(true);
    expect(wrapper.find('[data-testid="org-group-create"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="org-project-create"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="org-group-rename-g-dev"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="org-group-delete-g-dev"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="org-project-rename-p1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="org-project-move-p1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="org-project-delete-p1"]').exists()).toBe(false);
    // 清单照常渲染
    expect(wrapper.find('[data-testid="org-group-item-g-default"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid^="org-project-card-"]').length).toBe(1);
  });

  it("菜单「组织管理」所有成员可见（VIEWER 亦然）：点击进入组织页", async () => {
    const { wrapper, router } = await mountOrg(
      orgHandler({
        detail: DETAIL_VIEWER,
        workspaceList: [{ id: "ws-1", name: "团队空间", myRole: "VIEWER", createdAt: "2026-09-01T00:00:00Z" }],
      }),
      { path: "/" },
    );
    await wrapper.find("[data-testid=ws-open]").trigger("click"); // 选中 ws-1（VIEWER）
    await flushPromises();
    await flushPromises();
    expect(wrapper.find('[data-testid="menu-org"]').exists()).toBe(true); // 所有成员可见
    expect(wrapper.find('[data-testid="menu-members"]').exists()).toBe(false); // 管理入口仍按角色隐藏
    await wrapper.find('[data-testid="menu-org"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/workspaces/ws-1/org");
    expect(wrapper.find("[data-testid=org-view]").exists()).toBe(true);
  });
});
