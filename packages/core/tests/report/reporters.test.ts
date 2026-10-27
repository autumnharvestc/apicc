import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { htmlReporter } from "../../src/report/html.js";
import { junitReporter } from "../../src/report/junit.js";
import type { RunResult } from "../../src/report/types.js";
import { itCompliesWithReporterContract } from "../contracts/reporter.contract.js";
import { createExecutionEvidenceCollector, createEvidenceBudget, projectExecutionEvidence } from "../../src/report/evidence.js";
import { createCredentialOutputSanitizer } from "../../src/credentials/output.js";
import type { CaseExecutionResult } from "../../src/runner/caseExecutor.js";
import { reportEntryEvidence } from "../../src/report/units.js";

const sample: RunResult = {
  collectionId: "c1", collectionName: "order-api", envName: "dev",
  startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  total: 2, passed: 1, failed: 1,
  cases: [
    { apiId: "a1", apiName: "get-ok", caseId: "t1", caseName: "ok", passed: true, durationMs: 12, assertions: [{ pass: true, message: "eq 通过" }] },
    { apiId: "a1", apiName: "get-ok", caseId: "t2", caseName: "bad", passed: false, durationMs: 30, assertions: [{ pass: false, message: "eq 失败" }], error: "请求失败（timeout）" },
  ],
};

describe("C1 final evidence boundary", () => {
  it("budgets the first trace projection before visiting omitted business messages", () => {
    let reads = 0;
    const events = Array.from({ length: 12 }, () => ({ type: "node-end" as const, nodeId: "E", get message() { reads++; return "E".repeat(256); } }));
    const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, ["E", "D"]);
    const safe = collector.projectRun({ ...sample, cases: [], trace: { events, totalEvents: events.length, truncated: false } }, { reportBytes: 4096, valueBytes: 256 });
    expect(safe.trace?.truncated).toBe(true); expect(reads).toBeLessThan(events.length);
    expect(safe.trace?.events.every((event) => event.nodeId === "E")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(safe))).toBeLessThanOrEqual(4096);
  });
  const execution = (text: string): CaseExecutionResult => ({
    request: { protocol: "http", method: "GET", url: "https://example.test", headers: { Authorization: "Bearer private", Cookie: "sid=cookie-private" }, query: [], auth: { kind: "none" } },
    response: { status: 200, headers: {}, bodyText: text, timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 2, iterationTimeMs: 3,
    outcome: { ...sample.cases[1]!, locator: { collectionId: "c1", folderIds: [], apiId: "a1", caseId: "t2", scope: "base" }, error: text, assertions: [{ pass: false, message: text }] },
    assertionOutcomes: [{ id: "assert-1", op: "eq", selector: { target: "bodyText", match: "first" }, code: "MISMATCH", pass: false, message: text, actual: text, expected: text, differencePath: "$.x" }],
  });
  it("keeps exact v2 attempt evidence when rows are reordered and final logical success in all reporters", async () => {
    const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "rev" }, [], { mode: "all" });
    const identity = { invocationId: "root", invocationPath: [{ workflowId: "wf", branchId: "branch", iteration: 0, handler: "finally" as const }], nodeVisitId: "visit" };
    const failed = execution("early late-secret"); Object.assign(failed.outcome, identity, { attempt: 1, nodeId: "n", entryId: "n" });
    failed.requestStarted = false; failed.requestCompleted = false;
    const passed = execution("second"); Object.assign(passed.outcome, identity, { attempt: 2, nodeId: "n", entryId: "n", passed: true });
    passed.extractionOutcomes = [{ id: "secret", name: "s", selector: { target: "bodyText", match: "first" }, status: "extracted", pass: true, published: true, sensitive: true, code: "OK", message: "ok", value: "late-secret" }];
    collector.observe(failed, { ...identity, attempt: 1, entryId: "n" }); collector.observe(passed, { ...identity, attempt: 2, entryId: "n" });
    const raw: import("../../src/workflow/runner.js").WorkflowRunResult = { ...identity, workflowId: "wf", workflowName: "wf", status: "enabled", total: 1, passed: 1, failed: 0, skipped: 0, verdict: "passed", warnings: [], startedAt: sample.startedAt, finishedAt: sample.finishedAt,
      requestFacts: { requestStarted: 1, requestCompleted: 1, httpExchanges: 1 },
      trace: { events: [
        { ...identity, type: "node-end", nodeId: "n", state: "passed", message: "early late-secret" },
        { ...identity, type: "branch-winner", nodeId: "n", branchId: "winner<&" },
        { ...identity, type: "retry-wait", nodeId: "n", attempt: 1, delayMs: 7 },
        { ...identity, type: "recovered", nodeId: "n" },
        { ...identity, type: "loop-iteration", nodeId: "n", iteration: 0 },
        { ...identity, type: "cleanup-end", nodeId: "n", state: "passed" },
      ], truncated: false, totalEvents: 6 },
      nodeResults: [{ ...identity, attempt: 1, nodeId: "n", label: "request <node>", kind: "request", state: "passed", outcomes: [passed.outcome, failed.outcome], recoveredError: { code: "node-failed", cause: "failure", failureKind: "assertion", message: "late-secret" } }] };
    const safe = collector.projectWorkflow(raw);
    const report = safe.report!;
    expect(report.reportingMode).toBe("workflow-invocation-v2");
    expect(report.cases[0]!.evidence?.response?.body.text).toBe("second");
    expect(report.cases[1]!.evidence?.identity).toMatchObject({ ...identity, attempt: 1 });
    expect(report.cases[1]!.passed).toBe(false);
    expect(safe.nodeResults[0]!.recoveredError?.message).not.toContain("late-secret");
    expect(JSON.stringify(safe)).not.toContain("late-secret");
    const out = mkdtempSync(join(tmpdir(), "apicc-f5-logical-"));
    const xml = readFileSync(await junitReporter.render(report, out), "utf8");
    expect(xml).toContain('tests="1" failures="0"'); expect(xml).not.toContain("<failure"); expect(xml).toContain("failed-attempts");
    const html = readFileSync(await htmlReporter.render(report, out), "utf8");
    expect(html).toContain("workflow-invocation-v2"); expect(html).toContain("passed"); expect(html).toContain("early");
    expect(html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1]).toBe("最终逻辑调用 · 总计 1 · 通过 1 · 失败 0 · 跳过 0");
    const facts = /<section id="execution-facts">([\s\S]*?)<\/section>/.exec(html)![1]!;
    expect(facts).toContain("真实执行行 2"); expect(facts).toContain("原始失败行 1");
    expect(facts).toContain("requestStarted 1"); expect(facts).toContain("requestCompleted 1"); expect(facts).toContain("httpExchanges 1");
    const nodes = /<section id="workflow-nodes">([\s\S]*?)<\/section>/.exec(html)![1]!;
    expect(nodes).toContain("<th>节点</th>"); expect(nodes).toContain("<th>类型</th>"); expect(nodes).toContain("<th>状态</th>");
    expect(nodes).toContain("request &lt;node&gt;"); expect(nodes).toContain("通过（passed）");
    const trace = /<section id="trace">([\s\S]*?)<\/section>/.exec(html)![1]!;
    const readableTrace = trace.replace(/<details>[\s\S]*?<\/details>/g, "");
    expect(readableTrace).toContain("分支胜出（branch-winner）"); expect(readableTrace).toContain("重试等待（retry-wait）");
    expect(readableTrace).toContain("错误已恢复（recovered）"); expect(readableTrace).toContain("清理结束（cleanup-end）");
    expect(readableTrace).toContain("winner&lt;&amp;"); expect(readableTrace).toContain("循环 1"); expect(readableTrace).not.toContain("循环 0");
    expect(readableTrace).toContain("attempt 1"); expect(readableTrace).toContain("等待 7 ms");
    expect(readableTrace.indexOf("node-end")).toBeLessThan(readableTrace.indexOf("branch-winner"));
    expect(readableTrace.indexOf("recovered")).toBeLessThan(readableTrace.indexOf("cleanup-end"));
    expect(trace).toContain('"invocationId": "root"'); expect(trace).toContain('"nodeVisitId": "visit"'); expect(trace).toContain('"invocationPath"');
    expect(html.match(/<tr class="(?:pass|fail|skip)">/g)).toHaveLength(2);
    expect(html).not.toContain("条目 {}"); expect(html).not.toContain("late-secret");
    const truncatedHtml = readFileSync(await htmlReporter.render({ ...report, trace: { ...report.trace!, truncated: true, totalEvents: 9 } }, out), "utf8");
    expect(truncatedHtml).toContain("轨迹已截断"); expect(truncatedHtml).toContain("显示 6 / 9 个事件");
    const bounded = collector.projectWorkflow({ ...raw, trace: { events: Array.from({ length: 20001 }, () => ({ ...identity, type: "node-end", message: "late-secret" })), totalEvents: 20001, truncated: false } });
    expect(bounded.trace?.truncated).toBe(true); expect(bounded.trace!.events.length).toBeLessThanOrEqual(20000);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(JSON.stringify(bounded)).not.toContain("late-secret");
  });
  it("reprojects earlier legacy errors, script assertions and complete bodies with late sensitive markers before truncation", async () => {
    const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "rev" }, ["known-private"]);
    const first = execution("x".repeat(65530) + "late-sensitive" + "known-private");
    const sensitiveObject = { "object-key-secret": { "nested-key-secret": ["late-sensitive", { "array-key-secret": "object-value-secret" }] } };
    first.response!.bodyText = JSON.stringify(sensitiveObject, null, 2) + first.response!.bodyText;
    first.response!.headers.Authorization = "response-private";
    first.outcome.error = "legacy error late-sensitive known-private";
    first.outcome.assertions = [{ pass: false, message: "pm.assert legacy late-sensitive" }];
    first.assertionOutcomes![0]!.expected = "late-sensitive";
    first.outcome.entryId = "one"; first.outcome.row = 0;
    collector.observe(first, { entryId: "one", rowIndex: 0 });
    const later = execution("later");
    later.outcome.entryId = "two"; later.outcome.row = 1;
    later.extractionOutcomes = [{ id: "extract", name: "token", selector: { target: "bodyText", match: "first" }, status: "failed", pass: false, published: false, sensitive: true, code: "FAILED", message: "failed", value: sensitiveObject }];
    collector.observe(later, { entryId: "two", rowIndex: 1 });
    const safe = collector.projectRun({ ...sample, cases: [first.outcome, later.outcome] });
    const json = JSON.stringify(safe);
    for (const secret of ["late-sensitive", "known-private", "cookie-private", "Bearer private", "response-private", "object-key-secret", "nested-key-secret", "array-key-secret", "object-value-secret"]) expect(json).not.toContain(secret);
    expect(safe.cases[0]!.evidence?.response?.body.truncated).toBe(true);
    expect(safe.cases[0]!.evidence?.assertions?.[0]?.differencePath?.text).toBe("$.x");
    const out = mkdtempSync(join(tmpdir(), "apicc-c1-safe-"));
    for (const reporter of [htmlReporter, junitReporter]) {
      const contents = readFileSync(await reporter.render(safe, out), "utf8");
      expect(contents).not.toContain("late-sensitive"); expect(contents).not.toContain("known-private");
      expect(contents).not.toContain("object-key-secret"); expect(contents).not.toContain("nested-key-secret"); expect(contents).not.toContain("array-key-secret");
    }
    const exhaustedBudget = createEvidenceBudget();
    exhaustedBudget.remaining = 0;
    const omitted = projectExecutionEvidence({ execution: first, identity: { projectId: "p", definitionRevision: "rev", entryId: "one" } }, createCredentialOutputSanitizer(["late-sensitive"]), exhaustedBudget);
    expect(omitted.identity.entryId).toBe("one");
    expect(omitted.state).toBe("omitted");
    const small = projectExecutionEvidence({ execution: first, identity: { projectId: "p", definitionRevision: "rev" } }, createCredentialOutputSanitizer(["late-sensitive"]), createEvidenceBudget({ caseBytes: 1024, reportBytes: 1024 }));
    expect(small.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThan(2200); // fixed identity/framing plus a 1 KiB attachment budget
  });
  it("keeps same named scope, entry, source row and node identities distinct", () => {
    const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "rev" }, []);
    const rows = ["base", "env"].flatMap((scope) => [0, 1].map((row) => { const value = execution("<actual & expected>"); value.outcome.scope = scope; value.outcome.row = row; value.outcome.locator!.scope = scope; value.outcome.nodeId = `node-${row}`; value.outcome.entryId = `entry-${row}`;
      collector.observe(value, { entryId: `entry-${row}`, nodeId: `node-${row}`, rowIndex: row }); return value.outcome; }));
    const safe = collector.projectRun({ ...sample, cases: rows });
    expect(new Set(safe.cases.map((row) => JSON.stringify(row.evidence?.identity))).size).toBe(4);
    expect(safe.cases.every((row) => row.evidence?.state === "collected")).toBe(true);
  });
  it("retains real row counts and adds one labeled reporting unit only for unrepresented entry failures", async () => {
    const result: RunResult = { ...sample, total: 1, passed: 1, failed: 0, cases: [{ ...sample.cases[0]!, entryId: "e", suiteRow: 2, scope: "base" }],
      suite: { suiteRunId: "run", projectId: "p", definitionRevision: "rev", environmentId: "env-original", datasetId: "data-original", dataDigest: "original-digest", verdict: "failed", total: 2, passed: 0, failed: 1, skipped: 1,
        entries: [{ entryId: "e", kind: "workflow", workflowId: "original-workflow", suiteRow: 2, status: "failed", error: "container <failed>" }, { entryId: "skip", kind: "case", status: "skipped" }] } };
    const safe = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "rev" }, []).projectRun(result);
    expect(safe.reportingUnits).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0, entryDiagnostics: 1 });
    expect(reportEntryEvidence(safe, safe.suite!.entries![0]!).identity).toMatchObject({ workflowId: "original-workflow", suiteRow: 2, environmentId: "env-original", datasetId: "data-original", dataDigest: "original-digest" });
    const out = mkdtempSync(join(tmpdir(), "apicc-c1-entry-"));
    const xml = readFileSync(await junitReporter.render(safe, out), "utf8");
    expect(xml).toContain('tests="2" failures="1"');
    expect(xml).toContain("NON-HTTP entry-diagnostic");
    expect(xml).toContain("original-workflow");
    expect(safe.total).toBe(1); expect(safe.passed).toBe(1); expect(safe.failed).toBe(0);
    const failed = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "rev" }, []).projectRun({ ...result, passed: 0, failed: 1, cases: [{ ...result.cases[0]!, passed: false, error: "real row <failed>" }] });
    expect(failed.reportingUnits).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0, entryDiagnostics: 0 });
    const html = readFileSync(await htmlReporter.render(failed, out), "utf8");
    expect(html).toContain("real row &lt;failed&gt;");
    expect(html).toContain("container &lt;failed&gt;");
    expect(html).not.toContain("NON-HTTP entry-diagnostic");
    expect(html).toContain("条目"); expect(html).toContain("reporting-units"); expect(html).toContain("总计 1");
    const suiteSection = /<section id="suite-entries">([\s\S]*?)<\/section>/.exec(html);
    expect(suiteSection, "suite entries need a readable table, not only raw JSON").not.toBeNull();
    const entries = suiteSection![1]!.replace(/<details>[\s\S]*?<\/details>/g, "");
    expect(entries).toContain("<th>条目</th>"); expect(entries).toContain("<th>状态</th>"); expect(entries).toContain("container &lt;failed&gt;");
    expect(entries).toContain("跳过（skipped）"); expect(entries).toContain("<td>3</td>");
  });
  it("labels mixed logical units separately from raw execution and leaves absent request facts uncollected", async () => {
    const result: RunResult = { ...sample, reportingMode: "mixed-suite-v2", total: 3, passed: 2, failed: 1,
      workflowUnits: [{ entryId: "flow", workflowId: "wf", invocationId: "inv", verdict: "passed" }],
      cases: [{ ...sample.cases[1]!, entryId: "flow" }, { ...sample.cases[0]!, entryId: "flow" }, { ...sample.cases[0]!, entryId: "case" }] };
    const html = readFileSync(await htmlReporter.render(result, mkdtempSync(join(tmpdir(), "apicc-mixed-readable-"))), "utf8");
    expect(html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1]).toBe("混合逻辑报告单位 · 总计 2 · 通过 2 · 失败 0 · 跳过 0");
    const facts = /<section id="execution-facts">([\s\S]*?)<\/section>/.exec(html)![1]!;
    expect(facts).toContain("真实执行行 3"); expect(facts).toContain("原始失败行 1");
    for (const key of ["requestStarted", "requestCompleted", "httpExchanges"]) {
      expect(facts).toContain(`${key} 未采集`); expect(facts).not.toContain(`${key} 0`);
    }
    expect(html).not.toContain("最终逻辑调用");
    expect(result).toMatchObject({ total: 3, passed: 2, failed: 1 });
  });
});

describe("htmlReporter", () => {
  itCompliesWithReporterContract(htmlReporter, sample);

  it("R21 clears only the chosen offline filter and immediately preserves remaining filters and focus", async () => {
    const result: RunResult = { ...sample, total: 4, passed: 1, failed: 3, cases: [
      { ...sample.cases[0]!, apiName: "alpha", row: 0 },
      { ...sample.cases[1]!, apiName: "alpha", row: 1 },
      { ...sample.cases[1]!, caseId: "beta-first", apiName: "beta", row: 0 },
      { ...sample.cases[1]!, caseId: "beta-second", apiName: "beta", row: 1 },
    ], workflow: { total: 1, passed: 1, failed: 0, skipped: 0, entries: [{ entryId: "node", workflowId: "wf", kind: "workflow", nodeKind: "request", status: "passed" }] },
    trace: { events: [{ type: "node-end", nodeId: "node", state: "passed" }], totalEvents: 1, truncated: false } };
    const html = readFileSync(await htmlReporter.render(result, mkdtempSync(join(tmpdir(), "apicc-clear-"))), "utf8");
    // Only the generated script's small DOM boundary; no browser/layout emulation.
    const elements = new Map<string, { tag: string; attrs: string; value: string; checked: boolean; hidden: boolean; listeners: Record<string, () => void>; addEventListener: (name: string, fn: () => void) => void; focus: () => void }>();
    let focused = "";
    for (const match of html.matchAll(/<(input|button)\b([^>]*)>/g)) {
      const id = /\bid="([^"]+)"/.exec(match[2]!)?.[1]; if (!id) continue;
      const listeners: Record<string, () => void> = {};
      elements.set(id, { tag: match[1]!, attrs: match[2]!, value: "", checked: false, hidden: /\bhidden\b/.test(match[2]!), listeners,
        addEventListener: (name, fn) => { listeners[name] = fn; }, focus: () => { focused = id; } });
    }
    const rows = [...html.matchAll(/<tr class="(pass|fail|skip)">([\s\S]*?)<\/tr>/g)].map(match => ({ hidden: false,
      classList: { contains: (name: string) => match[1] === name },
      cells: [...match[2]!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(cell => ({ textContent: cell[1]! })),
    }));
    expect(rows).toHaveLength(4); // Node/trace statuses must never enter the case filter's selector.
    const document = { getElementById: (id: string) => elements.get(id), querySelectorAll: (selector: string) => {
      if (selector === "input") return [...elements.values()].filter(element => element.tag === "input");
      if (selector === "tr.pass,tr.fail,tr.skip") return rows;
      throw new Error(`Unsupported DOM boundary: ${selector}`);
    } };
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const apiClear = elements.get("api-clear"); const rowClear = elements.get("row-clear");
    expect(apiClear, "API filter must deliver its own clear control").toBeDefined();
    expect(rowClear, "row filter must deliver its own clear control").toBeDefined();
    runInNewContext(script, { document });
    for (const button of [apiClear!, rowClear!]) {
      expect(button.tag).toBe("button"); expect(button.attrs).toContain('type="button"');
      expect(button.hidden).toBe(true); expect(button.attrs).toMatch(/aria-label="[^"]+"/); expect(button.attrs).toMatch(/title="[^"]+"/);
    }
    expect(/aria-label="([^"]+)"/.exec(apiClear!.attrs)![1]).not.toBe(/aria-label="([^"]+)"/.exec(rowClear!.attrs)![1]);
    const change = (id: string, value: string) => { const input = elements.get(id)!; input.value = value; input.listeners.input!(); };
    const visible = () => rows.map(row => !row.hidden);
    change("api", "alpha"); change("row", "2");
    elements.get("failed")!.checked = true; elements.get("failed")!.listeners.input!();
    expect(visible()).toEqual([false, true, false, false]);
    expect(apiClear!.hidden).toBe(false); expect(rowClear!.hidden).toBe(false);
    apiClear!.listeners.click!();
    expect(elements.get("api")!.value).toBe(""); expect(elements.get("row")!.value).toBe("2"); expect(elements.get("failed")!.checked).toBe(true);
    expect(visible()).toEqual([false, true, false, true]); expect(focused).toBe("api");
    expect(apiClear!.hidden).toBe(true); expect(rowClear!.hidden).toBe(false);
    change("api", "alpha"); rowClear!.listeners.click!();
    expect(elements.get("row")!.value).toBe(""); expect(elements.get("api")!.value).toBe("alpha"); expect(elements.get("failed")!.checked).toBe(true);
    expect(visible()).toEqual([false, true, false, false]); expect(focused).toBe("row");
    expect(apiClear!.hidden).toBe(false); expect(rowClear!.hidden).toBe(true);
    elements.get("failed")!.checked = false; elements.get("failed")!.listeners.input!();
    expect(visible()).toEqual([true, true, false, false]);
    apiClear!.listeners.click!(); expect(visible()).toEqual([true, true, true, true]);
    expect(apiClear!.hidden).toBe(true); expect(rowClear!.hidden).toBe(true);
    expect(result.cases.map(item => item.row)).toEqual([0, 1, 0, 1]);
  });

  it("包含汇总与用例明细", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-html-"));
    const rows: RunResult = { ...sample, total: 3, passed: 2, cases: [
      ...sample.cases.map((item, row) => ({ ...item, row })),
      { ...sample.cases[0]!, caseId: "no-row" },
    ] };
    const file = await htmlReporter.render(rows, outDir);
    const html = readFileSync(file, "utf8");
    expect(html).toContain("order-api");
    expect(html).toContain("bad");
    expect(html).toContain("eq 失败");
    const displayedRows = [...html.matchAll(/<tr class="(?:pass|fail|skip)">([\s\S]*?)<\/tr>/g)]
      .map(match => [...match[1]!.matchAll(/<td>([\s\S]*?)<\/td>/g)][3]![1]);
    expect(displayedRows).toEqual(["1", "2", "-"]);
    expect(rows.cases.map(item => item.row)).toEqual([0, 1, undefined]);
  });
});

describe("junitReporter", () => {
  itCompliesWithReporterContract(junitReporter, sample);

  it("产出合法 testsuites 结构，失败用例含 failure 节点", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-junit-"));
    const file = await junitReporter.render(sample, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain("<testsuites");
    expect(xml).toContain('failures="1"');
    expect(xml).toContain("<failure");
  });
});

const hostile: RunResult = {
  collectionId: "c1", collectionName: `x"&</title><script>alert(1)</script>`, envName: "dev",
  startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  total: 1, passed: 0, failed: 1,
  cases: [
    {
      apiId: "a1", apiName: `api<&"`, caseId: "t1", caseName: `case<&"\u0007`, row: 3,
      passed: false, durationMs: 5,
      assertions: [{ pass: false, message: `msg<&">` }],
      error: `err&<>"\u0007`,
    },
  ],
};

const skipped: RunResult = {
  ...sample,
  total: 3, passed: 1, failed: 1, skipped: 1,
  cases: [
    ...sample.cases,
    { apiId: "a1", apiName: `skip<&`, caseId: "t3", caseName: `pruned<&`, nodeId: "node-7", passed: false, skipped: true, skipReason: `条件<&\"`, durationMs: 0, assertions: [] },
  ],
};

describe("skipped 三态报告", () => {
  it("HTML 显示独立 skipped 样式、节点归属、原因和计数", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-html-skip-"));
    const file = await htmlReporter.render(skipped, outDir);
    const html = readFileSync(file, "utf8");
    expect(html).toContain("跳过 1");
    expect(html).toContain('class="skip"');
    expect(html).toContain("node-7");
    expect(html).toContain("条件&lt;&amp;\"");
  });

  it("JUnit 在 testsuites 和 testsuite 独立计 skipped，并写 skipped 节点", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-junit-skip-"));
    const file = await junitReporter.render({
      ...skipped,
      total: 4,
      passed: 1,
      failed: 1,
      skipped: 2,
      cases: [
        ...skipped.cases,
        { apiId: "a1", apiName: "skip<&", caseId: "t3", caseName: "pruned<&", nodeId: "node-8", passed: false, skipped: true, skipReason: "另一个原因", durationMs: 0, assertions: [] },
      ],
    }, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain('<testsuites tests="4" failures="1" skipped="2">');
    expect(xml).toContain('<testsuite name="order-api" tests="4" failures="1" skipped="2">');
    expect(xml).toContain('<skipped message="条件&lt;&amp;&quot;"/>');
    expect(xml).toContain('name="node-7:skip&lt;&amp;.pruned&lt;&amp;"');
    expect(xml).toContain('name="node-8:skip&lt;&amp;.pruned&lt;&amp;"');
    expect(xml).not.toContain("<failure message=\"条件");
  });

  it("旧版 collection 结果缺少 skipped 时按零处理", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-junit-old-"));
    const file = await junitReporter.render({ ...sample, skipped: undefined }, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain('tests="2" failures="1" skipped="0"');
  });
});

describe("转义加固与文件名唯一", () => {
  it("HTML 不含原始 <script> 与裸控制字符", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-esc-h-"));
    const file = await htmlReporter.render(hostile, outDir);
    const html = readFileSync(file, "utf8");
    expect(html).not.toContain(`<script>alert(1)`);
    expect(html).toContain(`&lt;script&gt;alert(1)&lt;/script&gt;`);
    expect(html).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    expect(html).toContain(`err&amp;&lt;&gt;"`);
  });

  it("JUnit 不含裸控制字符且属性正确转义", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-esc-j-"));
    const file = await junitReporter.render(hostile, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    expect(xml).toContain(`classname="x&quot;&amp;&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`);
    expect(xml).toContain(`name="api&lt;&amp;&quot;.case&lt;&amp;&quot;#3"`);
  });

  it("failure 节点聚合 error 与全部失败断言消息（error 优先）", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-junit-agg-"));
    const file = await junitReporter.render(sample, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain(`message="请求失败（timeout）; eq 失败"`);
  });

  it("failure 无 error 用断言消息，均空回退「断言失败」", async () => {
    const r: RunResult = {
      collectionId: "c1", collectionName: "c",
      startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
      total: 2, passed: 0, failed: 2,
      cases: [
        { apiId: "a", apiName: "api", caseId: "t1", caseName: "assert-fail", passed: false, durationMs: 1, assertions: [{ pass: false, message: "仅断言失败" }] },
        { apiId: "a", apiName: "api", caseId: "t2", caseName: "silent-fail", passed: false, durationMs: 1, assertions: [] },
      ],
    };
    const outDir = mkdtempSync(join(tmpdir(), "apicc-junit-fb-"));
    const file = await junitReporter.render(r, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain(`message="仅断言失败"`);
    expect(xml).toContain(`message="断言失败"`);
  });

  it("文件名使用单调 ULID，同毫秒连续渲染不碰撞", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-ulid-"));
    const h1 = await htmlReporter.render(sample, outDir);
    const h2 = await htmlReporter.render(sample, outDir);
    const j1 = await junitReporter.render(sample, outDir);
    expect(basename(h1)).toMatch(/^report-[0-9A-HJKMNP-TV-Z]{26}\.html$/);
    expect(basename(j1)).toMatch(/^junit-[0-9A-HJKMNP-TV-Z]{26}\.xml$/);
    expect(h1).not.toBe(h2);
    expect(existsSync(h1)).toBe(true);
    expect(existsSync(h2)).toBe(true);
  });
});
