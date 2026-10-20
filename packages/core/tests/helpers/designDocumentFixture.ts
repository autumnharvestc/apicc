import { ContractProjectSchema, type ContractProject } from "../../src/contract/workspace.js";

export const designDocumentIds = {
  project: "10000000-0000-4000-8000-000000000001",
  contract: "10000000-0000-4000-8000-000000000002",
  query: "10000000-0000-4000-8000-000000000003",
  response: "10000000-0000-4000-8000-000000000004",
  example: "10000000-0000-4000-8000-000000000005",
  model: "10000000-0000-4000-8000-000000000006",
  parameterComponent: "10000000-0000-4000-8000-000000000007",
} as const;

/** Shared HTTP source fixture for legacy Markdown and projection document tests. */
export function projectionProject(): ContractProject {
  const { project, contract, query, response, example, model, parameterComponent } = designDocumentIds;
  return ContractProjectSchema.parse({
    id: project,
    name: "Projection fixture",
    variables: {},
    globals: { query: [], headers: [], cookies: [], body: [] },
    environments: [],
    collections: [{
      id: "10000000-0000-4000-8000-000000000008",
      name: "Users",
      variables: {},
      preOperations: [],
      postOperations: [],
      folders: [],
      apis: [{
        contract: {
          formatVersion: 1,
          id: contract,
          metadata: { name: "Get user", description: "Read a user", tags: [], version: "1.0.0", status: "draft" },
          request: {
            protocol: "http",
            method: "GET",
            baseUrl: "https://api.example.test/v1",
            path: "/users/{id}",
            pathParams: [{ kind: "componentRef", id: "10000000-0000-4000-8000-00000000000a", componentId: parameterComponent, expectedKind: "parameter" }],
            query: [{ kind: "inline", id: query, name: "access_token", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "synthetic-import-token" }],
            headers: [{ kind: "inline", id: "10000000-0000-4000-8000-000000000009", name: "Authorization", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "Bearer synthetic-import-token" }],
            cookies: [],
            auth: { kind: "bearer", token: { id: "credential-ref-id", policy: "test-auto" } },
            body: { kind: "json", content: '{"password":"synthetic-import-token","profile":"visible"}', schema: { kind: "modelRef", modelId: model } },
          },
          responses: [{
            kind: "inline",
            id: response,
            status: "200",
            description: "ok",
            headers: {},
            content: { "application/json": { examples: [{ kind: "inline", id: example, name: "sample", value: { refresh_token: "synthetic-import-token", status: "ok" } }] } },
          }],
        },
        cases: [],
        documentation: "",
      }],
    }],
    workflows: [],
    stressPolicy: { trustedOrigins: [], deniedOrigins: [] },
    models: [{
      formatVersion: 1,
      id: model,
      name: "User",
      description: "Recursive user model",
      schema: {
        kind: "object",
        properties: {
          password: { kind: "scalar", type: "string", default: "synthetic-import-token" },
          related: { kind: "modelRef", modelId: model },
        },
        required: [],
        additionalProperties: false,
      },
    }],
    components: [{
      formatVersion: 1,
      id: parameterComponent,
      name: "Shared ID",
      description: "Reusable parameter",
      kind: "parameter",
      definition: { location: "path", name: "id", schema: { kind: "scalar", type: "integer" }, required: true, description: "User ID" },
    }],
  });
}
