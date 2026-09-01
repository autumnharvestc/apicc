import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reporter } from "../plugin/types.js";
import type { RunResult } from "./types.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const htmlReporter: Reporter = {
  format: "html",
  async render(result: RunResult, outDir: string) {
    const rows = result.cases.map((c) => `
      <tr class="${c.passed ? "pass" : "fail"}">
        <td>${escapeHtml(c.apiName)}</td><td>${escapeHtml(c.caseName)}</td>
        <td>${c.row !== undefined ? c.row : "-"}</td><td>${c.passed ? "通过" : "失败"}</td>
        <td>${c.durationMs.toFixed(1)}</td>
        <td>${[c.error ? escapeHtml(c.error) : "", ...c.assertions.filter((a) => !a.pass).map((a) => escapeHtml(a.message))].filter(Boolean).join("; ") || "-"}</td>
      </tr>`).join("\n");
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>apicc 报告 - ${escapeHtml(result.collectionName)}</title>
<style>body{font-family:sans-serif;margin:2rem}.pass{color:#0a7}.fail{color:#c33;background:#fee}</style></head>
<body><h1>${escapeHtml(result.collectionName)}${result.envName ? `（${escapeHtml(result.envName)}）` : ""}</h1>
<p>总计 ${result.total} · 通过 ${result.passed} · 失败 ${result.failed}</p>
<table border="1" cellpadding="4"><tr><th>接口</th><th>用例</th><th>数据行</th><th>结果</th><th>耗时ms</th><th>详情</th></tr>${rows}</table>
</body></html>`;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `report-${Date.now()}.html`);
    writeFileSync(file, html);
    return file;
  },
};
