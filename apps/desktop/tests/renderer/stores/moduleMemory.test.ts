// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useModuleMemoryStore } from "../../../src/renderer/src/stores/moduleMemory.js";
import type { ApiLocator, ProjectLocator } from "../../../src/shared/locations.js";

const first: ProjectLocator = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  groupId: "10000000-0000-4000-8000-000000000002",
  projectId: "10000000-0000-4000-8000-000000000004",
};
const second: ProjectLocator = { ...first, groupId: "10000000-0000-4000-8000-000000000003" };
const firstApi: ApiLocator = { ...first, collectionId: "10000000-0000-4000-8000-000000000005", folderIds: [], apiId: "10000000-0000-4000-8000-000000000006" };
const secondApi: ApiLocator = { ...second, collectionId: firstApi.collectionId, folderIds: [], apiId: firstApi.apiId };

afterEach(() => localStorage.clear());

describe("module memory local identity", () => {
  it("restores tree expansion and selected API only for the same root and full project locator", () => {
    const memory = useModuleMemoryStore();
    memory.activateProject("C:/workspace-a", first);
    memory.apiTree.expanded = [JSON.stringify(["local", "collection", first.workspaceId, first.groupId, first.projectId, "collection-a"])];
    memory.apiTree.lastApiLocator = firstApi;
    memory.test.apiLocator = firstApi;
    memory.touch();

    memory.activateProject("C:/workspace-a", second);
    expect(memory.apiTree.expanded).toEqual([]);
    expect(memory.apiTree.lastApiLocator).toBeNull();
    expect(memory.test.apiLocator).toBeNull();
    memory.apiTree.lastApiLocator = secondApi;
    memory.test.apiLocator = secondApi;
    memory.touch();

    memory.activateProject("C:/workspace-b", first);
    expect(memory.apiTree.lastApiLocator).toBeNull();
    memory.activateProject("C:/workspace-a", first);
    expect(memory.apiTree.lastApiLocator).toEqual(firstApi);
    expect(memory.test.apiLocator).toEqual(firstApi);
  });

  it("does not restore legacy id-only module memory", () => {
    localStorage.setItem("apicc.moduleMemory", JSON.stringify({
      apiTree: { expanded: ["api-id"], lastApiId: "api-id" },
      test: { pane: "api-cases", apiId: "api-id" },
    }));
    const memory = useModuleMemoryStore();
    expect(memory.apiTree.expanded).toEqual([]);
    expect(memory.apiTree.lastApiLocator).toBeNull();
    expect(memory.test.apiLocator).toBeNull();
  });
});
