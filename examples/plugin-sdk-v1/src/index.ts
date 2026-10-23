import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { definePlugin, type AssertContributionV1, type PluginManifestV1, type ReporterContributionV1 } from "@apicc/plugin-sdk";

// Keep this metadata equal to apicc-plugin.json when changing declarations.
const manifest = {
  "manifestVersion": 1,
  "id": "local.apicc-plugin-demo",
  "name": "apicc-plugin-demo",
  "version": "0.1.0",
  "apiVersion": 1,
  "engines": {
    "apicc": ">=0.1.0 <0.2.0"
  },
  "entry": "./dist/index.js",
  "capabilities": [
    "assert",
    "reporter"
  ],
  "contributions": [
    {
      "kind": "assert",
      "id": "local.apicc-plugin-demo/assert.has-field"
    },
    {
      "kind": "reporter",
      "id": "local.apicc-plugin-demo/reporter.text"
    }
  ]
} satisfies PluginManifestV1;

const hasField: AssertContributionV1 = {
  kind: "assert", id: manifest.contributions[0].id,
  descriptor: { targets: ["bodyJson"], expectedFormat: "text", expectedRequired: true },
  evaluate(actual, expected) {
    const pass = actual !== null && typeof actual === "object" && !Array.isArray(actual)
      && expected !== undefined && Object.hasOwn(actual, expected);
    return { pass, message: pass ? "包含字段" : "缺少字段" };
  },
};

const textReporter: ReporterContributionV1 = {
  kind: "reporter", id: manifest.contributions[1].id,
  async render(report, outDir) {
    const file = resolve(outDir, "apicc-plugin-demo-report.txt");
    const counts = (value: typeof report.rows) =>
      `总计 ${value.total} · 通过 ${value.passed} · 失败 ${value.failed} · 跳过 ${value.skipped}`;
    const lines = [report.title, `执行行：${counts(report.rows)}`];
    if (report.logical) lines.push(`逻辑结果：${counts(report.logical)}`);
    if (report.requestFacts) lines.push(`请求事实：开始 ${report.requestFacts.started} · 完成 ${report.requestFacts.completed} · HTTP 交换 ${report.requestFacts.httpExchanges}`);
    for (const diagnostic of report.diagnostics) lines.push(`诊断：${diagnostic}`);
    const readText = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
    const categories = new Map([["transport", "传输失败"], ["http", "HTTP 失败"], ["script", "脚本失败"],
      ["assertion", "断言失败"], ["extraction", "提取失败"], ["config", "配置失败"], ["aborted", "已中止"]]);
    for (const row of report.cases) {
      if (row.passed !== false) continue;
      lines.push(`失败用例：${readText(row.caseName) ?? "名称未提供"}（用例 ID：${readText(row.caseId) ?? "未提供"}）`);
      const category = readText(row.failureKind);
      if (category) lines.push(`  类别：${categories.get(category) ?? category}`);
      let hasReason = false;
      const error = readText(row.error);
      if (error) { lines.push(`  原因：${error}`); hasReason = true; }
      for (const assertion of Array.isArray(row.assertions) ? row.assertions : []) {
        if (assertion === null || typeof assertion !== "object" || Array.isArray(assertion) || assertion.pass !== false) continue;
        const message = readText(assertion.message) ?? readText(assertion.error);
        if (message) { lines.push(`  断言：${message}`); hasReason = true; }
        const differencePath = readText(assertion.differencePath);
        if (differencePath) lines.push(`  差异路径：${differencePath}`);
        const schemaPath = readText(assertion.schemaPath);
        if (schemaPath) lines.push(`  Schema 路径：${schemaPath}`);
      }
      if (!hasReason) lines.push("  本次投影未提供详细失败原因。");
    }
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    return file;
  },
};

export const plugin = definePlugin({
  manifest,
  setup(context) {
    context.register(hasField);
    context.register(textReporter);
  },
});
export default plugin;
