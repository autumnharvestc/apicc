// @vitest-environment node
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import type { ApiccApi } from "../../../src/shared/types.js";
import { contractAssetFixture } from "../helpers/contract-assets.js";

describe("workspace store", () => {
  it("open 持有工作区名称、完整局部树、revision 与只读状态", async () => {
    const { api, tree } = await contractAssetFixture();
    const store = useWorkspaceStore(api);
    expect(store.opened).toBe(false);

    await store.open("C:/apicc-contract-assets");

    expect(store.opened).toBe(true);
    expect(store.name).toBe(tree.label);
    expect(store.tree?.key).toBe(tree.key);
    expect(store.revision).toBeTruthy();
    expect(store.readOnly).toBe(false);
  });

  it("保留 OpenResult.readOnly/revision；载入问题不推断只读", async () => {
    const { api } = await contractAssetFixture();
    api.problems = [{ file: "broken.yaml", message: "schema 校验失败" }];
    const open = api.wsOpen.bind(api);
    const readonlyApi = {
      ...api,
      wsOpen: async (root: string) => ({ ...await open(root), readOnly: true, revision: "fixture-readonly-revision" }),
    } as ApiccApi;
    const store = useWorkspaceStore(readonlyApi);

    await store.open("C:/apicc-contract-assets");

    expect(store.problems).toHaveLength(1);
    expect(store.readOnly).toBe(true);
    expect(store.revision).toBe("fixture-readonly-revision");
  });

  it("项目策略保存规范化去重且禁用 origin 优先", async () => {
    const { api, projectLocator, project } = await contractAssetFixture();
    const store = useWorkspaceStore(api);
    await store.open("C:/apicc-contract-assets");

    const saved = await store.saveStressPolicy(projectLocator, {
      trustedOrigins: ["HTTPS://Example.COM:443/", "https://example.com"],
      deniedOrigins: ["https://EXAMPLE.com/"],
      maxConcurrency: 2,
      maxRps: 5,
    });

    expect(saved.trustedOrigins).toEqual([]);
    expect(saved.deniedOrigins).toEqual(["https://example.com"]);
    expect(saved.maxConcurrency).toBe(2);
    expect(store.findProject(projectLocator)?.id).toBe(project.id);
    expect(store.findProject(projectLocator)?.stressPolicy).toEqual(saved);
  });

  it("API 所属项目按完整 locator 且恰好唯一：未命中/碰撞均拒绝", async () => {
    const { api, tree, apiLocator, projectLocator } = await contractAssetFixture();
    const store = useWorkspaceStore(api);
    await store.open("C:/apicc-contract-assets");

    expect(store.projectLocatorForApi({ ...apiLocator, apiId: "00000000-0000-4000-8000-000000000001" })).toBeNull();
    expect(store.projectLocatorForApi(apiLocator)).toEqual(projectLocator);

    const duplicate = structuredClone(tree);
    const sourceGroup = duplicate.children.find((node): node is import("../../../src/shared/tree-dto.js").LocalGroupTreeNodeDTO =>
      node.kind === "group" && node.children.some((child) => child.kind === "project"));
    if (!sourceGroup) throw new Error("Fixture group missing");
    // A duplicated API occurrence is ambiguous even when its public locator is identical.
    const secondGroup = structuredClone(sourceGroup);
    duplicate.children.push(secondGroup);
    store.tree = duplicate;
    expect(store.projectLocatorForApi(apiLocator)).toBeNull();
  });
});
