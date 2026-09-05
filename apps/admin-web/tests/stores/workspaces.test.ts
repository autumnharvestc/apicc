// M4-A 任务 3：workspaces store 工厂测试（裁定 B/D）——清单/创建/删除 + loading/error 通道；
// 选中工作区详情（myRole 驱动侧栏管理入口显隐，失败/未拉取 → current=null 防闪烁，裁定 C）；
// 创建/删除成功后刷新清单（裁定 B）；删除 current → 清选中。错误语义沿 desktop：失败 error
// 上屏不清旧态。client 用假 fetch 替身（任务 1 先例）。
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
    expect(calls[0]!.headers["Authorization"]).toBeUndefined(); // 清单拉取前无 token 由 client 层管——此处仅钉路径
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

describe("select（选中工作区详情，裁定 C 防闪烁）", () => {
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
});

describe("create（成功后刷新清单，裁定 B）", () => {
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
  });

  it("失败（400）：false + error 上屏，清单不动", async () => {
    const { calls, store } = setup((req) => (req.method === "POST" ? json(400, { code: "validation_failed", message: "名称不合法" }) : json(200, LIST)));
    const ok = await store.create({ name: "x".repeat(65) });
    expect(ok).toBe(false);
    expect(store.error).toBe("名称不合法");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(0); // 失败不触发 refresh
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

  it("失败（403 非 OWNER）：false + error，清单不动", async () => {
    const { store } = setup((req) => (req.url === `${BASE}/workspaces/ws-2` && req.method === "DELETE" ? json(403, { code: "forbidden", message: "仅 OWNER 可删除" }) : json(200, LIST)));
    await store.refresh(); // 先建立清单，再验证删除失败不清旧态
    const ok = await store.remove("ws-2");
    expect(ok).toBe(false);
    expect(store.error).toBe("仅 OWNER 可删除");
    expect(store.list).toEqual(LIST);
  });
});
