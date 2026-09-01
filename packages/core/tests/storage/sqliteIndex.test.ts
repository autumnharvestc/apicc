import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteIndex } from "../../src/storage/sqliteIndex.js";
import type { Workspace } from "../../src/domain/model.js";

const ws: Workspace = {
  id: "w1", name: "demo", variables: {},
  groups: [{
    id: "g1", name: "g", projects: [{
      id: "p1", name: "p", variables: {},
      environments: [{ id: "e1", name: "dev", variables: {} }],
      collections: [{
        id: "c1", name: "c", variables: {},
        folders: [{
          id: "f1", name: "f",
          apis: [{
            id: "af1", name: "fapi", version: "1", deprecated: false,
            method: "GET", url: "/", headers: [], query: [],
            cases: [{ id: "tf1", name: "fok", scope: "base", parameters: {}, assertions: [] }],
          }],
        }],
        apis: [{
          id: "a1", name: "api", version: "1", deprecated: false,
          method: "GET", url: "/", headers: [], query: [],
          cases: [{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] }],
        }],
      }],
    }],
  }],
};

describe("SqliteIndex", () => {
  it("rebuild 后可按 id 与 type 查询，path 为相对工作区根的完整路径", () => {
    const db = join(mkdtempSync(join(tmpdir(), "apicc-idx-")), "index.db");
    const idx = new SqliteIndex(db);
    idx.rebuild(ws);
    expect(idx.byId("a1")?.type).toBe("api");
    expect(idx.byId("t1")?.parentId).toBe("a1");
    expect(idx.byId("a1")?.path).toBe(join("groups", "g", "projects", "p", "collections", "c", "apis", "api"));
    expect(idx.byId("t1")?.path).toBe(join("groups", "g", "projects", "p", "collections", "c", "apis", "api", "cases", "ok"));
    expect(idx.byId("e1")?.path).toBe(join("groups", "g", "projects", "p", "environments", "dev.yaml"));
    // folder 层级：folder 行入索引且归属 collection，folder 内接口与用例同样入索引
    expect(idx.byType("folder")).toHaveLength(1);
    expect(idx.byId("f1")?.parentId).toBe("c1");
    expect(idx.byId("f1")?.path).toBe(join("groups", "g", "projects", "p", "collections", "c", "folders", "f"));
    expect(idx.byId("af1")?.parentId).toBe("f1");
    expect(idx.byId("af1")?.path).toBe(join("groups", "g", "projects", "p", "collections", "c", "folders", "f", "apis", "fapi"));
    expect(idx.byId("tf1")?.parentId).toBe("af1");
    expect(idx.byId("tf1")?.path).toBe(join("groups", "g", "projects", "p", "collections", "c", "folders", "f", "apis", "fapi", "cases", "fok"));
    expect(idx.byType("api")).toHaveLength(2);
    expect(idx.byType("case")).toHaveLength(2);
    idx.close();
  });

  it("重复 rebuild 幂等", () => {
    const db = join(mkdtempSync(join(tmpdir(), "apicc-idx-")), "index.db");
    const idx = new SqliteIndex(db);
    idx.rebuild(ws);
    idx.rebuild(ws);
    expect(idx.byType("case")).toHaveLength(2);
    idx.close();
  });
});
