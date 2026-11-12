import { readerText, readerLanguageControl, readerLanguageScript, readerStyles } from "./readerPresentation.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import type { Reporter } from "../plugin/types.js";
import type { RunResult } from "./types.js";
import { reportingUnits, caseReportingIdentity } from "./units.js";
import type { WorkflowTraceEvent } from "../workflow/trace.js";

const nextReportFileId = monotonicFactory();

const reportLabels: Record<string, string> = {"原始详情 / 完整身份": "Raw details / Full identity", "工作流节点统计及状态": "Workflow nodes and status", "调用轨迹（含恢复、OR winner、取消和 cleanup）": "Invocation trace (recovery, OR winner, cancellation and cleanup)", "套件条目状态及错误": "Suite entries and errors", "执行行与协议事实": "Execution rows and protocol facts", "高级报告详情（reporting-units）": "Advanced report details (reporting-units)", "真实执行行明细": "Actual case rows", "节点": "Node", "类型": "Type", "状态": "Status", "原因": "Reason", "详情": "Details", "序号": "Index", "事件": "Event", "分支 / 循环 / attempt": "Branch / iteration / attempt", "状态 / 原因": "Status / reason", "条目": "Entry", "数据行": "Data row", "混合逻辑报告单位": "Mixed logical reporting units", "最终逻辑调用": "Final logical invocations", "跳过": "Skipped", "通过": "Passed", "失败": "Failed", "报告模式": "Reporting mode", "非请求诊断": "Non-HTTP entry diagnostics", "仅失败": "Failed only", "接口": "API", "用例": "Case", "结果": "Result", "耗时ms": "Duration (ms)", "最终状态": "Final status", "执行证据 / 完整身份":"Execution evidence / Full identity"};
const kindLabels: Record<string, string> = {workflow:'工作流',case:'用例',request:'请求',group:'分组',loop:'循环',condition:'条件',parallel:'并行',retry:'重试',handler:'错误处理',cleanup:'清理',noop:'占位',assign:'赋值',delay:'延时',assert:'断言',subflow:'子流程'};
function label(value: string): string {
  if (Object.hasOwn(reportLabels, value)) return readerText(value, reportLabels[value]!);
  if (Object.hasOwn(kindLabels, value)) return readerText(kindLabels[value]!, value);
  return escapeHtml(value);
}



function escapeHtml(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function counts(value: { total: number; passed: number; failed: number; skipped?: number }): string {
  return readerText(`总计 ${value.total} · 通过 ${value.passed} · 失败 ${value.failed} · 跳过 ${value.skipped ?? 0}`, `Total ${value.total} · Passed ${value.passed} · Failed ${value.failed} · Skipped ${value.skipped ?? 0}`);
}

function details(value: unknown): string {
  return `<details><summary>${label("原始详情 / 完整身份")}</summary><pre>${escapeHtml(JSON.stringify(value, null, 2) ?? "未采集")}</pre></details>`;
}

function table(headers: string[], rows: string[][], className = ""): string {
  return `<div class="table-scroll ${className}" tabindex="0"><table><thead><tr>${headers.map((header) => `<th>${label(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function status(value: string | undefined): string {
  if (!value) return "-";
  const labels: Record<string, string> = { passed: "通过", failed: "失败", skipped: "跳过", aborted: "已中止", cancelled: "已取消", noop: "无操作" };
  const style = value === "passed" || value === "noop" ? "status-pass" : value === "failed" || value === "aborted" ? "status-fail" : "status-other";
  return `<span class="${style}">${Object.hasOwn(labels, value) ? readerText(`${labels[value]}（${value}）`, value) : escapeHtml(value)}</span>`;
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
  const format=(en:boolean)=> {
    const parts=(event.invocationPath??[]).map(segment=>[
      segment.branchId!==undefined?`${en?'Branch':'分支'} ${segment.branchId}`:'',
      segment.iteration!==undefined?`${en?'Iteration':'循环'} ${segment.iteration+1}`:'',
      segment.handler?`${en?'Handler':'处理器'} ${segment.handler}`:'',
    ].filter(Boolean).join(' · ')).filter(Boolean);
    if(event.branchId!==undefined)parts.push(`${en?'Branch':'分支'} ${event.branchId}`);
    if(event.iteration!==undefined)parts.push(`${en?'Iteration':'循环'} ${event.iteration+1}`);
    if(event.attempt!==undefined)parts.push(`attempt ${event.attempt}`);
    return parts.join(' / ')||'-';
  };
  return readerText(format(false),format(true));
}

function workflowSection(result: RunResult): string {
  if (!result.workflow) return "";
  const flow = result.workflow;
  return `<section id="workflow-nodes"><h2>${label("工作流节点统计及状态")}</h2><p>${counts(flow)}${flow.verdict ? ` · ${label("最终状态")} ${status(flow.verdict)}` : ""}</p>${table(
    ["节点", "类型", "状态", "原因", "详情"], flow.entries.map((entry) => [
      escapeHtml(entry.label ? `${entry.label}（${entry.entryId}）` : entry.entryId), label(entry.nodeKind ?? entry.kind),
      status(entry.state ?? entry.status), escapeHtml([entry.skipReason, entry.failureKind, entry.error].filter(Boolean).join(" · ") || "-"), details(entry),
    ]))}</section>`;
}

function traceSection(result: RunResult): string {
  if (!result.trace) return "";
  const trace = result.trace;
  return `<section id="trace"><h2>${label("调用轨迹（含恢复、OR winner、取消和 cleanup）")}</h2><p>${readerText(`显示 ${trace.events.length} / ${trace.totalEvents} 个事件${trace.truncated ? " · 轨迹已截断" : ""}`, `Showing ${trace.events.length} / ${trace.totalEvents} events${trace.truncated ? " · Trace truncated" : ""}`)}</p>${table(
    ["序号", "事件", "节点", "分支 / 循环 / attempt", "状态 / 原因", "详情"], trace.events.map((event, index) => [
      String(index + 1), Object.hasOwn(eventLabels, event.type) ? readerText(`${eventLabels[event.type]}（${event.type}）`, event.type) : escapeHtml(event.type), escapeHtml(event.nodeId ?? "-"), traceContext(event),
      `${status(event.state)}${[event.cause, event.code, event.failureKind, event.message].filter(Boolean).map((text) => ` · ${escapeHtml(text!)}`).join("")}${event.delayMs !== undefined ? ` · ${readerText(`等待 ${event.delayMs} ms`, `Wait ${event.delayMs} ms`)}` : ""}`, details(event),
    ]), "trace-scroll")}</section>`;
}

function suiteSection(result: RunResult): string {
  if (!result.suite) return "";
  const suite = result.suite;
  return `<section id="suite-entries"><h2>${label("套件条目状态及错误")}</h2><p>${label("条目")} ${counts(suite)} · ${label("最终状态")} ${status(suite.verdict)}</p>${suite.entries?.length ? table(
    ["条目", "类型", "数据行", "状态", "原因", "详情"], suite.entries.map((entry) => [
      escapeHtml(entry.entryId), label(entry.kind), entry.suiteRow === undefined ? "-" : String(entry.suiteRow + 1), status(entry.status),
      escapeHtml([entry.skipReason, entry.error].filter(Boolean).join(" · ") || "-"), details(entry),
    ])) : ""}</section>`;
}

export const htmlReporter: Reporter = {
  format: "html",
  async render(result: RunResult, outDir: string) {
    const units = reportingUnits(result);
    const primary = result.reportingMode ? `${label(result.reportingMode === "mixed-suite-v2" ? "混合逻辑报告单位" : "最终逻辑调用")} · ${counts(units.summary)}` : counts(result);
    const rows = result.cases.map((c) => `
      <tr class="${c.skipped ? "skip" : c.passed ? "pass" : "fail"}">
        <td>${escapeHtml(c.nodeId ?? "-")}</td><td>${escapeHtml(c.apiName)}</td><td>${escapeHtml(c.caseName)}</td>
        <td>${c.row !== undefined ? c.row + 1 : "-"}</td><td>${label(c.skipped ? "跳过" : c.passed ? "通过" : "失败")}</td>
        <td>${c.durationMs.toFixed(1)}</td>
        <td>${[c.skipReason ? escapeHtml(c.skipReason) : "", c.error ? escapeHtml(c.error) : "", ...c.assertions.filter((a) => !a.pass).map((a) => escapeHtml(a.message))].filter(Boolean).join("; ") || "-"}<details><summary>${label("执行证据 / 完整身份")}</summary><p>${escapeHtml(caseReportingIdentity(c))}</p><pre>${escapeHtml(JSON.stringify(c.evidence ?? { state: "not-collected", reason: "旧记录未采集" }, null, 2))}</pre></details></td>
      </tr>`).join("\n");
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>apicc 报告 - ${escapeHtml(result.collectionName)}</title>
<style>body{font-family:sans-serif;line-height:1.5;margin:2rem;overflow-wrap:anywhere}h1{font-size:1.8rem}.primary-summary{font-size:1.25rem;font-weight:600}section{margin:1.5rem 0}h2{font-size:1.2rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.5rem .7rem;text-align:left;vertical-align:top;min-width:5rem}th{white-space:nowrap;background:#f6f7f8}td{max-width:32rem;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;font-size:.85rem}summary{cursor:pointer}details{margin-top:.4rem}.table-scroll{max-width:100%;overflow:auto}.table-scroll table{min-width:48rem}.trace-scroll{max-height:34rem}.trace-scroll th{position:sticky;top:0}.filters{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem}.pass,.status-pass{color:#087854}.fail,.status-fail{color:#a22;background:#fee}.skip,.status-other{color:#765;background:#fff3cd}.filter-input{position:relative;display:inline-block}.filter-input input{box-sizing:border-box;padding-right:1.8em;max-width:100%}.filter-input button{position:absolute;right:.2em;top:50%;transform:translateY(-50%);width:1.4em;height:1.4em;padding:0;border:0;background:transparent;cursor:pointer;font:inherit;line-height:1}@media(max-width:640px){body{margin:1rem}h1{font-size:1.4rem}.filter-input{max-width:100%}}${readerStyles}
body{max-width:1600px;margin:auto;padding:0 24px 24px;overflow-wrap:anywhere}.report-toolbar{position:sticky;top:0;z-index:3;display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:12px 0;background:#f4f6fa;border-bottom:1px solid #d7e1ed}.report-toolbar>label{font-size:12px;color:#52647c}.filters{gap:8px}.filters input:not([type=checkbox]){width:160px;padding-right:30px}.filter-input button{width:24px;height:24px;color:#52647c;border-radius:4px}.primary-summary{padding:16px;border-left:4px solid #2875db;background:#eaf2ff;border-radius:8px}.table-scroll{border:1px solid #d7e1ed;border-radius:8px;background:white;max-height:34rem}th,td{border:0;border-bottom:1px solid #d7e1ed;padding:10px 12px}th{position:sticky;top:0;background:#edf2f9;z-index:1}section{padding:18px;border:1px solid #d7e1ed;background:white;border-radius:10px;box-shadow:0 2px 8px #20345405}section h2{margin-top:0}pre{padding:12px;background:#edf2f9}details{margin:12px 0}td details{margin:4px 0}summary:focus-visible{outline-offset:2px}.pass{color:#16674f;background:#f4fbf7}.skip{color:#755417;background:#fffaed}@media(max-width:640px){body{margin:auto;padding:0 12px 12px}.filters input:not([type=checkbox]){width:120px}.report-toolbar{gap:6px;padding:8px 0}}
</style></head>
<body><div class="report-toolbar">${readerLanguageControl}<div class="filters"><label><input id="failed" type="checkbox">${label("仅失败")}</label> <label for="api">${label("接口")}</label><span class="filter-input"><input id="api"><button id="api-clear" type="button" data-reader-aria-zh="清除接口筛选" data-reader-aria-en="Clear API filter" aria-label="清除接口筛选" title="清除接口筛选" hidden>×</button></span> <label for="row">${label("数据行")}</label><span class="filter-input"><input id="row"><button id="row-clear" type="button" data-reader-aria-zh="清除数据行筛选" data-reader-aria-en="Clear row filter" aria-label="清除数据行筛选" title="清除数据行筛选" hidden>×</button></span></div></div><h1 id="report-summary">${escapeHtml(result.collectionName)}${result.envName ? `（${escapeHtml(result.envName)}）` : ""}</h1>
<p class="primary-summary">${primary}</p>
${result.reportingMode ? `<p>${label("报告模式")} ${escapeHtml(result.reportingMode)}</p><section id="execution-facts"><h2>${label("执行行与协议事实")}</h2><p>${readerText(`真实执行行 ${result.total} · 原始失败行 ${result.failed}`, `Actual case rows ${result.total} · Original failed rows ${result.failed}`)}</p><p>${readerText(`请求开始 requestStarted ${result.requestFacts?.requestStarted ?? "未采集"} · 请求结束 requestCompleted ${result.requestFacts?.requestCompleted ?? "未采集"} · HTTP 交换 httpExchanges ${result.requestFacts?.httpExchanges ?? "未采集"}`, `Requests started ${result.requestFacts?.requestStarted ?? "Not collected"} · Requests completed ${result.requestFacts?.requestCompleted ?? "Not collected"} · HTTP exchanges ${result.requestFacts?.httpExchanges ?? "Not collected"}`)}</p></section>` : ""}
<details><summary>${label("高级报告详情（reporting-units）")}</summary><pre>${escapeHtml(JSON.stringify({ reportingMode: result.reportingMode, reportingUnits: units.summary, workflowUnits: result.workflowUnits }, null, 2))}</pre></details>
${workflowSection(result)}
${traceSection(result)}
${suiteSection(result)}
${units.diagnostics.length ? `<section id="entry-diagnostics"><h2>${label("非请求诊断")}</h2>${table(["条目", "类型", "状态", "原因", "详情"], units.diagnostics.map(entry => [escapeHtml(entry.entryId), label(entry.kind), status(entry.status), escapeHtml([entry.skipReason, entry.error].filter(Boolean).join(" · ") || "-"), details(entry)]))}</section>` : ""}
<h2>${label("真实执行行明细")}</h2>
<div class="table-scroll" tabindex="0"><table><thead><tr><th>${label("节点")}</th><th>${label("接口")}</th><th>${label("用例")}</th><th>${label("数据行")}</th><th>${label("结果")}</th><th>${label("耗时ms")}</th><th>${label("详情")}</th></tr></thead><tbody>${rows}</tbody></table></div>
<script>function filter(){document.querySelectorAll('tr.pass,tr.fail,tr.skip').forEach(function(r){r.hidden=(document.getElementById('failed').checked&&!r.classList.contains('fail'))||!r.cells[1].textContent.includes(document.getElementById('api').value)||(document.getElementById('row').value!==''&&r.cells[3].textContent!==document.getElementById('row').value)});['api','row'].forEach(function(id){document.getElementById(id+'-clear').hidden=document.getElementById(id).value===''})}document.querySelectorAll('input').forEach(function(i){i.addEventListener('input',filter)});['api','row'].forEach(function(id){document.getElementById(id+'-clear').addEventListener('click',function(){var input=document.getElementById(id);input.value='';filter();input.focus()})});filter()</script>
${readerLanguageScript}
</body></html>`;
    if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new Error("HTML report exceeds capacity; safe JSON retained by run host");
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `report-${nextReportFileId()}.html`);
    writeFileSync(file, html);
    return file;
  },
};
