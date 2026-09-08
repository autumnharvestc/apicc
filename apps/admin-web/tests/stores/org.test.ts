// 任务 6：org store 工厂测试——分组/项目清单（并行拉取）+ 建分组/改名/删除 + 建项目/改名/移动/
// 删除九个动作；通道拆分（workspaces/users 先例：error=清单拉取页顶呈现、actionError=弹窗动作
// 就近呈现，均上屏不抛出）；防重复提交（submitting=弹窗表单、busyId=删除确认）；动作成功后
// 自动刷新清单。client 用假 fetch 替身（workspaces store 测试同款），请求 URL/载荷逐字断言。
import { describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/api/client.js";
import { createOrgStore } from "../../src/stores/org.js";

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
const GROUPS = [
  { id: "g-default", name: "默认分组", isDefault: true, createdAt: "2026-09-01T00:00:00Z" },
  { id: "g-dev", name: "研发", isDefault: false, createdAt: "2026-09-02T00:00:00Z" },
];
const PROJECTS = [
  { id: "p1", groupId: "g-default", name: "订单", createdAt: "2026-09-03T00:00:00Z" },
  { id: "p2", groupId: "g-dev", name: "库存", createdAt: "2026-09-04T00:00:00Z" },
];

/** 组织面端点处理器：GET 清单默认成功，写动作经 opts 注入（缺省 404 兜底防误命中）。 */
function orgHandler(opts: {
  groups?: unknown[];
  projects?: unknown[];
  onCreateGroup?: (req: CapturedRequest) => Response | Promise<Response>;
  onRenameGroup?: (req: CapturedRequest) => Response | Promise<Response>;
  onDeleteGroup?: (req: CapturedRequest) => Response | Promise<Response>;
  onCreateProject?: (req: CapturedRequest) => Response | Promise<Response>;
  onRenameProject?: (req: CapturedRequest) => Response | Promise<Response>;
  onMoveProject?: (req: CapturedRequest) => Response | Promise<Response>;
  onDeleteProject?: (req: CapturedRequest) => Response | Promise<Response>;
} = {}): FetchHandler {
  return (req) => {
    const { method, url } = req;
    if (url === `${BASE}/workspaces/ws-1/groups` && method === "GET") return json(200, opts.groups ?? GROUPS);
    if (url === `${BASE}/workspaces/ws-1/groups` && method === "POST") return opts.onCreateGroup ? opts.onCreateGroup(req) : notFound();
    if (url === `${BASE}/workspaces/ws-1/groups/g-dev/rename` && method === "POST") return opts.onRenameGroup ? opts.onRenameGroup(req) : notFound();
    if (url === `${BASE}/workspaces/ws-1/groups/g-dev` && method === "DELETE") return opts.onDeleteGroup ? opts.onDeleteGroup(req) : notFound();
    if (url === `${BASE}/workspaces/ws-1/projects` && method === "GET") return json(200, opts.projects ?? PROJECTS);
    if (url === `${BASE}/workspaces/ws-1/projects` && method === "POST") return opts.onCreateProject ? opts.onCreateProject(req) : notFound();
    if (url === `${BASE}/workspaces/ws-1/projects/p1/rename` && method === "POST") return opts.onRenameProject ? opts.onRenameProject(req) : notFound();
    if (url === `${BASE}/workspaces/ws-1/projects/p1/move` && method === "POST") return opts.onMoveProject ? opts.onMoveProject(req) : notFound();
    if (url === `${BASE}/workspaces/ws-1/projects/p1` && method === "DELETE") return opts.onDeleteProject ? opts.onDeleteProject(req) : notFound();
    return notFound();
  };
}

function setup(handler: FetchHandler) {
  const stub = fetchStub(handler);
  const client = createAdminClient({ baseUrl: BASE, fetch: stub.impl });
  const store = createOrgStore({ client });
  return { calls: stub.calls, store };
}

describe("orgStore 工厂隔离", () => {
  it("两实例清单互不可见", async () => {
    const a = setup(orgHandler());
    const b = setup(() => json(500, { code: "boom", message: "boom" }));
    await a.store.refresh("ws-1");
    await b.store.refresh("ws-1");
    expect(a.store.groups).toHaveLength(2);
    expect(b.store.groups).toHaveLength(0);
    expect(b.store.error).toBe("boom");
  });
});

describe("refresh（分组+项目并行拉取）", () => {
  it("成功：GET groups + GET projects 双端点 → groups/projects 填充，loading 收口", async () => {
    const { calls, store } = setup(orgHandler());
    await store.refresh("ws-1");
    expect(calls.some((c) => c.method === "GET" && c.url === `${BASE}/workspaces/ws-1/groups`)).toBe(true);
    expect(calls.some((c) => c.method === "GET" && c.url === `${BASE}/workspaces/ws-1/projects`)).toBe(true);
    expect(store.groups).toEqual(GROUPS);
    expect(store.projects).toEqual(PROJECTS);
    expect(store.error).toBeNull();
    expect(store.loading).toBe(false);
  });

  it("失败：error 上屏且不清旧清单（desktop 错误语义，不抛出）", async () => {
    let n = 0;
    const { store } = setup(() => {
      n += 1;
      if (n <= 2) return json(200, n === 1 ? GROUPS : PROJECTS);
      return json(500, { code: "boom", message: "服务端故障" });
    });
    await store.refresh("ws-1");
    expect(store.groups).toHaveLength(2);
    await store.refresh("ws-1");
    expect(store.error).toBe("服务端故障");
    expect(store.groups).toHaveLength(2); // 旧清单保留
    expect(store.projects).toHaveLength(2);
    expect(store.loading).toBe(false);
  });
});

describe("分组动作（create/rename/delete）", () => {
  it("createGroup：POST { name } → 201 → 自动刷新 + return true", async () => {
    let posted: unknown;
    const groups = [...GROUPS];
    const { calls, store } = setup(orgHandler({
      onCreateGroup: (req) => {
        posted = req.body;
        groups.push({ id: "g3", name: (req.body as { name: string }).name, isDefault: false, createdAt: "2026-09-06T00:00:00Z" });
        return json(201, groups[groups.length - 1]);
      },
      groups,
    }));
    const ok = await store.createGroup("ws-1", "市场");
    expect(ok).toBe(true);
    expect(posted).toEqual({ name: "市场" });
    const groupGets = calls.filter((c) => c.method === "GET" && c.url === `${BASE}/workspaces/ws-1/groups`);
    expect(groupGets.length).toBe(1); // 创建成功自动刷新（此前未拉取，唯一一次 GET 即刷新）
    expect(store.groups.some((g) => g.id === "g3")).toBe(true);
  });

  it("createGroup：409 group_name_taken → actionError 上屏不抛出、return false", async () => {
    const { store } = setup(orgHandler({ onCreateGroup: () => json(409, { code: "group_name_taken", message: "分组名称已存在" }) }));
    const ok = await store.createGroup("ws-1", "研发");
    expect(ok).toBe(false);
    expect(store.actionError).toBe("分组名称已存在");
    expect(store.error).toBeNull();
  });

  it("createGroup：submitting 在途防重复提交（第二次调用零请求、return false）", async () => {
    let release!: () => void;
    const gate = new Promise<Response>((resolve) => {
      release = () => resolve(json(201, GROUPS[0]));
    });
    let posts = 0;
    const { store } = setup(orgHandler({
      onCreateGroup: () => {
        posts += 1;
        return gate;
      },
    }));
    const first = store.createGroup("ws-1", "市场"); // 在途不等待
    const second = await store.createGroup("ws-1", "市场2");
    expect(second).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(posts).toBe(1);
    expect(store.submitting).toBe(false);
  });

  it("renameGroup：POST /groups/{gid}/rename { name } → 200 → 刷新；400 default_group_immutable → actionError", async () => {
    let posted: unknown;
    const { calls, store } = setup(orgHandler({
      onRenameGroup: (req) => {
        posted = req.body;
        return json(200, { id: "g-dev", name: "后端", isDefault: false, createdAt: "2026-09-02T00:00:00Z" });
      },
    }));
    const ok = await store.renameGroup("ws-1", "g-dev", "后端");
    expect(ok).toBe(true);
    expect(posted).toEqual({ name: "后端" });
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/workspaces/ws-1/groups/g-dev/rename`)).toBe(true);
    expect(store.groups.find((g) => g.id === "g-dev")?.name).toBe("研发"); // 清单来自刷新结果（桩未变）

    const bad = setup(orgHandler({ onRenameGroup: () => json(400, { code: "default_group_immutable", message: "默认分组不可改名" }) }));
    expect(await bad.store.renameGroup("ws-1", "g-dev", "x")).toBe(false);
    expect(bad.store.actionError).toBe("默认分组不可改名");
  });

  it("deleteGroup：DELETE /groups/{gid} → 204 → 刷新；busyId 防重复；409 group_not_empty → actionError", async () => {
    let release!: () => void;
    const gate = new Promise<Response>((resolve) => {
      release = () => resolve(noContent());
    });
    let deletes = 0;
    const { calls, store } = setup(orgHandler({
      onDeleteGroup: () => {
        deletes += 1;
        return gate;
      },
    }));
    const first = store.deleteGroup("ws-1", "g-dev"); // 在途不等待
    expect(store.busyId).toBe("g-dev");
    const second = await store.deleteGroup("ws-1", "g-dev");
    expect(second).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(deletes).toBe(1);
    expect(store.busyId).toBeNull();
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/workspaces/ws-1/groups/g-dev`)).toBe(true);
    expect(calls.some((c) => c.method === "GET" && c.url === `${BASE}/workspaces/ws-1/groups`)).toBe(true); // 成功后刷新

    const bad = setup(orgHandler({ onDeleteGroup: () => json(409, { code: "group_not_empty", message: "分组内仍有项目" }) }));
    expect(await bad.store.deleteGroup("ws-1", "g-dev")).toBe(false);
    expect(bad.store.actionError).toBe("分组内仍有项目");
  });
});

describe("项目动作（create/rename/move/delete）", () => {
  it("createProject：POST { groupId, name } → 201 → 自动刷新", async () => {
    let posted: unknown;
    const projects = [...PROJECTS];
    const { calls, store } = setup(orgHandler({
      onCreateProject: (req) => {
        posted = req.body;
        projects.push({ id: "p3", groupId: (req.body as { groupId: string }).groupId, name: (req.body as { name: string }).name, createdAt: "2026-09-06T00:00:00Z" });
        return json(201, projects[projects.length - 1]);
      },
      projects,
    }));
    const ok = await store.createProject("ws-1", { groupId: "g-dev", name: "结算" });
    expect(ok).toBe(true);
    expect(posted).toEqual({ groupId: "g-dev", name: "结算" });
    expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/workspaces/ws-1/projects`).length).toBe(1); // 创建成功自动刷新
    expect(store.projects.some((p) => p.id === "p3")).toBe(true);
  });

  it("renameProject：POST /projects/{pid}/rename { name } → 200 → 刷新", async () => {
    let posted: unknown;
    const { calls, store } = setup(orgHandler({
      onRenameProject: (req) => {
        posted = req.body;
        return json(200, { id: "p1", groupId: "g-default", name: "订单改", createdAt: "2026-09-03T00:00:00Z" });
      },
    }));
    const ok = await store.renameProject("ws-1", "p1", "订单改");
    expect(ok).toBe(true);
    expect(posted).toEqual({ name: "订单改" });
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/workspaces/ws-1/projects/p1/rename`)).toBe(true);
  });

  it("moveProject：POST /projects/{pid}/move { groupId } → 204 → 刷新；400/404 → actionError", async () => {
    let posted: unknown;
    const { calls, store } = setup(orgHandler({
      onMoveProject: (req) => {
        posted = req.body;
        return noContent();
      },
    }));
    const ok = await store.moveProject("ws-1", "p1", "g-dev");
    expect(ok).toBe(true);
    expect(posted).toEqual({ groupId: "g-dev" });
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/workspaces/ws-1/projects/p1/move`)).toBe(true);

    const bad = setup(orgHandler({ onMoveProject: () => json(404, { code: "group_not_found", message: "目标分组不存在" }) }));
    expect(await bad.store.moveProject("ws-1", "p1", "g-x")).toBe(false);
    expect(bad.store.actionError).toBe("目标分组不存在");
  });

  it("deleteProject：DELETE /projects/{pid} → 204 → 刷新；404 project_not_found → actionError", async () => {
    const projects = [...PROJECTS];
    const { calls, store } = setup(orgHandler({
      onDeleteProject: () => {
        projects.splice(projects.findIndex((p) => p.id === "p1"), 1);
        return noContent();
      },
      projects,
    }));
    const ok = await store.deleteProject("ws-1", "p1");
    expect(ok).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/workspaces/ws-1/projects/p1`)).toBe(true);
    expect(store.projects.some((p) => p.id === "p1")).toBe(false); // 刷新后已消失

    const bad = setup(orgHandler({ onDeleteProject: () => json(404, { code: "project_not_found", message: "项目不存在" }) }));
    expect(await bad.store.deleteProject("ws-1", "p1")).toBe(false);
    expect(bad.store.actionError).toBe("项目不存在");
  });
});
