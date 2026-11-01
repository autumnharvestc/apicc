import { describe, expect, it } from "vitest";
import { resolveAiInvocation } from "../../src/ai/config.js";
import { validateAiInputBudget } from "../../src/ai/budgets.js";
import { fixture as typedFixture } from "./config.fixture.js";
const fixture = (): any => typedFixture();

describe("resource and complete input budgets", () => {
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid local token count %s (retrospective protection coverage)", count => {
    const invocation = resolveAiInvocation({ document: fixture(), purpose: "case-suggestion" });
    expect(() => validateAiInputBudget(invocation, { messages: [] }, () => count)).toThrowError(expect.objectContaining({ code: "invalid-token-count", field: "inputTokens", source: "local-counter" }));
  });
  it("enforces the independent input usage budget before the larger model capacity (retrospective protection coverage)", () => {
    const invocation = resolveAiInvocation({ document: fixture(), purpose: "case-suggestion", overrides: { maxInputTokens: 100 } });
    expect(() => validateAiInputBudget(invocation, { messages: [] }, () => 101)).toThrowError(expect.objectContaining({ code: "budget-exceeded", field: "maxInputTokens", source: "input", allowed: 100 }));
  });
  it.each([
    ["deadlineMs", 9999], ["deadlineMs", 7200001], ["requestTimeoutMs", 9999], ["requestTimeoutMs", 3600001],
    ["maxRequests", 0], ["maxRequests", 11], ["transportRetries", 10], ["repairAttempts", 4],
    ["maxInputBytes", 4095], ["maxInputBytes", 4194305], ["maxInstructionBytes", 0], ["maxInstructionBytes", 1023], ["maxInstructionBytes", 65537],
    ["maxOutputBytes", 65535], ["maxOutputBytes", 33554433], ["maxOutputTokens", 15], ["candidateCount", 51],
    ["evidenceCount", 201], ["maxEventBytes", 16383], ["maxEventBytes", 4194305], ["maxStreamBytes", 1048575],
  ])("rejects invalid explicit %s=%d", (field, value) => {
    expect(() => resolveAiInvocation({ document: fixture(), purpose: "case-suggestion", overrides: { [field]: value } })).toThrowError(expect.objectContaining({ field }));
  });
  it("keeps shared host protection outside model overrides and allows reviewed advanced output protection", () => {
    const document = fixture();
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion", overrides: { hostConcurrency: 8 } as any })).toThrow();
    document.models[1].capabilities.maxOutputTokens = 524288;
    document.models[1].budgets = { maxOutputTokens: 300000, totalOutputTokens: 900000 };
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion", modelProfileId: "b" })).toThrowError(expect.objectContaining({ field: "maxOutputTokens", allowed: 262144 }));
    document.application.protection.maxOutputTokens = 524288;
    expect(resolveAiInvocation({ document, purpose: "case-suggestion", modelProfileId: "b" }).budgets?.maxOutputTokens).toBe(300000);
  });
  it("checks all system/schema/history/repair bytes and supplemental instruction", () => {
    const invocation = resolveAiInvocation({ document: fixture(), purpose: "case-suggestion", overrides: { maxInputBytes: 4096 } });
    const input = { messages: [{ role: "system" as const, content: "s".repeat(2000) }, { role: "user" as const, content: "repair".repeat(300) }], outputSchema: { description: "x".repeat(1000) }, instruction: "补充" };
    expect(() => validateAiInputBudget(invocation, input)).toThrowError(expect.objectContaining({ field: "maxInputBytes" }));
    expect(() => validateAiInputBudget(invocation, { messages: [], instruction: "中".repeat(3000) })).toThrowError(expect.objectContaining({ field: "maxInstructionBytes" }));
  });
  it("uses reliable local count for shared windows and independent input limits", () => {
    const document = fixture();
    document.models[0].capabilities.contextWindowTokens = 10000;
    const invocation = resolveAiInvocation({ document, purpose: "case-suggestion" });
    expect(() => validateAiInputBudget(invocation, { messages: [{ role: "user", content: "hello" }], outputSchema: { type: "object" } }, () => 1809)).toThrowError(expect.objectContaining({ field: "contextWindowTokens" }));
    document.models[0].capabilities.sharedContextWindow = false;
    document.models[0].capabilities.maxInputTokens = 1900;
    const independent = resolveAiInvocation({ document, purpose: "case-suggestion" });
    expect(validateAiInputBudget(independent, { messages: [] }, () => 1809)?.tokenStatus).toBe("exact");
    expect(() => validateAiInputBudget(independent, { messages: [] }, () => 1901)).toThrowError(expect.objectContaining({ field: "maxInputTokens" }));
  });
  it("reports unconfirmed tokens without a counter rather than inventing bytes-to-token precision", () => {
    const invocation = resolveAiInvocation({ document: fixture(), purpose: "case-suggestion" });
    expect(validateAiInputBudget(invocation, { messages: [{ role: "user", content: "中文" }] })).toMatchObject({ tokenStatus: "unconfirmed" });
    expect(validateAiInputBudget(invocation, { messages: [] })?.inputTokens).toBeUndefined();
  });
});
