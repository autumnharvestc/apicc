import Database from "better-sqlite3";
import { join } from "node:path";
import type { Workspace } from "../domain/model.js";

interface Row { id: string; type: string; name: string; parentId: string | null; path: string }

/** 可重建的查询缓存（规格 §4）：任何时刻删除 db 文件后由 rebuild 恢复。
 *  path 与 fileStorage 的磁盘布局同口径：相对工作区根的完整路径（目录对象为目录路径，环境/用例为文件路径）。 */
export class SqliteIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, type TEXT, name TEXT, parentId TEXT, path TEXT)",
    );
  }

  rebuild(ws: Workspace): void {
    const insert = this.db.prepare("INSERT OR REPLACE INTO objects VALUES (?, ?, ?, ?, ?)");
    const rows: Row[] = [];
    rows.push({ id: ws.id, type: "workspace", name: ws.name, parentId: null, path: "." });
    for (const g of ws.groups) {
      const gPath = join("groups", g.name);
      rows.push({ id: g.id, type: "group", name: g.name, parentId: ws.id, path: gPath });
      for (const p of g.projects) {
        const pPath = join(gPath, "projects", p.name);
        rows.push({ id: p.id, type: "project", name: p.name, parentId: g.id, path: pPath });
        for (const e of p.environments) {
          rows.push({ id: e.id, type: "environment", name: e.name, parentId: p.id, path: join(pPath, "environments", `${e.name}.yaml`) });
        }
        for (const c of p.collections) {
          const cPath = join(pPath, "collections", c.name);
          rows.push({ id: c.id, type: "collection", name: c.name, parentId: p.id, path: cPath });
          for (const f of c.folders) {
            const fPath = join(cPath, "folders", f.name);
            rows.push({ id: f.id, type: "folder", name: f.name, parentId: c.id, path: fPath });
            for (const api of f.apis) {
              const aPath = join(fPath, "apis", api.name);
              rows.push({ id: api.id, type: "api", name: api.name, parentId: f.id, path: aPath });
              for (const tc of api.cases) {
                rows.push({ id: tc.id, type: "case", name: tc.name, parentId: api.id, path: join(aPath, "cases", tc.name) });
              }
            }
          }
          for (const api of c.apis) {
            const aPath = join(cPath, "apis", api.name);
            rows.push({ id: api.id, type: "api", name: api.name, parentId: c.id, path: aPath });
            for (const tc of api.cases) {
              rows.push({ id: tc.id, type: "case", name: tc.name, parentId: api.id, path: join(aPath, "cases", tc.name) });
            }
          }
        }
      }
    }
    this.db.transaction(() => {
      this.db.exec("DELETE FROM objects");
      for (const r of rows) insert.run(r.id, r.type, r.name, r.parentId, r.path);
    })();
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
