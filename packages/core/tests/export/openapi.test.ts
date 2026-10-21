import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ParameterBinding } from "../../src/contract/model.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import { DocumentDiagnosticSchema } from "../../src/design/projection.js";
import type { DocumentDiagnostic, DocumentScope } from "../../src/design/projection.js";
import { parseContractOpenapi } from "../../src/import/contractOpenapi.js";
import { createContractExecutionProject, contractExecutionIds } from "../helpers/contractExecutionFixtures.js";

interface OpenapiExportResult {
  document: Record<string, unknown>;
  diagnostics: DocumentDiagnostic[];
  blocked: boolean;
}

type OpenapiExporter = (
  snapshot: ProjectSnapshot,
  scope: DocumentScope,
  options: { version: "3.0" | "3.1"; infoVersion?: string; allowLossy: boolean },
) => OpenapiExportResult;

function inlineParameter(binding: ParameterBinding): Extract<ParameterBinding, { kind: "inline" }> {
  if (binding.kind !== "inline") throw new Error("Expected inline request parameter.");
  return binding;
}

const modelId = "20000000-0000-4000-8000-000000000001";
const secretRefId = "openapi-test-secret-ref-should-never-leak";
const secretValue = "openapi-test-secret-value-should-never-leak";
const localBodyPath = "C:\\Users\\test\\private-body.json";

function makeOpenapiProject(): ContractProject {
  const project = createContractExecutionProject("https://api.example.test/v1");
  project.name = "OpenAPI roundtrip fixture";
  const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
  asset.contract.metadata = {
    name: "read-item",
    description: "Read a public item.",
    tags: ["items"],
    version: "2.4.0",
    status: "published",
  };
  const request = asset.contract.request;
  if (request.protocol !== "http") throw new Error("HTTP fixture required");
  request.method = "GET";
  request.baseUrl = "https://api.example.test/v1";
  request.path = "/items/{itemId}";
  request.pathParams = [{
    kind: "inline", id: "20000000-0000-4000-8000-000000000002", name: "itemId",
    schema: { kind: "scalar", type: "integer" }, required: true, enabled: true, description: "Item identifier",
  }];
  request.query = [{
    kind: "inline", id: "20000000-0000-4000-8000-000000000003", name: "include",
    schema: { kind: "scalar", type: "string", enum: ["owner", "history"] }, required: false, enabled: true, description: "Related data",
    value: secretValue,
  }];
  request.headers = [{
    kind: "inline", id: "20000000-0000-4000-8000-000000000004", name: "X-Trace",
    schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "Trace ID",
  }];
  request.cookies = [{
    kind: "inline", id: "20000000-0000-4000-8000-000000000005", name: "session",
    schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "Session cookie",
    value: secretValue,
  }];
  request.auth = { kind: "bearer", token: { id: secretRefId, policy: "test" } };
  request.body = { kind: "json", content: "", schema: { kind: "modelRef", modelId } };
  asset.contract.responses = [
    {
      kind: "inline", id: "20000000-0000-4000-8000-000000000006", status: "200", description: "Item found",
      headers: { "X-RateLimit": "Remaining requests" },
      content: {
        "application/json": {
          schema: { kind: "modelRef", modelId },
          examples: [{ kind: "inline", id: "20000000-0000-4000-8000-000000000007", name: "found", value: { id: 7, name: "Ada" } }],
        },
      },
    },
    {
      kind: "inline", id: "20000000-0000-4000-8000-000000000008", status: "404", description: "Item missing",
      headers: {},
      content: { "text/plain": { schema: { kind: "scalar", type: "string" }, examples: [] } },
    },
  ];
  asset.cases = [];
  project.models = [{
    formatVersion: 1,
    id: modelId,
    name: "Item",
    description: "An item model.",
    schema: {
      kind: "object",
      properties: { id: { kind: "scalar", type: "integer" }, name: { kind: "scalar", type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  }];
  return project;
}

async function getExporter(): Promise<OpenapiExporter> {
  const core = await import("../../src/index.js") as unknown as { exportOpenapi?: OpenapiExporter };
  expect(core.exportOpenapi).toBeTypeOf("function");
  if (typeof core.exportOpenapi !== "function") throw new Error("exportOpenapi is unavailable");
  return core.exportOpenapi;
}

describe("exportOpenapi", () => {
  it.each(["dataset", "suite"] as const)("warns when a project contains only local %s assets and omits their data", async (kind) => {
    const exportOpenapi = await getExporter();
    const project = makeOpenapiProject();
    project.workflows = [];
    delete project.mock;
    const marker = `local-${kind}-asset-only`;
    if (kind === "dataset") project.datasets = [{ formatVersion: 1, id: "20000000-0000-4000-8000-000000000080", name: marker, columns: ["value"], rows: [{ value: marker }] }];
    else project.suites = [{ formatVersion: 1, id: "20000000-0000-4000-8000-000000000081", name: marker, tags: [marker], selection: { kind: "query" }, failFast: false, reporters: ["html"] }];
    const result = exportOpenapi(createProjectSnapshot(project), { kind: "project" }, { version: "3.1", allowLossy: false });
    expect(result.blocked).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "OPENAPI_LOCAL_EXECUTION_DATA_OMITTED", severity: "warning", path: "project", message: expect.stringMatching(kind === "dataset" ? /datasets/i : /suites/i), lossy: false }));
    expect(JSON.stringify(result.document)).not.toContain(marker);
    expect(stringifyYaml(result.document)).not.toContain(marker);
  });
  it.each([
    ["3.0", "3.0.3"],
    ["3.1", "3.1.0"],
  ] as const)("roundtrips the supported contract subset for OpenAPI %s through JSON and YAML", async (version, expectedOpenapi) => {
    const exportOpenapi = await getExporter();
    const snapshot = createProjectSnapshot(makeOpenapiProject());
    const result = exportOpenapi(snapshot, { kind: "project" }, { version, allowLossy: false });

    expect(result.blocked).toBe(false);
    expect(result.document.openapi).toBe(expectedOpenapi);
    expect((result.document.info as Record<string, unknown>).version).toBe("2.4.0");
    expect((result.document.paths as Record<string, unknown>)["/items/{itemId}"]).toBeDefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "OPENAPI_LOCAL_EXECUTION_DATA_OMITTED", path: "project", severity: "warning", lossy: false,
    }));
    for (const diagnostic of result.diagnostics) {
      expect(DocumentDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
    }

    for (const serialized of [JSON.stringify(result.document), stringifyYaml(result.document)]) {
      const parsedDocument = serialized.startsWith("{") ? JSON.parse(serialized) : parseYaml(serialized);
      const imported = parseContractOpenapi(parsedDocument);
      const importedAsset = imported.project.collections[0]!.apis[0]!;
      const importedRequest = importedAsset.contract.request;
      expect(importedRequest.protocol).toBe("http");
      if (importedRequest.protocol !== "http") throw new Error("Expected the imported request to remain HTTP.");
      expect(importedRequest.method).toBe("GET");
      expect(importedRequest.path).toBe("/items/{itemId}");
      expect(importedRequest.pathParams.map((binding) => {
        const parameter = inlineParameter(binding);
        return { name: parameter.name, required: parameter.required };
      })).toEqual([{ name: "itemId", required: true }]);
      expect(importedRequest.query.map((binding) => inlineParameter(binding).name)).toEqual(["include"]);
      expect(importedRequest.headers.map((binding) => inlineParameter(binding).name)).toEqual(["X-Trace"]);
      expect(importedRequest.cookies.map((binding) => inlineParameter(binding).name)).toEqual(["session"]);
      expect(importedRequest.query[0]).toMatchObject({ name: "include", required: false, schema: { kind: "scalar", type: "string", enum: ["owner", "history"] } });
      expect(importedRequest.headers[0]).toMatchObject({ name: "X-Trace", required: false, schema: { kind: "scalar", type: "string" } });
      expect(importedRequest.cookies[0]).toMatchObject({ name: "session", required: false, schema: { kind: "scalar", type: "string" } });
      const importedAuth = importedRequest.auth;
      expect(importedAuth.kind).toBe("componentRef");
      if (importedAuth.kind !== "componentRef") throw new Error("Expected the declared bearer scheme to roundtrip as a component reference.");
      const authComponent = imported.project.components.find((component) => component.id === importedAuth.componentId);
      expect(authComponent).toMatchObject({ kind: "auth", definition: { kind: "bearer" } });
      expect(importedRequest.body.kind).toBe("json");
      if (importedRequest.body.kind !== "json") throw new Error("Expected a JSON request body.");
      const bodySchema = importedRequest.body.schema;
      if (bodySchema?.kind !== "modelRef") throw new Error("Expected the request body schema to reference Item.");
      const importedModel = imported.project.models.find((model) => model.id === bodySchema.modelId);
      expect(importedModel).toMatchObject({
        name: "Item",
        schema: {
          kind: "object",
          required: ["id"],
          properties: { id: { kind: "scalar", type: "integer" }, name: { kind: "scalar", type: "string" } },
          additionalProperties: false,
        },
      });
      expect(importedAsset.contract.responses.map((binding) => {
        if (binding.kind !== "inline") throw new Error("Expected inline response.");
        return binding.status;
      })).toEqual(["200", "404"]);
      const importedSuccess = importedAsset.contract.responses[0]!;
      const importedMissing = importedAsset.contract.responses[1]!;
      if (importedSuccess.kind !== "inline" || importedMissing.kind !== "inline") throw new Error("Expected inline responses.");
      expect(importedSuccess.content["application/json"]?.schema).toMatchObject({ kind: "modelRef" });
      expect(importedSuccess.headers).toEqual({ "X-RateLimit": "Remaining requests" });
      expect(importedSuccess.content["application/json"]?.examples).toMatchObject([{ name: "found", value: { id: 7, name: "Ada" } }]);
      expect(importedMissing.content["text/plain"]?.schema).toMatchObject({ kind: "scalar", type: "string" });
      const serializedOutput = JSON.stringify(parsedDocument);
      expect(serializedOutput).not.toContain(secretRefId);
      expect(serializedOutput).not.toContain(secretValue);
      expect(JSON.stringify(result.diagnostics)).not.toContain(secretRefId);
    }
  });

  it("uses explicit info.version independently of the OpenAPI specification version", async () => {
    const exportOpenapi = await getExporter();
    const result = exportOpenapi(createProjectSnapshot(makeOpenapiProject()), { kind: "project" }, {
      version: "3.1", infoVersion: "9.7.1", allowLossy: false,
    });
    expect(result.document.openapi).toBe("3.1.0");
    expect((result.document.info as Record<string, unknown>).version).toBe("9.7.1");
  });

  it("keeps case-distinct query parameter names distinct", async () => {
    const exportOpenapi = await getExporter();
    const project = makeOpenapiProject();
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const request = asset.contract.request;
    if (request.protocol !== "http") throw new Error("HTTP fixture required");
    request.query.push(
      { kind: "inline", id: "20000000-0000-4000-8000-000000000010", name: "id", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "Lowercase id" },
      { kind: "inline", id: "20000000-0000-4000-8000-000000000011", name: "ID", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "Uppercase ID" },
    );

    const result = exportOpenapi(createProjectSnapshot(project), { kind: "project" }, { version: "3.1", allowLossy: false });
    const pathItem = (result.document.paths as Record<string, Record<string, unknown>>)["/items/{itemId}"]!;
    const operation = pathItem.get as Record<string, unknown>;
    const queryNames = (operation.parameters as Array<Record<string, unknown>>)
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name);

    expect(result.blocked).toBe(false);
    expect(queryNames).toEqual(["include", "id", "ID"]);
  });

  it("preserves annotations on OpenAPI 3.0 model references through a Schema Object wrapper", async () => {
    const exportOpenapi = await getExporter();
    const project = makeOpenapiProject();
    project.models[0]!.schema = { kind: "scalar", type: "string" };
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const request = asset.contract.request;
    if (request.protocol !== "http" || request.body.kind !== "json") throw new Error("JSON HTTP fixture required");
    request.body.schema = { kind: "modelRef", modelId, description: "Color label", enum: ["red"] };

    const result = exportOpenapi(createProjectSnapshot(project), { kind: "project" }, { version: "3.0", allowLossy: false });
    const pathItem = (result.document.paths as Record<string, Record<string, unknown>>)["/items/{itemId}"]!;
    const operation = pathItem.get as Record<string, unknown>;
    const requestBody = operation.requestBody as Record<string, unknown>;
    const content = requestBody.content as Record<string, Record<string, unknown>>;
    const schema = content["application/json"]!.schema as Record<string, unknown>;

    expect(result.blocked).toBe(false);
    expect(schema).toMatchObject({
      description: "Color label",
      enum: ["red"],
      allOf: [{ $ref: "#/components/schemas/Item" }],
    });
    expect(schema).not.toHaveProperty("$ref");
  });

  it("wraps an OpenAPI 3.0 root model alias when its asset description is added", async () => {
    const exportOpenapi = await getExporter();
    const project = makeOpenapiProject();
    const targetModelId = "20000000-0000-4000-8000-000000000012";
    project.models[0]!.schema = { kind: "modelRef", modelId: targetModelId };
    project.models[0]!.description = "Asset-only alias description";
    project.models.push({
      formatVersion: 1,
      id: targetModelId,
      name: "Target",
      description: "",
      schema: { kind: "scalar", type: "string" },
    });

    const result = exportOpenapi(createProjectSnapshot(project), { kind: "project" }, { version: "3.0", allowLossy: false });
    const components = result.document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, Record<string, unknown>>;

    expect(result.blocked).toBe(false);
    expect(schemas.Item).toMatchObject({
      description: "Asset-only alias description",
      allOf: [{ $ref: "#/components/schemas/Target" }],
    });
    expect(schemas.Item).not.toHaveProperty("$ref");
  });

  it("redacts schema annotations using their property or parameter field name", async () => {
    const exportOpenapi = await getExporter();
    const project = makeOpenapiProject();
    const modelSchema = project.models[0]!.schema;
    if (modelSchema.kind !== "object") throw new Error("Object model required");
    modelSchema.properties.password = {
      kind: "scalar",
      type: "string",
      default: "synthetic-sensitive-value",
      enum: ["synthetic-sensitive-value", "public"],
      examples: ["synthetic-sensitive-value"],
    };
    modelSchema.properties.quantity = { kind: "scalar", type: "integer", default: 7 };
    const request = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.request;
    if (request.protocol !== "http") throw new Error("HTTP fixture required");
    const parameter = inlineParameter(request.query[0]!);
    parameter.name = "access_token";
    parameter.schema = {
      kind: "scalar",
      type: "string",
      default: "synthetic-sensitive-value",
      enum: ["synthetic-sensitive-value", "public"],
      examples: ["synthetic-sensitive-value"],
    };

    const result = exportOpenapi(createProjectSnapshot(project), { kind: "project" }, { version: "3.1", allowLossy: false });
    const components = result.document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, Record<string, unknown>>;
    const itemProperties = schemas.Item!.properties as Record<string, Record<string, unknown>>;
    const operations = result.document.paths as Record<string, Record<string, unknown>>;
    const operation = operations["/items/{itemId}"]!.get as Record<string, unknown>;
    const parameters = operation.parameters as Array<Record<string, unknown>>;
    const credentialParameter = parameters.find((item) => item.name === "access_token")!;

    expect(result.blocked).toBe(false);
    expect(itemProperties.password).toMatchObject({
      default: "****",
      enum: ["****", "****"],
      examples: ["****"],
    });
    expect(itemProperties.quantity).toMatchObject({ default: 7 });
    expect(credentialParameter.schema).toMatchObject({
      default: "****",
      enum: ["****", "****"],
      examples: ["****"],
    });
  });

  it("blocks an empty selected scope and duplicate path-method pairs regardless of allowLossy", async () => {
    const exportOpenapi = await getExporter();
    const snapshot = createProjectSnapshot(makeOpenapiProject());
    const empty = exportOpenapi(snapshot, { kind: "apis", contractIds: [] }, {
      version: "3.1", infoVersion: "1", allowLossy: true,
    });
    expect(empty.blocked).toBe(true);
    expect(empty.diagnostics).toContainEqual(expect.objectContaining({ code: "OPENAPI_SCOPE_EMPTY", path: "scope", severity: "error", lossy: false }));

    const duplicate = makeOpenapiProject();
    const first = duplicate.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const second = structuredClone(first);
    second.contract.id = "20000000-0000-4000-8000-000000000009";
    second.contract.metadata.name = "same route";
    duplicate.collections[0]!.apis.push(second);
    const collision = exportOpenapi(createProjectSnapshot(duplicate), { kind: "project" }, {
      version: "3.1", infoVersion: "1", allowLossy: true,
    });
    expect(collision.blocked).toBe(true);
    expect(collision.diagnostics).toContainEqual(expect.objectContaining({ code: "OPENAPI_PATH_METHOD_COLLISION", path: "paths./items/{itemId}.get", severity: "error", lossy: false }));
  });

  it("uses the shared project, collection, API, and tag scopes", async () => {
    const exportOpenapi = await getExporter();
    const snapshot = createProjectSnapshot(makeOpenapiProject());
    const scopes: DocumentScope[] = [
      { kind: "project" },
      { kind: "collections", collectionIds: [contractExecutionIds.collection] },
      { kind: "apis", contractIds: [contractExecutionIds.contract] },
      { kind: "tags", tags: ["items"] },
    ];
    for (const scope of scopes) {
      const result = exportOpenapi(snapshot, scope, { version: "3.1", infoVersion: "1", allowLossy: false });
      expect(result.blocked).toBe(false);
      expect(Object.keys(result.document.paths as Record<string, unknown>)).toEqual(["/items/{itemId}"]);
    }
  });

  it("blocks missing model references even with allowLossy enabled", async () => {
    const exportOpenapi = await getExporter();
    const project = makeOpenapiProject();
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const request = asset.contract.request;
    if (request.protocol !== "http" || request.body.kind !== "json") throw new Error("JSON HTTP fixture required");
    request.body.schema = { kind: "modelRef", modelId: "20000000-0000-4000-8000-000000000099" };
    const result = exportOpenapi(createProjectSnapshot(project), { kind: "project" }, { version: "3.1", infoVersion: "1", allowLossy: true });
    expect(result.blocked).toBe(true);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "ASSET_REFERENCE_MISSING", path: "contract.request.body.schema.modelId", severity: "error", lossy: true,
    }));
  });

  it.each(["websocket", "graphql"] as const)("reports %s as explicit semantic loss and only allowLossy can unblock it", async (unsupported) => {
    const exportOpenapi = await getExporter();
    const project = makeOpenapiProject();
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    if (unsupported === "websocket") {
      const request = asset.contract.request;
      if (request.protocol !== "http") throw new Error("HTTP fixture required");
      asset.contract.request = {
        protocol: "websocket", baseUrl: request.baseUrl, path: request.path, pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, message: "{\"ping\":true}",
      };
    } else {
      const request = asset.contract.request;
      if (request.protocol !== "http") throw new Error("HTTP fixture required");
      request.body = { kind: "graphql", query: "query Item { item { id } }" };
    }
    const snapshot = createProjectSnapshot(project);
    const blocked = exportOpenapi(snapshot, { kind: "project" }, { version: "3.1", infoVersion: "1", allowLossy: false });
    expect(blocked.blocked).toBe(true);
    expect(blocked.diagnostics).toContainEqual(expect.objectContaining({
      code: unsupported === "websocket" ? "OPENAPI_WEBSOCKET_UNSUPPORTED" : "OPENAPI_GRAPHQL_SEMANTICS_UNSUPPORTED",
      path: unsupported === "websocket" ? "request.protocol" : "request.body",
      lossy: true,
      severity: "warning",
    }));
    const allowed = exportOpenapi(snapshot, { kind: "project" }, { version: "3.1", infoVersion: "1", allowLossy: true });
    expect(allowed.blocked).toBe(false);
  });

  it("does not expose a local request-body path while reporting it as non-lossy local execution data", async () => {
    const exportOpenapi = await getExporter();
    const project = makeOpenapiProject();
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const request = asset.contract.request;
    if (request.protocol !== "http") throw new Error("HTTP fixture required");
    request.body = { kind: "binary", file: { path: localBodyPath }, contentType: "application/octet-stream" };
    const result = exportOpenapi(createProjectSnapshot(project), { kind: "project" }, { version: "3.1", infoVersion: "1", allowLossy: false });
    expect(result.blocked).toBe(false);
    expect(JSON.stringify(result.document)).not.toContain(localBodyPath);
    expect(JSON.stringify(result.diagnostics)).not.toContain(localBodyPath);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "OPENAPI_LOCAL_FILE_REFERENCE_OMITTED", path: "request.body.file", severity: "warning", lossy: false,
    }));
  });
});
