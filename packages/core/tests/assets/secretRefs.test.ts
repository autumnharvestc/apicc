import { describe, expect, it } from "vitest";

import { rotateProjectSecretRefs } from "../../src/assets/secretRefs.js";
import { ApiAssetSchema, type AuthComponentAsset, type InlineAuthBinding } from "../../src/contract/model.js";
import { ContractProjectSchema, ContractWorkspaceSchema, type ContractProject } from "../../src/contract/workspace.js";
import { contractFixture, workspaceFixture } from "../helpers/contractFixtures.js";

function projectFixture(): ContractProject {
  return ContractWorkspaceSchema.parse(workspaceFixture()).groups[0].projects[0];
}

function apiAsset(id: string, request: Record<string, unknown>) {
  const fixture = contractFixture(request);
  fixture.contract.id = id;
  return ApiAssetSchema.parse(fixture);
}

function authComponent(id: string, name: string, definition: InlineAuthBinding): AuthComponentAsset {
  return { formatVersion: 1, id, name, description: "auth fixture", kind: "auth", definition };
}

function mixedProjectFixture(): ContractProject {
  const project = projectFixture();
  const firstCollection = project.collections[0];
  const httpApi = firstCollection.apis[0];
  const httpRequest = httpApi.contract.request;
  if (httpRequest.protocol !== "http") throw new Error("Fixture must use HTTP.");
  httpRequest.auth = { kind: "bearer", token: { id: "", policy: "http-policy" } };
  httpRequest.body = {
    kind: "json",
    content: "{\"id\":\"fake-body-ref\",\"policy\":\"keep-body\"}",
    schema: { kind: "scalar", type: "string", default: { id: "fake-schema-ref", policy: "keep-schema" } },
  };

  const nestedFolder = firstCollection.folders[0].folders[0];
  nestedFolder.apis.push(apiAsset("00000000-0000-4000-8000-000000000040", {
    protocol: "websocket",
    baseUrl: "wss://example.test/socket",
    path: "/events",
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth: { kind: "basic", username: "socket-user", password: { id: "__proto__", policy: "socket-policy" } },
    message: "{\"subscribe\":true}",
  }));

  const sharedAuth = project.components.find((component) => component.kind === "auth");
  if (!sharedAuth || sharedAuth.kind !== "auth") throw new Error("Fixture must include an auth component.");
  sharedAuth.definition = { kind: "bearer", token: { id: "", policy: "component-bearer-policy" } };

  const secondCollection = {
    ...structuredClone(firstCollection),
    id: "00000000-0000-4000-8000-000000000041",
    name: "Second collection",
    variables: { literal: "keep-variable" },
    preOperations: [{ id: "second-operation", type: "script" as const, content: "const ref = { id: 'fake-op-ref', policy: 'keep-op' };" }],
    folders: [],
    apis: [
      apiAsset("00000000-0000-4000-8000-000000000042", {
        protocol: "soap",
        method: "POST",
        baseUrl: "https://example.test/soap",
        path: "/service",
        pathParams: [],
        query: [],
        headers: [],
        cookies: [],
        auth: { kind: "apikey", name: "X-API-Key", placement: "query", value: { id: "/|:🪺", policy: "soap-policy" } },
        envelope: "<Envelope/>",
      }),
      apiAsset("00000000-0000-4000-8000-000000000043", {
        protocol: "http",
        method: "GET",
        baseUrl: "https://example.test",
        path: "/component-auth",
        pathParams: [],
        query: [],
        headers: [],
        cookies: [],
        auth: { kind: "componentRef", componentId: sharedAuth.id, expectedKind: "auth" },
        body: { kind: "none" },
      }),
    ],
  };
  project.collections.push(secondCollection);

  project.components.push(
    authComponent("00000000-0000-4000-8000-000000000044", "Unused basic", {
      kind: "basic", username: "unused", password: { id: "component-basic", policy: "basic-component-policy" },
    }),
    authComponent("00000000-0000-4000-8000-000000000045", "Unused API key", {
      kind: "apikey", name: "X-Unused", placement: "header", value: { id: "密钥🔑", policy: "apikey-component-policy" },
    }),
    authComponent("00000000-0000-4000-8000-000000000046", "Unused bearer", {
      kind: "bearer", token: { id: "orphan-component", policy: "orphan-policy" },
    }),
    authComponent("00000000-0000-4000-8000-000000000047", "No auth", { kind: "none" }),
  );

  const parameterComponent = project.components.find((component) => component.kind === "parameter");
  if (parameterComponent?.kind !== "parameter") throw new Error("Fixture must include a parameter component.");
  parameterComponent.definition.schema.default = { id: "fake-parameter-ref", policy: "keep-parameter" };
  const exampleComponent = project.components.find((component) => component.kind === "example");
  if (!exampleComponent || exampleComponent.kind !== "example") throw new Error("Fixture must include an example component.");
  exampleComponent.definition.value = { id: "fake-example-ref", policy: "keep-example" };

  return ContractProjectSchema.parse(project);
}

function projectWithRefs(firstId: string, secondId?: string): ContractProject {
  const project = projectFixture();
  const firstRequest = project.collections[0].apis[0].contract.request;
  if (firstRequest.protocol !== "http") throw new Error("Fixture must use HTTP.");
  firstRequest.auth = { kind: "bearer", token: { id: firstId, policy: "first-policy" } };

  if (secondId !== undefined) {
    const secondApi = apiAsset("00000000-0000-4000-8000-000000000050", {
      protocol: "websocket",
      baseUrl: "wss://example.test",
      path: "/",
      pathParams: [],
      query: [],
      headers: [],
      cookies: [],
      auth: { kind: "basic", username: "user", password: { id: secondId, policy: "second-policy" } },
      message: "",
    });
    project.collections[0].folders[0].folders[0].apis.push(secondApi);
  }

  project.components = [];
  return ContractProjectSchema.parse(project);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

type ObjectReferencePath = { path: string; value: object };

function objectReferenceSnapshot(value: unknown): ObjectReferencePath[] {
  const snapshot: ObjectReferencePath[] = [];
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, path: string[]): void => {
    if (current === null || typeof current !== "object" || ancestors.has(current)) return;
    snapshot.push({ path: JSON.stringify(path), value: current });
    ancestors.add(current);
    for (const key of Object.keys(current)) {
      visit((current as Record<string, unknown>)[key], [...path, key]);
    }
    ancestors.delete(current);
  };

  visit(value, []);
  return snapshot;
}

function expectSourceUnchangedByValueAndIdentity(
  project: ContractProject,
  before: ContractProject,
  referencesBefore: ObjectReferencePath[],
): void {
  expect(project).toEqual(before);
  const referencesAfter = objectReferenceSnapshot(project);
  expect(referencesAfter.map(({ path }) => path)).toEqual(referencesBefore.map(({ path }) => path));
  for (let index = 0; index < referencesBefore.length; index += 1) {
    expect(referencesAfter[index].value).toBe(referencesBefore[index].value);
  }
}

describe("rotateProjectSecretRefs", () => {
  it("rotates each formal auth ref once across protocols, nested collections, and unused auth components", () => {
    const project = mixedProjectFixture();
    const before = structuredClone(project);
    const expected = structuredClone(project);
    const expectedHttpRequest = expected.collections[0].apis[0].contract.request;
    if (expectedHttpRequest.protocol !== "http" || expectedHttpRequest.auth.kind !== "bearer") {
      throw new Error("Expected fixture must retain its HTTP bearer binding.");
    }
    expectedHttpRequest.auth.token.id = "rotated-empty";

    const expectedWebsocketRequest = expected.collections[0].folders[0].folders[0].apis[0].contract.request;
    if (expectedWebsocketRequest.protocol !== "websocket" || expectedWebsocketRequest.auth.kind !== "basic") {
      throw new Error("Expected fixture must retain its nested WebSocket basic binding.");
    }
    expectedWebsocketRequest.auth.password.id = "rotated-prototype-name";

    const expectedSoapRequest = expected.collections[1].apis[0].contract.request;
    if (expectedSoapRequest.protocol !== "soap" || expectedSoapRequest.auth.kind !== "apikey") {
      throw new Error("Expected fixture must retain its SOAP API key binding.");
    }
    expectedSoapRequest.auth.value.id = "rotated-separated";

    const expectedBearerComponent = expected.components.find((component) => component.kind === "auth" && component.name === "Service token");
    if (expectedBearerComponent?.kind !== "auth" || expectedBearerComponent.definition.kind !== "bearer") {
      throw new Error("Expected fixture must retain its shared bearer component.");
    }
    expectedBearerComponent.definition.token.id = "rotated-empty";
    const expectedBasicComponent = expected.components.find((component) => component.kind === "auth" && component.name === "Unused basic");
    if (expectedBasicComponent?.kind !== "auth" || expectedBasicComponent.definition.kind !== "basic") {
      throw new Error("Expected fixture must retain its unused basic component.");
    }
    expectedBasicComponent.definition.password.id = "rotated-basic-component";
    const expectedApiKeyComponent = expected.components.find((component) => component.kind === "auth" && component.name === "Unused API key");
    if (expectedApiKeyComponent?.kind !== "auth" || expectedApiKeyComponent.definition.kind !== "apikey") {
      throw new Error("Expected fixture must retain its unused API key component.");
    }
    expectedApiKeyComponent.definition.value.id = "rotated-unicode";
    const expectedOrphanComponent = expected.components.find((component) => component.kind === "auth" && component.name === "Unused bearer");
    if (expectedOrphanComponent?.kind !== "auth" || expectedOrphanComponent.definition.kind !== "bearer") {
      throw new Error("Expected fixture must retain its unused bearer component.");
    }
    expectedOrphanComponent.definition.token.id = "rotated-orphan";

    const targets = new Map([
      ["", "rotated-empty"],
      ["__proto__", "rotated-prototype-name"],
      ["/|:🪺", "rotated-separated"],
      ["component-basic", "rotated-basic-component"],
      ["密钥🔑", "rotated-unicode"],
      ["orphan-component", "rotated-orphan"],
    ]);
    const calls = new Map<string, number>();

    const result = rotateProjectSecretRefs(project, {
      newId(sourceRefId) {
        calls.set(sourceRefId, (calls.get(sourceRefId) ?? 0) + 1);
        const target = targets.get(sourceRefId);
        if (target === undefined) throw new Error(`Unexpected source ref ${sourceRefId}`);
        return target;
      },
    });

    expect(result).toEqual(expected);
    expect([...calls.entries()].sort(([left], [right]) => left.localeCompare(right))).toEqual(
      [...targets.keys()].map((id) => [id, 1] as [string, number]).sort(([left], [right]) => left.localeCompare(right)),
    );
    expect(result.collections[0].apis[0].contract.request).toMatchObject({
      protocol: "http",
      auth: { kind: "bearer", token: { id: "rotated-empty", policy: "http-policy" } },
      body: {
        kind: "json",
        content: "{\"id\":\"fake-body-ref\",\"policy\":\"keep-body\"}",
        schema: { default: { id: "fake-schema-ref", policy: "keep-schema" } },
      },
    });

    const websocketRequest = result.collections[0].folders[0].folders[0].apis[0].contract.request;
    expect(websocketRequest).toMatchObject({
      protocol: "websocket",
      auth: { kind: "basic", username: "socket-user", password: { id: "rotated-prototype-name", policy: "socket-policy" } },
    });
    const soapRequest = result.collections[1].apis[0].contract.request;
    expect(soapRequest).toMatchObject({
      protocol: "soap",
      auth: { kind: "apikey", name: "X-API-Key", placement: "query", value: { id: "rotated-separated", policy: "soap-policy" } },
    });
    expect(result.collections[1].apis[1].contract.request).toMatchObject({
      auth: { kind: "componentRef", componentId: "00000000-0000-4000-8000-000000000007", expectedKind: "auth" },
    });

    const bearerComponent = result.components.find((component) => component.kind === "auth" && component.name === "Service token");
    const basicComponent = result.components.find((component) => component.kind === "auth" && component.name === "Unused basic");
    const apiKeyComponent = result.components.find((component) => component.kind === "auth" && component.name === "Unused API key");
    const orphanComponent = result.components.find((component) => component.kind === "auth" && component.name === "Unused bearer");
    const noAuthComponent = result.components.find((component) => component.kind === "auth" && component.name === "No auth");
    expect(bearerComponent).toMatchObject({ definition: { kind: "bearer", token: { id: "rotated-empty", policy: "component-bearer-policy" } } });
    expect(basicComponent).toMatchObject({ definition: { kind: "basic", password: { id: "rotated-basic-component", policy: "basic-component-policy" } } });
    expect(apiKeyComponent).toMatchObject({ definition: { kind: "apikey", value: { id: "rotated-unicode", policy: "apikey-component-policy" } } });
    expect(orphanComponent).toMatchObject({ definition: { kind: "bearer", token: { id: "rotated-orphan", policy: "orphan-policy" } } });
    expect(noAuthComponent).toMatchObject({ definition: { kind: "none" } });

    expect(project).toEqual(before);
    expect(result.models[0].schema).toEqual(project.models[0].schema);
    expect(result.components.find((component) => component.kind === "parameter")).toEqual(
      project.components.find((component) => component.kind === "parameter"),
    );
    expect(result.components.find((component) => component.kind === "example")).toEqual(
      project.components.find((component) => component.kind === "example"),
    );
    expect(result.collections[1].variables).toEqual(project.collections[1].variables);
    expect(result.collections[1].preOperations).toEqual(project.collections[1].preOperations);
    expect(result.collections[0].apis[0].contract.request).not.toBe(project.collections[0].apis[0].contract.request);

    const mutableCandidateComponent = result.components.find((component) => component.kind === "auth" && component.name === "Service token");
    if (mutableCandidateComponent?.kind !== "auth" || mutableCandidateComponent.definition.kind !== "bearer") {
      throw new Error("Rotated bearer component must remain available.");
    }
    mutableCandidateComponent.definition.token.id = "candidate-only-edit";
    expect(project.components.find((component) => component.kind === "auth" && component.name === "Service token")).toMatchObject({
      definition: { kind: "bearer", token: { id: "", policy: "component-bearer-policy" } },
    });
  });

  it("returns an independent equal project without calling the factory when no auth refs exist", () => {
    const project = projectFixture();
    project.components = [];
    const source = ContractProjectSchema.parse(project);
    let calls = 0;

    const result = rotateProjectSecretRefs(source, { newId: () => { calls += 1; return "unused"; } });

    expect(calls).toBe(0);
    expect(result).not.toBe(source);
    expect(result).toEqual(source);
    expect(result.collections).not.toBe(source.collections);
  });

  it("supports a deeply frozen source project", () => {
    const project = projectWithRefs("frozen-source");
    deepFreeze(project);

    const result = rotateProjectSecretRefs(project, { newId: (id) => `new:${id}` });
    const request = result.collections[0].apis[0].contract.request;

    expect(request).toMatchObject({ auth: { kind: "bearer", token: { id: "new:frozen-source", policy: "first-policy" } } });
    expect(Object.isFrozen(project)).toBe(true);
    expect(project.collections[0].apis[0].contract.request).toMatchObject({
      auth: { kind: "bearer", token: { id: "frozen-source", policy: "first-policy" } },
    });
  });

  it("rejects a factory result that reuses its own source id without changing the source", () => {
    const project = projectWithRefs("same-source");
    const before = structuredClone(project);
    const referencesBefore = objectReferenceSnapshot(project);

    expect(() => rotateProjectSecretRefs(project, { newId: (id) => id })).toThrow();
    expectSourceUnchangedByValueAndIdentity(project, before, referencesBefore);
  });

  it("rejects a target matching any source id before changing the source", () => {
    const project = projectWithRefs("source-one", "source-two");
    const before = structuredClone(project);
    const referencesBefore = objectReferenceSnapshot(project);

    expect(() => rotateProjectSecretRefs(project, {
      newId: (id) => id === "source-one" ? "source-two" : "new-source-two",
    })).toThrow();
    expectSourceUnchangedByValueAndIdentity(project, before, referencesBefore);
  });

  it("rejects duplicate generated targets without changing the source", () => {
    const project = projectWithRefs("first-source", "second-source");
    const before = structuredClone(project);
    const referencesBefore = objectReferenceSnapshot(project);

    expect(() => rotateProjectSecretRefs(project, { newId: () => "duplicate-target" })).toThrow();
    expectSourceUnchangedByValueAndIdentity(project, before, referencesBefore);
  });

  it("propagates a factory error without changing the source", () => {
    const project = projectWithRefs("factory-error");
    const before = structuredClone(project);
    const referencesBefore = objectReferenceSnapshot(project);

    expect(() => rotateProjectSecretRefs(project, { newId: () => { throw new Error("factory failure"); } })).toThrow("factory failure");
    expectSourceUnchangedByValueAndIdentity(project, before, referencesBefore);
  });

  it("rejects a non-string factory result without changing the source", () => {
    const project = projectWithRefs("non-string-target");
    const before = structuredClone(project);
    const referencesBefore = objectReferenceSnapshot(project);

    expect(() => rotateProjectSecretRefs(project, { newId: () => 42 as unknown as string })).toThrow();
    expectSourceUnchangedByValueAndIdentity(project, before, referencesBefore);
  });
});
