import { randomUUID } from "node:crypto";

import { createProjectSnapshot } from "../assets/snapshot.js";
import type {
  ApiAsset,
  ApiRequest,
  AuthBinding,
  ComponentAsset,
  ExampleBinding,
  ExampleComponentAsset,
  HttpMethod,
  InlineAuthBinding,
  InlineExampleBinding,
  InlineParameter,
  InlineResponse,
  ModelAsset,
  ParameterBinding,
  ParameterComponentAsset,
  ParameterLocation,
  RequestBody,
  ResponseBinding,
  ResponseContent,
  ResponseComponentAsset,
  ResponseDefinition,
  SecretRef,
} from "../contract/model.js";
import { ContractProjectSchema, type ContractCollection, type ContractProject } from "../contract/workspace.js";
import type { JsonValue } from "../contract/schemaNode.js";
import { sanitizeNodeName } from "../storage/sanitize.js";
import { isCredentialFieldName, mapContractSchema, stripCredentialValues, type SchemaMappingContext } from "./schemaMapping.js";

export interface ContractImportDiagnostic {
  code: string;
  ownerId: string;
  path: string;
  reason: string;
  targetId?: string;
}

export interface ContractImportResult {
  project: ContractProject;
  diagnostics: ContractImportDiagnostic[];
}

interface ReferenceIndex {
  byName: Map<string, string>;
  byPointer: Map<string, string>;
}

interface ImportState {
  projectId: string;
  diagnostics: ContractImportDiagnostic[];
  models: ModelAsset[];
  components: ComponentAsset[];
  modelIds: Map<string, string>;
  parameterRefs: ReferenceIndex;
  authRefs: ReferenceIndex;
  responseRefs: ReferenceIndex;
  exampleRefs: ReferenceIndex;
  parameterById: Map<string, ParameterComponentAsset>;
  responseSources: Map<string, unknown>;
  exampleSources: Map<string, unknown>;
  authSources: Map<string, unknown>;
  sourceRoot: Record<string, unknown>;
  openApi2: boolean;
  collection: ContractCollection;
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch"]);
const EMPTY_GLOBALS = { query: [], headers: [], cookies: [], body: [] };

/** Import an OpenAPI 2.0 or 3.x document into the contract project model without fetching references or executing source content. */
export function parseContractOpenapi(input: unknown): ContractImportResult {
  const root = asRecord(input);
  if (!root) throw new TypeError("An OpenAPI document object is required.");

  const openApi2 = typeof root.swagger === "string" && root.swagger.startsWith("2.");
  const info = asRecord(root.info) ?? {};
  const projectId = randomUUID();
  const projectName = sanitizeNodeName(stringOr(info.title, "Imported OpenAPI"));
  const collection: ContractCollection = {
    id: randomUUID(),
    name: projectName,
    variables: {},
    preOperations: [],
    postOperations: [],
    folders: [],
    apis: [],
  };
  const components = asRecord(root.components) ?? {};
  const schemaSources = asRecord(openApi2 ? root.definitions : components.schemas) ?? {};
  const parameterSources = asRecord(openApi2 ? root.parameters : components.parameters) ?? {};
  const responseSources = asRecord(openApi2 ? root.responses : components.responses) ?? {};
  const exampleSources = asRecord(components.examples) ?? {};
  const authSources = asRecord(openApi2 ? root.securityDefinitions : components.securitySchemes) ?? {};
  const state: ImportState = {
    projectId,
    diagnostics: [],
    models: [],
    components: [],
    modelIds: new Map(),
    parameterRefs: indexReferences(parameterSources, openApi2 ? ["#/parameters/"] : ["#/components/parameters/"]),
    authRefs: indexReferences(authSources, openApi2 ? ["#/securityDefinitions/"] : ["#/components/securitySchemes/"]),
    responseRefs: indexReferences(responseSources, openApi2 ? ["#/responses/"] : ["#/components/responses/"]),
    exampleRefs: indexReferences(exampleSources, ["#/components/examples/"]),
    parameterById: new Map(),
    responseSources: new Map(),
    exampleSources: new Map(),
    authSources: new Map(),
    sourceRoot: root,
    openApi2,
    collection,
  };

  const schemaPrefix = openApi2 ? "#/definitions/" : "#/components/schemas/";
  for (const name of Object.keys(schemaSources)) state.modelIds.set(`${schemaPrefix}${escapePointer(name)}`, randomUUID());
  importModels(schemaSources, state);
  importComponents(parameterSources, responseSources, exampleSources, authSources, state);
  importPaths(asRecord(root.paths) ?? {}, state);

  if (info.description !== undefined) addDiagnostic(state, "OPENAPI_INFO_DESCRIPTION_UNREPRESENTED", projectId, "info/description", "Project-level description is not represented by ContractProject.");
  for (const field of Object.keys(info)) {
    if (["title", "version", "description"].includes(field)) continue;
    addDiagnostic(state, "OPENAPI_INFO_FIELD_UNSUPPORTED", projectId, `info/${field}`, "This OpenAPI info field is not represented by ContractProject.");
  }
  if (root.externalDocs !== undefined) addDiagnostic(state, "OPENAPI_EXTERNAL_DOCS_UNREPRESENTED", projectId, "externalDocs", "External documentation links are not copied or fetched.");
  for (const [index, tagValue] of asArray(root.tags).entries()) {
    const tag = asRecord(tagValue) ?? {};
    for (const field of ["description", "externalDocs"]) {
      if (tag[field] !== undefined) addDiagnostic(state, "OPENAPI_TAG_METADATA_UNREPRESENTED", projectId, `tags/${index}/${field}`, "Tag descriptions and external links are not represented by the contract metadata.");
    }
  }
  if (!openApi2) {
    for (const field of Object.keys(components)) {
      if (["schemas", "parameters", "responses", "examples", "securitySchemes"].includes(field)) continue;
      addDiagnostic(state, "OPENAPI_COMPONENTS_UNSUPPORTED", projectId, `components/${field}`, "This component kind is not represented by the four supported local component types.");
    }
  }

  if (root.webhooks !== undefined) {
    addDiagnostic(state, "OPENAPI_WEBHOOKS_UNSUPPORTED", projectId, "webhooks", "OpenAPI webhooks are not represented by the current contract project model.");
  }
  for (const key of Object.keys(root)) {
    if (["openapi", "swagger", "info", "servers", "host", "basePath", "schemes", "consumes", "produces", "paths", "components", "definitions", "parameters", "responses", "securityDefinitions", "security", "tags", "externalDocs", "webhooks"].includes(key)) continue;
    addDiagnostic(state, "OPENAPI_ROOT_FIELD_UNSUPPORTED", projectId, key, "This top-level OpenAPI field was not imported.");
  }

  const project = ContractProjectSchema.parse({
    id: projectId,
    name: projectName,
    variables: {},
    globals: EMPTY_GLOBALS,
    environments: [],
    collections: [collection],
    workflows: [],
    stressPolicy: { trustedOrigins: [], deniedOrigins: [] },
    models: state.models,
    components: state.components,
  });
  const graphDiagnostics = createProjectSnapshot(project).context.diagnostics;
  const diagnostics = deduplicateDiagnostics([
    ...state.diagnostics,
    ...graphDiagnostics.map((item) => ({ ...item, reason: "The imported asset graph contains an unresolved or cyclic reference." })),
  ]);
  return { project, diagnostics };
}

function importModels(sources: Record<string, unknown>, state: ImportState): void {
  const schemaPrefix = state.openApi2 ? "#/definitions/" : "#/components/schemas/";
  for (const [name, source] of Object.entries(sources)) {
    const modelId = state.modelIds.get(`${schemaPrefix}${escapePointer(name)}`);
    if (!modelId) continue;
    const schema = mapContractSchema(source, {
      ownerId: modelId,
      sourcePath: `models.${name}.schema`,
      modelIds: state.modelIds,
      diagnostics: state.diagnostics,
    });
    const record = asRecord(source) ?? {};
    state.models.push({
      formatVersion: 1,
      id: modelId,
      name: sanitizeNodeName(name),
      description: stringOr(record.description, ""),
      schema,
    });
  }
}

function importComponents(
  parameterSources: Record<string, unknown>,
  responseSources: Record<string, unknown>,
  exampleSources: Record<string, unknown>,
  authSources: Record<string, unknown>,
  state: ImportState,
): void {
  for (const [name, source] of Object.entries(parameterSources)) {
    const id = state.parameterRefs.byName.get(name);
    if (!id) continue;
    const parameter = resolveParameterSource(source, `components.parameters.${name}`, id, state);
    const componentLocation = mapParameterLocation(parameter.location ?? "") ?? "query";
    if (!mapParameterLocation(parameter.location ?? "")) {
      addDiagnostic(state, "PARAMETER_LOCATION_UNSUPPORTED", id, `components.parameters.${name}/in`, "This parameter location is not represented by the component model.");
    }
    const definition: ParameterComponentAsset["definition"] = {
      location: componentLocation,
      name: parameter.name ?? sanitizeNodeName(name),
      schema: mapParameterSchema(parameter.raw, parameter.name ?? name, `components.parameters.${name}`, id, state),
      required: parameter.required ?? false,
      description: stringOr(asRecord(parameter.raw)?.description, ""),
    };
    const component: ParameterComponentAsset = {
      formatVersion: 1,
      id,
      name: sanitizeNodeName(name),
      description: stringOr(asRecord(source)?.description, ""),
      kind: "parameter",
      definition,
    };
    state.components.push(component);
    state.parameterById.set(id, component);
    diagnoseUnsupportedFields(asRecord(source), new Set(["name", "in", "required", "schema", "description", "example", "examples", "default", "enum", "$ref", "type", "items"]), id, `components.parameters.${name}`, "PARAMETER_FIELD_UNSUPPORTED", state);
  }

  for (const [name, source] of Object.entries(responseSources)) state.responseSources.set(name, source);
  for (const [name, source] of Object.entries(exampleSources)) state.exampleSources.set(name, source);
  for (const [name, source] of Object.entries(authSources)) state.authSources.set(name, source);

  for (const [name, source] of Object.entries(responseSources)) {
    const id = state.responseRefs.byName.get(name);
    if (!id) continue;
    const definition = mapResponseDefinition(source, name, `components.responses.${name}`, id, "default", state);
    const component: ResponseComponentAsset = {
      formatVersion: 1,
      id,
      name: sanitizeNodeName(name),
      description: stringOr(asRecord(source)?.description, definition.description),
      kind: "response",
      definition,
    };
    state.components.push(component);
  }

  for (const [name, source] of Object.entries(exampleSources)) {
    const id = state.exampleRefs.byName.get(name);
    if (!id) continue;
    const record = asRecord(source) ?? {};
    const value = resolveExampleComponentValue(name, state, new Set());
    const component: ExampleComponentAsset = {
      formatVersion: 1,
      id,
      name: sanitizeNodeName(name),
      description: stringOr(record.description, stringOr(record.summary, "")),
      kind: "example",
      definition: { name: stringOr(record.summary, sanitizeNodeName(name)), value: value ?? null },
    };
    state.components.push(component);
    diagnoseUnsupportedFields(record, new Set(["summary", "description", "value", "externalValue", "$ref"]), id, `components.examples.${name}`, "EXAMPLE_FIELD_UNSUPPORTED", state);
    if (record.externalValue !== undefined) addDiagnostic(state, "EXAMPLE_EXTERNAL_VALUE_UNSUPPORTED", id, `components.examples.${name}.externalValue`, "External example values are not fetched.");
  }

  for (const [name, source] of Object.entries(authSources)) {
    const id = state.authRefs.byName.get(name);
    if (!id) continue;
    const record = asRecord(source) ?? {};
    const definition = mapAuthScheme(record, id, `components.securitySchemes.${name}`, state);
    for (const secretPath of credentialValuePaths(record, `components.securitySchemes.${name}`)) {
      addDiagnostic(state, "AUTH_VALUE_REMOVED", id, secretPath, "A source authentication value was not imported; fill the new unbound credential locally (****).");
    }
    state.components.push({
      formatVersion: 1,
      id,
      name: sanitizeNodeName(name),
      description: stringOr(record.description, ""),
      kind: "auth",
      definition,
    });
    diagnoseUnsupportedFields(record, new Set(["type", "scheme", "bearerFormat", "name", "in", "description", "flows", "openIdConnectUrl", "authorizationUrl", "tokenUrl", "refreshUrl", "scopes", "$ref"]), id, `components.securitySchemes.${name}`, "AUTH_SCHEME_FIELD_UNSUPPORTED", state);
  }
}

function resolveExampleComponentValue(name: string, state: ImportState, ancestors: Set<string>): JsonValue | undefined {
  const id = state.exampleRefs.byName.get(name);
  const sourcePath = `components.examples.${name}`;
  const record = asRecord(state.exampleSources.get(name));
  if (!record || !id) {
    return undefined;
  }
  if (ancestors.has(name)) {
    addDiagnostic(state, "EXAMPLE_COMPONENT_ALIAS_CYCLE", id, `${sourcePath}/$ref`, "The local example component aliases contain a cycle; no value was imported.");
    return undefined;
  }
  if (typeof record.$ref === "string") {
    if (!record.$ref.startsWith("#/")) {
      addDiagnostic(state, "EXAMPLE_EXTERNAL_REFERENCE_UNSUPPORTED", id, `${sourcePath}/$ref`, "External example references are not fetched.");
      return undefined;
    }
    const targetId = state.exampleRefs.byPointer.get(record.$ref);
    const targetName = targetId ? componentNameById(state.exampleRefs, targetId) : undefined;
    if (!targetName) {
      addDiagnostic(state, "EXAMPLE_REFERENCE_UNRESOLVED", id, `${sourcePath}/$ref`, "The local example reference was not found.");
      return undefined;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(name);
    if (nextAncestors.has(targetName)) {
      addDiagnostic(state, "EXAMPLE_COMPONENT_ALIAS_CYCLE", id, `${sourcePath}/$ref`, "The local example component aliases contain a cycle; no value was imported.");
      return undefined;
    }
    return resolveExampleComponentValue(targetName, state, nextAncestors);
  }
  if (record.value === undefined) {
    addDiagnostic(state, "EXAMPLE_VALUE_MISSING", id, `${sourcePath}/value`, "The example component has no inline value and no local value reference.");
    return undefined;
  }
  const value = toJsonValue(record.value);
  if (value === undefined) {
    addDiagnostic(state, "EXAMPLE_VALUE_UNSUPPORTED", id, `${sourcePath}/value`, "The example value is not JSON-compatible and was not imported.");
    return undefined;
  }
  const stripped = stripCredentialValues(value);
  for (const path of stripped.removedPaths) {
    addDiagnostic(state, "AUTH_VALUE_REMOVED", id, `${sourcePath}/value.${path}`, "A common credential field value was removed; fill it again in the local credential entry.");
  }
  return stripped.value;
}

interface ResolvedParameter {
  raw: Record<string, unknown>;
  name?: string;
  location?: string;
  required?: boolean;
  componentId?: string;
  sourcePath: string;
}

function resolveParameterSource(source: unknown, sourcePath: string, ownerId: string, state: ImportState): ResolvedParameter {
  const record = asRecord(source) ?? {};
  if (typeof record.$ref !== "string") {
    return {
      raw: record,
      name: typeof record.name === "string" ? record.name : undefined,
      location: typeof record.in === "string" ? record.in : undefined,
      required: typeof record.required === "boolean" ? record.required : undefined,
      sourcePath,
    };
  }
  const componentId = state.parameterRefs.byPointer.get(record.$ref);
  const name = componentId ? componentNameById(state.parameterRefs, componentId) : undefined;
  const component = componentId ? state.parameterById.get(componentId) : undefined;
  const sourceDefinition = name ? Object.entries(asRecord(state.openApi2 ? state.sourceRoot.parameters : (asRecord(state.sourceRoot.components) ?? {}).parameters) ?? {}).find(([entryName]) => entryName === name)?.[1] : undefined;
  const rawDefinition = asRecord(sourceDefinition) ?? {};
  if (componentId && component) {
    return {
      raw: rawDefinition,
      name: component.definition.name,
      location: component.definition.location,
      required: component.definition.required,
      componentId,
      sourcePath,
    };
  }
  if (componentId) {
    return {
      raw: rawDefinition,
      name: typeof rawDefinition.name === "string" ? rawDefinition.name : name,
      location: typeof rawDefinition.in === "string" ? rawDefinition.in : undefined,
      required: typeof rawDefinition.required === "boolean" ? rawDefinition.required : undefined,
      componentId,
      sourcePath,
    };
  }
  addDiagnostic(state, record.$ref.startsWith("#/") ? "PARAMETER_REFERENCE_UNRESOLVED" : "PARAMETER_EXTERNAL_REFERENCE_UNSUPPORTED", ownerId, `${sourcePath}/$ref`, "The parameter reference was not resolved or fetched.");
  return { raw: {}, sourcePath };
}

function mapParameterSchema(raw: Record<string, unknown>, name: string, sourcePath: string, ownerId: string, state: ImportState) {
  const schema = asRecord(raw.schema) ?? Object.fromEntries(
    ["type", "items", "default", "enum", "example", "examples", "description"]
      .filter((key) => Object.hasOwn(raw, key))
      .map((key) => [key, raw[key]]),
  );
  const combined: Record<string, unknown> = { ...schema };
  if (raw.example !== undefined && combined.example === undefined) combined.example = raw.example;
  if (raw.examples !== undefined && combined.examples === undefined) {
    const examples = asRecord(raw.examples);
    if (examples) combined.examples = Object.values(examples).map((value) => asRecord(value)?.value ?? value);
  }
  const schemaNamePath = isCredentialFieldName(name) ? `${sourcePath}/schema/properties/${name}` : `${sourcePath}/schema`;
  return mapContractSchema(combined, {
    ownerId,
    sourcePath: schemaNamePath,
    modelIds: state.modelIds,
    diagnostics: state.diagnostics,
  });
}

function importPaths(paths: Record<string, unknown>, state: ImportState): void {
  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = asRecord(pathItemValue);
    if (!pathItem) {
      addDiagnostic(state, "OPENAPI_PATH_ITEM_UNSUPPORTED", state.projectId, `paths.${path}`, "The path item is not an object and was omitted.");
      continue;
    }
    if (typeof pathItem.$ref === "string") {
      addDiagnostic(state, pathItem.$ref.startsWith("#/") ? "OPENAPI_PATH_REFERENCE_UNSUPPORTED" : "OPENAPI_EXTERNAL_REFERENCE_UNSUPPORTED", state.projectId, `paths.${path}/$ref`, "Path item references are not expanded or fetched.");
    }
    diagnoseUnsupportedFields(
      pathItem,
      new Set(["$ref", "summary", "description", "servers", "parameters", ...HTTP_METHODS]),
      state.projectId,
      `paths.${path}`,
      "OPENAPI_PATH_FIELD_UNSUPPORTED",
      state,
    );
    for (const [methodName, operationValue] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(methodName.toLowerCase())) continue;
      const operation = asRecord(operationValue);
      const method = methodName.toUpperCase() as HttpMethod;
      if (!operation) {
        addDiagnostic(state, "OPENAPI_OPERATION_UNSUPPORTED", state.projectId, `paths.${path}/${methodName}`, "The operation is not an object and was omitted.");
        continue;
      }
      const contractId = randomUUID();
      const parameters = mergeParameters(pathItem.parameters, operation.parameters);
      const importedParameters = importOperationParameters(parameters, `paths.${path}/${methodName}/parameters`, contractId, state);
      const requestServer = resolveServer(pathItem, operation, state.sourceRoot, contractId, state);
      const request = buildRequest(path, method, operation, importedParameters, contractId, state, requestServer);
      const responses = importOperationResponses(asRecord(operation.responses) ?? {}, contractId, `paths.${path}/${methodName}/responses`, state);
      const info = asRecord(state.sourceRoot.info) ?? {};
      const tags = stringArray(operation.tags).map((tag) => sanitizeNodeName(tag));
      const displayName = sanitizeNodeName(stringOr(operation.operationId, stringOr(operation.summary, `${method} ${path}`)));
      const description = [pathItem.summary, pathItem.description, operation.description, operation.summary]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join("\n\n");
      state.collection.apis.push({
        contract: {
          formatVersion: 1,
          id: contractId,
          metadata: {
            name: displayName,
            description,
            tags,
            version: stringOr(info.version, "1.0.0"),
            status: operation.deprecated === true ? "deprecated" : "draft",
          },
          request,
          responses,
        },
        cases: [],
        documentation: description,
      });

      const security = operation.security === undefined ? state.sourceRoot.security : operation.security;
      let selectedAuth: AuthBinding | undefined;
      if (security !== undefined) {
        selectedAuth = mapSecurityRequirement(security, contractId, `paths.${path}/${methodName}/security`, state);
        if (selectedAuth) request.auth = selectedAuth;
      }
      if (requestServer.userInfo) {
        if (selectedAuth) {
          addDiagnostic(state, "AUTH_BINDING_CONFLICT", contractId, `${requestServer.userInfo.sourcePath}/userinfo`, "Server URL userinfo was omitted because another authentication binding is selected; choose the intended binding in the editor.");
        } else {
          request.auth = { kind: "basic", username: requestServer.userInfo.usernameTemplate ?? "", password: newSecretRef() };
        }
      }
      if (operation.callbacks !== undefined) addDiagnostic(state, "OPENAPI_CALLBACKS_UNSUPPORTED", contractId, `paths.${path}/${methodName}/callbacks`, "OpenAPI callbacks are not represented by the contract model.");
      diagnoseUnsupportedFields(operation, new Set(["operationId", "summary", "description", "tags", "deprecated", "parameters", "requestBody", "responses", "security", "servers", "callbacks", "consumes", "produces"]), contractId, `paths.${path}/${methodName}`, "OPENAPI_OPERATION_FIELD_UNSUPPORTED", state);
    }
  }
}

interface OperationParameters {
  bindings: Record<ParameterLocation, ParameterBinding[]>;
  bodyParameter?: Record<string, unknown>;
  formParameters: Array<{ name: string; schema: Record<string, unknown>; required: boolean; description: string }>;
}

function importOperationParameters(values: unknown[], sourcePath: string, ownerId: string, state: ImportState): OperationParameters {
  const output: OperationParameters = {
    bindings: { path: [], query: [], header: [], cookie: [] },
    formParameters: [],
  };
  const resolved = new Map<string, ResolvedParameter>();
  values.forEach((value, index) => {
    const parameter = resolveParameterSource(value, `${sourcePath}/${index}`, ownerId, state);
    if (!parameter.name || !parameter.location) return;
    resolved.set(`${parameter.location}:${parameter.name}`, parameter);
  });

  for (const parameter of resolved.values()) {
    const raw = parameter.raw;
    const name = parameter.name;
    const parameterIn = parameter.location;
    if (!name || !parameterIn) continue;
    if (parameterIn === "body") {
      if (output.bodyParameter) addDiagnostic(state, "REQUEST_BODY_PARAMETER_DUPLICATE", ownerId, parameter.sourcePath, "Only one OpenAPI 2.0 body parameter can be represented.");
      if (raw.required === true) addDiagnostic(state, "REQUEST_BODY_REQUIRED_UNREPRESENTED", ownerId, `${parameter.sourcePath}/required`, "Required body metadata is not represented by the request body model.");
      diagnoseUnsupportedFields(raw, new Set(["name", "in", "required", "schema"]), ownerId, parameter.sourcePath, "PARAMETER_FIELD_UNSUPPORTED", state);
      output.bodyParameter = raw;
      continue;
    }
    if (parameterIn === "formData") {
    const schema = asRecord(raw.schema) ?? { type: raw.type };
      output.formParameters.push({ name, schema, required: parameter.required ?? false, description: stringOr(raw.description, "") });
      continue;
    }
    const location = parameterLocation(parameterIn);
    if (!location) {
      addDiagnostic(state, "PARAMETER_LOCATION_UNSUPPORTED", ownerId, parameter.sourcePath, "This parameter location is not represented by the contract model.");
      continue;
    }
    if (parameter.componentId) {
      output.bindings[location].push({
        kind: "componentRef",
        id: randomUUID(),
        componentId: parameter.componentId,
        expectedKind: "parameter",
        enabled: true,
      });
    } else {
      const binding: InlineParameter = {
        kind: "inline",
        id: randomUUID(),
        name,
        schema: mapParameterSchema(raw, name, parameter.sourcePath, ownerId, state),
        required: parameter.required ?? (parameterIn === "path"),
        enabled: true,
        description: stringOr(raw.description, ""),
      };
      output.bindings[location].push(binding);
    }
    diagnoseUnsupportedFields(raw, new Set(["name", "in", "required", "schema", "description", "example", "examples", "default", "enum", "$ref", "type", "items"]), ownerId, parameter.sourcePath, "PARAMETER_FIELD_UNSUPPORTED", state);
  }
  return output;
}

function buildRequest(
  path: string,
  method: HttpMethod,
  operation: Record<string, unknown>,
  parameters: OperationParameters,
  ownerId: string,
  state: ImportState,
  server: ResolvedServer,
): ApiRequest {
  let body: RequestBody = { kind: "none" };
  if (parameters.bodyParameter) {
    const bodyParameter = parameters.bodyParameter;
    const bodySchema = bodyParameter.schema;
    body = { kind: "json", content: "", ...(bodySchema === undefined ? {} : { schema: mapContractSchema(bodySchema, schemaContext(state, ownerId, `request.body.schema`)) }) };
  } else if (parameters.formParameters.length > 0) {
    body = makeFormBody(parameters.formParameters, stringArray(operation.consumes ?? state.sourceRoot.consumes), ownerId, "request.formData", state);
  } else if (operation.requestBody !== undefined) {
    body = mapRequestBody(operation.requestBody, ownerId, "requestBody", state);
  }
  const request: ApiRequest = {
    protocol: "http",
    method,
    baseUrl: server.baseUrl,
    path: server.pathPrefix ? joinPath(server.pathPrefix, path) : path,
    pathParams: parameters.bindings.path,
    query: parameters.bindings.query,
    headers: parameters.bindings.header,
    cookies: parameters.bindings.cookie,
    auth: { kind: "none" },
    body,
  };
  return request;
}

function mapRequestBody(value: unknown, ownerId: string, sourcePath: string, state: ImportState): RequestBody {
  const requestBody = asRecord(value);
  if (!requestBody) {
    addDiagnostic(state, "REQUEST_BODY_UNSUPPORTED", ownerId, sourcePath, "The request body is not an object and was omitted.");
    return { kind: "none" };
  }
  diagnoseUnsupportedFields(requestBody, new Set(["required", "content", "$ref"]), ownerId, sourcePath, "REQUEST_BODY_FIELD_UNSUPPORTED", state);
  if (typeof requestBody.$ref === "string") {
    addDiagnostic(state, requestBody.$ref.startsWith("#/") ? "REQUEST_BODY_REFERENCE_UNSUPPORTED" : "OPENAPI_EXTERNAL_REFERENCE_UNSUPPORTED", ownerId, `${sourcePath}/$ref`, "Request body references are not expanded or fetched.");
    return { kind: "none" };
  }
  const content = asRecord(requestBody.content) ?? {};
  const mediaType = chooseMediaType(content);
  const media = mediaType ? asRecord(content[mediaType]) ?? {} : {};
  if (requestBody.required === true) addDiagnostic(state, "REQUEST_BODY_REQUIRED_UNREPRESENTED", ownerId, `${sourcePath}/required`, "Required body metadata is not represented by the request body model.");
  for (const extraMediaType of Object.keys(content).filter((key) => key !== mediaType)) {
    addDiagnostic(state, "REQUEST_BODY_MEDIA_TYPE_UNREPRESENTED", ownerId, `${sourcePath}/content/${extraMediaType}`, "Only one request media type is represented by the request model.");
  }
  if (!mediaType) {
    return { kind: "none" };
  }
  diagnoseUnsupportedFieldsAndReferences(media, new Set(["schema"]), ownerId, `${sourcePath}/content/${mediaType}`, "REQUEST_BODY_MEDIA_FIELD_UNSUPPORTED", state);
  const schemaInput = media.schema;
  if (mediaType === "application/x-www-form-urlencoded" || mediaType === "multipart/form-data") {
    const schema = asRecord(schemaInput) ?? {};
    const properties = asRecord(schema.properties) ?? {};
    const requiredFields = new Set(stringArray(schema.required));
    const formParameters = Object.entries(properties).map(([name, property]) => ({
      name,
      schema: asRecord(property) ?? {},
      required: requiredFields.has(name),
      description: stringOr(asRecord(property)?.description, ""),
    }));
    if (schemaInput !== undefined) addDiagnostic(state, "REQUEST_BODY_SCHEMA_NOT_REPRESENTED", ownerId, `${sourcePath}/content/${mediaType}/schema`, "The form body schema was converted to fields; schema-level constraints not represented by fields may be lost.");
    const body = makeFormBody(formParameters, [mediaType], ownerId, `${sourcePath}/content/${mediaType}`, state);
    if (asRecord(schema.additionalProperties) || schema.allOf || schema.anyOf || schema.oneOf) {
      addDiagnostic(state, "REQUEST_BODY_SCHEMA_CONSTRAINTS_UNREPRESENTED", ownerId, `${sourcePath}/content/${mediaType}/schema`, "Form schema composition or additional properties are not represented by multipart fields.");
    }
    return body;
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return { kind: "json", content: "", ...(schemaInput === undefined ? {} : { schema: mapContractSchema(schemaInput, schemaContext(state, ownerId, `${sourcePath}/content/${mediaType}/schema`)) }) };
  }
  if (mediaType === "application/xml" || mediaType.endsWith("+xml")) {
    return { kind: "xml", content: "", ...(schemaInput === undefined ? {} : { schema: mapContractSchema(schemaInput, schemaContext(state, ownerId, `${sourcePath}/content/${mediaType}/schema`)) }) };
  }
  if (mediaType.startsWith("text/")) {
    return { kind: "text", content: "", ...(schemaInput === undefined ? {} : { schema: mapContractSchema(schemaInput, schemaContext(state, ownerId, `${sourcePath}/content/${mediaType}/schema`)) }) };
  }
  if (schemaInput !== undefined) addDiagnostic(state, "REQUEST_BODY_SCHEMA_UNREPRESENTED", ownerId, `${sourcePath}/content/${mediaType}/schema`, "This media type cannot retain its request schema in the contract body model.");
  addDiagnostic(state, "REQUEST_BODY_MEDIA_TYPE_UNSUPPORTED", ownerId, `${sourcePath}/content/${mediaType}`, "The request media type is represented as an unbound binary body.");
  return { kind: "binary", file: { path: "" }, contentType: mediaType };
}

function makeFormBody(
  fields: Array<{ name: string; schema: Record<string, unknown>; required: boolean; description: string }>,
  consumes: string[],
  ownerId: string,
  sourcePath: string,
  state: ImportState,
): RequestBody {
  const multipart = consumes.some((value) => value.toLowerCase() === "multipart/form-data")
    || fields.some((field) => field.schema.type === "file" || field.schema.format === "binary");
  if (!multipart) {
    return {
      kind: "urlencoded",
      fields: fields.map((field) => {
        if (isCredentialFieldName(field.name)) addDiagnostic(state, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}/${field.name}`, "A common credential field value was left empty; fill it again in the local credential entry.");
        if (field.required) addDiagnostic(state, "FORM_REQUIRED_UNREPRESENTED", ownerId, `${sourcePath}/${field.name}/required`, "Required form field metadata is not represented by the request body model.");
        return { id: randomUUID(), name: field.name, value: "", enabled: true };
      }),
    };
  }
  return {
    kind: "multipart",
    entries: fields.map((field) => {
      if (field.schema.type === "file" || field.schema.format === "binary") {
        addDiagnostic(state, "REQUEST_FILE_NOT_BOUND", ownerId, `${sourcePath}/${field.name}`, "The imported file field has no local file binding and must be selected again.");
        return { kind: "file" as const, id: randomUUID(), name: field.name, file: { path: "" }, enabled: true };
      }
      if (isCredentialFieldName(field.name)) addDiagnostic(state, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}/${field.name}`, "A common credential field value was left empty; fill it again in the local credential entry.");
      if (field.required) addDiagnostic(state, "FORM_REQUIRED_UNREPRESENTED", ownerId, `${sourcePath}/${field.name}/required`, "Required form field metadata is not represented by the request body model.");
      return { kind: "text" as const, id: randomUUID(), name: field.name, value: "", enabled: true };
    }),
  };
}

function importOperationResponses(responses: Record<string, unknown>, ownerId: string, sourcePath: string, state: ImportState): ResponseBinding[] {
  const output: ResponseBinding[] = [];
  for (const [statusValue, responseValue] of Object.entries(responses)) {
    const status = normalizeStatus(statusValue, ownerId, `${sourcePath}/${statusValue}`, state);
    const response = asRecord(responseValue) ?? {};
    if (typeof response.$ref === "string") {
      const componentId = state.responseRefs.byPointer.get(response.$ref);
      if (componentId) {
        addDiagnostic(state, "RESPONSE_REFERENCE_STATUS_UNREPRESENTED", ownerId, `${sourcePath}/${statusValue}`, "Response references do not carry an operation status; the source status key is not represented on this binding.");
        output.push({ kind: "componentRef", id: randomUUID(), componentId, expectedKind: "response" });
      } else {
        addDiagnostic(state, response.$ref.startsWith("#/") ? "RESPONSE_REFERENCE_UNRESOLVED" : "RESPONSE_EXTERNAL_REFERENCE_UNSUPPORTED", ownerId, `${sourcePath}/${statusValue}/$ref`, "The response reference was not resolved or fetched.");
        output.push({ kind: "inline", id: randomUUID(), ...emptyResponseDefinition(status, "") });
      }
      continue;
    }
    output.push({ kind: "inline", id: randomUUID(), ...mapResponseDefinition(responseValue, statusValue, `${sourcePath}/${statusValue}`, ownerId, status, state) });
  }
  return output;
}

function mapResponseDefinition(
  value: unknown,
  name: string,
  sourcePath: string,
  ownerId: string,
  status: string,
  state: ImportState,
): ResponseDefinition {
  const source = asRecord(value) ?? {};
  if (typeof source.$ref === "string") addDiagnostic(state, "RESPONSE_COMPONENT_ALIAS_UNSUPPORTED", ownerId, `${sourcePath}/$ref`, "Response component aliases are not expanded.");
  const headers: Record<string, string> = {};
  for (const [headerName, header] of Object.entries(asRecord(source.headers) ?? {})) {
    const headerRecord = asRecord(header) ?? {};
    Object.defineProperty(headers, headerName, { value: stringOr(headerRecord.description, ""), enumerable: true, configurable: true, writable: true });
    if (typeof headerRecord.$ref === "string") {
      addDiagnostic(state, "RESPONSE_HEADER_REFERENCE_UNSUPPORTED", ownerId, `${sourcePath}/headers/${headerName}/$ref`, "Response header references are not expanded or fetched.");
    }
    diagnoseUnsupportedFieldsAndReferences(headerRecord, new Set(["description"]), ownerId, `${sourcePath}/headers/${headerName}`, "RESPONSE_HEADER_FIELD_UNSUPPORTED", state);
  }
  const content: Record<string, ResponseContent> = {};
  const mediaContent = asRecord(source.content);
  if (mediaContent) {
    for (const [mediaType, mediaValue] of Object.entries(mediaContent)) {
      const media = asRecord(mediaValue) ?? {};
      const item: ResponseContent = { examples: [] };
      if (media.schema !== undefined) item.schema = mapContractSchema(media.schema, schemaContext(state, ownerId, `${sourcePath}/content/${mediaType}/schema`));
      item.examples = mapExamples(media.examples, `${sourcePath}/content/${mediaType}/examples`, ownerId, state);
      if (media.example !== undefined) {
        const example = makeInlineExample("example", media.example, ownerId, `${sourcePath}/content/${mediaType}/example`, state);
        if (example) item.examples.push(example);
      }
      Object.defineProperty(content, mediaType, { value: item, enumerable: true, configurable: true, writable: true });
      diagnoseUnsupportedFieldsAndReferences(media, new Set(["schema", "examples", "example"]), ownerId, `${sourcePath}/content/${mediaType}`, "RESPONSE_MEDIA_FIELD_UNSUPPORTED", state);
    }
  }
  if (state.openApi2 && source.schema !== undefined) {
    const mediaType = stringArray(state.sourceRoot.produces)[0] ?? "application/json";
    content[mediaType] = { schema: mapContractSchema(source.schema, schemaContext(state, ownerId, `${sourcePath}/schema`)), examples: [] };
  }
  if (state.openApi2 && source.examples !== undefined) {
    const examples = asRecord(source.examples) ?? {};
    for (const [mediaType, exampleValue] of Object.entries(examples)) {
      const inline = makeInlineExample(mediaType, exampleValue, ownerId, `${sourcePath}/examples/${mediaType}`, state);
      const current = content[mediaType] ?? { examples: [] };
      if (inline) current.examples.push(inline);
      content[mediaType] = current;
    }
  }
  diagnoseUnsupportedFields(source, new Set(["description", "headers", "content", "schema", "examples", "response", "$ref", "x-codeSamples"]), ownerId, sourcePath, "RESPONSE_FIELD_UNSUPPORTED", state);
  return {
    status,
    description: stringOr(source.description, stringOr(source.summary, sanitizeNodeName(name))),
    headers,
    content,
  };
}

function mapExamples(value: unknown, sourcePath: string, ownerId: string, state: ImportState): ExampleBinding[] {
  const source = asRecord(value);
  if (!source) return [];
  const output: ExampleBinding[] = [];
  for (const [name, exampleValue] of Object.entries(source)) {
    const exampleRecord = asRecord(exampleValue) ?? {};
    if (typeof exampleRecord.$ref === "string") {
      const componentId = state.exampleRefs.byPointer.get(exampleRecord.$ref);
      if (componentId) output.push({ kind: "componentRef", id: randomUUID(), componentId, expectedKind: "example" });
      else addDiagnostic(state, exampleRecord.$ref.startsWith("#/") ? "EXAMPLE_REFERENCE_UNRESOLVED" : "EXAMPLE_EXTERNAL_REFERENCE_UNSUPPORTED", ownerId, `${sourcePath}/${name}/$ref`, "The example reference was not resolved or fetched.");
      continue;
    }
    const inline = makeInlineExample(name, exampleRecord.value ?? exampleValue, ownerId, `${sourcePath}/${name}`, state, stringOr(exampleRecord.summary, name));
    if (inline) output.push(inline);
  }
  return output;
}

function makeInlineExample(
  name: string,
  value: unknown,
  ownerId: string,
  sourcePath: string,
  state: ImportState,
  displayName = name,
): InlineExampleBinding | undefined {
  const json = toJsonValue(value);
  if (json === undefined) {
    addDiagnostic(state, "EXAMPLE_VALUE_UNSUPPORTED", ownerId, sourcePath, "The example is not a JSON value and was omitted.");
    return undefined;
  }
  const stripped = stripCredentialValues(json);
  for (const path of stripped.removedPaths) addDiagnostic(state, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}/${path}`, "A common credential field value was removed from the example.");
  return { kind: "inline", id: randomUUID(), name: sanitizeNodeName(displayName), value: stripped.value };
}

function mapAuthScheme(source: Record<string, unknown>, ownerId: string, sourcePath: string, state: ImportState): InlineAuthBinding {
  const type = stringOr(source.type, "");
  if (type === "http" && stringOr(source.scheme, "").toLowerCase() === "bearer") {
    return { kind: "bearer", token: newSecretRef() };
  }
  if (type === "http" && stringOr(source.scheme, "").toLowerCase() === "basic") {
    return { kind: "basic", username: "", password: newSecretRef() };
  }
  if (type === "apiKey") {
    const placement = source.in === "query" ? "query" : source.in === "header" ? "header" : undefined;
    if (placement) return { kind: "apikey", name: stringOr(source.name, "apiKey"), placement, value: newSecretRef() };
    addDiagnostic(state, "AUTH_LOCATION_UNSUPPORTED", ownerId, `${sourcePath}/in`, "This authentication location is not represented by the auth binding model.");
  }
  addDiagnostic(state, "AUTH_SCHEME_UNSUPPORTED", ownerId, sourcePath, "This security scheme is represented by an unconfigured auth placeholder.");
  return { kind: "none" };
}

function mapSecurityRequirement(value: unknown, ownerId: string, sourcePath: string, state: ImportState): AuthBinding | undefined {
  if (!Array.isArray(value)) {
    addDiagnostic(state, "SECURITY_REQUIREMENT_UNSUPPORTED", ownerId, sourcePath, "The security requirement is not an array and was omitted.");
    return undefined;
  }
  if (value.length === 0) return { kind: "none" };
  if (value.length > 1) addDiagnostic(state, "SECURITY_ALTERNATIVES_UNREPRESENTED", ownerId, sourcePath, "Only the first alternative security requirement is represented.");
  const first = asRecord(value[0]);
  if (!first) return { kind: "none" };
  const entries = Object.entries(first);
  if (entries.length > 1) addDiagnostic(state, "SECURITY_COMBINATION_UNREPRESENTED", ownerId, sourcePath, "Only the first security scheme in a combined requirement is represented.");
  const schemeName = entries[0]?.[0];
  if (!schemeName) return { kind: "none" };
  const componentId = state.authRefs.byName.get(schemeName);
  if (!componentId) {
    addDiagnostic(state, "SECURITY_SCHEME_UNRESOLVED", ownerId, `${sourcePath}/${schemeName}`, "The security scheme reference was not found.");
    return { kind: "none" };
  }
  return { kind: "componentRef", componentId, expectedKind: "auth" };
}

interface ResolvedServer {
  baseUrl: string;
  pathPrefix: string;
  userInfo?: { sourcePath: string; usernameTemplate?: string };
}

function resolveServer(pathItem: Record<string, unknown>, operation: Record<string, unknown>, root: Record<string, unknown>, ownerId: string, state: ImportState): ResolvedServer {
  if (state.openApi2) {
    const host = stringOr(root.host, "");
    const schemes = stringArray(root.schemes);
    if (schemes.length > 1) addDiagnostic(state, "OPENAPI_SCHEMES_UNREPRESENTED", ownerId, "schemes", "Only the first OpenAPI 2.0 scheme is represented.");
    const scheme = schemes[0] ?? "https";
    const basePath = stringOr(root.basePath, "");
    if (host) return stripServerUserInfo(`${scheme}://${host}${basePath}`, "host", ownerId, state);
    return { baseUrl: "", pathPrefix: basePath };
  }
  const servers = asArray(operation.servers ?? pathItem.servers ?? root.servers);
  const firstServer = asRecord(servers[0]);
  if (servers.length > 1) addDiagnostic(state, "OPENAPI_SERVERS_UNREPRESENTED", ownerId, "servers", "Only the first server is represented.");
  const url = stringOr(firstServer?.url, "");
  const variables = asRecord(firstServer?.variables);
  if (variables && Object.keys(variables).length > 0) {
    for (const variableName of Object.keys(variables)) addDiagnostic(state, "OPENAPI_SERVER_VARIABLE_UNRESOLVED", ownerId, `servers/0/variables/${variableName}`, "Server variables remain unresolved in the base URL.");
  }
  return stripServerUserInfo(url, "servers/0/url", ownerId, state);
}

function stripServerUserInfo(value: string, sourcePath: string, ownerId: string, state: ImportState): ResolvedServer {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(value);
  if (!match) return { baseUrl: value, pathPrefix: "" };
  const authority = match[2];
  const userInfoDelimiter = authority.lastIndexOf("@");
  if (userInfoDelimiter < 0) return { baseUrl: value, pathPrefix: "" };
  const rawUserInfo = authority.slice(0, userInfoDelimiter);
  const host = authority.slice(userInfoDelimiter + 1);
  const colon = rawUserInfo.indexOf(":");
  const rawUsername = colon < 0 ? rawUserInfo : rawUserInfo.slice(0, colon);
  const rawPassword = colon < 0 ? "" : rawUserInfo.slice(colon + 1);
  const usernameTemplate = /^\{[^{}]+\}$/.test(rawUsername) ? rawUsername : undefined;
  const passwordTemplate = /^\{[^{}]+\}$/.test(rawPassword) ? rawPassword : undefined;
  if (rawUsername !== "" && usernameTemplate === undefined) {
    addDiagnostic(state, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}/userinfo.username`, "Server URL userinfo was removed; re-enter it through the credential editor if needed.");
  }
  if (rawPassword !== "" && passwordTemplate === undefined) {
    addDiagnostic(state, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}/userinfo.password`, "Server URL userinfo was removed; re-enter it through the credential editor if needed.");
  }
  if (passwordTemplate) {
    addDiagnostic(state, "URL_USERINFO_TEMPLATE_UNREPRESENTED", ownerId, `${sourcePath}/userinfo.password`, "A password template in server URL userinfo cannot be bound automatically and was not retained.");
  }
  return {
    baseUrl: `${match[1]}${host}${match[3]}`,
    pathPrefix: "",
    userInfo: { sourcePath, ...(usernameTemplate ? { usernameTemplate } : {}) },
  };
}

function normalizeStatus(value: string, ownerId: string, path: string, state: ImportState): string {
  if (value.toLowerCase() === "default") return "default";
  if (/^[1-5][0-9]{2}$/.test(value)) return value;
  if (/^[1-5]xx$/i.test(value)) return value.toUpperCase();
  addDiagnostic(state, "RESPONSE_STATUS_UNSUPPORTED", ownerId, path, "The response key is not a supported status and was represented as default.");
  return "default";
}

function emptyResponseDefinition(status: string, description: string): ResponseDefinition {
  return { status, description, headers: {}, content: {} };
}

function schemaContext(state: ImportState, ownerId: string, sourcePath: string): SchemaMappingContext {
  return { ownerId, sourcePath, modelIds: state.modelIds, diagnostics: state.diagnostics };
}

function mergeParameters(pathParameters: unknown, operationParameters: unknown): unknown[] {
  const merged = new Map<string, unknown>();
  for (const value of [...asArray(pathParameters), ...asArray(operationParameters)]) {
    const record = asRecord(value) ?? {};
    const ref = typeof record.$ref === "string" ? record.$ref : undefined;
    const key = ref ?? `${stringOr(record.in, "")}:${stringOr(record.name, "")}`;
    merged.set(key, value);
  }
  return [...merged.values()];
}

function mapParameterLocation(location: string): ParameterLocation | undefined {
  return parameterLocation(location);
}

function parameterLocation(location: string): ParameterLocation | undefined {
  switch (location) {
    case "path":
    case "query":
    case "header":
    case "cookie":
      return location;
    default:
      return undefined;
  }
}

function chooseMediaType(content: Record<string, unknown>): string | undefined {
  const keys = Object.keys(content);
  return keys.find((key) => key.toLowerCase() === "application/json")
    ?? keys.find((key) => key.toLowerCase().endsWith("+json"))
    ?? keys[0];
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  if (!path) return prefix;
  return `${prefix.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function indexReferences(sources: Record<string, unknown>, prefixes: string[]): ReferenceIndex {
  const byName = new Map<string, string>();
  const byPointer = new Map<string, string>();
  for (const name of Object.keys(sources)) {
    const id = randomUUID();
    byName.set(name, id);
    for (const prefix of prefixes) byPointer.set(`${prefix}${escapePointer(name)}`, id);
  }
  return { byName, byPointer };
}

function componentNameById(index: ReferenceIndex, id: string): string | undefined {
  for (const [name, componentId] of index.byName) if (componentId === id) return name;
  return undefined;
}

function diagnoseUnsupportedFields(
  source: Record<string, unknown> | undefined,
  supported: ReadonlySet<string>,
  ownerId: string,
  sourcePath: string,
  code: string,
  state: ImportState,
): void {
  if (!source) return;
  for (const field of Object.keys(source)) {
    if (!supported.has(field)) addDiagnostic(state, code, ownerId, `${sourcePath}/${field}`, "The field is not represented by the target contract model.");
  }
}

function diagnoseUnsupportedFieldsAndReferences(
  source: Record<string, unknown> | undefined,
  supported: ReadonlySet<string>,
  ownerId: string,
  sourcePath: string,
  code: string,
  state: ImportState,
): void {
  if (!source) return;
  for (const [field, value] of Object.entries(source)) {
    if (supported.has(field)) continue;
    const fieldPath = `${sourcePath}/${field}`;
    addDiagnostic(state, code, ownerId, fieldPath, "The field is not represented by the target contract model.");
    reportExternalReferences(value, ownerId, fieldPath, state);
  }
}

function reportExternalReferences(value: unknown, ownerId: string, sourcePath: string, state: ImportState, ancestors = new Set<object>()): void {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return;
    ancestors.add(value);
    value.forEach((item, index) => reportExternalReferences(item, ownerId, `${sourcePath}/${index}`, state, ancestors));
    ancestors.delete(value);
    return;
  }
  const source = asRecord(value);
  if (!source || ancestors.has(source)) return;
  ancestors.add(source);
  if (typeof source.$ref === "string" && !source.$ref.startsWith("#/")) {
    addDiagnostic(state, "OPENAPI_EXTERNAL_REFERENCE_UNSUPPORTED", ownerId, `${sourcePath}/$ref`, "External references are not fetched.");
  }
  for (const [key, child] of Object.entries(source)) {
    if (key !== "$ref") reportExternalReferences(child, ownerId, `${sourcePath}/${key}`, state, ancestors);
  }
  ancestors.delete(source);
}

function addDiagnostic(state: ImportState, code: string, ownerId: string, path: string, reason: string, targetId?: string): void {
  state.diagnostics.push({ code, ownerId, path, reason, ...(targetId ? { targetId } : {}) });
}

function deduplicateDiagnostics(diagnostics: ContractImportDiagnostic[]): ContractImportDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.code, diagnostic.ownerId, diagnostic.path, diagnostic.targetId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function credentialValuePaths(value: unknown, sourcePath: string, ancestors = new Set<object>()): string[] {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return [];
    ancestors.add(value);
    const paths = value.flatMap((item, index) => credentialValuePaths(item, `${sourcePath}/${index}`, ancestors));
    ancestors.delete(value);
    return paths;
  }
  const record = asRecord(value);
  if (!record || ancestors.has(record)) return [];
  ancestors.add(record);
  const paths: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    const path = `${sourcePath}/${key}`;
    const authValueField = ["example", "value"].includes(key.toLowerCase()) || isCredentialFieldName(key);
    if (authValueField && child !== undefined && child !== null && child !== "") paths.push(path);
    else paths.push(...credentialValuePaths(child, path, ancestors));
  }
  ancestors.delete(record);
  return paths;
}


function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toJsonValue(value: unknown, ancestors = new Set<object>()): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object" || ancestors.has(value)) return undefined;
  ancestors.add(value);
  let output: JsonValue | undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => toJsonValue(item, ancestors));
    output = items.some((item) => item === undefined) ? undefined : items as JsonValue[];
  } else {
    const fields: Record<string, JsonValue> = {};
    let valid = true;
    for (const [key, item] of Object.entries(value)) {
      const converted = toJsonValue(item, ancestors);
      if (converted === undefined) {
        valid = false;
        break;
      }
      Object.defineProperty(fields, key, { value: converted, enumerable: true, configurable: true, writable: true });
    }
    if (valid) output = fields;
  }
  ancestors.delete(value);
  return output;
}

function newSecretRef(): SecretRef {
  return { id: randomUUID(), policy: "test-auto" };
}
