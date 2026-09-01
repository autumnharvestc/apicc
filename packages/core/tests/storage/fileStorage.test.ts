import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStorage } from "../../src/storage/fileStorage.js";
import type { Workspace } from "../../src/domain/model.js";

const workspace: Workspace = {
  id: "w1", name: "demo", variables: { region: "cn" },
  groups: [{
    id: "g1", name: "ecommerce",
    projects: [{
      id: "p1", name: "order-service", variables: {},
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
    expect(problems[0]!.file).toContain("dev.yaml");
  });

  it("缺少 apicc.workspace.yaml 时抛错", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-empty-"));
    await expect(fileStorage.load(root)).rejects.toThrow(/apicc\.workspace\.yaml/);
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
    expect(problems[0]!.file).toContain("folder.yaml");
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
});
