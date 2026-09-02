import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import type { Reporter } from "../plugin/types.js";
import type { RunResult } from "./types.js";

const nextReportFileId = monotonicFactory();

function escapeXml(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const junitReporter: Reporter = {
  format: "junit",
  async render(result: RunResult, outDir: string) {
    const cases = result.cases.map((c) => `  <testcase name="${escapeXml(`${c.apiName}.${c.caseName}${c.row !== undefined ? `#${c.row}` : ""}`)}" classname="${escapeXml(result.collectionName)}" time="${(c.durationMs / 1000).toFixed(3)}">
    ${c.passed ? "" : `<failure message="${escapeXml([c.error, ...c.assertions.filter((a) => !a.pass).map((a) => a.message)].filter(Boolean).join("; ") || "断言失败")}"/>`}
  </testcase>`).join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="${result.total}" failures="${result.failed}">
  <testsuite name="${escapeXml(result.collectionName)}" tests="${result.total}" failures="${result.failed}">
${cases}
  </testsuite>
</testsuites>`;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `junit-${nextReportFileId()}.xml`);
    writeFileSync(file, xml);
    return file;
  },
};
