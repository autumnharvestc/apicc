import { describe, expect, it } from "vitest";

import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ProjectSnapshot } from "../../src/assets/snapshot.js";
import type { MockDiagnostic } from "../../src/mock/config.js";
import * as core from "../../src/index.js";
import { createMockConfiguredProject, mockFixtureIds } from "../helpers/mockFixtures.js";

interface CompiledRule {
  id: string;
  status: number;
  mediaType: string;
  headers: Record<string, string>;
  body: readonly number[];
  delayMs: number;
  conditions: unknown[];
}

interface CompilerSuccess {
  ok: true;
  plan: {
    sourceProjectRevision: string;
    routes: Array<{ contractId: string; method: string; pathTemplate: string; rules: CompiledRule[] }>;
  };
}

interface CompilerFailure {
  ok: false;
  diagnostics: MockDiagnostic[];
}

const compiler = core as unknown as {
  compileProjectMock?: (snapshot: ProjectSnapshot) => CompilerSuccess | CompilerFailure;
};

const secondContractId = "10000000-0000-4000-8000-000000000021";
const secondRuleId = "10000000-0000-4000-8000-000000000022";
const secondResponseId = "10000000-0000-4000-8000-000000000023";
const secondExampleId = "10000000-0000-4000-8000-000000000024";

function addSecondRoute(project: ReturnType<typeof createMockConfiguredProject>, path: string): void {
  const collection = project.collections[0]!;
  const folder = collection.folders[0]!.folders[0]!;
  const source = folder.apis[0]!;
  const second = structuredClone(source);
  second.contract.id = secondContractId;
  if (second.contract.request.protocol !== "http") throw new Error("Mock fixture must use HTTP.");
  second.contract.request.path = path;
  const secondResponse = second.contract.responses[0]!;
  if (secondResponse.kind !== "inline") throw new Error("Mock fixture response must be inline.");
  secondResponse.id = secondResponseId;
  secondResponse.content["application/json"]!.examples[0]!.id = secondExampleId;
  folder.apis.push(second);
  project.mock.enabledContractIds.push(secondContractId);
  project.mock.rules.push({
    ...structuredClone(project.mock.rules[0]!),
    id: secondRuleId,
    contractId: secondContractId,
    responseBindingId: secondResponseId,
    source: { kind: "example", exampleBindingId: secondExampleId },
  });
}

function failureCode(result: CompilerSuccess | CompilerFailure | undefined): string | undefined {
  return result?.ok === false ? result.diagnostics[0]?.code : undefined;
}

describe("compileProjectMock", () => {
  it("compiles the fixed example to stable bytes tied to the snapshot revision", () => {
    const snapshot = createProjectSnapshot(createMockConfiguredProject());
    const first = compiler.compileProjectMock?.(snapshot);
    const second = compiler.compileProjectMock?.(snapshot);

    expect(first).toMatchObject({
      ok: true,
      plan: {
        sourceProjectRevision: snapshot.definitionRevision,
        routes: [{ contractId: "10000000-0000-4000-8000-000000000005", method: "GET", pathTemplate: "/items/{id}" }],
      },
    });
    if (!first || !first.ok) throw new Error("Expected the fixed example to compile.");
    const rule = first.plan.routes[0]!.rules[0]!;
    expect(rule.id).toBe(mockFixtureIds.rule);
    expect(rule.status).toBe(200);
    expect(rule.mediaType).toBe("application/json");
    expect(rule.body).toEqual(Array.from(Buffer.from('{"id":"item-7"}', "utf8")));
    expect(rule.headers).toEqual({ "X-Mock-Fixture": "fixed" });
    expect(second).toEqual(first);
  });

  it.each([
    { path: "/items/fixed", ok: true, routeOrder: ["/items/fixed", "/items/{id}"] },
    { path: "/items/{other}", ok: false, code: "MOCK_ROUTE_AMBIGUOUS" },
  ])("orders static routes ahead and rejects canonical path collisions for $path", ({ path, ok, routeOrder, code }) => {
    const project = createMockConfiguredProject();
    addSecondRoute(project, path);
    const result = compiler.compileProjectMock?.(createProjectSnapshot(project));
    if (ok) {
      expect(result).toMatchObject({ ok: true });
      if (!result || !result.ok) throw new Error("Expected both routes to compile.");
      expect(result.plan.routes.map((route) => route.pathTemplate)).toEqual(routeOrder);
    } else expect(failureCode(result)).toBe(code);
  });

  it("preserves AND conditions and requires an explicit default to be last", () => {
    const project = createMockConfiguredProject();
    const rules = project.mock.rules;
    rules[0]!.conditions = [
      { source: "query", op: "equals", name: "view", value: "full" },
      { source: "body", op: "equals", pointer: "/id", value: "item-7" },
    ];
    rules.push({ ...structuredClone(rules[0]!), id: secondRuleId, conditions: [] });
    const result = compiler.compileProjectMock?.(createProjectSnapshot(project));
    expect(result).toMatchObject({ ok: true });
    if (!result || !result.ok) throw new Error("Expected a conditional rule followed by a default.");
    expect(result.plan.routes[0]!.rules.map((rule) => rule.id)).toEqual([mockFixtureIds.rule, secondRuleId]);
    expect(result.plan.routes[0]!.rules[0]!.conditions).toEqual(rules[0]!.conditions);

    const invalid = createMockConfiguredProject();
    invalid.mock.rules.push({
      ...structuredClone(invalid.mock.rules[0]!),
      id: secondRuleId,
      conditions: [{ source: "query", op: "exists", name: "view" }],
    });
    expect(failureCode(compiler.compileProjectMock?.(createProjectSnapshot(invalid)))).toBe("MOCK_DEFAULT_RULE_NOT_LAST");

    const noDefault = createMockConfiguredProject();
    noDefault.mock.rules[0]!.conditions = [{ source: "query", op: "exists", name: "view" }];
    expect(compiler.compileProjectMock?.(createProjectSnapshot(noDefault))).toMatchObject({ ok: true });
  });

  it("allows configured SOAP HTTP routes only with static XML or text bodies", () => {
    const project = createMockConfiguredProject();
    const api = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    api.contract.request = {
      protocol: "soap",
      method: "POST",
      baseUrl: "",
      path: "/items/{id}",
      pathParams: [],
      query: [],
      headers: [],
      cookies: [],
      auth: { kind: "none" },
      envelope: "<request />",
    };
    const response = api.contract.responses[0]!;
    if (response.kind !== "inline") throw new Error("Mock fixture response must be inline.");
    response.content = {
      "application/xml": {
        examples: [{
          kind: "inline",
          id: mockFixtureIds.example,
          name: "fixed XML",
          value: "<item>fixed</item>",
        }],
      },
    };
    project.mock.rules[0]!.mediaType = "application/xml";
    const result = compiler.compileProjectMock?.(createProjectSnapshot(project));
    expect(result).toMatchObject({ ok: true, plan: { routes: [{ method: "POST", rules: [{ mediaType: "application/xml" }] }] } });
    if (!result || !result.ok) throw new Error("Expected configured SOAP static text to compile.");
    expect(Buffer.from(result.plan.routes[0]!.rules[0]!.body).toString("utf8")).toBe("<item>fixed</item>");
  });

  it.each([
    { method: "GET" as const, status: 204, expectedStatus: 204 },
    { method: "HEAD" as const, status: undefined, expectedStatus: 200 },
  ])("suppresses response bytes for $method / $status", ({ method, status, expectedStatus }) => {
    const project = createMockConfiguredProject();
    const api = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    if (api.contract.request.protocol !== "http") throw new Error("Mock fixture must use HTTP.");
    api.contract.request.method = method;
    if (status !== undefined) project.mock.rules[0]!.status = status;
    const result = compiler.compileProjectMock?.(createProjectSnapshot(project));
    expect(result).toMatchObject({ ok: true });
    if (!result || !result.ok) throw new Error("Expected bodyless response status to compile.");
    expect(result.plan.routes[0]!.rules[0]!.status).toBe(expectedStatus);
    expect(result.plan.routes[0]!.rules[0]!.body).toEqual([]);
  });

  it("requires a concrete status for wildcard response bindings", () => {
    const project = createMockConfiguredProject();
    const response = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.responses[0]!;
    if (response.kind !== "inline") throw new Error("Mock fixture response must be inline.");
    response.status = "2XX";
    expect(failureCode(compiler.compileProjectMock?.(createProjectSnapshot(project)))).toBe("MOCK_STATUS_REQUIRED");

    project.mock.rules[0]!.status = 202;
    const result = compiler.compileProjectMock?.(createProjectSnapshot(project));
    expect(result).toMatchObject({ ok: true, plan: { routes: [{ rules: [{ status: 202 }] }] } });
  });

  it.each(["a\u0000b", "\u0100"])("rejects a response header value Node cannot transmit", (value) => {
    const project = createMockConfiguredProject();
    const response = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.responses[0]!;
    if (response.kind !== "inline") throw new Error("Mock fixture response must be inline.");
    response.headers["X-Test"] = value;

    const result = compiler.compileProjectMock?.(createProjectSnapshot(project));
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "MOCK_RESPONSE_HEADER_INVALID",
        path: expect.stringContaining("headers.X-Test"),
      })],
    });
  });

  it("rejects a selected Content-Type value Node cannot transmit", () => {
    const project = createMockConfiguredProject();
    const response = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.responses[0]!;
    if (response.kind !== "inline") throw new Error("Mock fixture response must be inline.");
    const content = response.content["application/json"]!;
    delete response.content["application/json"];
    response.content["application/json; x=\u0100"] = content;
    project.mock.rules[0]!.mediaType = "application/json; x=\u0100";

    expect(compiler.compileProjectMock?.(createProjectSnapshot(project))).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "MOCK_MEDIA_TYPE_INVALID",
        path: "mock.rules[0].mediaType",
      })],
    });
  });
});
