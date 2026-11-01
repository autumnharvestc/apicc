import type { ProjectAssetContextReadView, DeepReadonly } from "../assets/context.js";
import type {
  ApiAsset,
  ApiContract,
  AuthBinding,
  ExampleBinding,
  ModelAsset,
  ParameterBinding,
  RequestBody,
  ResponseBinding,
  SchemaNode,
} from "../contract/model.js";
import type { JsonValue } from "../contract/schemaNode.js";
import { isCredentialFieldName, MASKED_SECRET_PLACEHOLDER, redactCommonCredentialText } from "../import/schemaMapping.js";
import { jsonPathFieldNames, normalizeSavedAssertionPath } from "../assert/selection.js";
import type { Assertion } from "../testing/model.js";

export interface ContractAiView extends Record<string, unknown> {
  contractId: string;
  name: string;
  request: Record<string, unknown>;
  responses: unknown[];
  models: unknown[];
  references: { modelIds: string[]; componentIds: string[] };
}

interface ViewState {
  context: ProjectAssetContextReadView;
  modelIds: Set<string>;
  componentIds: Set<string>;
  includeBodies: boolean;
}

/** Build a data-only design view from an API and the read-only context for the same project snapshot. */
export function contractAiView(asset: DeepReadonly<ApiAsset>, context: ProjectAssetContextReadView, options: { includeBodies?: boolean } = {}): ContractAiView {
  const contract = context.getContract(asset.contract.id);
  if (!contract) throw new TypeError("The API asset must belong to the supplied project snapshot context.");
  const state: ViewState = { context, modelIds: new Set(), componentIds: new Set(), includeBodies: options.includeBodies ?? true };
  const request = requestView(contract, state);
  const responses = contract.responses.map((response) => responseView(response, state));
  const models: Array<Record<string, unknown>> = [];
  const visitedModels = new Set<string>();
  while (true) {
    const nextId = [...state.modelIds].find((id) => !visitedModels.has(id));
    if (!nextId) break;
    visitedModels.add(nextId);
    const model = context.getModel(nextId);
    if (!model) {
      models.push({ id: nextId, unresolved: true });
      continue;
    }
    models.push(modelView(model, state));
  }
  const metadata = contract.metadata;
  return redactProjectionText({
    contractId: contract.id,
    name: metadata.name,
    description: metadata.description,
    version: metadata.version,
    tags: [...metadata.tags],
    request,
    responses,
    models,
    references: {
      modelIds: [...state.modelIds].sort(),
      componentIds: [...state.componentIds].sort(),
    },
  }) as ContractAiView;
}

// Only called on this module's explicit contract/schema projection. Credential-valued
// data is handled at its typed source; schema property names are declarations, not values.
export function redactProjectionText(value: unknown): unknown {
  if (typeof value === "string") return redactAiText(value);
  if (Array.isArray(value)) return value.map(redactProjectionText);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactAiText(key), redactProjectionText(item)]));
  return value;
}

function requestView(contract: DeepReadonly<ApiContract>, state: ViewState): Record<string, unknown> {
  const request = contract.request;
  const common = {
    protocol: request.protocol,
    baseUrl: redactUrl(request.baseUrl),
    path: redactUrl(request.path),
    pathParams: request.pathParams.map((parameter) => parameterView(parameter, state)),
    query: request.query.map((parameter) => parameterView(parameter, state)),
    headers: request.headers.map((parameter) => parameterView(parameter, state)),
    cookies: request.cookies.map((parameter) => parameterView(parameter, state)),
    auth: authView(request.auth, state),
  };
  if (request.protocol === "http") return { ...common, method: request.method, body: bodyView(request.body, state) };
  if (request.protocol === "soap") {
    const view: Record<string, unknown> = { ...common, method: request.method, soapAction: request.soapAction };
    if (state.includeBodies) view.envelope = redactBodyText(request.envelope);
    return view;
  }
  const view: Record<string, unknown> = { ...common };
  if (state.includeBodies && request.message !== undefined) view.message = redactBodyText(request.message);
  return view;
}

function parameterView(parameter: DeepReadonly<ParameterBinding>, state: ViewState): Record<string, unknown> {
  if (parameter.kind === "inline") {
    return {
      kind: "inline",
      id: parameter.id,
      name: parameter.name,
      required: parameter.required,
      enabled: parameter.enabled,
      description: parameter.description,
      schema: schemaView(parameter.schema, state, parameter.name),
      ...(parameter.value === undefined ? {} : { value: safeFieldValue(parameter.value, parameter.name) }),
    };
  }
  state.componentIds.add(parameter.componentId);
  const component = state.context.getComponent(parameter.componentId);
  if (!component || component.kind !== "parameter") {
    return { kind: "componentRef", id: parameter.id, componentId: parameter.componentId, expectedKind: "parameter", unresolved: true };
  }
  return {
    kind: "componentRef",
    id: parameter.id,
    componentId: component.id,
    expectedKind: "parameter",
    name: component.definition.name,
    location: component.definition.location,
    required: component.definition.required,
    description: component.definition.description,
    schema: schemaView(component.definition.schema, state, component.definition.name),
    ...(parameter.value === undefined ? {} : { value: safeFieldValue(parameter.value, component.definition.name) }),
  };
}

function authView(auth: DeepReadonly<AuthBinding>, state: ViewState): Record<string, unknown> {
  if (auth.kind === "none") return { kind: "none" };
  if (auth.kind === "componentRef") {
    state.componentIds.add(auth.componentId);
    const component = state.context.getComponent(auth.componentId);
    if (!component || component.kind !== "auth") return { kind: "componentRef", componentId: auth.componentId, expectedKind: "auth", unresolved: true };
    return authTypeView(component.definition.kind);
  }
  return authTypeView(auth.kind);
}

function authTypeView(kind: string): Record<string, unknown> {
  if (kind === "none") return { kind: "none" };
  return {
    kind,
    placeholder: MASKED_SECRET_PLACEHOLDER,
  };
}

function bodyView(body: DeepReadonly<RequestBody>, state: ViewState): Record<string, unknown> {
  const view = bodyDesignView(body, state);
  if (!state.includeBodies) {
    if (body.kind === "graphql") { delete view.query; delete view.variables; }
    if (body.kind === "urlencoded") for (const field of view.fields as Array<Record<string, unknown>>) delete field.value;
    if (body.kind === "multipart") for (const entry of view.entries as Array<Record<string, unknown>>) delete entry.value;
  }
  return view;
}

function bodyDesignView(body: DeepReadonly<RequestBody>, state: ViewState): Record<string, unknown> {
  switch (body.kind) {
    case "none":
      return { kind: "none" };
    case "json":
    case "xml":
    case "text":
      return {
        kind: body.kind,
        ...(state.includeBodies ? { content: redactBodyText(body.content) } : {}),
        ...(body.schema ? { schema: schemaView(body.schema, state) } : {}),
      };
    case "graphql":
      return {
        kind: "graphql",
        query: redactBodyText(body.query),
        ...(body.variables === undefined ? {} : { variables: redactBodyText(body.variables) }),
        ...(body.operationName === undefined ? {} : { operationName: body.operationName }),
      };
    case "urlencoded":
      return {
        kind: "urlencoded",
        fields: body.fields.map((field) => ({ id: field.id, name: field.name, enabled: field.enabled, value: safeFieldValue(field.value, field.name) })),
      };
    case "multipart":
      return {
        kind: "multipart",
        entries: body.entries.map((entry) => entry.kind === "text"
          ? { kind: "text", id: entry.id, name: entry.name, enabled: entry.enabled, value: safeFieldValue(entry.value, entry.name) }
          : { kind: "file", id: entry.id, name: entry.name, contentType: entry.contentType, enabled: entry.enabled }),
      };
    case "binary":
      return { kind: "binary", contentType: body.contentType, file: { bound: Boolean(body.file.path) } };
  }
}

function responseView(response: DeepReadonly<ResponseBinding>, state: ViewState): Record<string, unknown> {
  if (response.kind === "componentRef") {
    state.componentIds.add(response.componentId);
    const component = state.context.getComponent(response.componentId);
    if (!component || component.kind !== "response") {
      return { kind: "componentRef", id: response.id, componentId: response.componentId, expectedKind: "response", unresolved: true };
    }
    return {
      kind: "componentRef",
      id: response.id,
      componentId: component.id,
      expectedKind: "response",
      definition: responseDefinitionView(component.definition, state),
    };
  }
  return { kind: "inline", id: response.id, ...responseDefinitionView(response, state) };
}

function responseDefinitionView(response: DeepReadonly<{
  status: string;
  description: string;
  headers: Record<string, string>;
  content: Record<string, { schema?: SchemaNode; examples: ExampleBinding[] }>;
}>, state: ViewState): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) headers[name] = safeFieldValue(value, name);
  const content: Record<string, unknown> = {};
  for (const [mediaType, item] of Object.entries(response.content)) {
    const examples = item.examples.map((example) => exampleView(example, state));
    if (!state.includeBodies) for (const example of examples) delete example.value;
    Object.defineProperty(content, mediaType, {
      value: {
        ...(item.schema ? { schema: schemaView(item.schema, state) } : {}),
        examples,
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { status: response.status, description: response.description, headers, content };
}

function exampleView(example: DeepReadonly<ExampleBinding>, state: ViewState): Record<string, unknown> {
  if (example.kind === "componentRef") {
    state.componentIds.add(example.componentId);
    const component = state.context.getComponent(example.componentId);
    if (!component || component.kind !== "example") {
      return { kind: "componentRef", id: example.id, componentId: example.componentId, expectedKind: "example", unresolved: true };
    }
    return {
      kind: "componentRef",
      id: example.id,
      componentId: component.id,
      expectedKind: "example",
      name: component.definition.name,
      value: redactReadonlyJson(component.definition.value),
    };
  }
  return { kind: "inline", id: example.id, name: example.name, value: redactReadonlyJson(example.value) };
}

function modelView(model: DeepReadonly<ModelAsset>, state: ViewState): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    schema: schemaView(model.schema, state),
  };
}

/** Internal shared structure projection; no body values or credential references. */
export function schemaAiView(schema: DeepReadonly<SchemaNode>, context: ProjectAssetContextReadView, fieldName?: string): Record<string, unknown> {
  return redactProjectionText(schemaView(schema, { context, modelIds: new Set(), componentIds: new Set(), includeBodies: false }, fieldName)) as Record<string, unknown>;
}

export function componentAiView(component: DeepReadonly<import("../contract/model.js").ComponentAsset>, context: ProjectAssetContextReadView): Record<string, unknown> {
  const state: ViewState = { context, modelIds: new Set(), componentIds: new Set(), includeBodies: false };
  let definition: Record<string, unknown>;
  switch (component.kind) {
    case "parameter": definition = { location: component.definition.location, name: component.definition.name, schema: schemaView(component.definition.schema, state, component.definition.name), required: component.definition.required, description: component.definition.description }; break;
    case "response": definition = responseDefinitionView(component.definition, state); break;
    case "auth": definition = { kind: component.definition.kind, referenced: component.definition.kind !== "none" }; break;
    case "example": definition = { name: component.definition.name }; break;
  }
  return redactProjectionText({ id: component.id, name: component.name, description: component.description, kind: component.kind, definition }) as Record<string, unknown>;
}

function schemaView(schema: DeepReadonly<SchemaNode>, state: ViewState, fieldName?: string): Record<string, unknown> {
  const annotations: Record<string, unknown> = {};
  if (schema.description !== undefined) annotations.description = schema.description;
  if (schema.default !== undefined) annotations.default = redactReadonlyJson(schema.default, fieldName);
  if (schema.examples !== undefined) annotations.examples = schema.examples.map((value) => redactReadonlyJson(value, fieldName));
  if (schema.enum !== undefined) annotations.enum = schema.enum.map((value) => redactReadonlyJson(value, fieldName));
  switch (schema.kind) {
    case "scalar":
      return { ...annotations, kind: "scalar", type: schema.type };
    case "modelRef":
      state.modelIds.add(schema.modelId);
      return { ...annotations, kind: "modelRef", modelId: schema.modelId };
    case "array":
      return { ...annotations, kind: "array", items: schemaView(schema.items, state) };
    case "object": {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(schema.properties)) {
        Object.defineProperty(properties, name, { value: schemaView(child, state, name), enumerable: true, configurable: true, writable: true });
      }
      return {
        ...annotations,
        kind: "object",
        properties,
        required: [...schema.required],
        additionalProperties: typeof schema.additionalProperties === "boolean"
          ? schema.additionalProperties
          : schemaView(schema.additionalProperties, state),
      };
    }
    case "allOf":
    case "oneOf":
    case "anyOf":
      return { ...annotations, kind: schema.kind, variants: schema.variants.map((variant) => schemaView(variant, state)) };
  }
}

function safeFieldValue(value: string, name: string): string {
  return safeAiValue(value, name) as string;
}

function redactReadonlyJson(value: DeepReadonly<JsonValue>, fieldName?: string): JsonValue {
  return safeAiValue(copyReadonlyJson(value), fieldName) as JsonValue;
}

function copyReadonlyJson(value: DeepReadonly<JsonValue>): JsonValue {
  if (Array.isArray(value)) return value.map((item) => copyReadonlyJson(item));
  if (value !== null && typeof value === "object") {
    const copy: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(copy, key, { value: copyReadonlyJson(child as DeepReadonly<JsonValue>), enumerable: true, configurable: true, writable: true });
    }
    return copy;
  }
  return value as JsonValue;
}

function redactBodyText(value: string): string {
  try {
    const parsed = JSON.parse(value) as JsonValue;
    return JSON.stringify(safeAiValue(parsed));
  } catch {
    return redactCommonCredentialText(value);
  }
}

function redactUrl(value: string): string {
  const withoutUserInfo = value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@/?#]*@/gi, `$1${MASKED_SECRET_PLACEHOLDER}@`);
  return withoutUserInfo.replace(/([?&][^=&#]*(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token)[^=&#]*=)[^&#]*/gi, `$1${MASKED_SECRET_PLACEHOLDER}`);
}

/** Heuristic secondary protection for already selected data, never a credential resolver. */
export function redactAiText(value: string): string {
  // The generic assignment masker consumes '&' as ordinary credential text.
  // Preserve boundaries only after a typed URL query value was already masked;
  // the header masker still sees and removes its entire original line.
  let boundary = ";apicc-masked-query-boundary;";
  while (value.includes(boundary)) boundary += ";";
  const urls = redactUrl(value).replace(/([?&][^=&#]*(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token)[^=&#]*=)\*{4}(?=&)/gi, `$1****${boundary}`);
  return redactCommonCredentialText(urls).split(boundary).join("")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bfile:\/\/[^\s"'<>]+/gi, "[REDACTED]")
    .replace(/\\\\[^\s\\"'<>]+\\[^\s"'<>]+/g, "[REDACTED]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, "[REDACTED]")
    .replace(/(^|[\s"'])(\/(?:home|Users|usr|etc|var|tmp|opt|root|mnt)\/[^\s"'<>]*)/g, "$1[REDACTED]")
    .replace(/\*\*\*\*/g, "[REDACTED]");
}

export function safeAiValue(value: unknown, field?: string): unknown {
  if (field && isCredentialFieldName(field)) return "[REDACTED]";
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      // A string remains a string; only containers have structured credential fields.
      if (parsed && typeof parsed === "object") return redactAiText(JSON.stringify(safeAiValue(parsed)));
    } catch { /* Ordinary text still receives secondary text protection. */ }
    return redactAiText(value);
  }
  if (Array.isArray(value)) return value.map(item => safeAiValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactAiText(key), safeAiValue(item, key)]));
  return value;
}

/** Preserve saved selectors while applying their known secret semantics to expected. */
export function assertionAiView(assertion: DeepReadonly<Assertion>): Record<string, unknown> {
  const field = assertion.headerName ?? assertion.cookieName ?? (assertion.target === "bodyJson"
    ? jsonPathFieldNames(normalizeSavedAssertionPath(assertion) ?? "$").find(isCredentialFieldName) : assertion.path);
  return { id: assertion.id, target: assertion.target, op: assertion.op, path: assertion.path, headerName: assertion.headerName,
    cookieName: assertion.cookieName, match: assertion.match, expected: assertion.expected === undefined ? undefined : safeAiValue(assertion.expected, field),
    namespaces: assertion.namespaces ? { ...assertion.namespaces } : undefined, options: safeAiValue(assertion.options) };
}
