import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStorage } from "../../src/storage/fileStorage.js";
import { WorkspaceSchema } from "../../src/domain/model.js";
import type { Workspace } from "../../src/domain/model.js";
import type { Workflow } from "../../src/workflow/model.js";

const workspace: Workspace = {
  id: "w1", name: "demo", variables: { region: "cn" },
  groups: [{
    id: "g1", name: "ecommerce",
    projects: [{
      id: "p1", name: "order-service", variables: {},
      workflows: [],
      environments: [{ id: "e1", name: "dev", extends: undefined, variables: { baseUrl: "http://127.0.0.1" } }],
      collections: [{
        id: "c1", name: "order-api", variables: {}, folders: [], apis: [],
      }],
    }],
  }],
};

describe("fileStorage", () => {
  it("save→load roundtrip 保留结构、变量与 id", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    await fileStorage.save(root, workspace);
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(problems).toEqual([]);
    expect(loaded.groups[0]?.projects[0]?.environments[0]?.variables.baseUrl).toBe("http://127.0.0.1");
    expect(loaded.groups[0]?.projects[0]?.collections[0]?.id).toBe("c1");
  });

  it("接口 design.md 与用例环境后缀落盘并读回", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    const ws: Workspace = {
      ...workspace,
      groups: [{
        ...workspace.groups[0]!, projects: [{
          ...workspace.groups[0]!.projects[0]!, collections: [{
            id: "c1", name: "order-api", variables: {}, folders: [],
            apis: [{
              id: "a1", name: "create-order", version: "1.0.0", deprecated: false,
              method: "POST", url: "{{baseUrl}}/orders", headers: [], query: [],
              design: "# 创建订单设计",
              cases: [
                { id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] },
                { id: "t2", name: "ok", scope: "sit", parameters: {}, assertions: [] },
              ],
            }],
          }],
        }],
      }],
    };
    await fileStorage.save(root, ws);
    const { workspace: loaded } = await fileStorage.load(root);
    const api = loaded.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
    expect(api.design).toBe("# 创建订单设计");
    expect(api.cases.map((c) => c.scope).sort()).toEqual(["base", "sit"]);
  });

  it("坏 YAML 隔离为 problem，不阻塞其余加载", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    await fileStorage.save(root, workspace);
    const envFile = join(root, "groups", "ecommerce", "projects", "order-service", "environments", "dev.yaml");
    writeFileSync(envFile, "id: [broken");
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(loaded.groups[0]!.projects[0]!.environments).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe(
      join("groups", "ecommerce", "projects", "order-service", "environments", "dev.yaml"),
    );
  });

  it("缺少 apicc.workspace.yaml 时抛错", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-empty-"));
    await expect(fileStorage.load(root)).rejects.toThrow(/apicc\.workspace\.yaml/);
  });

  it("collection.yaml 未知字段经 zod schema 校验记 problem 并跳过（回归 C2）", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    await fileStorage.save(root, workspace);
    const cFile = join(root, "groups", "ecommerce", "projects", "order-service", "collections", "order-api", "collection.yaml");
    writeFileSync(cFile, "id: c1\nname: order-api\nnonsense: 1\n");
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(loaded.groups[0]!.projects[0]!.collections).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toContain(join("collections", "order-api", "collection.yaml"));
    expect(problems[0]!.message).toContain("nonsense");
  });

  it("collection.yaml 省略可选字段时以 schema 默认值构建域对象（回归 C2）", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    await fileStorage.save(root, workspace);
    const cFile = join(root, "groups", "ecommerce", "projects", "order-service", "collections", "order-api", "collection.yaml");
    writeFileSync(cFile, "id: c1\nname: order-api\n");
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(problems).toEqual([]);
    const collection = loaded.groups[0]!.projects[0]!.collections[0]!;
    expect(collection.variables).toEqual({});
    expect(collection.apis).toEqual([]);
    expect(collection.folders).toEqual([]);
  });

  it("api.yaml 带未知字段同样记 problem（schema 校验覆盖全部文件类型）", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    await fileStorage.save(root, workspace);
    const apiDir = join(root, "groups", "ecommerce", "projects", "order-service", "collections", "order-api", "apis", "a1");
    mkdirSync(join(apiDir, "cases"), { recursive: true });
    writeFileSync(join(apiDir, "api.yaml"), "id: a1\nname: broken-api\nmethod: GET\nurl: /\nspellingMistake: true\n");
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(loaded.groups[0]!.projects[0]!.collections[0]!.apis).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("spellingMistake");
  });

  it("workspace.yaml 自身 schema 失败保持抛错语义", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    await fileStorage.save(root, workspace);
    writeFileSync(join(root, "apicc.workspace.yaml"), "id: w1\nname: demo\nbogus: 1\n");
    await expect(fileStorage.load(root)).rejects.toThrow(/apicc\.workspace\.yaml/);
  });

  it("collections 下缺 collection.yaml 的子目录记 problem（回归 I1，与 apis 孤儿目录语义对齐）", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    await fileStorage.save(root, workspace);
    mkdirSync(join(root, "groups", "ecommerce", "projects", "order-service", "collections", "orphan"));
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(loaded.groups[0]!.projects[0]!.collections.map((c) => c.name)).toEqual(["order-api"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toContain(join("collections", "orphan", "collection.yaml"));
    expect(problems[0]!.message).toContain("缺少 collection.yaml");
  });

  it("folder 层级落盘并读回（folder 内 api 的用例与设计完整保留）", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    const ws: Workspace = {
      ...workspace,
      groups: [{
        ...workspace.groups[0]!, projects: [{
          ...workspace.groups[0]!.projects[0]!, collections: [{
            id: "c1", name: "order-api", variables: {},
            folders: [{
              id: "f1", name: "支付", apis: [{
                id: "a2", name: "pay-order", version: "1.0.0", deprecated: false,
                method: "POST", url: "{{baseUrl}}/pay", headers: [], query: [],
                design: "# 支付设计",
                cases: [
                  { id: "t3", name: "ok", scope: "base", parameters: {}, assertions: [] },
                  { id: "t4", name: "ok", scope: "sit", parameters: {}, assertions: [] },
                ],
              }],
            }],
            apis: [],
          }],
        }],
      }],
    };
    await fileStorage.save(root, ws);
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(problems).toEqual([]);
    const collection = loaded.groups[0]!.projects[0]!.collections[0]!;
    expect(collection.folders[0]!.id).toBe("f1");
    expect(collection.folders[0]!.name).toBe("支付");
    const api = collection.folders[0]!.apis[0]!;
    expect(api.id).toBe("a2");
    expect(api.design).toBe("# 支付设计");
    expect(api.cases.map((c) => c.scope).sort()).toEqual(["base", "sit"]);
  });

  it("folder.yaml 坏文件隔离为 problem，不阻塞其余加载", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    const ws: Workspace = {
      ...workspace,
      groups: [{
        ...workspace.groups[0]!, projects: [{
          ...workspace.groups[0]!.projects[0]!, collections: [{
            id: "c1", name: "order-api", variables: {},
            folders: [{ id: "f1", name: "支付", apis: [] }],
            apis: [],
          }],
        }],
      }],
    };
    await fileStorage.save(root, ws);
    const folderFile = join(root, "groups", "ecommerce", "projects", "order-service",
      "collections", "order-api", "folders", "支付", "folder.yaml");
    writeFileSync(folderFile, "id: [broken");
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(loaded.groups[0]!.projects[0]!.collections[0]!.folders).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe(
      join("groups", "ecommerce", "projects", "order-service", "collections", "order-api", "folders", "支付", "folder.yaml"),
    );
  });

  it("目录枚举按名称字典序排序，与创建顺序无关", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    const ws: Workspace = {
      ...workspace,
      groups: [{
        ...workspace.groups[0]!, projects: [{
          ...workspace.groups[0]!.projects[0]!,
          environments: [
            { id: "e2", name: "zeta", extends: undefined, variables: {} },
            { id: "e1", name: "alpha", extends: undefined, variables: {} },
          ],
          collections: [
            { id: "c2", name: "zeta-api", variables: {}, folders: [], apis: [] },
            { id: "c1", name: "alpha-api", variables: {}, folders: [], apis: [] },
          ],
        }],
      }],
    };
    await fileStorage.save(root, ws);
    const { workspace: loaded } = await fileStorage.load(root);
    const project = loaded.groups[0]!.projects[0]!;
    expect(project.environments.map((e) => e.name)).toEqual(["alpha", "zeta"]);
    expect(project.collections.map((c) => c.name)).toEqual(["alpha-api", "zeta-api"]);
  });

  it("缺少 api.yaml 的孤儿 api 目录记 problem 而非静默丢弃", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    await fileStorage.save(root, workspace);
    const orphanDir = join(root, "groups", "ecommerce", "projects", "order-service",
      "collections", "order-api", "apis", "orphan");
    mkdirSync(join(orphanDir, "cases"), { recursive: true });
    writeFileSync(join(orphanDir, "cases", "x.yaml"), "id: t1");
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(loaded.groups[0]!.projects[0]!.collections[0]!.apis).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe(
      join("groups", "ecommerce", "projects", "order-service", "collections", "order-api", "apis", "orphan", "api.yaml"),
    );
    expect(problems[0]!.message).toContain("api.yaml");
    expect(problems[0]!.message).toContain("跳过");
  });

  it("全字段 save→load 深等价（toEqual + strict parse）", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    const ws: Workspace = {
      id: "w1", name: "demo", variables: { region: "cn", env: "prod" },
      globals: { variables: { global: "1" }, query: [{ key: "q", value: "1", enabled: true }], headers: [{ key: "h", value: "1", enabled: true }] },
      groups: [{
        id: "g1", name: "ecommerce",
        projects: [{
          id: "p1", name: "order-service", variables: { timeoutMs: "3000" },
          workflows: [],
          environments: [
            { id: "e1", name: "dev", extends: undefined, variables: { baseUrl: "http://127.0.0.1" }, baseUrls: { c1: "http://b1" } },
            { id: "e2", name: "sit", extends: "dev", variables: { baseUrl: "http://sit.example" }, baseUrls: {} },
          ],
          collections: [{
            id: "c1", name: "order-api", variables: { pageSize: "20" },
            scripts: { pre: "pm.variables.set('k','v')", post: "pm.assert(true,'ok')" },
            folders: [{
              id: "f1", name: "支付", apis: [{
                id: "a2", name: "pay-order", version: "1.0.0", deprecated: false,
                method: "POST", protocol: "http", url: "{{baseUrl}}/pay",
                headers: [{ key: "X-Sign", value: "s", enabled: true }],
                query: [], body: { kind: "json", content: '{"oid":"1"}' },
                auth: { type: "bearer", token: "tk", placement: "header" },
                design: "# 支付设计",
                cases: [{
                  id: "t3", name: "ok", scope: "base", parameters: { oid: "1" },
                  dataDriver: { sourcePath: "d.csv", format: "csv" },
                  preScript: "pm.variables.set('x','1')", postScript: "pm.assert(true,'y')",
                  assertions: [{ id: "as1", target: "status", op: "eq", expected: "200" }],
                }],
              }],
            }],
            apis: [{
              id: "a1", name: "create-order", version: "1.2.3", deprecated: true,
              method: "POST", protocol: "http", url: "{{baseUrl}}/orders",
              headers: [{ key: "X-Trace", value: "t-1", enabled: true }],
              query: [{ key: "dry", value: "1", enabled: false }],
              body: { kind: "json", content: '{"sku":"A1"}' },
              auth: { type: "bearer", token: "tk", placement: "header" },
              design: "# 创建订单设计",
              cases: [
                { id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] },
                { id: "t2", name: "ok", scope: "sit", parameters: {}, assertions: [] },
              ],
            }],
          }],
        }],
      }],
    };
    await fileStorage.save(root, ws);
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(problems).toEqual([]);
    // toEqual 忽略 undefined 属性 → 语义等价（undefined 字段 vs 缺失字段）
    // 数组顺序由目录名承载（字典序），深比较前按 id 归一，不削弱字段级比较
    const byId = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const norm = (w: Workspace): Workspace => {
      const c = JSON.parse(JSON.stringify(w)) as Workspace;
      for (const g of c.groups) for (const p of g.projects) {
        p.environments = byId(p.environments);
        p.collections = byId(p.collections);
        for (const col of p.collections) {
          col.folders = byId(col.folders);
          for (const f of col.folders) { f.apis = byId(f.apis); for (const a of f.apis) a.cases = byId(a.cases); }
          col.apis = byId(col.apis);
          for (const a of col.apis) a.cases = byId(a.cases);
        }
      }
      return c;
    };
    expect(norm(loaded)).toEqual(norm(ws));
    expect(() => WorkspaceSchema.parse(loaded)).not.toThrow();
  });
});

describe("fileStorage workflows 读写（M2-A）", () => {
  const workflow: Workflow = {
    id: "wf1", name: "下单流程", status: "draft",
    nodes: [{ id: "n1", kind: "request", apiId: "a1", caseId: "c1" }],
    edges: [],
  };

  it("save 落盘 projects/<p>/workflows/<名>/workflow.yaml 并读回", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-wfio-"));
    const ws: Workspace = {
      ...workspace,
      groups: [{
        ...workspace.groups[0]!, projects: [{
          ...workspace.groups[0]!.projects[0]!, workflows: [workflow],
        }],
      }],
    };
    await fileStorage.save(root, ws);
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(problems).toEqual([]);
    const loadedWf = loaded.groups[0]!.projects[0]!.workflows[0]!;
    expect(loadedWf.name).toBe("下单流程");
    expect(loadedWf.nodes).toEqual([{ id: "n1", kind: "request", apiId: "a1", caseId: "c1" }]);
    expect(loadedWf.edges).toEqual([]);
  });

  it("坏 workflow.yaml 隔离为 problem", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-wfio2-"));
    const ws: Workspace = {
      ...workspace,
      groups: [{
        ...workspace.groups[0]!, projects: [{
          ...workspace.groups[0]!.projects[0]!, workflows: [workflow],
        }],
      }],
    };
    await fileStorage.save(root, ws);
    writeFileSync(
      join(root, "groups", "ecommerce", "projects", "order-service", "workflows", "下单流程", "workflow.yaml"),
      "id: [broken",
    );
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(loaded.groups[0]!.projects[0]!.workflows).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe(
      join("groups", "ecommerce", "projects", "order-service", "workflows", "下单流程", "workflow.yaml"),
    );
  });
});
