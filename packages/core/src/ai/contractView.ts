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
import { isCredentialFieldName, MASKED_SECRET_PLACEHOLDER, redactCommonCredentialText, redactCredentialValue } from "../import/schemaMapping.js";

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
}

/** Build a data-only design view from an API and the read-only context for the same project snapshot. */
export function contractAiView(asset: DeepReadonly<ApiAsset>, context: ProjectAssetContextReadView): ContractAiView {
  const contract = context.getContract(asset.contract.id);
  if (!contract) throw new TypeError("The API asset must belong to the supplied project snapshot context.");
  const state: ViewState = { context, modelIds: new Set(), componentIds: new Set() };
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
  return {
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
  };
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
  if (request.protocol === "soap") return { ...common, method: request.method, envelope: redactBodyText(request.envelope), soapAction: request.soapAction };
  return { ...common, message: request.message === undefined ? undefined : redactBodyText(request.message) };
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
  switch (body.kind) {
    case "none":
      return { kind: "none" };
    case "json":
    case "xml":
    case "text":
      return {
        kind: body.kind,
        content: redactBodyText(body.content),
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
    Object.defineProperty(content, mediaType, {
      value: {
        ...(item.schema ? { schema: schemaView(item.schema, state) } : {}),
        examples: item.examples.map((example) => exampleView(example, state)),
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
  return isCredentialFieldName(name) && value !== "" ? MASKED_SECRET_PLACEHOLDER : value;
}

function redactReadonlyJson(value: DeepReadonly<JsonValue>, fieldName?: string): JsonValue {
  return redactCredentialValue(copyReadonlyJson(value), fieldName);
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
    return JSON.stringify(redactCredentialValue(parsed));
  } catch {
    return redactCommonCredentialText(value);
  }
}

function redactUrl(value: string): string {
  const withoutUserInfo = value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@/?#]*@/i, `$1${MASKED_SECRET_PLACEHOLDER}@`);
  return withoutUserInfo.replace(/([?&][^=&#]*(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token)[^=&#]*=)[^&#]*/gi, `$1${MASKED_SECRET_PLACEHOLDER}`);
}
