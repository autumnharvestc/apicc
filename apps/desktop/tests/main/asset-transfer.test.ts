import { describe, expect, it } from "vitest";
import { ContractWorkspaceSchema, type ContractProject, type SecretStore } from "@apicc/core";
import type { Importer } from "@apicc/core";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";
import { IpcChannel } from "../../src/shared/channels.js";
import {
  findApi,
  IDS,
  makeTempRoot,
  makeWorkspace,
  persistWorkspace,
  projectOne,
  projectTwo,
  uuid,
} from "./helpers/contract-assets.js";

const sourceLocator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
const duplicateLocator = { ...sourceLocator, groupId: IDS.groupTwo };
const secondProjectLocator = { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo };
const sourceSecret = { id: "source-secret-ref", policy: "test-auto" } as const;
const unusedSecret = { id: "unused-source-secret-ref", policy: "test-auto" } as const;

function scopeKey(scope: Parameters<SecretStore["status"]>[0], ref: Parameters<SecretStore["status"]>[1]): string {
  return JSON.stringify([scope.workspaceId, scope.groupId, scope.projectId, ref.id, ref.policy]);
}

function addTransferReferences(project: ContractProject): void {
  const api = findApi(project, IDS.sharedApi);
  const parameter = project.components.find((component) => component.id === IDS.parameter);
  const auth = project.components.find((component) => component.id === IDS.auth);
  const response = project.components.find((component) => component.id === IDS.response);
  if (!api || !parameter || parameter.kind !== "parameter" || !auth || auth.kind !== "auth"
    || auth.definition.kind !== "bearer" || !response || response.kind !== "response") {
    throw new Error("Transfer fixture must contain its linked API and four component kinds");
  }
  if (api.contract.request.protocol !== "http") throw new Error("Transfer fixture API must be HTTP");

  const previewEnvironmentId = uuid(202);
  const secondCase = api.cases[1];
  if (!secondCase) throw new Error("Transfer fixture must contain two environment versions");
  project.environments[0]!.name = "dev";
  project.environments[0]!.baseUrls = { [IDS.collectionOne]: "https://dev.example.test" };
  project.environments.push({
    id: previewEnvironmentId,
    name: "preview",
    extends: "dev",
    variables: {},
    baseUrls: { [IDS.secondCollection]: "https://preview.example.test" },
  });
  api.cases[0]!.scope = "dev";
  secondCase.scope = "preview";
  api.contract.request.headers = [{ kind: "componentRef", id: uuid(203), componentId: IDS.parameter, expectedKind: "parameter" }];
  api.contract.request.auth = { kind: "componentRef", componentId: IDS.auth, expectedKind: "auth" };
  api.contract.request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: IDS.model } };
  api.contract.responses = [{ kind: "componentRef", id: uuid(204), componentId: IDS.response, expectedKind: "response" }];
  parameter.definition.schema = { kind: "modelRef", modelId: IDS.model };
  auth.definition = { kind: "bearer", token: sourceSecret };
  const unusedAuth = project.components.find((component) => component.id === IDS.unusedAuth);
  if (!unusedAuth || unusedAuth.kind !== "auth" || unusedAuth.definition.kind !== "apikey") {
    throw new Error("Transfer fixture must contain its unused auth component");
  }
  unusedAuth.definition.value = unusedSecret;
  response.definition.content = {
    "application/json": {
      schema: { kind: "modelRef", modelId: IDS.model },
      examples: [{ kind: "componentRef", id: uuid(205), componentId: IDS.example, expectedKind: "example" }],
    },
  };
  const workflow = project.workflows[0];
  if (!workflow) throw new Error("Transfer fixture must contain a workflow");
  const noopId = uuid(206);
  workflow.nodes.push({ id: noopId, kind: "noop" });
  workflow.edges.push({ id: uuid(207), from: IDS.workflowNode, to: noopId });
}

function secretFromAuth(project: ContractProject, componentId: string): { id: string; policy: string } {
  const component = project.components.find((item) => item.id === componentId);
  if (!component || component.kind !== "auth" || component.definition.kind !== "bearer") {
    throw new Error(`Bearer auth component missing: ${componentId}`);
  }
  return component.definition.token;
}

function assertAvailableResult(value: unknown, status: "available" | "missing"): void {
  expect(value).toMatchObject({ ok: true, status });
}

describe("asset transfer IPC", () => {
  it("imports, clones, and moves real projects without copying scoped secret values or dangling references", async () => {
    const temporary = await makeTempRoot("apicc-asset-transfer-");
    try {
      const workspace = makeWorkspace();
      const source = projectOne(workspace);
      addTransferReferences(source);
      const groupTwo = workspace.groups.find((group) => group.id === IDS.groupTwo)!;
      groupTwo.projects.push(structuredClone(source));

      const movingProject = projectTwo(workspace);
      const movingApi = findApi(movingProject, IDS.sharedApi);
      if (!movingApi) throw new Error("Move fixture API missing");
      const moveRef = { id: "move-secret-ref", policy: "test-auto" } as const;
      const moveUnusedRef = { id: "move-unused-secret-ref", policy: "test-auto" } as const;
      const moveAuthId = uuid(208);
      movingApi.contract.request.auth = { kind: "componentRef", componentId: moveAuthId, expectedKind: "auth" };
      movingProject.components.push({
        formatVersion: 1,
        id: moveAuthId,
        name: "move auth",
        description: "",
        kind: "auth",
        definition: { kind: "bearer", token: moveRef },
      });
      movingProject.components.push({
        formatVersion: 1,
        id: uuid(209),
        name: "unused move auth",
        description: "",
        kind: "auth",
        definition: { kind: "apikey", name: "x-key", placement: "header", value: moveUnusedRef },
      });
      const initial = ContractWorkspaceSchema.parse(workspace);
      await persistWorkspace(temporary.path, initial);

      const values = new Map<string, string>();
      const secretStore: SecretStore = {
        async put(scope, ref, value) { values.set(scopeKey(scope, ref), value); },
        async resolve(scope, ref) {
          const value = values.get(scopeKey(scope, ref));
          if (value === undefined) throw new Error(`Missing synthetic credential: ${ref.id}`);
          return value;
        },
        async version(scope, ref) { return values.has(scopeKey(scope, ref)) ? "v1" : "missing"; },
        async remove(scope, ref) { values.delete(scopeKey(scope, ref)); },
        async status(scope, ref) { return values.has(scopeKey(scope, ref)) ? "available" : "missing"; },
      };
      const session = createSession();
      await session.open(temporary.path);
      const importedProject = structuredClone(source);
      importedProject.id = uuid(210);
      importedProject.name = "Imported source";
      const importer: Importer = {
        name: "asset-transfer-fixture",
        detect: (fileName, content) => fileName === "transfer.fixture" && content === "fixture",
        parse: () => ({ project: structuredClone(importedProject), diagnostics: [], warnings: [] }),
      };
      const deps = createIpcDeps({
        session,
        importers: [importer],
        pickDirectory: async () => "",
        saveFile: async () => "",
        credentials: { secretStore },
      });

      await deps.handle(IpcChannel.CredentialPut, null, { locator: sourceLocator, ref: sourceSecret, value: "source-only synthetic value" });
      await deps.handle(IpcChannel.CredentialPut, null, { locator: duplicateLocator, ref: sourceSecret, value: "other-group synthetic value" });
      assertAvailableResult(await deps.handle(IpcChannel.CredentialStatus, null, { locator: sourceLocator, ref: sourceSecret }), "available");
      assertAvailableResult(await deps.handle(IpcChannel.CredentialStatus, null, { locator: duplicateLocator, ref: sourceSecret }), "available");
      expect(await secretStore.resolve({ workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, sourceSecret))
        .toBe("source-only synthetic value");
      expect(await secretStore.resolve({ workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectOne }, sourceSecret))
        .toBe("other-group synthetic value");

      const preview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "transfer.fixture", content: "fixture" });
      expect(preview).toMatchObject({ importerName: "asset-transfer-fixture", project: importedProject });
      expect(JSON.stringify(preview)).not.toContain("source-only synthetic value");
      await deps.handle(IpcChannel.ImportApply, null, {
        mode: "project",
        target: { workspaceId: IDS.workspace, groupId: IDS.groupTwo },
        name: "Imported asset",
        project: preview.project,
      });
      await session.open(temporary.path);
      const imported = session.workspace!.groups.find((group) => group.id === IDS.groupTwo)!.projects.find((project) => project.name === "Imported asset")!;
      const importedAuth = imported.components.find((component) => component.name === "saved auth");
      if (!importedAuth || importedAuth.kind !== "auth" || importedAuth.definition.kind !== "bearer") throw new Error("Imported auth missing");
      expect(importedAuth.definition.token.id).not.toBe(sourceSecret.id);
      assertAvailableResult(await deps.handle(IpcChannel.CredentialStatus, null, {
        locator: { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: imported.id },
        ref: importedAuth.definition.token,
      }), "missing");

      const sourceBeforeClone = session.locateProject(sourceLocator)!.project;
      const clone = await deps.handle(IpcChannel.ProjectClone, null, sourceLocator);
      const cloneLocator = { ...sourceLocator, projectId: clone.id };
      await session.open(temporary.path);
      expect(session.locateProject(cloneLocator)?.project).toEqual(clone);
      expect(await session.validate()).toEqual([]);
      expect(session.locateProject(sourceLocator)?.project).toEqual(sourceBeforeClone);
      expect(clone.id).not.toBe(sourceLocator.projectId);
      const clonedCollection = clone.collections.find((collection) => collection.name === "collection one")!;
      expect(clonedCollection.id).not.toBe(IDS.collectionOne);
      const clonedSecondCollection = clone.collections.find((collection) => collection.name === "second collection")!;
      expect(clonedSecondCollection.id).not.toBe(IDS.secondCollection);
      const clonedEnvironment = clone.environments.find((environment) => environment.name === "preview")!;
      expect(clonedEnvironment.id).not.toBe(uuid(202));
      expect(clonedEnvironment.extends).toBe("dev");
      expect(clonedEnvironment.baseUrls).toEqual({ [clonedSecondCollection.id]: "https://preview.example.test" });
      const clonedApi = findApi(clone, clone.collections[0]!.apis[0]!.contract.id)!;
      expect(clonedApi.contract.id).not.toBe(IDS.sharedApi);
      const clonedModel = clone.models.find((model) => model.name === "Payload")!;
      expect(clonedModel.id).not.toBe(IDS.model);
      const clonedParameter = clone.components.find((component) => component.name === "token header")!;
      const clonedAuth = clone.components.find((component) => component.name === "saved auth")!;
      const clonedResponse = clone.components.find((component) => component.name === "ok response")!;
      const clonedExample = clone.components.find((component) => component.name === "ok example")!;
      expect(clonedParameter.id).not.toBe(IDS.parameter);
      expect(clonedAuth.id).not.toBe(IDS.auth);
      expect(clonedResponse.id).not.toBe(IDS.response);
      expect(clonedExample.id).not.toBe(IDS.example);
      if (clonedApi.contract.request.auth.kind !== "componentRef" || clonedParameter.kind !== "parameter"
        || clonedResponse.kind !== "response" || clonedAuth.kind !== "auth" || clonedAuth.definition.kind !== "bearer") {
        throw new Error("Cloned asset links changed kind");
      }
      expect(clonedApi.contract.request.auth.componentId).toBe(clonedAuth.id);
      expect(clonedApi.contract.request.headers[0]).toMatchObject({ kind: "componentRef", componentId: clonedParameter.id });
      if (clonedApi.contract.request.protocol !== "http") throw new Error("Expected the cloned API request to be HTTP.");
      if (clonedApi.contract.request.body.kind !== "json" || clonedApi.contract.request.body.schema?.kind !== "modelRef") {
        throw new Error("Cloned request body schema reference missing");
      }
      expect(clonedApi.contract.request.body.schema.modelId).toBe(clonedModel.id);
      expect(clonedApi.contract.responses[0]).toMatchObject({ kind: "componentRef", componentId: clonedResponse.id });
      expect(clonedParameter.definition.schema).toMatchObject({ kind: "modelRef", modelId: clonedModel.id });
      expect(clonedResponse.definition.content["application/json"]?.examples?.[0])
        .toMatchObject({ kind: "componentRef", componentId: clonedExample.id });
      const clonedSourceSecret = secretFromAuth(clone, clonedAuth.id);
      const clonedUnused = clone.components.find((component) => component.name === "unused auth");
      if (!clonedUnused || clonedUnused.kind !== "auth" || clonedUnused.definition.kind !== "apikey") throw new Error("Cloned unused auth missing");
      expect(clonedSourceSecret.id).not.toBe(sourceSecret.id);
      expect(clonedUnused.definition.value.id).not.toBe(unusedSecret.id);
      assertAvailableResult(await deps.handle(IpcChannel.CredentialStatus, null, { locator: cloneLocator, ref: clonedSourceSecret }), "missing");
      expect(await secretStore.status(cloneLocator, clonedSourceSecret)).toBe("missing");
      expect(await secretStore.status({ workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, sourceSecret)).toBe("available");
      const clonedWorkflow = clone.workflows.find((workflow) => workflow.name === "request flow")!;
      const clonedRequestNode = clonedWorkflow.nodes.find((node) => node.kind === "request")!;
      expect(clonedWorkflow.id).not.toBe(IDS.workflow);
      expect(clonedRequestNode.id).not.toBe(IDS.workflowNode);
      expect(clonedRequestNode.apiId).toBe(clonedApi.contract.id);
      expect(clonedRequestNode.caseId).toBe(clonedApi.cases[0]!.id);
      expect(clonedApi.cases.map((testCase) => testCase.scope)).toEqual(["dev", "preview"]);
      expect(clonedApi.cases[0]!.id).not.toBe(IDS.sharedCase);
      expect(clonedWorkflow.edges[0]!.id).not.toBe(uuid(207));
      expect(clonedWorkflow.edges[0]!.from).toBe(clonedWorkflow.nodes[0]!.id);
      expect(clonedWorkflow.edges[0]!.to).toBe(clonedWorkflow.nodes[1]!.id);

      await deps.handle(IpcChannel.NodeRename, null, {
        kind: "group",
        locator: { workspaceId: IDS.workspace, groupId: IDS.groupTwo },
      }, "renamed group two");
      assertAvailableResult(await deps.handle(IpcChannel.CredentialStatus, null, { locator: duplicateLocator, ref: sourceSecret }), "available");

      await deps.handle(IpcChannel.CredentialPut, null, { locator: secondProjectLocator, ref: moveRef, value: "move-only value" });
      await deps.handle(IpcChannel.CredentialPut, null, { locator: secondProjectLocator, ref: moveUnusedRef, value: "move-unused value" });
      const historicalTargetScope = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectTwo };
      await secretStore.put(historicalTargetScope, moveRef, "historical target binding");
      const moveApiBefore = findApi(session.locateProject(secondProjectLocator)!.project, IDS.sharedApi)!;
      await deps.handle(IpcChannel.ProjectMove, null, secondProjectLocator, { workspaceId: IDS.workspace, groupId: IDS.groupOne });
      await session.open(temporary.path);
      const movedLocator = { ...secondProjectLocator, groupId: IDS.groupOne };
      const moved = session.locateProject(movedLocator)!.project;
      const movedApi = findApi(moved, IDS.sharedApi)!;
      expect(moved.id).toBe(IDS.projectTwo);
      expect(movedApi.contract.id).toBe(moveApiBefore.contract.id);
      const movedAuth = moved.components.find((component) => component.id === moveAuthId);
      if (!movedAuth || movedAuth.kind !== "auth" || movedAuth.definition.kind !== "bearer") throw new Error("Moved auth missing");
      expect(movedAuth.id).toBe(moveAuthId);
      expect(movedAuth.definition.token.id).not.toBe(moveRef.id);
      const movedUnused = moved.components.find((component) => component.name === "unused move auth");
      if (!movedUnused || movedUnused.kind !== "auth" || movedUnused.definition.kind !== "apikey") throw new Error("Moved unused auth missing");
      expect(movedUnused.definition.value.id).not.toBe(moveUnusedRef.id);
      assertAvailableResult(await deps.handle(IpcChannel.CredentialStatus, null, { locator: movedLocator, ref: movedAuth.definition.token }), "missing");
      assertAvailableResult(await deps.handle(IpcChannel.CredentialStatus, null, { locator: movedLocator, ref: movedUnused.definition.value }), "missing");
      expect(await secretStore.status({ workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo }, moveRef)).toBe("available");
      expect(await secretStore.status({ workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo }, moveUnusedRef)).toBe("available");
      expect(await secretStore.status(historicalTargetScope, moveRef)).toBe("available");
      expect(await secretStore.resolve(historicalTargetScope, moveRef)).toBe("historical target binding");
      expect(session.locateProject(secondProjectLocator)).toBeUndefined();
    } finally {
      await temporary.dispose();
    }
  });
});
