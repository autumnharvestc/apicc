// 计划 C 任务 1：online session 会话表化——工作区驻留与显式激活。
// 单槽（workspaceState/treeCache 单值）→ Map<workspaceId, {workspaceState, treeCache}> + 活跃指针：
// openWorkspace 入表激活（已驻留则更新状态并清该工作区树缓存）；activateWorkspace 纯切指针
// （表中有且已登录）；closeWorkspace 带 id 出表/无参关活跃，出表不自动切活跃；
// requireWorkspace 仍限活跃工作区（防跨工作区误写）；logout 清全表；树缓存按工作区隔离。
// open/close 为纯状态操作（不发网络）；getTreeView 首取后按工作区缓存、内容变更即失效。
// 文件版本由渲染层编辑缓冲自持，main 不做文件内容缓存（次要 5 顺修备案）。
import { describe, expect, it } from "vitest";
import { createOnlineSession, onlineTreeToDto } from "../../../src/main/online/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import type { TokenStore } from "../../../src/main/online/tokenStore.js";

const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const SERVER = "http://127.0.0.1:8080";
const LOGIN_OK = (): Response => json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER });

// path 实体化（2026-09-08）形态：内容 path 首段=项目实体 id（2026-09-09 服务端 BIGINT 化后为
// 数字字符串）；projects 行 = 实体表产出 {id, name, groupId, myRole}（旧 path 目录字段已退役）。
const PID = "101";
const TREE = {
  workspaceId: "ws-1",
  rootVersion: 2,
  files: [
    { path: "apicc.workspace.yaml", hash: "h0", version: 1, size: 10 },
    { path: `${PID}/collections/c/apis/a/api.yaml`, hash: "h1", version: 2, size: 20 },
  ],
  projects: [{ id: PID, name: "p", groupId: "201", myRole: "EDITOR" as const }],
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
    // /tree 按请求 URL 回显 workspaceId（表语义：多工作区各自的树可辨别）
    const wsMatch = req.url.match(/workspaces\/([^/?]+)\/tree/);
    const wsId = wsMatch ? decodeURIComponent(wsMatch[1]!) : tree.workspaceId;
    if (req.url.endsWith("/tree")) return json(200, { ...tree, workspaceId: wsId });
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
const WS2 = { workspaceId: "ws-2", name: "另一空间", myRole: "VIEWER" as const };
const treeCalls = (calls: CapturedRequest[]) => calls.filter((c) => c.url.endsWith("/tree")).length;

describe("online session 工作区会话表（计划 C 任务 1）", () => {
  it("openWorkspace 入表并置活跃（不发网络）；getTreeView 首取服务端树并映射 DTO + 项目角色，树缓存生效（第二次不再发 /tree）", async () => {
    const { session, calls } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    expect(session.workspace).toEqual({ id: "ws-1", name: "团队空间", myRole: "EDITOR" });
    expect(treeCalls(calls)).toBe(0);
    const view = await session.getTreeView("ws-1");
    expect(view.workspaceId).toBe("ws-1");
    expect(view.name).toBe("团队空间");
    expect(view.myRole).toBe("EDITOR");
    expect(view.projects).toEqual(TREE.projects);
    expect(view.tree).toEqual(onlineTreeToDto(TREE, "团队空间"));
    expect(view.tree.label).toBe("团队空间");
    // 缓存：第二次 getTreeView 不重发 /tree 请求
    await session.getTreeView("ws-1");
    expect(treeCalls(calls)).toBe(1);
  });

  it("双工作区驻留：open 第二个工作区不清第一个——树缓存按工作区隔离，activate 来回切换各自命中缓存", async () => {
    const { session, calls } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    const view1 = await session.getTreeView("ws-1");
    session.openWorkspace(WS2);
    const view2 = await session.getTreeView("ws-2");
    expect(treeCalls(calls)).toBe(2); // 各工作区首取一次
    // ws-1 驻留未被覆盖（open 不再是覆盖式单槽）：切回后缓存命中、树内容按工作区隔离
    session.activateWorkspace("ws-1");
    const view1Again = await session.getTreeView("ws-1");
    expect(treeCalls(calls)).toBe(2);
    expect(view1Again).toEqual(view1);
    expect(view1Again.tree.id).toBe("ws-1");
    session.activateWorkspace("ws-2");
    expect(await session.getTreeView("ws-2")).toEqual(view2);
    expect(treeCalls(calls)).toBe(2);
  });

  it("requireWorkspace 仍限活跃工作区：驻留但非活跃的 id 取视图拒绝「尚未打开在线工作区」（防跨工作区误写）", async () => {
    const { session } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    session.openWorkspace(WS2);
    // ws-1 仍驻留但非活跃：视图请求拒绝（切换只由 activateWorkspace 显式驱动）
    await expect(session.getTreeView("ws-1")).rejects.toThrow(/尚未打开在线工作区/);
    session.activateWorkspace("ws-1");
    await expect(session.getTreeView("ws-2")).rejects.toThrow(/尚未打开在线工作区/);
    expect((await session.getTreeView("ws-1")).workspaceId).toBe("ws-1");
  });

  it("activateWorkspace：表中有且已登录才切活跃；表中无/未登录 → 「尚未打开在线工作区」口径错误", async () => {
    const { session } = setup();
    session.openWorkspace(WS);
    // 未登录：即使表中已有也不切（激活前提 = 登录态 + 驻留）
    expect(() => session.activateWorkspace("ws-1")).toThrow(/尚未打开在线工作区/);
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS2);
    session.activateWorkspace("ws-1"); // 表中有且已登录 → 纯切指针
    expect(session.workspace).toEqual({ id: "ws-1", name: "团队空间", myRole: "EDITOR" });
    expect(() => session.activateWorkspace("ws-404")).toThrow(/尚未打开在线工作区/); // 表中无
  });

  it("closeWorkspace(id) 出表指定工作区：非活跃出表不动活跃指针（不自动切）", async () => {
    const { session, calls } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    await session.getTreeView("ws-1");
    session.openWorkspace(WS2);
    await session.getTreeView("ws-2");
    session.closeWorkspace("ws-1");
    // 活跃指针不动：仍是 ws-2；ws-1 已出表（activate 拒绝）
    expect(session.workspace).toEqual({ id: "ws-2", name: "另一空间", myRole: "VIEWER" });
    expect(() => session.activateWorkspace("ws-1")).toThrow(/尚未打开在线工作区/);
    // ws-2 的缓存不受影响：视图命中不重发 /tree
    await session.getTreeView("ws-2");
    expect(treeCalls(calls)).toBe(2);
  });

  it("closeWorkspace() 无参关活跃：出表后活跃置 null 且不自动切其他驻留工作区", async () => {
    const { session } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    await session.getTreeView("ws-1");
    session.openWorkspace(WS2);
    await session.getTreeView("ws-2");
    session.closeWorkspace();
    expect(session.workspace).toBeNull();
    // 不自动切：ws-1 仍驻留但活跃为 null，取视图/未显式激活前拒绝
    await expect(session.getTreeView("ws-1")).rejects.toThrow(/尚未打开在线工作区/);
    // ws-1 仍在表中：显式激活后恢复
    session.activateWorkspace("ws-1");
    expect(session.workspace).toEqual({ id: "ws-1", name: "团队空间", myRole: "EDITOR" });
    expect(await session.getTreeView("ws-1")).toBeDefined();
  });

  it("openWorkspace 已驻留工作区：更新 workspaceState 且只清该工作区树缓存（重开重发 /tree，其他工作区缓存保留）", async () => {
    const { session, calls } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    await session.getTreeView("ws-1");
    session.openWorkspace(WS2);
    await session.getTreeView("ws-2");
    expect(treeCalls(calls)).toBe(2);
    // 重开 ws-1（改名）：更新状态 + 清 ws-1 缓存 + 置活跃
    session.openWorkspace({ ...WS, name: "改名空间" });
    expect(session.workspace).toEqual({ id: "ws-1", name: "改名空间", myRole: "EDITOR" });
    const reopened = await session.getTreeView("ws-1");
    expect(reopened.name).toBe("改名空间");
    expect(treeCalls(calls)).toBe(3); // ws-1 缓存被清 → 重发
    // ws-2 缓存保留：切回不重发
    session.activateWorkspace("ws-2");
    await session.getTreeView("ws-2");
    expect(treeCalls(calls)).toBe(3);
  });

  it("logout 清全表：全部驻留工作区出表、活跃指针清空", async () => {
    const { session } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    session.openWorkspace(WS2);
    await session.logout();
    expect(session.workspace).toBeNull();
    await expect(session.getTreeView("ws-1")).rejects.toThrow(/尚未打开在线工作区/);
    expect(() => session.activateWorkspace("ws-1")).toThrow(/尚未打开在线工作区/);
    expect(() => session.activateWorkspace("ws-2")).toThrow(/尚未打开在线工作区/);
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
    expect(treeCalls(calls)).toBe(1);
    // 推送成功 → 树缓存失效，下次取视图重发 /tree
    await session.putFile({ workspaceId: "ws-1", path: `${PID}/collections/c/apis/a/api.yaml`, content: "new", baseVersion: 2 });
    await session.getTreeView("ws-1");
    expect(treeCalls(calls)).toBe(2);
  });

  it("内容变更只失效对应工作区的树缓存：put ws-1 不清 ws-2 缓存（按工作区隔离）", async () => {
    const { session, calls } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    await session.getTreeView("ws-1");
    session.openWorkspace(WS2);
    await session.getTreeView("ws-2");
    expect(treeCalls(calls)).toBe(2);
    await session.putFile({ workspaceId: "ws-1", path: `${PID}/collections/c/apis/a/api.yaml`, content: "new", baseVersion: 2 });
    // ws-1 缓存失效 → 重发；ws-2 缓存保留
    session.activateWorkspace("ws-1");
    await session.getTreeView("ws-1");
    expect(treeCalls(calls)).toBe(3);
    session.activateWorkspace("ws-2");
    await session.getTreeView("ws-2");
    expect(treeCalls(calls)).toBe(3);
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
