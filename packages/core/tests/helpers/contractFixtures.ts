export type FixtureParameter = Record<string, unknown>;

export type FixtureAsset = {
  contract: {
    formatVersion: number;
    id: string;
    metadata: Record<string, unknown>;
    request: Record<string, unknown>;
    responses: unknown[];
  };
  cases: unknown[];
  documentation: string;
};

const ids = {
  contract: "00000000-0000-4000-8000-000000000001",
  pathParameter: "00000000-0000-4000-8000-000000000002",
  response: "00000000-0000-4000-8000-000000000003",
  responseExample: "00000000-0000-4000-8000-000000000004",
  model: "00000000-0000-4000-8000-000000000005",
  parameterComponent: "00000000-0000-4000-8000-000000000006",
  authComponent: "00000000-0000-4000-8000-000000000007",
  responseComponent: "00000000-0000-4000-8000-000000000008",
  exampleComponent: "00000000-0000-4000-8000-000000000009",
};

export function nestedSchemaFixture(): Record<string, unknown> {
  return {
    kind: "object",
    properties: {
      profile: {
        kind: "object",
        properties: {
          name: {
            kind: "scalar",
            type: "string",
            default: "Ada",
            examples: ["Lin"],
            enum: ["Ada", "Lin"],
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      scores: { kind: "array", items: { kind: "scalar", type: "integer" } },
    },
    required: ["profile"],
    additionalProperties: { kind: "modelRef", modelId: ids.model },
  };
}

export function compositeSchemaFixture(): Record<string, unknown> {
  return {
    kind: "allOf",
    variants: [
      nestedSchemaFixture(),
      {
        kind: "oneOf",
        variants: [
          { kind: "scalar", type: "null" },
          {
            kind: "anyOf",
            variants: [
              { kind: "scalar", type: "number", enum: [1, 2] },
              { kind: "modelRef", modelId: ids.model },
            ],
          },
        ],
      },
    ],
    description: "nested and combinatorial schema fixture",
  };
}

export function inlineParameter(input: {
  name: string;
  schema: Record<string, unknown>;
  id?: string;
  required?: boolean;
  enabled?: boolean;
  description?: string;
  value?: string;
}): FixtureParameter {
  return {
    kind: "inline",
    id: input.id ?? ids.pathParameter,
    name: input.name,
    schema: input.schema,
    required: input.required ?? false,
    enabled: input.enabled ?? true,
    description: input.description ?? "request parameter",
    ...(input.value === undefined ? {} : { value: input.value }),
  };
}

export function parameterReference(
  componentId = ids.parameterComponent,
  id = "00000000-0000-4000-8000-000000000010",
): FixtureParameter {
  return {
    kind: "componentRef",
    id,
    componentId,
    expectedKind: "parameter",
    enabled: false,
    value: "{{userId}}",
  };
}

export function inlineExample(): Record<string, unknown> {
  return { kind: "inline", id: ids.responseExample, name: "created", value: { id: 7 } };
}

export function exampleReference(componentId = ids.exampleComponent): Record<string, unknown> {
  return {
    kind: "componentRef",
    id: "00000000-0000-4000-8000-000000000011",
    componentId,
    expectedKind: "example",
  };
}

export function responseReference(): Record<string, unknown> {
  return {
    kind: "componentRef",
    id: "00000000-0000-4000-8000-000000000022",
    componentId: ids.responseComponent,
    expectedKind: "response",
  };
}

export function authBindingFixtures(): Record<string, unknown>[] {
  return [
    { kind: "none" },
    { kind: "bearer", token: { id: "bearer-token", policy: "test-auto" } },
    { kind: "basic", username: "fixture-user", password: { id: "basic-password", policy: "test-auto" } },
    { kind: "apikey", name: "X-API-Key", placement: "header", value: { id: "api-key", policy: "test-auto" } },
    { kind: "apikey", name: "key", placement: "query", value: { id: "query-api-key", policy: "test-auto" } },
    { kind: "componentRef", componentId: "00000000-0000-4000-8000-000000000007", expectedKind: "auth" },
  ];
}

export function inlineResponse(): Record<string, unknown> {
  return {
    kind: "inline",
    id: ids.response,
    status: "201",
    description: "created",
    headers: { "Content-Type": "application/json" },
    content: {
      "application/json": { schema: nestedSchemaFixture(), examples: [inlineExample()] },
      "application/problem+json": { examples: [exampleReference()] },
    },
  };
}

export function modelAssetFixture(): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: ids.model,
    name: "Person",
    description: "A model with recursive composition.",
    schema: compositeSchemaFixture(),
  };
}

export function componentFixtures(): Record<string, unknown>[] {
  return [
    {
      formatVersion: 1,
      id: ids.parameterComponent,
      name: "User ID",
      description: "Reusable path parameter.",
      kind: "parameter",
      definition: {
        location: "path",
        name: "userId",
        schema: { kind: "scalar", type: "integer", examples: [7] },
        required: true,
        description: "User identifier.",
      },
    },
    {
      formatVersion: 1,
      id: ids.authComponent,
      name: "Service token",
      description: "Reusable bearer authentication.",
      kind: "auth",
      definition: { kind: "bearer", token: { id: "service-token", policy: "test-auto" } },
    },
    {
      formatVersion: 1,
      id: ids.responseComponent,
      name: "Created response",
      description: "Reusable response definition.",
      kind: "response",
      definition: {
        status: "201",
        description: "created",
        headers: { "Content-Type": "application/json" },
        content: { "application/json": { schema: nestedSchemaFixture(), examples: [exampleReference()] } },
      },
    },
    {
      formatVersion: 1,
      id: ids.exampleComponent,
      name: "Created example",
      description: "Reusable JSON example.",
      kind: "example",
      definition: { name: "created", value: { id: 7 } },
    },
  ];
}

export function contractFixture(request?: Record<string, unknown>): FixtureAsset {
  return {
    contract: {
      formatVersion: 1,
      id: ids.contract,
      metadata: {
        name: "Create user",
        description: "Creates a user.",
        tags: ["users", "write"],
        version: "2.1.0",
        status: "draft",
      },
      request: request ?? {
        protocol: "http",
        method: "POST",
        baseUrl: "https://example.test/v1",
        path: "/users",
        pathParams: [],
        query: [],
        headers: [],
        cookies: [],
        auth: { kind: "none" },
        body: { kind: "json", content: "{{payload}}", schema: nestedSchemaFixture() },
      },
      responses: [inlineResponse(), { kind: "inline", id: "00000000-0000-4000-8000-000000000012", status: "4XX", description: "client error", headers: {}, content: {} }],
    },
    cases: [],
    documentation: "# Create user\n\nCreates a user.",
  };
}

export function httpRequestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "http",
    method: "POST",
    baseUrl: "https://example.test/v1",
    path: "/users",
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth: { kind: "none" },
    body: { kind: "none" },
    ...overrides,
  };
}

export function bodyFixtures(): Record<string, unknown>[] {
  return [
    { kind: "none" },
    { kind: "json", content: "{\"id\": 7}", schema: nestedSchemaFixture() },
    { kind: "xml", content: "<user id=\"7\"/>", schema: { kind: "scalar", type: "string" } },
    { kind: "text", content: "hello", schema: { kind: "scalar", type: "string" } },
    { kind: "graphql", query: "query User { user(id: 7) { id } }", variables: "{\"id\":7}", operationName: "User" },
    { kind: "urlencoded", fields: [{ id: "00000000-0000-4000-8000-000000000013", name: "name", value: "Ada", enabled: true }] },
    {
      kind: "multipart",
      entries: [
        { kind: "text", id: "00000000-0000-4000-8000-000000000014", name: "caption", value: "portrait", enabled: true },
        { kind: "file", id: "00000000-0000-4000-8000-000000000015", name: "photo", file: { path: "C:/fixtures/photo.png" }, contentType: "image/png", enabled: true },
      ],
    },
    {
      kind: "multipart",
      entries: [{ kind: "file", id: "00000000-0000-4000-8000-000000000026", name: "attachment", file: { path: "C:/fixtures/attachment.bin" }, enabled: true }],
    },
    { kind: "binary", file: { path: "C:/fixtures/archive.bin" }, contentType: "application/octet-stream" },
  ];
}

export function protocolRequestFixtures(): Record<string, unknown>[] {
  return [
    httpRequestFixture(),
    {
      protocol: "websocket",
      baseUrl: "wss://example.test/socket",
      path: "/events",
      pathParams: [],
      query: [],
      headers: [],
      cookies: [],
      auth: { kind: "none" },
      message: "{\"subscribe\":true}",
    },
    {
      protocol: "soap",
      method: "POST",
      baseUrl: "https://example.test/soap",
      path: "/service",
      pathParams: [],
      query: [],
      headers: [],
      cookies: [],
      auth: { kind: "none" },
      envelope: "<Envelope/>",
      soapAction: "urn:CreateUser",
    },
  ];
}

export function workspaceFixture(): Record<string, unknown> {
  const api = contractFixture();
  api.cases = [{
    id: "case-create-user",
    name: "valid payload",
    scope: "base",
    parameters: { userId: "7" },
    preOperations: [{ id: "operation-before", type: "script", content: "request.headers['X-Trace'] = 'fixture';" }],
    postOperations: [],
    assertions: [],
  }];

  return {
    formatVersion: 1,
    id: "00000000-0000-4000-8000-000000000016",
    name: "Fixture workspace",
    variables: {},
    groups: [{
      id: "00000000-0000-4000-8000-000000000017",
      name: "Default group",
      default: true,
      projects: [{
        id: "00000000-0000-4000-8000-000000000018",
        name: "Fixture project",
        variables: {},
        globals: { query: [], headers: [], cookies: [], body: [] },
        environments: [{ id: "00000000-0000-4000-8000-000000000019", name: "local", variables: {}, baseUrls: {} }],
        collections: [{
          id: "00000000-0000-4000-8000-000000000020",
          name: "Users",
          variables: {},
          preOperations: [{ id: "operation-collection", type: "script", content: "collectionReady = true;" }],
          postOperations: [],
          folders: [{
            id: "00000000-0000-4000-8000-000000000021",
            name: "Nested",
            preOperations: [],
            postOperations: [],
            folders: [{ id: "00000000-0000-4000-8000-000000000025", name: "Deep", preOperations: [], postOperations: [], folders: [], apis: [] }],
            apis: [],
          }],
          apis: [api],
        }],
        workflows: [{ id: "workflow-fixture", name: "Create user", status: "draft", nodes: [], edges: [] }],
        stressPolicy: { trustedOrigins: [], deniedOrigins: [] },
        models: [modelAssetFixture()],
        components: componentFixtures(),
      }],
    }],
  };
}

export function workspaceFixtureWithUnknownFolderField(): Record<string, unknown> {
  const workspace = workspaceFixture();
  const groups = workspace.groups as Array<Record<string, unknown>>;
  const projects = groups[0].projects as Array<Record<string, unknown>>;
  const collections = projects[0].collections as Array<Record<string, unknown>>;
  const folders = collections[0].folders as Array<Record<string, unknown>>;
  folders[0].futureField = true;
  return workspace;
}
