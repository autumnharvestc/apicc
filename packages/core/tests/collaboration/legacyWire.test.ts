import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { StressDistributedSchema, StressReportSchema, StressReportWireSchema } from "../../src/stress/model.js";
import { parseStressReport } from "../../src/stress/reportV2.js";
import { projectPublication } from "../../src/collaboration/projection.js";

const fixtures = JSON.parse(await readFile(new URL("../../../../server/src/test/resources/collaboration-runtime-fixtures.json", import.meta.url), "utf8"));
it.each(["body", "baseline"])("T4-I1 wire rejects legacy %s shard error extras while historical parsers stay compatible", async at => {
  const valid = fixtures.find((fixture: { name: string }) => fixture.name === `legacy-${at}-valid`).request.payload;
  const invalid = fixtures.find((fixture: { name: string }) => fixture.name === `legacy-${at}-extra`).request.payload;
  const body = valid.input.report[at]; const extra = invalid.input.report[at];
  expect(StressReportWireSchema.safeParse(body).success).toBe(true);
  expect(await projectPublication(valid.input, valid.policy)).toMatchObject({ kind: "report" });
  expect.soft(StressDistributedSchema.safeParse(extra.distributed).success).toBe(true);
  expect.soft(StressReportSchema.safeParse(extra).success).toBe(true);
  expect(() => parseStressReport(extra)).not.toThrow();
  expect(StressReportWireSchema.safeParse(extra).success).toBe(false);
});
