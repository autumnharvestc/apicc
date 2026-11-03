import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { digestJson, RequestSchema } from "../src/protocol.js";
import { handleOperation } from "../src/handlers.js";
import { archiveInput, policy, stressReport } from "../../../packages/core/tests/collaboration/fixtures.js";

const fixturePath = new URL("../../../server/src/test/resources/collaboration-runtime-fixtures.json", import.meta.url);
function fixtures() {
  const request = (operation: string, input: unknown) => {
    const payload = JSON.parse(JSON.stringify(input)); // Model optionals become actual JSON wire omissions.
    return { protocolVersion: 1, operation, requestId: "parity", inputDigest: digestJson(payload), deadlineEpochMs: 4_000_000_000_000, outputBudgetBytes: 1_048_576, payload };
  };
  const valid = { input: { ...archiveInput(), report: { format: "stress", body: stressReport() } }, policy };
  const semantic = structuredClone(valid); semantic.input.report.body.requests.completed = 3;
  const structural = { ...valid, input: { ...valid.input, rawProject: "forbidden" } };
  const policy256 = { ...policy, extraSensitiveFields: ["😀".repeat(256)] };
  const policy257 = { ...policy, extraSensitiveFields: ["😀".repeat(257)] };
  const legacy = { concurrency: 1, totalRequests: 0, ok: 0, failed: 0, durationMs: 1000, rps: 0,
    latency: { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 }, statusDist: {}, errorKinds: {}, startedAt: 0, finishedAt: 1000,
    distributed: { protocolVersion: 2, dataComplete: false, shards: 1, perShard: [], shardErrors: [{ shardId: "shard-1", error: "synthetic worker unavailable" }] } };
  const legacyBody = { input: { ...archiveInput(), report: { format: "stress", body: legacy } }, policy };
  const legacyBaseline = { input: { ...archiveInput(), report: { format: "stress", body: stressReport(), baseline: legacy } }, policy };
  const legacyBodyExtra = structuredClone(legacyBody);
  Object.assign(legacyBodyExtra.input.report.body.distributed.shardErrors[0]!, { unrecognizedPrivate: { source: "synthetic" } });
  const legacyBaselineExtra = structuredClone(legacyBaseline);
  Object.assign(legacyBaselineExtra.input.report.baseline.distributed.shardErrors[0]!, { unrecognizedPrivate: { source: "synthetic" } });
  return [
    { name: "stress-valid", wireValid: true, coreValid: true, request: request("project-report", valid) },
    { name: "stress-structure-invalid", wireValid: false, coreValid: false, request: request("project-report", structural) },
    { name: "stress-semantic-invalid", wireValid: true, coreValid: false, request: request("project-report", semantic) },
    { name: "nonBMP-256", wireValid: true, coreValid: true, request: request("project-report", { ...valid, policy: policy256 }) },
    { name: "nonBMP-257", wireValid: false, coreValid: false, request: request("project-report", { ...valid, policy: policy257 }) },
    { name: "legacy-body-valid", wireValid: true, coreValid: true, request: request("project-report", legacyBody) },
    { name: "legacy-body-extra", wireValid: false, coreValid: false, request: request("project-report", legacyBodyExtra) },
    { name: "legacy-baseline-valid", wireValid: true, coreValid: true, request: request("project-report", legacyBaseline) },
    { name: "legacy-baseline-extra", wireValid: false, coreValid: false, request: request("project-report", legacyBaselineExtra) },
  ];
}
it("shares exact structural/semantic/nonBMP fixture classes with Java", async () => {
  const values = fixtures();
  // Explicit maintenance command only; normal tests never rewrite the artifact.
  if (process.env.APICC_WRITE_COLLAB_FIXTURES === "1") await writeFile(fixturePath, JSON.stringify(values, null, 2) + "\n");
  expect(JSON.parse(await readFile(fixturePath, "utf8"))).toEqual(values);
  for (const fixture of values) {
    expect.soft(RequestSchema.safeParse(fixture.request).success, fixture.name).toBe(fixture.wireValid);
    if (fixture.coreValid) expect(await handleOperation(fixture.request.operation, fixture.request.payload)).toMatchObject({ kind: "report" });
    else await expect.soft(handleOperation(fixture.request.operation, fixture.request.payload)).rejects.toThrow();
  }
});
