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
      id: "p1", name: "p", variables: {}, environments: [],
      collections: [{
        id: "c1", name: "c", variables: {}, folders: [],
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
  it("rebuild 后可按 id 与 type 查询", () => {
    const db = join(mkdtempSync(join(tmpdir(), "apicc-idx-")), "index.db");
    const idx = new SqliteIndex(db);
    idx.rebuild(ws, "/ws");
    expect(idx.byId("a1")?.type).toBe("api");
    expect(idx.byId("t1")?.parentId).toBe("a1");
    expect(idx.byType("api")).toHaveLength(1);
    idx.close();
  });

  it("重复 rebuild 幂等", () => {
    const db = join(mkdtempSync(join(tmpdir(), "apicc-idx-")), "index.db");
    const idx = new SqliteIndex(db);
    idx.rebuild(ws, "/ws");
    idx.rebuild(ws, "/ws");
    expect(idx.byType("case")).toHaveLength(1);
    idx.close();
  });
});
