import { describe, expect, it } from "vitest";

import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { buildDocumentProjection, DocumentProjectionSchema } from "../../src/design/projection.js";
import { createContractExecutionProject, contractExecutionIds } from "../helpers/contractExecutionFixtures.js";

const ids = {
  secondApi: "20000000-0000-4000-8000-000000000001",
  model: "20000000-0000-4000-8000-000000000002",
  responseBinding: "20000000-0000-4000-8000-000000000003",
  responseComponent: "20000000-0000-4000-8000-000000000004",
  exampleBinding: "20000000-0000-4000-8000-000000000005",
  exampleComponent: "20000000-0000-4000-8000-000000000006",
  missingModel: "20000000-0000-4000-8000-000000000007",
  authComponent: "20000000-0000-4000-8000-00000000000c",
} as const;

function onlyApi(project: ReturnType<typeof createContractExecutionProject>) {
  return project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
}

function referencedProject() {
  const project = createContractExecutionProject("http://127.0.0.1");
  const api = onlyApi(project);
  api.contract.metadata.tags = ["accounts"];
  api.contract.metadata.description = "Authorization: Bearer metadata-secret";
  api.contract.request.auth = {
    kind: "apikey",
    name: "X-Workspace-Key",
    placement: "header",
    value: { id: "secret-ref-projection-1", policy: "test-auto" },
  };
  api.contract.request.headers.push({
    kind: "inline",
    id: "20000000-0000-4000-8000-000000000008",
    name: "X-Access-Token",
    schema: { kind: "scalar", type: "string" },
    required: false,
    enabled: true,
    description: "access token header",
    value: "header-secret-value",
  });
  if (api.contract.request.protocol !== "http") throw new Error("Expected an HTTP fixture.");
  api.contract.request.body = {
    kind: "multipart",
    entries: [
      { kind: "text", id: "20000000-0000-4000-8000-000000000009", name: "access_token", value: "multipart-secret", enabled: true },
      { kind: "file", id: "20000000-0000-4000-8000-00000000000a", name: "upload", file: { path: "C:\\private\\upload.bin" }, filename: "upload.bin", enabled: true },
    ],
  };
  api.documentation = "Authorization: Bearer docs-secret\npassword=docs-password\nWindows path: C:/Users/alice/private/contract.yaml\nUNC path: \\\\server\\share\\private\\contract.yaml\nPOSIX path: Read `/etc/apicc/credentials.json`\nURL: https://api.example.test/v1?next=/users\nRelative path: schemas/request.json";
  api.contract.responses = [{
    kind: "componentRef",
    id: ids.responseBinding,
    componentId: ids.responseComponent,
    expectedKind: "response",
  }];
  project.models = [{
    formatVersion: 1,
    id: ids.model,
    name: "UserPayload",
    description: "Recursive user data",
    schema: {
      kind: "object",
      properties: {
        password: { kind: "scalar", type: "string", default: "model-password" },
        related: { kind: "modelRef", modelId: ids.model },
      },
      required: ["password"],
      additionalProperties: false,
    },
  }];
  project.components = [
    {
      formatVersion: 1,
      id: ids.responseComponent,
      name: "Created response",
      description: "Response with an example reference",
      kind: "response",
      definition: {
        status: "201",
        description: "created",
        headers: { Authorization: "Bearer response-header-secret" },
        content: {
          "application/json": {
            schema: { kind: "modelRef", modelId: ids.model },
            examples: [{ kind: "componentRef", id: ids.exampleBinding, componentId: ids.exampleComponent, expectedKind: "example" }],
          },
        },
      },
    },
    {
      formatVersion: 1,
      id: ids.exampleComponent,
      name: "Created sample",
      description: "",
      kind: "example",
      definition: { name: "sample", value: { access_token: "example-secret", state: "ready" } },
    },
  ];
  return project;
}

describe("buildDocumentProjection", () => {
  it("projects resolved response/model references finitely and masks credential and local file data", () => {
    const project = referencedProject();
    const snapshot = createProjectSnapshot(project);
    const projection = buildDocumentProjection(snapshot, { kind: "project" });
    const api = projection.apis[0]!;

    expect(projection.sourceProjectRevision).toBe(snapshot.definitionRevision);
    expect(projection.project).toEqual({ id: contractExecutionIds.project, name: "snapshot-project" });
    expect(projection.apis).toHaveLength(1);
    expect(api.metadata).toMatchObject({ name: "snapshot-request", tags: ["accounts"], status: "draft" });
    expect(api.request).toMatchObject({
      protocol: "http",
      method: "POST",
      auth: { kind: "apikey", name: "X-Workspace-Key", placement: "header", value: "****" },
      headers: [
        { name: "X-Base-Template", value: "{{baseUrl}}" },
        { name: "X-Access-Token", value: "****" },
      ],
      body: { kind: "multipart", entries: [
        { kind: "text", name: "access_token", value: "****" },
        { kind: "file", name: "upload", bound: true, filename: "upload.bin" },
      ] },
    });
    expect(api.responses).toMatchObject([{
      kind: "componentRef",
      status: "201",
      content: { "application/json": { schema: { kind: "modelRef", modelId: ids.model }, examples: [{ name: "sample", value: { access_token: "****", state: "ready" } }] } },
    }]);
    expect(api.models).toHaveLength(1);
    expect(api.models[0]?.schema).toMatchObject({
      kind: "object",
      properties: {
        password: { default: "****" },
        related: { kind: "modelRef", modelId: ids.model },
      },
    });
    expect(JSON.stringify(projection)).not.toContain("secret-ref-projection-1");
    expect(JSON.stringify(projection)).not.toContain("credential-ref-1");
    expect(JSON.stringify(projection)).not.toContain("header-secret-value");
    expect(JSON.stringify(projection)).not.toContain("multipart-secret");
    expect(JSON.stringify(projection)).not.toContain("example-secret");
    expect(JSON.stringify(projection)).not.toContain("response-header-secret");
    expect(JSON.stringify(projection)).not.toContain("C:\\\\private\\\\upload.bin");
    expect(api.documentation).not.toContain("C:/Users/alice/private/contract.yaml");
    expect(api.documentation).not.toContain("\\\\server\\share\\private\\contract.yaml");
    expect(api.documentation).not.toContain("/etc/apicc/credentials.json");
    expect(api.documentation).toContain("https://api.example.test/v1?next=/users");
    expect(api.documentation).toContain("schemas/request.json");
    expect(JSON.stringify(projection)).not.toContain("docs-secret");
    expect(DocumentProjectionSchema.safeParse(projection).success).toBe(true);
    expect(() => JSON.stringify(projection)).not.toThrow();
    expect(snapshot.project.collections[0]?.folders[0]?.folders[0]?.apis[0]?.documentation).toBe("Authorization: Bearer docs-secret\npassword=docs-password\nWindows path: C:/Users/alice/private/contract.yaml\nUNC path: \\\\server\\share\\private\\contract.yaml\nPOSIX path: Read `/etc/apicc/credentials.json`\nURL: https://api.example.test/v1?next=/users\nRelative path: schemas/request.json");

    const bodyProject = createContractExecutionProject("http://127.0.0.1");
    const bodyApi = onlyApi(bodyProject);
    if (bodyApi.contract.request.protocol !== "http") throw new Error("Expected an HTTP fixture.");
    bodyApi.contract.request.body = { kind: "json", content: '{"id":9007199254740993,"password":"body-secret-sentinel","route":"/users","template":"{{route}}"}' };
    const jsonRequest = buildDocumentProjection(createProjectSnapshot(bodyProject), { kind: "project" }).apis[0]?.request;
    if (!jsonRequest || jsonRequest.protocol !== "http") throw new Error("Expected an HTTP projection.");
    expect(jsonRequest.body).toMatchObject({ kind: "json", content: '{"id":9007199254740993,"password":"****","route":"/users","template":"{{route}}"}' });

    bodyApi.contract.request.body = { kind: "graphql", query: "query Probe { ok }", variables: '{"access_token":"graphql-secret-sentinel","name":"{{name}}"}' };
    const graphqlRequest = buildDocumentProjection(createProjectSnapshot(bodyProject), { kind: "project" }).apis[0]?.request;
    if (!graphqlRequest || graphqlRequest.protocol !== "http") throw new Error("Expected an HTTP projection.");
    expect(graphqlRequest.body).toMatchObject({ kind: "graphql", variables: '{"access_token":"****","name":"{{name}}"}' });

    bodyApi.contract.request.body = { kind: "json", content: '{"password":{{secret}}}' };
    const invalidJsonRequest = buildDocumentProjection(createProjectSnapshot(bodyProject), { kind: "project" }).apis[0]?.request;
    if (!invalidJsonRequest || invalidJsonRequest.protocol !== "http") throw new Error("Expected an HTTP projection.");
    expect(invalidJsonRequest.body).toMatchObject({ kind: "json", content: "****" });

    const basicProject = referencedProject();
    const basicApi = onlyApi(basicProject);
    basicApi.contract.request.auth = { kind: "basic", username: "inline-auth-user-sentinel", password: { id: "inline-basic-secret-ref", policy: "test-auto" } };
    const inlineBasic = buildDocumentProjection(createProjectSnapshot(basicProject), { kind: "project" }).apis[0]?.request.auth;
    expect(inlineBasic).toEqual({ kind: "basic", username: "****", password: "****" });

    basicProject.components.push({
      formatVersion: 1,
      id: ids.authComponent,
      name: "Basic auth",
      description: "",
      kind: "auth",
      definition: { kind: "basic", username: "component-auth-user-sentinel", password: { id: "component-basic-secret-ref", policy: "test-auto" } },
    });
    basicApi.contract.request.auth = { kind: "componentRef", componentId: ids.authComponent, expectedKind: "auth" };
    const componentBasic = buildDocumentProjection(createProjectSnapshot(basicProject), { kind: "project" }).apis[0]?.request.auth;
    expect(componentBasic).toEqual({ kind: "basic", username: "****", password: "****" });

    const endpointProject = createContractExecutionProject("https://api.example.test");
    const endpointApi = onlyApi(endpointProject);
    if (endpointApi.contract.request.protocol !== "http") throw new Error("Expected an HTTP fixture.");
    endpointApi.contract.request.baseUrl = "https://api.example.test/v1?next=/users";
    endpointApi.contract.request.path = "/users/{{userId}}";
    const endpointProjection = buildDocumentProjection(createProjectSnapshot(endpointProject), { kind: "project" }).apis[0]!;
    expect(endpointProjection.request.baseUrl).toBe("https://api.example.test/v1?next=/users");
    expect(endpointProjection.request.path).toBe("/users/{{userId}}");
  });

  it("selects collection, API, and any matching tag in project order", () => {
    const project = createContractExecutionProject("http://127.0.0.1");
    const collection = project.collections[0]!;
    const folder = collection.folders[0]!.folders[0]!;
    const first = folder.apis[0]!;
    first.contract.metadata.tags = ["alpha"];
    const second = structuredClone(first);
    second.contract.id = ids.secondApi;
    second.contract.metadata.name = "second-in-source-order";
    second.contract.metadata.tags = ["beta"];
    folder.apis.push(second);
    const snapshot = createProjectSnapshot(project);

    expect(buildDocumentProjection(snapshot, { kind: "collections", collectionIds: [collection.id] }).apis.map((api) => api.contractId))
      .toEqual([first.contract.id, ids.secondApi]);
    expect(buildDocumentProjection(snapshot, { kind: "apis", contractIds: [ids.secondApi, first.contract.id] }).apis.map((api) => api.contractId))
      .toEqual([first.contract.id, ids.secondApi]);
    expect(buildDocumentProjection(snapshot, { kind: "tags", tags: ["beta", "alpha"] }).apis.map((api) => api.contractId))
      .toEqual([first.contract.id, ids.secondApi]);
  });

  it("returns scope diagnostics for empty or unknown selections without expanding to the project", () => {
    const snapshot = createProjectSnapshot(createContractExecutionProject("http://127.0.0.1"));
    const empty = buildDocumentProjection(snapshot, { kind: "collections", collectionIds: [] });
    const unknown = buildDocumentProjection(snapshot, { kind: "apis", contractIds: [ids.secondApi] });

    expect(empty.apis).toEqual([]);
    expect(empty.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", path: "scope.collectionIds", lossy: false }),
    ]));
    expect(unknown.apis).toEqual([]);
    expect(unknown.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "DOCUMENT_SCOPE_TARGET_NOT_FOUND", ownerId: ids.secondApi }),
    ]));
  });

  it("keeps unresolved model references with a concrete diagnostic path", () => {
    const project = createContractExecutionProject("http://127.0.0.1");
    const api = onlyApi(project);
    api.contract.responses = [{
      kind: "inline",
      id: "20000000-0000-4000-8000-00000000000b",
      status: "200",
      description: "ok",
      headers: {},
      content: { "application/json": { schema: { kind: "modelRef", modelId: ids.missingModel }, examples: [] } },
    }];
    const projection = buildDocumentProjection(createProjectSnapshot(project), { kind: "apis", contractIds: [api.contract.id] });

    expect(projection.apis[0]?.responses[0]).toMatchObject({
      content: { "application/json": { schema: { kind: "modelRef", modelId: ids.missingModel } } },
    });
    expect(projection.diagnostics).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "ASSET_REFERENCE_MISSING",
      ownerId: api.contract.id,
      path: 'contract.responses[0].content["application/json"].schema.modelId',
      lossy: true,
    }));
  });
});
