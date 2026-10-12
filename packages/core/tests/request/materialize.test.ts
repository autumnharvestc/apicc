import { describe, expect, it } from "vitest";

import { createProjectAssetContext } from "../../src/assets/context.js";
import type {
  ApiAsset,
  ApiContract,
  ApiRequest,
  ComponentAsset,
  HttpRequest,
} from "../../src/contract/model.js";
import type { CredentialBindings } from "../../src/credentials/types.js";
import type { ProjectGlobals } from "../../src/domain/model.js";
import { materializeRequest } from "../../src/request/materialize.js";

const contractId = "00000000-0000-4000-8000-000000000101";
const parameterComponentId = "00000000-0000-4000-8000-000000000102";
const parameterBindingId = "00000000-0000-4000-8000-000000000103";

function httpRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    protocol: "http",
    method: "GET",
    baseUrl: "https://example.test/v1",
    path: "users",
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth: { kind: "none" },
    body: { kind: "none" },
    ...overrides,
  };
}

function contractFor(request: ApiRequest, components: ComponentAsset[] = []): ApiContract {
  return {
    formatVersion: 1,
    id: contractId,
    metadata: { name: "Users", description: "", tags: [], version: "1", status: "draft" },
    request,
    responses: [],
  };
}

function contextFor(contract: ApiContract, components: ComponentAsset[] = []) {
  const asset: ApiAsset = { contract, cases: [], documentation: "" };
  return createProjectAssetContext({ projectId: "00000000-0000-4000-8000-000000000199", assets: [asset], models: [], components });
}

function inputs(options: {
  globals?: Partial<ProjectGlobals>;
  envBaseUrl?: string;
  variables?: Record<string, string>;
  secrets?: Record<string, string>;
} = {}) {
  const credentials: CredentialBindings = {
    versions: {},
    resolve(ref) {
      const value = options.secrets?.[ref.id];
      if (value === undefined) throw new Error("credential unavailable");
      return value;
    },
  };
  return {
    globals: options.globals ?? {},
    envBaseUrl: options.envBaseUrl,
    credentials,
    resolve(template: string) {
      return template.replace(/\{\{\s*([A-Za-z0-9_.$-]+)\s*\}\}/g, (match, key: string) => options.variables?.[key] ?? match);
    },
  };
}

function materialize(request: ApiRequest, options: Parameters<typeof inputs>[0] = {}, components: ComponentAsset[] = []) {
  const contract = contractFor(request, components);
  return materializeRequest(contract, contextFor(contract, components), inputs(options));
}

const parameterSchema = { kind: "scalar", type: "string" } as const;

describe("materializeRequest", () => {
  it.each([
    ["https://example.test/v1", "users"],
    ["https://example.test/v1", "/users"],
    ["https://example.test/v1/", "users"],
    ["https://example.test/v1/", "/users"],
  ])("joins base URL %s and path %s without losing the base path", (baseUrl, path) => {
    expect(materialize(httpRequest({ baseUrl, path })).url).toBe("https://example.test/v1/users");
  });

  it("keeps the base URL path when the request path is empty", () => {
    expect(materialize(httpRequest({ path: "" })).url).toBe("https://example.test/v1");
  });

  it.each(["https://other.test/users", "//other.test/users", "?page=2", "#section", "users?page=2", "users#section"])(
    "rejects path values that split or replace the request URL: %s",
    (path) => {
      expect(() => materialize(httpRequest({ path }))).toThrow(expect.objectContaining({ code: "REQUEST_URL_INVALID" }));
    },
  );

  it("encodes path values exactly once and requires a concrete path value", () => {
    const withPath = httpRequest({
      path: "/users/{userId}",
      pathParams: [{ kind: "inline", id: parameterBindingId, name: "userId", schema: parameterSchema, required: true, enabled: true, description: "", value: "a/b c%2F" }],
    });
    expect(materialize(withPath).url).toBe("https://example.test/v1/users/a%2Fb%20c%252F");

    const noValue = httpRequest({
      path: "/users/{userId}",
      pathParams: [{ kind: "inline", id: parameterBindingId, name: "userId", schema: { ...parameterSchema, default: "default", examples: ["example"] }, required: true, enabled: true, description: "" }],
    });
    expect(() => materialize(noValue)).toThrow(expect.objectContaining({ code: "REQUEST_PATH_PARAMETER_MISSING" }));
  });

  it.each(["./users", "../users", "%2e/users", "%2E/users", ".%2e/users", "%2e./users", "%2e%2e/users", "%2E%2E/users"])(
    "I2 - rejects dot segments that URL normalization would remove: %s",
    (path) => {
      expect(() => materialize(httpRequest({ path }))).toThrow(expect.objectContaining({ code: "REQUEST_PATH_DOT_SEGMENT" }));
    },
  );

  it.each([".\t./users", ".\n./users", ".\r./users"])("I2 - rejects URL-stripped control characters in dot segments: %s", (path) => {
    expect(() => materialize(httpRequest({ path }))).toThrow(expect.objectContaining({ code: "REQUEST_PATH_DOT_SEGMENT" }));
  });

  it("I2 - rejects dot segments introduced by variable resolution", () => {
    expect(() => materialize(httpRequest({ path: "{{route}}/users" }), { variables: { route: ".." } })).toThrow(
      expect.objectContaining({ code: "REQUEST_PATH_DOT_SEGMENT" }),
    );
  });

  it("I2 - rejects dot segments introduced by one-time path parameter encoding", () => {
    const request = httpRequest({
      path: "{userId}/users",
      pathParams: [{ kind: "inline", id: parameterBindingId, name: "userId", schema: parameterSchema, required: true, enabled: true, description: "", value: ".." }],
    });
    expect(() => materialize(request)).toThrow(expect.objectContaining({ code: "REQUEST_PATH_DOT_SEGMENT" }));
  });

  it("I2 - preserves ordinary dotted path names", () => {
    expect(materialize(httpRequest({ path: "v1.2/users..bak" })).url).toBe("https://example.test/v1/v1.2/users..bak");
  });

  it("prefers a nonempty literal request base URL over the selected environment fallback", () => {
    const result = materialize(httpRequest({ baseUrl: "https://design.test/api", path: "/users" }), { envBaseUrl: "https://runtime.test/v2/" });
    expect(result.url).toBe("https://design.test/api/users");
  });

  it("prefers a nonempty request base URL after variable resolution", () => {
    const result = materialize(httpRequest({ baseUrl: "{{baseUrl}}", path: "/users" }), {
      envBaseUrl: "https://runtime.test/v2/", variables: { baseUrl: "https://design.test/api" },
    });
    expect(result.url).toBe("https://design.test/api/users");
  });

  it("uses the selected environment fallback when the resolved request base URL is empty", () => {
    const result = materialize(httpRequest({ baseUrl: "{{baseUrl}}", path: "/users" }), {
      envBaseUrl: "https://runtime.test/v2/", variables: { baseUrl: "" },
    });
    expect(result.url).toBe("https://runtime.test/v2/users");
  });

  it("does not fall back from an invalid nonempty request base URL", () => {
    expect(() => materialize(httpRequest({ baseUrl: "not a URL", path: "/users" }), { envBaseUrl: "https://runtime.test/v2/" }))
      .toThrow(expect.objectContaining({ code: "REQUEST_URL_INVALID" }));
  });

  it("uses a selected environment base URL when the contract base URL is explicitly empty", () => {
    const result = materialize(httpRequest({ baseUrl: "", path: "/users" }), { envBaseUrl: "https://runtime.test/v2/" });
    expect(result.url).toBe("https://runtime.test/v2/users");
  });

  it("I1 - merges cookie parameters when there is no explicit Cookie header", () => {
    const result = materialize(httpRequest({
      cookies: [
        { kind: "inline", id: parameterBindingId, name: "sid", schema: parameterSchema, required: false, enabled: true, description: "", value: "local" },
        { kind: "inline", id: "00000000-0000-4000-8000-000000000104", name: "role", schema: parameterSchema, required: false, enabled: true, description: "", value: "admin" },
      ],
    }), {
      globals: { cookies: [{ key: "sid", value: "global", enabled: true }, { key: "theme", value: "dark", enabled: true }] },
    });
    expect(result.headers).toEqual({ Cookie: "sid=local; theme=dark; role=admin" });
  });

  it("I1 - preserves an enabled explicit Cookie header as the complete header", () => {
    const result = materialize(httpRequest({
      cookies: [{ kind: "inline", id: parameterBindingId, name: "sid", schema: parameterSchema, required: false, enabled: true, description: "", value: "local" }],
      headers: [{ kind: "inline", id: "00000000-0000-4000-8000-000000000105", name: "cookie", schema: parameterSchema, required: false, enabled: true, description: "", value: " theme=light ; from-header=one " }],
    }), { globals: { cookies: [{ key: "extra", value: "global", enabled: true }] } });
    expect(result.headers).toEqual({ Cookie: " theme=light ; from-header=one " });
  });

  it("I1 - preserves an inherited explicit Cookie header as the complete header", () => {
    const result = materialize(httpRequest({
      cookies: [{ kind: "inline", id: parameterBindingId, name: "sid", schema: parameterSchema, required: false, enabled: true, description: "", value: "local" }],
    }), { globals: { headers: [{ key: "cOoKiE", value: "z=last; a=first", enabled: true }], cookies: [{ key: "extra", value: "global", enabled: true }] } });
    expect(result.headers).toEqual({ Cookie: "z=last; a=first" });
  });

  it("I1 - treats an enabled empty Cookie header as present", () => {
    const result = materialize(httpRequest({
      cookies: [{ kind: "inline", id: parameterBindingId, name: "sid", schema: parameterSchema, required: false, enabled: true, description: "", value: "local" }],
      headers: [{ kind: "inline", id: "00000000-0000-4000-8000-000000000105", name: "COOKIE", schema: parameterSchema, required: false, enabled: true, description: "", value: "" }],
    }), { globals: { headers: [{ key: "Cookie", value: "global=header", enabled: true }], cookies: [{ key: "extra", value: "global", enabled: true }] } });
    expect(result.headers).toEqual({ Cookie: "" });
  });

  it("I1 - lets a disabled request Cookie header suppress a global header and falls back to cookie parameters", () => {
    const result = materialize(httpRequest({
      cookies: [{ kind: "inline", id: parameterBindingId, name: "sid", schema: parameterSchema, required: false, enabled: true, description: "", value: "local" }],
      headers: [{ kind: "inline", id: "00000000-0000-4000-8000-000000000105", name: "COOKIE", schema: parameterSchema, required: false, enabled: false, description: "", value: "ignored" }],
    }), { globals: { headers: [{ key: "Cookie", value: "global=header", enabled: true }], cookies: [{ key: "sid", value: "global", enabled: true }, { key: "theme", value: "dark", enabled: true }] } });
    expect(result.headers).toEqual({ Cookie: "sid=local; theme=dark" });
  });

  it("lets enabled request headers override globals without case-sensitive duplicates", () => {
    const result = materialize(httpRequest({
      headers: [{ kind: "inline", id: parameterBindingId, name: "x-tenant", schema: parameterSchema, required: false, enabled: true, description: "", value: "request" }],
    }), { globals: { headers: [{ key: "X-Tenant", value: "global", enabled: true }] } });
    expect(result.headers).toEqual({ "x-tenant": "request" });
  });

  it("allows a disabled request header to suppress the case-insensitive global header", () => {
    const result = materialize(httpRequest({
      headers: [{ kind: "inline", id: parameterBindingId, name: "x-tenant", schema: parameterSchema, required: false, enabled: false, description: "", value: "ignored" }],
    }), { globals: { headers: [{ key: "X-Tenant", value: "global", enabled: true }] } });
    expect(result.headers).toEqual({});
  });

  it.each([
    ["Authorization", true, { Authorization: "request" }],
    ["authorization", true, { authorization: "request" }],
    ["Authorization", false, {}],
    ["authorization", false, {}],
  ] as const)("lets an enabled or disabled %s request header override the global header", (name, enabled, expected) => {
    const result = materialize(httpRequest({
      headers: [{ kind: "inline", id: parameterBindingId, name, schema: parameterSchema, required: false, enabled, description: "", value: "request" }],
    }), { globals: { headers: [{ key: name === "Authorization" ? "authorization" : "Authorization", value: "global", enabled: true }] } });
    expect(result.headers).toEqual(expected);
  });

  it("resolves a parameter reference from the supplied read-only component context", () => {
    const binding = { kind: "componentRef" as const, id: parameterBindingId, componentId: parameterComponentId, expectedKind: "parameter" as const, value: "blue" };
    const request = httpRequest({ query: [binding] });
    const component = (name: string): ComponentAsset => ({
      formatVersion: 1,
      id: parameterComponentId,
      name: "Reusable query parameter",
      description: "",
      kind: "parameter",
      definition: { location: "query", name, schema: parameterSchema, required: false, description: "" },
    });
    const contract = contractFor(request);
    const oldResult = materializeRequest(contract, contextFor(contract, [component("oldName")]), inputs());
    const newResult = materializeRequest(contract, contextFor(contract, [component("newName")]), inputs());
    expect(oldResult.query).toEqual([{ key: "oldName", value: "blue", enabled: true }]);
    expect(newResult.query).toEqual([{ key: "newName", value: "blue", enabled: true }]);
  });

  it("does not reject query values or raw JSON text using design schemas", () => {
    const result = materialize(httpRequest({
      query: [{ kind: "inline", id: parameterBindingId, name: "count", schema: { kind: "scalar", type: "integer", default: 4, examples: [2] }, required: true, enabled: true, description: "", value: "not-an-integer" }],
      body: { kind: "json", content: "not valid JSON", schema: { kind: "scalar", type: "integer" } },
    }));
    expect(result.query).toEqual([{ key: "count", value: "not-an-integer", enabled: true }]);
    expect(result.protocol === "http" ? result.body : undefined).toEqual({ kind: "json", content: "not valid JSON" });
  });

  it("does not block request materialization on an unrelated unresolved response draft", () => {
    const contract = contractFor(httpRequest());
    contract.responses = [{ kind: "componentRef", id: "00000000-0000-4000-8000-000000000108", componentId: "00000000-0000-4000-8000-000000000109", expectedKind: "response" }];
    expect(materializeRequest(contract, contextFor(contract), inputs()).url).toBe("https://example.test/v1/users");
  });

  it("does not use schema defaults or examples as query instance values", () => {
    const result = materialize(httpRequest({
      query: [{ kind: "inline", id: parameterBindingId, name: "q", schema: { kind: "scalar", type: "string", default: "default", examples: ["example"] }, required: true, enabled: true, description: "" }],
    }));
    expect(result.query).toEqual([{ key: "q", value: "", enabled: true }]);
  });

  it("encodes a GraphQL document and decoded variables as a JSON transport body", () => {
    const result = materialize(httpRequest({
      method: "POST",
      body: { kind: "graphql", query: "query Get($id: ID!) { user(id: $id) { id } }", variables: "{\"id\":\"{{userId}}\"}", operationName: "Get{{suffix}}" },
    }), { variables: { userId: "u-7", suffix: "User" } });
    expect(result.protocol === "http" ? result.body : undefined).toEqual({
      kind: "json",
      content: "{\"query\":\"query Get($id: ID!) { user(id: $id) { id } }\",\"variables\":{\"id\":\"u-7\"},\"operationName\":\"GetUser\"}",
    });
  });

  it("converts URL-encoded fields and merges non-overridden global body values", () => {
    const result = materialize(httpRequest({
      method: "POST",
      body: { kind: "urlencoded", fields: [{ id: parameterBindingId, name: "q", value: "{{term}}", enabled: true }, { id: "00000000-0000-4000-8000-000000000106", name: "off", value: "x", enabled: false }] },
    }), { variables: { term: "blue" }, globals: { body: [{ key: "q", value: "global", enabled: true }, { key: "extra", value: "yes", enabled: true }] } });
    expect(result.protocol === "http" ? result.body : undefined).toEqual({ kind: "form", content: "", form: [{ key: "q", value: "blue", enabled: true }, { key: "extra", value: "yes", enabled: true }] });
  });

  it.each([
    { kind: "multipart" as const, entries: [] },
    { kind: "binary" as const, file: { path: "C:/private/data.bin" }, contentType: "application/octet-stream" },
  ])("rejects body encoding without a transport implementation: $kind", (body) => {
    expect(() => materialize(httpRequest({ method: "POST", body }))).toThrow(expect.objectContaining({ code: "UNSUPPORTED_BODY_ENCODING" }));
  });

  it("keeps runtime auth separate from contract references and resolves only this request's secret binding", () => {
    const ref = { id: "secret-id", policy: "test-auto" };
    const request = httpRequest({ auth: { kind: "bearer", token: ref } });
    const result = materialize(request, { secrets: { "secret-id": "decrypted-token" } });
    expect(result.auth).toEqual({ kind: "bearer", token: "decrypted-token" });
    expect(request.auth).toEqual({ kind: "bearer", token: ref });
  });

  it("rejects unsupported credential policy and unresolved secret placeholders without exposing values", () => {
    const unsupported = httpRequest({ auth: { kind: "bearer", token: { id: "unsupported-id", policy: "unknown" } } });
    expect(() => materialize(unsupported, { secrets: { "unsupported-id": "must-not-appear" } })).toThrow(expect.objectContaining({ code: "CREDENTIAL_POLICY_UNSUPPORTED" }));

    const unresolved = httpRequest({ auth: { kind: "bearer", token: { id: "placeholder-id", policy: "test-auto" } } });
    try {
      materialize(unresolved, { secrets: { "placeholder-id": "{{stillMissing}}" } });
      throw new Error("expected unresolved secret to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "AUTH_SECRET_UNRESOLVED" });
      expect(error instanceof Error ? error.message : String(error)).not.toContain("stillMissing");
    }
  });

  it("materializes WebSocket message fields without HTTP-only method or body fields", () => {
    const request: ApiRequest = {
      protocol: "websocket",
      baseUrl: "wss://example.test/socket",
      path: "/events",
      pathParams: [],
      query: [],
      headers: [],
      cookies: [],
      auth: { kind: "none" },
      message: "hello {{name}}",
    };
    const result = materialize(request, { envBaseUrl: "wss://runtime.test/other", variables: { name: "Ada" } });
    expect(result).toEqual({ protocol: "websocket", url: "wss://example.test/socket/events", headers: {}, query: [], auth: { kind: "none" }, message: "hello Ada" });
  });

  it("materializes SOAP envelope and action without HTTP body or WebSocket message fields", () => {
    const request: ApiRequest = {
      protocol: "soap",
      method: "POST",
      baseUrl: "https://example.test/services",
      path: "/users",
      pathParams: [],
      query: [],
      headers: [],
      cookies: [],
      auth: { kind: "none" },
      envelope: "<Envelope>{{name}}</Envelope>",
      soapAction: "urn:Get{{suffix}}",
    };
    const result = materialize(request, { envBaseUrl: "https://runtime.test/other", variables: { name: "Ada", suffix: "User" } });
    expect(result).toEqual({ protocol: "soap", method: "POST", url: "https://example.test/services/users", headers: {}, query: [], auth: { kind: "none" }, envelope: "<Envelope>Ada</Envelope>", soapAction: "urn:GetUser" });
  });

  it("owns nested request data per call and leaves the read-only asset context unchanged", () => {
    const request = httpRequest({
      headers: [{ kind: "inline", id: parameterBindingId, name: "x-run", schema: parameterSchema, required: false, enabled: true, description: "", value: "initial" }],
      query: [{ kind: "inline", id: "00000000-0000-4000-8000-000000000107", name: "q", schema: parameterSchema, required: false, enabled: true, description: "", value: "initial" }],
      auth: { kind: "bearer", token: { id: "owned-secret", policy: "test-auto" } },
      body: { kind: "json", content: "{\"value\":\"initial\"}" },
    });
    const contract = contractFor(request);
    const context = contextFor(contract);
    const first = materializeRequest(contract, context, inputs({ secrets: { "owned-secret": "initial-token" } }));
    const second = materializeRequest(contract, context, inputs({ secrets: { "owned-secret": "initial-token" } }));

    first.headers["x-run"] = "changed";
    first.query[0]!.value = "changed";
    if (first.auth.kind === "bearer") first.auth.token = "changed";
    if (first.protocol === "http" && first.body) first.body.content = "changed";

    expect(second.headers).toEqual({ "x-run": "initial" });
    expect(second.query).toEqual([{ key: "q", value: "initial", enabled: true }]);
    expect(second.auth).toEqual({ kind: "bearer", token: "initial-token" });
    expect(second.protocol === "http" ? second.body : undefined).toEqual({ kind: "json", content: "{\"value\":\"initial\"}" });
    expect(context.getContract(contractId)?.request).toEqual(request);
  });
});
