import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import type { Reporter } from "../plugin/types.js";
import type { RunResult } from "./types.js";
import { reportingUnits, caseReportingIdentity } from "./units.js";

const nextReportFileId = monotonicFactory();
function boundedOutput(value: unknown): string {
  const text = JSON.stringify(value); const bytes = Buffer.from(text);
  return bytes.length > 64 * 1024 ? bytes.subarray(0, 64 * 1024 - 32).toString("utf8") + " [truncated/omitted]" : text;
}

function escapeXml(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const junitReporter: Reporter = {
  format: "junit",
  async render(result: RunResult, outDir: string) {
    const units = reportingUnits(result);
    const cases = units.rows.map((c) => `  <testcase name="${escapeXml(caseReportingIdentity(c))}" classname="${escapeXml(result.collectionName)}" time="${(c.durationMs / 1000).toFixed(3)}">
    ${c.skipped ? `<skipped message="${escapeXml(c.skipReason ?? c.error ?? "跳过")}"/>` : c.passed ? "" : `<failure message="${escapeXml([c.error, ...c.assertions.filter((a) => !a.pass).map((a) => a.message)].filter(Boolean).join("; ") || "断言失败")}"/>`}
    <system-out>${escapeXml(JSON.stringify(c.evidence ?? { state: "not-collected", reason: "旧记录未采集" }))}</system-out>
  </testcase>`).join("\n") + units.diagnostics.map((entry) => `\n<testcase name="${escapeXml(`NON-HTTP entry-diagnostic ${entry.entryId} row=${entry.suiteRow ?? "-"} workflow=${entry.workflowId ?? "-"}`)}" classname="${escapeXml(result.collectionName)}" time="0"><failure message="${escapeXml(entry.error ?? entry.status)}"/><system-out>${escapeXml(JSON.stringify(entry))}</system-out></testcase>`).join("");
    const logicalCases = units.invocations.map((unit) => {
      const rows = result.reportingMode === "workflow-invocation-v2" ? result.cases : result.cases.filter((row) => row.entryId === unit.entryId && row.suiteRow === unit.suiteRow);
      return `<testcase name="${escapeXml(`workflow ${unit.workflowId} entry=${unit.entryId} row=${unit.suiteRow ?? "-"} invocation=${unit.invocationId}`)}" classname="${escapeXml(result.collectionName)}" time="0">${unit.verdict === "passed" ? "" : unit.verdict === "skipped" ? "<skipped/>" : unit.verdict === "aborted" ? `<failure type="aborted" message="${escapeXml(unit.error ?? "aborted")}"/>` : `<failure message="${escapeXml(unit.error ?? "failed")}"/>`}<system-out>${escapeXml(boundedOutput({ "failed-attempts": rows.filter((row) => !row.passed), unit, "real-case-rows": rows.length, requestFacts: result.requestFacts, trace: result.trace }))}</system-out></testcase>`;
    }).join("\n");
    const skipped = units.summary.skipped;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="${units.summary.total}" failures="${units.summary.failed}" skipped="${skipped}">
  <testsuite name="${escapeXml(result.collectionName)}" tests="${units.summary.total}" failures="${units.summary.failed}" skipped="${skipped}">
<properties><property name="real-case-rows" value="${result.total}"/><property name="entry-counts" value="${escapeXml(JSON.stringify(result.suite ? { total: result.suite.total, failed: result.suite.failed, skipped: result.suite.skipped } : result.workflow ? { total: result.workflow.total, failed: result.workflow.failed, skipped: result.workflow.skipped } : {}))}"/><property name="reporting-units" value="${escapeXml(JSON.stringify(units.summary))}"/></properties>
${cases}${logicalCases}
<system-out>${escapeXml(boundedOutput(result.workflow ?? result.suite ?? {}))}</system-out>
  </testsuite>
</testsuites>`;
    if (Buffer.byteLength(xml) > 16 * 1024 * 1024) throw new Error("JUnit report exceeds capacity; safe JSON retained by run host");
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `junit-${nextReportFileId()}.xml`);
    writeFileSync(file, xml);
    return file;
  },
};
