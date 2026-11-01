import { describe, expect, it } from "vitest";
import { renderAiResult } from "../src/ai/output.js";
import { createDefaultAiConfigDocument, createProjectSnapshot, prepareAiContext, resolveAiInvocation, runAiAssistance } from "@apicc/core";
import type { AiBusinessResult, AiEvidence, AiInvocationHost } from "@apicc/core";
import { DebugResultSchema } from "@apicc/core/schema";
import { contractExecutionIds, createContractExecutionProject } from "../../core/tests/helpers/contractExecutionFixtures.js";
import { resolveRequestSettings } from "../../core/src/request/settings.js";

// Each value mirrors the named projection in Core ai/analysis.ts; renderer
// assertions check visible business meaning, never a serialized DTO snapshot.
const fact = (kind: string, value: unknown, location = kind): AiEvidence => ({ purpose: "report-analysis", id: `report:e-${kind}`, kind, location, state: "collected", value });
function render(...facts: AiEvidence[]): string {
  const result: AiBusinessResult = { purpose: "report-analysis", label: "AI 辅助", generatedAt: "2026-10-31T00:00:00.000Z", timeZone: "UTC",
    source: { kind: "local", bindingId: "binding", projectId: "project", definitionRevision: "revision", editRevision: 0, unsaved: false },
    model: { profileId: "profile", modelId: "model", connectionId: "connection" },
    analysis: { conclusion: "保留结论原文", observedFacts: facts, possibleCauses: [], checks: [], limitations: [] }, evidence: facts,
    evidenceSelection: { selected: facts.length, total: facts.length, omitted: 0 },
  };
  return renderAiResult(result);
}
describe("readable projected report facts", () => {
  it("separates logical outcomes from real request statistics with count units including zero", () => {
    const text = render(fact("logical-summary", { total: 3, passed: 1, failed: 1, skipped: 1, entryDiagnostics: 0 }),
      fact("request-summary", { requestStarted: 4, requestCompleted: 3, httpExchanges: 5 }));
    expect(text).toContain("逻辑结果：总数 3 项；通过 1 项；失败 1 项；跳过 1 项；入口诊断 0 项");
    expect(text).toContain("请求统计：开始 4 次；完成 3 次；HTTP 交换 5 次");
    expect(text).toContain("保留结论原文");
  });
  it("renders case verdict and assertion messages as named business rows rather than array indices", () => {
    const text = render(fact("case-outcome", { apiName: "订单", caseName: "缺少参数", passed: false, durationMs: 12,
      assertions: [{ pass: false, message: "状态码不匹配", code: "ASSERT_STATUS" }, { pass: true, message: "业务原文 OK" }] }, "cases[0]"));
    expect(text).toContain("接口：订单；用例：缺少参数；结果：失败；耗时：12 ms");
    expect(text).toContain("断言 1：失败；状态码不匹配；诊断码：ASSERT_STATUS");
    expect(text).toContain("断言 2：通过；业务原文 OK");
    expect(text).not.toContain("assertions：0");
    expect(text).not.toContain("false");
  });
  it("localizes collection availability, truncation, script diagnostics and missing body states", () => {
    const text = render(fact("evidence-state", { state: "collected", truncated: false, scriptDiagnostics: "not-collected", bodyUnavailable: true }, "failureEvidence[0]"));
    expect(text).toContain("证据采集：已采集；截断：否；脚本诊断：未采集；正文：不可用");
    expect(text).not.toContain("bodyUnavailable");
    expect(text).not.toContain("not-collected");
  });
  it("renders real v2 stress metric wrappers with throughput and latency units and explicit unavailable reasons", () => {
    const text = render(fact("stress-metrics", { rps: { availability: "available", value: 2.5 },
      latency: { availability: "available", value: { min: 1, avg: 23.5, max: 99, p50: 12, p90: 30, p95: 35, p99: 50 } },
      scriptLatency: { availability: "unavailable", reason: "not-collected" }, iterationLatency: { availability: "unavailable", reason: "no-data" } }, "metrics"));
    expect(text).toContain("吞吐率：2.5 请求/秒");
    expect(text).toContain("请求延迟：最小 1 ms；平均 23.5 ms；最大 99 ms；P50 12 ms；P90 30 ms；P95 35 ms；P99 50 ms");
    expect(text).toContain("脚本耗时：未采集");
    expect(text).toContain("迭代耗时：无数据");
    expect(text).not.toContain("availability");
  });
  it("keeps old stress observations and API text while disclosing unknown extension facts without flattening them", () => {
    const body = '{"business":"原始响应内容"}';
    const text = render(fact("stress-legacy", { totalRequests: 0, ok: 0, failed: 0, rps: 0, latency: { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 }, incomplete: true }),
      fact("body", body), fact("future-extension", { newData: { nested: "not a human summary" } }));
    expect(text).toContain("旧版用例行：总数 0 行；成功 0 行；失败 0 行");
    expect(text).toContain("吞吐率：0 请求/秒");
    expect(text).toContain("完整性：不完整");
    expect(text).toContain(body);
    expect(text).toContain("此类证据尚无专用摘要（future-extension），请按证据位置查看原报告");
    expect(text).not.toContain("newData：nested");
  });
  it("explains recorded stress precision and reports new fields without guessing their meaning", () => {
    const text = render(fact("stress-statistics", { method: "log-histogram", exact: false, relativeError: 0.01,
      minValueMs: 0.001, gamma: 1.01, bucketCount: 4608, exactLimit: 256, underflow: 0, overflow: 2, futurePrecision: { a: 1 } }));
    expect(text).toContain("统计方法：对数直方图；精确统计：否；相对误差上限：0.01（比例）");
    expect(text).toContain("最小可记录值 0.001 ms");
    expect(text).toContain("上溢样本 2 个");
    expect(text).toContain("另有 1 个扩展字段（futurePrecision）");
    expect(text).not.toContain("futurePrecision：a");
  });
});

async function finalCNativeResult(observed: 'empty' | 'all', selectedOnly = false, bodyIncluded = false) {
  const snapshot = createProjectSnapshot(createContractExecutionProject('https://synthetic.example.test'));
  const locator = { workspaceId: 'workspace', groupId: 'group', projectId: snapshot.project.id, collectionId: contractExecutionIds.collection,
    folderIds: [contractExecutionIds.outerFolder, contractExecutionIds.innerFolder], apiId: contractExecutionIds.contract };
  const report = DebugResultSchema.parse({ runId: 'final-c-native', source: { sourceKind: 'asset', locator, sourceApiRevision: 'api-revision' },
    sourceProjectRevision: snapshot.definitionRevision, executionSnapshotRevision: 'execution-revision', mode: 'request',
    startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z',
    run: { collectionName: 'Native Debug', total: 1, passed: 0, failed: 1, startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' },
    outcomes: [{ apiName: 'Native API', caseName: 'Native failure case', passed: false, durationMs: 17, assertions: [{ pass: false, message: 'Native condition failed' }],
      evidence: { state: 'collected', scriptDiagnostics: 'not-collected', truncated: false, identity: { projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision },
        response: { status: 503, headers: { text: '', truncated: false }, body: { text: 'FINAL_C_UNSELECTED_BODY', truncated: false } } } }],
    exchanges: [{ source: { sourceKind: 'asset', case: { ...locator, caseId: contractExecutionIds.case, scope: 'base' } }, rowIndex: 0, hopIndex: 0, order: 1,
      transportState: 'failed', settings: resolveRequestSettings(), startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z', durationMs: 23, failureStage: 'connect', failureCode: 'FINAL_C_CONNECT_FAILURE' }],
    exchangeTotal: 3, omittedExchangeCount: 2,
    replay: { mode: 'request', sourceKind: 'asset', locator, parameters: {}, fields: [], available: false }, console: [],
    warnings: ['FINAL_C_NATIVE_WARNING'], failureKind: 'transport', errorName: 'NativeTransportError', error: 'FINAL_C_NATIVE_FAILURE' });
  const before = JSON.stringify(report);
  const input = { purpose: 'report-analysis' as const, snapshot, context: snapshot.context, source: { kind: 'local' as const, bindingId: 'binding', rootIdentity: 'opaque-root',
    projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, editRevision: 0 }, reportId: 'final-c-native', report,
    bodySelection: bodyIncluded ? ['outcomes[0].evidence.response.body'] : [] };
  const full = prepareAiContext(input), summary = full.evidence.find(item => item.kind === 'logical-summary')!;
  const preview = selectedOnly ? prepareAiContext({ ...input, evidenceSelection: [summary.id] }) : full;
  const document = createDefaultAiConfigDocument();
  document.connections = [{ id: 'c', revision: 1, name: 'Synthetic', owner: { kind: 'personal' }, baseUrl: 'https://ai.example.test/v1', auth: { kind: 'bearer' }, headers: {}, protocols: ['openai-chat-completions'] }];
  document.models = [{ id: 'm', revision: 1, connectionId: 'c', modelId: 'synthetic', protocol: 'openai-chat-completions', structuredOutput: 'json-object', streaming: false,
    supportedParameters: [], capabilities: { status: 'unconfirmed', source: 'manual' }, budgets: {}, purposeBudgets: {} }];
  const resolved = resolveAiInvocation({ document, purpose: 'report-analysis', modelProfileId: 'm' });
  const host: AiInvocationHost = { run: async (_input, execute) => execute({ invoke: async () => ({ terminal: 'completed', text: JSON.stringify({ conclusion: 'Legal model conclusion',
    observedFacts: observed === 'empty' ? [] : preview.evidence.map(item => ({ evidenceIds: [item.id] })), possibleCauses: [], checks: [], limitations: [] }) }) }) };
  const result = await runAiAssistance(preview, resolved, host, { signal: new AbortController().signal });
  expect(result.purpose).toBe('report-analysis'); expect(JSON.stringify(report)).toBe(before);
  if (!bodyIncluded) expect(JSON.stringify(result)).not.toContain('FINAL_C_UNSELECTED_BODY');
  return result;
}
it('final C I1 CLI retains selected program facts when a valid formal Core model response cites none', async () => {
  const result = await finalCNativeResult('empty'); if (result.purpose !== 'report-analysis') throw new Error('fixture purpose');
  expect(result.analysis.observedFacts).toEqual([]); expect(result.evidence.some(item => item.kind === 'debug-failure')).toBe(true);
  const text = renderAiResult(result);
  for (const expected of ['FINAL_C_NATIVE_FAILURE', 'FINAL_C_NATIVE_WARNING', 'Native failure case', '17 ms']) expect.soft(text).toContain(expected);
  expect(text).not.toContain('FINAL_C_UNSELECTED_BODY');
});
it('final C I1 CLI summarizes real native Debug kinds with units rather than unknown-kind fallback', async () => {
  const text = renderAiResult(await finalCNativeResult('all'));
  for (const expected of ['NativeTransportError', 'FINAL_C_NATIVE_FAILURE', 'FINAL_C_NATIVE_WARNING', 'Native failure case', 'Native condition failed', '17 ms', 'FINAL_C_CONNECT_FAILURE', '23 ms']) expect.soft(text).toContain(expected);
  expect.soft(text).toMatch(/交换.*3.*(?:次|项|个)/);
  expect(text).not.toMatch(/无专用摘要（debug-/);
});
it('final C I1 selected raw body is not promoted into independent program facts when the model cites none', async () => {
  const result = await finalCNativeResult('empty', false, true); if (result.purpose !== 'report-analysis') throw new Error('fixture purpose');
  expect(result.evidence.find(item => item.kind === 'body')?.value).toBe('FINAL_C_UNSELECTED_BODY');
  expect(renderAiResult(result)).not.toContain('FINAL_C_UNSELECTED_BODY');
});
it('final C I1 CLI never restores excluded native facts or unselected body while retaining the selected summary', async () => {
  const result = await finalCNativeResult('empty', true); if (result.purpose !== 'report-analysis') throw new Error('fixture purpose');
  expect(result.evidence.map(item => item.kind)).toEqual(['logical-summary']);
  const text = renderAiResult(result);
  expect.soft(text).toContain('总数 1 项');
  for (const excluded of ['FINAL_C_NATIVE_FAILURE', 'FINAL_C_NATIVE_WARNING', 'FINAL_C_UNSELECTED_BODY', 'Native condition failed']) expect(text).not.toContain(excluded);
});
