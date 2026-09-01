import Database from "better-sqlite3";
import { join } from "node:path";
import type { Workspace } from "../domain/model.js";

interface Row { id: string; type: string; name: string; parentId: string | null; path: string }

/** 可重建的查询缓存（规格 §4）：任何时刻删除 db 文件后由 rebuild 恢复。 */
export class SqliteIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, type TEXT, name TEXT, parentId TEXT, path TEXT)",
    );
  }

  rebuild(ws: Workspace, root: string): void {
    const insert = this.db.prepare("INSERT OR REPLACE INTO objects VALUES (?, ?, ?, ?, ?)");
    const rows: Row[] = [];
    rows.push({ id: ws.id, type: "workspace", name: ws.name, parentId: null, path: "." });
    for (const g of ws.groups) {
      rows.push({ id: g.id, type: "group", name: g.name, parentId: ws.id, path: join("groups", g.name) });
      for (const p of g.projects) {
        rows.push({ id: p.id, type: "project", name: p.name, parentId: g.id, path: join("groups", g.name, "projects", p.name) });
        for (const e of p.environments) {
          rows.push({ id: e.id, type: "environment", name: e.name, parentId: p.id, path: join("environments", `${e.name}.yaml`) });
        }
        for (const c of p.collections) {
          rows.push({ id: c.id, type: "collection", name: c.name, parentId: p.id, path: join("collections", c.name) });
          for (const f of c.folders) {
            rows.push({ id: f.id, type: "folder", name: f.name, parentId: c.id, path: join("collections", c.name, f.name) });
          }
          for (const api of c.apis) {
            rows.push({ id: api.id, type: "api", name: api.name, parentId: c.id, path: join("collections", c.name, "apis", api.name) });
            for (const tc of api.cases) {
              rows.push({ id: tc.id, type: "case", name: tc.name, parentId: api.id, path: join("cases", tc.name) });
            }
          }
        }
      }
    }
    this.db.transaction(() => {
      this.db.exec("DELETE FROM objects");
      for (const r of rows) insert.run(r.id, r.type, r.name, r.parentId, r.path);
    })();
    void root;
  }

  byId(id: string): Omit<Row, never> | undefined {
    return this.db.prepare("SELECT id, type, name, parentId, path FROM objects WHERE id = ?").get(id) as Row | undefined;
  }

  byType(type: string): Row[] {
    return this.db.prepare("SELECT id, type, name, parentId, path FROM objects WHERE type = ?").all(type) as Row[];
  }

  close(): void {
    this.db.close();
  }
}
