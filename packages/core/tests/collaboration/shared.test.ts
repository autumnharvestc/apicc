import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as shared from "../../src/collaboration/shared.js";
import { jsonWireSchema, archiveInput, documentInput, policy, safeDocument } from "./fixtures.js";

describe("browser and RPC public Core subpaths", () => {
  it("loads the built shared package subpath without any host function exports", async () => {
    const module = await import("@apicc/core/collaboration/shared");
    expect.soft(typeof module.PublicArtifactDtoSchema.parse).toBe("function");
    expect.soft("projectPublication" in module).toBe(false);
    expect.soft("decodeContractProjectFiles" in module).toBe(false);
    expect.soft("startMockServer" in module).toBe(false);
  });
  it("bundles the actual shared import graph for browsers without Node or host modules", async () => {
    const require = createRequire(import.meta.url);
    const vite = createRequire(require.resolve("vitest/package.json")).resolve("vite");
    const { build } = await import(pathToFileURL(vite).href);
    const moduleIds: string[] = []; const code: string[] = [];
    await build({ configFile: false, logLevel: "silent", build: { write: false, minify: false,
      lib: { entry: resolve("src/collaboration/shared.ts"), formats: ["es"], fileName: "collaboration-shared" } },
      plugins: [{ name: "inspect-real-shared-graph", generateBundle(_options: unknown, bundle: Record<string, { type: string; modules?: Record<string, unknown>; code?: string }>) {
        for (const item of Object.values(bundle)) if (item.type === "chunk") { moduleIds.push(...Object.keys(item.modules ?? {})); code.push(item.code ?? ""); }
      } }],
    });
    expect.soft(moduleIds.length).toBeGreaterThan(0);
    expect.soft(moduleIds.filter((id) => /(?:node:|browser-external|\/storage\/|\/collaboration\/(?:index|projection|report|mutation|policy)\.|\/src\/index\.)/.test(id.replace(/\\/g, "/")))).toEqual([]);
    expect.soft(code.join("\n")).not.toContain("__vite-browser-external");
  }, 20_000);
  it.each([
    "PublicArtifactDtoSchema", "DocumentViewDtoSchema", "ReportViewDtoSchema", "PublicationInputSchema", "ProjectionPolicySchema", "ArchivePublicationInputWireSchema", "RunReportInputWireSchema",
    "CompiledMockPlanSchema", "SharedMockPolicySchema", "MockDiagnosticSchema", "AssetMutationInputWireSchema", "AssetMutationResultSchema", "CompileMockInputWireSchema", "CompileMockResultSchema", "MockEvaluationInputWireSchema", "MockEvaluationResultWireSchema",
  ] as const)("exports a concrete JSON wire schema for %s", (name) => {
    const schema = z.toJSONSchema(jsonWireSchema(shared[name]), { target: "draft-2020-12", io: "input", reused: "ref" });
    expect(typeof schema).toBe("object");
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":{}');
  });
  it.each([
    ["AssetMutationInputWireSchema", { beforeFiles: [], afterFiles: [] }], ["AssetMutationResultSchema", { scriptChanged: false, locations: [] }],
    ["CompileMockInputWireSchema", { files: documentInput().files }], ["CompileMockResultSchema", { ok: true, plan: { sourceProjectRevision: "r1", routes: [] } }],
    ["CompileMockResultSchema", { ok: false, diagnostics: [{ severity: "error", code: "INVALID", path: "mock", message: "拒绝原因", lossy: false }] }],
    ["MockEvaluationInputWireSchema", { method: "GET", target: "/items?q=1&q=2", headers: {}, body: [0, 255] }],
    ["MockEvaluationResultWireSchema", { status: 404, mediaType: "text/plain", headers: {}, body: [78, 111], delayMs: 0, reason: "NO_ROUTE" }],
  ] as const)("validates and rejects unknown/private payloads at %s", (name, good) => {
    expect.soft(shared[name].safeParse(good).success).toBe(true);
    expect.soft(shared[name].safeParse({ ...good, rawProject: "PRIVATE" }).success).toBe(false);
  });
  it.each(["MockEvaluationInputWireSchema", "MockEvaluationResultWireSchema"] as const)("rejects non-byte wire bodies at %s", (name) => {
    const value = name === "MockEvaluationInputWireSchema" ? { method: "GET", target: "/", headers: {}, body: [256] }
      : { status: 200, mediaType: "text/plain", headers: {}, body: [256], delayMs: 0, reason: "MATCHED" };
    expect(shared[name].safeParse(value).success).toBe(false);
  });
  it.each([null, 1023, 1024.5, 8388609])("rejects an invalid compile byte cap at the wire entrance: %s", (maxResponseBytes) => {
    expect(shared.CompileMockInputWireSchema.safeParse({ files: documentInput().files, maxResponseBytes }).success).toBe(false);
  });
  it.each(["status", "delayMs"])("rejects invalid evaluation response wire %s", (key) => {
    expect(shared.MockEvaluationResultWireSchema.safeParse({ status: 200, mediaType: "text/plain", headers: {}, body: [], delayMs: 0, reason: "MATCHED", [key]: key === "status" ? 99 : 30001 }).success).toBe(false);
  });
  it("preserves the strict publication fixtures through actual JSON wire serialization", () => {
    for (const [schema, value] of [[shared.PublicArtifactDtoSchema, safeDocument()], [shared.PublicationInputSchema, archiveInput()], [shared.ProjectionPolicySchema, policy]] as const) {
      expect(schema.safeParse(JSON.parse(JSON.stringify(value))).success).toBe(true);
    }
  });
});
