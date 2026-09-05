// M4-A 任务 3/4：workspaces store 工厂测试——清单/创建/删除 + 通道拆分（error=工作区面清单/选中、
// actionError=创建/删除弹窗内、membersError=成员面，任务 3 审查次要 2 顺修）；选中竞态防护
// （任务 3 审查次要 1 顺修：乱序完成以最新请求为准）；成员 actions（任务 4，裁定 D：清单/
// 改角色/移除/添加 + 行级 busy + 成功后清单与 current 重选联动）。client 用假 fetch 替身。
import { describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/api/client.js";
import { createWorkspacesStore } from "../../src/stores/workspaces.js";

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
const LIST = [
  { id: "ws-1", name: "团队空间", myRole: "OWNER", createdAt: "2026-09-03T00:00:00Z" },
  { id: "ws-2", name: "访客空间", myRole: "VIEWER", createdAt: "2026-09-04T00:00:00Z" },
];
const DETAIL_1 = { id: "ws-1", name: "团队空间", myRole: "OWNER", memberCount: 3 };
const DETAIL_2 = { id: "ws-2", name: "访客空间", myRole: "VIEWER", memberCount: 1 };
const DETAIL_1_AFTER_TRANSFER = { id: "ws-1", name: "团队空间", myRole: "ADMIN", memberCount: 2 };
const MEMBERS = [
  { userId: "u-1", username: "alice", displayName: "Alice", role: "OWNER" },
  { userId: "u-2", username: "bob", displayName: "Bob", role: "EDITOR" },
];

function setup(handler: FetchHandler) {
  const stub = fetchStub(handler);
  const client = createAdminClient({ baseUrl: BASE, fetch: stub.impl });
  const store = createWorkspacesStore({ client });
  return { calls: stub.calls, store };
}

describe("workspacesStore 工厂隔离", () => {
  it("两实例清单互不可见", async () => {
    const a = setup((req) => (req.method === "GET" && req.url === `${BASE}/workspaces` ? json(200, LIST) : json(404, { code: "not_found", message: "x" })));
    const b = setup(() => json(500, { code: "boom", message: "boom" }));
    await a.store.refresh();
    await b.store.refresh();
    expect(a.store.list).toHaveLength(2);
    expect(b.store.list).toHaveLength(0);
    expect(b.store.error).toBe("boom");
  });
});

describe("refresh（清单 + loading/error 通道）", () => {
  it("成功：GET /workspaces → list；错误通道清空", async () => {
    const { calls, store } = setup((req) => (req.method === "GET" && req.url === `${BASE}/workspaces` ? json(200, LIST) : json(404, { code: "not_found", message: "x" })));
    await store.refresh();
    expect(calls[0]!.url).toBe(`${BASE}/workspaces`);
    expect(store.list).toEqual(LIST);
    expect(store.error).toBeNull();
    expect(store.loading).toBe(false);
  });

  it("失败：error 上屏且不清旧清单（desktop 错误语义）", async () => {
    let calls = 0;
    const { store } = setup((req) => {
      calls += 1;
      if (calls === 1) return json(200, LIST);
      throw new TypeError("fetch failed");
    });
    await store.refresh();
    await store.refresh();
    expect(store.error).toContain("fetch failed");
    expect(store.list).toEqual(LIST); // 旧清单保留
    expect(store.loading).toBe(false);
  });
});

describe("select（选中工作区详情，裁定 C 防闪烁 + 竞态防护）", () => {
  it("成功：GET /workspaces/{id} → current 详情", async () => {
    const { calls, store } = setup((req) => (req.url === `${BASE}/workspaces/ws-1` && req.method === "GET" ? json(200, DETAIL_1) : json(404, { code: "not_found", message: "x" })));
    await store.select("ws-1");
    expect(calls[0]!.url).toBe(`${BASE}/workspaces/ws-1`);
    expect(store.current).toEqual(DETAIL_1);
    expect(store.currentLoading).toBe(false);
  });

  it("失败：current 置 null（入口隐藏防闪烁）+ error 上屏", async () => {
    const { store } = setup(() => json(403, { code: "workspace_forbidden", message: "无权访问" }));
    await store.select("ws-9");
    expect(store.current).toBeNull();
    expect(store.error).toBe("无权访问");
  });

  it("竞态：乱序完成时以最新请求为准，后到的旧结果丢弃（任务 3 审查次要 1 顺修）", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<Response>((resolve) => {
      releaseSlow = () => resolve(json(200, DETAIL_1));
    });
    const { store } = setup((req) => {
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "GET") return slowGate; // 先发慢完成
      if (req.url === `${BASE}/workspaces/ws-2` && req.method === "GET") return json(200, DETAIL_2); // 后发先至
      return json(404, { code: "not_found", message: "x" });
    });
    const slow = store.select("ws-1");
    await store.select("ws-2");
    expect(store.current).toEqual(DETAIL_2);
    releaseSlow(); // ws-1 结果此刻才回来
    await slow;
    expect(store.current).toEqual(DETAIL_2); // 旧结果被丢弃
    expect(store.currentLoading).toBe(false);
  });
});

describe("create（成功后刷新清单，裁定 B；错误走 actionError 弹窗通道）", () => {
  it("成功：POST { name } → true + 自动 refresh（清单再拉一次）", async () => {
    const list = [...LIST];
    const { calls, store } = setup((req) => {
      if (req.url === `${BASE}/workspaces` && req.method === "GET") return json(200, list);
      if (req.url === `${BASE}/workspaces` && req.method === "POST") {
        list.push({ id: "ws-3", name: String((req.body as { name: string }).name), myRole: "OWNER", createdAt: "2026-09-05T00:00:00Z" });
        return json(201, { id: "ws-3", name: "新空间", myRole: "OWNER" });
      }
      return json(404, { code: "not_found", message: "x" });
    });
    const ok = await store.create({ name: "新空间" });
    expect(ok).toBe(true);
    const gets = calls.filter((c) => c.method === "GET" && c.url === `${BASE}/workspaces`);
    expect(gets).toHaveLength(1); // create 内部自动 refresh（此前无清单拉取）
    expect(store.list).toHaveLength(3);
    expect(store.error).toBeNull();
    expect(store.actionError).toBeNull();
  });

  it("失败（400）：false + actionError（弹窗内呈现，任务 3 审查次要 2 顺修），清单 error 不受扰", async () => {
    const { calls, store } = setup((req) => (req.method === "POST" ? json(400, { code: "validation_failed", message: "名称不合法" }) : json(200, LIST)));
    await store.refresh(); // 先建立清单错误通道状态（error=null）
    const ok = await store.create({ name: "x".repeat(65) });
    expect(ok).toBe(false);
    expect(store.actionError).toBe("名称不合法");
    expect(store.error).toBeNull(); // 弹窗错误不污染列表页通道
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1); // 失败不触发 refresh
  });
});

describe("remove（OWNER 删除；成功后刷新；删 current 清选中）", () => {
  it("成功：DELETE /workspaces/{id} → true + 自动 refresh", async () => {
    const list = [...LIST];
    const { calls, store } = setup((req) => {
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "DELETE") {
        list.splice(list.findIndex((w) => w.id === "ws-1"), 1);
        return noContent();
      }
      if (req.url === `${BASE}/workspaces` && req.method === "GET") return json(200, list);
      return json(404, { code: "not_found", message: "x" });
    });
    const ok = await store.remove("ws-1");
    expect(ok).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/workspaces/ws-1`)).toBe(true);
    expect(store.list).toHaveLength(1);
  });

  it("删除的是 current → current 置 null（侧栏管理入口随之隐藏）", async () => {
    const { store } = setup((req) => {
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "DELETE") return noContent();
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "GET") return json(200, DETAIL_1);
      if (req.url === `${BASE}/workspaces` && req.method === "GET") return json(200, LIST);
      return json(404, { code: "not_found", message: "x" });
    });
    await store.select("ws-1");
    expect(store.current).toEqual(DETAIL_1);
    await store.remove("ws-1");
    expect(store.current).toBeNull();
  });

  it("失败（403 非 OWNER）：false + actionError（弹窗内呈现），清单不动", async () => {
    const { store } = setup((req) => (req.url === `${BASE}/workspaces/ws-2` && req.method === "DELETE" ? json(403, { code: "forbidden", message: "仅 OWNER 可删除" }) : json(200, LIST)));
    await store.refresh();
    const ok = await store.remove("ws-2");
    expect(ok).toBe(false);
    expect(store.actionError).toBe("仅 OWNER 可删除");
    expect(store.error).toBeNull();
    expect(store.list).toEqual(LIST);
  });
});

describe("members（任务 4，裁定 D：清单/改角色/移除/添加）", () => {
  it("loadMembers 成功：GET members → members 清单", async () => {
    const { calls, store } = setup((req) => (req.url === `${BASE}/workspaces/ws-1/members` && req.method === "GET" ? json(200, MEMBERS) : json(404, { code: "not_found", message: "x" })));
    const out = await store.loadMembers("ws-1");
    expect(out).toEqual({ ok: true, forbidden: false });
    expect(calls[0]!.url).toBe(`${BASE}/workspaces/ws-1/members`);
    expect(store.members).toEqual(MEMBERS);
    expect(store.membersError).toBeNull();
    expect(store.membersLoading).toBe(false);
  });

  it("loadMembers 403（非 ADMIN 直达）：forbidden=true + membersError（成员面唯一通道，裁定 C）", async () => {
    const { store } = setup(() => json(403, { code: "forbidden", message: "仅 ADMIN 可管理成员" }));
    const out = await store.loadMembers("ws-1");
    expect(out).toEqual({ ok: false, forbidden: true });
    expect(store.membersError).toBe("仅 ADMIN 可管理成员");
  });

  it("loadMembers 其他失败：membersError 上屏，forbidden=false", async () => {
    const { store } = setup(() => {
      throw new TypeError("fetch failed");
    });
    const out = await store.loadMembers("ws-1");
    expect(out).toEqual({ ok: false, forbidden: false });
    expect(store.membersError).toContain("fetch failed");
    expect(store.error).toBeNull(); // 非 403 不外溢到列表页通道
  });

  it("changeRole 成功：PUT { role } + members 刷新 + current 重选（转让后自身角色联动 Layout 显隐）", async () => {
    let transferred = false;
    const { calls, store } = setup((req) => {
      if (req.url === `${BASE}/workspaces/ws-1/members` && req.method === "GET") return json(200, MEMBERS);
      if (req.url === `${BASE}/workspaces/ws-1/members/u-2` && req.method === "PUT") {
        transferred = true;
        return noContent();
      }
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "GET") return json(200, transferred ? DETAIL_1_AFTER_TRANSFER : DETAIL_1);
      return json(404, { code: "not_found", message: "x" });
    });
    await store.select("ws-1");
    const ok = await store.changeRole("ws-1", "u-2", "ADMIN");
    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT" && c.url === `${BASE}/workspaces/ws-1/members/u-2`);
    expect(put!.body).toEqual({ role: "ADMIN" });
    expect(store.members).toEqual(MEMBERS); // 清单已刷新
    expect(store.current).toEqual(DETAIL_1_AFTER_TRANSFER); // current 重选，myRole 联动
    expect(store.memberBusyId).toBeNull();
    expect(store.membersError).toBeNull();
  });

  it("changeRole 失败（owner_immutable）：false + membersError，清单与 current 不动", async () => {
    const { store } = setup((req) => {
      if (req.url === `${BASE}/workspaces/ws-1/members` && req.method === "GET") return json(200, MEMBERS);
      if (req.url === `${BASE}/workspaces/ws-1/members/u-1` && req.method === "PUT") return json(400, { code: "owner_immutable", message: "不能变更 OWNER 的角色" });
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "GET") return json(200, DETAIL_1);
      return json(404, { code: "not_found", message: "x" });
    });
    await store.select("ws-1");
    await store.loadMembers("ws-1");
    const ok = await store.changeRole("ws-1", "u-1", "VIEWER");
    expect(ok).toBe(false);
    expect(store.membersError).toBe("不能变更 OWNER 的角色");
    expect(store.members).toEqual(MEMBERS); // 清单不动
    expect(store.current).toEqual(DETAIL_1); // current 不动
    expect(store.memberBusyId).toBeNull();
  });

  it("addMember 成功（§3.2 对非成员即创建）：PUT { role } + members 刷新 + current 重选（memberCount 变化）", async () => {
    const members = [MEMBERS[0]!];
    const { calls, store } = setup((req) => {
      if (req.url === `${BASE}/workspaces/ws-1/members` && req.method === "GET") return json(200, members);
      if (req.url === `${BASE}/workspaces/ws-1/members/u-2` && req.method === "PUT") {
        members.push({ userId: "u-2", username: "bob", displayName: "Bob", role: "EDITOR" });
        return noContent();
      }
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "GET") return json(200, DETAIL_1);
      return json(404, { code: "not_found", message: "x" });
    });
    await store.select("ws-1"); // 预选中：成功后 current 重选（memberCount 联动）
    const ok = await store.addMember("ws-1", "u-2", "EDITOR");
    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT" && c.url === `${BASE}/workspaces/ws-1/members/u-2`);
    expect(put!.body).toEqual({ role: "EDITOR" });
    expect(store.members).toHaveLength(2);
    expect(store.current).toEqual(DETAIL_1);
    expect(store.memberSubmitting).toBe(false);
  });

  it("addMember 失败：false + membersError", async () => {
    const { store } = setup((req) => (req.url === `${BASE}/workspaces/ws-1/members/u-9` && req.method === "PUT" ? json(404, { code: "user_not_found", message: "用户不存在" }) : json(200, MEMBERS)));
    const ok = await store.addMember("ws-1", "u-9", "VIEWER");
    expect(ok).toBe(false);
    expect(store.membersError).toBe("用户不存在");
  });

  it("removeMember 成功：DELETE + members 刷新 + current 重选", async () => {
    const members = [...MEMBERS];
    const { calls, store } = setup((req) => {
      if (req.url === `${BASE}/workspaces/ws-1/members` && req.method === "GET") return json(200, members);
      if (req.url === `${BASE}/workspaces/ws-1/members/u-2` && req.method === "DELETE") {
        members.splice(members.findIndex((m) => m.userId === "u-2"), 1);
        return noContent();
      }
      if (req.url === `${BASE}/workspaces/ws-1` && req.method === "GET") return json(200, DETAIL_1);
      return json(404, { code: "not_found", message: "x" });
    });
    await store.select("ws-1");
    const ok = await store.removeMember("ws-1", "u-2");
    expect(ok).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/workspaces/ws-1/members/u-2`)).toBe(true);
    expect(store.members).toHaveLength(1);
    expect(store.current).toEqual(DETAIL_1);
  });

  it("removeMember 失败（403）：false + membersError，清单不动", async () => {
    const { store } = setup((req) => (req.url === `${BASE}/workspaces/ws-1/members/u-1` && req.method === "DELETE" ? json(403, { code: "forbidden", message: "不能移除 OWNER" }) : json(200, MEMBERS)));
    await store.loadMembers("ws-1");
    const ok = await store.removeMember("ws-1", "u-1");
    expect(ok).toBe(false);
    expect(store.membersError).toBe("不能移除 OWNER");
    expect(store.members).toEqual(MEMBERS);
  });
});

describe("acl（任务 5，裁定 A/B：tree/acl/setAclEntry/removeAclEntry）", () => {
  const TREE = {
    workspaceId: "ws-1",
    rootVersion: 7,
    files: [{ path: "groups/后端/projects/订单/collections/订单/apis/a/apicc.api.yaml", hash: "h1", version: 1, size: 10 }],
    projects: [
      { id: "p-1", name: "订单", path: "groups/后端/projects/订单", myRole: "OWNER" },
      { id: "p-2", name: "库存", path: "groups/后端/projects/库存", myRole: "EDITOR" },
    ],
  };
  const ACL_ROWS = [{ userId: "u-2", role: "VIEWER" }];
  const TREE_AFTER = {
    ...TREE,
    projects: [
      { id: "p-1", name: "订单", path: "groups/后端/projects/订单", myRole: "OWNER" },
      { id: "p-2", name: "库存", path: "groups/后端/projects/库存", myRole: "NONE" },
    ],
  };

  function aclHandler(overrides?: { onPut?: (req: CapturedRequest) => Response | Promise<Response>; onDelete?: (req: CapturedRequest) => Response | Promise<Response> }): FetchHandler {
    let p2Denied = false;
    return (req) => {
      const { method, url } = req;
      if (url === `${BASE}/workspaces/ws-1/tree` && method === "GET") return json(200, p2Denied ? TREE_AFTER : TREE);
      if (url === `${BASE}/workspaces/ws-1/projects/p-2/acl` && method === "GET") return json(200, p2Denied ? [{ userId: "u-2", role: "NONE" }] : ACL_ROWS);
      if (url === `${BASE}/workspaces/ws-1/projects/p-2/acl` && method === "PUT") {
        if (overrides?.onPut) return overrides.onPut(req);
        p2Denied = true;
        return noContent();
      }
      // DELETE 带 ?userId= 查询串 → 前缀匹配（url === 会漏）
      if (url.startsWith(`${BASE}/workspaces/ws-1/projects/p-2/acl`) && method === "DELETE") {
        if (overrides?.onDelete) return overrides.onDelete(req);
        p2Denied = false;
        return noContent();
      }
      if (url === `${BASE}/workspaces/ws-1/projects/p-1/acl` && method === "GET") return json(200, []);
      return json(404, { code: "not_found", message: "x" });
    };
  }

  it("loadTree 成功：GET tree → tree state（projects[].path/myRole 契约形状，裁定 C）", async () => {
    const { calls, store } = setup(aclHandler());
    await store.loadTree("ws-1");
    expect(calls[0]!.url).toBe(`${BASE}/workspaces/ws-1/tree`);
    expect(store.tree).toEqual(TREE);
    expect(store.treeLoading).toBe(false);
  });

  it("loadTree 失败：aclError 上屏，tree 保持 null", async () => {
    const { store } = setup((req) => (req.url === `${BASE}/workspaces/ws-1/tree` ? json(403, { code: "forbidden", message: "无权读取" }) : json(200, {})));
    await store.loadTree("ws-1");
    expect(store.tree).toBeNull();
    expect(store.aclError).toBe("无权读取");
  });

  it("loadAcl 成功：GET acl → entries + aclProjectId", async () => {
    const { calls, store } = setup(aclHandler());
    await store.loadAcl("ws-1", "p-2");
    expect(calls[0]!.url).toBe(`${BASE}/workspaces/ws-1/projects/p-2/acl`);
    expect(store.aclEntries).toEqual(ACL_ROWS);
    expect(store.aclProjectId).toBe("p-2");
    expect(store.aclLoading).toBe(false);
  });

  it("loadAcl 失败：aclError 上屏", async () => {
    const { store } = setup(() => json(404, { code: "not_found", message: "项目不存在" }));
    await store.loadAcl("ws-1", "p-9");
    expect(store.aclError).toBe("项目不存在");
  });

  it("loadAcl 竞态：乱序完成以最新请求为准（任务 4 审查备案 4：ACL 页同样受项目切换影响）", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<Response>((resolve) => {
      releaseSlow = () => resolve(json(200, ACL_ROWS));
    });
    const { store } = setup((req) => {
      if (req.url === `${BASE}/workspaces/ws-1/projects/p-1/acl` && req.method === "GET") return slowGate; // 先发慢完成
      if (req.url === `${BASE}/workspaces/ws-1/projects/p-2/acl` && req.method === "GET") return json(200, [{ userId: "u-3", role: "NONE" }]); // 后发先至
      return json(404, { code: "not_found", message: "x" });
    });
    const slow = store.loadAcl("ws-1", "p-1");
    await store.loadAcl("ws-1", "p-2");
    expect(store.aclProjectId).toBe("p-2");
    releaseSlow();
    await slow;
    expect(store.aclProjectId).toBe("p-2"); // 旧结果丢弃
    expect(store.aclEntries).toEqual([{ userId: "u-3", role: "NONE" }]);
  });

  it("setAclEntry 成功（NONE=拒之门外）：PUT { userId, role } + acl 重载 + tree 重载（myRole 联动，裁定 B）", async () => {
    const { calls, store } = setup(aclHandler());
    await store.loadTree("ws-1"); // 页面挂载即拉树（先例：ProjectAclView watch）
    await store.loadAcl("ws-1", "p-2");
    const ok = await store.setAclEntry("ws-1", "p-2", { userId: "u-2", role: "NONE" });
    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT" && c.url === `${BASE}/workspaces/ws-1/projects/p-2/acl`);
    expect(put!.body).toEqual({ userId: "u-2", role: "NONE" });
    expect(store.aclEntries).toEqual([{ userId: "u-2", role: "NONE" }]); // 行仍在，显示 NONE
    expect(store.tree!.projects.find((p) => p.id === "p-2")!.myRole).toBe("NONE"); // tree 重载联动
  });

  it("setAclEntry 失败（403）：false + aclError，行不动", async () => {
    const { store } = setup(aclHandler({ onPut: () => json(403, { code: "forbidden", message: "仅 ADMIN 可管理 ACL" }) }));
    await store.loadAcl("ws-1", "p-2");
    const ok = await store.setAclEntry("ws-1", "p-2", { userId: "u-2", role: "NONE" });
    expect(ok).toBe(false);
    expect(store.aclError).toBe("仅 ADMIN 可管理 ACL");
    expect(store.aclEntries).toEqual(ACL_ROWS);
  });

  it("removeAclEntry 成功（删行=恢复工作区角色继承，契约修订 2026-09-04）：DELETE ?userId= + acl/tree 重载", async () => {
    let p2Denied = true;
    const { calls, store } = setup((req) => {
      const { method, url } = req;
      if (url === `${BASE}/workspaces/ws-1/tree` && method === "GET") return json(200, p2Denied ? TREE_AFTER : TREE);
      if (url === `${BASE}/workspaces/ws-1/projects/p-2/acl` && method === "GET") return json(200, p2Denied ? [{ userId: "u-2", role: "NONE" }] : ACL_ROWS);
      if (url.startsWith(`${BASE}/workspaces/ws-1/projects/p-2/acl`) && method === "DELETE") {
        p2Denied = false;
        return noContent();
      }
      return json(404, { code: "not_found", message: "x" });
    });
    await store.loadTree("ws-1");
    await store.loadAcl("ws-1", "p-2");
    const ok = await store.removeAclEntry("ws-1", "p-2", "u-2");
    expect(ok).toBe(true);
    const del = calls.find((c) => c.method === "DELETE" && c.url === `${BASE}/workspaces/ws-1/projects/p-2/acl?userId=u-2`);
    expect(del!.url).toBe(`${BASE}/workspaces/ws-1/projects/p-2/acl?userId=u-2`);
    expect(store.aclEntries).toEqual(ACL_ROWS); // 行消失（恢复继承后回到工作区角色）
    expect(store.tree!.projects.find((p) => p.id === "p-2")!.myRole).toBe("EDITOR");
  });

  it("removeAclEntry 失败：false + aclError", async () => {
    const { store } = setup(aclHandler({ onDelete: () => json(500, { code: "io_error", message: "服务端异常" }) }));
    await store.loadAcl("ws-1", "p-2");
    const ok = await store.removeAclEntry("ws-1", "p-2", "u-2");
    expect(ok).toBe(false);
    expect(store.aclError).toBe("服务端异常");
    expect(store.aclEntries).toEqual(ACL_ROWS);
  });
});
