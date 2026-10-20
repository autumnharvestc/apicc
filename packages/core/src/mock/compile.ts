import { Buffer } from "node:buffer";

import type { ApiAsset, ApiContract, ExampleBinding, ResponseBinding, ResponseContent, ResponseDefinition } from "../contract/model.js";
import type { ModelAsset } from "../contract/model.js";
import type { JsonValue, SchemaNode } from "../contract/schemaNode.js";
import type { ContractFolder } from "../contract/workspace.js";
import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import { generateMockJsonValue } from "./generate.js";
import type { MockCondition, MockDiagnostic, MockProjectConfig, MockRule } from "./config.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-type",
]);
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type CompiledPathSegment =
  | { kind: "literal"; value: string }
  | { kind: "parameter"; name: string };

export interface CompiledMockRule {
  id: string;
  contractId: string;
  responseBindingId: string;
  conditions: readonly MockCondition[];
  status: number;
  mediaType: string;
  headers: Readonly<Record<string, string>>;
  body: readonly number[];
  delayMs: number;
}

export interface CompiledMockRoute {
  contractId: string;
  method: string;
  pathTemplate: string;
  segments: readonly CompiledPathSegment[];
  rules: readonly CompiledMockRule[];
}

export interface CompiledMockPlan {
  sourceProjectRevision: string;
  routes: readonly CompiledMockRoute[];
}

export type CompileProjectMockResult =
  | { ok: true; plan: CompiledMockPlan }
  | { ok: false; diagnostics: readonly MockDiagnostic[] };

interface ApiEntry {
  asset: DeepReadonly<ApiAsset>;
  path: string;
}

interface CompiledPath {
  segments: CompiledPathSegment[];
  canonical: string;
  parameterNames: Set<string>;
}

export function compileProjectMock(snapshot: ProjectSnapshot): CompileProjectMockResult {
  const config = snapshot.project.mock as MockProjectConfig | undefined;
  const diagnostics: MockDiagnostic[] = [];
  const addDiagnostic = (code: string, path: string, message: string, ownerId?: string): void => {
    diagnostics.push({ severity: "error", code, path, message, lossy: false, ...(ownerId ? { ownerId } : {}) });
  };

  if (!config) {
    addDiagnostic("MOCK_NOT_CONFIGURED", "mock", "The project has no saved Mock configuration.", snapshot.project.id);
    return failure(diagnostics);
  }
  if (config.enabledContractIds.length === 0) {
    addDiagnostic("MOCK_NO_ENABLED_CONTRACTS", "mock.enabledContractIds", "Enable at least one HTTP contract to compile a Mock plan.", snapshot.project.id);
    return failure(diagnostics);
  }

  const apiEntries = collectApis(snapshot);
  const apiById = new Map<string, ApiEntry>();
  for (const entry of apiEntries) {
    const id = entry.asset.contract.id;
    if (apiById.has(id)) addDiagnostic("MOCK_CONTRACT_ID_AMBIGUOUS", entry.path + ".contract.id", "The project contains more than one API with this contract ID.", id);
    else apiById.set(id, entry);
  }

  const routes: CompiledMockRoute[] = [];
  for (const [enabledIndex, contractId] of config.enabledContractIds.entries()) {
    const entry = apiById.get(contractId);
    const configPath = `mock.enabledContractIds[${enabledIndex}]`;
    if (!entry) {
      addDiagnostic("MOCK_CONTRACT_NOT_FOUND", configPath, "An enabled contract does not exist in this project.", contractId);
      continue;
    }

    const { contract } = entry.asset;
    const request = contract.request;
    if (request.protocol !== "http" && request.protocol !== "soap") {
      addDiagnostic("MOCK_HTTP_ONLY", entry.path + ".contract.request.protocol", "Only HTTP-backed contracts can be compiled for the local Mock.", contractId);
      continue;
    }

    const compiledPath = compilePath(request.path);
    if (!compiledPath) {
      addDiagnostic("MOCK_ROUTE_INVALID", entry.path + ".contract.request.path", "The HTTP path must be an absolute path with valid whole-segment parameters.", contractId);
      continue;
    }

    const contractRules = config.rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.enabled && rule.contractId === contractId);
    validateDefaultOrdering(contractRules, contractId, addDiagnostic);
    const compiledRules: CompiledMockRule[] = [];
    for (const { rule, index } of contractRules) {
      const compiledRule = compileRule(snapshot, entry, rule, index, compiledPath.parameterNames, request.method, request.protocol === "soap", addDiagnostic);
      if (compiledRule) compiledRules.push(compiledRule);
    }

    routes.push({
      contractId,
      method: request.method,
      pathTemplate: request.path,
      segments: compiledPath.segments,
      rules: compiledRules,
    });
  }

  for (const [index, rule] of config.rules.entries()) {
    if (rule.enabled && !apiById.has(rule.contractId)) {
      addDiagnostic("MOCK_RULE_CONTRACT_NOT_FOUND", `mock.rules[${index}].contractId`, "An enabled rule references a contract that does not exist in this project.", rule.id);
    }
  }

  detectRouteAmbiguities(routes, apiById, addDiagnostic);
  routes.sort(compareRoutes);
  if (diagnostics.length > 0) return failure(diagnostics);

  return {
    ok: true,
    plan: deepFreeze({ sourceProjectRevision: snapshot.definitionRevision, routes }),
  };
}

function compileRule(
  snapshot: ProjectSnapshot,
  entry: ApiEntry,
  rule: MockRule,
  ruleIndex: number,
  pathParameterNames: Set<string>,
  httpMethod: string,
  soapTransport: boolean,
  addDiagnostic: (code: string, path: string, message: string, ownerId?: string) => void,
): CompiledMockRule | undefined {
  const root = `mock.rules[${ruleIndex}]`;
  let valid = true;
  for (const [conditionIndex, condition] of rule.conditions.entries()) {
    if (!validateCondition(condition, pathParameterNames, !soapTransport)) {
      addDiagnostic("MOCK_CONDITION_INVALID", `${root}.conditions[${conditionIndex}]`, "The condition uses an invalid name or JSON Pointer.", rule.id);
      valid = false;
    }
  }

  const responseBinding = entry.asset.contract.responses.find((response) => response.id === rule.responseBindingId);
  const response = responseBinding ? resolveResponse(responseBinding, snapshot) : undefined;
  if (!response) {
    addDiagnostic("MOCK_RESPONSE_NOT_FOUND", `${root}.responseBindingId`, "The selected response binding is missing or has the wrong kind.", rule.id);
    return undefined;
  }

  const status = rule.status ?? concreteStatus(response.status);
  if (status === undefined) {
    addDiagnostic("MOCK_STATUS_REQUIRED", `${root}.status`, "A wildcard or default response requires an explicit concrete HTTP status.", rule.id);
    valid = false;
  }

  const mediaTypeEntries = Object.entries(response.content).filter(([mediaType]) => mediaType.toLowerCase() === rule.mediaType.toLowerCase());
  if (mediaTypeEntries.length !== 1) {
    addDiagnostic("MOCK_MEDIA_TYPE_NOT_FOUND", `${root}.mediaType`, "The selected media type must identify exactly one response content entry.", rule.id);
    return undefined;
  }
  const [contentType, content] = mediaTypeEntries[0]!;
  if (!isValidMediaType(rule.mediaType)) {
    addDiagnostic("MOCK_MEDIA_TYPE_INVALID", `${root}.mediaType`, "The selected media type is not a valid header-safe media type.", rule.id);
    valid = false;
  }
  if (soapTransport && (isJsonMediaType(contentType) || rule.source.kind === "schema")) {
    addDiagnostic("MOCK_SOAP_STATIC_TEXT_ONLY", `${root}.source`, "SOAP transport supports only explicitly configured static text responses, not JSON or schema generation.", rule.id);
    valid = false;
  }

  const bodyValue = resolveBodyValue(snapshot, entry.asset.contract, rule, content, contentType, root, addDiagnostic);
  if (!bodyValue.ok) valid = false;
  const headers = compileHeaders(response, `${root}.responseBindingId`, rule.id, addDiagnostic);
  if (!headers) valid = false;

  let body: number[] = [];
  if (bodyValue.ok) {
    const bytes = Buffer.from(bodyValue.text, "utf8");
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      addDiagnostic("MOCK_RESPONSE_TOO_LARGE", `${root}.source`, "A compiled response must not exceed 1 MiB.", rule.id);
      valid = false;
    } else if (status !== undefined && httpMethod !== "HEAD" && status !== 204 && status !== 304) {
      body = Array.from(bytes.values());
    }
  }

  if (!valid || status === undefined || !headers) return undefined;
  return {
    id: rule.id,
    contractId: rule.contractId,
    responseBindingId: rule.responseBindingId,
    conditions: rule.conditions.map((condition) => structuredClone(condition)),
    status,
    mediaType: rule.mediaType,
    headers,
    body,
    delayMs: rule.delayMs,
  };
}

function resolveBodyValue(
  snapshot: ProjectSnapshot,
  contract: DeepReadonly<ApiContract>,
  rule: MockRule,
  content: DeepReadonly<ResponseContent>,
  contentType: string,
  root: string,
  addDiagnostic: (code: string, path: string, message: string, ownerId?: string) => void,
): { ok: true; text: string } | { ok: false } {
  if (isJsonMediaType(contentType)) {
    if (rule.source.kind === "example") {
      const value = findExampleValue(snapshot, content.examples, rule.source.exampleBindingId);
      if (!value.found) {
        addDiagnostic("MOCK_EXAMPLE_NOT_FOUND", `${root}.source.exampleBindingId`, "The selected example is not part of the selected response content.", rule.id);
        return { ok: false };
      }
      return { ok: true, text: JSON.stringify(value.value) };
    }
    if (rule.source.kind === "literal") {
      try {
        const parsed: unknown = JSON.parse(rule.source.text);
        const encoded = JSON.stringify(parsed);
        if (encoded === undefined) throw new TypeError("The JSON literal has no serializable value.");
        return { ok: true, text: encoded };
      } catch {
        addDiagnostic("MOCK_JSON_LITERAL_INVALID", `${root}.source.text`, "A JSON media type requires a valid JSON literal.", rule.id);
        return { ok: false };
      }
    }
    if (!content.schema) {
      addDiagnostic("MOCK_RESPONSE_SCHEMA_MISSING", `${root}.responseBindingId`, "Schema generation requires a schema on the selected response content.", rule.id);
      return { ok: false };
    }
    const generated = generateMockJsonValue(content.schema as unknown as SchemaNode, {
      models: snapshot.project.models as unknown as ModelAsset[],
      seed: snapshot.project.mock?.seed ?? "",
      contractId: contract.id,
      ruleId: rule.id,
      path: `${root}.source`,
    });
    if (!generated.ok) {
      for (const diagnostic of generated.diagnostics) addDiagnostic(diagnostic.code, diagnostic.path, diagnostic.message, diagnostic.ownerId);
      return { ok: false };
    }
    return { ok: true, text: JSON.stringify(generated.value) };
  }

  if (rule.source.kind === "schema") {
    addDiagnostic("MOCK_SCHEMA_MEDIA_TYPE_UNSUPPORTED", `${root}.source`, "Schema generation is available only for JSON media types.", rule.id);
    return { ok: false };
  }
  if (rule.source.kind === "literal") return { ok: true, text: rule.source.text };

  const value = findExampleValue(snapshot, content.examples, rule.source.exampleBindingId);
  if (!value.found) {
    addDiagnostic("MOCK_EXAMPLE_NOT_FOUND", `${root}.source.exampleBindingId`, "The selected example is not part of the selected response content.", rule.id);
    return { ok: false };
  }
  if (typeof value.value !== "string") {
    addDiagnostic("MOCK_TEXT_EXAMPLE_REQUIRED", `${root}.source.exampleBindingId`, "XML and text responses require an explicit string example or literal.", rule.id);
    return { ok: false };
  }
  return { ok: true, text: value.value };
}

function findExampleValue(
  snapshot: ProjectSnapshot,
  examples: readonly DeepReadonly<ExampleBinding>[],
  exampleBindingId: string,
): { found: true; value: JsonValue } | { found: false } {
  const binding = examples.find((example) => example.id === exampleBindingId);
  if (!binding) return { found: false };
  if (binding.kind === "inline") return { found: true, value: binding.value as unknown as JsonValue };
  const component = snapshot.context.getComponent(binding.componentId);
  if (!component || component.kind !== "example") return { found: false };
  return { found: true, value: component.definition.value as unknown as JsonValue };
}

function resolveResponse(binding: DeepReadonly<ResponseBinding>, snapshot: ProjectSnapshot): DeepReadonly<ResponseDefinition> | undefined {
  if (binding.kind === "inline") return binding;
  const component = snapshot.context.getComponent(binding.componentId);
  if (!component || component.kind !== "response") return undefined;
  return component.definition as DeepReadonly<ResponseDefinition>;
}

function compileHeaders(
  response: DeepReadonly<ResponseDefinition>,
  path: string,
  ownerId: string,
  addDiagnostic: (code: string, path: string, message: string, ownerId?: string) => void,
): Record<string, string> | undefined {
  const output: Record<string, string> = {};
  const seen = new Set<string>();
  const connectionTokens = new Set<string>();
  for (const [name, value] of Object.entries(response.headers)) {
    if (name.toLowerCase() === "connection") {
      for (const token of value.split(",")) connectionTokens.add(token.trim().toLowerCase());
    }
  }

  let valid = true;
  for (const [name, value] of Object.entries(response.headers)) {
    const headerPath = `${path}.headers.${name}`;
    if (!HEADER_TOKEN.test(name) || !isNodeHttpHeaderValue(value)) {
      addDiagnostic("MOCK_RESPONSE_HEADER_INVALID", headerPath, "Response header names and values must be safe for HTTP transmission.", ownerId);
      valid = false;
      continue;
    }
    const key = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key) || connectionTokens.has(key)) continue;
    if (seen.has(key)) {
      addDiagnostic("MOCK_RESPONSE_HEADER_DUPLICATE", headerPath, "Response headers must not contain case-insensitive duplicate names.", ownerId);
      valid = false;
      continue;
    }
    seen.add(key);
    Object.defineProperty(output, name, { value, enumerable: true, configurable: true, writable: true });
  }
  return valid ? output : undefined;
}

function validateCondition(condition: MockCondition, pathParameterNames: Set<string>, allowJsonBody: boolean): boolean {
  if (condition.source === "body") return allowJsonBody && validJsonPointer(condition.pointer);
  if (condition.source === "path") return pathParameterNames.has(condition.name) && (!hasValue(condition) || typeof condition.value === "string");
  if (condition.source === "query") return condition.name.length > 0 && (!hasValue(condition) || typeof condition.value === "string");
  return HEADER_TOKEN.test(condition.name) && (!hasValue(condition) || typeof condition.value === "string");
}

function validJsonPointer(pointer: string): boolean {
  if (pointer === "") return true;
  if (!pointer.startsWith("/")) return false;
  return pointer.slice(1).split("/").every((token) => !/~(?![01])/.test(token));
}

function hasValue(condition: MockCondition): condition is Extract<MockCondition, { op: "equals" }> {
  return condition.op === "equals";
}

function concreteStatus(status: string): number | undefined {
  return /^[1-5][0-9]{2}$/.test(status) ? Number(status) : undefined;
}

function isJsonMediaType(mediaType: string): boolean {
  const essence = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  return essence === "application/json" || essence.endsWith("+json");
}

function isValidMediaType(mediaType: string): boolean {
  if (!isNodeHttpHeaderValue(mediaType)) return false;
  const [essence, ...parameters] = mediaType.split(";");
  if (!essence || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(essence.trim())) return false;
  return parameters.every((parameter) => parameter.trim().length > 0);
}

function isNodeHttpHeaderValue(value: string): boolean {
  return /^[\t\x20-\x7e\x80-\xff]*$/.test(value);
}

function compilePath(path: string): CompiledPath | undefined {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) return undefined;
  const rawSegments = path.split("/");
  const segments: CompiledPathSegment[] = [];
  const parameterNames = new Set<string>();
  const canonical: string[] = [];
  for (const segment of rawSegments) {
    if (segment.startsWith("{") || segment.endsWith("}")) {
      const match = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment);
      if (!match || parameterNames.has(match[1]!)) return undefined;
      parameterNames.add(match[1]!);
      segments.push({ kind: "parameter", name: match[1]! });
      canonical.push("{}");
    } else {
      if (segment.includes("{") || segment.includes("}")) return undefined;
      segments.push({ kind: "literal", value: segment });
      canonical.push(segment);
    }
  }
  return { segments, canonical: canonical.join("/"), parameterNames };
}

function validateDefaultOrdering(
  contractRules: Array<{ rule: MockRule; index: number }>,
  contractId: string,
  addDiagnostic: (code: string, path: string, message: string, ownerId?: string) => void,
): void {
  contractRules.forEach(({ rule, index }, position) => {
    if (rule.conditions.length === 0 && position !== contractRules.length - 1) {
      addDiagnostic("MOCK_DEFAULT_RULE_NOT_LAST", `mock.rules[${index}].conditions`, "An explicit default rule must be the last enabled rule for its contract.", rule.id || contractId);
    }
  });
}

function detectRouteAmbiguities(
  routes: CompiledMockRoute[],
  apiById: Map<string, ApiEntry>,
  addDiagnostic: (code: string, path: string, message: string, ownerId?: string) => void,
): void {
  const seen = new Map<string, CompiledMockRoute>();
  for (const route of routes) {
    const path = compilePath(route.pathTemplate);
    if (!path) continue;
    const key = JSON.stringify([route.method, path.canonical]);
    const previous = seen.get(key);
    if (previous) {
      const previousPath = apiById.get(previous.contractId)?.path ?? "mock.routes";
      const currentPath = apiById.get(route.contractId)?.path ?? "mock.routes";
      addDiagnostic("MOCK_ROUTE_AMBIGUOUS", currentPath + ".contract.request.path", "Two enabled contracts compile to the same HTTP method and canonical path template.", route.contractId);
      addDiagnostic("MOCK_ROUTE_AMBIGUOUS", previousPath + ".contract.request.path", "Two enabled contracts compile to the same HTTP method and canonical path template.", previous.contractId);
    } else seen.set(key, route);
  }
}

function compareRoutes(left: CompiledMockRoute, right: CompiledMockRoute): number {
  const methodOrder = compareText(left.method, right.method);
  if (methodOrder !== 0) return methodOrder;
  const count = Math.min(left.segments.length, right.segments.length);
  for (let index = 0; index < count; index += 1) {
    const leftSegment = left.segments[index]!;
    const rightSegment = right.segments[index]!;
    if (leftSegment.kind !== rightSegment.kind) return leftSegment.kind === "literal" ? -1 : 1;
    if (leftSegment.kind === "literal" && rightSegment.kind === "literal") {
      const textOrder = compareText(leftSegment.value, rightSegment.value);
      if (textOrder !== 0) return textOrder;
    }
  }
  if (left.segments.length !== right.segments.length) return left.segments.length - right.segments.length;
  return compareText(left.contractId, right.contractId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectApis(snapshot: ProjectSnapshot): ApiEntry[] {
  const entries: ApiEntry[] = [];
  snapshot.project.collections.forEach((collection, collectionIndex) => {
    const root = `collections[${collectionIndex}]`;
    collection.apis.forEach((asset, apiIndex) => entries.push({ asset, path: `${root}.apis[${apiIndex}]` }));
    collection.folders.forEach((folder, folderIndex) => collectFolder(folder, `${root}.folders[${folderIndex}]`, entries));
  });
  return entries;
}

function collectFolder(folder: DeepReadonly<ContractFolder>, path: string, entries: ApiEntry[]): void {
  folder.apis.forEach((asset, apiIndex) => entries.push({ asset, path: `${path}.apis[${apiIndex}]` }));
  folder.folders.forEach((child, childIndex) => collectFolder(child, `${path}.folders[${childIndex}]`, entries));
}

function failure(diagnostics: MockDiagnostic[]): CompileProjectMockResult {
  return { ok: false, diagnostics: deepFreeze(diagnostics) };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}
