import { describe, expect, it } from "vitest";
import type { PluginContributionV1, PluginManifestV1, ReportViewV1, RequestViewV1 } from "@apicc/plugin-sdk";
import { createPluginCatalog } from "../../src/plugin/catalog.js";
import { installSdkContributions } from "../../src/plugin/sdkAdapter.js";
import { createDefaultRegistry } from "../../src/shared.js";
import type { ExecutableRequest, ExecutionResponse, ProtocolClient } from "../../src/plugin/types.js";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { createCredentialOutputSanitizer } from "../../src/credentials/output.js";
import type { RunResult } from "../../src/report/types.js";
import { compileCaseAssertions, evaluateCaseAssertions } from "../../src/assert/evaluate.js";
import { createVariableResolver } from "../../src/variables/resolver.js";

const request = (): ExecutableRequest => ({ protocol: "http", method: "GET", url: "https://example.test", headers: { Authorization: "old" }, query: [], auth: { kind: "bearer", token: "secret" } });
const response: ExecutionResponse = { status: 201, headers: {}, bodyText: "real", timeMs: 12, bodyBytes: new Uint8Array([65]), encodedBytes: 1 };
function fixture(contributions: PluginContributionV1[]) {
  const catalog = createPluginCatalog();
  const manifest: PluginManifestV1 = { manifestVersion: 1, id: "example.demo", name: "demo", version: "0.1.0", apiVersion: 1,
    engines: { apicc: ">=0.1.0 <0.2.0" }, entry: "./dist/index.js", capabilities: [...new Set(contributions.map(c => c.kind))], contributions: contributions.map(({ kind, id }) => ({ kind, id })) };
  const tx = catalog.begin(manifest, {});
  contributions.forEach(c => tx.context.register(c));
  tx.commit();
  return catalog;
}

describe("SDK host adapters", () => {
  it("uses assertion descriptors and detached JSON/model views in the real assertion path", () => {
    const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0].projects[0];
    const snapshot = createProjectSnapshot(project);
    const modelId = project.models[0].id;
    const catalog = fixture([{ kind: "assert", id: "example.demo/assert.model", descriptor: { targets: ["bodyJson"], expectedFormat: "json", expectedRequired: true },
      evaluate(actual, expected, context) {
        expect(context).not.toHaveProperty("assets"); expect(context).not.toHaveProperty("regex");
        expect(context.getModel(modelId)).toEqual(project.models[0]);
        expect(Object.isFrozen(context.getModel(modelId))).toBe(true);
        expect(Object.isFrozen(actual)).toBe(true);
        return { pass: context.found && expected === "yes", message: "model available", code: "DEMO" };
      } }]);
    const registry = createDefaultRegistry(); installSdkContributions(registry, catalog, {});
    const op = registry.getAssert("example.demo/assert.model")!;
    expect(op.descriptor).toEqual({ targets: ["bodyJson"], expectedFormat: "json", expectedRequired: true });
    expect(op.evaluate({ value: 1 }, "yes", { assets: snapshot.context, found: true })).toEqual({ pass: true, message: "model available", code: "DEMO" });
    const testCase = project.collections[0].apis[0].cases[0];
    const compiled = compileCaseAssertions({ ...testCase, assertions: [{ id: "sdk", op: op.op, target: "bodyJson", expected: "yes" }] }, snapshot.context, registry);
    expect(compiled.diagnostics).toEqual([]);
    expect(evaluateCaseAssertions(compiled, { ...response, bodyText: "{}" }, createVariableResolver({ layers: [] }))[0].pass).toBe(true);
  });

  it("validates imported projects and preserves host graph diagnostics", () => {
    const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0].projects[0];
    project.models[0].schema = { kind: "modelRef", modelId: "00000000-0000-4000-8000-999999999999" };
    let invalid = false;
    const catalog = fixture([{ kind: "importer", id: "example.demo/importer.demo", detect: name => name.endsWith(".demo"),
      parse: () => ({ formatVersion: 1, project: invalid ? {} : project as never, diagnostics: [], warnings: ["demo"] }) }]);
    const registry = createDefaultRegistry(); installSdkContributions(registry, catalog, {});
    const importer = registry.listImporters().find(i => i.name === "example.demo/importer.demo")!;
    expect(importer.detect("x.demo", "")).toBe(true);
    const parsed = importer.parse("");
    expect(parsed.project).not.toBe(project); expect(parsed.warnings).toEqual(["demo"]);
    expect(parsed.diagnostics.some(d => d.code === "ASSET_REFERENCE_MISSING")).toBe(true);
    invalid = true; expect(() => importer.parse("")).toThrow();
  });

  it("projects safe report rows separately from logical verdict and optional request facts", async () => {
    let received: Readonly<ReportViewV1> | undefined;
    const catalog = fixture([{ kind: "reporter", id: "example.demo/reporter.demo", async render(view) { received = view; return "result.demo"; } }]);
    const registry = createDefaultRegistry();
    installSdkContributions(registry, catalog, {});
    const output = { boundary: createCredentialOutputSanitizer(["secret"]) };
    const result: RunResult = { collectionId: "x", collectionName: "secret", startedAt: "a", finishedAt: "b", total: 1, passed: 0, failed: 1,
      reportingMode: "workflow-invocation-v2", workflowUnits: [{ entryId: "e", workflowId: "w", verdict: "passed" }],
      requestFacts: { requestStarted: 0, requestCompleted: 0, httpExchanges: 0 },
      cases: [{ apiId: "a", apiName: "secret", caseId: "c", caseName: "case", passed: false, durationMs: 1, assertions: [], error: "secret" }] };
    expect(await registry.getReporter("example.demo/reporter.demo")!.render(result, ".", output)).toBe("result.demo");
    expect(received?.rows).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0 });
    expect(received?.logical).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(received?.requestFacts).toEqual({ started: 0, completed: 0, httpExchanges: 0 });
    expect(JSON.stringify(received)).not.toContain("secret");
    expect(result.cases[0].error).toBe("secret");
    delete result.requestFacts;
    await registry.getReporter("example.demo/reporter.demo")!.render(result, ".", output);
    expect(received).not.toHaveProperty("requestFacts");
    await expect(registry.getReporter("example.demo/reporter.demo")!.render(result, ".")).rejects.toThrow("output boundary");
  });

  it("requires explicit auth bindings and applies only validated header/query patches", () => {
    let bad = false;
    const catalog = fixture([{ kind: "auth", id: "example.demo/auth.demo", supports: ["bearer"], apply(view, auth) {
      expect(view).not.toHaveProperty("auth"); expect(auth.kind).toBe("bearer");
      return bad ? { headers: { Valid: "yes" }, query: [{ key: "x", value: 2 }] } as never : { headers: { Authorization: "sdk" }, query: [{ key: "x", value: "1" }] };
    } }]);
    const registry = createDefaultRegistry(); const builtin = registry.getAuth("bearer");
    installSdkContributions(registry, catalog, {}); expect(registry.getAuth("bearer")).toBe(builtin);
    installSdkContributions(registry, catalog, { auth: { bearer: "example.demo/auth.demo" } });
    const req = request(); registry.getAuth("bearer")!.apply(req, { kind: "bearer", token: "secret" });
    expect(req.headers).toEqual({ Authorization: "sdk" }); expect(req.query).toEqual([{ key: "x", value: "1", enabled: true }]);
    const mixedCase = request(); mixedCase.headers = { authorization: "old", "X-Keep": "keep" };
    mixedCase.query = [{ key: "existing", value: "first", enabled: true }];
    registry.getAuth("bearer")!.apply(mixedCase, { kind: "bearer", token: "secret" });
    expect.soft(mixedCase.headers).toEqual({ Authorization: "sdk", "X-Keep": "keep" });
    expect(mixedCase.query).toEqual([{ key: "existing", value: "first", enabled: true }, { key: "x", value: "1", enabled: true }]);
    bad = true; const untouched = request(); expect(() => registry.getAuth("bearer")!.apply(untouched, { kind: "bearer", token: "secret" })).toThrow();
    expect(untouched.headers.Authorization).toBe("old");
    installSdkContributions(registry, catalog, { auth: { bearer: "example.missing/auth.none" } });
    expect(() => registry.getAuth("bearer")).toThrowError(expect.objectContaining({ code: "binding_invalid" }));
  });

  it("delegates exactly once to the per-execution host and maps only captured opaque file refs", async () => {
    let mode: "once" | "zero" | "twice" | "unknown" | "switch" | "schema" | "void-return" | "void-throw" = "once";
    let seen: RequestViewV1 | undefined;
    const contractError = { code: "contribution_invalid", caseFailureKind: "config" };
    const pluginError = new Error("plugin-returned-early");
    const catalog = fixture([{ kind: "protocol", id: "example.demo/protocol.demo", supports: ["http"], async execute(view, ctx) {
      seen = view; expect(view).not.toHaveProperty("auth"); expect(ctx.runId).toBe("run");
      if (mode === "zero") return { ...response, status: 999 };
      if (mode === "unknown") return ctx.transport.execute({ ...view, body: { kind: "binary", file: { fileRef: "unknown" }, contentType: "x" } } as RequestViewV1);
      if (mode === "switch") return ctx.transport.execute({ protocol: "websocket", url: view.url, headers: {}, query: [] });
      if (mode === "schema") return ctx.transport.execute({ ...view, headers: { Invalid: 42 } } as never);
      if (mode === "void-return" || mode === "void-throw") {
        void ctx.transport.execute({ ...view, headers: { "X-SDK": "yes" } });
        if (mode === "void-throw") throw pluginError;
        return response;
      }
      await ctx.transport.execute({ ...view, headers: { "X-SDK": "yes" } });
      if (mode === "twice") { try { await ctx.transport.execute(view); } catch { /* cannot hide contract failure */ } }
      return { ...response, status: 999 };
    } }]);
    const registry = createDefaultRegistry(); const builtin = registry.getProtocol(request());
    installSdkContributions(registry, catalog, {}); expect(registry.getProtocol(request())).toBe(builtin);
    installSdkContributions(registry, catalog, { protocol: { http: "example.demo/protocol.demo" } });
    const req = request(); req.protocol === "http" && (req.body = { kind: "binary", file: { path: "private.bin" }, contentType: "x" });
    const reference = req.protocol === "http" && req.body?.kind === "binary" ? req.body.file : undefined;
    let calls = 0;
    let transportFailure: Error | undefined;
    const transport: ProtocolClient = { name: "run-client", canHandle: () => true, async execute(sent, opts) {
      calls++; expect(sent.protocol === "http" && sent.body?.kind === "binary" && sent.body.file).toBe(reference);
      expect(sent.headers).toEqual({ "X-SDK": "yes" }); expect(opts.signal).toBe(signal);
      if (transportFailure) {
        await new Promise<void>(resolve => setImmediate(resolve));
        throw transportFailure;
      }
      return response;
    } };
    const signal = new AbortController().signal;
    const opts = { connectTimeoutMs: 1, totalTimeoutMs: 2, signal, runtime: { pluginTransport: transport, pluginRunId: "run", files: {
      get(ref: unknown) { return ref === reference ? { filename: "upload.bin", size: 7 } as never : undefined; }, async close() {} } } };
    const client = registry.getProtocol(req)!;
    expect(await client.execute(req, opts)).toEqual(response); expect(calls).toBe(1);
    expect(JSON.stringify(seen)).not.toContain("private.bin");
    expect(seen?.protocol === "http" && seen.body).toEqual({ kind: "binary", file: { fileRef: expect.any(String), filename: "upload.bin", sizeBytes: 7 }, contentType: "x" });
    mode = "zero"; await expect.soft(client.execute(req, opts)).rejects.toThrowError(expect.objectContaining(contractError)); expect(calls).toBe(1);
    mode = "twice"; await expect.soft(client.execute(req, opts)).rejects.toThrowError(expect.objectContaining(contractError)); expect(calls).toBe(2);
    mode = "unknown"; await expect.soft(client.execute(req, opts)).rejects.toThrowError(expect.objectContaining(contractError)); expect(calls).toBe(2);
    mode = "switch"; await expect.soft(client.execute(req, opts)).rejects.toThrowError(expect.objectContaining(contractError)); expect(calls).toBe(2);
    mode = "schema"; await expect.soft(client.execute(req, opts)).rejects.toThrowError(expect.objectContaining(contractError)); expect(calls).toBe(2);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      transportFailure = new Error("transport-failed");
      mode = "void-return";
      await expect(client.execute(req, opts)).rejects.toBe(transportFailure);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect.soft(unhandled).toEqual([]); expect(calls).toBe(3);
      mode = "void-throw";
      await expect(client.execute(req, opts)).rejects.toBe(pluginError);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect.soft(unhandled).toEqual([]); expect(calls).toBe(4);
    } finally { process.off("unhandledRejection", onUnhandled); }
    transportFailure = undefined; mode = "once";
    const cancelled = new AbortController(); const cancellation = new Error("cancelled-by-host"); cancelled.abort(cancellation);
    await expect(client.execute(req, { ...opts, signal: cancelled.signal })).rejects.toBe(cancellation);
    expect(calls).toBe(4);
    installSdkContributions(registry, catalog, { protocol: { http: "example.missing/protocol.none" } });
    expect(() => registry.getProtocol(req)).toThrowError(expect.objectContaining({ code: "binding_invalid" }));
  });
});
