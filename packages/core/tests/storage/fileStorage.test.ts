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
});
