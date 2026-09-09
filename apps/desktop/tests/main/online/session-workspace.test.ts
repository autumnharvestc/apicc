// M3-B 任务 3：online session 工作区状态扩展——当前在线工作区 + 树缓存
// （plan 任务 3 步骤 2：main/online/session.ts 扩展）。open/close 为纯状态操作（不发网络）；
// getTreeView 取树（缓存：第二次不重发请求、内容变更即失效）、映射 TreeNodeDTO（裁定 A）；
// 切换/关闭清缓存。文件版本由渲染层编辑缓冲自持，main 不做文件内容缓存（次要 5 顺修备案）。
import { describe, expect, it } from "vitest";
import { createOnlineSession, onlineTreeToDto } from "../../../src/main/online/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import type { TokenStore } from "../../../src/main/online/tokenStore.js";

const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const SERVER = "http://127.0.0.1:8080";
const LOGIN_OK = (): Response => json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER });

// path 实体化（2026-09-08）形态：内容 path 首段=项目实体 UUID；projects 行 = 实体表产出
// {id, name, groupId, myRole}（旧 path 目录字段已退役）。
const PID = "0f8d3a2c-a1b2-c3d4-e5f6-0123456789ab";
const TREE = {
  workspaceId: "ws-1",
  rootVersion: 2,
  files: [
    { path: "apicc.workspace.yaml", hash: "h0", version: 1, size: 10 },
    { path: `${PID}/collections/c/apis/a/api.yaml`, hash: "h1", version: 2, size: 20 },
  ],
  projects: [{ id: PID, name: "p", groupId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", myRole: "EDITOR" as const }],
};

interface CapturedRequest { url: string; method: string; headers: Record<string, string>; body?: unknown }

/** 组清单行形状（§4 GET groups，OnlineGroupSchema 同款）。 */
interface GroupRow { id: string; name: string; isDefault: boolean; createdAt: string }

function setup(tree: typeof TREE = TREE, groups: GroupRow[] = []) {
  const calls: CapturedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    const req: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    if (req.url.endsWith("/auth/login")) return LOGIN_OK();
    if (req.url.endsWith("/tree")) return json(200, tree);
    if (req.method === "GET" && req.url.includes("/groups")) return json(200, groups);
    if (req.method === "GET" && req.url.includes("/files?")) {
      const paths = (req.url.split("paths=")[1] ?? "").split(",").map(decodeURIComponent);
      return json(200, {
        files: paths.filter((p) => tree.files.some((f) => f.path === p)).map((p) => {
          const row = tree.files.find((f) => f.path === p)!;
          return { path: p, content: `content-of-${p}`, version: row.version, hash: row.hash };
        }),
        missing: paths.filter((p) => !tree.files.some((f) => f.path === p)),
      });
    }
    if (req.method === "PUT") return json(201, { path: "x", version: 99, hash: "hx" });
    return json(200, USER);
  };
  const memory = new Map<string, string>();
  const tokenStore: TokenStore = {
    save: (baseUrl, token) => memory.set(baseUrl, token),
    load: (baseUrl) => memory.get(baseUrl) ?? null,
    clear: (baseUrl) => void memory.delete(baseUrl),
  };
  const session = createOnlineSession({
    createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: impl, timeoutMs: 5_000, onUnauthorized: hooks.onUnauthorized }),
    tokenStore,
  });
  return { session, calls };
}

const WS = { workspaceId: "ws-1", name: "团队空间", myRole: "EDITOR" as const };

describe("online session 工作区状态（任务 3）", () => {
  it("openWorkspace 记录状态（不发网络）；getTreeView 首取服务端树并映射 DTO + 项目角色，树缓存生效（第二次不再发 /tree）", async () => {
    const { session, calls } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    const treeCallsBefore = calls.filter((c) => c.url.endsWith("/tree")).length;
    session.openWorkspace(WS);
    expect(session.workspace).toEqual({ id: "ws-1", name: "团队空间", myRole: "EDITOR" });
    expect(calls.filter((c) => c.url.endsWith("/tree")).length).toBe(treeCallsBefore);
    const view = await session.getTreeView("ws-1");
    expect(view.workspaceId).toBe("ws-1");
    expect(view.name).toBe("团队空间");
    expect(view.myRole).toBe("EDITOR");
    expect(view.projects).toEqual(TREE.projects);
    expect(view.tree).toEqual(onlineTreeToDto(TREE, "团队空间"));
    expect(view.tree.label).toBe("团队空间");
    // 缓存：第二次 getTreeView 不重发 /tree 请求
    await session.getTreeView("ws-1");
    expect(calls.filter((c) => c.url.endsWith("/tree")).length).toBe(treeCallsBefore + 1);
  });

  it("closeWorkspace 清状态与树缓存；之后 getTreeView 抛「尚未打开在线工作区」", async () => {
    const { session } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    await session.getTreeView("ws-1");
    session.closeWorkspace();
    expect(session.workspace).toBeNull();
    await expect(session.getTreeView("ws-1")).rejects.toThrow(/尚未打开在线工作区/);
  });

  it("切换工作区（openWorkspace 覆盖）重置树缓存：对新 id 重发 /tree；不匹配的 id 拒绝", async () => {
    const { session, calls } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    await session.getTreeView("ws-1");
    session.openWorkspace({ workspaceId: "ws-2", name: "另一空间", myRole: "VIEWER" });
    await session.getTreeView("ws-2");
    expect(calls.filter((c) => c.url.endsWith("/tree")).length).toBe(2);
    await expect(session.getTreeView("ws-1")).rejects.toThrow(/尚未打开在线工作区/);
    expect(session.workspace).toEqual({ id: "ws-2", name: "另一空间", myRole: "VIEWER" });
  });

  it("putFile 成功前移版本；文件版本由渲染层自持（main 不缓存文件内容——次要 5 顺修备案）", async () => {
    const { session } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    await session.putFile({ workspaceId: "ws-1", path: `${PID}/collections/c/apis/a/api.yaml`, content: "new", baseVersion: 2 });
    // 推送成功只前移树缓存失效标记与既有出口；main 不持文件内容缓存（版本号在渲染层编辑缓冲自持）
    expect(session.workspace).toEqual({ id: "ws-1", name: "团队空间", myRole: "EDITOR" });
  });

  it("内容变更使树缓存失效：putFile 成功后 getTreeView 重发 /tree（新 hash/新文件可见）", async () => {
    const { session, calls } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    await session.getTreeView("ws-1");
    await session.getTreeView("ws-1"); // 缓存命中：/tree 仍只发过 1 次
    expect(calls.filter((c) => c.url.endsWith("/tree"))).toHaveLength(1);
    // 推送成功 → 树缓存失效，下次取视图重发 /tree
    await session.putFile({ workspaceId: "ws-1", path: `${PID}/collections/c/apis/a/api.yaml`, content: "new", baseVersion: 2 });
    await session.getTreeView("ws-1");
    expect(calls.filter((c) => c.url.endsWith("/tree"))).toHaveLength(2);
  });

  it("未登录时 openWorkspace 可记录状态，但 getTreeView 抛「尚未登录」（内容 API 需 token）", async () => {
    const { session } = setup();
    session.openWorkspace(WS);
    expect(session.workspace).toEqual({ id: "ws-1", name: "团队空间", myRole: "EDITOR" });
    await expect(session.getTreeView("ws-1")).rejects.toThrow(/尚未登录/);
  });

  it("getTreeView 分组层（计划 C 任务 3）：/groups 清单注入 groupNames → 项目挂 group:<groupId> 合成组节点（树+组同取同缓存）", async () => {
    const gid = TREE.projects[0]!.groupId!;
    const groups: GroupRow[] = [{ id: gid, name: "电商组", isDefault: false, createdAt: "2026-01-01T00:00:00Z" }];
    const { session, calls } = setup(TREE, groups);
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    const view = await session.getTreeView("ws-1");
    // 与纯函数映射同口径（传入组名表）；组节点 id 带合成前缀、label=组名
    expect(view.tree).toEqual(onlineTreeToDto(TREE, "团队空间", new Map([[gid, "电商组"]])));
    const group = view.tree.children!.find((c) => c.kind === "group");
    expect(group).toMatchObject({ id: `group:${gid}`, label: "电商组" });
    expect(group!.children!.map((c) => c.id)).toEqual([TREE.projects[0]!.id]);
    // 缓存：第二次 getTreeView 树与组清单都不重发（/tree 与 /groups 各只 1 次）
    await session.getTreeView("ws-1");
    expect(calls.filter((c) => c.url.endsWith("/tree"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/groups"))).toHaveLength(1);
  });

  it("组清单失败（非 200/形状不符）降级空表：孤儿项目直挂根，树浏览不被阻断", async () => {
    // setup 默认 groups=[] 的 /groups 端点返回空清单；此处换成协议坏体模拟清单面故障
    const gid = TREE.projects[0]!.groupId!;
    const calls: CapturedRequest[] = [];
    const badImpl: typeof fetch = async (input, init) => {
      const req: CapturedRequest = { url: String(input), method: init?.method ?? "GET", headers: {} };
      calls.push(req);
      if (req.url.endsWith("/auth/login")) return LOGIN_OK();
      if (req.url.endsWith("/tree")) return json(200, TREE);
      if (req.method === "GET" && req.url.includes("/groups")) return json(200, { not: "a-group-list" });
      return json(200, USER);
    };
    const memory = new Map<string, string>([[SERVER, "tok-1"]]);
    const session = createOnlineSession({
      createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: badImpl, timeoutMs: 5_000, onUnauthorized: hooks.onUnauthorized }),
      tokenStore: {
        save: (baseUrl, token) => void memory.set(baseUrl, token),
        load: (baseUrl) => memory.get(baseUrl) ?? null,
        clear: (baseUrl) => void memory.delete(baseUrl),
      },
    });
    session.openWorkspace(WS);
    // 未登录 → 先登录（login 走 badImpl 的 LOGIN_OK 分支）
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    const view = await session.getTreeView("ws-1");
    expect(view.tree.children!.some((c) => c.kind === "group" && c.id === `group:${gid}`)).toBe(false);
    expect(view.tree.children!.some((c) => c.kind === "project" && c.id === TREE.projects[0]!.id)).toBe(true);
  });
});
