import { describe, expect, it } from "vitest";
import { apiSessionKey, projectSessionKey } from "../../../src/renderer/src/stores/localIdentity.js";
import type { ApiLocator, ProjectLocator } from "../../../src/shared/locations.js";

const project: ProjectLocator = {
  workspaceId: "workspace-a",
  groupId: "group-a",
  projectId: "project-shared",
};

describe("local renderer identity", () => {
  it("projects only the explicit workspace/group/project fields", () => {
    expect(projectSessionKey("C:/one", { ...project, ignored: "must-not-enter-key" } as ProjectLocator & { ignored: string }))
      .toBe('["local","C:/one","workspace-a","group-a","project-shared"]');
  });

  it("distinguishes group and root identity when a project id is reused", () => {
    expect(projectSessionKey("C:/one", project)).not.toBe(projectSessionKey("C:/one", { ...project, groupId: "group-b" }));
    expect(projectSessionKey("C:/one", project)).not.toBe(projectSessionKey("C:/copy", project));
  });

  it("copies and preserves every ordered folder id in an API session key", () => {
    const folderIds = ["folder-a", "folder-b"];
    const locator: ApiLocator = { ...project, collectionId: "collection-a", folderIds, apiId: "api-a" };
    const key = apiSessionKey("C:/one", locator);
    folderIds.reverse();
    expect(key).toBe('["local","C:/one","workspace-a","group-a","project-shared","collection-a",["folder-a","folder-b"],"api-a"]');
    expect(apiSessionKey("C:/one", { ...locator, folderIds: [...locator.folderIds, "folder-c"] })).not.toBe(key);
  });
});
