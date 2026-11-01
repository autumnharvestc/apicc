import { describe, expect, it } from "vitest";
import { AiConfigDocumentSchema, AiConnectionSchema, resolveAiInvocation, createInitialAiModelBudgets } from "../../src/ai/config.js";
import { fixture as typedFixture } from "./config.fixture.js";
const fixture = (): any => typedFixture();

describe("layered invocation configuration", () => {
  it("rejects duplicate connection IDs (retrospective protection coverage)", () => {
    const document = fixture();
    document.connections.push({ ...document.connections[0] });
    const parsed = AiConfigDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ["connections"] }));
  });
  it("rejects duplicate personal project-purpose bindings (retrospective protection coverage)", () => {
    const document = fixture();
    document.projectOverrides = [{ projectKey: "same-project", purpose: "case-suggestion", budgets: {} }, { projectKey: "same-project", purpose: "case-suggestion", budgets: {} }];
    const parsed = AiConfigDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ["projectOverrides"] }));
  });
  it.each(["X-Client-Token", "x-client-token"])("rejects connection static header %s matching its declared secret slot", header => {
    const document = fixture();
    const connection = { ...document.connections[0], auth: { kind: "api-key", header: "X-Client-Token" }, headers: { [header]: "placeholder-only", "x-visible-version": "v1" }, credentialRef: "safe-ref" };
    const parsed = AiConnectionSchema.safeParse(connection);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ["headers", header] }));
  });
  // Would catch clipping every model together or mutating application defaults.
  it("limits only inherited application output and keeps model B independent", () => {
    const document = fixture();
    const a = resolveAiInvocation({ document, purpose: "case-suggestion" });
    const b = resolveAiInvocation({ document, purpose: "case-suggestion", modelProfileId: "b" });
    expect(a.budgets?.maxOutputTokens).toBe(8192);
    expect(a.sources?.maxOutputTokens).toMatchObject({ source: "application", limitedBy: "model", explanation: "继承应用默认，受模型限制" });
    expect(b.budgets?.maxOutputTokens).toBe(32768);
    expect(b.budgets?.maxInputBytes).toBe(1048576);
    expect(document.models[0].budgets).toEqual({});
  });
  it.each(["model", "purpose", "invocation"])("rejects explicit excess at %s with field and source", source => {
    const document = fixture();
    const overrides = source === "invocation" ? { maxOutputTokens: 9000 } : undefined;
    if (source === "model") document.models[0].budgets.maxOutputTokens = 9000;
    if (source === "purpose") document.bindings[0].budgets.maxOutputTokens = 9000;
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion", overrides })).toThrowError(expect.objectContaining({ code: "budget-exceeded", field: "maxOutputTokens", source, allowed: 8192 }));
  });
  it("resolves project, purpose, model-purpose and invocation partial overrides and restores inheritance", () => {
    const document = fixture();
    document.models[0].budgets.maxRequests = 4;
    document.models[0].purposeBudgets["case-suggestion"] = { candidateCount: 6 };
    document.bindings[0].budgets.candidateCount = 7;
    document.projectOverrides = [{ projectKey: "local:project", purpose: "case-suggestion", budgets: { candidateCount: 8 } }];
    const input = { document, purpose: "case-suggestion" as const, projectKey: "local:project" };
    expect(resolveAiInvocation({ ...input, overrides: { candidateCount: 9 } }).budgets?.candidateCount).toBe(9);
    expect(resolveAiInvocation(input).budgets?.candidateCount).toBe(8);
    document.projectOverrides = [];
    expect(resolveAiInvocation(input).budgets?.candidateCount).toBe(7);
    delete document.bindings[0].budgets.candidateCount;
    expect(resolveAiInvocation(input).budgets?.candidateCount).toBe(6);
    expect(resolveAiInvocation(input).budgets?.maxRequests).toBe(4);
  });
  it("keeps persisted total tokens when request count changes and rejects conflicting output", () => {
    const document = fixture();
    const result = resolveAiInvocation({ document, purpose: "case-suggestion", overrides: { maxRequests: 8 } });
    expect(result.budgets?.totalOutputTokens).toBe(49152);
    expect(result.warnings).toContain("请求次数超过 5，可能增加费用和等待时间");
    document.models[1].budgets.totalOutputTokens = 16384;
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion", modelProfileId: "b" })).toThrowError(expect.objectContaining({ field: "totalOutputTokens" }));
  });
  it("separates unknown capability from finite usage and reasoning defaults from names", () => {
    const document = fixture();
    document.models[0].capabilities = { status: "unconfirmed", source: "manual" };
    document.models[0].modelId = "reasoning-brand-name";
    const result = resolveAiInvocation({ document, purpose: "case-suggestion" });
    expect(result.capabilityStatus).toBe("unconfirmed");
    expect(result.budgets?.maxInputBytes).toBe(262144);
    expect(result.budgets?.maxOutputTokens).toBe(16384);
    document.models[0].capabilities = { status: "confirmed", source: "manual", outputIncludesReasoning: true, maxOutputTokens: 65536 };
    document.models[0].budgets = createInitialAiModelBudgets(document.models[0].capabilities);
    expect(resolveAiInvocation({ document, purpose: "case-suggestion" }).budgets?.maxOutputTokens).toBe(32768);
  });
  it("returns a fixed snapshot and normalizes gateway prefixes", () => {
    const document = fixture();
    const result = resolveAiInvocation({ document, purpose: "case-suggestion" });
    document.models[0].modelId = "changed";
    expect(result.model?.modelId).toBe("real-a");
    expect(result.connection?.baseUrl).toBe("https://example.com/gateway/v1");
  });
  it("rejects identity overrides and persisted credentials", () => {
    const document = fixture();
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion", overrides: { modelId: "sneak" } as any })).toThrow();
    document.connections[0].apiKey = "must-not-persist";
    expect(AiConfigDocumentSchema.safeParse(document).success).toBe(false);
  });
  it.each([
    { name: "dangling purpose model", mutate: (d: any) => { d.bindings[0].modelProfileId = "missing"; } },
    { name: "unsupported connection protocol", mutate: (d: any) => { d.models[0].protocol = "anthropic-messages"; } },
    { name: "duplicate model ID", mutate: (d: any) => { d.models.push(d.models[0]); } },
  ])("rejects $name (named regression)", ({ mutate }) => {
    const document = fixture(); mutate(document);
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion" })).toThrow();
  });
  it("requires confirmed capabilities before larger model budgets", () => {
    const document = fixture();
    document.models[0].capabilities = { status: "unconfirmed", source: "manual" };
    document.models[0].budgets = { maxOutputTokens: 32768, totalOutputTokens: 98304 };
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion" })).toThrowError(expect.objectContaining({ code: "capability-unconfirmed", field: "maxOutputTokens", source: "model" }));
  });
  it("reports invalid model range with model source rather than document source", () => {
    const document = fixture(); document.models[0].budgets.maxInputBytes = 4194305;
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion" })).toThrowError(expect.objectContaining({ field: "maxInputBytes", source: "model", allowed: expect.any(String) }));
  });
  it.each([
    { name: "dormant connection reference", mutate: (d: any) => { d.models[1].connectionId = "gone"; } },
    { name: "duplicate purpose binding", mutate: (d: any) => { d.bindings.push(d.bindings[0]); } },
    { name: "dangling project model", mutate: (d: any) => { d.projectOverrides.push({ projectKey: "p", purpose: "case-suggestion", modelProfileId: "gone", budgets: {} }); } },
  ])("validates $name before saving (named regression)", ({ mutate }) => {
    const document = fixture(); mutate(document);
    expect(AiConfigDocumentSchema.safeParse(document).success).toBe(false);
  });
  it("defaults an omitted streaming choice to true (additional regression)", () => {
    const document = fixture(); delete document.models[0].streaming;
    expect(resolveAiInvocation({ document, purpose: "case-suggestion" }).model.streaming).toBe(true);
  });
  it("rejects an unregistered supported parameter (additional regression)", () => {
    const document = fixture(); document.models[0].supportedParameters = ["raw-provider-body"];
    expect(AiConfigDocumentSchema.safeParse(document).success).toBe(false);
  });
  it("initializes new reasoning budgets once while preserving purpose-specific defaults", () => {
    const document = fixture();
    document.models[0].capabilities = { status: "confirmed", source: "manual", outputIncludesReasoning: true, maxOutputTokens: 65536 };
    document.models[0].budgets = createInitialAiModelBudgets(document.models[0].capabilities);
    document.bindings = [
      { purpose: "case-suggestion", modelProfileId: "a", budgets: {} },
      { purpose: "assertion-suggestion", modelProfileId: "a", budgets: {} },
      { purpose: "report-analysis", modelProfileId: "a", budgets: {} },
    ];
    const cases = resolveAiInvocation({ document, purpose: "case-suggestion" });
    const assertions = resolveAiInvocation({ document, purpose: "assertion-suggestion" });
    const reports = resolveAiInvocation({ document, purpose: "report-analysis" });
    expect(cases.budgets).toMatchObject({ maxOutputTokens: 32768, totalOutputTokens: 98304, deadlineMs: 600000, candidateCount: 5 });
    expect(assertions.budgets).toMatchObject({ maxOutputTokens: 32768, totalOutputTokens: 98304, deadlineMs: 300000, candidateCount: 10 });
    expect(reports.budgets).toMatchObject({ maxOutputTokens: 32768, totalOutputTokens: 98304, deadlineMs: 900000, evidenceCount: 20 });
    document.models[0].budgets.maxOutputTokens = 131072;
    document.models[0].capabilities.maxOutputTokens = 262144;
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion" })).toThrowError(expect.objectContaining({ field: "totalOutputTokens", source: "model" }));
    expect(document.models[0].budgets.totalOutputTokens).toBe(98304);
  });
  it("restores application inheritance when an optional application field is cleared", () => {
    const document = fixture();
    document.application.purposeDefaults["case-suggestion"].maxRequests = undefined;
    expect(resolveAiInvocation({ document, purpose: "case-suggestion" }).budgets.maxRequests).toBe(3);
  });
  it("reports capability confirmation per field", () => {
    const document = fixture();
    const resolved = resolveAiInvocation({ document, purpose: "case-suggestion" });
    expect(resolved.capabilityConfirmation).toEqual({ contextWindowTokens: "confirmed", maxInputTokens: "unconfirmed", maxOutputTokens: "confirmed", sharedContextWindow: "confirmed", outputIncludesReasoning: "confirmed" });
  });
  it("refuses larger output when the confirmed model has no output capacity declaration", () => {
    const document = fixture();
    delete document.models[0].capabilities.maxOutputTokens;
    document.models[0].budgets = { maxOutputTokens: 32768, totalOutputTokens: 98304 };
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion" })).toThrowError(expect.objectContaining({ code: "capability-unconfirmed", field: "maxOutputTokens" }));
  });
  it("does not change persisted single or total budgets when capability accounting changes", () => {
    const document = fixture();
    document.models[0].capabilities.maxOutputTokens = 65536;
    document.models[0].capabilities.outputIncludesReasoning = true;
    const resolved = resolveAiInvocation({ document, purpose: "case-suggestion" });
    expect(resolved.budgets).toMatchObject({ maxOutputTokens: 16384, totalOutputTokens: 49152 });
    expect(document.application.purposeDefaults["case-suggestion"]).toMatchObject({ maxOutputTokens: 16384, totalOutputTokens: 49152 });
  });
  it.each(["model", "purpose", "project"])("does not hide invalid explicit %s configuration beneath a valid invocation override", source => {
    const document = fixture();
    if (source === "model") document.models[0].budgets.maxOutputTokens = 9000;
    if (source === "purpose") document.bindings[0].budgets.maxOutputTokens = 9000;
    if (source === "project") document.projectOverrides = [{ projectKey: "p", purpose: "case-suggestion", budgets: { maxOutputTokens: 9000 } }];
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion", projectKey: "p", overrides: { maxOutputTokens: 8000 } })).toThrowError(expect.objectContaining({ field: "maxOutputTokens", source, allowed: 8192 }));
  });
  it.each([
    { name: "output-only confirmed model with 1 MiB input", capabilities: { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536 }, budgets: { maxInputBytes: 1048576 }, field: "maxInputBytes", allowed: 262144 },
    { name: "output-only confirmed model with 1000000 input tokens", capabilities: { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536 }, budgets: { maxInputTokens: 1000000 }, field: "maxInputTokens", allowed: expect.stringContaining("补充") },
    { name: "unknown input capacity even for one explicit input token", capabilities: { status: "unconfirmed", source: "synthetic fixture" }, budgets: { maxInputTokens: 1 }, field: "maxInputTokens", allowed: expect.stringContaining("补充") },
    { name: "window size without shared accounting", capabilities: { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, contextWindowTokens: 131072 }, budgets: { maxInputBytes: 1048576 }, field: "maxInputBytes", allowed: 262144 },
    { name: "separate accounting without independent input capacity", capabilities: { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, contextWindowTokens: 131072, sharedContextWindow: false }, budgets: { maxInputBytes: 1048576 }, field: "maxInputBytes", allowed: 262144 },
    { name: "shared accounting without window capacity", capabilities: { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, sharedContextWindow: true }, budgets: { maxInputBytes: 1048576 }, field: "maxInputBytes", allowed: 262144 },
  ])("requires confirmed input capacity: $name", ({ capabilities, budgets, field, allowed }) => {
    const document = fixture();
    document.models[0].capabilities = capabilities;
    document.models[0].budgets = budgets;
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion" })).toThrowError(expect.objectContaining({ code: "capability-unconfirmed", field, source: "model", allowed }));
  });
  it("does not hide an unconfirmed large model input budget beneath an invocation override", () => {
    const document = fixture();
    document.models[0].capabilities = { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536 };
    document.models[0].budgets = { maxInputBytes: 1048576 };
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion", overrides: { maxInputBytes: 262144 } })).toThrowError(expect.objectContaining({ code: "capability-unconfirmed", field: "maxInputBytes", source: "model" }));
  });
  it.each([
    { name: "independent input capacity", capacity: { maxInputTokens: 131072 } },
    { name: "explicit shared window", capacity: { sharedContextWindow: true, contextWindowTokens: 131072 } },
  ])("keeps a legitimate large input budget with $name", ({ capacity }) => {
    const document = fixture();
    document.models[0].capabilities = { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, ...capacity };
    document.models[0].budgets = { maxInputBytes: 1048576, maxInputTokens: 65536 };
    expect(resolveAiInvocation({ document, purpose: "case-suggestion" }).budgets).toMatchObject({ maxInputBytes: 1048576, maxInputTokens: 65536 });
  });
  it("keeps finite conservative bytes and an omitted token budget when input capacity is unknown", () => {
    const document = fixture();
    document.models[0].capabilities = { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536 };
    const resolved = resolveAiInvocation({ document, purpose: "case-suggestion" });
    expect(resolved.budgets.maxInputBytes).toBe(262144);
    expect(resolved.budgets.maxInputTokens).toBeUndefined();
    expect(resolved.capabilityConfirmation.maxInputTokens).toBe("unconfirmed");
  });
  it.each(["model", "purpose", "project", "invocation"])("rejects explicit %s input tokens beyond confirmed shared window minus effective reserved output", source => {
    const document = fixture();
    document.models[0].capabilities = { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, sharedContextWindow: true, contextWindowTokens: 50000 };
    if (source === "model") document.models[0].budgets = { maxInputTokens: 40000 };
    if (source === "purpose") document.bindings[0].budgets = { maxInputTokens: 40000 };
    if (source === "project") document.projectOverrides = [{ projectKey: "p", purpose: "case-suggestion", budgets: { maxInputTokens: 40000 } }];
    const overrides = source === "invocation" ? { maxInputTokens: 40000 } : undefined;
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion", projectKey: "p", overrides })).toThrowError(expect.objectContaining({ code: "budget-exceeded", field: "maxInputTokens", source, allowed: 33616 }));
  });
  it.each(["application", "model", "invocation"])("rejects effective %s output reservation beyond the confirmed shared window", source => {
    const document = fixture();
    document.models[0].capabilities = { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, sharedContextWindow: true, contextWindowTokens: 10000 };
    if (source === "model") document.models[0].budgets.maxOutputTokens = 16384;
    const overrides = source === "invocation" ? { maxOutputTokens: 16384 } : undefined;
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion", overrides })).toThrowError(expect.objectContaining({ code: "budget-exceeded", field: "maxOutputTokens", source, allowed: 10000 }));
  });
  it("does not hide a model input reservation exceeding shared capacity beneath a smaller invocation budget", () => {
    const document = fixture();
    document.models[0].capabilities = { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, sharedContextWindow: true, contextWindowTokens: 50000 };
    document.models[0].budgets.maxInputTokens = 40000;
    expect(() => resolveAiInvocation({ document, purpose: "case-suggestion", overrides: { maxInputTokens: 30000 } })).toThrowError(expect.objectContaining({ field: "maxInputTokens", source: "model", allowed: 33616 }));
  });
  it("uses the capability-limited effective output when calculating the shared input allowance", () => {
    const document = fixture();
    document.models[0].capabilities.contextWindowTokens = 50000;
    expect(resolveAiInvocation({ document, purpose: "case-suggestion", overrides: { maxInputTokens: 40000 } }).budgets).toMatchObject({ maxOutputTokens: 8192, maxInputTokens: 40000 });
  });
  it("accepts the exact shared input allowance without inventing an input usage budget when omitted", () => {
    const document = fixture();
    document.models[0].capabilities = { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, sharedContextWindow: true, contextWindowTokens: 50000 };
    expect(resolveAiInvocation({ document, purpose: "case-suggestion", overrides: { maxInputTokens: 33616 } }).budgets.maxInputTokens).toBe(33616);
    expect(resolveAiInvocation({ document, purpose: "case-suggestion" }).budgets.maxInputTokens).toBeUndefined();
  });
  it("does not add output to a separately limited confirmed input capacity", () => {
    const document = fixture();
    document.models[0].capabilities = { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, maxInputTokens: 60000, sharedContextWindow: false, contextWindowTokens: 50000 };
    expect(resolveAiInvocation({ document, purpose: "case-suggestion", overrides: { maxInputTokens: 40000 } }).budgets).toMatchObject({ maxOutputTokens: 16384, maxInputTokens: 40000 });
  });
  it("derives inherited application input tokens from confirmed shared capacity with a visible model limit", () => {
    const document = fixture();
    document.models[0].capabilities = { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, sharedContextWindow: true, contextWindowTokens: 50000 };
    document.application.purposeDefaults["case-suggestion"].maxInputTokens = 40000;
    const resolved = resolveAiInvocation({ document, purpose: "case-suggestion" });
    expect(resolved.budgets.maxInputTokens).toBe(33616);
    expect(resolved.sources.maxInputTokens).toMatchObject({ source: "application", limitedBy: "model", explanation: "继承应用默认，受模型限制" });
  });
});
