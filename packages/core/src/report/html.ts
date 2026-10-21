import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import type { Reporter } from "../plugin/types.js";
import type { RunResult } from "./types.js";
import { reportingUnits, caseReportingIdentity } from "./units.js";

const nextReportFileId = monotonicFactory();

function escapeHtml(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const htmlReporter: Reporter = {
  format: "html",
  async render(result: RunResult, outDir: string) {
    const units = reportingUnits(result);
    const rows = result.cases.map((c) => `
      <tr class="${c.skipped ? "skip" : c.passed ? "pass" : "fail"}">
        <td>${escapeHtml(c.nodeId ?? "-")}</td><td>${escapeHtml(c.apiName)}</td><td>${escapeHtml(c.caseName)}</td>
        <td>${c.row !== undefined ? c.row + 1 : "-"}</td><td>${c.skipped ? "跳过" : c.passed ? "通过" : "失败"}</td>
        <td>${c.durationMs.toFixed(1)}</td>
        <td>${[c.skipReason ? escapeHtml(c.skipReason) : "", c.error ? escapeHtml(c.error) : "", ...c.assertions.filter((a) => !a.pass).map((a) => escapeHtml(a.message))].filter(Boolean).join("; ") || "-"}<details><summary>${escapeHtml(caseReportingIdentity(c))}</summary><pre>${escapeHtml(JSON.stringify(c.evidence ?? { state: "not-collected", reason: "旧记录未采集" }, null, 2))}</pre></details></td>
      </tr>`).join("\n");
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>apicc 报告 - ${escapeHtml(result.collectionName)}</title>
<style>body{font-family:sans-serif;margin:2rem}.pass{color:#0a7}.fail{color:#c33;background:#fee}.skip{color:#765;background:#fff3cd}.filter-input{position:relative;display:inline-block}.filter-input input{box-sizing:border-box;padding-right:1.8em}.filter-input button{position:absolute;right:.2em;top:50%;transform:translateY(-50%);width:1.4em;height:1.4em;padding:0;border:0;background:transparent;cursor:pointer;font:inherit;line-height:1}</style></head>
<body><h1>${escapeHtml(result.collectionName)}${result.envName ? `（${escapeHtml(result.envName)}）` : ""}</h1>
<p>总计 ${result.total} · 通过 ${result.passed} · 失败 ${result.failed} · 跳过 ${result.skipped ?? 0}</p>
<p>条目 ${escapeHtml(JSON.stringify(result.suite ? { total: result.suite.total, passed: result.suite.passed, failed: result.suite.failed, skipped: result.suite.skipped, verdict: result.suite.verdict } : {}))} · reporting-units ${escapeHtml(JSON.stringify(units.summary))}</p>
${result.workflow ? `<details><summary>工作流节点统计及状态</summary><pre>${escapeHtml(JSON.stringify(result.workflow, null, 2))}</pre></details>` : ""}
${result.suite?.entries ? `<details><summary>套件条目状态及错误</summary><pre>${escapeHtml(JSON.stringify(result.suite.entries, null, 2))}</pre></details>` : ""}
${units.diagnostics.map((entry) => `<p class="fail">NON-HTTP entry-diagnostic ${escapeHtml(JSON.stringify(entry))}</p>`).join("")}
<label><input id="failed" type="checkbox">仅失败</label> <label for="api">接口</label><span class="filter-input"><input id="api"><button id="api-clear" type="button" aria-label="清除接口筛选" title="清除接口筛选" hidden>×</button></span> <label for="row">数据行</label><span class="filter-input"><input id="row"><button id="row-clear" type="button" aria-label="清除数据行筛选" title="清除数据行筛选" hidden>×</button></span>
<table border="1" cellpadding="4"><tr><th>节点</th><th>接口</th><th>用例</th><th>数据行</th><th>结果</th><th>耗时ms</th><th>详情</th></tr>${rows}</table>
<script>function filter(){document.querySelectorAll('tr.pass,tr.fail,tr.skip').forEach(function(r){r.hidden=(document.getElementById('failed').checked&&!r.classList.contains('fail'))||!r.cells[1].textContent.includes(document.getElementById('api').value)||(document.getElementById('row').value!==''&&r.cells[3].textContent!==document.getElementById('row').value)});['api','row'].forEach(function(id){document.getElementById(id+'-clear').hidden=document.getElementById(id).value===''})}document.querySelectorAll('input').forEach(function(i){i.addEventListener('input',filter)});['api','row'].forEach(function(id){document.getElementById(id+'-clear').addEventListener('click',function(){var input=document.getElementById(id);input.value='';filter();input.focus()})});filter()</script>
</body></html>`;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `report-${nextReportFileId()}.html`);
    writeFileSync(file, html);
    return file;
  },
};
