// M3-B 任务 3：online 工作区/迁移新频道接线——online:workspace:open（打开即取树映射，
// stress 清理链同 ws:open）、online:workspace:close、online:tree:view（树缓存）、
// online:migrate:scan / online:migrate:write（本地目录扫描与落盘）。
// 以及裁定 E 互斥：ws:create / ws:open（含失败路径）必须先关闭在线工作区会话。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import type { OnlineClient } from "../../../src/main/online/client.js";
import type { TokenStore } from "../../../src/main/online/tokenStore.js";
import { hashContent } from "../../../src/main/online/migrate.js";

const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const USER = { id: "u-1", username: "alice", displayName: "Alice" };
const TREE = {
  workspaceId: "ws-1",
  rootVersion: 1,
  files: [{ path: "groups/g/projects/p/collections/c/apis/a/api.yaml", hash: "h1", version: 1, size: 2 }],
  projects: [{ id: "p-1", name: "p", path: "groups/g/projects/p", myRole: "EDITOR" as const }],
};

function setup(handler: (url: string, method: string) => Response) {
  const calls: Array<{ url: string; method: string }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    return handler(url, method);
  };
  const memory = new Map<string, string>();
  const tokenStore: TokenStore = {
    save: (baseUrl, token) => void memory.set(baseUrl, token),
    load: (baseUrl) => memory.get(baseUrl) ?? null,
    clear: (baseUrl) => void memory.delete(baseUrl),
  };
  const deps = createIpcDeps({
    session: createSession(),
    pickDirectory: async () => "",
    saveFile: async () => "",
    online: {
      createClient: (baseUrl, hooks): OnlineClient =>
        createOnlineClient({ baseUrl, fetch: impl, timeoutMs: 5_000, onUnauthorized: hooks.onUnauthorized }),
      tokenStore,
    },
  });
  return { deps, calls };
}

async function loginAndOpen(deps: ReturnType<typeof setup>["deps"], tree = TREE) {
  await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
  return deps.handle("online:workspace:open", {}, { workspaceId: tree.workspaceId, name: "团队空间", myRole: "EDITOR" });
}

describe("online:workspace:open / online:tree:view（裁定 A/E）", () => {
  it("打开在线工作区：记录状态、取树并映射 DTO（root label = 工作区名，projects 透传）", async () => {
    const { deps, calls } = setup((url) => (url.endsWith("/auth/login") ? json(200, { token: "tok", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, TREE)));
    const view = (await loginAndOpen(deps)) as { workspaceId: string; name: string; myRole: string; projects: unknown[]; tree: { kind: string; label: string } };
    expect(view.workspaceId).toBe("ws-1");
    expect(view.name).toBe("团队空间");
    expect(view.myRole).toBe("EDITOR");
    expect(view.projects).toEqual(TREE.projects);
    expect(view.tree.kind).toBe("root");
    expect(view.tree.label).toBe("团队空间");
    expect(calls.filter((c) => c.url.endsWith("/tree"))).toHaveLength(1);
  });

  it("树缓存：open 后 tree:view 复用会话缓存，不重发 /tree", async () => {
    const { deps, calls } = setup((url) => (url.endsWith("/auth/login") ? json(200, { token: "tok", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, TREE)));
    await loginAndOpen(deps);
    const treeCalls = calls.filter((c) => c.url.endsWith("/tree")).length;
    await deps.handle("online:tree:view", {}, { workspaceId: "ws-1" });
    expect(calls.filter((c) => c.url.endsWith("/tree"))).toHaveLength(treeCalls);
  });

  it("未打开在线工作区 → tree:view 可读错误；close 后同样拒绝", async () => {
    const { deps } = setup((url) => (url.endsWith("/auth/login") ? json(200, { token: "tok", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, TREE)));
    await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    await expect(deps.handle("online:tree:view", {}, { workspaceId: "ws-1" })).rejects.toThrow(/尚未打开在线工作区/);
    await loginAndOpen(deps);
    await deps.handle("online:workspace:close", {});
    await expect(deps.handle("online:tree:view", {}, { workspaceId: "ws-1" })).rejects.toThrow(/尚未打开在线工作区/);
  });

  it("树取回失败（网络错误）→ 不残留半开会话：closeWorkspace 已随失败清理", async () => {
    const { deps } = setup((url) => {
      if (url.endsWith("/auth/login")) return json(200, { token: "tok", expiresAt: "2026-10-03T00:00:00Z", user: USER });
      if (url.endsWith("/tree")) throw new TypeError("fetch failed");
      return json(200, USER);
    });
    await expect(loginAndOpen(deps)).rejects.toThrow(/network_error|fetch failed/);
    // 失败后会话已关：重新取视图必须先重新 open（不残留半开会话）
    await expect(deps.handle("online:tree:view", {}, { workspaceId: "ws-1" })).rejects.toThrow(/尚未打开在线工作区/);
  });
});

describe("online:migrate:scan / online:migrate:write（裁定 D 本地面）", () => {
  it("scan 返回相对 / 路径 + hash + 内容；跳过 .apicc/.git", async () => {
    const { deps } = setup(() => json(200, []));
    const root = mkdtempSync(join(tmpdir(), "apicc-ipc-scan-"));
    try {
      mkdirSync(join(root, "groups", "g"), { recursive: true });
      mkdirSync(join(root, ".apicc"), { recursive: true });
      writeFileSync(join(root, "groups", "g", "api.yaml"), "method: GET\n", "utf8");
      writeFileSync(join(root, ".apicc", "x.json"), "{}", "utf8");
      const result = (await deps.handle("online:migrate:scan", {}, { dir: root })) as {
        files: Array<{ path: string; hash: string; content: string }>;
      };
      expect(result.files).toEqual([{ path: "groups/g/api.yaml", hash: hashContent("method: GET\n"), content: "method: GET\n" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("write 逐文件落盘（建父目录）；越界路径（..）入参校验拒绝", async () => {
    const { deps } = setup(() => json(200, []));
    const root = mkdtempSync(join(tmpdir(), "apicc-ipc-write-"));
    try {
      const result = (await deps.handle("online:migrate:write", {}, {
        dir: root,
        files: [{ path: "groups/g/api.yaml", content: "method: POST\n" }],
      })) as { written: string[] };
      expect(result.written).toEqual(["groups/g/api.yaml"]);
      expect(readFileSync(join(root, "groups", "g", "api.yaml"), "utf8")).toBe("method: POST\n");
      await expect(
        deps.handle("online:migrate:write", {}, { dir: root, files: [{ path: "../evil.yaml", content: "x" }] }),
      ).rejects.toThrow(/入参校验失败/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("模式互斥（裁定 E）：本地 ws:create / ws:open 复用既有清理链关闭在线工作区", () => {
  it("ws:create 成功路径：在线工作区被关闭（tree:view 拒绝）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-mutex-"));
    const other = mkdtempSync(join(tmpdir(), "apicc-mutex-"));
    try {
      const { deps } = setup((url) => (url.endsWith("/auth/login") ? json(200, { token: "tok", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, TREE)));
      await loginAndOpen(deps);
      await deps.handle("ws:create", {}, other, "本地工作区");
      await expect(deps.handle("online:tree:view", {}, { workspaceId: "ws-1" })).rejects.toThrow(/尚未打开在线工作区/);
      void dir;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("ws:create 失败路径（目录已是工作区）：清理链先行，在线工作区仍被关闭", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-mutex-"));
    try {
      const { deps } = setup((url) => (url.endsWith("/auth/login") ? json(200, { token: "tok", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, TREE)));
      await deps.handle("ws:create", {}, dir, "本地工作区");
      await loginAndOpen(deps);
      await expect(deps.handle("ws:create", {}, dir, "再次创建")).rejects.toThrow(/目录已是工作区/);
      await expect(deps.handle("online:tree:view", {}, { workspaceId: "ws-1" })).rejects.toThrow(/尚未打开在线工作区/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
