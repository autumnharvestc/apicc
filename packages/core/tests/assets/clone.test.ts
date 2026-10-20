import { describe, expect, it } from "vitest";

import { cloneAssetBundle, cloneProjectDefinition, type CloneIdKind, type CloneIdMapping } from "../../src/assets/clone.js";
import { ApiAssetSchema, ComponentAssetSchema, ModelAssetSchema, ParameterBindingSchema, type ApiAsset, type ComponentAsset, type ModelAsset } from "../../src/contract/model.js";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { componentFixtures, contractFixture, modelAssetFixture, parameterReference, workspaceFixture } from "../helpers/contractFixtures.js";
import { createMockConfiguredProject, mockFixtureIds } from "../helpers/mockFixtures.js";

const newProjectId = "00000000-0000-4000-8000-000000000900";
const componentIds = {
  parameter: "00000000-0000-4000-8000-000000000006",
  auth: "00000000-0000-4000-8000-000000000007",
  response: "00000000-0000-4000-8000-000000000008",
  example: "00000000-0000-4000-8000-000000000009",
};
const modelId = "00000000-0000-4000-8000-000000000005";

function deterministicIdFactory() {
  let next = 900;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

function mapped(idMap: readonly CloneIdMapping[], kind: CloneIdKind, sourceId: string, ownerId?: string): string {
  const match = idMap.find((entry) => entry.kind === kind && entry.sourceId === sourceId && entry.ownerId === ownerId);
  if (!match) throw new Error(`Missing ${kind} mapping for ${sourceId} owned by ${ownerId ?? "<project>"}.`);
  return match.targetId;
}

function apiAsset(id: string): ApiAsset {
  const input = contractFixture();
  input.contract.id = id;
  return ApiAssetSchema.parse(input);
}

function components(): ComponentAsset[] {
  return componentFixtures().map((item) => ComponentAssetSchema.parse(item));
}

function modelAsset(id = modelId): ModelAsset {
  return ModelAssetSchema.parse({ ...modelAssetFixture(), id });
}

function sourceProject() {
  const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0].projects[0];
  const collection = project.collections[0];
  const api = collection.apis[0];
  const secondApi = apiAsset("00000000-0000-4000-8000-000000000201");
  const nestedApi = apiAsset("00000000-0000-4000-8000-000000000203");
  const sourceProjectId = project.id;

  api.cases[0].id = "case-shared";
  api.cases[0].scope = "base";
  api.cases[0].parameters.literal = api.contract.id;
  api.cases[0].preOperations = [{ id: "case-operation", type: "script", content: `keep ${api.contract.id}` }];
  api.cases[0].postOperations = [];
  api.cases[0].assertions = [{ id: "case-assertion", target: "status", op: "eq", expected: "201" }];
  const otherScope = structuredClone(api.cases[0]);
  otherScope.scope = "local";
  api.cases = [api.cases[0], otherScope];
  secondApi.cases = [{ ...structuredClone(api.cases[0]), scope: "local" }];
  nestedApi.cases = [{ ...structuredClone(api.cases[0]), id: "nested-case", scope: "base" }];
  secondApi.documentation = `literal ${api.contract.id}`;
  collection.apis = [api, secondApi];
  collection.folders[0].folders[0].apis = [nestedApi];

  const [parameter, auth, response, example] = components();
  if (parameter.kind !== "parameter" || auth.kind !== "auth" || response.kind !== "response" || example.kind !== "example") {
    throw new Error("Component fixtures must have their declared kinds.");
  }
  parameter.definition.schema = { kind: "modelRef", modelId };
  response.definition.content["application/json"].examples = [{
    kind: "componentRef",
    id: "00000000-0000-4000-8000-000000000301",
    componentId: example.id,
    expectedKind: "example",
  }];
  auth.definition = { kind: "bearer", token: { id: "shared-secret", policy: "test-auto" } };
  project.models = [modelAsset()];
  project.components = [parameter, auth, response, example];

  const request = api.contract.request;
  if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
  request.baseUrl = `https://example.test/${collection.id}`;
  request.pathParams = [ParameterBindingSchema.parse(parameterReference(parameter.id, "00000000-0000-4000-8000-000000000302"))];
  request.query = [{
    kind: "inline",
    id: "00000000-0000-4000-8000-000000000303",
    name: "limit",
    schema: { kind: "scalar", type: "integer" },
    required: false,
    enabled: true,
    description: "limit",
    value: api.contract.id,
  }];
  request.auth = { kind: "componentRef", componentId: auth.id, expectedKind: "auth" };
  request.body = {
    kind: "json",
    content: `literal ${api.contract.id}`,
    schema: { kind: "modelRef", modelId },
  };
  api.cases[0].requestOverride = {
    ...structuredClone(request),
    path: "/case-only",
    pathParams: [ParameterBindingSchema.parse(parameterReference(parameter.id, "00000000-0000-4000-8000-000000000308"))],
    auth: { kind: "bearer", token: { id: "case-secret", policy: "test-auto" } },
    body: { kind: "urlencoded", fields: [{ id: "00000000-0000-4000-8000-000000000309", name: "case", value: "local", enabled: true }] },
  };
  api.contract.responses = [
    { kind: "componentRef", id: "00000000-0000-4000-8000-000000000304", componentId: response.id, expectedKind: "response" },
    {
      kind: "inline",
      id: "00000000-0000-4000-8000-000000000305",
      status: "201",
      description: "created",
      headers: {},
      content: { "application/json": { examples: [{
        kind: "componentRef",
        id: "00000000-0000-4000-8000-000000000306",
        componentId: example.id,
        expectedKind: "example",
      }] } },
    },
  ];
  api.documentation = `literal ${api.contract.id}`;
  const secondRequest = secondApi.contract.request;
  if (secondRequest.protocol !== "http") throw new Error("Fixture must use HTTP.");
  secondRequest.auth = { kind: "bearer", token: { id: "shared-secret", policy: "test-auto" } };
  secondRequest.body = { kind: "urlencoded", fields: [{
    id: "00000000-0000-4000-8000-000000000307",
    name: "text",
    value: api.contract.id,
    enabled: true,
  }] };

  project.environments[0].baseUrls = { [collection.id]: `https://service.test/${api.contract.id}` };
  project.environments.push({
    id: "00000000-0000-4000-8000-000000000202",
    name: "ci",
    extends: "local",
    variables: { marker: api.contract.id },
    baseUrls: { [collection.id]: "https://ci.example.test" },
  });
  collection.preOperations = [{ id: "collection-operation", type: "script", content: `literal ${api.contract.id}` }];
  collection.folders[0].preOperations = [{ id: "folder-operation", type: "script", content: "folder" }];
  project.workflows[0].nodes = [
    { id: "node-api-one", kind: "request", apiId: api.contract.id, caseId: "case-shared", label: api.contract.id },
    { id: "node-api-two", kind: "request", apiId: secondApi.contract.id, caseId: "case-shared" },
    { id: "node-api-nested", kind: "request", apiId: nestedApi.contract.id, caseId: "nested-case" },
  ];
  project.workflows[0].edges = [
    { id: "edge-one", from: "node-api-one", to: "node-api-two", condition: "literal node-api-one" },
    { id: "edge-nested", from: "node-api-two", to: "node-api-nested" },
  ];
  project.variables = { marker: api.contract.id };

  return {
    project,
    sourceProjectId,
    collectionId: collection.id,
    apiId: api.contract.id,
    secondApiId: secondApi.contract.id,
    nestedApiId: nestedApi.contract.id,
  };
}

describe("asset cloning", () => {
  it("remaps the saved mock rule, contract, response, and example references", () => {
    const source = createMockConfiguredProject();
    source.mock.rules[0]!.conditions = [{ source: "query", op: "equals", name: "view", value: "source" }];
    const result = cloneProjectDefinition(source, { newId: deterministicIdFactory() });
    const sourceMock = source.mock;
    const clonedMock = result.project.mock;
    if (!clonedMock) throw new Error("Cloned project must preserve mock configuration.");
    const sourceRule = sourceMock.rules[0]!;
    const clonedRule = clonedMock.rules[0]!;
    const clonedContractId = mapped(result.idMap, "contract", sourceRule.contractId, source.id);
    const clonedResponseId = mapped(result.idMap, "responseInstance", sourceRule.responseBindingId, sourceRule.contractId);
    const clonedExampleId = mapped(result.idMap, "exampleInstance", mockFixtureIds.example, sourceRule.contractId);

    expect(clonedMock.enabledContractIds).toEqual([clonedContractId]);
    expect(clonedRule.id).toBe(mapped(result.idMap, "mockRule" as CloneIdKind, sourceRule.id, source.id));
    expect(clonedRule.id).not.toBe(sourceRule.id);
    expect(clonedRule.contractId).toBe(clonedContractId);
    expect(clonedRule.responseBindingId).toBe(clonedResponseId);
    expect(clonedRule.source).toEqual({ kind: "example", exampleBindingId: clonedExampleId });
    expect(clonedRule.source).not.toEqual(sourceRule.source);
    expect(clonedRule.conditions).not.toBe(sourceRule.conditions);
    const sourceCondition = sourceRule.conditions[0];
    const clonedCondition = clonedRule.conditions[0];
    if (sourceCondition?.op !== "equals" || clonedCondition?.op !== "equals") {
      throw new Error("Mock fixture conditions must be equals conditions.");
    }
    expect(clonedCondition).not.toBe(sourceCondition);
    clonedCondition.value = "clone-only";
    clonedRule.conditions.push({ source: "body", op: "exists", pointer: "/item" });
    expect(sourceCondition.value).toBe("source");
    expect(sourceRule.conditions).toEqual([{ source: "query", op: "equals", name: "view", value: "source" }]);
  });

  it("clones a complete project in two passes and rewrites every declared identity and typed reference", () => {
    const source = sourceProject();
    const before = structuredClone(source.project);
    const result = cloneProjectDefinition(source.project, { newId: deterministicIdFactory() });
    const cloned = result.project;
    const clonedCollectionId = mapped(result.idMap, "collection", source.collectionId, source.sourceProjectId);
    const clonedApiId = mapped(result.idMap, "contract", source.apiId, source.sourceProjectId);
    const clonedSecondApiId = mapped(result.idMap, "contract", source.secondApiId, source.sourceProjectId);
    const clonedNestedApiId = mapped(result.idMap, "contract", source.nestedApiId, source.sourceProjectId);
    const clonedNestedCaseId = mapped(result.idMap, "case", "nested-case", source.nestedApiId);
    const clonedCaseId = mapped(result.idMap, "case", "case-shared", source.apiId);
    const clonedSecondCaseId = mapped(result.idMap, "case", "case-shared", source.secondApiId);
    const clonedModelId = mapped(result.idMap, "model", modelId, source.sourceProjectId);
    const clonedParameterId = mapped(result.idMap, "component", componentIds.parameter, source.sourceProjectId);
    const clonedAuthId = mapped(result.idMap, "component", componentIds.auth, source.sourceProjectId);
    const clonedResponseId = mapped(result.idMap, "component", componentIds.response, source.sourceProjectId);
    const clonedExampleId = mapped(result.idMap, "component", componentIds.example, source.sourceProjectId);
    const clonedSecretId = mapped(result.idMap, "secretRef", "shared-secret", source.sourceProjectId);
    const clonedCaseSecretId = mapped(result.idMap, "secretRef", "case-secret", source.sourceProjectId);
    const clonedWorkflowId = mapped(result.idMap, "workflow", "workflow-fixture", source.sourceProjectId);
    const clonedNodeOneId = mapped(result.idMap, "workflowNode", "node-api-one", "workflow-fixture");
    const clonedNodeTwoId = mapped(result.idMap, "workflowNode", "node-api-two", "workflow-fixture");
    const clonedEdgeId = mapped(result.idMap, "workflowEdge", "edge-one", "workflow-fixture");
    const clonedApi = cloned.collections[0].apis[0];
    const clonedRequest = clonedApi.contract.request;
    const clonedCaseRequest = clonedApi.cases[0].requestOverride;
    if (!clonedCaseRequest || clonedCaseRequest.protocol !== "http") {
      throw new Error("The cloned case override must preserve the HTTP request.");
    }

    expect(cloned.id).not.toBe(source.project.id);
    expect(cloned.collections[0].id).toBe(clonedCollectionId);
    expect(cloned.environments[0].id).not.toBe(source.project.environments[0].id);
    expect(cloned.environments.map((environment) => environment.name)).toEqual(["local", "ci"]);
    expect(cloned.environments[1].extends).toBe("local");
    expect(cloned.environments[0].baseUrls).toEqual({
      [clonedCollectionId]: `https://service.test/${source.apiId}`,
    });
    expect(clonedApi.contract.id).toBe(clonedApiId);
    expect(clonedApi.cases.map((testCase) => testCase.id)).toEqual([clonedCaseId, clonedCaseId]);
    expect(clonedApi.cases.map((testCase) => testCase.scope)).toEqual(["base", "local"]);
    expect(clonedApi.cases[0].preOperations[0].id).not.toBe("case-operation");
    expect(clonedApi.cases[0].assertions[0].id).not.toBe("case-assertion");
    expect(clonedCaseRequest.path).toBe("/case-only");
    expect(clonedCaseRequest.pathParams[0]?.id).not.toBe("00000000-0000-4000-8000-000000000308");
    expect(clonedCaseRequest.pathParams[0]).toMatchObject({ componentId: clonedParameterId });
    expect(clonedCaseRequest.auth).toEqual({ kind: "bearer", token: { id: clonedCaseSecretId, policy: "test-auto" } });
    expect(clonedCaseRequest.body).toMatchObject({
      kind: "urlencoded",
      fields: [{ id: expect.not.stringMatching("00000000-0000-4000-8000-000000000309") }],
    });
    expect(clonedSecondApiId).not.toBe(clonedApiId);
    expect(clonedSecondCaseId).not.toBe(clonedCaseId);
    expect(cloned.collections[0].apis[1].cases[0].id).toBe(clonedSecondCaseId);
    expect(cloned.collections[0].preOperations[0].id).not.toBe("collection-operation");
    expect(cloned.collections[0].folders[0].id).not.toBe("00000000-0000-4000-8000-000000000021");
    expect(cloned.collections[0].folders[0].preOperations[0].id).not.toBe("folder-operation");
    expect(cloned.collections[0].folders[0].folders[0].id).not.toBe("00000000-0000-4000-8000-000000000025");
    expect(cloned.collections[0].folders[0].folders[0].apis[0].contract.id).toBe(clonedNestedApiId);
    expect(cloned.collections[0].folders[0].folders[0].apis[0].cases[0].id).toBe(clonedNestedCaseId);
    expect(cloned.models[0].id).toBe(clonedModelId);
    expect(cloned.components.map((component) => component.id)).toEqual([clonedParameterId, clonedAuthId, clonedResponseId, clonedExampleId]);
    expect(cloned.components[0]).toMatchObject({ kind: "parameter", definition: { schema: { kind: "modelRef", modelId: clonedModelId } } });
    if (clonedRequest.protocol !== "http") throw new Error("Cloned fixture must use HTTP.");
    expect(clonedRequest.pathParams[0]).toMatchObject({ kind: "componentRef", componentId: clonedParameterId });
    expect(clonedRequest.pathParams[0].id).not.toBe("00000000-0000-4000-8000-000000000302");
    expect(clonedRequest.query[0].id).not.toBe("00000000-0000-4000-8000-000000000303");
    expect(clonedRequest.auth).toMatchObject({ kind: "componentRef", componentId: clonedAuthId });
    const clonedSecondRequest = cloned.collections[0].apis[1].contract.request;
    if (clonedSecondRequest.protocol !== "http") throw new Error("Cloned fixture must be HTTP.");
    expect(clonedRequest.body).toMatchObject({ kind: "json", schema: { kind: "modelRef", modelId: clonedModelId } });
    expect(clonedSecondRequest.body).toMatchObject({ kind: "urlencoded", fields: [{ id: expect.not.stringMatching(/^00000000-0000-4000-8000-000000000307$/) }] });
    expect(clonedApi.contract.responses[0]).toMatchObject({ kind: "componentRef", componentId: clonedResponseId });
    expect(clonedApi.contract.responses[0].id).not.toBe("00000000-0000-4000-8000-000000000304");
    expect(clonedApi.contract.responses[1]).toMatchObject({
      kind: "inline",
      content: { "application/json": { examples: [{ kind: "componentRef", componentId: clonedExampleId }] } },
    });
    expect(clonedApi.contract.responses[1].id).not.toBe("00000000-0000-4000-8000-000000000305");
    const responseExample = clonedApi.contract.responses[1];
    if (responseExample.kind !== "inline") throw new Error("Fixture response must be inline.");
    expect(responseExample.content["application/json"].examples[0].id).not.toBe("00000000-0000-4000-8000-000000000306");
    const sharedSecretFromRequest = clonedSecondRequest.auth;
    const sharedSecretFromComponent = cloned.components[1];
    if (sharedSecretFromRequest.kind !== "bearer" || sharedSecretFromComponent.kind !== "auth" || sharedSecretFromComponent.definition.kind !== "bearer") {
      throw new Error("Fixture secret references must be bearer bindings.");
    }
    expect(sharedSecretFromRequest.token.id).not.toBe("shared-secret");
    expect(sharedSecretFromRequest.token.id).toBe(clonedSecretId);
    expect(sharedSecretFromRequest.token.id).toBe(sharedSecretFromComponent.definition.token.id);
    expect(sharedSecretFromRequest.token.policy).toBe("test-auto");
    expect(cloned.workflows[0].id).toBe(clonedWorkflowId);
    expect(cloned.workflows[0].nodes[0]).toMatchObject({ apiId: clonedApiId, caseId: clonedCaseId, id: clonedNodeOneId });
    expect(cloned.workflows[0].nodes[1]).toMatchObject({ apiId: clonedSecondApiId, caseId: clonedSecondCaseId, id: clonedNodeTwoId });
    expect(cloned.workflows[0].nodes[2]).toMatchObject({ apiId: clonedNestedApiId, caseId: clonedNestedCaseId });
    expect(cloned.workflows[0].edges[0]).toEqual({ id: clonedEdgeId, from: clonedNodeOneId, to: clonedNodeTwoId, condition: "literal node-api-one" });
    expect(cloned.workflows[0].edges[1]).toMatchObject({ from: clonedNodeTwoId, to: mapped(result.idMap, "workflowNode", "node-api-nested", "workflow-fixture") });
    expect(cloned.collections[0].apis[0].documentation).toBe(`literal ${source.apiId}`);
    expect(clonedRequest.baseUrl).toBe(`https://example.test/${source.collectionId}`);
    expect(cloned.collections[0].apis[0].cases[0].parameters.literal).toBe(source.apiId);
    expect(cloned.collections[0].preOperations[0].content).toBe(`literal ${source.apiId}`);
    expect(cloned.environments[1].variables.marker).toBe(source.apiId);
    expect(source.project).toEqual(before);
  });

  it("clones only an asset bundle, rewrites its dependency IDs, and leaves the source untouched", () => {
    const api = apiAsset("00000000-0000-4000-8000-000000000401");
    const apiRequest = api.contract.request;
    if (apiRequest.protocol !== "http") throw new Error("Fixture must use HTTP.");
    apiRequest.query = [ParameterBindingSchema.parse(parameterReference(componentIds.parameter, "00000000-0000-4000-8000-000000000402"))];
    apiRequest.body = {
      kind: "multipart",
      entries: [{
        kind: "file",
        id: "00000000-0000-4000-8000-000000000403",
        name: "attachment",
        file: { path: "fixtures/00000000-0000-4000-8000-000000000401.bin" },
        contentType: "application/octet-stream",
        enabled: true,
      }],
    };
    apiRequest.auth = { kind: "bearer", token: { id: "bundle-secret", policy: "test-auto" } };
    const [parameter, auth, response, example] = components();
    if (parameter.kind !== "parameter" || auth.kind !== "auth" || response.kind !== "response" || example.kind !== "example") {
      throw new Error("Fixture component kinds changed.");
    }
    parameter.definition.schema = { kind: "modelRef", modelId };
    auth.definition = { kind: "bearer", token: { id: "bundle-secret", policy: "test-auto" } };
    const bundle = { assets: [api], models: [modelAsset()], components: [parameter, auth, response, example] };
    const before = structuredClone(bundle);
    const result = cloneAssetBundle(bundle, { newProjectId, newId: deterministicIdFactory() });
    const clonedApi = result.bundle.assets[0];
    const clonedRequest = clonedApi.contract.request;

    expect(result.bundle).not.toHaveProperty("projectId");
    expect(clonedApi.contract.id).not.toBe(api.contract.id);
    expect(result.bundle.models[0].id).not.toBe(modelId);
    expect(result.bundle.components[0].id).not.toBe(parameter.id);
    expect(clonedRequest.protocol).toBe("http");
    if (clonedRequest.protocol !== "http") throw new Error("Cloned fixture must use HTTP.");
    expect(clonedRequest.query[0]).toMatchObject({ componentId: result.bundle.components[0].id });
    expect(result.bundle.components[0]).toMatchObject({ definition: { schema: { kind: "modelRef", modelId: result.bundle.models[0].id } } });
    expect(clonedRequest.body).toMatchObject({
      kind: "multipart",
      entries: [{ id: expect.not.stringMatching(/^00000000-0000-4000-8000-000000000403$/), file: { path: "fixtures/00000000-0000-4000-8000-000000000401.bin" } }],
    });
    expect(clonedRequest.auth).toMatchObject({ kind: "bearer" });
    if (clonedRequest.auth.kind !== "bearer") throw new Error("Fixture secret reference must be inline.");
    expect(clonedRequest.auth.token.id).not.toBe("bundle-secret");
    expect(result.bundle.components[1]).toMatchObject({ kind: "auth", definition: { kind: "bearer", token: { id: clonedRequest.auth.token.id } } });
    expect(bundle).toEqual(before);
    expect(result.idMap).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "contract", sourceId: api.contract.id, targetId: clonedApi.contract.id }),
      expect.objectContaining({ kind: "model", sourceId: modelId, targetId: result.bundle.models[0].id }),
      expect.objectContaining({ kind: "component", sourceId: parameter.id, targetId: result.bundle.components[0].id }),
      expect.objectContaining({ kind: "secretRef", sourceId: "bundle-secret", ownerId: newProjectId, targetId: clonedRequest.auth.token.id }),
    ]));
  });

  it("supports a zero-argument ID factory while keeping owner-scoped case identities distinct", () => {
    const source = sourceProject();
    const result = cloneProjectDefinition(source.project, { newId: deterministicIdFactory() });
    const sameCaseAcrossScopes = result.idMap.filter((entry) => entry.kind === "case" && entry.sourceId === "case-shared" && entry.ownerId === source.apiId);

    expect(sameCaseAcrossScopes).toHaveLength(1);
    expect(result.project.collections[0].apis[0].cases[0].id).toBe(result.project.collections[0].apis[0].cases[1].id);
    expect(result.project.collections[0].apis[0].cases[0].id).not.toBe(result.project.collections[0].apis[1].cases[0].id);
  });

  it("clones shared host objects independently for project and bundle owner identities", () => {
    const source = sourceProject();
    const firstApi = source.project.collections[0].apis[0];
    const secondApi = source.project.collections[0].apis[1];
    const sharedParameter = firstApi.contract.request.query[0];
    firstApi.contract.request.query = [sharedParameter];
    secondApi.contract.request.query = [sharedParameter];
    firstApi.cases[1].preOperations = firstApi.cases[0].preOperations;
    const before = structuredClone(source.project);

    const projectResult = cloneProjectDefinition(source.project, { newId: deterministicIdFactory() });
    const clonedApis = projectResult.project.collections[0].apis;
    const firstParameterId = mapped(projectResult.idMap, "parameterInstance", sharedParameter.id, firstApi.contract.id);
    const secondParameterId = mapped(projectResult.idMap, "parameterInstance", sharedParameter.id, secondApi.contract.id);
    const scopedOperationMappings = projectResult.idMap.filter((entry) => entry.kind === "operation"
      && entry.sourceId === "case-operation"
      && entry.ownerId?.includes(firstApi.contract.id)
      && entry.ownerId.includes("case-shared"));

    expect(clonedApis[0].contract.request.query[0]).not.toBe(clonedApis[1].contract.request.query[0]);
    expect(clonedApis[0].contract.request.query[0].id).toBe(firstParameterId);
    expect(clonedApis[1].contract.request.query[0].id).toBe(secondParameterId);
    expect(firstParameterId).not.toBe(secondParameterId);
    expect(clonedApis[0].cases[0].preOperations[0]).not.toBe(clonedApis[0].cases[1].preOperations[0]);
    expect(scopedOperationMappings).toHaveLength(2);
    expect(clonedApis[0].cases[0].preOperations[0].id).toBe(scopedOperationMappings[0].targetId);
    expect(clonedApis[0].cases[1].preOperations[0].id).toBe(scopedOperationMappings[1].targetId);
    expect(source.project).toEqual(before);

    const firstBundleApi = apiAsset("00000000-0000-4000-8000-000000000501");
    const secondBundleApi = apiAsset("00000000-0000-4000-8000-000000000502");
    const bundleParameter = sharedParameter;
    firstBundleApi.contract.request.query = [bundleParameter];
    secondBundleApi.contract.request.query = [bundleParameter];
    const bundle = { assets: [firstBundleApi, secondBundleApi], models: [], components: [] };
    const beforeBundle = structuredClone(bundle);
    const bundleResult = cloneAssetBundle(bundle, { newProjectId, newId: deterministicIdFactory() });
    const firstBundleParameterId = mapped(bundleResult.idMap, "parameterInstance", bundleParameter.id, firstBundleApi.contract.id);
    const secondBundleParameterId = mapped(bundleResult.idMap, "parameterInstance", bundleParameter.id, secondBundleApi.contract.id);

    expect(bundleResult.bundle.assets[0].contract.request.query[0]).not.toBe(bundleResult.bundle.assets[1].contract.request.query[0]);
    expect(bundleResult.bundle.assets[0].contract.request.query[0].id).toBe(firstBundleParameterId);
    expect(bundleResult.bundle.assets[1].contract.request.query[0].id).toBe(secondBundleParameterId);
    expect(bundleResult.bundle.assets).toHaveLength(2);
    expect(bundleResult.bundle.models).toEqual([]);
    expect(bundleResult.bundle.components).toEqual([]);
    expect(bundle).toEqual(beforeBundle);
  });

  it("rejects a direct schema-object cycle while allowing references between model IDs", () => {
    const source = sourceProject();
    const cyclic = { kind: "array" as const } as { kind: "array"; items?: unknown };
    cyclic.items = cyclic;
    source.project.models[0].schema = cyclic as unknown as typeof source.project.models[number]["schema"];

    expect(() => cloneProjectDefinition(source.project, { newId: deterministicIdFactory() })).toThrow(/direct object cycle/i);
  });
});
