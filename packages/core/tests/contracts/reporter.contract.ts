import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Reporter } from "../../src/plugin/types.js";
import type { RunResult } from "../../src/report/types.js";

export const emptyRun: RunResult = {
  collectionId: "c1", collectionName: "demo",
  startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  total: 0, passed: 0, failed: 0, cases: [],
};

/** 报告渲染器契约：空结果可渲染、产出非空文件、返回存在的路径。 */
export function itCompliesWithReporterContract(reporter: Reporter, sample: RunResult = emptyRun) {
  it(`契约: ${reporter.format} 渲染空结果产出非空文件`, async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-report-"));
    const file = await reporter.render(sample, outDir);
    const { readFileSync, statSync } = await import("node:fs");
    expect(statSync(file).size).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
  });
}
