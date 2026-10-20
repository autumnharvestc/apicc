import { describe, expect, it } from "vitest";

import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { buildDocumentProjection } from "../../src/design/projection.js";
import { generateRequestSnippet, renderDocumentMarkdown } from "../../src/design/document.js";
import { designDocumentIds, projectionProject } from "../helpers/designDocumentFixture.js";

const languages = ["curl-posix", "powershell", "javascript-fetch"] as const;
type Language = typeof languages[number];

function documentProjection() {
  const project = projectionProject();
  const asset = project.collections[0]!.apis[0]!;
  const request = asset.contract.request;
  if (request.protocol !== "http") throw new Error("The shared document fixture must be HTTP.");
  request.method = "POST";
  request.path = "/users/{id}";
  const pathParam = request.pathParams[0];
  if (!pathParam || pathParam.kind !== "componentRef") throw new Error("The shared fixture must include its path component.");
  request.pathParams[0] = { ...pathParam, value: "a/b ?'" };
  request.query = [
    { kind: "inline", id: "10000000-0000-4000-8000-000000000011", name: "access_token", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "synthetic-import-token" },
    { kind: "inline", id: "10000000-0000-4000-8000-000000000012", name: "tag", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "first" },
    { kind: "inline", id: "10000000-0000-4000-8000-000000000013", name: "tag", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "second & more" },
    { kind: "inline", id: "10000000-0000-4000-8000-000000000014", name: "note", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "line\n\"quoted'" },
    { kind: "inline", id: "10000000-0000-4000-8000-000000000015", name: "skip", schema: { kind: "scalar", type: "string" }, required: false, enabled: false, description: "", value: "must-not-send" },
  ];
  request.headers = [
    { kind: "inline", id: "10000000-0000-4000-8000-000000000016", name: "Content-Type", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "application/vnd.example+json" },
    { kind: "inline", id: "10000000-0000-4000-8000-000000000017", name: "X-Note", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "say \"hello\"" },
    { kind: "inline", id: "10000000-0000-4000-8000-000000000018", name: "X-Disabled", schema: { kind: "scalar", type: "string" }, required: false, enabled: false, description: "", value: "must-not-send" },
  ];
  request.body = {
    kind: "json",
    content: '{\n  "password": "synthetic-import-token",\n  "message": "line one\\nline two"\n}',
    schema: { kind: "modelRef", modelId: designDocumentIds.model },
  };
  asset.contract.responses.push({
    kind: "inline",
    id: "10000000-0000-4000-8000-000000000019",
    status: "404",
    description: "not found",
    headers: { "X-Trace": "request-id" },
    content: { "text/plain": { examples: [{ kind: "inline", id: "10000000-0000-4000-8000-00000000001a", name: "missing", value: "not found" }] } },
  });
  asset.documentation = "Keep this business note in the document.";
  return buildDocumentProjection(createProjectSnapshot(project), { kind: "apis", contractIds: [designDocumentIds.contract] });
}

function documentApi() {
  return documentProjection().apis[0]!;
}

function withAuth(api: ReturnType<typeof documentApi>, auth: ReturnType<typeof documentApi>["request"]["auth"]) {
  return { ...api, request: { ...api.request, auth } };
}

describe("projection document and request snippets", () => {
  it.each(languages)("derives ordered, redacted HTTP semantics for %s", (language: Language) => {
    const api = documentApi();
    const snippet = generateRequestSnippet(api, language);
    const expectedUrl = "https://api.example.test/v1/users/a%2Fb%20%3F%27?access_token=%7B%7BACCESS_TOKEN%7D%7D&tag=first&tag=second%20%26%20more&note=line%0A%22quoted%27";

    expect(snippet.code).toContain(expectedUrl);
    expect(snippet.code.indexOf("tag=first")).toBeLessThan(snippet.code.indexOf("tag=second%20%26%20more"));
    expect(snippet.code).toContain("application/vnd.example+json");
    expect(snippet.code).toContain("X-Note");
    expect(snippet.code).toContain("say");
    expect(snippet.code).not.toContain("X-Disabled");
    expect(snippet.code).not.toContain("must-not-send");
    expect(snippet.code).not.toContain("synthetic-import-token");
    expect(snippet.code).not.toContain("credential-ref-id");
    expect(snippet.code).not.toContain("C:\\private");
    expect(snippet.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false);
    if (language === "curl-posix") expect(snippet.code).toContain("--request 'POST'");
    if (language === "powershell") expect(snippet.code).toContain("Invoke-RestMethod");
    if (language === "javascript-fetch") expect(snippet.code).toContain("await fetch(");
  });

  it("uses public authentication placeholders for bearer, basic, and API-key definitions", () => {
    const api = documentApi();
    const cases = [
      { auth: { kind: "bearer", token: "****" } as const, expected: "Bearer {{BEARER_TOKEN}}" },
      { auth: { kind: "basic", username: "****", password: "****" } as const, expected: "Basic {{BASIC_AUTH_BASE64}}" },
      { auth: { kind: "apikey", name: "X-Client-Key", placement: "header", value: "****" } as const, expected: "X-Client-Key" },
      { auth: { kind: "apikey", name: "subscription-key", placement: "query", value: "****" } as const, expected: "subscription-key=%7B%7BAPI_KEY%7D%7D" },
    ];

    for (const { auth, expected } of cases) {
      for (const language of languages) {
        const snippet = generateRequestSnippet(withAuth(api, auth), language);
        expect(snippet.code).toContain(expected);
        expect(snippet.code).not.toContain("credential-ref-id");
        expect(snippet.code).not.toContain("synthetic-import-token");
      }
    }
  });

  it("rejects an API-key header name that cannot be represented by HTTP", () => {
    const api = documentApi();
    const snippet = generateRequestSnippet(withAuth(api, {
      kind: "apikey", name: "X-Key\r\nInjected", placement: "header", value: "****",
    }), "javascript-fetch");

    expect(snippet.code).toBe("");
    expect(snippet.diagnostics).toContainEqual(expect.objectContaining({ code: "SNIPPET_HEADER_NAME_INVALID", severity: "error" }));
  });

  it("rejects PowerShell headers that collide case-insensitively, including auth headers", () => {
    const api = documentApi();
    const makeHeader = (id: string, name: string) => ({
      kind: "inline" as const, id, location: "header" as const, name, schema: { kind: "scalar" as const, type: "string" as const },
      required: false, enabled: true, description: "", value: "synthetic",
    });
    const cases = [
      {
        headers: [makeHeader("header-1", "X-Trace"), makeHeader("header-2", "x-trace")],
        auth: { kind: "none" as const },
      },
      {
        headers: [makeHeader("header-3", "authorization")],
        auth: { kind: "bearer" as const, token: "****" },
      },
    ];

    for (const scenario of cases) {
      const snippet = generateRequestSnippet({
        ...api,
        request: { ...api.request, headers: scenario.headers, auth: scenario.auth },
      }, "powershell");
      expect(snippet.code).toBe("");
      expect(snippet.diagnostics).toContainEqual(expect.objectContaining({
        code: "SNIPPET_POWERSHELL_DUPLICATE_HEADER", severity: "error",
      }));
    }
  });

  it.each(languages)("describes user-supplied multipart files without embedding paths in %s", (language: Language) => {
    const api = documentApi();
    const request = api.request;
    if (request.protocol !== "http") throw new Error("The shared document fixture must be HTTP.");
    const fileApi = {
      ...api,
      request: {
        ...request,
        headers: request.headers.filter((header) => header.kind === "unresolved" || header.name.toLowerCase() !== "content-type"),
        body: {
          kind: "multipart" as const,
          entries: [
            { kind: "text" as const, id: "text-1", name: "caption", value: "a 'quoted' line\nnext", enabled: true },
            { kind: "file" as const, id: "file-1", name: "upload", bound: true, filename: "report.json", contentType: "application/json", enabled: true },
          ],
        },
      },
    };
    const snippet = generateRequestSnippet(fileApi, language);

    expect(snippet.code).toContain("PATH_TO_FILE");
    expect(snippet.code).toContain("report.json");
    expect(snippet.code).toContain("caption");
    expect(snippet.code).not.toContain("C:\\private");
    expect(snippet.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false);
    if (language === "powershell") {
      expect(snippet.code).toContain("MultipartFormDataContent");
      expect(snippet.code).toContain("MediaTypeHeaderValue");
      expect(snippet.code).toContain("report.json");
      const invalidType = generateRequestSnippet({
        ...fileApi,
        request: {
          ...fileApi.request,
          body: {
            ...fileApi.request.body,
            entries: [{ kind: "file" as const, id: "file-invalid-type", name: "upload", bound: true, filename: "report.json", contentType: "not a media type", enabled: true }],
          },
        },
      }, language);
      expect(invalidType.code).toBe("");
      expect(invalidType.diagnostics).toContainEqual(expect.objectContaining({
        code: "SNIPPET_MULTIPART_CONTENT_TYPE_INVALID", severity: "error",
      }));
    }
    if (language === "javascript-fetch") {
      expect(snippet.code).toContain('type: "application/json"');
      expect(snippet.code).toContain('form.append("upload", upload0, "report.json")');
    }
    if (language === "curl-posix") expect(snippet.code).toContain("--form-string");
  });

  it("keeps cURL multipart text literal and rejects unsafe file form metadata", () => {
    const api = documentApi();
    if (api.request.protocol !== "http") throw new Error("The shared document fixture must be HTTP.");
    const multipartApi = {
      ...api,
      request: {
        ...api.request,
        headers: api.request.headers.filter((header) => header.kind === "unresolved" || header.name.toLowerCase() !== "content-type"),
        body: {
          kind: "multipart" as const,
          entries: [
            { kind: "text" as const, id: "text-at", name: "at", value: "@notes.txt", enabled: true },
            { kind: "text" as const, id: "text-less", name: "less", value: "<notes.txt", enabled: true },
            { kind: "text" as const, id: "text-type", name: "type", value: "hello;type=text/plain", enabled: true },
            { kind: "file" as const, id: "file-1", name: "upload", bound: true, filename: "report.json", contentType: "application/json", enabled: true },
          ],
        },
      },
    };
    const snippet = generateRequestSnippet(multipartApi, "curl-posix");
    expect(snippet.code).toContain("--form-string 'at=@notes.txt'");
    expect(snippet.code).toContain("--form-string 'less=<notes.txt'");
    expect(snippet.code).toContain("--form-string 'type=hello;type=text/plain'");
    expect(snippet.code).toContain("--form 'upload=@<PATH_TO_FILE>;filename=report.json;type=application/json'");

    const unsafe = generateRequestSnippet({
      ...multipartApi,
      request: {
        ...multipartApi.request,
        body: {
          ...multipartApi.request.body,
          entries: [{ kind: "file" as const, id: "file-bad", name: "upload;type=text/plain", bound: true, filename: "report.json", contentType: "application/json", enabled: true }],
        },
      },
    }, "curl-posix");
    expect(unsafe.code).toBe("");
    expect(unsafe.diagnostics).toContainEqual(expect.objectContaining({
      code: "SNIPPET_CURL_MULTIPART_METADATA_UNSUPPORTED", severity: "error",
    }));

    const commaFilename = generateRequestSnippet({
      ...multipartApi,
      request: {
        ...multipartApi.request,
        body: {
          ...multipartApi.request.body,
          entries: [{ kind: "file" as const, id: "file-comma", name: "upload", bound: true, filename: "report,final.json", contentType: "application/json", enabled: true }],
        },
      },
    }, "curl-posix");
    expect(commaFilename.code).toBe("");
    expect(commaFilename.diagnostics).toContainEqual(expect.objectContaining({
      code: "SNIPPET_CURL_MULTIPART_METADATA_UNSUPPORTED", severity: "error",
    }));
  });

  it("rejects explicit Content-Type for fetch multipart because its boundary is generated", () => {
    const api = documentApi();
    if (api.request.protocol !== "http") throw new Error("The shared document fixture must be HTTP.");
    const multipartApi = {
      ...api,
      request: {
        ...api.request,
        headers: [...api.request.headers, {
          kind: "inline" as const, id: "multipart-content-type", location: "header" as const, name: "Content-Type",
          schema: { kind: "scalar" as const, type: "string" as const }, required: false,
          enabled: true, description: "", value: "multipart/form-data; boundary=declared",
        }],
        body: {
          kind: "multipart" as const,
          entries: [{ kind: "text" as const, id: "caption", name: "caption", value: "hello", enabled: true }],
        },
      },
    };
    const snippet = generateRequestSnippet(multipartApi, "javascript-fetch");
    expect(snippet.code).toBe("");
    expect(snippet.diagnostics).toContainEqual(expect.objectContaining({
      code: "SNIPPET_FETCH_MULTIPART_CONTENT_TYPE_UNSUPPORTED", severity: "error",
    }));
  });

  it("renders readable projection Markdown with all response statuses and finite model links", () => {
    const projection = documentProjection();
    const markdown = renderDocumentMarkdown(projection);

    expect(markdown).toContain("| Name | Value | Required | Enabled |");
    expect(markdown).toContain("Get user");
    expect(markdown).toContain("200");
    expect(markdown).toContain("404");
    expect(markdown).toContain("application/json");
    expect(markdown).toContain("text/plain");
    expect(markdown).toContain("Schema");
    expect(markdown).toContain(`\"kind\":\"scalar\",\"type\":\"string\"`);
    expect(markdown).toContain(`[User](#model-${designDocumentIds.contract}-${designDocumentIds.model})`);
    expect(markdown).toContain(`#model-${designDocumentIds.contract}-${designDocumentIds.model}`);
    expect(markdown).toContain("Recursive user model");
    expect(markdown).toContain("Read a user");
    expect(markdown).not.toContain("synthetic-import-token");
    expect(markdown).not.toContain("credential-ref-id");

    const api = projection.apis[0]!;
    if (api.request.protocol !== "http") throw new Error("The shared document fixture must be HTTP.");
    for (const kind of ["json", "xml", "text"] as const) {
      api.request.body = { kind, content: "synthetic body", schema: { kind: "modelRef", modelId: designDocumentIds.model } };
      expect(renderDocumentMarkdown(projection)).toContain(`[User](#model-${designDocumentIds.contract}-${designDocumentIds.model})`);
    }
    api.request.body = { kind: "graphql", query: "mutation UpdateUser { updateUser }", operationName: "UpdateUser" };
    expect(renderDocumentMarkdown(projection)).toContain("Operation name: UpdateUser");
    api.request.body = {
      kind: "multipart",
      entries: [{ kind: "file", id: "file-doc", name: "upload", bound: true, filename: "report.json", contentType: "application/json", enabled: true }],
    };
    expect(renderDocumentMarkdown(projection)).toContain("application/json");
  });
});
