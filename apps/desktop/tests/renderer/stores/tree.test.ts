// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isProxy } from "vue";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useTreeStore } from "../../../src/renderer/src/stores/tree.js";
import { localTreeNodeKey } from "../../../src/shared/tree-dto.js";
import { contractAssetFixture } from "../helpers/contract-assets.js";

async function seeded() {
  const api = createMemoryApi();
  const fixture = await contractAssetFixture(api);
  const workspace = useWorkspaceStore(api);
  await workspace.open(fixture.root);
  const tree = useTreeStore(api, workspace);
  return { api, fixture, workspace, tree };
}

describe("tree store", () => {
  it("selects a live API node from workspace Pinia state without cloning its Proxy directly", async () => {
    const { fixture, workspace, tree } = await seeded();
    const project = workspace.findProject(fixture.projectLocator);
    const collection = project?.children.find((node) => node.kind === "collection");
    const node = collection?.children.find((candidate) => candidate.kind === "api" && candidate.id === fixture.apiNode.id);
    if (!node || node.kind !== "api") throw new Error("Fixture API node missing from active workspace store");

    expect(isProxy(node.locator)).toBe(true);
    tree.select(node);
    expect(tree.selected).toEqual({ source: "local", kind: "api", id: node.id, key: node.key, locator: fixture.apiLocator });
  });

  it("selects by source/key/locator and createNode returns the formal created location", async () => {
    const { fixture, workspace, tree } = await seeded();
    tree.select(fixture.apiNode);
    expect(tree.selected).toEqual({ source: "local", kind: "api", id: fixture.apiNode.id,
      key: fixture.apiNode.key, locator: fixture.apiLocator });
    const created = await tree.createNode({ kind: "project", parent: fixture.group.locator, name: "新项目" });
    if (created.kind !== "project") throw new Error("Expected project creation result");
    expect(created).toMatchObject({ kind: "project", source: "local", locator: { ...fixture.group.locator, projectId: expect.any(String) } });
    expect(created.key).toBe(localTreeNodeKey({ source: "local", kind: "project", locator: created.locator }));
    expect(tree.selected?.key).toBe(created.key);
    expect(workspace.findProject(created.locator)?.label).toBe("新项目");
  });

  it("creates an API within a full nested-folder location and refreshes the same source tree", async () => {
    const { api, fixture, workspace, tree } = await seeded();
    const folder = await tree.createNode({ kind: "folder", parent: fixture.collection.locator, name: "文件夹" });
    if (folder.kind !== "folder") throw new Error("Expected folder creation result");
    const created = await tree.createNode({ kind: "api", parent: folder.locator, api: { name: "文件夹内接口" } });
    if (created.kind !== "api") throw new Error("Expected API creation result");
    expect(created.locator.folderIds).toEqual([folder.locator.folderIds[0]]);
    const detail = await api.apiGet(created.locator);
    expect(detail.api.contract.metadata.name).toBe("文件夹内接口");
    const project = workspace.findProject(fixture.projectLocator);
    const collection = project?.children.find((node) => node.kind === "collection");
    if (!collection || collection.kind !== "collection") throw new Error("Fixture collection missing after API create");
    const folderNode = collection.children.find((node) => node.kind === "folder" && node.id === folder.id);
    expect(folderNode?.children?.map((node) => node.id)).toContain(created.id);
  });

  it("rename/delete pass complete NodeLocator values and deletion remains confirm-gated", async () => {
    const { api, fixture, workspace, tree } = await seeded();
    const locator = { kind: "api", locator: fixture.apiLocator } as const;
    await tree.renameNode(locator, "改名后");
    expect((await api.apiGet(fixture.apiLocator)).api.contract.metadata.name).toBe("改名后");
    let asked = false;
    expect(await tree.deleteNode(locator, async (message) => { asked = message === `delete:${fixture.apiLocator.apiId}`; return false; })).toBe(false);
    expect(asked).toBe(true);
    expect(JSON.stringify(workspace.tree)).toContain(fixture.apiLocator.apiId);
    expect(await tree.deleteNode(locator, async () => true)).toBe(true);
    expect(JSON.stringify(workspace.tree)).not.toContain(fixture.apiLocator.apiId);
  });

  it("read-only workspaces reject every tree write", async () => {
    const { tree, workspace, fixture } = await seeded();
    workspace.readOnly = true;
    await expect(tree.createNode({ kind: "project", parent: fixture.group.locator, name: "blocked" })).rejects.toThrow(/只读/);
    await expect(tree.renameNode({ kind: "api", locator: fixture.apiLocator }, "blocked")).rejects.toThrow(/只读/);
  });
});
