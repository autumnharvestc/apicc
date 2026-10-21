import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import type {
  ApiContract,
  AuthBinding,
  ComponentAsset,
  ExampleBinding,
  InlineAuthBinding,
  JsonValue,
  ModelAsset,
  ParameterBinding,
  ParameterLocation,
  RequestBody,
  ResponseBinding,
  ResponseDefinition,
  SchemaNode,
} from "../contract/model.js";
import type { DocumentApiLocation, DocumentDependencyClosure, DocumentDiagnostic, DocumentScope } from "./projection.js";
import {
  collectDocumentSecretRefIds,
  documentDesignDiagnostics,
  resolveDocumentDependencyClosure,
  sanitizeDocumentProse,
  sanitizeDocumentText,
  sanitizeDocumentUrl,
  selectDocumentApiLocations,
} from "./projection.js";
import { isCredentialFieldName, MASKED_SECRET_PLACEHOLDER, redactCredentialValue } from "../import/schemaMapping.js";

export interface OpenapiExportOptions {
  version: "3.0" | "3.1";
  infoVersion?: string;
  allowLossy: boolean;
}

export type OpenapiExportDiagnostic = DocumentDiagnostic;

export interface OpenapiExportResult {
  document: Record<string, unknown>;
  diagnostics: OpenapiExportDiagnostic[];
  blocked: boolean;
}

interface ApiExportContext {
  snapshot: ProjectSnapshot;
  location: DocumentApiLocation;
  contract: DeepReadonly<ApiContract>;
  closure: DocumentDependencyClosure;
  components: DeepReadonly<ComponentAsset>[];
  secretRefIds: Set<string>;
}

interface NameAllocator {
  used: Set<string>;
  allocate(preferred: string): string;
}

type OasRecord = Record<string, unknown>;

/** Export supported contract semantics from one verified raw snapshot. */
export function exportOpenapi(
  snapshot: ProjectSnapshot,
  scope: DocumentScope,
  options: OpenapiExportOptions,
): OpenapiExportResult {
  const diagnostics: OpenapiExportDiagnostic[] = [];
  const selected = selectDocumentApiLocations(snapshot, scope);
  for (const diagnostic of selected.diagnostics) diagnostics.push(fromDocumentDiagnostic(diagnostic));
  if (selected.locations.length === 0) {
    addDiagnostic(diagnostics, "error", "OPENAPI_SCOPE_EMPTY", "scope", "The selected scope contains no APIs.", false);
  }

  const version = options.version === "3.0" || options.version === "3.1" ? options.version : "3.1";
  if (options.version !== "3.0" && options.version !== "3.1") {
    addDiagnostic(diagnostics, "error", "OPENAPI_VERSION_INVALID", "options.version", "Choose OpenAPI 3.0 or 3.1.", false);
  }
  const contexts: ApiExportContext[] = [];
  for (const location of selected.locations) {
    const contract = snapshot.context.getContract(location.asset.contract.id);
    if (!contract) {
      addDiagnostic(diagnostics, "error", "OPENAPI_CONTRACT_MISSING", "contract", "The selected API is not present in the supplied snapshot context.", false);
      continue;
    }
    const closure = resolveDocumentDependencyClosure(snapshot, contract);
    for (const diagnostic of closure.diagnostics) diagnostics.push(fromDocumentDiagnostic(diagnostic));
    for (const diagnostic of documentDesignDiagnostics(snapshot, contract.id, closure)) diagnostics.push(fromDocumentDiagnostic(diagnostic));
    const components = snapshot.project.components.filter((component) => closure.componentIds.has(component.id));
    contexts.push({
      snapshot,
      location,
      contract,
      closure,
      components,
      secretRefIds: collectDocumentSecretRefIds(contract.request.auth, components),
    });
  }

  const allSecretRefIds = new Set(contexts.flatMap((context) => [...context.secretRefIds]));
  const infoVersion = selectInfoVersion(contexts, options.infoVersion, diagnostics);
  const schemaNames = createSchemaNames(snapshot, contexts, diagnostics);
  const schemas: OasRecord = Object.create(null) as OasRecord;
  const securitySchemes: OasRecord = Object.create(null) as OasRecord;
  const paths: OasRecord = Object.create(null) as OasRecord;
  for (const model of modelsInClosure(snapshot, contexts)) {
    const name = schemaNames.get(model.id);
    if (!name || Object.hasOwn(schemas, name)) continue;
    const schema = schemaToOpenapi(model.schema, {
      version,
      modelNames: schemaNames,
      secretRefIds: allSecretRefIds,
      diagnostics,
      ownerId: model.id,
      path: `components.schemas.${name}`,
    });
    const output = { ...schema };
    if (model.description.trim()) {
      const modelDescription = sanitizeDocumentProse(model.description, allSecretRefIds);
      if (version === "3.0" && typeof output.$ref === "string") {
        output.allOf = [{ $ref: output.$ref }];
        delete output.$ref;
      }
      const schemaDescription = typeof output.description === "string" ? output.description : "";
      if (!schemaDescription) output.description = modelDescription;
      else if (schemaDescription !== modelDescription) {
        output.description = `${modelDescription}\n\n${schemaDescription}`;
        addDiagnostic(diagnostics, "warning", "OPENAPI_MODEL_DESCRIPTION_COMBINED", `components.schemas.${name}.description`, "The model and root schema descriptions were combined into one OpenAPI description.", true, model.id);
      }
    }
    setSafe(schemas, name, output);
  }

  const routeKeys = new Set<string>();
  for (const context of contexts) {
    const operation = operationToOpenapi(context, version, schemaNames, securitySchemes, diagnostics);
    if (!operation) continue;
    const routePath = operation.path;
    const routeKey = `${routePath}\n${operation.method}`;
    if (routeKeys.has(routeKey)) {
      addDiagnostic(diagnostics, "error", "OPENAPI_PATH_METHOD_COLLISION", `paths.${routePath}.${operation.method}`, "More than one selected API defines this path and method.", false, context.contract.id);
      continue;
    }
    routeKeys.add(routeKey);
    const pathItem = (paths[routePath] as OasRecord | undefined) ?? (Object.create(null) as OasRecord);
    setSafe(pathItem, operation.method, operation.value);
    setSafe(paths, routePath, pathItem);
  }

  const hasLocalExecutionData = snapshot.project.workflows.length > 0
    || contexts.some(({ location }) => location.asset.cases.length > 0)
    || (snapshot.project.datasets?.length ?? 0) > 0
    || (snapshot.project.suites?.length ?? 0) > 0
    || snapshot.project.mock !== undefined;
  if (hasLocalExecutionData) {
    addDiagnostic(diagnostics, "warning", "OPENAPI_LOCAL_EXECUTION_DATA_OMITTED", "project", "Local test cases, datasets, suites, workflows, and Mock execution configuration are not part of OpenAPI.", false);
  }

  const title = sanitizeDocumentText(snapshot.project.name, allSecretRefIds);
  if (!title.trim()) addDiagnostic(diagnostics, "error", "OPENAPI_TITLE_EMPTY", "info.title", "OpenAPI info.title must not be empty.", false);
  const document: OasRecord = {
    openapi: version === "3.0" ? "3.0.3" : "3.1.0",
    info: { title: title || "API", version: infoVersion },
    paths,
  };
  const components: OasRecord = Object.create(null) as OasRecord;
  if (Object.keys(schemas).length > 0) setSafe(components, "schemas", schemas);
  if (Object.keys(securitySchemes).length > 0) setSafe(components, "securitySchemes", securitySchemes);
  if (Object.keys(components).length > 0) setSafe(document, "components", components);

  const uniqueDiagnostics = deduplicateDiagnostics(diagnostics);
  const blocked = uniqueDiagnostics.some((diagnostic) => diagnostic.severity === "error"
    || (diagnostic.lossy && !options.allowLossy));
  return { document, diagnostics: uniqueDiagnostics, blocked };
}

function operationToOpenapi(
  context: ApiExportContext,
  version: "3.0" | "3.1",
  modelNames: Map<string, string>,
  securitySchemes: OasRecord,
  diagnostics: OpenapiExportDiagnostic[],
): { path: string; method: string; value: OasRecord } | undefined {
  const { contract } = context;
  if (contract.request.protocol !== "http") {
    const protocol = contract.request.protocol;
    addDiagnostic(
      diagnostics,
      "warning",
      protocol === "websocket" ? "OPENAPI_WEBSOCKET_UNSUPPORTED" : "OPENAPI_SOAP_SEMANTICS_UNSUPPORTED",
      "request.protocol",
      protocol === "websocket"
        ? "WebSocket message semantics cannot be represented by OpenAPI HTTP operations."
        : "SOAP-specific semantics cannot be represented by the supported OpenAPI contract subset.",
      true,
      contract.id,
    );
    return undefined;
  }

  const request = contract.request;
  const path = normalizePath(request.path, request.pathParams, context, diagnostics);
  if (!path) return undefined;
  const operation: OasRecord = {
    summary: sanitizeDocumentText(contract.metadata.name, context.secretRefIds),
    responses: responseMap(context, version, modelNames, diagnostics),
  };
  if (contract.metadata.description.trim()) operation.description = sanitizeDocumentProse(contract.metadata.description, context.secretRefIds);
  if (contract.metadata.tags.length > 0) operation.tags = contract.metadata.tags.map((tag) => sanitizeDocumentText(tag, context.secretRefIds));
  if (contract.metadata.status === "deprecated") operation.deprecated = true;

  const parameters: OasRecord[] = [];
  const parameterSeen = new Set<string>();
  const groups: Array<{ location: ParameterLocation; bindings: readonly DeepReadonly<ParameterBinding>[] }> = [
    { location: "path", bindings: request.pathParams },
    { location: "query", bindings: request.query },
    { location: "header", bindings: request.headers },
    { location: "cookie", bindings: request.cookies },
  ];
  for (const group of groups) {
    group.bindings.forEach((binding, index) => {
      const parameter = resolveParameter(binding, group.location, context, diagnostics, `request.${group.location}[${index}]`);
      if (!parameter) return;
      if (!parameter.enabled) {
        addDiagnostic(diagnostics, "warning", "OPENAPI_PARAMETER_DISABLED_OMITTED", `request.${group.location}[${index}]`, "A disabled local request parameter is omitted from the OpenAPI operation.", true, contract.id);
        return;
      }
      if (!parameter.name.trim()) {
        addDiagnostic(diagnostics, "error", "OPENAPI_PARAMETER_NAME_EMPTY", `request.${group.location}[${index}].name`, "An OpenAPI parameter name must not be empty.", false, contract.id);
        return;
      }
      const normalizedName = group.location === "header" ? parameter.name.toLowerCase() : parameter.name;
      const uniqueKey = `${group.location}\n${normalizedName}`;
      if (parameterSeen.has(uniqueKey)) {
        addDiagnostic(diagnostics, "error", "OPENAPI_PARAMETER_DUPLICATE", `request.${group.location}[${index}]`, "OpenAPI cannot contain duplicate parameters with the same name and location.", false, contract.id);
        return;
      }
      parameterSeen.add(uniqueKey);
      const isPath = group.location === "path";
      if (isPath && !parameter.required) {
        addDiagnostic(diagnostics, "warning", "OPENAPI_PATH_PARAMETER_REQUIRED", `request.pathParams[${index}].required`, "OpenAPI path parameters must be required; this parameter is emitted as required.", true, contract.id);
      }
      const schema = schemaToOpenapi(parameter.schema, {
        version,
        modelNames,
        secretRefIds: context.secretRefIds,
        diagnostics,
        ownerId: contract.id,
        path: `request.${group.location}[${index}].schema`,
        fieldName: parameter.name,
      });
      const output: OasRecord = {
        name: parameter.name,
        in: group.location,
        required: isPath ? true : parameter.required,
        schema,
      };
      if (parameter.description.trim()) output.description = sanitizeDocumentProse(parameter.description, context.secretRefIds);
      parameters.push(output);
      if (parameter.value !== undefined && parameter.value !== "") {
        addDiagnostic(diagnostics, "warning", "OPENAPI_PARAMETER_RUNTIME_VALUE_OMITTED", `request.${group.location}[${index}].value`, "Local parameter values are not copied into the OpenAPI contract.", false, contract.id);
      }
    });
  }
  const pathVariables = path.match(/\{([^{}]+)\}/g)?.map((part) => part.slice(1, -1)) ?? [];
  const emittedPathVariables = new Set(parameters.filter((parameter) => parameter.in === "path").map((parameter) => String(parameter.name)));
  for (const variable of pathVariables) {
    if (!emittedPathVariables.has(variable)) {
      addDiagnostic(diagnostics, "error", "OPENAPI_PATH_PARAMETER_MISSING", `paths.${path}`, "Every path template variable must have a matching enabled path parameter.", false, contract.id);
    }
  }
  for (const parameter of parameters) {
    if (parameter.in === "path" && !pathVariables.includes(String(parameter.name))) {
      addDiagnostic(diagnostics, "error", "OPENAPI_PATH_PARAMETER_UNUSED", "request.pathParams", "Every path parameter must appear in the OpenAPI path template.", false, contract.id);
    }
  }
  if (parameters.length > 0) operation.parameters = parameters;

  const server = serverForUrl(request.baseUrl, context, diagnostics);
  if (server) operation.servers = [server];

  const security = authRequirement(request.auth, context, securitySchemes, diagnostics);
  if (security) operation.security = security;

  const requestBody = requestBodyToOpenapi(request.body, version, modelNames, context, diagnostics);
  if (requestBody) operation.requestBody = requestBody;
  return { path, method: request.method.toLowerCase(), value: operation };
}

function normalizePath(
  rawPath: string,
  _pathParams: readonly DeepReadonly<ParameterBinding>[],
  context: ApiExportContext,
  diagnostics: OpenapiExportDiagnostic[],
): string | undefined {
  const safe = sanitizeDocumentText(rawPath, context.secretRefIds);
  const path = safe.replace(/\{\{([^{}]+)\}\}/g, "{$1}");
  if (path !== safe) {
    addDiagnostic(diagnostics, "warning", "OPENAPI_PATH_VARIABLE_NORMALIZED", "request.path", "Double-braced path variables were converted to standard OpenAPI path variables.", false, context.contract.id);
  }
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || /[{}]/.test(path.replace(/\{[^{}]+\}/g, ""))) {
    addDiagnostic(diagnostics, "error", "OPENAPI_PATH_INVALID", "request.path", "The API path cannot be represented as an OpenAPI path template.", false, context.contract.id);
    return undefined;
  }
  if (/\{[^{}]*\}/.test(path) && [...path.matchAll(/\{([^{}]*)\}/g)].some((match) => !match[1]?.trim())) {
    addDiagnostic(diagnostics, "error", "OPENAPI_PATH_VARIABLE_INVALID", "request.path", "OpenAPI path variables must have non-empty names.", false, context.contract.id);
    return undefined;
  }
  return path;
}

interface ResolvedParameter {
  name: string;
  schema: DeepReadonly<SchemaNode>;
  required: boolean;
  enabled: boolean;
  description: string;
  value?: string;
}

function resolveParameter(
  binding: DeepReadonly<ParameterBinding>,
  location: ParameterLocation,
  context: ApiExportContext,
  diagnostics: OpenapiExportDiagnostic[],
  path: string,
): ResolvedParameter | undefined {
  if (binding.kind === "inline") return binding;
  const component = context.closure.componentIds.has(binding.componentId)
    ? context.snapshot.context.getComponent(binding.componentId)
    : undefined;
  if (!component || component.kind !== "parameter") {
    addDiagnostic(diagnostics, "error", "OPENAPI_PARAMETER_REFERENCE_INVALID", `${path}.componentId`, "The parameter component reference is missing or has the wrong kind.", false, context.contract.id);
    return undefined;
  }
  if (component.definition.location !== location) {
    addDiagnostic(diagnostics, "error", "OPENAPI_PARAMETER_LOCATION_MISMATCH", `${path}.componentId`, "The parameter component location does not match its use.", false, context.contract.id);
    return undefined;
  }
  return {
    name: component.definition.name,
    schema: component.definition.schema,
    required: component.definition.required,
    description: component.definition.description,
    enabled: binding.enabled ?? true,
    ...(binding.value === undefined ? {} : { value: binding.value }),
  };
}

function requestBodyToOpenapi(
  body: DeepReadonly<RequestBody>,
  version: "3.0" | "3.1",
  modelNames: Map<string, string>,
  context: ApiExportContext,
  diagnostics: OpenapiExportDiagnostic[],
): OasRecord | undefined {
  const media: OasRecord = Object.create(null) as OasRecord;
  switch (body.kind) {
    case "none":
      return undefined;
    case "json":
    case "xml":
    case "text": {
      const mediaType = body.kind === "json" ? "application/json" : body.kind === "xml" ? "application/xml" : "text/plain";
      const item: OasRecord = {};
      if (body.schema) item.schema = schemaToOpenapi(body.schema, {
        version, modelNames, secretRefIds: context.secretRefIds, diagnostics,
        ownerId: context.contract.id, path: "request.body.schema",
      });
      setSafe(media, mediaType, item);
      if (body.content.trim()) {
        addDiagnostic(diagnostics, "warning", "OPENAPI_REQUEST_BODY_SAMPLE_OMITTED", "request.body.content", "Local request body sample values are not copied into the OpenAPI contract.", false, context.contract.id);
      }
      break;
    }
    case "urlencoded": {
      const properties: OasRecord = Object.create(null) as OasRecord;
      const seen = new Set<string>();
      body.fields.forEach((field, index) => {
        if (!field.enabled) {
          addDiagnostic(diagnostics, "warning", "OPENAPI_BODY_FIELD_DISABLED_OMITTED", `request.body.fields[${index}]`, "A disabled local form field is omitted from the OpenAPI schema.", true, context.contract.id);
          return;
        }
        if (seen.has(field.name)) {
          addDiagnostic(diagnostics, "error", "OPENAPI_BODY_FIELD_DUPLICATE", `request.body.fields[${index}].name`, "OpenAPI form schemas cannot preserve duplicate field names.", false, context.contract.id);
          return;
        }
        seen.add(field.name);
        setSafe(properties, field.name, { type: "string" });
        if (field.value !== "") addDiagnostic(diagnostics, "warning", "OPENAPI_BODY_RUNTIME_VALUE_OMITTED", `request.body.fields[${index}].value`, "Local form field values are not copied into the OpenAPI contract.", false, context.contract.id);
      });
      setSafe(media, "application/x-www-form-urlencoded", { schema: { type: "object", properties } });
      break;
    }
    case "multipart": {
      const properties: OasRecord = Object.create(null) as OasRecord;
      const encoding: OasRecord = Object.create(null) as OasRecord;
      const seen = new Set<string>();
      body.entries.forEach((entry, index) => {
        if (!entry.enabled) {
          addDiagnostic(diagnostics, "warning", "OPENAPI_BODY_FIELD_DISABLED_OMITTED", `request.body.entries[${index}]`, "A disabled local multipart field is omitted from the OpenAPI schema.", true, context.contract.id);
          return;
        }
        if (seen.has(entry.name)) {
          addDiagnostic(diagnostics, "error", "OPENAPI_BODY_FIELD_DUPLICATE", `request.body.entries[${index}].name`, "OpenAPI multipart schemas cannot preserve duplicate field names.", false, context.contract.id);
          return;
        }
        seen.add(entry.name);
        if (entry.kind === "file") {
          setSafe(properties, entry.name, { type: "string", format: "binary" });
          addDiagnostic(diagnostics, "warning", "OPENAPI_LOCAL_FILE_REFERENCE_OMITTED", `request.body.entries[${index}].file`, "The local file path is not part of the OpenAPI document.", false, context.contract.id);
          if (entry.contentType) setSafe(encoding, entry.name, { contentType: entry.contentType });
        } else {
          setSafe(properties, entry.name, { type: "string" });
          if (entry.value !== "") addDiagnostic(diagnostics, "warning", "OPENAPI_BODY_RUNTIME_VALUE_OMITTED", `request.body.entries[${index}].value`, "Local multipart field values are not copied into the OpenAPI contract.", false, context.contract.id);
        }
      });
      const item: OasRecord = { schema: { type: "object", properties } };
      if (Object.keys(encoding).length > 0) item.encoding = encoding;
      setSafe(media, "multipart/form-data", item);
      if (Object.values(encoding).length > 0) {
        addDiagnostic(diagnostics, "warning", "OPENAPI_MULTIPART_ENCODING_ROUNDTRIP_LIMITED", "request.body.entries", "Per-part encoding metadata is exported, but the current importer does not restore every encoding option.", true, context.contract.id);
      }
      break;
    }
    case "binary":
      setSafe(media, body.contentType || "application/octet-stream", { schema: { type: "string", format: "binary" } });
      addDiagnostic(diagnostics, "warning", "OPENAPI_LOCAL_FILE_REFERENCE_OMITTED", "request.body.file", "The local file path is not part of the OpenAPI document.", false, context.contract.id);
      break;
    case "graphql":
      addDiagnostic(diagnostics, "warning", "OPENAPI_GRAPHQL_SEMANTICS_UNSUPPORTED", "request.body", "GraphQL operation semantics are not represented by the supported OpenAPI contract subset.", true, context.contract.id);
      return undefined;
  }
  return { content: media };
}

function responseMap(
  context: ApiExportContext,
  version: "3.0" | "3.1",
  modelNames: Map<string, string>,
  diagnostics: OpenapiExportDiagnostic[],
): OasRecord {
  const responses: OasRecord = Object.create(null) as OasRecord;
  const seenStatuses = new Set<string>();
  context.contract.responses.forEach((binding, index) => {
    const response = resolveResponse(binding, context, diagnostics, `contract.responses[${index}]`);
    if (!response) return;
    if (seenStatuses.has(response.status)) {
      addDiagnostic(diagnostics, "error", "OPENAPI_RESPONSE_STATUS_DUPLICATE", `contract.responses[${index}].status`, "An OpenAPI operation cannot have duplicate response status keys.", false, context.contract.id);
      return;
    }
    seenStatuses.add(response.status);
    const output: OasRecord = { description: sanitizeDocumentProse(response.description, context.secretRefIds) || "Response" };
    const headers: OasRecord = Object.create(null) as OasRecord;
    for (const [name, description] of Object.entries(response.headers)) {
      setSafe(headers, name, { description: sanitizeDocumentProse(description, context.secretRefIds), schema: { type: "string" } });
    }
    if (Object.keys(headers).length > 0) output.headers = headers;
    const content: OasRecord = Object.create(null) as OasRecord;
    for (const [mediaType, responseContent] of Object.entries(response.content)) {
      const media: OasRecord = {};
      if (responseContent.schema) media.schema = schemaToOpenapi(responseContent.schema, {
        version, modelNames, secretRefIds: context.secretRefIds, diagnostics,
        ownerId: context.contract.id, path: `contract.responses[${index}].content.${mediaType}.schema`,
      });
      const examples: OasRecord = Object.create(null) as OasRecord;
      responseContent.examples.forEach((example, exampleIndex) => {
        const resolved = resolveExample(example, context, diagnostics, `contract.responses[${index}].content.${mediaType}.examples[${exampleIndex}]`);
        if (!resolved) return;
        if (Object.hasOwn(examples, resolved.name)) {
          addDiagnostic(diagnostics, "error", "OPENAPI_EXAMPLE_NAME_DUPLICATE", `contract.responses[${index}].content.${mediaType}.examples[${exampleIndex}]`, "Response examples need unique names to be represented in OpenAPI.", false, context.contract.id);
          return;
        }
        setSafe(examples, resolved.name, {
          summary: sanitizeDocumentText(resolved.name, context.secretRefIds),
          value: sanitizeJsonValue(resolved.value, context.secretRefIds),
        });
      });
      if (Object.keys(examples).length > 0) media.examples = examples;
      setSafe(content, mediaType, media);
    }
    if (Object.keys(content).length > 0) output.content = content;
    setSafe(responses, response.status, output);
  });
  if (Object.keys(responses).length === 0) {
    addDiagnostic(diagnostics, "error", "OPENAPI_RESPONSES_REQUIRED", "contract.responses", "An OpenAPI operation must define at least one response.", false, context.contract.id);
  }
  return responses;
}

function resolveResponse(
  binding: DeepReadonly<ResponseBinding>,
  context: ApiExportContext,
  diagnostics: OpenapiExportDiagnostic[],
  path: string,
): DeepReadonly<ResponseDefinition> | undefined {
  if (binding.kind === "inline") return binding;
  const component = context.components.find((candidate) => candidate.id === binding.componentId);
  if (!component || component.kind !== "response") {
    addDiagnostic(diagnostics, "error", "OPENAPI_RESPONSE_REFERENCE_INVALID", `${path}.componentId`, "The response component reference is missing or has the wrong kind.", false, context.contract.id);
    return undefined;
  }
  return component.definition;
}

function resolveExample(
  binding: DeepReadonly<ExampleBinding>,
  context: ApiExportContext,
  diagnostics: OpenapiExportDiagnostic[],
  path: string,
): { name: string; value: DeepReadonly<JsonValue> } | undefined {
  if (binding.kind === "inline") return { name: binding.name, value: binding.value };
  const component = context.components.find((candidate) => candidate.id === binding.componentId);
  if (!component || component.kind !== "example") {
    addDiagnostic(diagnostics, "error", "OPENAPI_EXAMPLE_REFERENCE_INVALID", `${path}.componentId`, "The example component reference is missing or has the wrong kind.", false, context.contract.id);
    return undefined;
  }
  return { name: component.definition.name, value: component.definition.value };
}

function authRequirement(
  binding: DeepReadonly<AuthBinding>,
  context: ApiExportContext,
  schemes: OasRecord,
  diagnostics: OpenapiExportDiagnostic[],
): Array<Record<string, string[]>> | undefined {
  let auth: DeepReadonly<InlineAuthBinding>;
  let preferredName: string | undefined;
  if (binding.kind === "componentRef") {
    const component = context.closure.componentIds.has(binding.componentId)
      ? context.snapshot.context.getComponent(binding.componentId)
      : undefined;
    if (!component || component.kind !== "auth") {
      addDiagnostic(diagnostics, "error", "OPENAPI_AUTH_REFERENCE_INVALID", "request.auth.componentId", "The authentication component reference is missing or has the wrong kind.", false, context.contract.id);
      return undefined;
    }
    auth = component.definition;
    preferredName = component.name;
  } else {
    auth = binding;
  }
  if (auth.kind === "none") return undefined;

  let scheme: OasRecord;
  let baseName: string;
  switch (auth.kind) {
    case "bearer":
      scheme = { type: "http", scheme: "bearer" };
      baseName = preferredName || "BearerAuth";
      break;
    case "basic":
      scheme = { type: "http", scheme: "basic" };
      baseName = preferredName || "BasicAuth";
      if (auth.username) addDiagnostic(diagnostics, "warning", "OPENAPI_BASIC_USERNAME_OMITTED", "request.auth.username", "The local Basic Auth username is not copied into the OpenAPI security scheme.", false, context.contract.id);
      break;
    case "apikey":
      if (!auth.name.trim()) {
        addDiagnostic(diagnostics, "error", "OPENAPI_API_KEY_NAME_EMPTY", "request.auth.name", "An OpenAPI API key scheme requires a non-empty key name.", false, context.contract.id);
        return undefined;
      }
      scheme = { type: "apiKey", name: sanitizeDocumentText(auth.name, context.secretRefIds), in: auth.placement };
      baseName = preferredName || "ApiKeyAuth";
      break;
  }
  const existingName = Object.entries(schemes).find(([, value]) => JSON.stringify(value) === JSON.stringify(scheme))?.[0];
  let name = existingName;
  if (!name) {
    name = createNameAllocator(new Set(Object.keys(schemes))).allocate(preferredName || baseName);
    setSafe(schemes, name, scheme);
  }
  return [{ [name]: [] }];
}

function serverForUrl(
  rawUrl: string,
  context: ApiExportContext,
  diagnostics: OpenapiExportDiagnostic[],
): OasRecord | undefined {
  if (!rawUrl.trim()) return undefined;
  let url = sanitizeDocumentUrl(rawUrl, context.secretRefIds);
  const userInfo = /^(\b[a-z][a-z0-9+.-]*:\/\/)[^/@/?#]*@/i.exec(url);
  if (userInfo) {
    url = `${userInfo[1]}${url.slice(userInfo[0].length)}`;
    addDiagnostic(diagnostics, "warning", "OPENAPI_SERVER_USERINFO_OMITTED", "request.baseUrl", "Credentials embedded in the server URL are omitted from the public document.", false, context.contract.id);
  }
  url = url.replace(/\{\{([^{}]+)\}\}/g, "{$1}");
  const variableNames = [...new Set([...url.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? ""))];
  const variables: OasRecord = Object.create(null) as OasRecord;
  for (const name of variableNames) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      addDiagnostic(diagnostics, "error", "OPENAPI_SERVER_VARIABLE_INVALID", "request.baseUrl", "A server URL variable name is not valid in OpenAPI.", false, context.contract.id);
      return undefined;
    }
    setSafe(variables, name, { default: "" });
    addDiagnostic(diagnostics, "warning", "OPENAPI_SERVER_VARIABLE_DEFAULT_MISSING", `request.baseUrl.variables.${name}`, "The unresolved source variable is retained as an OpenAPI server variable with an empty default.", true, context.contract.id);
  }
  const probe = url.replace(/\{([^{}]+)\}/g, "openapi-variable");
  try {
    new URL(probe, "https://openapi.invalid/");
  } catch {
    addDiagnostic(diagnostics, "error", "OPENAPI_SERVER_URL_INVALID", "request.baseUrl", "The source base URL cannot be represented as a valid OpenAPI server URL.", false, context.contract.id);
    return undefined;
  }
  return Object.keys(variables).length > 0 ? { url, variables } : { url };
}

interface SchemaContext {
  version: "3.0" | "3.1";
  modelNames: Map<string, string>;
  secretRefIds: Set<string>;
  diagnostics: OpenapiExportDiagnostic[];
  ownerId: string;
  path: string;
  fieldName?: string;
}

function schemaToOpenapi(schema: DeepReadonly<SchemaNode>, context: SchemaContext): OasRecord {
  const output: OasRecord = Object.create(null) as OasRecord;
  if (schema.description !== undefined) output.description = sanitizeDocumentProse(schema.description, context.secretRefIds);
  if (schema.default !== undefined) output.default = sanitizeJsonValue(schema.default, context.secretRefIds, context.fieldName);
  if (schema.enum !== undefined) output.enum = schema.enum.map((value) => sanitizeJsonValue(value, context.secretRefIds, context.fieldName));
  if (schema.examples !== undefined) {
    if (context.version === "3.1") output.examples = schema.examples.map((value) => sanitizeJsonValue(value, context.secretRefIds, context.fieldName));
    else if (schema.examples.length === 1) output.example = sanitizeJsonValue(schema.examples[0]!, context.secretRefIds, context.fieldName);
    else if (schema.examples.length > 1) {
      output.example = sanitizeJsonValue(schema.examples[0]!, context.secretRefIds, context.fieldName);
      addDiagnostic(context.diagnostics, "warning", "OPENAPI_SCHEMA_EXAMPLES_TRUNCATED", `${context.path}.examples`, "OpenAPI 3.0 supports one Schema Object example; additional schema examples are omitted.", true, context.ownerId);
    }
  }
  switch (schema.kind) {
    case "modelRef": {
      const name = context.modelNames.get(schema.modelId);
      if (!name) {
        addDiagnostic(context.diagnostics, "error", "OPENAPI_SCHEMA_MODEL_REFERENCE_INVALID", `${context.path}.modelId`, "The referenced model is missing from the selected dependency closure.", false, context.ownerId);
        return output;
      }
      const reference = `#/components/schemas/${escapePointer(name)}`;
      if (context.version === "3.0" && Object.keys(output).length > 0) output.allOf = [{ $ref: reference }];
      else output.$ref = reference;
      return output;
    }
    case "scalar":
      if (schema.type === "null" && context.version === "3.0") {
        addDiagnostic(context.diagnostics, "warning", "OPENAPI_NULL_SCHEMA_UNSUPPORTED", context.path, "OpenAPI 3.0 cannot represent a null-only schema; this schema is emitted unconstrained.", true, context.ownerId);
        return output;
      }
      output.type = schema.type;
      return output;
    case "object": {
      output.type = "object";
      const properties: OasRecord = Object.create(null) as OasRecord;
      for (const [name, child] of Object.entries(schema.properties)) {
        setSafe(properties, name, schemaToOpenapi(child, { ...context, path: `${context.path}.properties.${name}`, fieldName: name }));
      }
      if (Object.keys(properties).length > 0) output.properties = properties;
      if (schema.required.length > 0) output.required = [...schema.required];
      output.additionalProperties = typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : schemaToOpenapi(schema.additionalProperties, { ...context, path: `${context.path}.additionalProperties`, fieldName: undefined });
      return output;
    }
    case "array":
      output.type = "array";
      output.items = schemaToOpenapi(schema.items, { ...context, path: `${context.path}.items`, fieldName: undefined });
      return output;
    case "allOf":
    case "oneOf":
    case "anyOf":
      output[schema.kind] = schema.variants.map((variant, index) => schemaToOpenapi(variant, { ...context, path: `${context.path}.${schema.kind}[${index}]`, fieldName: undefined }));
      return output;
  }
}

function modelsInClosure(snapshot: ProjectSnapshot, contexts: ApiExportContext[]): DeepReadonly<ModelAsset>[] {
  const ids = new Set(contexts.flatMap((context) => [...context.closure.modelIds]));
  return snapshot.project.models.filter((model) => ids.has(model.id));
}

function createSchemaNames(
  snapshot: ProjectSnapshot,
  contexts: ApiExportContext[],
  diagnostics: OpenapiExportDiagnostic[],
): Map<string, string> {
  const names = new Map<string, string>();
  const allocator = createNameAllocator();
  for (const model of modelsInClosure(snapshot, contexts)) {
    if (names.has(model.id)) continue;
    const preferred = openapiComponentName(model.name) || "Model";
    const name = allocator.allocate(preferred);
    names.set(model.id, name);
    if (name !== model.name) {
      addDiagnostic(diagnostics, "warning", "OPENAPI_MODEL_NAME_NORMALIZED", `models.${name}`, "The model name was normalized to a valid OpenAPI component name.", false, model.id);
    }
  }
  return names;
}

function selectInfoVersion(
  contexts: ApiExportContext[],
  explicit: string | undefined,
  diagnostics: OpenapiExportDiagnostic[],
): string {
  if (explicit !== undefined) {
    if (explicit.trim()) return explicit;
    addDiagnostic(diagnostics, "error", "OPENAPI_INFO_VERSION_EMPTY", "options.infoVersion", "info.version must be a non-empty string.", false);
    return "1.0.0";
  }
  if (contexts.length === 1 && contexts[0]?.contract.metadata.version.trim()) return contexts[0].contract.metadata.version;
  addDiagnostic(diagnostics, "warning", "OPENAPI_INFO_VERSION_DEFAULTED", "info.version", "No single interface version is available; info.version defaults to 1.0.0.", false);
  return "1.0.0";
}

function sanitizeJsonValue(value: DeepReadonly<JsonValue>, secretRefIds: Set<string>, fieldName?: string): JsonValue {
  const redacted = redactCredentialValue(value as JsonValue, fieldName);
  const visit = (current: JsonValue, key?: string): JsonValue => {
    if (key && isCredentialFieldName(key)) return MASKED_SECRET_PLACEHOLDER;
    if (typeof current === "string") return sanitizeDocumentText(current, secretRefIds);
    if (Array.isArray(current)) return current.map((item) => visit(item));
    if (current !== null && typeof current === "object") {
      const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const [childKey, child] of Object.entries(current)) setSafe(output, childKey, visit(child, childKey));
      return output;
    }
    return current;
  };
  return visit(redacted);
}

function openapiComponentName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^([^A-Za-z0-9._-])/, "_");
}

function createNameAllocator(initial: Set<string> = new Set()): NameAllocator {
  const used = new Set(initial);
  return {
    used,
    allocate(preferred) {
      let candidate = openapiComponentName(preferred) || "Component";
      let index = 2;
      while (used.has(candidate)) candidate = `${openapiComponentName(preferred) || "Component"}${index++}`;
      used.add(candidate);
      return candidate;
    },
  };
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function fromDocumentDiagnostic(diagnostic: DocumentDiagnostic): OpenapiExportDiagnostic {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    path: diagnostic.path,
    message: diagnostic.message,
    lossy: diagnostic.lossy,
    ...(diagnostic.ownerId === undefined ? {} : { ownerId: diagnostic.ownerId }),
  };
}

function addDiagnostic(
  diagnostics: OpenapiExportDiagnostic[],
  severity: OpenapiExportDiagnostic["severity"],
  code: string,
  path: string,
  message: string,
  lossy: boolean,
  ownerId?: string,
): void {
  diagnostics.push({ severity, code, path, message, lossy, ...(ownerId === undefined ? {} : { ownerId }) });
}

function deduplicateDiagnostics(diagnostics: OpenapiExportDiagnostic[]): OpenapiExportDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.path, diagnostic.ownerId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function setSafe(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}
