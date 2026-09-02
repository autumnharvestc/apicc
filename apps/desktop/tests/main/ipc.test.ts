import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "apicc-ipc-"));
  const session = createSession();
  const deps = createIpcDeps({ session, pickDirectory: async () => dir });
  return { deps, dir };
}

describe("IPC 处理器", () => {
  it("ws:create → tree:get → node:create → api:get 全链路", async () => {
    const { deps, dir } = setup();
    const opened = await deps.handle("ws:create", {}, dir, "演示");
    expect(opened.workspace.name).toBe("演示");
    let tree = await deps.handle("tree:get", {});
    expect(tree.children).toEqual([]);
    const group = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const project = await deps.handle("node:create", {}, { kind: "project", parentId: group.id, name: "p" });
    const collection = await deps.handle("node:create", {}, { kind: "collection", parentId: project.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: collection.id, name: "a", method: "GET", url: "/" });
    // 契约收紧（宽审查 I2）：node:create 返回统一瘦 DTO，不再泄漏 url/cases 等原生字段
    expect(group).toEqual({ kind: "group", id: group.id, label: "g" });
    expect(api).toEqual({ kind: "api", id: api.id, label: "a", method: "GET" });
    tree = await deps.handle("tree:get", {});
    const apiNode = tree.children![0]!.children![0]!.children![0]!.children![0]!;
    expect(apiNode.id).toBe(api.id);
    const fetched = await deps.handle("api:get", {}, api.id);
    expect(fetched.api.name).toBe("a");
    expect(fetched.envs).toEqual([]);
  });

  it("folder 内新建接口：parentId 指向文件夹时挂到所属集合的文件夹下", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const group = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const project = await deps.handle("node:create", {}, { kind: "project", parentId: group.id, name: "p" });
    const collection = await deps.handle("node:create", {}, { kind: "collection", parentId: project.id, name: "c" });
    const folder = await deps.handle("node:create", {}, { kind: "folder", parentId: collection.id, name: "f" });
    // 回归背景（宽审查 C1）：parentId 此前被直接当集合 id 传给 createApi，folder 内新建必抛「未找到集合」
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: folder.id, name: "a", method: "GET", url: "/" });
    expect(api.kind).toBe("api");
    const fetched = await deps.handle("api:get", {}, api.id);
    expect(fetched.api.name).toBe("a");
    const tree = await deps.handle("tree:get", {});
    const folderNode = tree.children![0]!.children![0]!.children![0]!.children!.find((n: { kind: string }) => n.kind === "folder")!;
    expect(folderNode.children!.map((c: { id: string }) => c.id)).toContain(api.id);
  });

  it("api:save 持久化并落盘", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "/x" });
    // node:create 只回瘦 DTO（无 url），编辑链路经 api:get 取完整接口本体再保存
    const detail = await deps.handle("api:get", {}, api.id);
    detail.api.url = "/y";
    await deps.handle("api:save", {}, detail.api);
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir });
    await fresh.handle("ws:open", {}, dir);
    const fetched = await fresh.handle("api:get", {}, api.id);
    expect(fetched.api.url).toBe("/y");
  });

  it("env:create 返回环境对象并落盘；env:vars:save 保存变量后重开读回", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    // env:create → 返回环境对象；处理器显式 save 落盘（session 变更操作不自动落盘）
    const env = await deps.handle("env:create", {}, { projectId: p.id, name: "sit", extends: "dev" });
    expect(env).toMatchObject({ name: "sit", extends: "dev", variables: {} });
    expect(env.id).toBeTruthy();
    await expect(deps.handle("env:create", {}, { projectId: "不存在", name: "x" })).rejects.toThrow(/未找到项目/);
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir });
    await fresh.handle("ws:open", {}, dir);
    const tree = await fresh.handle("tree:get", {});
    const projectNode = tree.children![0]!.children![0]!;
    expect(projectNode.envs).toEqual([{ id: env.id, name: "sit", extends: "dev", variables: {} }]);
    // env:vars:save → 变量覆盖 + 显式 save 落盘，重开读回验证
    await fresh.handle("env:vars:save", {}, env.id, { baseUrl: "http://s" });
    const rereadSession = createSession();
    const reread = createIpcDeps({ session: rereadSession, pickDirectory: async () => dir });
    await reread.handle("ws:open", {}, dir);
    const sit = rereadSession.workspace!.groups[0]!.projects[0]!.environments[0]!;
    expect(sit.variables).toEqual({ baseUrl: "http://s" });
    expect(sit.extends).toBe("dev");
  });

  it("未打开工作区时 tree:get 抛可读错误", async () => {
    const { deps } = setup();
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => "" });
    await expect(fresh.handle("tree:get", {})).rejects.toThrow(/未打开/);
  });

  it("debug:send 走调试链路", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "http://127.0.0.1:1/" });
    const detail = await deps.handle("api:get", {}, api.id);
    const result = await deps.handle("debug:send", {}, { apiId: api.id, caseId: detail.api.cases[0]!.id, envName: undefined });
    expect(result.outcome.passed).toBe(false);
    expect(result.run.total).toBe(1);
  });
});
