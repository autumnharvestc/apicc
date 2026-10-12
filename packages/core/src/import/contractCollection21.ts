import { randomUUID } from "node:crypto";

import type {
  ApiAsset,
  ApiRequest,
  AuthBinding,
  HttpMethod,
  InlineParameter,
  MultipartEntry,
  RequestBody,
  ResponseContent,
  ResponseBinding,
  SecretRef,
} from "../contract/model.js";
import { ContractProjectSchema, type ContractCollection, type ContractFolder, type ContractProject } from "../contract/workspace.js";
import type { JsonValue } from "../contract/schemaNode.js";
import { sanitizeNodeName } from "../storage/sanitize.js";
import { isCredentialFieldName, redactCommonCredentialText, stripCredentialValues } from "./schemaMapping.js";
import type { ContractImportDiagnostic, ContractImportResult } from "./contractOpenapi.js";

const EMPTY_GLOBALS = { query: [], headers: [], cookies: [], body: [] };

/** Import a parsed collection v2.1 object without evaluating its scripts or following file paths. */
export function parseContractCollection21(input: unknown): ContractImportResult {
  const root = asRecord(input);
  if (!root) throw new TypeError("A collection v2.1 document object is required.");
  const diagnostics: ContractImportDiagnostic[] = [];
  const info = asRecord(root.info) ?? {};
  const name = sanitizeNodeName(stringOr(info.name, "Imported collection"));
  const collectionId = randomUUID();
  const collection: ContractCollection = {
    id: collectionId,
    name,
    variables: importVariables(root.variable, collectionId, "variable", diagnostics),
    preOperations: [],
    postOperations: [],
    folders: [],
    apis: [],
  };
  diagnoseUnsupportedFields(info, new Set(["name", "schema"]), collection.id, "info", "COLLECTION_INFO_FIELD_UNSUPPORTED", diagnostics);
  if (info.description !== undefined) addDiagnostic(diagnostics, "COLLECTION_INFO_DESCRIPTION_UNREPRESENTED", collection.id, "info/description", "Collection-level description is not represented by ContractProject.");
  reportEvents(root.event, collection.id, "event", diagnostics);
  const inheritedAuth = root.auth;
  walkItems(asArray(root.item), collection, inheritedAuth, "item", diagnostics);

  for (const [key, value] of Object.entries(root)) {
    if (["info", "item", "auth", "event", "variable"].includes(key)) continue;
    addDiagnostic(diagnostics, "COLLECTION_ROOT_FIELD_UNSUPPORTED", collection.id, key, "This collection v2.1 field is not represented by the contract model.");
  }

  const project = ContractProjectSchema.parse({
    id: randomUUID(),
    name,
    variables: {},
    globals: EMPTY_GLOBALS,
    environments: [],
    collections: [collection],
    workflows: [],
    stressPolicy: { trustedOrigins: [], deniedOrigins: [] },
    models: [],
    components: [],
  });
  return { project, diagnostics: deduplicateDiagnostics(diagnostics) };
}

function walkItems(
  items: unknown[],
  parent: ContractCollection | ContractFolder,
  inheritedAuth: unknown,
  sourcePath: string,
  diagnostics: ContractImportDiagnostic[],
): void {
  items.forEach((itemValue, index) => {
    const item = asRecord(itemValue);
    if (!item) {
      addDiagnostic(diagnostics, "COLLECTION_ITEM_UNSUPPORTED", parent.id, `${sourcePath}[${index}]`, "The collection item is not an object and was omitted.");
      return;
    }
    const itemPath = `${sourcePath}[${index}]`;
    const displayName = sanitizeNodeName(stringOr(item.name, "Unnamed item"));
    const localAuth = resolveInheritedAuth(item.auth, inheritedAuth);
    const children = asArray(item.item);
    if (Array.isArray(item.item)) {
      const folder: ContractFolder = {
        id: randomUUID(),
        name: displayName,
        preOperations: [],
        postOperations: [],
        folders: [],
        apis: [],
      };
      parent.folders.push(folder);
      reportEvents(item.event, folder.id, `${itemPath}.event`, diagnostics);
      if (item.variable !== undefined) {
        reportUnrepresentedVariables(item.variable, folder.id, `${itemPath}.variable`, diagnostics);
      }
      walkItems(children, folder, localAuth, `${itemPath}.item`, diagnostics);
      diagnoseUnsupportedFields(item, new Set(["name", "item", "event", "variable", "auth", "description", "request", "response"]), folder.id, itemPath, "COLLECTION_FOLDER_FIELD_UNSUPPORTED", diagnostics);
    }
    if (item.request !== undefined) {
      const api = importApi(item, localAuth, itemPath, diagnostics);
      parent.apis.push(api);
      if (item.variable !== undefined) reportUnrepresentedVariables(item.variable, api.contract.id, `${itemPath}.variable`, diagnostics);
      diagnoseUnsupportedFields(item, new Set(["name", "item", "request", "response", "event", "variable", "auth", "description"]), api.contract.id, itemPath, "COLLECTION_ITEM_FIELD_UNSUPPORTED", diagnostics);
    } else if (!Array.isArray(item.item)) {
      reportEvents(item.event, parent.id, `${itemPath}.event`, diagnostics);
      for (const [key, value] of Object.entries(item)) {
        if (["name", "event", "variable", "auth", "description"].includes(key)) continue;
        addDiagnostic(diagnostics, "COLLECTION_ITEM_FIELD_UNSUPPORTED", parent.id, `${itemPath}.${key}`, "The item field is not represented by the contract model.");
      }
    }
  });
}

function importApi(
  item: Record<string, unknown>,
  inheritedAuth: unknown,
  sourcePath: string,
  diagnostics: ContractImportDiagnostic[],
): ApiAsset {
  const requestSource = asRecord(item.request) ?? {};
  const contractId = randomUUID();
  diagnoseUnsupportedFields(requestSource, new Set(["method", "url", "auth", "header", "headers", "body", "description"]), contractId, `${sourcePath}.request`, "COLLECTION_REQUEST_FIELD_UNSUPPORTED", diagnostics);
  reportEvents(item.event, contractId, `${sourcePath}.event`, diagnostics);
  const url = parseRequestUrl(requestSource.url, contractId, `${sourcePath}.request.url`, diagnostics);
  const importedHeaders = importHeaders(requestSource.header ?? requestSource.headers, contractId, `${sourcePath}.request.header`, diagnostics);
  const importedQuery = importQuery(url.query, contractId, `${sourcePath}.request.url.query`, diagnostics);
  const headers = importedHeaders.values;
  const query = importedQuery.values;
  const sourceAuth = resolveInheritedAuth(requestSource.auth, inheritedAuth);
  const explicitAuth = parseCollectionAuth(sourceAuth, contractId, `${sourcePath}.auth`, diagnostics);
  const selectedAuth = explicitAuth ?? importedHeaders.auth ?? importedQuery.auth;
  const auth = url.userInfo
    ? selectedAuth ?? { kind: "basic" as const, username: url.userInfo.usernameTemplate ?? "", password: newSecretRef() }
    : selectedAuth ?? { kind: "none" as const };
  if (url.userInfo && selectedAuth) {
    addDiagnostic(diagnostics, "AUTH_BINDING_CONFLICT", contractId, `${sourcePath}.request.url.userinfo`, "URL userinfo was omitted because another authentication binding is selected; choose the intended binding in the editor.");
  }
  const body = importRequestBody(requestSource.body, contractId, `${sourcePath}.request.body`, diagnostics);
  const method = parseMethod(requestSource.method, contractId, `${sourcePath}.request.method`, diagnostics);
  const documentation = buildDocumentation(item, requestSource, body.fileDescriptions);
  const responses = importResponses(item.response, contractId, `${sourcePath}.response`, diagnostics);

  const request: ApiRequest = {
    protocol: "http",
    method,
    baseUrl: url.baseUrl,
    path: url.path,
    pathParams: [],
    query,
    headers,
    cookies: [],
    auth,
    body: body.value,
  };
  const contract = {
    formatVersion: 1 as const,
    id: contractId,
    metadata: {
      name: sanitizeNodeName(stringOr(item.name, `${method} ${url.path}`)),
      description: descriptionOf(requestSource.description ?? item.description),
      tags: [],
      version: "1.0.0",
      status: "draft" as const,
    },
    request,
    responses,
  };
  return { contract, cases: [], documentation };
}

interface ParsedUrl {
  baseUrl: string;
  path: string;
  query: Array<{ key: string; value: string; enabled: boolean; description: string }>;
  userInfo?: { usernameTemplate?: string };
}

function parseRequestUrl(value: unknown, ownerId: string, sourcePath: string, diagnostics: ContractImportDiagnostic[]): ParsedUrl {
  const urlObject = asRecord(value);
  if (urlObject) diagnoseUnsupportedFields(urlObject, new Set(["raw", "query", "protocol", "host", "path", "hash", "variable", "port"]), ownerId, sourcePath, "COLLECTION_URL_FIELD_UNSUPPORTED", diagnostics);
  if (asArray(urlObject?.variable).length > 0) addDiagnostic(diagnostics, "COLLECTION_URL_VARIABLES_UNREPRESENTED", ownerId, `${sourcePath}.variable`, "URL-local variables are not represented by the contract request model.");
  let raw = typeof value === "string" ? value : stringOr(urlObject?.raw, "");
  if (!raw && urlObject) {
    const protocol = stringOr(urlObject.protocol, "https");
    const host = Array.isArray(urlObject.host) ? urlObject.host.filter((part) => typeof part === "string").join(".") : stringOr(urlObject.host, "");
    const portValue = urlObject.port;
    const port = typeof portValue === "number" && Number.isInteger(portValue) ? String(portValue) : stringOr(portValue, "");
    const validPort = port === "" || (/^\d{1,5}$/.test(port) && Number(port) <= 65535);
    if (port !== "" && !validPort) addDiagnostic(diagnostics, "COLLECTION_URL_PORT_INVALID", ownerId, `${sourcePath}.port`, "The structured URL port is invalid and was omitted.");
    const authority = host && port !== "" && validPort ? `${host}:${port}` : host;
    const path = Array.isArray(urlObject.path) ? urlObject.path.filter((part) => typeof part === "string").join("/") : stringOr(urlObject.path, "");
    raw = authority ? `${protocol}://${authority}${path ? `/${path.replace(/^\//, "")}` : ""}` : path;
  }
  const fragmentIndex = raw.indexOf("#");
  if (fragmentIndex >= 0) {
    addDiagnostic(diagnostics, "URL_FRAGMENT_OMITTED", ownerId, sourcePath, "URL fragments are not sent in HTTP requests and were omitted.");
    raw = raw.slice(0, fragmentIndex);
  }
  if (urlObject?.hash !== undefined && fragmentIndex < 0 && stringOr(urlObject.hash, "") !== "") {
    addDiagnostic(diagnostics, "URL_FRAGMENT_OMITTED", ownerId, sourcePath, "The structured URL fragment is not sent in HTTP requests and was omitted.");
  }
  const queryIndex = raw.indexOf("?");
  const rawQuery = queryIndex >= 0 ? raw.slice(queryIndex + 1) : "";
  const withoutQuery = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const structuredQuery = Array.isArray(urlObject?.query) ? urlObject.query : undefined;
  const query = structuredQuery
    ? structuredQuery.map((entry, index) => {
      const record = asRecord(entry) ?? {};
      diagnoseUnsupportedFields(record, new Set(["key", "value", "disabled", "description"]), ownerId, `${sourcePath}/query/${index}`, "COLLECTION_QUERY_FIELD_UNSUPPORTED", diagnostics);
      return { key: stringOr(record.key, ""), value: stringOr(record.value, ""), enabled: record.disabled !== true, description: descriptionOf(record.description), index };
    }).map(({ index: _index, ...item }) => item)
    : parseRawQuery(rawQuery);

  const urlMatch = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(withoutQuery);
  if (urlMatch) {
    const authority = urlMatch[2];
    const userInfoDelimiter = authority.lastIndexOf("@");
    let baseAuthority = authority;
    let userInfo: ParsedUrl["userInfo"];
    if (userInfoDelimiter >= 0) {
      const rawUserInfo = authority.slice(0, userInfoDelimiter);
      baseAuthority = authority.slice(userInfoDelimiter + 1);
      const colon = rawUserInfo.indexOf(":");
      const rawUsername = colon < 0 ? rawUserInfo : rawUserInfo.slice(0, colon);
      const rawPassword = colon < 0 ? "" : rawUserInfo.slice(colon + 1);
      const usernameTemplate = /^\{\{[^{}]+\}\}$/.test(rawUsername) ? rawUsername : undefined;
      const passwordTemplate = /^\{\{[^{}]+\}\}$/.test(rawPassword) ? rawPassword : undefined;
      const hasUsernameValue = rawUsername !== "" && usernameTemplate === undefined;
      const hasPasswordValue = rawPassword !== "" && passwordTemplate === undefined;
      if (hasUsernameValue) addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}.userinfo.username`, "URL userinfo value was removed; re-enter it through the credential editor if needed.");
      if (hasPasswordValue) addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}.userinfo.password`, "URL userinfo value was removed; re-enter it through the credential editor if needed.");
      if (passwordTemplate) addDiagnostic(diagnostics, "URL_USERINFO_TEMPLATE_UNREPRESENTED", ownerId, `${sourcePath}.userinfo.password`, "A password template in URL userinfo cannot be bound automatically and was not retained.");
      if (usernameTemplate || hasUsernameValue || hasPasswordValue || passwordTemplate) {
        userInfo = usernameTemplate ? { usernameTemplate } : {};
      }
    }
    return { baseUrl: `${urlMatch[1]}${baseAuthority}`, path: urlMatch[3] || "/", query, userInfo };
  }
  const templateMatch = /^(\{\{[^}]+\}\})(.*)$/.exec(withoutQuery);
  if (templateMatch) return { baseUrl: templateMatch[1], path: templateMatch[2] || "/", query };
  return { baseUrl: "", path: withoutQuery || "/", query };
}

function parseRawQuery(value: string): Array<{ key: string; value: string; enabled: boolean; description: string }> {
  if (!value) return [];
  return value.split("&").map((part) => {
    const delimiter = part.indexOf("=");
    const key = delimiter < 0 ? part : part.slice(0, delimiter);
    const itemValue = delimiter < 0 ? "" : part.slice(delimiter + 1);
    return { key: decodeQueryValue(key), value: decodeQueryValue(itemValue), enabled: true, description: "" };
  });
}

function decodeQueryValue(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

interface ImportedParameters {
  values: InlineParameter[];
  auth?: AuthBinding;
}

function importQuery(
  parsed: ParsedUrl["query"],
  ownerId: string,
  sourcePath: string,
  diagnostics: ContractImportDiagnostic[],
): ImportedParameters {
  let auth: AuthBinding | undefined;
  const values = parsed.map((item, index): InlineParameter => {
    const secret = isCredentialFieldName(item.key);
    if (secret && item.value !== "") {
      addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}[${index}].${item.key}`, "A common credential query value was removed; fill it again in the local credential entry (****).");
      if (!auth) auth = { kind: "apikey", name: item.key, placement: "query", value: newSecretRef() };
    }
    return {
      kind: "inline",
      id: randomUUID(),
      name: item.key,
      schema: { kind: "scalar", type: "string" },
      required: false,
      enabled: item.enabled,
      description: item.description,
      value: secret ? "" : item.value,
    };
  });
  return { values, ...(auth ? { auth } : {}) };
}

function importHeaders(value: unknown, ownerId: string, sourcePath: string, diagnostics: ContractImportDiagnostic[]): ImportedParameters {
  const output: InlineParameter[] = [];
  let auth: AuthBinding | undefined;
  asArray(value).forEach((headerValue, index) => {
    const header = asRecord(headerValue);
    if (!header || typeof header.key !== "string") return;
    diagnoseUnsupportedFields(header, new Set(["key", "value", "disabled", "description", "type"]), ownerId, `${sourcePath}[${index}]`, "COLLECTION_HEADER_FIELD_UNSUPPORTED", diagnostics);
    const secret = isCredentialFieldName(header.key);
    if (secret && typeof header.value === "string" && header.value !== "") {
      addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}[${index}].${header.key}`, "A common credential header value was removed; fill it again in the local credential entry (****).");
      if (!auth && header.key.toLowerCase() === "authorization") {
        const scheme = /^\s*(bearer|basic)\b/i.exec(header.value)?.[1]?.toLowerCase();
        auth = scheme === "basic"
          ? { kind: "basic", username: "", password: newSecretRef() }
          : { kind: "bearer", token: newSecretRef() };
      } else if (!auth) {
        auth = { kind: "apikey", name: header.key, placement: "header", value: newSecretRef() };
      }
    }
    output.push({
      kind: "inline",
      id: randomUUID(),
      name: header.key,
      schema: { kind: "scalar", type: "string" },
      required: false,
      enabled: header.disabled !== true,
      description: descriptionOf(header.description),
      value: secret ? "" : stringOr(header.value, ""),
    });
  });
  return { values: output, ...(auth ? { auth } : {}) };
}

interface ImportedBody {
  value: RequestBody;
  fileDescriptions: Array<{ name: string; description: string }>;
}

function importRequestBody(value: unknown, ownerId: string, sourcePath: string, diagnostics: ContractImportDiagnostic[]): ImportedBody {
  const body = asRecord(value);
  if (!body) return { value: { kind: "none" }, fileDescriptions: [] };
  const mode = stringOr(body.mode, "");
  if (mode === "raw") {
    diagnoseUnsupportedFields(body, new Set(["mode", "raw", "options"]), ownerId, sourcePath, "COLLECTION_BODY_FIELD_UNSUPPORTED", diagnostics);
    const raw = stringOr(body.raw, "");
    const options = asRecord(body.options);
    const rawOptions = asRecord(options?.raw);
    const language = stringOr(rawOptions?.language, "").toLowerCase();
    if (language === "json" || looksLikeJson(raw)) {
      try {
        const parsed = jsonValue(JSON.parse(raw));
        if (parsed !== undefined) {
          const stripped = stripCredentialValues(parsed);
          for (const path of stripped.removedPaths) addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}.raw.${path}`, "A common credential body value was removed; fill it again in the local credential entry (****).");
          return { value: { kind: "json", content: JSON.stringify(stripped.value) }, fileDescriptions: [] };
        }
      } catch {
        // Keep the plain body below; no source text is copied into diagnostics.
      }
      if (language === "json" || looksLikeJson(raw)) {
        addDiagnostic(diagnostics, "BODY_CREDENTIAL_SCAN_LIMITED", ownerId, `${sourcePath}.raw`, "The JSON body could not be parsed, so common credential fields could not be inspected.");
        return { value: { kind: "json", content: "" }, fileDescriptions: [] };
      }
    }
    const redactedText = redactCommonCredentialText(raw);
    if (redactedText !== raw) addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}.raw`, "An explicit common authentication text value was masked.");
    if (language === "graphql") return { value: { kind: "graphql", query: redactedText }, fileDescriptions: [] };
    if (language === "xml") return { value: { kind: "xml", content: redactedText }, fileDescriptions: [] };
    return { value: { kind: "text", content: redactedText }, fileDescriptions: [] };
  }
  if (mode === "urlencoded") {
    diagnoseUnsupportedFields(body, new Set(["mode", "urlencoded"]), ownerId, sourcePath, "COLLECTION_BODY_FIELD_UNSUPPORTED", diagnostics);
    const fields = asArray(body.urlencoded).flatMap((fieldValue) => {
      const field = asRecord(fieldValue);
      if (!field || typeof field.key !== "string") return [];
      diagnoseUnsupportedFields(field, new Set(["key", "value", "disabled", "type", "description"]), ownerId, `${sourcePath}.urlencoded.${field.key}`, "COLLECTION_FORM_FIELD_UNSUPPORTED", diagnostics);
      const sensitive = isCredentialFieldName(field.key);
      if (sensitive && stringOr(field.value, "") !== "") addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}.urlencoded.${field.key}`, "A common credential form value was removed; fill it again in the local credential entry (****).");
      return [{ id: randomUUID(), name: field.key, value: sensitive ? "" : stringOr(field.value, ""), enabled: field.disabled !== true }];
    });
    return { value: { kind: "urlencoded", fields }, fileDescriptions: [] };
  }
  if (mode === "formdata") {
    diagnoseUnsupportedFields(body, new Set(["mode", "formdata"]), ownerId, sourcePath, "COLLECTION_BODY_FIELD_UNSUPPORTED", diagnostics);
    const fileDescriptions: Array<{ name: string; description: string }> = [];
    const entries: MultipartEntry[] = [];
    asArray(body.formdata).forEach((fieldValue) => {
      const field = asRecord(fieldValue);
      if (!field || typeof field.key !== "string") return;
      diagnoseUnsupportedFields(field, new Set(["key", "type", "src", "value", "disabled", "description", "contentType"]), ownerId, `${sourcePath}.formdata.${field.key}`, "COLLECTION_FORM_FIELD_UNSUPPORTED", diagnostics);
      const description = descriptionOf(field.description);
      if (field.type === "file") {
        fileDescriptions.push({ name: field.key, description });
        addDiagnostic(diagnostics, "REQUEST_FILE_NOT_BOUND", ownerId, `${sourcePath}.formdata.${field.key}`, "The source file path was not bound; choose the file again locally.");
        entries.push({ kind: "file", id: randomUUID(), name: field.key, file: { path: "" }, enabled: field.disabled !== true });
        return;
      }
      const sensitive = isCredentialFieldName(field.key);
      if (sensitive && stringOr(field.value, "") !== "") addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}.formdata.${field.key}`, "A common credential form value was removed; fill it again in the local credential entry (****).");
      entries.push({ kind: "text", id: randomUUID(), name: field.key, value: sensitive ? "" : stringOr(field.value, ""), enabled: field.disabled !== true });
    });
    return { value: { kind: "multipart", entries }, fileDescriptions };
  }
  if (mode === "graphql") {
    diagnoseUnsupportedFields(body, new Set(["mode", "graphql"]), ownerId, sourcePath, "COLLECTION_BODY_FIELD_UNSUPPORTED", diagnostics);
    const graphql = asRecord(body.graphql) ?? {};
    const rawVariables = stringOr(graphql.variables, "");
    const variables = sanitizeJsonText(rawVariables, ownerId, `${sourcePath}.graphql.variables`, diagnostics);
    return {
      value: { kind: "graphql", query: stringOr(graphql.query, ""), ...(rawVariables ? { variables } : {}), ...(typeof graphql.operationName === "string" ? { operationName: graphql.operationName } : {}) },
      fileDescriptions: [],
    };
  }
  if (mode) addDiagnostic(diagnostics, "REQUEST_BODY_MODE_UNSUPPORTED", ownerId, `${sourcePath}.mode`, "The collection body mode is not represented by the request model.");
  return { value: { kind: "none" }, fileDescriptions: [] };
}

function importResponses(value: unknown, ownerId: string, sourcePath: string, diagnostics: ContractImportDiagnostic[]): ResponseBinding[] {
  return asArray(value).flatMap((responseValue, index) => {
    const response = asRecord(responseValue);
    if (!response) return [];
    diagnoseUnsupportedFields(response, new Set(["name", "status", "code", "header", "cookie", "body"]), ownerId, `${sourcePath}[${index}]`, "COLLECTION_RESPONSE_FIELD_UNSUPPORTED", diagnostics);
    const code = typeof response.code === "number" && response.code >= 100 && response.code <= 599 ? String(response.code) : "default";
    const contentType = headerValue(response.header, "content-type") ?? "application/json";
    const body = response.body;
    const json = typeof body === "string" ? tryJsonValue(body) : undefined;
    let exampleValue: JsonValue | undefined = json ?? (typeof body === "string" ? body : undefined);
    if (exampleValue !== undefined) {
      const stripped = stripCredentialValues(exampleValue);
      for (const path of stripped.removedPaths) addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}[${index}].body.${path}`, "A common credential response example value was removed.");
      exampleValue = stripped.value;
    }
    const content: Record<string, ResponseContent> = {};
    if (exampleValue !== undefined) {
      Object.defineProperty(content, contentType, {
        value: { examples: [{ kind: "inline", id: randomUUID(), name: sanitizeNodeName(stringOr(response.name, "example")), value: exampleValue }] },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    const headers: Record<string, string> = {};
    for (const header of asArray(response.header)) {
      const entry = asRecord(header);
      if (typeof entry?.key !== "string") continue;
      const sensitive = isCredentialFieldName(entry.key);
      if (sensitive && stringOr(entry.value, "") !== "") addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}[${index}].header.${entry.key}`, "A common credential response header value was removed.");
      headers[entry.key] = sensitive ? "" : stringOr(entry.value, "");
    }
    if (response.cookie !== undefined) addDiagnostic(diagnostics, "RESPONSE_COOKIES_UNREPRESENTED", ownerId, `${sourcePath}[${index}].cookie`, "Response cookies are not represented by the contract response model.");
    const description = stringOr(response.status, stringOr(response.name, ""));
    return [{
      kind: "inline" as const,
      id: randomUUID(),
      status: code,
      description,
      headers,
      content,
    }];
  });
}

function parseCollectionAuth(value: unknown, ownerId: string, sourcePath: string, diagnostics: ContractImportDiagnostic[]): AuthBinding | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const type = stringOr(source.type, "").toLowerCase();
  diagnoseUnsupportedFields(source, new Set(["type", type]), ownerId, sourcePath, "AUTH_FIELD_UNSUPPORTED", diagnostics);
  if (!type || type === "noauth" || type === "inherit") return type === "noauth" ? { kind: "none" } : undefined;
  const entries = asArray(source[type]);
  const fields = new Map<string, unknown>();
  entries.forEach((entry) => {
    const item = asRecord(entry);
    if (typeof item?.key === "string") fields.set(item.key.toLowerCase(), item.value);
    if (item) diagnoseUnsupportedFields(item, new Set(["key", "value", "type", "disabled"]), ownerId, `${sourcePath}.${type}`, "AUTH_FIELD_UNSUPPORTED", diagnostics);
  });
  if (type === "bearer") {
    if (typeof fields.get("token") === "string" && fields.get("token") !== "") {
      addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}.bearer.token`, "The bearer value was removed; fill the new unbound credential locally (****).");
    }
    return { kind: "bearer", token: newSecretRef() };
  }
  if (type === "basic") {
    const username = stringOr(fields.get("username"), "");
    if (typeof fields.get("password") === "string" && fields.get("password") !== "") {
      addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}.basic.password`, "The basic-auth password was removed; fill the new unbound credential locally (****).");
    }
    return { kind: "basic", username, password: newSecretRef() };
  }
  if (type === "apikey") {
    const name = stringOr(fields.get("key"), "apiKey");
    const placement = stringOr(fields.get("in"), "header").toLowerCase() === "query" ? "query" : "header";
    if (typeof fields.get("value") === "string" && fields.get("value") !== "") {
      addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}.apikey.value`, "The API-key value was removed; fill the new unbound credential locally (****).");
    }
    return { kind: "apikey", name, placement, value: newSecretRef() };
  }
  addDiagnostic(diagnostics, "AUTH_SCHEME_UNSUPPORTED", ownerId, sourcePath, "This collection auth scheme is not represented by the contract model.");
  return { kind: "none" };
}

function resolveInheritedAuth(value: unknown, inheritedAuth: unknown): unknown {
  if (value === undefined) return inheritedAuth;
  const source = asRecord(value);
  return stringOr(source?.type, "").toLowerCase() === "inherit" ? inheritedAuth : value;
}

function reportEvents(value: unknown, ownerId: string, sourcePath: string, diagnostics: ContractImportDiagnostic[]): void {
  asArray(value).forEach((_event, index) => {
    addDiagnostic(diagnostics, "SCRIPT_EVENT_NOT_IMPORTED", ownerId, `${sourcePath}[${index}]`, "Collection scripts are not imported or executed; add an operation manually if required.");
  });
}

function importVariables(value: unknown, ownerId: string, sourcePath: string, diagnostics: ContractImportDiagnostic[]): Record<string, string> {
  const output: Record<string, string> = {};
  asArray(value).forEach((variableValue, index) => {
    const variable = asRecord(variableValue);
    if (typeof variable?.key !== "string") return;
    const sensitive = isCredentialFieldName(variable.key);
    if (sensitive && stringOr(variable.value, "") !== "") addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}[${index}].${variable.key}`, "A common credential variable value was removed; fill it again in the local credential entry (****).");
    Object.defineProperty(output, variable.key, { value: sensitive ? "" : stringOr(variable.value, ""), enumerable: true, configurable: true, writable: true });
  });
  return output;
}

function buildDocumentation(item: Record<string, unknown>, request: Record<string, unknown>, fileDescriptions: Array<{ name: string; description: string }>): string {
  const sections = [descriptionOf(request.description ?? item.description)].filter(Boolean);
  if (fileDescriptions.length > 0) {
    sections.push(`## File fields\n\n${fileDescriptions.map((file) => `- ${file.name}: ${file.description || "No file description."}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

function descriptionOf(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return typeof record?.content === "string" ? record.content : "";
}

function sanitizeJsonText(value: string, ownerId: string, sourcePath: string, diagnostics: ContractImportDiagnostic[]): string {
  if (!value) return value;
  try {
    const parsed = jsonValue(JSON.parse(value));
    if (parsed === undefined) return "";
    const stripped = stripCredentialValues(parsed);
    for (const path of stripped.removedPaths) addDiagnostic(diagnostics, "AUTH_VALUE_REMOVED", ownerId, `${sourcePath}.${path}`, "A common credential value was removed from the JSON field.");
    return JSON.stringify(stripped.value);
  } catch {
    addDiagnostic(diagnostics, "BODY_CREDENTIAL_SCAN_LIMITED", ownerId, sourcePath, "The structured JSON field could not be parsed, so it was omitted rather than previewing unsanitized text.");
    return "";
  }
}

function headerValue(value: unknown, name: string): string | undefined {
  for (const headerValue of asArray(value)) {
    const header = asRecord(headerValue);
    if (typeof header?.key === "string" && header.key.toLowerCase() === name) return stringOr(header.value, "");
  }
  return undefined;
}

function parseMethod(value: unknown, ownerId: string, sourcePath: string, diagnostics: ContractImportDiagnostic[]): HttpMethod {
  const method = stringOr(value, "GET").toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) return method as HttpMethod;
  addDiagnostic(diagnostics, "HTTP_METHOD_UNSUPPORTED", ownerId, sourcePath, "The source HTTP method is not represented by the contract model; GET was used.");
  return "GET";
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function tryJsonValue(value: string): JsonValue | undefined {
  try {
    return jsonValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function jsonValue(value: unknown, ancestors = new Set<object>()): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object" || ancestors.has(value)) return undefined;
  ancestors.add(value);
  let result: JsonValue | undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => jsonValue(item, ancestors));
    result = items.some((item) => item === undefined) ? undefined : items as JsonValue[];
  } else {
    const fields: Record<string, JsonValue> = {};
    let valid = true;
    for (const [key, item] of Object.entries(value)) {
      const converted = jsonValue(item, ancestors);
      if (converted === undefined) {
        valid = false;
        break;
      }
      Object.defineProperty(fields, key, { value: converted, enumerable: true, configurable: true, writable: true });
    }
    if (valid) result = fields;
  }
  ancestors.delete(value);
  return result;
}

function newSecretRef(): SecretRef {
  return { id: randomUUID(), policy: "test-auto" };
}

function reportUnrepresentedVariables(value: unknown, ownerId: string, sourcePath: string, diagnostics: ContractImportDiagnostic[]): void {
  asArray(value).forEach((variableValue, index) => {
    const variable = asRecord(variableValue);
    if (typeof variable?.key === "string") addDiagnostic(diagnostics, "FOLDER_VARIABLES_UNREPRESENTED", ownerId, `${sourcePath}[${index}].${variable.key}`, "Folder-scoped variables are not represented by the contract folder model.");
  });
}

function addDiagnostic(diagnostics: ContractImportDiagnostic[], code: string, ownerId: string, path: string, reason: string): void {
  diagnostics.push({ code, ownerId, path, reason });
}

function deduplicateDiagnostics(diagnostics: ContractImportDiagnostic[]): ContractImportDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.code, diagnostic.ownerId, diagnostic.path]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function diagnoseUnsupportedFields(
  source: Record<string, unknown> | undefined,
  supported: ReadonlySet<string>,
  ownerId: string,
  sourcePath: string,
  code: string,
  diagnostics: ContractImportDiagnostic[],
): void {
  if (!source) return;
  for (const field of Object.keys(source)) {
    if (!supported.has(field)) addDiagnostic(diagnostics, code, ownerId, `${sourcePath}/${field}`, "The field is not represented by the target contract model.");
  }
}
