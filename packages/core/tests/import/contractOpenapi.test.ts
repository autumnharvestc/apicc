import { describe, expect, it } from "vitest";

import { parseContractOpenapi } from "../../src/import/contractOpenapi.js";

describe("parseContractOpenapi", () => {
  it("represents OpenAPI 2 formData file fields as unbound multipart inputs", () => {
    const imported = parseContractOpenapi({
      swagger: "2.0",
      info: { title: "File form field", version: "1" },
      host: "upload.example.test",
      schemes: ["https"],
      paths: {
        "/upload": {
          post: {
            consumes: ["multipart/form-data"],
            parameters: [{ name: "attachment", in: "formData", type: "file", required: true }],
            responses: { "200": { description: "uploaded" } },
          },
        },
      },
    });
    const asset = imported.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected a Swagger 2 file-upload API asset.");
    expect(asset.contract.request).toMatchObject({
      protocol: "http",
      body: { kind: "multipart", entries: [{ kind: "file", name: "attachment", file: { path: "" }, enabled: true }] },
    });
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REQUEST_FILE_NOT_BOUND", ownerId: asset.contract.id, path: "request.formData/attachment" }),
    ]));
  });

  it("keeps request path and query separate, retains server prefixes, schemas, responses and local component references", () => {
    const imported = parseContractOpenapi({
      openapi: "3.0.3",
      info: { title: "Pet API", version: "2.4.0" },
      servers: [{ url: "https://api.example.test/v2" }],
      paths: {
        "/pets/{petId}": {
          put: {
            operationId: "updatePet",
            parameters: [
              { name: "petId", in: "path", required: true, schema: { type: "integer" } },
              { $ref: "#/components/parameters/Limit" },
            ],
            requestBody: {
              description: "The JSON payload.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
            security: [{ Token: [] }],
            externalDocs: { url: "https://docs.example.test/update" },
            responses: {
              "200": {
                description: "updated",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Pet" },
                    examples: { sample: { $ref: "#/components/examples/PetSample" } },
                  },
                },
              },
              "404": { $ref: "#/components/responses/NotFound" },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: {
            type: "object",
            properties: {
              id: { type: "integer" },
              friend: { $ref: "#/components/schemas/Pet" },
              owner: { $ref: "#/components/schemas/Owner" },
              remote: { $ref: "https://schemas.example.test/remote.json" },
            },
            required: ["id"],
            "x-vendor-shape": "ignored-with-diagnostic",
          },
          Owner: { type: "object", properties: { name: { type: "string" } } },
        },
        parameters: {
          Limit: { name: "limit", in: "query", schema: { type: "integer", default: 20, example: 3 } },
        },
        securitySchemes: {
          Token: { type: "http", scheme: "bearer", example: "synthetic-import-token" },
        },
        responses: {
          NotFound: { description: "missing", content: { "application/json": { schema: { type: "string" } } } },
        },
        examples: {
          PetSample: { summary: "pet", value: { id: 7, name: "Milo" } },
        },
      },
    });

    const asset = imported.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected one imported API asset.");
    const request = asset.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Expected an HTTP request.");

    expect(request.baseUrl).toBe("https://api.example.test/v2");
    expect(request.path).toBe("/pets/{petId}");
    expect(request.pathParams).toHaveLength(1);
    expect(request.query).toHaveLength(1);
    expect(request.body).toMatchObject({ kind: "json", content: "" });
    expect(request.query[0]).toMatchObject({ kind: "componentRef", expectedKind: "parameter" });
    expect("value" in request.query[0] ? request.query[0].value : undefined).toBeUndefined();
    expect(asset.contract.responses).toHaveLength(2);
    expect(asset.contract.responses[1]).toMatchObject({ kind: "componentRef", expectedKind: "response" });

    const kinds = imported.project.components.map((component) => component.kind);
    expect(kinds).toEqual(expect.arrayContaining(["parameter", "auth", "response", "example"]));
    expect(request.auth).toMatchObject({ kind: "componentRef", expectedKind: "auth" });

    const pet = imported.project.models.find((model) => model.name === "Pet");
    expect(pet?.schema).toMatchObject({ kind: "object" });
    if (pet?.schema.kind !== "object") throw new Error("Expected the Pet model to be an object schema.");
    expect(pet.schema.properties.friend).toMatchObject({ kind: "modelRef", modelId: pet.id });

    expect(JSON.stringify(imported)).not.toContain("synthetic-import-token");
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_EXTERNAL_REFERENCE_UNSUPPORTED", ownerId: expect.any(String), path: expect.stringContaining("remote") }),
      expect.objectContaining({ code: "SCHEMA_KEYWORD_UNKNOWN", ownerId: expect.any(String), path: expect.stringContaining("x-vendor-shape") }),
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: expect.any(String), path: expect.stringContaining("Token/example") }),
      expect.objectContaining({ code: "RESPONSE_REFERENCE_STATUS_UNREPRESENTED", ownerId: asset.contract.id, path: expect.stringContaining("404") }),
      expect.objectContaining({ code: "REQUEST_BODY_FIELD_UNSUPPORTED", ownerId: asset.contract.id, path: expect.stringContaining("requestBody/description") }),
      expect.objectContaining({ code: "OPENAPI_OPERATION_FIELD_UNSUPPORTED", ownerId: asset.contract.id, path: expect.stringContaining("externalDocs") }),
    ]));
  });

  it("imports OpenAPI 2 body parameters and basePath while reporting pure model alias cycles", () => {
    const imported = parseContractOpenapi({
      swagger: "2.0",
      info: { title: "Legacy API", version: "1.2" },
      host: "legacy.example.test",
      basePath: "/gateway/v1",
      schemes: ["https"],
      consumes: ["application/json"],
      produces: ["application/json"],
      paths: {
        "/pets/{id}": {
          post: {
            parameters: [
              { name: "id", in: "path", required: true, type: "string" },
              { name: "page", in: "query", type: "integer", default: 1, example: 4 },
              { name: "payload", in: "body", required: true, schema: { $ref: "#/definitions/Pet" } },
              { $ref: "#/parameters/Trace" },
            ],
            security: [{ ApiKey: [] }],
            responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } } },
          },
        },
      },
      definitions: {
        Pet: { type: "object", properties: { next: { $ref: "#/definitions/Pet" } } },
        AliasA: { $ref: "#/definitions/AliasB" },
        AliasB: { $ref: "#/definitions/AliasA" },
      },
      parameters: { Trace: { name: "X-Trace", in: "header", type: "string" } },
      responses: { NotFound: { description: "missing", schema: { type: "string" } } },
      securityDefinitions: { ApiKey: { type: "apiKey", name: "X-API-Key", in: "header" } },
    });

    const asset = imported.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected a Swagger 2 API asset.");
    const request = asset.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Expected an HTTP request.");
    expect(request.baseUrl).toBe("https://legacy.example.test/gateway/v1");
    expect(request.path).toBe("/pets/{id}");
    expect(request.pathParams).toHaveLength(1);
    expect(request.query).toHaveLength(1);
    expect(request.query[0]).toMatchObject({ kind: "inline", name: "page", schema: { kind: "scalar", type: "integer", default: 1, examples: [4] } });
    expect("value" in request.query[0] ? request.query[0].value : undefined).toBeUndefined();
    expect(request.headers).toHaveLength(1);
    expect(request.headers[0]).toMatchObject({ kind: "componentRef", expectedKind: "parameter" });
    expect(request.body).toMatchObject({ kind: "json", content: "", schema: { kind: "modelRef" } });
    expect(request.auth).toMatchObject({ kind: "componentRef", expectedKind: "auth" });
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ASSET_MODEL_REFERENCE_CYCLE", ownerId: expect.any(String), path: expect.stringContaining("schema.modelId") }),
      expect.objectContaining({ code: "REQUEST_BODY_REQUIRED_UNREPRESENTED", ownerId: asset.contract.id, path: expect.stringContaining("parameters/2/required") }),
    ]));
  });

  it("strips nested credentials from Schema annotations while retaining other design values", () => {
    const imported = parseContractOpenapi({
      openapi: "3.0.3",
      info: { title: "Schema annotation fixture", version: "1" },
      paths: {},
      components: {
        schemas: {
          Payload: {
            type: "object",
            default: { profile: { password: "schema-default-password", displayName: "Ada" }, sessions: [{ token: "schema-default-token", id: 1 }] },
            examples: [{ profile: { client_secret: "schema-example-secret", label: "primary" }, credentials: [{ api_key: "schema-example-key", enabled: true }] }],
            enum: [{ access_token: "schema-enum-token", status: "ready" }],
          },
        },
      },
    });
    const model = imported.project.models.find((candidate) => candidate.name === "Payload");
    expect(model).toBeDefined();
    if (!model) throw new Error("Expected the Payload schema model.");

    expect(model.schema.default).toEqual({ profile: { password: "", displayName: "Ada" }, sessions: [{ token: "", id: 1 }] });
    expect(model.schema.examples).toEqual([{ profile: { client_secret: "", label: "primary" }, credentials: [{ api_key: "", enabled: true }] }]);
    expect(model.schema.enum).toEqual([{ access_token: "", status: "ready" }]);
    const serialized = JSON.stringify(imported);
    for (const value of ["schema-default-password", "schema-default-token", "schema-example-secret", "schema-example-key", "schema-enum-token"]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).toContain("Ada");
    expect(serialized).toContain("ready");
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: model.id, path: "models.Payload.schema/default/profile.password" }),
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: model.id, path: "models.Payload.schema/default/sessions[0].token" }),
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: model.id, path: "models.Payload.schema/examples/0/profile.client_secret" }),
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: model.id, path: "models.Payload.schema/examples/0/credentials[0].api_key" }),
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: model.id, path: "models.Payload.schema/enum/0/access_token" }),
    ]));
  });

  it("retains same-level type, properties, items, and composition keywords together", () => {
    const imported = parseContractOpenapi({
      openapi: "3.0.3",
      info: { title: "Composition fixture", version: "1" },
      paths: {},
      components: {
        schemas: {
          Base: { type: "object", properties: { baseField: { type: "string" } } },
          CompositeObject: {
            type: "object",
            properties: { ownField: { type: "integer" } },
            allOf: [{ $ref: "#/components/schemas/Base" }],
          },
          MixedArray: {
            type: "array",
            items: { oneOf: [{ type: "string" }, { type: "integer" }] },
            anyOf: [{ type: "null" }],
          },
          MultipleCompositions: {
            type: "string",
            allOf: [{ type: "string", minLength: 2 }],
            oneOf: [{ type: "number" }, { type: "integer" }],
            anyOf: [{ type: "boolean" }],
          },
        },
      },
    });
    const models = new Map(imported.project.models.map((model) => [model.name, model]));
    const base = models.get("Base");
    const composite = models.get("CompositeObject")?.schema;
    const mixedArray = models.get("MixedArray")?.schema;
    const multiple = models.get("MultipleCompositions")?.schema;

    expect(composite?.kind).toBe("allOf");
    if (composite?.kind !== "allOf") throw new Error("Expected the type-plus-allOf schema to retain both structures.");
    expect(composite.variants).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "object", properties: { ownField: { kind: "scalar", type: "integer" } } }),
      expect.objectContaining({ kind: "modelRef", modelId: base?.id }),
    ]));
    expect(mixedArray?.kind).toBe("allOf");
    if (mixedArray?.kind !== "allOf") throw new Error("Expected array-plus-anyOf composition to retain both structures.");
    expect(mixedArray.variants).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "array", items: { kind: "oneOf", variants: [{ kind: "scalar", type: "string" }, { kind: "scalar", type: "integer" }] } }),
      expect.objectContaining({ kind: "anyOf", variants: [{ kind: "scalar", type: "null" }] }),
    ]));
    expect(multiple?.kind).toBe("allOf");
    if (multiple?.kind !== "allOf") throw new Error("Expected all same-level composition keywords to be retained.");
    expect(multiple.variants.map((variant) => variant.kind)).toEqual(["scalar", "scalar", "oneOf", "anyOf"]);
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_KEYWORD_UNSUPPORTED", ownerId: models.get("MultipleCompositions")?.id, path: expect.stringContaining("allOf/0/minLength") }),
    ]));
  });

  it("does not infer a string shape from untyped required or additionalProperties composition siblings", () => {
    const imported = parseContractOpenapi({
      openapi: "3.0.3",
      info: { title: "Untyped composition fixture", version: "1" },
      paths: {},
      components: {
        schemas: {
          Base: { type: "object", properties: { id: { type: "string" } } },
          RequiredOnly: { allOf: [{ $ref: "#/components/schemas/Base" }], required: ["id"] },
          AdditionalOnly: { allOf: [{ $ref: "#/components/schemas/Base" }], additionalProperties: true },
          UntypedMulti: {
            oneOf: [{ $ref: "#/components/schemas/Base" }, { type: "null" }],
            anyOf: [{ type: "object", properties: { label: { type: "string" } } }],
            required: ["id"],
            additionalProperties: true,
          },
        },
      },
    });
    const models = new Map(imported.project.models.map((model) => [model.name, model]));
    const base = models.get("Base");
    const requiredOnly = models.get("RequiredOnly");
    const additionalOnly = models.get("AdditionalOnly");
    const untypedMulti = models.get("UntypedMulti");
    expect(base?.schema.kind).toBe("object");
    expect(requiredOnly?.schema).toEqual({ kind: "allOf", variants: [{ kind: "modelRef", modelId: base?.id }] });
    expect(additionalOnly?.schema).toEqual({ kind: "allOf", variants: [{ kind: "modelRef", modelId: base?.id }] });
    expect(untypedMulti?.schema.kind).toBe("allOf");
    if (untypedMulti?.schema.kind !== "allOf") throw new Error("Expected all same-level untyped compositions to remain represented.");
    expect(untypedMulti.schema.variants.map((variant) => variant.kind)).toEqual(["oneOf", "anyOf"]);
    expect(JSON.stringify([requiredOnly?.schema, additionalOnly?.schema])).not.toContain('"type":"string"');
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_KEYWORD_UNSUPPORTED", ownerId: requiredOnly?.id, path: "models.RequiredOnly.schema/required" }),
      expect.objectContaining({ code: "SCHEMA_KEYWORD_UNSUPPORTED", ownerId: additionalOnly?.id, path: "models.AdditionalOnly.schema/additionalProperties" }),
      expect.objectContaining({ code: "SCHEMA_KEYWORD_UNSUPPORTED", ownerId: untypedMulti?.id, path: "models.UntypedMulti.schema/required" }),
      expect.objectContaining({ code: "SCHEMA_KEYWORD_UNSUPPORTED", ownerId: untypedMulti?.id, path: "models.UntypedMulti.schema/additionalProperties" }),
    ]));
  });

  it("diagnoses discarded request media, response header, and response media fields at their source paths", () => {
    const imported = parseContractOpenapi({
      openapi: "3.0.3",
      info: { title: "Media field fixture", version: "1" },
      paths: {
        "/items": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { displayName: { type: "string" } } },
                  example: { displayName: "request-only-Ada" },
                  examples: { remote: { $ref: "https://examples.example.test/request.json" } },
                  encoding: { upload: { $ref: "https://examples.example.test/encoding.json" } },
                  "x-request-unknown": true,
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                headers: {
                  "X-Rate": {
                    description: "remaining calls",
                    required: false,
                    schema: { type: "integer" },
                    example: 5,
                    $ref: "https://headers.example.test/rate.json",
                  },
                },
                content: {
                  "application/json": {
                    schema: { type: "object" },
                    example: { result: "visible-response-example" },
                    examples: { remote: { $ref: "https://examples.example.test/response.json" } },
                    encoding: { upload: { $ref: "https://examples.example.test/response-encoding.json" } },
                    headers: { "X-Internal": { schema: { type: "string" } } },
                    extensions: { $ref: "https://examples.example.test/extensions.json" },
                    "x-response-unknown": true,
                  },
                },
              },
            },
          },
        },
      },
    });
    const asset = imported.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the request/response media fixture asset.");
    const request = asset.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Expected the OpenAPI HTTP request.");
    expect(request.body).toMatchObject({ kind: "json", content: "", schema: { kind: "object" } });
    expect(JSON.stringify(request.body)).not.toContain("request-only-Ada");
    expect(JSON.stringify(asset.contract.responses)).toContain("visible-response-example");
    const diagnosticPaths = imported.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.path}`);
    for (const path of [
      "REQUEST_BODY_MEDIA_FIELD_UNSUPPORTED:requestBody/content/application/json/example",
      "REQUEST_BODY_MEDIA_FIELD_UNSUPPORTED:requestBody/content/application/json/examples",
      "REQUEST_BODY_MEDIA_FIELD_UNSUPPORTED:requestBody/content/application/json/encoding",
      "REQUEST_BODY_MEDIA_FIELD_UNSUPPORTED:requestBody/content/application/json/x-request-unknown",
      "OPENAPI_EXTERNAL_REFERENCE_UNSUPPORTED:requestBody/content/application/json/examples/remote/$ref",
      "OPENAPI_EXTERNAL_REFERENCE_UNSUPPORTED:requestBody/content/application/json/encoding/upload/$ref",
      "RESPONSE_HEADER_FIELD_UNSUPPORTED:paths./items/post/responses/200/headers/X-Rate/schema",
      "RESPONSE_HEADER_FIELD_UNSUPPORTED:paths./items/post/responses/200/headers/X-Rate/example",
      "RESPONSE_HEADER_REFERENCE_UNSUPPORTED:paths./items/post/responses/200/headers/X-Rate/$ref",
      "RESPONSE_MEDIA_FIELD_UNSUPPORTED:paths./items/post/responses/200/content/application/json/encoding",
      "RESPONSE_MEDIA_FIELD_UNSUPPORTED:paths./items/post/responses/200/content/application/json/headers",
      "RESPONSE_MEDIA_FIELD_UNSUPPORTED:paths./items/post/responses/200/content/application/json/extensions",
      "RESPONSE_MEDIA_FIELD_UNSUPPORTED:paths./items/post/responses/200/content/application/json/x-response-unknown",
      "EXAMPLE_EXTERNAL_REFERENCE_UNSUPPORTED:paths./items/post/responses/200/content/application/json/examples/remote/$ref",
      "OPENAPI_EXTERNAL_REFERENCE_UNSUPPORTED:paths./items/post/responses/200/content/application/json/encoding/upload/$ref",
    ]) expect(diagnosticPaths).toContain(path);
    expect(asset.contract.responses[0]).toMatchObject({ headers: { "X-Rate": "remaining calls" } });
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RESPONSE_HEADER_REFERENCE_UNSUPPORTED", ownerId: asset.contract.id, path: "paths./items/post/responses/200/headers/X-Rate/$ref" }),
    ]));
  });

  it("resolves local example component alias chains and diagnoses cycles or unsupported refs", () => {
    const imported = parseContractOpenapi({
      openapi: "3.0.3",
      info: { title: "Example alias fixture", version: "1" },
      paths: {
        "/items": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    examples: {
                      first: { $ref: "#/components/examples/Alias" },
                      second: { $ref: "#/components/examples/SecondHop" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        examples: {
          Base: { summary: "base", value: { id: 1, status: "ready" } },
          Alias: { $ref: "#/components/examples/Base" },
          SecondHop: { $ref: "#/components/examples/Alias" },
          CycleA: { $ref: "#/components/examples/CycleB" },
          CycleB: { $ref: "#/components/examples/CycleA" },
          Missing: { $ref: "#/components/examples/Ghost" },
          Remote: { $ref: "https://examples.example.test/remote.json" },
        },
      },
    });
    const examples = new Map(imported.project.components.filter((component) => component.kind === "example").map((component) => [component.name, component]));
    for (const name of ["Base", "Alias", "SecondHop"]) {
      const component = examples.get(name);
      expect(component?.kind).toBe("example");
      if (component?.kind !== "example") throw new Error(`Expected ${name} example component.`);
      expect(component.definition.value).toEqual({ id: 1, status: "ready" });
    }
    const asset = imported.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected an operation referencing the aliased examples.");
    const examplesOut = asset.contract.responses[0]?.kind === "inline" ? asset.contract.responses[0].content["application/json"]?.examples : undefined;
    expect(examplesOut).toEqual([
      expect.objectContaining({ kind: "componentRef", componentId: examples.get("Alias")?.id }),
      expect.objectContaining({ kind: "componentRef", componentId: examples.get("SecondHop")?.id }),
    ]);
    expect(examples.get("Missing")).toMatchObject({ kind: "example", definition: { value: null } });
    expect(examples.get("Remote")).toMatchObject({ kind: "example", definition: { value: null } });
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "EXAMPLE_COMPONENT_ALIAS_CYCLE", ownerId: examples.get("CycleA")?.id, path: "components.examples.CycleA/$ref" }),
      expect.objectContaining({ code: "EXAMPLE_REFERENCE_UNRESOLVED", ownerId: examples.get("Missing")?.id, path: "components.examples.Missing/$ref" }),
      expect.objectContaining({ code: "EXAMPLE_EXTERNAL_REFERENCE_UNSUPPORTED", ownerId: examples.get("Remote")?.id, path: "components.examples.Remote/$ref" }),
    ]));
  });

  it("strips OpenAPI server URL userinfo and preserves selected security intent", () => {
    const imported = parseContractOpenapi({
      openapi: "3.0.3",
      info: { title: "Server userinfo fixture", version: "1" },
      servers: [{ url: "https://review-user:review-password@example.test:8443/v1" }],
      paths: {
        "/no-auth": { get: { responses: { "200": { description: "ok" } } } },
        "/bearer": { get: { security: [{ Token: [] }], responses: { "200": { description: "ok" } } } },
        "/explicit-none": { get: { security: [], responses: { "200": { description: "ok" } } } },
      },
      components: { securitySchemes: { Token: { type: "http", scheme: "bearer" } } },
    });
    const assets = new Map(imported.project.collections[0]?.apis.map((asset) => [asset.contract.request.path, asset]));
    const noAuth = assets.get("/no-auth");
    const bearer = assets.get("/bearer");
    const explicitNone = assets.get("/explicit-none");
    expect(noAuth).toBeDefined();
    expect(bearer).toBeDefined();
    expect(explicitNone).toBeDefined();
    if (!noAuth || !bearer || !explicitNone) throw new Error("Expected all server-userinfo operations.");

    expect(noAuth.contract.request.baseUrl).toBe("https://example.test:8443/v1");
    expect(noAuth.contract.request.auth).toMatchObject({ kind: "basic", username: "", password: { policy: "test-auto" } });
    expect(bearer.contract.request.auth).toMatchObject({ kind: "componentRef", expectedKind: "auth" });
    expect(explicitNone.contract.request.auth).toEqual({ kind: "none" });
    const serialized = JSON.stringify(imported);
    expect(serialized).not.toContain("review-user");
    expect(serialized).not.toContain("review-password");
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: noAuth.contract.id, path: "servers/0/url/userinfo.username" }),
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: noAuth.contract.id, path: "servers/0/url/userinfo.password" }),
      expect.objectContaining({ code: "AUTH_BINDING_CONFLICT", ownerId: bearer.contract.id, path: "servers/0/url/userinfo" }),
      expect.objectContaining({ code: "AUTH_BINDING_CONFLICT", ownerId: explicitNone.contract.id, path: "servers/0/url/userinfo" }),
    ]));
  });
});
