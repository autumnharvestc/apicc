import type {
  ApiAsset,
  ApiRequest,
  AuthBinding,
  ComponentAsset,
  ExampleBinding,
  ParameterBinding,
  ResponseBinding,
  ResponseDefinition,
  SecretRef,
} from "../contract/model.js";
import { cloneDefinitionValue, type AssetBundle } from "./context.js";
import type { ContractCollection, ContractFolder, ContractProject } from "../contract/workspace.js";
import type { Workflow } from "../workflow/model.js";
import type { SchemaNode } from "../contract/schemaNode.js";

export type CloneIdKind =
  | "project" | "collection" | "folder" | "environment" | "workflow" | "workflowNode" | "workflowEdge"
  | "contract" | "case" | "model" | "component" | "operation" | "assertion"
  | "parameterInstance" | "responseInstance" | "exampleInstance" | "requestEntry" | "secretRef";

export interface CloneIdMapping {
  kind: CloneIdKind;
  sourceId: string;
  targetId: string;
  ownerId?: string;
}

export type CloneIdFactory = (kind: CloneIdKind, sourceId: string, ownerId?: string) => string;

export interface ClonedProjectDefinition {
  project: ContractProject;
  idMap: CloneIdMapping[];
}

export interface ClonedAssetBundle {
  bundle: AssetBundle;
  idMap: CloneIdMapping[];
}

class IdMapper {
  private readonly ids = new Map<string, string>();
  private readonly mappings: CloneIdMapping[] = [];

  constructor(private readonly newId: CloneIdFactory) {}

  declare(kind: CloneIdKind, sourceId: string, ownerId?: string): string {
    const identity = this.identity(kind, sourceId, ownerId);
    const existing = this.ids.get(identity);
    if (existing !== undefined) return existing;

    const targetId = this.newId(kind, sourceId, ownerId);
    if (targetId === sourceId) throw new Error(`The ID factory reused the source ID for ${kind}:${sourceId}.`);
    if (this.mappings.some((mapping) => mapping.targetId === targetId)) {
      throw new Error(`The ID factory returned a duplicate target ID for ${kind}:${sourceId}.`);
    }
    this.ids.set(identity, targetId);
    this.mappings.push({ kind, sourceId, targetId, ...(ownerId === undefined ? {} : { ownerId }) });
    return targetId;
  }

  reference(kind: CloneIdKind, sourceId: string, ownerId?: string): string {
    return this.ids.get(this.identity(kind, sourceId, ownerId)) ?? sourceId;
  }

  result(): CloneIdMapping[] {
    return this.mappings.map((mapping) => ({ ...mapping }));
  }

  private identity(kind: CloneIdKind, sourceId: string, ownerId?: string): string {
    return JSON.stringify([kind, ownerId ?? null, sourceId]);
  }
}

export function cloneProjectDefinition(
  project: ContractProject,
  options: { newId: CloneIdFactory },
): ClonedProjectDefinition {
  const cloned = cloneDefinitionValue(project);
  const mapper = new IdMapper(options.newId);
  mapper.declare("project", project.id);
  collectProjectMappings(project, mapper);
  rewriteProject(project, cloned, mapper);
  return { project: cloned, idMap: mapper.result() };
}

export function cloneAssetBundle(
  bundle: AssetBundle,
  options: { newProjectId: string; newId: CloneIdFactory },
): ClonedAssetBundle {
  const cloned = cloneDefinitionValue(bundle);
  const mapper = new IdMapper(options.newId);
  for (const asset of bundle.assets) collectApiMappings(asset, options.newProjectId, mapper);
  for (const model of bundle.models) mapper.declare("model", model.id, options.newProjectId);
  for (const component of bundle.components) collectComponentMappings(component, options.newProjectId, mapper);

  bundle.assets.forEach((asset, index) => rewriteApiAsset(asset, cloned.assets[index], options.newProjectId, mapper));
  bundle.models.forEach((model, index) => {
    cloned.models[index].id = mapper.reference("model", model.id, options.newProjectId);
    rewriteSchema(cloned.models[index].schema, options.newProjectId, mapper);
  });
  bundle.components.forEach((component, index) => rewriteComponent(component, cloned.components[index], options.newProjectId, mapper));
  return { bundle: cloned, idMap: mapper.result() };
}

function collectProjectMappings(project: ContractProject, mapper: IdMapper): void {
  for (const environment of project.environments) mapper.declare("environment", environment.id, project.id);
  for (const collection of project.collections) collectCollectionMappings(collection, project.id, collectionScope(collection.id), mapper);
  for (const workflow of project.workflows) collectWorkflowMappings(workflow, project.id, mapper);
  for (const model of project.models) mapper.declare("model", model.id, project.id);
  for (const component of project.components) collectComponentMappings(component, project.id, mapper);
}

function collectCollectionMappings(collection: ContractCollection, projectId: string, scope: string, mapper: IdMapper): void {
  mapper.declare("collection", collection.id, projectId);
  collectOperations(collection.preOperations, operationScope(scope, "pre"), mapper);
  collectOperations(collection.postOperations, operationScope(scope, "post"), mapper);
  for (const folder of collection.folders) collectFolderMappings(folder, scope, projectId, mapper);
  for (const asset of collection.apis) collectApiMappings(asset, projectId, mapper);
}

function collectFolderMappings(folder: ContractFolder, parentScope: string, projectId: string, mapper: IdMapper): void {
  mapper.declare("folder", folder.id, parentScope);
  const scope = folderScope(parentScope, folder.id);
  collectOperations(folder.preOperations, operationScope(scope, "pre"), mapper);
  collectOperations(folder.postOperations, operationScope(scope, "post"), mapper);
  for (const child of folder.folders) collectFolderMappings(child, scope, projectId, mapper);
  for (const asset of folder.apis) collectApiMappings(asset, projectId, mapper);
}

function collectApiMappings(asset: ApiAsset, projectId: string, mapper: IdMapper): void {
  const contractId = asset.contract.id;
  mapper.declare("contract", contractId, projectId);
  for (const testCase of asset.cases) {
    mapper.declare("case", testCase.id, contractId);
    const caseScope = logicalCaseScope(contractId, testCase.id, testCase.scope);
    collectOperations(testCase.preOperations, operationScope(caseScope, "pre"), mapper);
    collectOperations(testCase.postOperations, operationScope(caseScope, "post"), mapper);
    for (const assertion of testCase.assertions) mapper.declare("assertion", assertion.id, caseScope);
    if (testCase.requestOverride) collectRequestMappings(testCase.requestOverride, contractId, projectId, mapper);
  }

  collectRequestMappings(asset.contract.request, contractId, projectId, mapper);
  for (const response of asset.contract.responses) collectResponseMapping(response, contractId, projectId, mapper);
}

function collectRequestMappings(request: ApiRequest, contractId: string, projectId: string, mapper: IdMapper): void {
  for (const parameter of request.pathParams) collectParameterMapping(parameter, contractId, mapper);
  for (const parameter of request.query) collectParameterMapping(parameter, contractId, mapper);
  for (const parameter of request.headers) collectParameterMapping(parameter, contractId, mapper);
  for (const parameter of request.cookies) collectParameterMapping(parameter, contractId, mapper);
  collectAuthMapping(request.auth, projectId, mapper);
  if (request.protocol === "http") collectRequestBodyMappings(request, contractId, mapper);
}

function collectParameterMapping(parameter: ParameterBinding, ownerId: string, mapper: IdMapper): void {
  mapper.declare("parameterInstance", parameter.id, ownerId);
}

function collectAuthMapping(auth: AuthBinding, projectId: string, mapper: IdMapper): void {
  if (auth.kind === "bearer") collectSecretMapping(auth.token, projectId, mapper);
  else if (auth.kind === "basic") collectSecretMapping(auth.password, projectId, mapper);
  else if (auth.kind === "apikey") collectSecretMapping(auth.value, projectId, mapper);
}

function collectSecretMapping(secret: SecretRef, projectId: string, mapper: IdMapper): void {
  mapper.declare("secretRef", secret.id, projectId);
}

function collectRequestBodyMappings(request: ApiRequest & { protocol: "http" }, ownerId: string, mapper: IdMapper): void {
  if (request.body.kind === "urlencoded") {
    for (const field of request.body.fields) mapper.declare("requestEntry", field.id, ownerId);
  } else if (request.body.kind === "multipart") {
    for (const entry of request.body.entries) mapper.declare("requestEntry", entry.id, ownerId);
  }
}

function collectResponseMapping(response: ResponseBinding, ownerId: string, projectId: string, mapper: IdMapper): void {
  mapper.declare("responseInstance", response.id, ownerId);
  if (response.kind === "componentRef") return;
  collectResponseDefinitionMappings(response, ownerId, mapper);
}

function collectResponseDefinitionMappings(response: ResponseDefinition, ownerId: string, mapper: IdMapper): void {
  for (const content of Object.values(response.content)) {
    for (const example of content.examples) collectExampleMapping(example, ownerId, mapper);
  }
}

function collectExampleMapping(example: ExampleBinding, ownerId: string, mapper: IdMapper): void {
  mapper.declare("exampleInstance", example.id, ownerId);
}

function collectComponentMappings(component: ComponentAsset, projectId: string, mapper: IdMapper): void {
  mapper.declare("component", component.id, projectId);
  if (component.kind === "auth") collectAuthMapping(component.definition, projectId, mapper);
  else if (component.kind === "response") collectResponseDefinitionMappings(component.definition, component.id, mapper);
}

function collectOperations(operations: ContractProject["collections"][number]["preOperations"], owner: string, mapper: IdMapper): void {
  for (const operation of operations) mapper.declare("operation", operation.id, owner);
}

function collectWorkflowMappings(workflow: Workflow, projectId: string, mapper: IdMapper): void {
  mapper.declare("workflow", workflow.id, projectId);
  for (const node of workflow.nodes) mapper.declare("workflowNode", node.id, workflow.id);
  for (const edge of workflow.edges) mapper.declare("workflowEdge", edge.id, workflow.id);
}

function rewriteProject(source: ContractProject, target: ContractProject, mapper: IdMapper): void {
  target.id = mapper.reference("project", source.id);
  source.environments.forEach((environment, index) => {
    target.environments[index].id = mapper.reference("environment", environment.id, source.id);
    target.environments[index].baseUrls = remapCollectionKeys(environment.baseUrls, source.id, mapper);
  });
  source.collections.forEach((collection, index) => rewriteCollection(collection, target.collections[index], source.id, mapper, collectionScope(collection.id)));
  source.workflows.forEach((workflow, index) => rewriteWorkflow(workflow, target.workflows[index], source.id, mapper));
  source.models.forEach((model, index) => {
    target.models[index].id = mapper.reference("model", model.id, source.id);
    rewriteSchema(target.models[index].schema, source.id, mapper);
  });
  source.components.forEach((component, index) => rewriteComponent(component, target.components[index], source.id, mapper));
}

function rewriteCollection(source: ContractCollection, target: ContractCollection, projectId: string, mapper: IdMapper, scope: string): void {
  target.preOperations.forEach((operation, index) => {
    operation.id = mapper.reference("operation", source.preOperations[index].id, operationScope(scope, "pre"));
  });
  target.postOperations.forEach((operation, index) => {
    operation.id = mapper.reference("operation", source.postOperations[index].id, operationScope(scope, "post"));
  });
  source.folders.forEach((folder, index) => rewriteFolder(folder, target.folders[index], projectId, mapper, scope));
  source.apis.forEach((asset, index) => rewriteApiAsset(asset, target.apis[index], projectId, mapper));
  target.id = mapper.reference("collection", source.id, projectId);
}

function rewriteFolder(source: ContractFolder, target: ContractFolder, projectId: string, mapper: IdMapper, parentScope: string): void {
  const scope = folderScope(parentScope, source.id);
  target.preOperations.forEach((operation, index) => {
    operation.id = mapper.reference("operation", source.preOperations[index].id, operationScope(scope, "pre"));
  });
  target.postOperations.forEach((operation, index) => {
    operation.id = mapper.reference("operation", source.postOperations[index].id, operationScope(scope, "post"));
  });
  source.folders.forEach((folder, index) => rewriteFolder(folder, target.folders[index], projectId, mapper, scope));
  source.apis.forEach((asset, index) => rewriteApiAsset(asset, target.apis[index], projectId, mapper));
  target.id = mapper.reference("folder", source.id, parentScope);
}

function rewriteApiAsset(source: ApiAsset, target: ApiAsset, projectId: string, mapper: IdMapper): void {
  const contractId = source.contract.id;
  target.contract.id = mapper.reference("contract", contractId, projectId);
  source.cases.forEach((testCase, index) => {
    const outputCase = target.cases[index];
    const caseScope = logicalCaseScope(contractId, testCase.id, testCase.scope);
    outputCase.id = mapper.reference("case", testCase.id, contractId);
    outputCase.preOperations.forEach((operation, operationIndex) => {
      operation.id = mapper.reference("operation", testCase.preOperations[operationIndex].id, operationScope(caseScope, "pre"));
    });
    outputCase.postOperations.forEach((operation, operationIndex) => {
      operation.id = mapper.reference("operation", testCase.postOperations[operationIndex].id, operationScope(caseScope, "post"));
    });
    outputCase.assertions.forEach((assertion, assertionIndex) => {
      assertion.id = mapper.reference("assertion", testCase.assertions[assertionIndex].id, caseScope);
    });
    if (testCase.requestOverride && outputCase.requestOverride) {
      rewriteRequest(testCase.requestOverride, outputCase.requestOverride, contractId, projectId, mapper);
    }
  });

  const sourceRequest = source.contract.request;
  const targetRequest = target.contract.request;
  rewriteRequest(sourceRequest, targetRequest, contractId, projectId, mapper);
  source.contract.responses.forEach((response, index) => rewriteResponseBinding(response, target.contract.responses[index], contractId, projectId, mapper));
}

function rewriteRequest(source: ApiRequest, target: ApiRequest, contractId: string, projectId: string, mapper: IdMapper): void {
  target.pathParams.forEach((parameter, index) => rewriteParameter(source.pathParams[index], parameter, contractId, projectId, mapper));
  target.query.forEach((parameter, index) => rewriteParameter(source.query[index], parameter, contractId, projectId, mapper));
  target.headers.forEach((parameter, index) => rewriteParameter(source.headers[index], parameter, contractId, projectId, mapper));
  target.cookies.forEach((parameter, index) => rewriteParameter(source.cookies[index], parameter, contractId, projectId, mapper));
  rewriteAuth(source.auth, target.auth, projectId, mapper);
  if (source.protocol === "http" && target.protocol === "http") {
    if (source.body.kind === "json" || source.body.kind === "xml" || source.body.kind === "text") {
      if (target.body.kind === source.body.kind && source.body.schema && target.body.schema) rewriteSchema(target.body.schema, projectId, mapper);
    } else if (source.body.kind === "urlencoded" && target.body.kind === "urlencoded") {
      target.body.fields.forEach((field, index) => {
        field.id = mapper.reference("requestEntry", source.body.kind === "urlencoded" ? source.body.fields[index].id : field.id, contractId);
      });
    } else if (source.body.kind === "multipart" && target.body.kind === "multipart") {
      target.body.entries.forEach((entry, index) => {
        entry.id = mapper.reference("requestEntry", source.body.kind === "multipart" ? source.body.entries[index].id : entry.id, contractId);
      });
    }
  }
}

function rewriteParameter(source: ParameterBinding, target: ParameterBinding, contractId: string, projectId: string, mapper: IdMapper): void {
  target.id = mapper.reference("parameterInstance", source.id, contractId);
  if (source.kind === "componentRef" && target.kind === "componentRef") {
    target.componentId = mapper.reference("component", source.componentId, projectId);
  } else if (source.kind === "inline" && target.kind === "inline") {
    rewriteSchema(target.schema, projectId, mapper);
  }
}

function rewriteAuth(source: AuthBinding, target: AuthBinding, projectId: string, mapper: IdMapper): void {
  if (source.kind === "componentRef" && target.kind === "componentRef") {
    target.componentId = mapper.reference("component", source.componentId, projectId);
  } else if (source.kind === "bearer" && target.kind === "bearer") rewriteSecret(source.token, target.token, projectId, mapper);
  else if (source.kind === "basic" && target.kind === "basic") rewriteSecret(source.password, target.password, projectId, mapper);
  else if (source.kind === "apikey" && target.kind === "apikey") rewriteSecret(source.value, target.value, projectId, mapper);
}

function rewriteSecret(source: SecretRef, target: SecretRef, projectId: string, mapper: IdMapper): void {
  target.id = mapper.reference("secretRef", source.id, projectId);
}

function rewriteResponseBinding(source: ResponseBinding, target: ResponseBinding, contractId: string, projectId: string, mapper: IdMapper): void {
  target.id = mapper.reference("responseInstance", source.id, contractId);
  if (source.kind === "componentRef" && target.kind === "componentRef") {
    target.componentId = mapper.reference("component", source.componentId, projectId);
  } else if (source.kind === "inline" && target.kind === "inline") {
    rewriteResponseDefinition(source, target, contractId, projectId, mapper);
  }
}

function rewriteResponseDefinition(source: ResponseDefinition, target: ResponseDefinition, ownerId: string, projectId: string, mapper: IdMapper): void {
  for (const [contentType, sourceContent] of Object.entries(source.content)) {
    const targetContent = target.content[contentType];
    if (!targetContent) continue;
    if (sourceContent.schema && targetContent.schema) rewriteSchema(targetContent.schema, projectId, mapper);
    sourceContent.examples.forEach((example, index) => rewriteExample(example, targetContent.examples[index], ownerId, projectId, mapper));
  }
}

function rewriteExample(source: ExampleBinding, target: ExampleBinding, ownerId: string, projectId: string, mapper: IdMapper): void {
  target.id = mapper.reference("exampleInstance", source.id, ownerId);
  if (source.kind === "componentRef" && target.kind === "componentRef") {
    target.componentId = mapper.reference("component", source.componentId, projectId);
  }
}

function rewriteComponent(source: ComponentAsset, target: ComponentAsset, projectId: string, mapper: IdMapper): void {
  target.id = mapper.reference("component", source.id, projectId);
  if (source.kind === "parameter" && target.kind === "parameter") rewriteSchema(target.definition.schema, projectId, mapper);
  else if (source.kind === "auth" && target.kind === "auth") rewriteAuth(source.definition, target.definition, projectId, mapper);
  else if (source.kind === "response" && target.kind === "response") rewriteResponseDefinition(source.definition, target.definition, source.id, projectId, mapper);
}

function rewriteSchema(schema: SchemaNode, projectId: string, mapper: IdMapper, seen = new WeakSet<object>()): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  if (schema.kind === "modelRef") {
    schema.modelId = mapper.reference("model", schema.modelId, projectId);
  } else if (schema.kind === "object") {
    for (const property of Object.values(schema.properties)) rewriteSchema(property, projectId, mapper, seen);
    if (typeof schema.additionalProperties === "object") rewriteSchema(schema.additionalProperties, projectId, mapper, seen);
  } else if (schema.kind === "array") {
    rewriteSchema(schema.items, projectId, mapper, seen);
  } else if (schema.kind === "allOf" || schema.kind === "oneOf" || schema.kind === "anyOf") {
    for (const variant of schema.variants) rewriteSchema(variant, projectId, mapper, seen);
  }
  seen.delete(schema);
}

function rewriteWorkflow(source: Workflow, target: Workflow, projectId: string, mapper: IdMapper): void {
  target.id = mapper.reference("workflow", source.id, projectId);
  source.nodes.forEach((node, index) => {
    const output = target.nodes[index];
    output.id = mapper.reference("workflowNode", node.id, source.id);
    if (node.apiId !== undefined) output.apiId = mapper.reference("contract", node.apiId, projectId);
    if (node.caseId !== undefined && node.apiId !== undefined) output.caseId = mapper.reference("case", node.caseId, node.apiId);
  });
  source.edges.forEach((edge, index) => {
    const output = target.edges[index];
    output.id = mapper.reference("workflowEdge", edge.id, source.id);
    output.from = mapper.reference("workflowNode", edge.from, source.id);
    output.to = mapper.reference("workflowNode", edge.to, source.id);
  });
}

function remapCollectionKeys(source: Record<string, string>, projectId: string, mapper: IdMapper): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const mappedKey = mapper.reference("collection", key, projectId);
    Object.defineProperty(output, mappedKey, { value, enumerable: true, configurable: true, writable: true });
  }
  return output;
}

function collectionScope(id: string): string {
  return JSON.stringify(["collection", id]);
}

function folderScope(parentScope: string, id: string): string {
  return JSON.stringify([parentScope, "folder", id]);
}

function logicalCaseScope(apiId: string, caseId: string, scope: string): string {
  return JSON.stringify(["api", apiId, "case", caseId, "scope", scope]);
}

function operationScope(parentScope: string, side: "pre" | "post"): string {
  return JSON.stringify([parentScope, "operation", side]);
}
