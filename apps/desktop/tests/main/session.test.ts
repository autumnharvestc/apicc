import { mkdtempSync } from "node:fs";
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
    s.deleteNode("api", api.id);
    expect(s.locateApi(api.id)).toBeUndefined();
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

  it("renameNode 重命名集合（盘上目录随 save 更新，旧目录清理）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "old-name");
    s.renameNode("collection", c.id, "new-name");
    await s.save();
    const s2 = createSession();
    await s2.open(dir);
    const names = s2.workspace!.groups[0]!.projects[0]!.collections.map((x) => x.name);
    expect(names).toEqual(["new-name"]);
  });
});
