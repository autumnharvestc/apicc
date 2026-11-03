import { describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { compileProjectMock, type CompiledMockPlan, type CompileProjectMockResult } from "../../src/mock/compile.js";
import { evaluateMock, type MockEvaluationInput } from "../../src/mock/evaluate.js";
import { createMockConfiguredProject, mockFixtureIds } from "../helpers/mockFixtures.js";

const request = (changes: Partial<MockEvaluationInput> = {}): MockEvaluationInput => ({
  method: "GET", target: "/items/item-7", headers: {}, body: new Uint8Array(), ...changes,
});
function compile(project = createMockConfiguredProject(), maxResponseBytes?: number): CompileProjectMockResult {
  return compileProjectMock(
    createProjectSnapshot(project), maxResponseBytes === undefined ? undefined : { maxResponseBytes },
  );
}
function plan(project = createMockConfiguredProject()): CompiledMockPlan {
  const result = compile(project);
  if (!result.ok) throw new Error(`Fixture compile failed: ${result.diagnostics.map((item) => item.code).join(",")}`);
  return result.plan;
}
function textPlan(text: string) {
  const project = createMockConfiguredProject();
  const response = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.responses[0]!;
  if (response.kind !== "inline") throw new Error("inline fixture required");
  response.content = { "text/plain": { examples: [] } };
  project.mock.rules[0]!.mediaType = "text/plain";
  project.mock.rules[0]!.source = { kind: "literal", text };
  return project;
}

describe("transport-independent Mock evaluation", () => {
  // M01 is an honest already-green baseline, not rejection RED evidence.
  it("returns the existing no-route response for duplicated query on an absent route", () => {
    expect(evaluateMock({ sourceProjectRevision: "r1", routes: [] }, request({ target: "/not-present?q=1&q=2" })))
      .toMatchObject({ status: 404, reason: "NO_ROUTE", delayMs: 0 });
  });
  // Break caught: ignoring one condition source, choosing wrong duplicate query, or re-generating bytes.
  it("selects the rule using path, duplicated query, header case, and JSON pointer", () => {
    const project = createMockConfiguredProject();
    project.mock.rules[0]!.conditions = [
      { source: "path", op: "equals", name: "id", value: "item-7" },
      { source: "query", op: "equals", name: "q", value: "second" },
      { source: "header", op: "equals", name: "X-Mode", value: "public" },
      { source: "body", op: "equals", pointer: "/a~1b/0", value: true },
    ];
    const result = evaluateMock(plan(project), request({ target: "/items/item-7?q=first&q=second", headers: { "x-mode": "public" }, body: new TextEncoder().encode('{"a/b":[true]}') }));
    expect.soft(result).toMatchObject({ status: 200, ruleId: mockFixtureIds.rule, routeTemplate: "/items/{id}", reason: "MATCHED", mediaType: "application/json", headers: { "X-Mock-Fixture": "fixed" } });
    expect.soft(new TextDecoder().decode(result.body)).toBe('{"id":"item-7"}');
  });
  // Each case reaches a distinct existing matcher failure branch.
  it.each([
    ["/items/%ZZ", 400, "MALFORMED_PATH_ENCODING"],
    ["https://target.invalid/items/item-7", 400, "MALFORMED_REQUEST_TARGET"],
  ])("rejects target %s with %i/%s", (target, status, reason) => {
    expect(evaluateMock(plan(), request({ target }))).toMatchObject({ status, reason });
  });
  it("reports an unmatched rule without selecting the default by accident", () => {
    const project = createMockConfiguredProject();
    project.mock.rules[0]!.conditions = [{ source: "query", op: "exists", name: "required" }];
    expect(evaluateMock(plan(project), request())).toMatchObject({ status: 501, reason: "NO_RULE_MATCH", routeTemplate: "/items/{id}" });
  });
  it.each(["HEAD", "GET-204", "GET-304"])("suppresses compiled response bytes for %s", (mode) => {
    const source = plan();
    const method = mode === "HEAD" ? "HEAD" : "GET";
    const status = mode === "GET-204" ? 204 : mode === "GET-304" ? 304 : 200;
    const route = source.routes[0]!;
    const changed: CompiledMockPlan = { ...source, routes: [{ ...route, method, rules: [{ ...route.rules[0]!, status }] }] };
    const result = evaluateMock(changed, request({ method }));
    expect.soft(result.status).toBe(status);
    expect.soft(result.body).toEqual(new Uint8Array());
  });
  it("returns configured delay with literal bytes without waiting or interpolating", () => {
    const project = textPlan("中文 {{literal}}\n");
    project.mock.rules[0]!.delayMs = 30_000;
    const result = evaluateMock(plan(project), request());
    expect.soft(result).toMatchObject({ status: 200, delayMs: 30_000, reason: "MATCHED" });
    expect.soft(new TextDecoder().decode(result.body)).toBe("中文 {{literal}}\n");
  });
  it("uses fixed schema-generated seed bytes across evaluations", () => {
    const project = createMockConfiguredProject();
    project.mock.rules[0]!.source = { kind: "schema" };
    const compiled = plan(project);
    const one = evaluateMock(compiled, request());
    const two = evaluateMock(compiled, request());
    expect.soft(one.status).toBe(200);
    expect.soft([...one.body]).toEqual(compiled.routes[0]!.rules[0]!.body);
    expect.soft(two.body).toEqual(one.body);
  });
});

describe("compiled response byte budget", () => {
  // Break caught: cap is ignored, or Chinese character count replaces UTF-8 byte count.
  it("accepts 1023 UTF-8 bytes at cap and rejects 1026 bytes above 1024", () => {
    expect(compile(textPlan("中".repeat(341)), 1024).ok).toBe(true);
    const result = compile(textPlan("中".repeat(342)), 1024);
    expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "MOCK_RESPONSE_TOO_LARGE", path: "mock.rules[0].source", ownerId: mockFixtureIds.rule })] });
  });
  it("accepts a response larger than the old local cap when explicitly allowed", () => {
    expect(compile(textPlan("x".repeat(1_048_577)), 1_048_577).ok).toBe(true);
  });
  it("retains the omitted local default of 1 MiB", () => {
    expect(compile(textPlan("x".repeat(1_048_576))).ok).toBe(true);
    expect(compile(textPlan("x".repeat(1_048_577)))).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "MOCK_RESPONSE_TOO_LARGE" })] });
  });
  it.each([1023, 8_388_609, 1024.5, Number.NaN])("rejects invalid explicit shared response cap %s", (cap) => {
    expect(compile(textPlan("ok"), cap)).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "MOCK_RESPONSE_LIMIT_INVALID", path: "options.maxResponseBytes" })] });
  });
  it.each([1024, 8_388_608])("accepts shared response cap endpoint %s", (cap) => {
    expect(compile(textPlan("ok"), cap).ok).toBe(true);
  });
  it("rejects an explicitly null byte limit rather than treating it as omitted", () => {
    const result = Reflect.apply(compileProjectMock, undefined, [createProjectSnapshot(textPlan("ok")), { maxResponseBytes: null }]) as CompileProjectMockResult;
    expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "MOCK_RESPONSE_LIMIT_INVALID" })] });
  });
});
