import { describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { compileProjectMock, type CompiledMockPlan } from "../../src/mock/compile.js";
import { validateSharedMock } from "../../src/collaboration/policy.js";
import { CompiledMockPlanSchema, MockDiagnosticSchema, SharedMockPolicySchema } from "../../src/collaboration/shared.js";
import type { SharedMockPolicy } from "../../src/collaboration/types.js";
import { createMockConfiguredProject } from "../helpers/mockFixtures.js";
import { policy } from "./fixtures.js";

const sharedPolicy: SharedMockPolicy = { maxResponseBytes: 1024, maxDelayMs: 30_000, requestDeadlineMs: 35_000,
  extraSensitiveHeaders: policy.extraSensitiveHeaders, extraSensitiveQuery: policy.extraSensitiveQuery,
  extraSensitiveFields: policy.extraSensitiveFields, extraSensitivePointers: policy.extraSensitivePointers };
function plan(): CompiledMockPlan {
  const project = createMockConfiguredProject();
  const response = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.responses[0]!;
  if (response.kind !== "inline") throw new Error("inline fixture required");
  // The old local fixture deliberately contains ignored Content-Length; a safe
  // shared declaration must not depend on silent removal of that control header.
  delete response.headers["Content-Length"];
  const result = compileProjectMock(createProjectSnapshot(project));
  if (!result.ok) throw new Error("valid local Mock fixture required");
  return structuredClone(result.plan);
}

describe("shared Mock publication rejects unsafe dependencies without dropping rules", () => {
  it("accepts unchanged safe static declarations and literal template-looking bytes", () => {
    const input = plan(); input.routes[0]!.rules[0]!.body = [...new TextEncoder().encode("{{literal}}")];
    expect(validateSharedMock(input, sharedPolicy)).toEqual([]);
  });
  it("retains filtered source header names so real compile-to-preview cannot silently accept them", () => {
    const project = createMockConfiguredProject();
    const response = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.responses[0]!;
    if (response.kind !== "inline") throw new Error("inline fixture required");
    response.headers = { Connection: "X-Removed", "X-Removed": "private-value" };
    const compiled = compileProjectMock(createProjectSnapshot(project));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("source compile precondition failed");
    expect.soft(compiled.plan.routes[0]!.rules[0]).toHaveProperty("excludedResponseHeaders", ["Connection", "X-Removed"]);
    expect.soft(validateSharedMock(compiled.plan, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_RESPONSE_HEADER_FORBIDDEN", path: "routes[0].rules[0].headers.Connection" }));
  });
  it.each(["Authorization", "Cookie", "Proxy-Authorization", "X-Apicc-Token", "X-Private"])("rejects a rule depending on stripped header %s with its field location", (name) => {
    const input = plan(); const rule = input.routes[0]!.rules[0]!;
    rule.conditions = [{ source: "header", op: "equals", name, value: "secret" }];
    const before = structuredClone(input);
    expect.soft(validateSharedMock(input, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_SENSITIVE_CONDITION", path: "routes[0].rules[0].conditions[0].name", ownerId: rule.id }));
    expect.soft(input).toEqual(before);
  });
  it.each(["X-Apicc-Mock-Key", "X-Apicc-Share-Key"])("rejects dedicated control key dependency %s", (name) => {
    const input = plan(); const rule = input.routes[0]!.rules[0]!;
    rule.conditions = [{ source: "header", op: "exists", name }];
    expect(validateSharedMock(input, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_SENSITIVE_CONDITION", path: "routes[0].rules[0].conditions[0].name", ownerId: rule.id }));
  });
  it.each(["query", "field", "pointer"])("rejects configured sensitive %s matching", (kind) => {
    const input = plan(); const rule = input.routes[0]!.rules[0]!;
    rule.conditions = kind === "query" ? [{ source: "query", op: "exists", name: "access" }] : [{ source: "body", op: "exists", pointer: kind === "field" ? "/privateField" : "/nested/secret" }];
    expect(validateSharedMock(input, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_SENSITIVE_CONDITION", ownerId: rule.id }));
  });
  it.each(["X-Api-Key", "X-Auth-Token"])("rejects conventional credential header dependency %s", (name) => {
    const input = plan(); input.routes[0]!.rules[0]!.conditions = [{ source: "header", op: "exists", name }];
    expect(validateSharedMock(input, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_SENSITIVE_CONDITION" }));
  });
  it("rejects a condition on a descendant of a sensitive JSON pointer", () => {
    const input = plan(); input.routes[0]!.rules[0]!.conditions = [{ source: "body", op: "exists", pointer: "/nested/privateArea/child" }];
    expect(validateSharedMock(input, { ...sharedPolicy, extraSensitivePointers: ["/nested/privateArea"] })).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_SENSITIVE_CONDITION" }));
  });
  it.each(["Authorization", "X-Private"])("rejects a sensitive response header %s", (name) => {
    const input = plan(); input.routes[0]!.rules[0]!.headers = { [name]: "PRIVATE-VALUE" };
    expect(validateSharedMock(input, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_RESPONSE_HEADER_FORBIDDEN" }));
  });
  it("rejects sensitive material retained in an otherwise ordinary response header", () => {
    const input = plan(); input.routes[0]!.rules[0]!.headers = { "X-Public": "Bearer PRIVATE-HEADER-VALUE" };
    expect(validateSharedMock(input, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_SENSITIVE_MATERIAL", path: "routes[0].rules[0].headers.X-Public" }));
  });
  it.each(["Set-Cookie", "Location", "Connection", "Transfer-Encoding", "Content-Length", "Access-Control-Allow-Origin", "Content-Security-Policy", "Strict-Transport-Security", "X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy", "Cross-Origin-Resource-Policy"])("rejects response override %s at preview", (name) => {
    const input = plan(); const rule = input.routes[0]!.rules[0]!; rule.headers = { [name]: "unsafe" };
    expect(validateSharedMock(input, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_RESPONSE_HEADER_FORBIDDEN", path: `routes[0].rules[0].headers.${name}`, ownerId: rule.id }));
  });
  it.each(["Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "TE", "Trailer", "Upgrade"])("rejects remaining standard hop-by-hop response header %s", (name) => {
    const input = plan(); const rule = input.routes[0]!.rules[0]!; rule.headers = { [name]: "unsafe" };
    expect(validateSharedMock(input, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_RESPONSE_HEADER_FORBIDDEN", path: `routes[0].rules[0].headers.${name}`, ownerId: rule.id }));
  });
  it.each(["scripts", "forward", "attachments"])("rejects unknown executable/source material %s in a compiled rule", (key) => {
    const input = plan(); const rule = input.routes[0]!.rules[0]!;
    Object.assign(rule, { [key]: key === "scripts" ? "pm.sendRequest('https://target.invalid')" : "C:\\Users\\private\\file.bin" });
    expect.soft(CompiledMockPlanSchema.safeParse(input).success).toBe(false);
    expect.soft(validateSharedMock(input, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_PLAN_INVALID", path: `routes[0].rules[0].${key}` }));
  });
  it.each(["runtime-secret", "windows-path", "posix-path", "configured-field", "configured-pointer"])("rejects compiled response containing %s", (kind) => {
    const input = plan();
    const values: Record<string, string> = { "runtime-secret": "{{credential:private}}", "windows-path": "C:\\Users\\private\\file.bin", "posix-path": "/home/private/file.bin", "configured-field": '{"privateField":"SECRET"}', "configured-pointer": '{"nested":{"secret":"SECRET"}}' };
    input.routes[0]!.rules[0]!.body = [...new TextEncoder().encode(values[kind]!)];
    expect(validateSharedMock(input, sharedPolicy)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_SENSITIVE_MATERIAL", path: "routes[0].rules[0].body" }));
  });
  it("checks the actual response byte cap and enabled delay against deadline", () => {
    const input = plan(); const rule = input.routes[0]!.rules[0]!;
    rule.body = Array(1025).fill(120); rule.delayMs = 1000;
    expect.soft(validateSharedMock(input, { ...sharedPolicy, maxDelayMs: 999 })).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_RESPONSE_TOO_LARGE", path: "routes[0].rules[0].body" }));
    expect.soft(validateSharedMock(input, { ...sharedPolicy, maxDelayMs: 999 })).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_DELAY_LIMIT", path: "routes[0].rules[0].delayMs" }));
    expect.soft(validateSharedMock(input, { ...sharedPolicy, requestDeadlineMs: 1000 })).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_DEADLINE_INVALID", path: "routes[0].rules[0].delayMs" }));
  });
  it.each([
    ["maxResponseBytes", 1023], ["maxResponseBytes", 8388609], ["maxResponseBytes", 1024.5],
    ["maxDelayMs", -1], ["maxDelayMs", 30001], ["requestDeadlineMs", 999], ["requestDeadlineMs", 120001],
  ])("rejects invalid shared budget %s=%s", (key, value) => {
    const next = { ...sharedPolicy, [key]: value };
    expect.soft(SharedMockPolicySchema.safeParse(next).success).toBe(false);
    expect.soft(validateSharedMock(plan(), next)).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_POLICY_INVALID", path: `policy.${key}` }));
  });
  it.each(["byte", "status", "delay", "method"])("rejects malformed compiled %s values", (kind) => {
    const input = plan(); const rule = input.routes[0]!.rules[0]!;
    if (kind === "byte") rule.body = [256]; if (kind === "status") rule.status = 99; if (kind === "delay") rule.delayMs = 30001; if (kind === "method") input.routes[0]!.method = "CONNECT";
    expect.soft(CompiledMockPlanSchema.safeParse(input).success).toBe(false);
    expect.soft(validateSharedMock(input, sharedPolicy).some((item) => item.code === "SHARED_MOCK_PLAN_INVALID")).toBe(true);
  });
  it("rejects unknown administrator escape hatches and unknown diagnostic bags", () => {
    expect.soft(SharedMockPolicySchema.safeParse({ ...sharedPolicy, allowUnsafe: true }).success).toBe(false);
    expect.soft(MockDiagnosticSchema.safeParse({ severity: "error", code: "REFUSED", path: "rule", message: "拒绝原因", lossy: false, raw: { token: "PRIVATE" } }).success).toBe(false);
  });
});
