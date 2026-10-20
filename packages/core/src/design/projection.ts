import { z } from "zod";

import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import { HttpMethodSchema } from "../domain/primitives.js";
import {
  referencesFromApiAsset,
  referencesFromComponentAsset,
  referencesFromModelAsset,
  type AssetReference,
} from "../assets/graph.js";
import {
  JsonValueSchema,
  SchemaNodeSchema,
  type ApiAsset,
  type ApiContract,
  type ApiRequest,
  type AuthBinding,
  type ComponentAsset,
  type ExampleBinding,
  type InlineAuthBinding,
  type JsonValue,
  type ModelAsset,
  type ParameterBinding,
  type ParameterLocation,
  type RequestBody,
  type ResponseBinding,
  type ResponseDefinition,
  type SchemaNode,
} from "../contract/model.js";
import type { ContractCollection, ContractFolder, ContractProject } from "../domain/model.js";
import {
  isCredentialFieldName,
  MASKED_SECRET_PLACEHOLDER,
  redactCommonCredentialText,
  redactCredentialValue,
} from "../import/schemaMapping.js";

export const DocumentDiagnosticSchema = z.object({
  severity: z.enum(["warning", "error"]),
  code: z.string(),
  path: z.string(),
  message: z.string(),
  lossy: z.boolean(),
  ownerId: z.string().optional(),
}).strict();
export type DocumentDiagnostic = z.infer<typeof DocumentDiagnosticSchema>;

export const DocumentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("collections"), collectionIds: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("apis"), contractIds: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("tags"), tags: z.array(z.string()) }).strict(),
]);
export type DocumentScope = z.infer<typeof DocumentScopeSchema>;

const DocumentProjectIdentitySchema = z.object({ id: z.string(), name: z.string() }).strict();
const DocumentContainerSchema = z.object({ id: z.string(), name: z.string() }).strict();
const DocumentApiMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  version: z.string(),
  status: z.enum(["draft", "published", "deprecated"]),
}).strict();

const DocumentParameterSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inline"),
    id: z.string(),
    location: z.enum(["path", "query", "header", "cookie"]),
    name: z.string(),
    schema: SchemaNodeSchema,
    required: z.boolean(),
    enabled: z.boolean(),
    description: z.string(),
    value: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal("componentRef"),
    id: z.string(),
    componentId: z.string(),
    expectedKind: z.literal("parameter"),
    location: z.enum(["path", "query", "header", "cookie"]),
    name: z.string(),
    schema: SchemaNodeSchema,
    required: z.boolean(),
    enabled: z.boolean(),
    description: z.string(),
    value: z.string().optional(),
  }).strict(),
  z.object({ kind: z.literal("unresolved"), id: z.string(), componentId: z.string(), expectedKind: z.literal("parameter"), location: z.enum(["path", "query", "header", "cookie"]) }).strict(),
]);

const DocumentAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("bearer"), token: z.string() }).strict(),
  z.object({ kind: z.literal("basic"), username: z.string(), password: z.string() }).strict(),
  z.object({ kind: z.literal("apikey"), name: z.string(), placement: z.enum(["header", "query"]), value: z.string() }).strict(),
  z.object({ kind: z.literal("unresolved"), componentId: z.string(), expectedKind: z.literal("auth") }).strict(),
]);

const DocumentRequestBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.enum(["json", "xml", "text"]), content: z.string(), schema: SchemaNodeSchema.optional() }).strict(),
  z.object({ kind: z.literal("graphql"), query: z.string(), variables: z.string().optional(), operationName: z.string().optional() }).strict(),
  z.object({ kind: z.literal("urlencoded"), fields: z.array(z.object({ id: z.string(), name: z.string(), value: z.string(), enabled: z.boolean() }).strict()) }).strict(),
  z.object({
    kind: z.literal("multipart"),
    entries: z.array(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), id: z.string(), name: z.string(), value: z.string(), enabled: z.boolean() }).strict(),
      z.object({ kind: z.literal("file"), id: z.string(), name: z.string(), bound: z.boolean(), filename: z.string().optional(), contentType: z.string().optional(), enabled: z.boolean() }).strict(),
    ])),
  }).strict(),
  z.object({ kind: z.literal("binary"), bound: z.boolean(), contentType: z.string() }).strict(),
]);

const DocumentRequestCommonShape = {
  baseUrl: z.string(),
  path: z.string(),
  pathParams: z.array(DocumentParameterSchema),
  query: z.array(DocumentParameterSchema),
  headers: z.array(DocumentParameterSchema),
  cookies: z.array(DocumentParameterSchema),
  auth: DocumentAuthSchema,
};
const DocumentRequestSchema = z.discriminatedUnion("protocol", [
  z.object({ protocol: z.literal("http"), ...DocumentRequestCommonShape, method: HttpMethodSchema, body: DocumentRequestBodySchema }).strict(),
  z.object({ protocol: z.literal("websocket"), ...DocumentRequestCommonShape, message: z.string().optional() }).strict(),
  z.object({ protocol: z.literal("soap"), ...DocumentRequestCommonShape, method: z.literal("POST"), envelope: z.string(), soapAction: z.string().optional() }).strict(),
]);

const DocumentExampleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline"), id: z.string(), name: z.string(), value: JsonValueSchema }).strict(),
  z.object({ kind: z.literal("componentRef"), id: z.string(), componentId: z.string(), expectedKind: z.literal("example"), name: z.string(), value: JsonValueSchema }).strict(),
  z.object({ kind: z.literal("unresolved"), id: z.string(), componentId: z.string(), expectedKind: z.literal("example") }).strict(),
]);
const DocumentResponseContentSchema = z.object({
  schema: SchemaNodeSchema.optional(),
  examples: z.array(DocumentExampleSchema),
}).strict();
const DocumentResponseDefinitionSchema = z.object({
  status: z.string(),
  description: z.string(),
  headers: z.record(z.string(), z.string()),
  content: z.record(z.string(), DocumentResponseContentSchema),
}).strict();
const DocumentResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline"), id: z.string(), ...DocumentResponseDefinitionSchema.shape }).strict(),
  z.object({ kind: z.literal("componentRef"), id: z.string(), componentId: z.string(), expectedKind: z.literal("response"), ...DocumentResponseDefinitionSchema.shape }).strict(),
  z.object({ kind: z.literal("unresolved"), id: z.string(), componentId: z.string(), expectedKind: z.literal("response") }).strict(),
]);

const DocumentModelSchema = z.object({ id: z.string(), name: z.string(), description: z.string(), schema: SchemaNodeSchema }).strict();
const DocumentComponentSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("parameter"), name: z.string(), description: z.string(), definition: z.object({
    location: z.enum(["path", "query", "header", "cookie"]), name: z.string(), schema: SchemaNodeSchema, required: z.boolean(), description: z.string(),
  }).strict() }).strict(),
  z.object({ id: z.string(), kind: z.literal("auth"), name: z.string(), description: z.string(), definition: DocumentAuthSchema }).strict(),
  z.object({ id: z.string(), kind: z.literal("response"), name: z.string(), description: z.string(), definition: DocumentResponseDefinitionSchema }).strict(),
  z.object({ id: z.string(), kind: z.literal("example"), name: z.string(), description: z.string(), definition: z.object({ name: z.string(), value: JsonValueSchema }).strict() }).strict(),
]);
const DocumentCaseSummarySchema = z.object({
  name: z.string(),
  scope: z.string(),
  assertionCount: z.number().int().nonnegative(),
}).strict();

const DocumentApiSchema = z.object({
  contractId: z.string(),
  collection: DocumentContainerSchema,
  folders: z.array(DocumentContainerSchema),
  metadata: DocumentApiMetadataSchema,
  request: DocumentRequestSchema,
  responses: z.array(DocumentResponseSchema),
  models: z.array(DocumentModelSchema),
  components: z.array(DocumentComponentSchema),
  documentation: z.string(),
  caseSummaries: z.array(DocumentCaseSummarySchema).default([]),
  diagnostics: z.array(DocumentDiagnosticSchema),
}).strict();

export const DocumentProjectionSchema = z.object({
  formatVersion: z.literal(1),
  sourceProjectRevision: z.string(),
  project: DocumentProjectIdentitySchema,
  apis: z.array(DocumentApiSchema),
  diagnostics: z.array(DocumentDiagnosticSchema),
}).strict();
export type DocumentProjection = z.infer<typeof DocumentProjectionSchema>;
export type DocumentApi = DocumentProjection["apis"][number];

export interface DocumentApiLocation {
  asset: DeepReadonly<ApiAsset>;
  collection: DeepReadonly<ContractCollection>;
  folders: DeepReadonly<ContractFolder>[];
}

export interface DocumentDependencyClosure {
  modelIds: Set<string>;
  componentIds: Set<string>;
  diagnostics: DocumentDiagnostic[];
}

export function buildDocumentProjection(snapshot: ProjectSnapshot, scope: DocumentScope): DocumentProjection {
  const selection = selectDocumentApiLocations(snapshot, scope);
  const apis = selection.locations.map((location) => projectApi(snapshot, location));
  const diagnostics = [...selection.diagnostics, ...apis.flatMap((api) => api.diagnostics)];
  return DocumentProjectionSchema.parse({
    formatVersion: 1,
    sourceProjectRevision: snapshot.definitionRevision,
    project: { id: snapshot.project.id, name: sanitizeText(snapshot.project.name, new Set()) },
    apis,
    diagnostics: uniqueDiagnostics(diagnostics),
  });
}

/** Select raw API locations with the same validated scopes used by document projection. */
export function selectDocumentApiLocations(
  snapshot: ProjectSnapshot,
  scope: DocumentScope,
): { locations: DocumentApiLocation[]; diagnostics: DocumentDiagnostic[] } {
  const allLocations = collectProjectApis(snapshot.project);
  const selected = selectApis(snapshot.project, allLocations, scope);
  return {
    locations: allLocations.filter((location) => selected.apiIds.has(location.asset.contract.id)),
    diagnostics: selected.diagnostics,
  };
}

function collectProjectApis(project: DeepReadonly<ContractProject>): DocumentApiLocation[] {
  const locations: DocumentApiLocation[] = [];
  const visitFolder = (
    collection: DeepReadonly<ContractCollection>,
    folder: DeepReadonly<ContractFolder>,
    ancestors: DeepReadonly<ContractFolder>[],
  ): void => {
    const path = [...ancestors, folder];
    for (const asset of folder.apis) locations.push({ asset, collection, folders: path });
    for (const child of folder.folders) visitFolder(collection, child, path);
  };

  for (const collection of project.collections) {
    for (const asset of collection.apis) locations.push({ asset, collection, folders: [] });
    for (const folder of collection.folders) visitFolder(collection, folder, []);
  }
  return locations;
}

function selectApis(
  project: DeepReadonly<ContractProject>,
  locations: DocumentApiLocation[],
  scope: DocumentScope,
): { apiIds: Set<string>; diagnostics: DocumentDiagnostic[] } {
  const parsed = DocumentScopeSchema.safeParse(scope);
  if (!parsed.success) {
    return {
      apiIds: new Set(),
      diagnostics: [scopeDiagnostic("DOCUMENT_SCOPE_INVALID", "scope", "文档范围无效。")],
    };
  }

  const apiIds = new Set<string>();
  const diagnostics: DocumentDiagnostic[] = [];
  const allApiIds = new Set(locations.map(({ asset }) => asset.contract.id));
  switch (parsed.data.kind) {
    case "project":
      for (const id of allApiIds) apiIds.add(id);
      break;
    case "collections": {
      if (parsed.data.collectionIds.length === 0) {
        diagnostics.push(scopeDiagnostic("DOCUMENT_SCOPE_EMPTY", "scope.collectionIds", "必须选择至少一个模块。"));
        break;
      }
      const requested = new Set(parsed.data.collectionIds);
      const known = new Set(project.collections.map((collection) => collection.id));
      for (const id of requested) {
        if (!known.has(id)) diagnostics.push(scopeDiagnostic("DOCUMENT_SCOPE_TARGET_NOT_FOUND", "scope.collectionIds", "找不到所选模块。", id));
      }
      for (const location of locations) if (requested.has(location.collection.id) && known.has(location.collection.id)) apiIds.add(location.asset.contract.id);
      break;
    }
    case "apis": {
      if (parsed.data.contractIds.length === 0) {
        diagnostics.push(scopeDiagnostic("DOCUMENT_SCOPE_EMPTY", "scope.contractIds", "必须选择至少一个接口。"));
        break;
      }
      const requested = new Set(parsed.data.contractIds);
      for (const id of requested) {
        if (!allApiIds.has(id)) diagnostics.push(scopeDiagnostic("DOCUMENT_SCOPE_TARGET_NOT_FOUND", "scope.contractIds", "找不到所选接口。", id));
      }
      for (const id of requested) if (allApiIds.has(id)) apiIds.add(id);
      break;
    }
    case "tags": {
      if (parsed.data.tags.length === 0) {
        diagnostics.push(scopeDiagnostic("DOCUMENT_SCOPE_EMPTY", "scope.tags", "必须选择至少一个标签。"));
        break;
      }
      const knownTags = new Set(locations.flatMap(({ asset }) => asset.contract.metadata.tags));
      const requested = new Set(parsed.data.tags);
      for (const tag of requested) {
        if (!knownTags.has(tag)) diagnostics.push(scopeDiagnostic("DOCUMENT_SCOPE_TARGET_NOT_FOUND", "scope.tags", "找不到所选标签。", tag));
      }
      for (const location of locations) {
        if (location.asset.contract.metadata.tags.some((tag) => requested.has(tag))) apiIds.add(location.asset.contract.id);
      }
      break;
    }
  }
  return { apiIds, diagnostics };
}

function scopeDiagnostic(code: string, path: string, message: string, ownerId?: string): DocumentDiagnostic {
  return { severity: "error", code, path, message, lossy: false, ...(ownerId === undefined ? {} : { ownerId }) };
}

function projectApi(snapshot: ProjectSnapshot, location: DocumentApiLocation): DocumentProjection["apis"][number] {
  const contract = snapshot.context.getContract(location.asset.contract.id);
  if (!contract) throw new TypeError("The API asset must belong to the supplied project snapshot context.");
  const closure = resolveDocumentDependencyClosure(snapshot, contract);
  const components = selectedComponents(snapshot, closure.componentIds);
  const componentsById = new Map(components.map((component) => [component.id, component]));
  const secretRefIds = collectDocumentSecretRefIds(contract.request.auth, components);
  const apiDiagnostics = [...closure.diagnostics, ...documentDesignDiagnostics(snapshot, contract.id, closure)];
  const sanitize = (value: string): string => sanitizeText(value, secretRefIds);
  const sanitizeProse = (value: string): string => sanitizeProseText(value, secretRefIds);

  return {
    contractId: contract.id,
    collection: { id: location.collection.id, name: sanitize(location.collection.name) },
    folders: location.folders.map((folder) => ({ id: folder.id, name: sanitize(folder.name) })),
    metadata: {
      name: sanitize(contract.metadata.name),
      description: sanitizeProse(contract.metadata.description),
      tags: contract.metadata.tags.map(sanitize),
      version: sanitize(contract.metadata.version),
      status: contract.metadata.status,
    },
    request: projectRequest(contract.request, componentsById, secretRefIds),
    responses: contract.responses.map((response, index) => projectResponse(response, componentsById, secretRefIds, `contract.responses[${index}]`)),
    models: snapshot.project.models.filter((model) => closure.modelIds.has(model.id)).map((model) => projectModel(model, secretRefIds)),
    components: components.map((component) => projectComponent(component, componentsById, secretRefIds)),
    documentation: sanitizeProse(location.asset.documentation),
    caseSummaries: location.asset.cases.map((testCase) => ({
      name: sanitize(testCase.name),
      scope: sanitize(testCase.scope),
      assertionCount: testCase.assertions.length,
    })),
    diagnostics: uniqueDiagnostics(apiDiagnostics),
  };
}

/** Resolve the finite raw dependency closure for one contract, excluding local test-case overrides. */
export function resolveDocumentDependencyClosure(snapshot: ProjectSnapshot, contract: DeepReadonly<ApiContract>): DocumentDependencyClosure {
  const rootAsset = { contract, cases: [], documentation: "" } as unknown as ApiAsset;
  const apiIds = new Set(collectProjectApis(snapshot.project).map(({ asset }) => asset.contract.id));
  const modelRows = new Map<string, DeepReadonly<ModelAsset>[]>();
  const componentRows = new Map<string, DeepReadonly<ComponentAsset>[]>();
  for (const model of snapshot.project.models) modelRows.set(model.id, [...(modelRows.get(model.id) ?? []), model]);
  for (const component of snapshot.project.components) componentRows.set(component.id, [...(componentRows.get(component.id) ?? []), component]);

  const modelIds = new Set<string>();
  const componentIds = new Set<string>();
  const diagnostics: DocumentDiagnostic[] = [];
  const visited = new Set<string>();
  const queue = referencesFromApiAsset(rootAsset);
  while (queue.length > 0) {
    const reference = queue.shift();
    if (!reference) continue;
    const targetKey = `${reference.expectedKind}:${reference.targetId}`;
    if (visited.has(`${reference.ownerId}:${reference.path}:${targetKey}`)) continue;
    visited.add(`${reference.ownerId}:${reference.path}:${targetKey}`);

    const allMatches = (modelRows.get(reference.targetId)?.length ?? 0)
      + (componentRows.get(reference.targetId)?.length ?? 0)
      + (apiIds.has(reference.targetId) ? 1 : 0);
    if (allMatches === 0) {
      diagnostics.push(referenceDiagnostic(reference, "ASSET_REFERENCE_MISSING", `引用的${reference.expectedKind}不存在。`));
      continue;
    }
    if (allMatches > 1) {
      diagnostics.push(referenceDiagnostic(reference, "ASSET_ID_DUPLICATE", "引用目标存在重复 ID，无法确定定义。"));
      continue;
    }

    if (reference.expectedKind === "model") {
      const model = modelRows.get(reference.targetId)?.[0];
      if (!model) {
        diagnostics.push(referenceDiagnostic(reference, "ASSET_REFERENCE_KIND_MISMATCH", "引用目标不是模型。"));
        continue;
      }
      if (modelIds.has(model.id)) continue;
      modelIds.add(model.id);
      queue.push(...referencesFromModelAsset(model as ModelAsset));
      continue;
    }

    const component = componentRows.get(reference.targetId)?.[0];
    if (!component || component.kind !== reference.expectedKind) {
      diagnostics.push(referenceDiagnostic(reference, "ASSET_REFERENCE_KIND_MISMATCH", "引用目标组件类型不匹配。"));
      continue;
    }
    if (componentIds.has(component.id)) continue;
    componentIds.add(component.id);
    queue.push(...referencesFromComponentAsset(component as ComponentAsset));
  }
  return { modelIds, componentIds, diagnostics: uniqueDiagnostics(diagnostics) };
}

function referenceDiagnostic(reference: AssetReference, code: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path: reference.path, message, lossy: true, ownerId: reference.ownerId };
}

export function documentDesignDiagnostics(snapshot: ProjectSnapshot, contractId: string, closure: DocumentDependencyClosure): DocumentDiagnostic[] {
  const owners = new Set([contractId, ...closure.modelIds, ...closure.componentIds]);
  const diagnostics = snapshot.context.diagnostics.filter((diagnostic) => {
    if (!owners.has(diagnostic.ownerId)) return false;
    if (diagnostic.ownerId === contractId) return diagnostic.path.startsWith("contract.");
    return true;
  });
  return diagnostics.map((diagnostic) => {
    const lossy = diagnostic.code === "ASSET_REFERENCE_MISSING"
      || diagnostic.code === "ASSET_REFERENCE_KIND_MISMATCH"
      || diagnostic.code === "ASSET_ID_DUPLICATE";
    const severity = lossy ? "error" : "warning";
    return {
      severity,
      code: diagnostic.code,
      path: diagnostic.path,
      message: diagnostic.code === "ASSET_PARAMETER_LOCATION_MISMATCH"
        ? "参数组件的位置与所属参数列表不匹配。"
        : diagnostic.code === "ASSET_PARAMETER_NAME_DUPLICATE"
          ? "同一参数位置存在重复名称。"
          : diagnostic.code === "ASSET_RESPONSE_STATUS_CONTENT_TYPE_DUPLICATE"
            ? "同一响应状态和媒体类型重复定义。"
            : "资产定义存在结构诊断。",
      lossy,
      ownerId: diagnostic.ownerId,
    } satisfies DocumentDiagnostic;
  });
}

function selectedComponents(snapshot: ProjectSnapshot, componentIds: Set<string>): DeepReadonly<ComponentAsset>[] {
  return snapshot.project.components.filter((component) => componentIds.has(component.id));
}

function projectRequest(
  request: DeepReadonly<ApiRequest>,
  components: Map<string, DeepReadonly<ComponentAsset>>,
  secretRefIds: Set<string>,
): DocumentProjection["apis"][number]["request"] {
  const common = {
    baseUrl: redactUrl(request.baseUrl, secretRefIds),
    path: redactUrl(request.path, secretRefIds),
    pathParams: request.pathParams.map((binding) => projectParameter(binding, "path", components, secretRefIds)),
    query: request.query.map((binding) => projectParameter(binding, "query", components, secretRefIds)),
    headers: request.headers.map((binding) => projectParameter(binding, "header", components, secretRefIds)),
    cookies: request.cookies.map((binding) => projectParameter(binding, "cookie", components, secretRefIds)),
    auth: projectAuth(request.auth, components, secretRefIds),
  };
  if (request.protocol === "http") {
    return { protocol: "http", method: request.method, ...common, body: projectRequestBody(request.body, secretRefIds) };
  }
  if (request.protocol === "soap") {
    return {
      protocol: "soap",
      method: request.method,
      ...common,
      envelope: sanitizeText(request.envelope, secretRefIds),
      ...(request.soapAction === undefined ? {} : { soapAction: sanitizeText(request.soapAction, secretRefIds) }),
    };
  }
  return {
    protocol: "websocket",
    ...common,
    ...(request.message === undefined ? {} : { message: sanitizeText(request.message, secretRefIds) }),
  };
}

function projectParameter(
  binding: DeepReadonly<ParameterBinding>,
  location: ParameterLocation,
  components: Map<string, DeepReadonly<ComponentAsset>>,
  secretRefIds: Set<string>,
): z.infer<typeof DocumentParameterSchema> {
  if (binding.kind === "inline") {
    return {
      kind: "inline",
      id: binding.id,
      location,
      name: sanitizeText(binding.name, secretRefIds),
      schema: projectSchema(binding.schema, secretRefIds, binding.name),
      required: binding.required,
      enabled: binding.enabled,
      description: sanitizeProseText(binding.description, secretRefIds),
      ...(binding.value === undefined ? {} : { value: safeFieldValue(binding.value, binding.name, secretRefIds) }),
    };
  }
  const component = components.get(binding.componentId);
  if (!component || component.kind !== "parameter") {
    return { kind: "unresolved", id: binding.id, componentId: binding.componentId, expectedKind: "parameter", location };
  }
  return {
    kind: "componentRef",
    id: binding.id,
    componentId: component.id,
    expectedKind: "parameter",
    location,
    name: sanitizeText(component.definition.name, secretRefIds),
    schema: projectSchema(component.definition.schema, secretRefIds, component.definition.name),
    required: component.definition.required,
    enabled: binding.enabled ?? true,
    description: sanitizeProseText(component.definition.description, secretRefIds),
    ...(binding.value === undefined ? {} : { value: safeFieldValue(binding.value, component.definition.name, secretRefIds) }),
  };
}

function projectAuth(
  auth: DeepReadonly<AuthBinding | InlineAuthBinding>,
  components: Map<string, DeepReadonly<ComponentAsset>>,
  secretRefIds: Set<string>,
): z.infer<typeof DocumentAuthSchema> {
  let definition: DeepReadonly<InlineAuthBinding>;
  if (auth.kind === "componentRef") {
    const component = components.get(auth.componentId);
    if (!component || component.kind !== "auth") return { kind: "unresolved", componentId: auth.componentId, expectedKind: "auth" };
    definition = component.definition;
  } else {
    definition = auth;
  }
  switch (definition.kind) {
    case "none": return { kind: "none" };
    case "bearer": return { kind: "bearer", token: MASKED_SECRET_PLACEHOLDER };
    case "basic": return { kind: "basic", username: MASKED_SECRET_PLACEHOLDER, password: MASKED_SECRET_PLACEHOLDER };
    case "apikey": return {
      kind: "apikey",
      name: sanitizeText(definition.name, secretRefIds),
      placement: definition.placement,
      value: MASKED_SECRET_PLACEHOLDER,
    };
  }
}

function projectRequestBody(body: DeepReadonly<RequestBody>, secretRefIds: Set<string>): z.infer<typeof DocumentRequestBodySchema> {
  switch (body.kind) {
    case "none": return { kind: "none" };
    case "json":
    case "xml":
    case "text":
      return {
        kind: body.kind,
        content: body.kind === "json" ? sanitizeJsonText(body.content, secretRefIds) : sanitizeText(body.content, secretRefIds),
        ...(body.schema === undefined ? {} : { schema: projectSchema(body.schema, secretRefIds) }),
      };
    case "graphql":
      return {
        kind: "graphql",
        query: sanitizeText(body.query, secretRefIds),
        ...(body.variables === undefined ? {} : { variables: sanitizeJsonText(body.variables, secretRefIds) }),
        ...(body.operationName === undefined ? {} : { operationName: sanitizeText(body.operationName, secretRefIds) }),
      };
    case "urlencoded":
      return { kind: "urlencoded", fields: body.fields.map((field) => ({
        id: field.id,
        name: sanitizeText(field.name, secretRefIds),
        value: safeFieldValue(field.value, field.name, secretRefIds),
        enabled: field.enabled,
      })) };
    case "multipart":
      return { kind: "multipart", entries: body.entries.map((entry) => entry.kind === "text"
        ? {
          kind: "text",
          id: entry.id,
          name: sanitizeText(entry.name, secretRefIds),
          value: safeFieldValue(entry.value, entry.name, secretRefIds),
          enabled: entry.enabled,
        }
        : {
          kind: "file",
          id: entry.id,
          name: sanitizeText(entry.name, secretRefIds),
          bound: entry.file.path.length > 0,
          ...(entry.filename === undefined ? {} : { filename: sanitizeText(entry.filename, secretRefIds) }),
          ...(entry.contentType === undefined ? {} : { contentType: sanitizeText(entry.contentType, secretRefIds) }),
          enabled: entry.enabled,
        }) };
    case "binary": return { kind: "binary", bound: body.file.path.length > 0, contentType: sanitizeText(body.contentType, secretRefIds) };
  }
}

function projectResponse(
  binding: DeepReadonly<ResponseBinding>,
  components: Map<string, DeepReadonly<ComponentAsset>>,
  secretRefIds: Set<string>,
  path: string,
): z.infer<typeof DocumentResponseSchema> {
  if (binding.kind === "componentRef") {
    const component = components.get(binding.componentId);
    if (!component || component.kind !== "response") {
      return { kind: "unresolved", id: binding.id, componentId: binding.componentId, expectedKind: "response" };
    }
    return {
      kind: "componentRef",
      id: binding.id,
      componentId: component.id,
      expectedKind: "response",
      ...projectResponseDefinition(component.definition, components, secretRefIds, `components.${component.id}.definition`),
    };
  }
  return { kind: "inline", id: binding.id, ...projectResponseDefinition(binding, components, secretRefIds, path) };
}

function projectResponseDefinition(
  response: DeepReadonly<ResponseDefinition>,
  components: Map<string, DeepReadonly<ComponentAsset>>,
  secretRefIds: Set<string>,
  path: string,
): z.infer<typeof DocumentResponseDefinitionSchema> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    defineSafe(headers, sanitizeText(name, secretRefIds), safeFieldValue(value, name, secretRefIds));
  }
  const content: Record<string, z.infer<typeof DocumentResponseContentSchema>> = {};
  for (const [mediaType, item] of Object.entries(response.content)) {
    defineSafe(content, sanitizeText(mediaType, secretRefIds), {
      ...(item.schema === undefined ? {} : { schema: projectSchema(item.schema, secretRefIds) }),
      examples: item.examples.map((example, index) => projectExample(example, components, secretRefIds, `${path}.content[${JSON.stringify(mediaType)}].examples[${index}]`)),
    });
  }
  return { status: response.status, description: sanitizeProseText(response.description, secretRefIds), headers, content };
}

function projectExample(
  example: DeepReadonly<ExampleBinding>,
  components: Map<string, DeepReadonly<ComponentAsset>>,
  secretRefIds: Set<string>,
  _path: string,
): z.infer<typeof DocumentExampleSchema> {
  if (example.kind === "componentRef") {
    const component = components.get(example.componentId);
    if (!component || component.kind !== "example") {
      return { kind: "unresolved", id: example.id, componentId: example.componentId, expectedKind: "example" };
    }
    return {
      kind: "componentRef",
      id: example.id,
      componentId: component.id,
      expectedKind: "example",
      name: sanitizeText(component.definition.name, secretRefIds),
      value: sanitizeJson(component.definition.value, secretRefIds),
    };
  }
  return { kind: "inline", id: example.id, name: sanitizeText(example.name, secretRefIds), value: sanitizeJson(example.value, secretRefIds) };
}

function projectModel(model: DeepReadonly<ModelAsset>, secretRefIds: Set<string>): z.infer<typeof DocumentModelSchema> {
  return {
    id: model.id,
    name: sanitizeText(model.name, secretRefIds),
    description: sanitizeProseText(model.description, secretRefIds),
    schema: projectSchema(model.schema, secretRefIds),
  };
}

function projectComponent(
  component: DeepReadonly<ComponentAsset>,
  components: Map<string, DeepReadonly<ComponentAsset>>,
  secretRefIds: Set<string>,
): z.infer<typeof DocumentComponentSchema> {
  const common = { id: component.id, name: sanitizeText(component.name, secretRefIds), description: sanitizeProseText(component.description, secretRefIds) };
  switch (component.kind) {
    case "parameter": return {
      ...common,
      kind: "parameter",
      definition: {
        location: component.definition.location,
        name: sanitizeText(component.definition.name, secretRefIds),
        schema: projectSchema(component.definition.schema, secretRefIds, component.definition.name),
        required: component.definition.required,
        description: sanitizeProseText(component.definition.description, secretRefIds),
      },
    };
    case "auth": return { ...common, kind: "auth", definition: projectAuth(component.definition, components, secretRefIds) };
    case "response": return {
      ...common,
      kind: "response",
      definition: projectResponseDefinition(component.definition, components, secretRefIds, `components.${component.id}.definition`),
    };
    case "example": return {
      ...common,
      kind: "example",
      definition: { name: sanitizeText(component.definition.name, secretRefIds), value: sanitizeJson(component.definition.value, secretRefIds) },
    };
  }
}

function projectSchema(schema: DeepReadonly<SchemaNode>, secretRefIds: Set<string>, fieldName?: string): SchemaNode {
  const annotations = {
    ...(schema.description === undefined ? {} : { description: sanitizeProseText(schema.description, secretRefIds) }),
    ...(schema.default === undefined ? {} : { default: sanitizeJson(schema.default, secretRefIds, fieldName) }),
    ...(schema.examples === undefined ? {} : { examples: schema.examples.map((value) => sanitizeJson(value, secretRefIds, fieldName)) }),
    ...(schema.enum === undefined ? {} : { enum: schema.enum.map((value) => sanitizeJson(value, secretRefIds, fieldName)) }),
  };
  switch (schema.kind) {
    case "scalar": return { ...annotations, kind: "scalar", type: schema.type };
    case "modelRef": return { ...annotations, kind: "modelRef", modelId: schema.modelId };
    case "array": return { ...annotations, kind: "array", items: projectSchema(schema.items, secretRefIds) };
    case "object": {
      const properties: Record<string, SchemaNode> = {};
      for (const [name, child] of Object.entries(schema.properties)) defineSafe(properties, sanitizeText(name, secretRefIds), projectSchema(child, secretRefIds, name));
      return {
        ...annotations,
        kind: "object",
        properties,
        required: [...schema.required].map((name) => sanitizeText(name, secretRefIds)),
        additionalProperties: typeof schema.additionalProperties === "boolean"
          ? schema.additionalProperties
          : projectSchema(schema.additionalProperties, secretRefIds),
      };
    }
    case "allOf":
    case "oneOf":
    case "anyOf": return { ...annotations, kind: schema.kind, variants: schema.variants.map((variant) => projectSchema(variant, secretRefIds)) };
  }
}

export function collectDocumentSecretRefIds(auth: DeepReadonly<AuthBinding>, components: DeepReadonly<ComponentAsset>[]): Set<string> {
  const ids = new Set<string>();
  const addAuth = (binding: DeepReadonly<AuthBinding | InlineAuthBinding>): void => {
    if (binding.kind === "componentRef") return;
    if (binding.kind === "bearer") ids.add(binding.token.id);
    else if (binding.kind === "basic") ids.add(binding.password.id);
    else if (binding.kind === "apikey") ids.add(binding.value.id);
  };
  addAuth(auth);
  for (const component of components) if (component.kind === "auth") addAuth(component.definition);
  return ids;
}

/** Reuse document projection redaction for values crossing another public export boundary. */
export function sanitizeDocumentText(value: string, secretRefIds: Set<string>): string {
  return sanitizeText(value, secretRefIds);
}

export function sanitizeDocumentProse(value: string, secretRefIds: Set<string>): string {
  return sanitizeProseText(value, secretRefIds);
}

export function sanitizeDocumentUrl(value: string, secretRefIds: Set<string>): string {
  return redactUrl(value, secretRefIds);
}

function safeFieldValue(value: string, name: string, secretRefIds: Set<string>): string {
  if (isCredentialFieldName(name) && value !== "") return MASKED_SECRET_PLACEHOLDER;
  return sanitizeText(value, secretRefIds);
}

function sanitizeText(value: string, secretRefIds: Set<string>): string {
  let output = redactCommonCredentialText(value);
  for (const id of secretRefIds) if (id) output = output.replaceAll(id, MASKED_SECRET_PLACEHOLDER);
  output = output.replace(/\b[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/]?)+/g, MASKED_SECRET_PLACEHOLDER);
  output = output.replace(/\\\\[^\\/\s"'<>|]+[\\/][^\\/\s"'<>|]+(?:[\\/][^\s"'<>|]+)*/g, MASKED_SECRET_PLACEHOLDER);
  return output;
}

function sanitizeProseText(value: string, secretRefIds: Set<string>): string {
  const output = sanitizeText(value, secretRefIds);
  const urlPattern = /https?:\/\/[^\s"'`<>]+/gi;
  let sanitized = "";
  let offset = 0;
  for (const match of output.matchAll(urlPattern)) {
    const start = match.index ?? 0;
    sanitized += sanitizePosixPaths(output.slice(offset, start)) + match[0];
    offset = start + match[0].length;
  }
  return sanitized + sanitizePosixPaths(output.slice(offset));
}

function sanitizePosixPaths(value: string): string {
  const quoted = value.replace(/(["'`])\/(?!\/)([^"'`<>|\r\n]+)\1/g, `$1${MASKED_SECRET_PLACEHOLDER}$1`);
  return quoted.replace(/(^|[\s=(])\/(?!\/)[^\s"'`<>|)]+/g, `$1${MASKED_SECRET_PLACEHOLDER}`);
}

function redactUrl(value: string, secretRefIds: Set<string>): string {
  const withoutUserInfo = value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@/?#]*@/i, `$1${MASKED_SECRET_PLACEHOLDER}@`);
  const withoutSecretQuery = withoutUserInfo.replace(/([?&][^=&#]*(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token)[^=&#]*=)[^&#]*/gi, `$1${MASKED_SECRET_PLACEHOLDER}`);
  return sanitizeText(withoutSecretQuery, secretRefIds);
}

function sanitizeJsonText(value: string, secretRefIds: Set<string>): string {
  try {
    JSON.parse(value);
  } catch {
    return containsCredentialJsonKey(value) ? MASKED_SECRET_PLACEHOLDER : sanitizeText(value, secretRefIds);
  }

  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let index = 0;
  const skipWhitespace = (): void => {
    while (/\s/.test(value[index] ?? "")) index += 1;
  };
  const parseString = (): { start: number; end: number; value: string } => {
    const start = index;
    index += 1;
    while (index < value.length) {
      if (value[index] === "\\") {
        index += 2;
        continue;
      }
      if (value[index] === '"') {
        index += 1;
        break;
      }
      index += 1;
    }
    const end = index;
    return { start, end, value: JSON.parse(value.slice(start, end)) as string };
  };
  const parseValue = (fieldName?: string, suppressed = false): void => {
    skipWhitespace();
    const start = index;
    const sensitive = fieldName !== undefined && isCredentialFieldName(fieldName);
    const nestedSuppressed = suppressed || sensitive;
    let stringValue: { start: number; end: number; value: string } | undefined;
    const token = value[index];
    if (token === '"') {
      stringValue = parseString();
    } else if (token === "{") {
      index += 1;
      skipWhitespace();
      while (value[index] !== "}") {
        const key = parseString();
        skipWhitespace();
        index += 1; // colon
        if (!nestedSuppressed) {
          const sanitizedKey = sanitizeText(key.value, secretRefIds);
          if (sanitizedKey !== key.value) replacements.push({ start: key.start, end: key.end, value: JSON.stringify(sanitizedKey) });
        }
        parseValue(key.value, nestedSuppressed);
        skipWhitespace();
        if (value[index] === ",") {
          index += 1;
          skipWhitespace();
        } else {
          break;
        }
      }
      index += 1; // closing brace
    } else if (token === "[") {
      index += 1;
      skipWhitespace();
      while (value[index] !== "]") {
        parseValue(undefined, nestedSuppressed);
        skipWhitespace();
        if (value[index] === ",") {
          index += 1;
          skipWhitespace();
        } else {
          break;
        }
      }
      index += 1; // closing bracket
    } else {
      while (index < value.length && !/[\s,}\]]/.test(value[index] ?? "")) index += 1;
    }

    if (!suppressed && sensitive) {
      replacements.push({ start, end: index, value: JSON.stringify(MASKED_SECRET_PLACEHOLDER) });
    } else if (!suppressed && stringValue) {
      const sanitizedValue = sanitizeText(stringValue.value, secretRefIds);
      if (sanitizedValue !== stringValue.value) {
        replacements.push({ start: stringValue.start, end: stringValue.end, value: JSON.stringify(sanitizedValue) });
      }
    }
  };

  parseValue();
  replacements.sort((left, right) => left.start - right.start);
  let output = "";
  let offset = 0;
  for (const replacement of replacements) {
    output += value.slice(offset, replacement.start) + replacement.value;
    offset = replacement.end;
  }
  return output + value.slice(offset);
}

function containsCredentialJsonKey(value: string): boolean {
  const keyLike = /(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([A-Za-z_][A-Za-z0-9_-]*))\s*:/g;
  for (const match of value.matchAll(keyLike)) {
    let key: string | undefined = match[2] ?? match[3];
    if (match[1] !== undefined) {
      try {
        const parsed: unknown = JSON.parse(`"${match[1]}"`);
        key = typeof parsed === "string" ? parsed : undefined;
      } catch {
        // Invalid key text is not evidence of a credential field.
      }
    }
    if (key !== undefined && isCredentialFieldName(key)) return true;
  }
  return false;
}

function sanitizeJson(value: DeepReadonly<JsonValue>, secretRefIds: Set<string>, fieldName?: string): JsonValue {
  const redacted = redactCredentialValue(value as JsonValue, fieldName);
  return sanitizeJsonStrings(redacted, secretRefIds);
}

function sanitizeJsonStrings(value: JsonValue, secretRefIds: Set<string>): JsonValue {
  if (typeof value === "string") return sanitizeText(value, secretRefIds);
  if (Array.isArray(value)) return value.map((child) => sanitizeJsonStrings(child, secretRefIds));
  if (value !== null && typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) defineSafe(output, sanitizeText(key, secretRefIds), sanitizeJsonStrings(child, secretRefIds));
    return output;
  }
  return value;
}

function defineSafe<Value>(target: Record<string, Value>, key: string, value: Value): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function uniqueDiagnostics(diagnostics: DocumentDiagnostic[]): DocumentDiagnostic[] {
  const unique = new Map<string, DocumentDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.path, diagnostic.ownerId]);
    if (!unique.has(key)) unique.set(key, diagnostic);
  }
  return [...unique.values()];
}
