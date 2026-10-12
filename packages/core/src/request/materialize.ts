import type { DeepReadonly, ProjectAssetContextReadView } from "../assets/context.js";
import type { ApiContract, ApiRequest, AuthBinding, HttpMethod, InlineAuthBinding, SecretRef } from "../contract/model.js";
import type { CredentialBindings } from "../credentials/types.js";
import type { KeyValuePair, ProjectGlobals } from "../domain/model.js";
import { materializeBody, type RuntimeBody } from "./body.js";
import { materializeParameters, RequestMaterializationError, type MaterializedParameter } from "./parameters.js";

export interface MaterializeInputs {
  resolve(template: string): string;
  envBaseUrl?: string;
  globals: Partial<ProjectGlobals>;
  credentials: CredentialBindings;
}

export type RuntimeAuth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "apikey"; name: string; placement: "header" | "query"; value: string };

interface MaterializedCommon {
  url: string;
  headers: Record<string, string>;
  query: KeyValuePair[];
  auth: RuntimeAuth;
}

export type MaterializedRequest =
  | (MaterializedCommon & { protocol: "http"; method: HttpMethod; body?: RuntimeBody })
  | (MaterializedCommon & { protocol: "websocket"; message?: string })
  | (MaterializedCommon & { protocol: "soap"; method: "POST"; envelope: string; soapAction?: string });

export function materializeRequest(
  contract: DeepReadonly<ApiContract>,
  context: ProjectAssetContextReadView,
  inputs: MaterializeInputs,
): MaterializedRequest {
  const gate = context.checkGate("execution", contract.id);
  if (!gate.ok) {
    throw Object.assign(
      new RequestMaterializationError("ASSET_EXECUTION_BLOCKED", "The request has unresolved asset dependencies."),
      { diagnostics: gate.diagnostics },
    );
  }

  const request = contract.request;
  const pathParams = materializeParameters(request.pathParams, "path", context, inputs.resolve);
  const path = materializePath(request.path, pathParams, inputs.resolve);
  const requestBaseUrl = inputs.resolve(request.baseUrl);
  const baseUrl = requestBaseUrl !== ""
    ? requestBaseUrl
    : inputs.envBaseUrl === undefined ? requestBaseUrl : inputs.resolve(inputs.envBaseUrl);
  const url = joinRequestUrl(baseUrl, path, request.protocol);
  const queryParams = materializeParameters(request.query, "query", context, inputs.resolve);
  const headerParams = materializeParameters(request.headers, "header", context, inputs.resolve);
  const cookieParams = materializeParameters(request.cookies, "cookie", context, inputs.resolve);
  const query = mergeQuery(queryParams, inputs.globals.query ?? [], inputs.resolve);
  const { headers, explicitCookieHeader } = mergeHeaders(headerParams, inputs.globals.headers ?? [], inputs.resolve);
  if (explicitCookieHeader !== undefined) {
    headers.Cookie = explicitCookieHeader;
  } else {
    const cookies = mergeCookies(cookieParams, inputs.globals.cookies ?? [], inputs.resolve);
    if (cookies !== undefined) headers.Cookie = cookies;
  }
  const auth = materializeAuth(request.auth, context, inputs);
  const common: MaterializedCommon = { url, headers, query, auth };

  switch (request.protocol) {
    case "http": {
      const body = materializeBody(request.body, inputs.globals.body ?? [], inputs.resolve);
      return body === undefined
        ? { protocol: "http", method: request.method, ...common }
        : { protocol: "http", method: request.method, ...common, body };
    }
    case "websocket":
      return request.message === undefined
        ? { protocol: "websocket", ...common }
        : { protocol: "websocket", ...common, message: inputs.resolve(request.message) };
    case "soap":
      return request.soapAction === undefined
        ? { protocol: "soap", method: "POST", ...common, envelope: inputs.resolve(request.envelope) }
        : { protocol: "soap", method: "POST", ...common, envelope: inputs.resolve(request.envelope), soapAction: inputs.resolve(request.soapAction) };
  }
}

function materializePath(pathTemplate: string, parameters: MaterializedParameter[], resolve: (template: string) => string): string {
  let path = resolve(pathTemplate);
  for (const parameter of parameters) {
    const token = `{${parameter.name}}`;
    const hasValue = parameter.enabled && parameter.value.length > 0;
    if (parameter.required && !hasValue) {
      throw new RequestMaterializationError("REQUEST_PATH_PARAMETER_MISSING", "A required path parameter has no value.");
    }
    path = path.replaceAll(token, hasValue ? encodeURIComponent(parameter.value) : "");
  }
  return path;
}

function joinRequestUrl(baseUrl: string, path: string, protocol: ApiRequest["protocol"]): string {
  if (path.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.includes("?") || path.includes("#") || path.includes("\\")) {
    throw new RequestMaterializationError("REQUEST_URL_INVALID", "The request path must be a relative path without query or fragment.");
  }
  if (hasUrlDotSegment(path)) {
    throw new RequestMaterializationError("REQUEST_PATH_DOT_SEGMENT", "The request path contains a segment that URL normalization would remove.");
  }

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new RequestMaterializationError("REQUEST_URL_INVALID", "The request base URL is invalid.");
  }
  const allowedProtocols = protocol === "websocket" ? ["ws:", "wss:"] : ["http:", "https:"];
  if (!allowedProtocols.includes(base.protocol) || base.search !== "" || base.hash !== "" || /[?#]/.test(baseUrl)) {
    throw new RequestMaterializationError("REQUEST_URL_INVALID", "The request base URL is invalid for this protocol.");
  }
  if (path === "") return base.href;

  const relativePath = path.replace(/^\/+/, "");
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}/${relativePath}`;
  return base.href;
}

function hasUrlDotSegment(path: string): boolean {
  if (/[\u0009\u000A\u000D]/.test(path)) return true;
  return path.split("/").some((segment) => {
    const dotSequence = segment.replace(/%2e/gi, ".");
    return dotSequence === "." || dotSequence === "..";
  });
}

function mergeQuery(parameters: MaterializedParameter[], globals: readonly KeyValuePair[], resolve: (template: string) => string): KeyValuePair[] {
  const requestNames = new Set(parameters.map((parameter) => parameter.name));
  const inherited = globals
    .filter((parameter) => parameter.enabled && parameter.key.length > 0 && !requestNames.has(parameter.key))
    .map((parameter) => ({ key: parameter.key, value: resolve(parameter.value), enabled: true }));
  const request = parameters.map((parameter) => ({ key: parameter.name, value: parameter.value, enabled: parameter.enabled }));
  return [...inherited, ...request];
}

function mergeHeaders(
  parameters: MaterializedParameter[],
  globals: readonly KeyValuePair[],
  resolve: (template: string) => string,
): { headers: Record<string, string>; explicitCookieHeader?: string } {
  const headersByName = new Map<string, { name: string; value: string }>();
  const requestNames = new Set(parameters.map((parameter) => parameter.name.toLowerCase()));

  for (const parameter of globals) {
    if (!parameter.enabled || parameter.key.length === 0 || requestNames.has(parameter.key.toLowerCase())) continue;
    const value = resolve(parameter.value);
    headersByName.set(parameter.key.toLowerCase(), { name: parameter.key, value });
  }

  for (const parameter of parameters) {
    const normalizedName = parameter.name.toLowerCase();
    if (parameter.enabled) headersByName.set(normalizedName, { name: parameter.name, value: parameter.value });
    else headersByName.delete(normalizedName);
  }

  const cookieHeader = headersByName.get("cookie");
  headersByName.delete("cookie");
  const headers = Object.fromEntries([...headersByName.values()].map(({ name, value }) => [name, value])) as Record<string, string>;
  return { headers, explicitCookieHeader: cookieHeader?.value };
}

function mergeCookies(
  parameters: MaterializedParameter[],
  globals: readonly KeyValuePair[],
  resolve: (template: string) => string,
): string | undefined {
  const values = new Map<string, string>();
  for (const cookie of globals) {
    if (cookie.enabled && cookie.key.length > 0) {
      const key = resolve(cookie.key);
      if (key.length > 0) values.set(key, resolve(cookie.value));
    }
  }
  for (const parameter of parameters) {
    if (parameter.enabled) values.set(parameter.name, parameter.value);
    else values.delete(parameter.name);
  }
  return values.size === 0 ? undefined : [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

function materializeAuth(auth: DeepReadonly<AuthBinding>, context: ProjectAssetContextReadView, inputs: MaterializeInputs): RuntimeAuth {
  let definition: DeepReadonly<InlineAuthBinding>;
  if (auth.kind === "componentRef") {
    const component = context.getComponent(auth.componentId);
    if (!component || component.kind !== "auth") {
      throw new RequestMaterializationError("ASSET_REFERENCE_INVALID", "The authentication reference is unavailable.");
    }
    definition = component.definition;
  } else {
    definition = auth;
  }

  switch (definition.kind) {
    case "none":
      return { kind: "none" };
    case "bearer":
      return { kind: "bearer", token: resolveCredential(definition.token, inputs.credentials) };
    case "basic":
      return {
        kind: "basic",
        username: inputs.resolve(definition.username),
        password: resolveCredential(definition.password, inputs.credentials),
      };
    case "apikey":
      return {
        kind: "apikey",
        name: inputs.resolve(definition.name),
        placement: definition.placement,
        value: resolveCredential(definition.value, inputs.credentials),
      };
  }
}

function resolveCredential(ref: DeepReadonly<SecretRef>, credentials: CredentialBindings): string {
  if (ref.policy !== "test-auto") {
    throw new RequestMaterializationError("CREDENTIAL_POLICY_UNSUPPORTED", "The credential policy is not supported for this request.");
  }
  const value = credentials.resolve(ref);
  if (/\{\{\s*[A-Za-z0-9_.$-]+\s*\}\}/.test(value)) {
    throw new RequestMaterializationError("AUTH_SECRET_UNRESOLVED", "A credential resolved to an unresolved placeholder.");
  }
  return value;
}
