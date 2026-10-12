import type { ApiAsset, ApiTestCase, ComponentAsset, ModelAsset } from "@apicc/core";
import type { ApiccApi, ApiDetail, ContainerDetail, ContainerSaveResult, CreateComponentInput, CreateModelInput, NodeCreateInput, NodeCreatedDTO, OpenResult } from "../../src/shared/types.js";
import type { ApiLocator, CaseLocator, CollectionLocator, FolderLocator, GroupLocator, ProjectLocator, WorkflowLocator } from "../../src/shared/locations.js";
import type { Environment, Workflow } from "@apicc/core";
import type { IpcResultMap } from "../../src/shared/ipc-contract.js";
import type { CredentialMutationResult, CredentialStatusResult } from "../../src/shared/credentials.js";
import { IpcChannel } from "../../src/shared/channels.js";
import type { LocalApiTreeNodeDTO, LocalTreeNodeDTO, OnlineTreeNodeDTO } from "../../src/shared/tree-dto.js";

declare const api: ApiccApi;
declare const apiLocator: ApiLocator;
declare const projectLocator: ProjectLocator;
declare const groupLocator: GroupLocator;
declare const collectionLocator: CollectionLocator;
declare const folderLocator: FolderLocator;
declare const workflowLocator: WorkflowLocator;
declare const asset: ApiAsset;
declare const testCase: ApiTestCase;
declare const model: ModelAsset;
declare const component: ComponentAsset;

const detail: Promise<ApiDetail> = api.apiGet(apiLocator);
const savedApi: Promise<ApiAsset> = api.apiSave(apiLocator, asset);
const savedCase: Promise<ApiTestCase> = api.caseSave({ ...apiLocator, caseId: testCase.id, scope: testCase.scope }, testCase);
const savedContainer: Promise<ContainerSaveResult> = api.containerSave({
  kind: "collection",
  locator: collectionLocator,
  operations: { preOperations: [], postOperations: [], variables: {} },
});
const createdNode: Promise<NodeCreatedDTO> = api.nodeCreate({ kind: "folder", parent: folderLocator, name: "nested" });
const workflowList = api.wfList(projectLocator);
const workflow = api.wfGet(workflowLocator);
const createdWorkflow: Promise<Workflow> = api.wfCreate({ locator: projectLocator, name: "build workflow" });
const authConfig = api.authConfig("https://contracts.example.test");
const credentialPut: Promise<CredentialMutationResult> = api.credentialPut({ locator: projectLocator, ref: { id: "credential-ref", policy: "test-auto" }, value: "" });
const credentialRemove: Promise<CredentialMutationResult> = api.credentialRemove({ locator: projectLocator, ref: { id: "credential-ref", policy: "test-auto" } });
const credentialStatus: Promise<CredentialStatusResult> = api.credentialStatus({ locator: projectLocator, ref: { id: "credential-ref", policy: "test-auto" } });
const putIpcResult: IpcResultMap[typeof IpcChannel.CredentialPut] = { ok: true };
const statusIpcResult: IpcResultMap[typeof IpcChannel.CredentialStatus] = { ok: true, status: "missing" };
// @ts-expect-error Credential mutation results do not include a status field.
const wrongCredentialResult: IpcResultMap[typeof IpcChannel.CredentialPut] = { ok: true, status: "missing" };
// @ts-expect-error Credential locators require workspace, group, and project identity.
api.credentialPut({ locator: { workspaceId: projectLocator.workspaceId, projectId: projectLocator.projectId }, ref: { id: "credential-ref", policy: "test-auto" }, value: "" });
// @ts-expect-error Credential values must be strings.
api.credentialPut({ locator: projectLocator, ref: { id: "credential-ref", policy: "test-auto" }, value: 4 });
const opened: Promise<OpenResult> = api.wsOpen("C:/workspace");
const localTree: Promise<LocalTreeNodeDTO> = api.treeGet();
const environment: Promise<Environment> = api.envCreate({ locator: projectLocator, name: "qa", extends: null });
const collectionDetail: Promise<ContainerDetail> = api.containerGet({ kind: "collection", locator: collectionLocator });
const folderDetail: Promise<ContainerDetail> = api.containerGet({ kind: "folder", locator: folderLocator });
const modelInput: CreateModelInput = { name: "payload", description: "", schema: { kind: "scalar", type: "string" } };
const parameterInput: CreateComponentInput = { kind: "parameter", name: "id", description: "", definition: { location: "path", name: "id", schema: { kind: "scalar", type: "string" }, required: true, description: "" } };
const authInput: CreateComponentInput = { kind: "auth", name: "bearer", description: "", definition: { kind: "bearer", token: { id: "credential-alias", policy: "fixture-alias" } } };
const responseInput: CreateComponentInput = { kind: "response", name: "ok", description: "", definition: { status: "200", description: "", headers: {}, content: {} } };
const exampleInput: CreateComponentInput = { kind: "example", name: "example", description: "", definition: { name: "ok", value: { ok: true } } };
const createdModel: Promise<ModelAsset> = api.modelCreate(projectLocator, modelInput);
const parameter: Promise<ComponentAsset> = api.componentCreate(projectLocator, parameterInput);
const auth: Promise<ComponentAsset> = api.componentCreate(projectLocator, authInput);
const response: Promise<ComponentAsset> = api.componentCreate(projectLocator, responseInput);
const example: Promise<ComponentAsset> = api.componentCreate(projectLocator, exampleInput);
declare const localApiNode: LocalApiTreeNodeDTO;
const localProtocol: "http" | "websocket" | "soap" = localApiNode.protocol;
const modelListResult: IpcResultMap[typeof IpcChannel.ModelList] = [model];
const modelGetResult: IpcResultMap[typeof IpcChannel.ModelGet] = model;
// @ts-expect-error A single model result cannot satisfy a model-list channel.
const crossedModelResult: IpcResultMap[typeof IpcChannel.ModelList] = modelGetResult;

// @ts-expect-error APIs are addressed by full physical locator, not bare ids.
api.apiGet(apiLocator.apiId);
// @ts-expect-error A project cannot be created under a project locator.
const wrongParent: NodeCreateInput = { kind: "project", parent: projectLocator, name: "wrong" };
// @ts-expect-error Folder container operations do not have collection variables.
api.containerSave({ kind: "folder", locator: folderLocator, operations: { preOperations: [], postOperations: [], variables: {} } });
// @ts-expect-error Case identity requires its physical scope.
api.caseDelete({ ...apiLocator, caseId: testCase.id });
// @ts-expect-error Create inputs cannot smuggle identity or format-version fields.
const wrongModelInput: CreateModelInput = { name: "payload", description: "", schema: { kind: "scalar", type: "string" }, id: "forged", formatVersion: 1 };
// @ts-expect-error Project creation uses a parent group plus a name, not an ID payload.
api.nodeCreate({ kind: "project", parent: "group-id", name: "wrong" });

if (createdNode) {
  void createdNode.then((node) => {
    if (node.kind === "api") {
      const protocol: "http" | "websocket" | "soap" = node.protocol;
      void protocol;
    }
    // @ts-expect-error File nodes are never returned by local creation.
    const file: "file" = node.kind;
    void file;
  });
}

// @ts-expect-error Local treeGet never contains online-only nodes.
const onlineTree: Promise<OnlineTreeNodeDTO> = api.treeGet();
void [detail, savedApi, savedCase, savedContainer, workflowList, workflow, createdWorkflow, authConfig, credentialPut, credentialRemove, credentialStatus, putIpcResult, statusIpcResult, wrongCredentialResult, opened, localTree, environment, collectionDetail, folderDetail, createdModel, parameter, auth, response, example, wrongParent, wrongModelInput, component, localProtocol, modelListResult, crossedModelResult, onlineTree];
