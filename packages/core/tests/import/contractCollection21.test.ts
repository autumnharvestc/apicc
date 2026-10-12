import { describe, expect, it } from "vitest";

import { parseContractCollection21 } from "../../src/import/contractCollection21.js";

describe("parseContractCollection21", () => {
  it("keeps arbitrarily nested folders, splits URL query, preserves response and file documentation, and diagnoses scripts without running them", () => {
    const imported = parseContractCollection21({
      info: {
        name: "Collection API",
        schema: "https://example.test/schemas/collection-v2.1.json",
      },
      auth: { type: "basic", extension: "auth-extension-value", basic: [{ key: "username", value: "collection-user" }, { key: "password", value: "collection-password-secret" }] },
      item: [{
        name: "Level one",
        item: [{
          name: "Level two",
          item: [{
            name: "Level three",
            item: [
              {
                name: "Create account",
                event: [{ listen: "prerequest", script: { exec: ["throw new Error('script-origin-secret')"] } }],
                request: {
                  auth: { type: "inherit" },
                  method: "POST",
                  url: { raw: "https://api.example.test/v1/accounts?limit=5#preview" },
                  header: [{ key: "Authorization", value: "Bearer synthetic-import-token" }],
                  body: {
                    mode: "raw",
                    raw: '{"password":"synthetic-import-token","displayName":"Ada"}',
                    options: { raw: { language: "json" } },
                  },
                },
                response: [{
                  name: "created",
                  code: 201,
                  status: "Created",
                  header: [{ key: "Content-Type", value: "application/json" }],
                  body: '{"id":7,"name":"Ada"}',
                }],
              },
              {
                name: "Upload avatar",
                request: {
                  method: "POST",
                  url: { raw: "https://api.example.test/v1/avatars" },
                  body: {
                    mode: "formdata",
                    formdata: [{ key: "avatar", type: "file", src: "avatar.png", description: "Choose the profile image." }],
                  },
                },
              },
              {
                name: "GraphQL variables",
                request: {
                  method: "POST",
                  url: { raw: "https://api.example.test/v1/graphql" },
                  body: {
                    mode: "graphql",
                    graphql: { query: "query Account($password: String) { account }", variables: '{"password":"graphql-password-secret"' },
                  },
                },
              },
            ],
          }],
        }],
      }],
    });

    const collection = imported.project.collections[0];
    expect(collection).toBeDefined();
    if (!collection) throw new Error("Expected an imported collection.");
    const levelThree = collection.folders[0]?.folders[0]?.folders[0];
    expect(levelThree?.name).toBe("Level three");
    expect(levelThree?.apis).toHaveLength(3);
    const create = levelThree?.apis[0];
    const upload = levelThree?.apis[1];
    const graph = levelThree?.apis[2];
    expect(create).toBeDefined();
    expect(upload).toBeDefined();
    expect(graph).toBeDefined();
    if (!create || !upload || !graph) throw new Error("Expected all nested API assets.");

    const request = create.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Expected an HTTP request.");
    expect(request.baseUrl).toBe("https://api.example.test");
    expect(request.path).toBe("/v1/accounts");
    expect(request.query).toHaveLength(1);
    expect(request.query[0]).toMatchObject({ kind: "inline", name: "limit", value: "5" });
    expect(request.auth).toMatchObject({ kind: "basic", username: "collection-user", password: { policy: "test-auto" } });
    expect(request.body).toMatchObject({ kind: "json" });
    if (request.body.kind !== "json") throw new Error("Expected a JSON body.");
    expect(request.body.content).toContain('"password":""');
    expect(request.body.content).toContain('"displayName":"Ada"');
    expect(create.contract.responses).toHaveLength(1);
    expect(create.contract.responses[0]).toMatchObject({ kind: "inline", status: "201" });
    expect(create.contract.responses[0]).toMatchObject({
      content: { "application/json": { examples: [{ kind: "inline", value: { id: 7, name: "Ada" } }] } },
    });

    expect(upload.contract.request).toMatchObject({ protocol: "http", body: { kind: "multipart" } });
    expect(upload.documentation).toContain("Choose the profile image.");
    expect(graph.contract.request).toMatchObject({ body: { kind: "graphql", variables: "" } });
    expect(JSON.stringify(imported)).not.toContain("synthetic-import-token");
    expect(JSON.stringify(imported)).not.toContain("script-origin-secret");
    expect(JSON.stringify(imported)).not.toContain("collection-password-secret");
    expect(JSON.stringify(imported)).not.toContain("graphql-password-secret");
    expect(JSON.stringify(imported)).not.toContain("auth-extension-value");
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCRIPT_EVENT_NOT_IMPORTED", ownerId: create.contract.id, path: expect.stringContaining("event") }),
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: create.contract.id, path: expect.stringContaining("Authorization") }),
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: create.contract.id, path: expect.stringContaining("password") }),
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: create.contract.id, path: expect.stringContaining("basic.password") }),
      expect.objectContaining({ code: "URL_FRAGMENT_OMITTED", ownerId: create.contract.id, path: expect.stringContaining("url") }),
      expect.objectContaining({ code: "BODY_CREDENTIAL_SCAN_LIMITED", ownerId: graph.contract.id, path: expect.stringContaining("graphql.variables") }),
      expect.objectContaining({ code: "AUTH_FIELD_UNSUPPORTED", ownerId: create.contract.id, path: expect.stringContaining("auth/extension") }),
    ]));
  });

  it("removes URL userinfo and creates an unbound Basic ref when no auth binding was selected", () => {
    const imported = parseContractCollection21({
      info: { name: "URL userinfo fixture", schema: "https://example.test/collection/v2.1" },
      item: [{
        name: "userinfo request",
        request: { method: "GET", url: "https://review-user:review-url-secret@example.test:8443/v1/{{itemId}}?limit={{limit}}" },
      }],
    });
    const asset = imported.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the URL-userinfo API asset.");
    const request = asset.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Expected an HTTP request.");

    expect(request.baseUrl).toBe("https://example.test:8443");
    expect(request.path).toBe("/v1/{{itemId}}");
    expect(request.query).toMatchObject([{ kind: "inline", name: "limit", value: "{{limit}}" }]);
    expect(request.auth).toMatchObject({ kind: "basic", username: "", password: { policy: "test-auto" } });
    const serialized = JSON.stringify(imported);
    expect(serialized).not.toContain("review-user");
    expect(serialized).not.toContain("review-url-secret");
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: asset.contract.id, path: expect.stringContaining("userinfo.username") }),
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: asset.contract.id, path: expect.stringContaining("userinfo.password") }),
    ]));
  });

  it("keeps explicit Bearer auth selected when URL userinfo is also present", () => {
    const imported = parseContractCollection21({
      info: { name: "Explicit auth conflict fixture", schema: "https://example.test/collection/v2.1" },
      item: [{
        name: "bearer request",
        request: {
          method: "GET",
          url: "https://url-user:url-password@example.test/v1/items",
          auth: { type: "bearer", bearer: [{ key: "token", value: "explicit-bearer-token" }] },
        },
      }],
    });
    const asset = imported.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the explicit-auth API asset.");
    const request = asset.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Expected an HTTP request.");

    expect(request.baseUrl).toBe("https://example.test");
    expect(request.auth).toMatchObject({ kind: "bearer", token: { policy: "test-auto" } });
    const serialized = JSON.stringify(imported);
    for (const value of ["url-user", "url-password", "explicit-bearer-token"]) expect(serialized).not.toContain(value);
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "AUTH_BINDING_CONFLICT", ownerId: asset.contract.id, path: expect.stringContaining("userinfo") }),
    ]));
  });

  it("preserves explicit noauth when URL userinfo is removed", () => {
    const imported = parseContractCollection21({
      info: { name: "No-auth conflict fixture", schema: "https://example.test/collection/v2.1" },
      item: [{
        name: "noauth request",
        request: { method: "GET", url: "https://url-user:url-password@example.test/v1/items", auth: { type: "noauth" } },
      }],
    });
    const asset = imported.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the explicit-noauth API asset.");

    expect(asset.contract.request.auth).toEqual({ kind: "none" });
    const serialized = JSON.stringify(imported);
    expect(serialized).not.toContain("url-user");
    expect(serialized).not.toContain("url-password");
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "AUTH_BINDING_CONFLICT", ownerId: asset.contract.id, path: expect.stringContaining("userinfo") }),
    ]));
  });

  it("preserves an explicit port when rebuilding a structured URL without raw", () => {
    const imported = parseContractCollection21({
      info: { name: "Structured port fixture", schema: "https://example.test/collection/v2.1" },
      item: [{
        name: "Port request",
        request: {
          method: "GET",
          url: {
            protocol: "http",
            host: ["example", "test"],
            port: "8080",
            path: ["v1", "items"],
            query: [{ key: "limit", value: "5" }],
          },
        },
      }],
    });
    const asset = imported.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the structured URL API asset.");
    const request = asset.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Expected an HTTP request.");
    expect(request.baseUrl).toBe("http://example.test:8080");
    expect(request.path).toBe("/v1/items");
    expect(request.query).toMatchObject([{ kind: "inline", name: "limit", value: "5" }]);
    expect(imported.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COLLECTION_URL_FIELD_UNSUPPORTED", path: expect.stringContaining("port") }),
    ]));
  });
});
