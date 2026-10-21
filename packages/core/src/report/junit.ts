import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import type { Reporter } from "../plugin/types.js";
import type { RunResult } from "./types.js";
import { reportingUnits, caseReportingIdentity } from "./units.js";

const nextReportFileId = monotonicFactory();

function escapeXml(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const junitReporter: Reporter = {
  format: "junit",
  async render(result: RunResult, outDir: string) {
    const units = reportingUnits(result);
    const cases = result.cases.map((c) => `  <testcase name="${escapeXml(caseReportingIdentity(c))}" classname="${escapeXml(result.collectionName)}" time="${(c.durationMs / 1000).toFixed(3)}">
    ${c.skipped ? `<skipped message="${escapeXml(c.skipReason ?? c.error ?? "跳过")}"/>` : c.passed ? "" : `<failure message="${escapeXml([c.error, ...c.assertions.filter((a) => !a.pass).map((a) => a.message)].filter(Boolean).join("; ") || "断言失败")}"/>`}
    <system-out>${escapeXml(JSON.stringify(c.evidence ?? { state: "not-collected", reason: "旧记录未采集" }))}</system-out>
  </testcase>`).join("\n") + units.diagnostics.map((entry) => `\n<testcase name="${escapeXml(`NON-HTTP entry-diagnostic ${entry.entryId} row=${entry.suiteRow ?? "-"} workflow=${entry.workflowId ?? "-"}`)}" classname="${escapeXml(result.collectionName)}" time="0"><failure message="${escapeXml(entry.error ?? entry.status)}"/><system-out>${escapeXml(JSON.stringify(entry))}</system-out></testcase>`).join("");
    const skipped = result.skipped ?? 0;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="${units.summary.total}" failures="${units.summary.failed}" skipped="${skipped}">
  <testsuite name="${escapeXml(result.collectionName)}" tests="${units.summary.total}" failures="${units.summary.failed}" skipped="${skipped}">
<properties><property name="real-case-rows" value="${result.total}"/><property name="entry-counts" value="${escapeXml(JSON.stringify(result.suite ? { total: result.suite.total, failed: result.suite.failed, skipped: result.suite.skipped } : result.workflow ? { total: result.workflow.total, failed: result.workflow.failed, skipped: result.workflow.skipped } : {}))}"/><property name="reporting-units" value="${escapeXml(JSON.stringify(units.summary))}"/></properties>
${cases}
<system-out>${escapeXml(JSON.stringify(result.workflow ?? result.suite ?? {}))}</system-out>
  </testsuite>
</testsuites>`;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `junit-${nextReportFileId()}.xml`);
    writeFileSync(file, xml);
    return file;
  },
};
