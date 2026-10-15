import type {
  ApiAsset,
  ApiContract,
  ApiRequest,
  AuthBinding,
  ComponentAsset,
  ExampleBinding,
  ModelAsset,
  ParameterBinding,
  ResponseBinding,
  ResponseContent,
  ResponseDefinition,
} from "../contract/model.js";
import type { SchemaNode } from "../contract/schemaNode.js";

type DeepReadonlyValue<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonlyValue<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonlyValue<T[Key]> }
    : T;

export type AssetReferenceKind = "model" | ComponentAsset["kind"];

export interface AssetReference {
  ownerId: string;
  path: string;
  targetId: string;
  expectedKind: AssetReferenceKind;
}

export interface ProjectAssetGraphInput {
  assets: ApiAsset[];
  models: ModelAsset[];
  components: ComponentAsset[];
}

export function referencesFromApiAsset(asset: ApiAsset): AssetReference[] {
  const references: AssetReference[] = [];
  const { contract } = asset;
  const ownerId = contract.id;
  references.push(...referencesFromApiRequest(contract.request, ownerId));
  asset.cases.forEach((testCase, index) => {
    if (testCase.requestOverride) {
      references.push(...referencesFromApiRequest(testCase.requestOverride, ownerId, `cases[${index}].requestOverride`));
    }
  });
  contract.responses.forEach((response, index) => collectResponseReferences(response, `contract.responses[${index}]`, ownerId, references));
  return references;
}

export function referencesFromApiRequest(
  request: DeepReadonlyValue<ApiRequest>,
  ownerId: string,
  path = "contract.request",
): AssetReference[] {
  const references: AssetReference[] = [];
  collectParameterReferences(request.pathParams, `${path}.pathParams`, ownerId, references);
  collectParameterReferences(request.query, `${path}.query`, ownerId, references);
  collectParameterReferences(request.headers, `${path}.headers`, ownerId, references);
  collectParameterReferences(request.cookies, `${path}.cookies`, ownerId, references);
  collectAuthReference(request.auth, `${path}.auth`, ownerId, references);
  if (request.protocol === "http") {
    const body = request.body;
    if (body.kind === "json" || body.kind === "xml" || body.kind === "text") {
      if (body.schema) collectSchemaReferences(body.schema, `${path}.body.schema`, ownerId, references);
    }
  }
  return references;
}

export function referencesFromModelAsset(asset: ModelAsset, index?: number): AssetReference[] {
  const rootPath = index === undefined ? "schema" : `models[${index}].schema`;
  return collectSchemaReferences(asset.schema, rootPath, asset.id, []);
}

export function referencesFromComponentAsset(asset: ComponentAsset, index?: number): AssetReference[] {
  const rootPath = index === undefined ? "definition" : `components[${index}].definition`;
  const references: AssetReference[] = [];
  if (asset.kind === "parameter") {
    collectSchemaReferences(asset.definition.schema, `${rootPath}.schema`, asset.id, references);
  } else if (asset.kind === "response") {
    collectResponseDefinitionReferences(asset.definition, rootPath, asset.id, references);
  }
  return references;
}

export function collectProjectAssetReferences(input: ProjectAssetGraphInput): AssetReference[] {
  return [
    ...input.assets.flatMap(referencesFromApiAsset),
    ...input.models.flatMap((asset, index) => referencesFromModelAsset(asset, index)),
    ...input.components.flatMap((asset, index) => referencesFromComponentAsset(asset, index)),
  ];
}

function collectParameterReferences(
  parameters: readonly DeepReadonlyValue<ParameterBinding>[],
  path: string,
  ownerId: string,
  references: AssetReference[],
): void {
  parameters.forEach((parameter, index) => {
    if (parameter.kind === "componentRef") {
      references.push({ ownerId, path: `${path}[${index}].componentId`, targetId: parameter.componentId, expectedKind: "parameter" });
    } else {
      collectSchemaReferences(parameter.schema, `${path}[${index}].schema`, ownerId, references);
    }
  });
}

function collectAuthReference(auth: DeepReadonlyValue<AuthBinding>, path: string, ownerId: string, references: AssetReference[]): void {
  if (auth.kind === "componentRef") {
    references.push({ ownerId, path: `${path}.componentId`, targetId: auth.componentId, expectedKind: "auth" });
  }
}

function collectResponseReferences(
  response: ResponseBinding,
  path: string,
  ownerId: string,
  references: AssetReference[],
): void {
  if (response.kind === "componentRef") {
    references.push({ ownerId, path: `${path}.componentId`, targetId: response.componentId, expectedKind: "response" });
  } else {
    collectResponseDefinitionReferences(response, path, ownerId, references);
  }
}

function collectResponseDefinitionReferences(
  response: ResponseDefinition,
  path: string,
  ownerId: string,
  references: AssetReference[],
): void {
  for (const [contentType, content] of Object.entries(response.content)) {
    collectResponseContentReferences(content, `${path}.content[${JSON.stringify(contentType)}]`, ownerId, references);
  }
}

function collectResponseContentReferences(
  content: ResponseContent,
  path: string,
  ownerId: string,
  references: AssetReference[],
): void {
  if (content.schema) collectSchemaReferences(content.schema, `${path}.schema`, ownerId, references);
  content.examples.forEach((example, index) => collectExampleReference(example, `${path}.examples[${index}]`, ownerId, references));
}

function collectExampleReference(example: ExampleBinding, path: string, ownerId: string, references: AssetReference[]): void {
  if (example.kind === "componentRef") {
    references.push({ ownerId, path: `${path}.componentId`, targetId: example.componentId, expectedKind: "example" });
  }
}

function collectSchemaReferences(schema: DeepReadonlyValue<SchemaNode>, path: string, ownerId: string, references: AssetReference[]): AssetReference[] {
  const ancestors = new WeakSet<object>();

  const visit = (node: DeepReadonlyValue<SchemaNode>, nodePath: string): void => {
    if (ancestors.has(node)) return;
    ancestors.add(node);
    try {
      if (node.kind === "modelRef") {
        references.push({ ownerId, path: `${nodePath}.modelId`, targetId: node.modelId, expectedKind: "model" });
      } else if (node.kind === "object") {
        for (const [key, property] of Object.entries(node.properties)) {
          visit(property, `${nodePath}.properties[${JSON.stringify(key)}]`);
        }
        if (typeof node.additionalProperties === "object") {
          visit(node.additionalProperties, `${nodePath}.additionalProperties`);
        }
      } else if (node.kind === "array") {
        visit(node.items, `${nodePath}.items`);
      } else if (node.kind === "allOf" || node.kind === "oneOf" || node.kind === "anyOf") {
        node.variants.forEach((variant, index) => visit(variant, `${nodePath}.variants[${index}]`));
      }
    } finally {
      ancestors.delete(node);
    }
  };

  visit(schema, path);
  return references;
}
