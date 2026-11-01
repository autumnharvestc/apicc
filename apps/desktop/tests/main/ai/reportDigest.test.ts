import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { aiReportDigest } from "../../../src/shared/ai/reportDigest.js";
it("hashes the versioned JSON projection with sorted object keys and ordered array values", async () => {
  const expected = createHash("sha256").update('apicc-ai-report-selection:v1\n{"a":[2,1],"b":2}').digest("hex");
  expect(await aiReportDigest({ b: 2, a: [2, 1], omitted: undefined })).toBe(expected);
  expect(await aiReportDigest({ a: [1, 2], b: 2 })).not.toBe(expected);
});
