import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSession } from "../../src/main/session.js";

const root = () => mkdtempSync(join(tmpdir(), "apicc-ui-"));

describe("createSession", () => {
  it("create 建立最小工作区并 open 读回", async () => {
    const s = createSession();
    const dir = root();
    const created = await s.create(dir, "演示");
    expect(created.workspace.name).toBe("演示");
    const opened = await s.open(dir);
    expect(opened.workspace.groups).toEqual([]);
    expect(s.root).toBe(dir);
  });

  it("未打开时 locate 抛错；open 后可经路径定位接口", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g1");
    const p = s.createProject(g.id, "p1");
    const c = s.createCollection(p.id, "c1");
    const api = s.createApi(c.id, null, { name: "ping", method: "GET", url: "{{baseUrl}}/x" });
    const found = s.locateApi(api.id);
    expect(found?.collection.id).toBe(c.id);
    expect(found?.project.id).toBe(p.id);
    expect(s.locateApi("missing")).toBeUndefined();
    const s2 = createSession();
    expect(() => s2.locateApi(api.id)).toThrow(/未打开/);
  });

  it("createApi 附带基座冒烟用例；delete 级联删除接口", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "c");
    const api = s.createApi(c.id, null, { name: "a", method: "POST", url: "/" });
    expect(api.cases).toHaveLength(1);
    expect(api.cases[0]!.scope).toBe("base");
    await s.save();
    const apiDir = join(dir, "groups", "g", "projects", "p", "collections", "c", "apis", "a");
    expect(existsSync(apiDir)).toBe(true);
    s.deleteNode("api", api.id);
    await s.save();
    expect(s.locateApi(api.id)).toBeUndefined();
    const s2 = createSession();
    await s2.open(dir);
    expect(existsSync(apiDir)).toBe(false);
  });

  it("saveApi 更新接口并落盘（重开读回验证）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "c");
    const api = s.createApi(c.id, null, { name: "a", method: "GET", url: "/x" });
    api.url = "/changed";
    await s.saveApi(api);
    const s2 = createSession();
    const reopened = await s2.open(dir);
    const found = s2.locateApi(api.id);
    expect(found?.api.url).toBe("/changed");
    expect(reopened.workspace.groups).toHaveLength(1);
  });

  it("deleteNode group 未命中时抛「未找到」（与 memory 契约对齐，宽审查 I3）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    expect(() => s.deleteNode("group", "不存在")).toThrow(/未找到/);
  });

  it("createEnvironment 派生环境并继承父变量；setEnvironmentVariables 覆盖", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    p.environments.push({ id: "e-dev", name: "dev", variables: { baseUrl: "http://d", token: "t" } });
    const env = s.createEnvironment(p.id, { name: "sit", extends: "dev" });
    await s.save();
    const s2 = createSession();
    await s2.open(dir);
    const sit = s2.workspace!.groups[0]!.projects[0]!.environments.find((e) => e.name === "sit")!;
    expect(sit.extends).toBe("dev");
    await s2.setEnvironmentVariables(sit.id, { baseUrl: "http://s" });
    // 简报修正：session 变更操作不自动落盘（承重语义备忘，IPC 层显式 save），
    // 重开读回前须显式 save——与本文件 renameNode 用例的既有模式一致。
    await s2.save();
    const reopened = createSession();
    await reopened.open(dir);
    const sitVars = reopened.workspace!.groups[0]!.projects[0]!.environments.find((e) => e.name === "sit")!.variables;
    expect(sitVars).toEqual({ baseUrl: "http://s" });
    expect(env.name).toBe("sit");
  });

  it("renameWorkflow 改名后旧目录清理、新目录可读", async () => {
    // 简报骨架：建 g/p/workflow("旧名") → save（断言旧目录存在）→ renameWorkflow → save
    // → 重开断言 workflows[0].name === "新名" 且 join(root, ..., "workflows", "旧名") 不存在。
    // 盘上名刻意用中文（产品常态输入）：清理走 node:fs/promises rm——本机（Windows+Node24）
    // 实测 rmSync 对非 ASCII 路径静默失效/硬崩，此用例同时钉住该修复不回退到 rmSync。
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const wf = s.createWorkflow(p.id, "旧名");
    await s.save();
    const oldDir = join(dir, "groups", "g", "projects", "p", "workflows", "旧名");
    expect(existsSync(oldDir)).toBe(true);
    await s.renameWorkflow(wf.id, "新名");
    expect(existsSync(oldDir)).toBe(false);
    // 同项目重名拒绝（与 createWorkflow 同文案）：wf 已改名后，另一条流不得再改成「新名」
    const other = s.createWorkflow(p.id, "另一条流");
    await s.save();
    await expect(s.renameWorkflow(other.id, "新名")).rejects.toThrow(/工作流已存在: 新名/);
    expect(s.locateWorkflow(other.id)?.workflow.name).toBe("另一条流");
    const s2 = createSession();
    const reopened = await s2.open(dir);
    // 重开读回：改名已持久化（按 id 取，不依赖盘上目录的字典序）
    const reopenedWfs = reopened.workspace.groups[0]!.projects[0]!.workflows;
    expect(reopenedWfs.find((w) => w.id === wf.id)!.name).toBe("新名");
    expect(existsSync(join(dir, "groups", "g", "projects", "p", "workflows", "新名"))).toBe(true);
    expect(s2.locateWorkflow(wf.id)?.workflow.name).toBe("新名");
  });

  it("cleanupOrphanDirs 清理已删除工作流的残留目录", async () => {
    // 简报骨架：save 含 wf → 内存 deleteWorkflow → save → 旧目录不存在（中文盘上名同上）
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const wf = s.createWorkflow(p.id, "残留流");
    await s.save();
    const wfDir = join(dir, "groups", "g", "projects", "p", "workflows", "残留流");
    expect(existsSync(wfDir)).toBe(true);
    s.deleteWorkflow(wf.id);
    await s.save();
    expect(existsSync(wfDir)).toBe(false);
    expect(s.locateWorkflow(wf.id)).toBeUndefined();
  });

  it("renameNode 重命名集合（盘上目录随 save 更新，旧目录清理）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "old-name");
    await s.save();
    const oldDir = join(dir, "groups", "g", "projects", "p", "collections", "old-name");
    expect(existsSync(oldDir)).toBe(true);
    s.renameNode("collection", c.id, "new-name");
    await s.save();
    const s2 = createSession();
    await s2.open(dir);
    const names = s2.workspace!.groups[0]!.projects[0]!.collections.map((x) => x.name);
    expect(names).toEqual(["new-name"]);
    expect(existsSync(oldDir)).toBe(false);
  });
});
