import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteIndex } from "../../src/storage/sqliteIndex.js";
import { ContractWorkspaceSchema, type ContractWorkspace } from "../../src/contract/workspace.js";
import { encodeContractWorkspace, validateProspectiveContractFiles } from "../../src/storage/contractFiles.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";

describe("SqliteIndex contract cache", () => {
  const projectId = "ABCDEF00-0000-4000-A000-000000000018";
  const groupId = "ABCDEF00-0000-4000-A000-000000000017";
  const collectionId = "00000000-0000-4000-8000-000000000020";
  const modelId = "00000000-0000-4000-8000-000000000005";
  const nestedApiId = "00000000-0000-4000-8000-000000000026";

  function contractWorkspace(): ContractWorkspace {
    const workspace = ContractWorkspaceSchema.parse(workspaceFixture());
    workspace.groups[0]!.id = groupId;
    workspace.groups[0]!.projects[0]!.id = projectId;
    const project = workspace.groups[0]!.projects[0]!;
    const api = project.collections[0]!.apis[0]!;
    api.cases.push({ ...api.cases[0]!, scope: "release.v1", name: "release" });
    api.cases.push({ ...api.cases[0]!, id: "用例", scope: "环境", name: "unicode identity" });
    const nestedApi = structuredClone(api);
    nestedApi.contract.id = nestedApiId;
    nestedApi.contract.metadata.name = "Nested API";
    nestedApi.cases = [{ ...api.cases[0]!, name: "nested valid payload" }];
    project.collections[0]!.folders[0]!.folders[0]!.apis.push(nestedApi);
    return workspace;
  }

  it("indexes nested assets with paths from the contract layout and composite case identities", () => {
    const db = join(mkdtempSync(join(tmpdir(), "apicc-contract-idx-")), "cache.sqlite");
    const workspace = contractWorkspace();
    const project = workspace.groups[0]!.projects[0]!;
    const collection = project.collections[0]!;
    const api = collection.apis[0]!;
    const nestedFolder = collection.folders[0]!.folders[0]!;
    const index = new SqliteIndex(db);
    index.rebuild(workspace);

    expect(index.byIdentity({ type: "api", groupId, projectId, ownerId: collection.id, id: api.contract.id })?.path)
      .toBe(`groups/${groupId}/projects/${projectId}/collections/${collectionId}/apis/${api.contract.id}`);
    expect(index.byIdentity({ type: "api", groupId, projectId, ownerId: nestedFolder.id, id: nestedApiId })?.path)
      .toBe(`groups/${groupId}/projects/${projectId}/collections/${collectionId}/folders/00000000-0000-4000-8000-000000000021/folders/00000000-0000-4000-8000-000000000025/apis/${nestedApiId}`);

    const baseCase = index.byIdentity({ type: "case", groupId, projectId, ownerId: api.contract.id, id: "case-create-user", scope: "base" });
    const releaseCase = index.byIdentity({ type: "case", groupId, projectId, ownerId: api.contract.id, id: "case-create-user", scope: "release.v1" });
    const unicodeCase = index.byIdentity({ type: "case", groupId, projectId, ownerId: api.contract.id, id: "用例", scope: "环境" });
    const nestedCase = index.byIdentity({ type: "case", groupId, projectId, ownerId: nestedApiId, id: "case-create-user", scope: "base" });
    expect(baseCase?.path).toBe(`groups/${groupId}/projects/${projectId}/collections/${collectionId}/apis/${api.contract.id}/cases/636173652d6372656174652d75736572.62617365.yaml`);
    expect(releaseCase?.path).toBe(`groups/${groupId}/projects/${projectId}/collections/${collectionId}/apis/${api.contract.id}/cases/636173652d6372656174652d75736572.72656c656173652e7631.yaml`);
    expect(unicodeCase?.path).toBe(`groups/${groupId}/projects/${projectId}/collections/${collectionId}/apis/${api.contract.id}/cases/e794a8e4be8b.e78eafe5a283.yaml`);
    expect(nestedCase?.path).toBe(`groups/${groupId}/projects/${projectId}/collections/${collectionId}/folders/00000000-0000-4000-8000-000000000021/folders/00000000-0000-4000-8000-000000000025/apis/${nestedApiId}/cases/636173652d6372656174652d75736572.62617365.yaml`);
    expect(index.byType("folder")).toHaveLength(2);
    expect(index.byType("model")).toHaveLength(1);
    for (const componentKind of ["parameter", "auth", "response", "example"]) {
      expect(index.byType(componentKind)).toHaveLength(1);
    }
    index.close();
  });

  it("keeps repeated project-local IDs independently addressable at each group/project path", async () => {
    const source = contractWorkspace();
    const firstGroup = source.groups[0]!;
    const firstProject = firstGroup.projects[0]!;
    const sameGroupProject = structuredClone(firstProject);
    sameGroupProject.id = "00000000-0000-4000-8000-000000000030";
    sameGroupProject.name = "Same-group copy";
    firstGroup.projects.push(sameGroupProject);
    const secondGroup = {
      id: "00000000-0000-4000-8000-000000000031",
      name: "Second group",
      projects: [structuredClone(firstProject)],
    };
    source.groups.push(secondGroup);

    const workspace = ContractWorkspaceSchema.parse(source);
    const prospective = await validateProspectiveContractFiles(encodeContractWorkspace(workspace).files);
    expect(prospective).toEqual({ problems: [], readOnly: false });

    const locations = [
      { groupId: firstGroup.id, projectId: firstProject.id, project: firstProject },
      { groupId: firstGroup.id, projectId: sameGroupProject.id, project: sameGroupProject },
      { groupId: secondGroup.id, projectId: firstProject.id, project: secondGroup.projects[0]! },
    ];
    const db = join(mkdtempSync(join(tmpdir(), "apicc-scoped-identities-")), "cache.sqlite");
    const index = new SqliteIndex(db);
    try {
      index.rebuild(workspace);

      const queries = locations.map(({ groupId, projectId, project }) => {
        const collection = project.collections[0]!;
        const api = collection.apis[0]!;
        const testCase = api.cases[0]!;
        const model = project.models[0]!;
        const component = project.components[0]!;
        const apiPath = `groups/${groupId}/projects/${projectId}/collections/${collection.id}/apis/${api.contract.id}`;
        const apiIdentity = { type: "api", groupId, projectId, ownerId: collection.id, id: api.contract.id };
        const caseIdentity = { type: "case", groupId, projectId, ownerId: api.contract.id, id: testCase.id, scope: testCase.scope };
        const modelIdentity = { type: "model", groupId, projectId, ownerId: project.id, id: model.id };
        const componentIdentity = { type: component.kind, groupId, projectId, ownerId: project.id, id: component.id };
        const fromApi = index.referencesFrom(groupId, projectId, api.contract.id);
        const toModel = index.referencesTo(groupId, projectId, model.id, "model");

        expect(index.byIdentity(apiIdentity)?.path).toBe(apiPath);
        expect(index.byIdentity(caseIdentity)?.path).toBe(`${apiPath}/cases/636173652d6372656174652d75736572.62617365.yaml`);
        expect(index.byIdentity(modelIdentity)?.path).toBe(`groups/${groupId}/projects/${projectId}/models/${model.id}.yaml`);
        expect(index.byIdentity(componentIdentity)?.path)
          .toBe(`groups/${groupId}/projects/${projectId}/components/${component.kind}/${component.id}.yaml`);
        expect(fromApi.some((reference) => reference.targetId === model.id && reference.expectedKind === "model")).toBe(true);
        expect(fromApi.every((reference) => reference.groupId === groupId && reference.projectId === projectId)).toBe(true);
        expect(toModel.length).toBeGreaterThan(0);
        expect(toModel.every((reference) => reference.groupId === groupId && reference.projectId === projectId)).toBe(true);
        return { apiIdentity, caseIdentity, modelIdentity, componentIdentity, fromApi, toModel };
      });

      expect(index.byType("api")).toHaveLength(6);
      index.close();

      const reopened = new SqliteIndex(db);
      try {
        for (const query of queries) {
          expect(reopened.byIdentity(query.apiIdentity)).toBeDefined();
          expect(reopened.byIdentity(query.caseIdentity)).toBeDefined();
          expect(reopened.byIdentity(query.modelIdentity)).toBeDefined();
          expect(reopened.byIdentity(query.componentIdentity)).toBeDefined();
          expect(reopened.referencesFrom(query.apiIdentity.groupId, query.apiIdentity.projectId, query.apiIdentity.id)).toEqual(query.fromApi);
          expect(reopened.referencesTo(query.modelIdentity.groupId, query.modelIdentity.projectId, query.modelIdentity.id, "model"))
            .toEqual(query.toModel);
        }
      } finally {
        reopened.close();
      }
    } finally {
      try { index.close(); } catch { /* already closed before reopen */ }
    }
  });

  it("uses project metadata as the path for inline environments and workflows", () => {
    const db = join(mkdtempSync(join(tmpdir(), "apicc-inline-idx-")), "cache.sqlite");
    const workspace = contractWorkspace();
    const project = workspace.groups[0]!.projects[0]!;
    const index = new SqliteIndex(db);
    index.rebuild(workspace);

    expect(index.byIdentity({ type: "environment", groupId, projectId, ownerId: project.id, id: project.environments[0]!.id }))
      .toMatchObject({ path: `groups/${groupId}/projects/${projectId}/project.yaml`, locator: `environments/${project.environments[0]!.id}` });
    expect(index.byIdentity({ type: "workflow", groupId, projectId, ownerId: project.id, id: project.workflows[0]!.id }))
      .toMatchObject({ path: `groups/${groupId}/projects/${projectId}/project.yaml`, locator: `workflows/${project.workflows[0]!.id}` });
    expect(index.byIdentity({ type: "model", groupId, projectId, ownerId: project.id, id: modelId })?.path)
      .toBe(`groups/${groupId}/projects/${projectId}/models/${modelId}.yaml`);
    expect(index.byIdentity({ type: "example", groupId, projectId, ownerId: project.id, id: "00000000-0000-4000-8000-000000000009" })?.path)
      .toBe(`groups/${groupId}/projects/${projectId}/components/example/00000000-0000-4000-8000-000000000009.yaml`);
    index.close();
  });

  it("indexes asset reference edges and returns the same stable queries after reopening", () => {
    const db = join(mkdtempSync(join(tmpdir(), "apicc-ref-idx-")), "cache.sqlite");
    const workspace = contractWorkspace();
    const project = workspace.groups[0]!.projects[0]!;
    const apiId = project.collections[0]!.apis[0]!.contract.id;
    const index = new SqliteIndex(db);
    index.rebuild(workspace);
    const fromApi = index.referencesFrom(groupId, project.id, apiId);
    expect(fromApi).toContainEqual({
      groupId,
      projectId: project.id,
      ownerId: apiId,
      path: "contract.request.body.schema.additionalProperties.modelId",
      targetId: modelId,
      expectedKind: "model",
    });
    const inbound = index.referencesTo(groupId, project.id, modelId, "model");
    expect(inbound.length).toBeGreaterThan(0);
    expect(inbound).toEqual([...inbound].sort((left, right) =>
      left.projectId.localeCompare(right.projectId)
      || left.ownerId.localeCompare(right.ownerId)
      || left.path.localeCompare(right.path)));
    index.close();

    const reopened = new SqliteIndex(db);
    expect(reopened.referencesFrom(groupId, project.id, apiId)).toEqual(fromApi);
    expect(reopened.referencesTo(groupId, project.id, modelId, "model")).toEqual(inbound);
    reopened.close();
  });

  it("rebuild replaces stale object rows and reference edges", () => {
    const db = join(mkdtempSync(join(tmpdir(), "apicc-rebuild-idx-")), "cache.sqlite");
    const source = contractWorkspace();
    const project = source.groups[0]!.projects[0]!;
    const api = project.collections[0]!.apis[0]!;
    const index = new SqliteIndex(db);
    index.rebuild(source);
    const groupId = source.groups[0]!.id;
    const projectId = project.id;
    expect(index.byIdentity({ type: "case", groupId, projectId, ownerId: api.contract.id, id: "case-create-user", scope: "release.v1" })).toBeDefined();
    expect(index.referencesFrom(groupId, projectId, api.contract.id).length).toBeGreaterThan(0);

    const pruned = structuredClone(source);
    pruned.groups[0]!.projects[0]!.collections[0]!.apis = [];
    pruned.groups[0]!.projects[0]!.models = [];
    pruned.groups[0]!.projects[0]!.components = [];
    index.rebuild(pruned);

    expect(index.byIdentity({ type: "case", groupId, projectId, ownerId: api.contract.id, id: "case-create-user", scope: "release.v1" })).toBeUndefined();
    expect(index.byType("model")).toEqual([]);
    expect(index.byType("parameter")).toEqual([]);
    expect(index.referencesFrom(groupId, projectId, api.contract.id)).toEqual([]);
    expect(index.byIdentity({ type: "case", groupId, projectId, ownerId: nestedApiId, id: "case-create-user", scope: "base" })).toBeDefined();
    index.close();
  });
});
