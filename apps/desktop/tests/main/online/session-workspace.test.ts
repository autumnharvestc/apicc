// M3-B 任务 3：online session 工作区状态扩展——当前在线工作区 + 树缓存 + 文件内容缓存
// （plan 任务 3 步骤 2：main/online/session.ts 扩展）。open/close 为纯状态操作（不发网络）；
// getTreeView 取树（缓存：第二次不重发请求）、映射 TreeNodeDTO（裁定 A）；切换/关闭清缓存。
import { describe, expect, it } from "vitest";
import { createOnlineSession, onlineTreeToDto } from "../../../src/main/online/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import type { TokenStore } from "../../../src/main/online/tokenStore.js";

const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const SERVER = "http://127.0.0.1:8080";
const LOGIN_OK = (): Response => json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER });

const TREE = {
  workspaceId: "ws-1",
  rootVersion: 2,
  files: [
    { path: "apicc.workspace.yaml", hash: "h0", version: 1, size: 10 },
    { path: "groups/g/projects/p/collections/c/apis/a/api.yaml", hash: "h1", version: 2, size: 20 },
  ],
  projects: [{ id: "p-1", name: "p", myRole: "EDITOR" as const }],
};

interface CapturedRequest { url: string; method: string; headers: Record<string, string>; body?: unknown }

function setup(tree: typeof TREE = TREE) {
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

  it("文件内容缓存：getFiles 命中入缓存、putFile 成功更新版本；closeWorkspace 清空", async () => {
    const { session, calls } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    const filesCallCount = () => calls.filter((c) => c.url.includes("/files?")).length;
    await session.getFiles({ workspaceId: "ws-1", paths: ["groups/g/projects/p/collections/c/apis/a/api.yaml"] });
    expect(session.getCachedFile("ws-1", "groups/g/projects/p/collections/c/apis/a/api.yaml")).toEqual({
      content: "content-of-groups/g/projects/p/collections/c/apis/a/api.yaml",
      version: 2,
    });
    expect(session.getCachedFile("ws-1", "missing.yaml")).toBeNull();
    // putFile 成功 → 缓存版本随结果更新（后续冲突判定可用最新 baseVersion）
    await session.putFile({ workspaceId: "ws-1", path: "groups/g/projects/p/collections/c/apis/a/api.yaml", content: "new", baseVersion: 2 });
    expect(session.getCachedFile("ws-1", "groups/g/projects/p/collections/c/apis/a/api.yaml")?.version).toBe(99);
    session.closeWorkspace();
    expect(session.getCachedFile("ws-1", "groups/g/projects/p/collections/c/apis/a/api.yaml")).toBeNull();
    expect(filesCallCount()).toBe(1);
  });

  it("内容变更使树缓存失效：putFile 成功后 getTreeView 重发 /tree（新 hash/新文件可见）", async () => {
    const { session, calls } = setup();
    await session.login({ baseUrl: SERVER, username: "alice", password: "password8" });
    session.openWorkspace(WS);
    await session.getTreeView("ws-1");
    await session.getTreeView("ws-1"); // 缓存命中：/tree 仍只发过 1 次
    expect(calls.filter((c) => c.url.endsWith("/tree"))).toHaveLength(1);
    // 推送成功 → 树缓存失效，下次取视图重发 /tree
    await session.putFile({ workspaceId: "ws-1", path: "groups/g/projects/p/collections/c/apis/a/api.yaml", content: "new", baseVersion: 2 });
    await session.getTreeView("ws-1");
    expect(calls.filter((c) => c.url.endsWith("/tree"))).toHaveLength(2);
  });

  it("未登录时 openWorkspace 可记录状态，但 getTreeView 抛「尚未登录」（内容 API 需 token）", async () => {
    const { session } = setup();
    session.openWorkspace(WS);
    expect(session.workspace).toEqual({ id: "ws-1", name: "团队空间", myRole: "EDITOR" });
    await expect(session.getTreeView("ws-1")).rejects.toThrow(/尚未登录/);
  });
});
