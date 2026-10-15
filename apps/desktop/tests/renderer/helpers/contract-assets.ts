import { randomUUID } from "node:crypto";
import { ContractWorkspaceSchema, fileStorage } from "@apicc/core";
import type { CreateComponentInput, CreateModelInput } from "../../../src/shared/types.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import type { ApiLocator, ProjectLocator } from "../../../src/shared/locations.js";
import type { LocalApiTreeNodeDTO, LocalCollectionTreeNodeDTO, LocalGroupTreeNodeDTO, LocalProjectTreeNodeDTO, LocalRootTreeNodeDTO } from "../../../src/shared/tree-dto.js";

export type ContractMemoryApi = ReturnType<typeof createMemoryApi>;

export interface ContractAssetFixture {
  api: ContractMemoryApi;
  root: string;
  tree: LocalRootTreeNodeDTO;
  group: LocalGroupTreeNodeDTO;
  project: LocalProjectTreeNodeDTO;
  collection: LocalCollectionTreeNodeDTO;
  apiNode: LocalApiTreeNodeDTO;
  projectLocator: ProjectLocator;
  apiLocator: ApiLocator;
}

export interface ContractAssetEditorFixture extends ContractAssetFixture {
  secondApiLocator: ApiLocator;
  model: Awaited<ReturnType<ContractMemoryApi["modelCreate"]>>;
  components: Awaited<ReturnType<ContractMemoryApi["componentList"]>>;
}

/** Shared legal contract workspace fixture for the renderer memory and store tests. */
export async function contractAssetFixture(
  api: ContractMemoryApi = createMemoryApi(),
  root = "C:/apicc-contract-assets",
): Promise<ContractAssetFixture> {
  api.seedWorkspace();
  await api.wsOpen(root);
  const candidate = await api.treeGet();
  if (candidate.source !== "local" || candidate.kind !== "root") throw new Error("Contract asset fixture expected a local workspace root");
  const tree = candidate;
  const group = tree.children.find((node): node is LocalGroupTreeNodeDTO => node.kind === "group"
    && node.children.some((child) => child.kind === "project"));
  const project = group?.children.find((node): node is LocalProjectTreeNodeDTO => node.kind === "project");
  const collection = project?.children.find((node): node is LocalCollectionTreeNodeDTO => node.kind === "collection");
  const apiNode = collection?.children.find((node) => node.kind === "api");
  if (!group || !project || !collection || apiNode?.kind !== "api") {
    throw new Error("Contract asset fixture did not produce the seeded group/project/collection/API tree");
  }
  const projectLocator = {
    workspaceId: tree.locator.workspaceId,
    groupId: group.locator.groupId,
    projectId: project.locator.projectId,
  };
  return {
    api,
    root,
    tree,
    group,
    project,
    collection,
    apiNode,
    projectLocator,
    apiLocator: { ...apiNode.locator, folderIds: [...apiNode.locator.folderIds] },
  };
}

/** One integrated editor fixture: two APIs, one model, four typed components, and persisted references. */
export async function contractAssetEditorFixture(
  api: ContractMemoryApi = createMemoryApi(),
  root = "C:/apicc-contract-editor-assets",
): Promise<ContractAssetEditorFixture> {
  const fixture = await contractAssetFixture(api, root);
  const second = await api.nodeCreate({
    kind: "api",
    parent: fixture.collection.locator,
    api: { name: "Second editor API", protocol: "http", method: "GET", baseUrl: "", path: "/second" },
  });
  if (second.kind !== "api") throw new Error("Contract editor fixture failed to create its second API");
  const model = await api.modelCreate(fixture.projectLocator, modelInput);
  const components = await Promise.all(componentInputs.map((input) => api.componentCreate(fixture.projectLocator, input)));
  const parameter = components.find((component) => component.kind === "parameter");
  const auth = components.find((component) => component.kind === "auth");
  const response = components.find((component) => component.kind === "response");
  const example = components.find((component) => component.kind === "example");
  if (!parameter || parameter.kind !== "parameter" || !auth || auth.kind !== "auth"
    || !response || response.kind !== "response" || !example || example.kind !== "example") {
    throw new Error("Contract editor fixture did not create all four component kinds");
  }
  const detail = await api.apiGet(fixture.apiLocator);
  if (detail.api.contract.request.protocol !== "http") throw new Error("Seed API must use HTTP for editor asset references");
  detail.api.contract.request.query.push({
    kind: "componentRef", id: randomUUID(), componentId: parameter.id, expectedKind: "parameter", value: "42", enabled: true,
  });
  detail.api.contract.request.auth = { kind: "componentRef", componentId: auth.id, expectedKind: "auth" };
  if (detail.api.contract.request.protocol === "http") {
    detail.api.contract.request.body = {
      kind: "json", content: "", schema: { kind: "modelRef", modelId: model.id },
    };
  }
  detail.api.contract.responses.push({
    kind: "componentRef", id: randomUUID(), componentId: response.id, expectedKind: "response",
  });
  await api.apiSave(fixture.apiLocator, detail.api, detail.sourceApiRevision);
  const secondDetail = await api.apiGet(second.locator);
  if (secondDetail.api.contract.request.protocol !== "http") throw new Error("Second API must use HTTP for editor fixture references");
  secondDetail.api.contract.request.body = {
    kind: "json", content: "", schema: { kind: "modelRef", modelId: model.id },
  };
  secondDetail.api.contract.responses = [{
    kind: "inline", id: randomUUID(), status: "200", description: "ok", headers: {},
    content: { "application/json": { schema: { kind: "modelRef", modelId: model.id }, examples: [
      { kind: "componentRef", id: randomUUID(), componentId: example.id, expectedKind: "example" },
    ] } },
  }];
  await api.apiSave(second.locator, secondDetail.api, secondDetail.sourceApiRevision);
  return {
    ...fixture,
    secondApiLocator: { ...second.locator, folderIds: [...second.locator.folderIds] },
    model,
    components,
  };
}

/** Persist a second real project scope with the same project/entity IDs under another group. */
export async function duplicateContractProjectAcrossGroups(
  fixture: ContractAssetFixture,
  groupName: string,
): Promise<ProjectLocator> {
  const loaded = await fileStorage.load(fixture.root);
  const workspace = ContractWorkspaceSchema.parse(JSON.parse(JSON.stringify(loaded.workspace)));
  const sourceGroup = workspace.groups.find((group) => group.id === fixture.projectLocator.groupId);
  const sourceProject = sourceGroup?.projects.find((project) => project.id === fixture.projectLocator.projectId);
  if (!sourceGroup || !sourceProject) throw new Error("Contract fixture project not found in persisted workspace");

  const duplicate = structuredClone(sourceProject);
  duplicate.name = `${sourceProject.name} (${groupName})`;
  const duplicateCollection = duplicate.collections.find((collection) => collection.id === fixture.collection.locator.collectionId);
  const duplicateApi = duplicateCollection?.apis.find((api) => api.contract.id === fixture.apiNode.id);
  if (!duplicateApi) throw new Error("Contract fixture API not found in duplicated project");
  duplicateApi.contract.metadata.description = `Stored in ${groupName}`;

  const groupId = randomUUID();
  workspace.groups.push({ id: groupId, name: groupName, projects: [duplicate] });
  const validated = ContractWorkspaceSchema.parse(workspace);
  await fileStorage.save(fixture.root, validated, { expectedRevision: loaded.revision, deletions: [] });
  const reopened = await fixture.api.wsOpen(fixture.root);
  return { workspaceId: reopened.workspace.id, groupId, projectId: duplicate.id };
}

export const modelInput: CreateModelInput = {
  name: "Payload",
  description: "Shared model fixture",
  schema: {
    kind: "object",
    properties: { id: { kind: "scalar", type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};

export const componentInputs: CreateComponentInput[] = [
  {
    kind: "parameter",
    name: "Query ID",
    description: "Shared parameter fixture",
    definition: { location: "query", name: "id", schema: { kind: "scalar", type: "string" }, required: false, description: "" },
  },
  { kind: "auth", name: "No auth", description: "Shared auth fixture", definition: { kind: "none" } },
  {
    kind: "response",
    name: "Success",
    description: "Shared response fixture",
    definition: { status: "200", description: "ok", headers: {}, content: { "application/json": { schema: modelInput.schema, examples: [] } } },
  },
  { kind: "example", name: "Success example", description: "Shared example fixture", definition: { name: "success", value: { ok: true } } },
];
