import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import type { Reporter } from "../plugin/types.js";
import type { RunResult } from "./types.js";
import { reportingUnits, caseReportingIdentity } from "./units.js";
import type { WorkflowTraceEvent } from "../workflow/trace.js";

const nextReportFileId = monotonicFactory();

function escapeHtml(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function counts(value: { total: number; passed: number; failed: number; skipped?: number }): string {
  return `总计 ${value.total} · 通过 ${value.passed} · 失败 ${value.failed} · 跳过 ${value.skipped ?? 0}`;
}

function details(value: unknown): string {
  return `<details><summary>原始详情 / 完整身份</summary><pre>${escapeHtml(JSON.stringify(value, null, 2) ?? "未采集")}</pre></details>`;
}

function table(headers: string[], rows: string[][], className = ""): string {
  return `<div class="table-scroll ${className}" tabindex="0"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function status(value: string | undefined): string {
  if (!value) return "-";
  const labels: Record<string, string> = { passed: "通过", failed: "失败", skipped: "跳过", aborted: "已中止", cancelled: "已取消", noop: "无操作" };
  const style = value === "passed" || value === "noop" ? "status-pass" : value === "failed" || value === "aborted" ? "status-fail" : "status-other";
  return `<span class="${style}">${escapeHtml(labels[value] ? `${labels[value]}（${value}）` : value)}</span>`;
}

const eventLabels: Record<WorkflowTraceEvent["type"], string> = {
  "attempt-start": "尝试开始", "attempt-end": "尝试结束", "retry-wait": "重试等待",
  "handler-start": "错误处理开始", "handler-end": "错误处理结束", "handler-skipped": "错误处理跳过",
  "cleanup-start": "清理开始", "cleanup-end": "清理结束", "cleanup-skipped": "清理跳过", recovered: "错误已恢复",
  "node-start": "节点开始", "node-end": "节点结束", "node-failure": "节点失败", "node-skipped": "节点跳过",
  "leaf-wait": "叶节点等待", "leaf-start": "叶节点开始", "branch-start": "分支开始", "branch-end": "分支结束",
  "branch-winner": "分支胜出", "session-cleanup-failed": "会话清理失败", "loop-iteration": "循环迭代",
};

function traceContext(event: WorkflowTraceEvent): string {
  const parts = (event.invocationPath ?? []).map((segment) => [
    segment.branchId !== undefined ? `分支 ${segment.branchId}` : "",
    segment.iteration !== undefined ? `循环 ${segment.iteration + 1}` : "",
    segment.handler ? `处理器 ${segment.handler}` : "",
  ].filter(Boolean).join(" · ")).filter(Boolean);
  if (event.branchId !== undefined) parts.push(`分支 ${event.branchId}`);
  if (event.iteration !== undefined) parts.push(`循环 ${event.iteration + 1}`);
  if (event.attempt !== undefined) parts.push(`attempt ${event.attempt}`);
  return escapeHtml(parts.join(" / ") || "-");
}

function workflowSection(result: RunResult): string {
  if (!result.workflow) return "";
  const flow = result.workflow;
  return `<section id="workflow-nodes"><h2>工作流节点统计及状态</h2><p>${counts(flow)}${flow.verdict ? ` · 最终状态 ${status(flow.verdict)}` : ""}</p>${table(
    ["节点", "类型", "状态", "原因", "详情"], flow.entries.map((entry) => [
      escapeHtml(entry.label ? `${entry.label}（${entry.entryId}）` : entry.entryId), escapeHtml(entry.nodeKind ?? entry.kind),
      status(entry.state ?? entry.status), escapeHtml([entry.skipReason, entry.failureKind, entry.error].filter(Boolean).join(" · ") || "-"), details(entry),
    ]))}</section>`;
}

function traceSection(result: RunResult): string {
  if (!result.trace) return "";
  const trace = result.trace;
  return `<section id="trace"><h2>调用轨迹（含恢复、OR winner、取消和 cleanup）</h2><p>显示 ${trace.events.length} / ${trace.totalEvents} 个事件${trace.truncated ? " · 轨迹已截断" : ""}</p>${table(
    ["序号", "事件", "节点", "分支 / 循环 / attempt", "状态 / 原因", "详情"], trace.events.map((event, index) => [
      String(index + 1), escapeHtml(eventLabels[event.type] ? `${eventLabels[event.type]}（${event.type}）` : event.type), escapeHtml(event.nodeId ?? "-"), traceContext(event),
      `${status(event.state)}${[event.cause, event.code, event.failureKind, event.message, event.delayMs !== undefined ? `等待 ${event.delayMs} ms` : ""].filter(Boolean).map((text) => ` · ${escapeHtml(text!)}`).join("")}`, details(event),
    ]), "trace-scroll")}</section>`;
}

function suiteSection(result: RunResult): string {
  if (!result.suite) return "";
  const suite = result.suite;
  return `<section id="suite-entries"><h2>套件条目状态及错误</h2><p>条目 ${counts(suite)} · 最终状态 ${status(suite.verdict)}</p>${suite.entries?.length ? table(
    ["条目", "类型", "数据行", "状态", "原因", "详情"], suite.entries.map((entry) => [
      escapeHtml(entry.entryId), escapeHtml(entry.kind), entry.suiteRow === undefined ? "-" : String(entry.suiteRow + 1), status(entry.status),
      escapeHtml([entry.skipReason, entry.error].filter(Boolean).join(" · ") || "-"), details(entry),
    ])) : ""}</section>`;
}

export const htmlReporter: Reporter = {
  format: "html",
  async render(result: RunResult, outDir: string) {
    const units = reportingUnits(result);
    const primary = result.reportingMode ? `${result.reportingMode === "mixed-suite-v2" ? "混合逻辑报告单位" : "最终逻辑调用"} · ${counts(units.summary)}` : counts(result);
    const rows = result.cases.map((c) => `
      <tr class="${c.skipped ? "skip" : c.passed ? "pass" : "fail"}">
        <td>${escapeHtml(c.nodeId ?? "-")}</td><td>${escapeHtml(c.apiName)}</td><td>${escapeHtml(c.caseName)}</td>
        <td>${c.row !== undefined ? c.row + 1 : "-"}</td><td>${c.skipped ? "跳过" : c.passed ? "通过" : "失败"}</td>
        <td>${c.durationMs.toFixed(1)}</td>
        <td>${[c.skipReason ? escapeHtml(c.skipReason) : "", c.error ? escapeHtml(c.error) : "", ...c.assertions.filter((a) => !a.pass).map((a) => escapeHtml(a.message))].filter(Boolean).join("; ") || "-"}<details><summary>${escapeHtml(caseReportingIdentity(c))}</summary><pre>${escapeHtml(JSON.stringify(c.evidence ?? { state: "not-collected", reason: "旧记录未采集" }, null, 2))}</pre></details></td>
      </tr>`).join("\n");
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>apicc 报告 - ${escapeHtml(result.collectionName)}</title>
<style>body{font-family:sans-serif;line-height:1.5;margin:2rem;overflow-wrap:anywhere}h1{font-size:1.8rem}.primary-summary{font-size:1.25rem;font-weight:600}section{margin:1.5rem 0}h2{font-size:1.2rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.5rem .7rem;text-align:left;vertical-align:top;min-width:5rem}th{white-space:nowrap;background:#f6f7f8}td{max-width:32rem;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;font-size:.85rem}summary{cursor:pointer}details{margin-top:.4rem}.table-scroll{max-width:100%;overflow:auto}.table-scroll table{min-width:48rem}.trace-scroll{max-height:34rem}.trace-scroll th{position:sticky;top:0}.filters{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem}.pass,.status-pass{color:#087854}.fail,.status-fail{color:#a22;background:#fee}.skip,.status-other{color:#765;background:#fff3cd}.filter-input{position:relative;display:inline-block}.filter-input input{box-sizing:border-box;padding-right:1.8em;max-width:100%}.filter-input button{position:absolute;right:.2em;top:50%;transform:translateY(-50%);width:1.4em;height:1.4em;padding:0;border:0;background:transparent;cursor:pointer;font:inherit;line-height:1}@media(max-width:640px){body{margin:1rem}h1{font-size:1.4rem}.filter-input{max-width:100%}}</style></head>
<body><h1>${escapeHtml(result.collectionName)}${result.envName ? `（${escapeHtml(result.envName)}）` : ""}</h1>
<p class="primary-summary">${primary}</p>
${result.reportingMode ? `<p>报告模式 ${escapeHtml(result.reportingMode)}</p><section id="execution-facts"><h2>执行行与协议事实</h2><p>真实执行行 ${result.total} · 原始失败行 ${result.failed}</p><p>请求开始 requestStarted ${result.requestFacts?.requestStarted ?? "未采集"} · 请求结束 requestCompleted ${result.requestFacts?.requestCompleted ?? "未采集"} · HTTP 交换 httpExchanges ${result.requestFacts?.httpExchanges ?? "未采集"}</p></section>` : ""}
<details><summary>高级报告详情（reporting-units）</summary><pre>${escapeHtml(JSON.stringify({ reportingMode: result.reportingMode, reportingUnits: units.summary, workflowUnits: result.workflowUnits }, null, 2))}</pre></details>
${workflowSection(result)}
${traceSection(result)}
${suiteSection(result)}
${units.diagnostics.map((entry) => `<p class="fail">NON-HTTP entry-diagnostic ${escapeHtml(JSON.stringify(entry))}</p>`).join("")}
<h2>真实执行行明细</h2><div class="filters"><label><input id="failed" type="checkbox">仅失败</label> <label for="api">接口</label><span class="filter-input"><input id="api"><button id="api-clear" type="button" aria-label="清除接口筛选" title="清除接口筛选" hidden>×</button></span> <label for="row">数据行</label><span class="filter-input"><input id="row"><button id="row-clear" type="button" aria-label="清除数据行筛选" title="清除数据行筛选" hidden>×</button></span></div>
<div class="table-scroll" tabindex="0"><table><thead><tr><th>节点</th><th>接口</th><th>用例</th><th>数据行</th><th>结果</th><th>耗时ms</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table></div>
<script>function filter(){document.querySelectorAll('tr.pass,tr.fail,tr.skip').forEach(function(r){r.hidden=(document.getElementById('failed').checked&&!r.classList.contains('fail'))||!r.cells[1].textContent.includes(document.getElementById('api').value)||(document.getElementById('row').value!==''&&r.cells[3].textContent!==document.getElementById('row').value)});['api','row'].forEach(function(id){document.getElementById(id+'-clear').hidden=document.getElementById(id).value===''})}document.querySelectorAll('input').forEach(function(i){i.addEventListener('input',filter)});['api','row'].forEach(function(id){document.getElementById(id+'-clear').addEventListener('click',function(){var input=document.getElementById(id);input.value='';filter();input.focus()})});filter()</script>
</body></html>`;
    if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new Error("HTML report exceeds capacity; safe JSON retained by run host");
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `report-${nextReportFileId()}.html`);
    writeFileSync(file, html);
    return file;
  },
};
