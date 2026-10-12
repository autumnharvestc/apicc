import { describe, expect, it } from "vitest";
import {
  ApiLocatorSchema,
  ApiParentLocatorSchema,
  CaseLocatorSchema,
  CollectionLocatorSchema,
  ComponentLocatorSchema,
  FolderLocatorSchema,
  GroupLocatorSchema,
  ModelLocatorSchema,
  NodeLocatorSchema,
  ProjectLocatorSchema,
  WorkflowLocatorSchema,
  WorkflowImpactLocatorSchema,
  WorkspaceLocatorSchema,
} from "../../src/shared/locations.js";

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  group: "00000000-0000-4000-8000-000000000002",
  project: "00000000-0000-4000-8000-000000000003",
  collection: "00000000-0000-4000-8000-000000000004",
  folder: "00000000-0000-4000-8000-000000000005",
  api: "00000000-0000-4000-8000-000000000006",
  component: "00000000-0000-4000-8000-000000000007",
  environment: "00000000-0000-4000-8000-000000000008",
  model: "00000000-0000-4000-8000-000000000009",
  workflow: "00000000-0000-4000-8000-000000000010",
};

const project = { workspaceId: ids.workspace, groupId: ids.group, projectId: ids.project };
const collection = { ...project, collectionId: ids.collection };

describe("desktop definition locators", () => {
  it("accepts full hierarchy locators and preserves UUID spelling", () => {
    const upperWorkspaceId = "00000000-0000-4000-8000-00000000000A";
    expect(WorkspaceLocatorSchema.parse({ workspaceId: upperWorkspaceId })).toEqual({ workspaceId: upperWorkspaceId });
    expect(GroupLocatorSchema.parse({ workspaceId: ids.workspace, groupId: "00000000-0000-0000-0000-000000000000" }).groupId)
      .toBe("00000000-0000-0000-0000-000000000000");
    expect(ProjectLocatorSchema.parse(project)).toEqual(project);
    expect(CollectionLocatorSchema.parse(collection)).toEqual(collection);
    expect(ModelLocatorSchema.parse({ ...project, modelId: ids.model }).modelId).toBe(ids.model);
    expect(WorkflowLocatorSchema.parse({ ...project, workflowId: ids.workflow }).workflowId).toBe(ids.workflow);
  });

  it("distinguishes collection and nested-folder API parents and preserves every folder ancestor", () => {
    expect(ApiParentLocatorSchema.parse(collection)).toEqual(collection);
    expect(ApiParentLocatorSchema.parse({ ...collection, folderIds: [ids.folder] })).toEqual({ ...collection, folderIds: [ids.folder] });
    const nestedApi = { ...collection, folderIds: [ids.folder, ids.api], apiId: ids.component };
    expect(ApiLocatorSchema.parse(nestedApi)).toEqual(nestedApi);
    expect(FolderLocatorSchema.safeParse({ ...collection, folderIds: [] }).success).toBe(false);
    expect(ApiLocatorSchema.safeParse({ ...collection, folderIds: [ids.folder], apiId: "bad" }).success).toBe(false);
  });

  it("uses strict discriminated node locations and keeps case scope textual", () => {
    const component = {
      kind: "component" as const,
      locator: { ...project, componentKind: "auth" as const, componentId: ids.component },
    };
    expect(ComponentLocatorSchema.parse(component.locator)).toEqual(component.locator);
    expect(NodeLocatorSchema.parse(component)).toEqual(component);
    expect(NodeLocatorSchema.safeParse({ kind: "model", locator: component.locator }).success).toBe(false);
    expect(NodeLocatorSchema.safeParse({ kind: "project", locator: { ...project, extra: true } }).success).toBe(false);
    expect(ComponentLocatorSchema.safeParse({ ...project, componentKind: "secret", componentId: ids.component }).success).toBe(false);
    expect(CaseLocatorSchema.parse({
      ...collection,
      folderIds: [ids.folder],
      apiId: ids.api,
      caseId: "case id/with punctuation",
      scope: "variant:one",
    }).scope).toBe("variant:one");
  });

  it("accepts API-level and logical-case impact queries without physical scope", () => {
    const api = { ...collection, folderIds: [ids.folder], apiId: ids.api };
    expect(WorkflowImpactLocatorSchema.parse(api)).toEqual(api);
    expect(WorkflowImpactLocatorSchema.parse({ ...api, caseId: "case-blue" })).toEqual({ ...api, caseId: "case-blue" });
    expect(WorkflowImpactLocatorSchema.safeParse({ ...api, scope: "blue" }).success).toBe(false);
    expect(WorkflowImpactLocatorSchema.safeParse({ ...api, extra: true }).success).toBe(false);
    expect(WorkflowImpactLocatorSchema.safeParse({ ...api, caseId: 3 }).success).toBe(false);
  });
});
