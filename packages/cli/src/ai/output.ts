import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AiBudgetOverrides, AiBusinessResult, AiContextPreview, AiEvidence, AiResolvedInvocation } from "@apicc/core";
import { stringify } from "yaml";

const labels: Record<string, string> = {
  collected: "已采集", "not-collected": "未采集", omitted: "已省略", legacy: "旧版数据",
  "default-omitted": "默认不发送", "not-authorized": "未授权", "not-selected": "未选中", "legacy-not-collected": "旧版未采集", truncated: "已截断",
  scripts: "脚本", "dataset-rows": "数据集行", "secrets-attachments-absolute-paths": "秘密、附件和本机绝对路径",
  "candidate-count-budget": "受有效候选数预算限制", "candidate-limit": "请求的候选上限",
  contract: "请求与响应契约", "logical-summary": "逻辑结果汇总", "request-summary": "请求统计", "case-outcome": "用例结果", "evidence-state": "证据状态",
  "execution-identity": "执行归属", timings: "耗时", "response-status": "响应状态码", body: "已选正文", "trace-summary": "运行轨迹摘要",
  total: "总数", passed: "通过", failed: "失败", skipped: "跳过", entryDiagnostics: "入口诊断",
  requestStarted: "请求开始数", requestCompleted: "请求完成数", httpExchanges: "HTTP 交换数",
  requestMs: "请求耗时（ms）", scriptMs: "脚本耗时（ms）", iterationMs: "迭代耗时（ms）", durationMs: "耗时（ms）",
  available: "可用", unavailable: "不可用", missing: "未设置", "session-only": "仅本次会话", confirmed: "已确认", unconfirmed: "未确认",
  "case-suggestion": "用例建议", "assertion-suggestion": "断言建议", "report-analysis": "报告分析",
  aborted: "已中止", cancelled: "已取消", noop: "无操作", incomplete: "不完整", "no-data": "无数据",
  "existing-assertions-only": "仅已有断言", "budget-exhausted": "预算耗尽", overflow: "溢出", unaligned: "未对齐",
  "drain-timeout": "排空超时", "warmup-drain-timeout": "预热排空超时", "setup-failed": "准备失败", "vu-setup-failed": "虚拟用户准备失败",
  "teardown-failed": "清理失败", "vu-teardown-failed": "虚拟用户清理失败", "worker-missing": "工作进程缺失", "worker-failed": "工作进程失败",
  "worker-incompatible": "工作进程不兼容", "snapshot-missing": "快照缺失", "snapshot-duplicate": "快照重复", "snapshot-invalid": "快照无效",
  "metrics-budget-exhausted": "指标预算耗尽", "histogram-overflow": "直方图溢出", "timeline-unaligned": "时间线未对齐",
  "phase-window-missing": "阶段时间窗口缺失", dropped: "已丢弃", "policy-limited": "受策略限制", "resource-saturated": "资源饱和", "execution-failed": "执行失败",
  setup: "准备", vuSetup: "虚拟用户准备", "vu-setup": "虚拟用户准备", warmup: "预热", measurement: "正式测量", drain: "排空",
  vuTeardown: "虚拟用户清理", "vu-teardown": "虚拟用户清理", teardown: "清理", pooled: "连接复用", fresh: "每次新建连接",
  "constant-vus": "固定虚拟用户", "constant-arrival": "固定到达率", stages: "分阶段", vus: "虚拟用户数", arrival: "到达率",
  transport: "传输失败", http: "HTTP", script: "脚本失败", assertion: "断言失败", extraction: "提取失败", config: "配置失败",
  "attempt-start": "尝试开始", "attempt-end": "尝试结束", "retry-wait": "等待重试", "handler-start": "错误处理开始", "handler-end": "错误处理结束",
  "handler-skipped": "错误处理跳过", "cleanup-start": "清理开始", "cleanup-end": "清理结束", "cleanup-skipped": "清理跳过", recovered: "已恢复",
  "node-start": "节点开始", "node-end": "节点结束", "node-failure": "节点失败", "node-skipped": "节点跳过", "leaf-wait": "请求等待",
  "leaf-start": "请求开始", "branch-start": "分支开始", "branch-end": "分支结束", "branch-winner": "分支胜出", "session-cleanup-failed": "会话清理失败", "loop-iteration": "循环迭代",
  "exact-nearest-rank": "精确最近秩", "log-histogram": "对数直方图", onError: "错误处理", finally: "最终清理",
  "project-identity": "项目归属不一致", target: "目标不一致", environment: "环境不一致", load: "负载不一致", connection: "连接模式不一致",
  data: "数据身份不一致", statistics: "统计口径不一致", "report-version": "报告版本不一致", "revision-changed": "定义版本已变化",
  "legacy-metadata-unavailable": "旧版元数据缺失", "incomplete-run": "运行不完整", "environment-definition-not-compared": "未比较环境定义",
  "debug-revisions": "调试版本", "debug-failure": "原生调试失败", "debug-warnings": "调试警告", "debug-outcome": "调试用例结果", "debug-exchange": "调试 HTTP 交换", "debug-completeness": "调试采集完整性",
  asset: "保存的资产", free: "自由请求", prepared: "已准备", entered: "已进入传输", "headers-received": "已收到响应头", responded: "已响应",
};
export const aiLabel = (value: string): string => labels[value] ?? value;

type FactFields = Record<string, unknown>;
type Field = readonly [key: string, label: string, unit?: string];
const object = (value: unknown): FactFields => value && typeof value === "object" && !Array.isArray(value) ? value as FactFields : {};
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, unit = ""): string => value === null || value === undefined ? "未采集"
  : typeof value === "boolean" ? value ? "是" : "否" : typeof value === "object" ? "结构化内容请查看原报告" : `${value}${unit ? ` ${unit}` : ""}`;
const state = (value: unknown): string => typeof value === "string" ? aiLabel(value) : "未采集";
const verdict = (value: unknown): string => typeof value === "boolean" ? value ? "通过" : "失败" : state(value);
const fields = (value: FactFields, selected: readonly Field[]) => selected.filter(([key]) => Object.hasOwn(value, key))
  .map(([key, label, unit]) => `${label} ${text(value[key], unit)}`).join("；");
const logicalFields: Field[] = [["total", "总数", "项"], ["passed", "通过", "项"], ["failed", "失败", "项"], ["skipped", "跳过", "项"], ["entryDiagnostics", "入口诊断", "项"]];
const requestFields: Field[] = [["started", "开始", "次"], ["completed", "完成", "次"], ["eligibleCompleted", "计入统计的完成", "次"], ["failed", "失败", "次"]];
const identityFields: Field[] = [["projectId", "项目"], ["definitionRevision", "定义版本"], ["apiId", "接口 ID"], ["caseId", "用例 ID"], ["collectionId", "集合"],
  ["scope", "作用域"], ["workflowId", "工作流"], ["nodeId", "节点"], ["entryId", "入口"], ["suiteRunId", "套件运行"], ["suiteRow", "套件数据行"],
  ["row", "数据行"], ["rowIndex", "行位置"], ["invocationId", "调用"], ["parentInvocationId", "父调用"], ["nodeVisitId", "节点访问"], ["attempt", "尝试次数"],
  ["environmentId", "环境"], ["datasetId", "数据集"], ["dataDigest", "数据指纹"], ["stressRunId", "压测运行"], ["vuId", "虚拟用户"], ["iterationId", "迭代"], ["stageId", "阶段"]];
function metric(value: unknown, unit: string): string {
  const data = object(value);
  if (data.availability === "unavailable") return data.reason ? state(data.reason) : "不可用";
  return text(data.availability === "available" ? data.value : value, unit);
}
function latency(value: unknown): string {
  const data = object(value);
  if (data.availability === "unavailable") return data.reason ? state(data.reason) : "不可用";
  const values = data.availability === "available" ? object(data.value) : data;
  return fields(values, [["min", "最小", "ms"], ["avg", "平均", "ms"], ["max", "最大", "ms"], ["p50", "P50", "ms"], ["p90", "P90", "ms"], ["p95", "P95", "ms"], ["p99", "P99", "ms"]]) || "未采集";
}
function previewText(value: unknown): string {
  const data = object(value);
  if (data.omitted === true) return "已省略";
  return `${text(data.text)}${data.truncated === true ? "（已截断）" : ""}`;
}
function locator(value: unknown): string {
  const data = object(value);
  return [fields(data, identityFields), ...(Array.isArray(data.folderIds) ? [`目录层级：${data.folderIds.map(v => text(v)).join(" / ") || "根目录"}`] : [])].filter(Boolean).join("；");
}
function invocationPath(value: unknown): string[] {
  return rows(value).map((item, index) => { const part = object(item); return `调用路径 ${index + 1}：${fields(part, [["workflowId", "工作流"], ["nodeId", "节点"], ["branchId", "分支"], ["iteration", "迭代"]])}${part.handler ? `；处理阶段：${state(part.handler)}` : ""}`; });
}
function counts(value: unknown): string {
  return fields(object(value), [["total", "总数", "行"], ["ok", "成功", "行"], ["failed", "失败", "行"]]);
}
function renderFact(evidence: AiEvidence): string[] {
  const v = object(evidence.value);
  const finish = (lines: string[], known: readonly string[]) => {
    const extensions = Object.keys(v).filter(key => !known.includes(key));
    return extensions.length ? [...lines, `另有 ${extensions.length} 个扩展字段（${extensions.join("、")}），请按证据位置查看原报告。`] : lines;
  };
  const summary = (label: string, selected: readonly Field[], extra: string[] = [], known: string[] = []) =>
    finish([`${label}：${fields(v, selected) || "未采集"}`, ...extra], [...selected.map(([key]) => key), ...known]);
  switch (evidence.kind) {
    case "logical-summary": return summary("逻辑结果", logicalFields);
    case "request-summary": return summary("请求统计", [["requestStarted", "开始", "次"], ["requestCompleted", "完成", "次"], ["httpExchanges", "HTTP 交换", "次"]]);
    case "debug-outcome": case "case-outcome": return finish([
      `接口：${text(v.apiName)}；用例：${text(v.caseName)}；结果：${v.skipped === true ? "跳过" : verdict(v.passed)}；耗时：${text(v.durationMs, "ms")}`,
      ...[fields(v, identityFields)].filter(Boolean),
      ...(v.error ? [`失败原因：${text(v.error)}`] : []), ...(v.skipReason ? [`跳过原因：${state(v.skipReason)}`] : []), ...(v.failureKind ? [`失败类型：${state(v.failureKind)}`] : []),
      ...rows(v.assertions).map((item, index) => { const assertion = object(item); return `断言 ${index + 1}：${verdict(assertion.pass)}；${text(assertion.message)}${assertion.code ? `；诊断码：${text(assertion.code)}` : ""}${assertion.kind ? `；类型：${state(assertion.kind)}` : ""}`; }),
      ...(v.locator ? [`用例定位：${locator(v.locator)}`] : []),
      ...invocationPath(v.invocationPath),
    ], ["apiName", "caseName", "passed", "skipped", "durationMs", "error", "skipReason", "failureKind", "assertions", "locator", "invocationPath", ...identityFields.map(([key]) => key)]);
    case "debug-revisions": return summary("调试版本", [["sourceProjectRevision", "源项目版本"], ["executionSnapshotRevision", "执行快照版本"], ["sourceApiRevision", "源接口版本"]]);
    case "debug-failure": return summary("原生调试失败", [["errorName", "错误名称"], ["error", "失败原因"]], [`失败类型：${state(v.failureKind)}`], ["failureKind"]);
    case "debug-warnings": return rows(evidence.value).map(warning => `调试警告：${text(warning)}`);
    case "debug-completeness": return summary("HTTP 交换采集", [["exchangeTotal", "交换总数", "次"], ["shown", "已展示", "次"], ["omittedExchangeCount", "省略", "次"]]);
    case "debug-exchange": return summary("调试 HTTP 交换", [["rowIndex", "数据行位置"], ["hopIndex", "跳转位置"], ["order", "交换序号"], ["durationMs", "耗时", "ms"], ["failureStage", "失败阶段"], ["failureCode", "诊断码"]],
      [`传输状态：${state(v.transportState)}；身份可用：${text(v.identityAvailable)}`, `来源：${state(object(v.source).sourceKind)}；${locator(object(v.source).case)}${locator(object(v.source).project)}`,
        `开始：${text(v.startedAt)}；结束：${text(v.finishedAt)}`], ["source", "transportState", "identityAvailable", "startedAt", "finishedAt"]);
    case "evidence-state": return finish([`证据采集：${state(v.state)}；截断：${text(v.truncated)}；脚本诊断：${state(v.scriptDiagnostics)}；正文：${v.bodyUnavailable === true ? "不可用" : v.bodyUnavailable === false ? "可用" : "未声明"}`], ["state", "truncated", "scriptDiagnostics", "bodyUnavailable"]);
    case "execution-identity": return summary("执行归属", identityFields, [...(v.locator ? [`用例定位：${locator(v.locator)}`] : []), ...invocationPath(v.invocationPath)], ["locator", "invocationPath"]);
    case "timings": return summary("耗时", [["requestMs", "请求", "ms"], ["scriptMs", "脚本", "ms"], ["iterationMs", "迭代", "ms"]]);
    case "request": return finish([`请求：${state(v.protocol)} ${text(v.method)}；地址：${previewText(v.url)}`, `请求头：${previewText(v.headers)}`], ["protocol", "method", "url", "headers"]);
    case "response-status": return [`响应状态码：${text(evidence.value)}`];
    case "body": return [`正文：${text(evidence.value)}${evidence.truncated ? "（已截断）" : ""}`];
    case "workflow-units": return rows(evidence.value).map(item => { const unit = object(item); return `工作流调用：${fields(unit, identityFields)}；结果：${state(unit.verdict)}${unit.error ? `；原因：${text(unit.error)}` : ""}`; });
    case "suite": case "workflow": return summary(evidence.kind === "suite" ? "套件结果" : "工作流结果", logicalFields,
      [`运行结论：${state(v.verdict)}`, ...[fields(v, identityFields)].filter(Boolean), ...rows(v.entries).map((item, index) => { const entry = object(item); return `入口 ${index + 1}：${text(entry.label ?? entry.entryId)}；结果：${state(entry.status)}；${fields(entry, identityFields)}${entry.error ? `；原因：${text(entry.error)}` : ""}${entry.caseLocator ? `；用例：${locator(entry.caseLocator)}` : ""}`; })], ["verdict", "entries", ...identityFields.map(([key]) => key)]);
    case "trace-summary": return summary("运行轨迹", [["totalEvents", "事件总数", "个"], ["truncated", "已截断"]]);
    case "trace-event": return summary(`轨迹事件：${state(v.type)}`, identityFields,
      [`状态：${state(v.state)}${v.message ? `；说明：${text(v.message)}` : ""}${v.cause ? `；原因：${state(v.cause)}` : ""}${v.code ? `；诊断码：${text(v.code)}` : ""}${v.delayMs === undefined ? "" : `；等待：${text(v.delayMs, "ms")}`}`,
        ...[fields(v, [["branchId", "分支"], ["iteration", "迭代"]])].filter(Boolean), ...(v.failureKind ? [`失败类型：${state(v.failureKind)}`] : []),
        ...invocationPath(v.invocationPath), ...(v.childInvocation ? [`子调用：${text(object(v.childInvocation).invocationId)}`, ...invocationPath(object(v.childInvocation).invocationPath)] : [])], ["type", "state", "message", "cause", "code", "delayMs", "failureKind", "branchId", "iteration", "childInvocation", "invocationPath"]);
    case "stress-verdict": return finish([`压测结论：${v.status ? state(v.status) : verdict(v.passed)}`,
      ...rows(v.violations).map(item => { const violation = object(item); const [label, unit] = ({ errorRate: ["错误率", "（比例）"], assertionFailureRate: ["断言失败率", "（比例）"], p95: ["请求 P95", "ms"], rps: ["吞吐率", "请求/秒"], businessFailures: ["业务失败", "次"], noData: ["无数据", ""], incomplete: ["完整性", ""] } as Record<string, string[]>)[String(violation.metric)] ?? [text(violation.metric), ""];
        return `阈值不满足：${text(violation.message)}；指标 ${label}；实际 ${text(violation.actual, unit)}；阈值 ${text(violation.expected, unit)}`; })], ["status", "passed", "violations"]);
    case "stress-metrics": return finish([`吞吐率：${metric(v.rps, "请求/秒")}`, `请求延迟：${latency(v.latency)}`, `脚本耗时：${latency(v.scriptLatency)}`, `迭代耗时：${latency(v.iterationLatency)}`], ["rps", "latency", "scriptLatency", "iterationLatency"]);
    case "stress-legacy": return finish([`旧版用例行：${counts({ total: v.totalRequests, ok: v.ok, failed: v.failed })}`, `吞吐率：${metric(v.rps, "请求/秒")}`, `请求延迟：${latency(v.latency)}`, `完整性：${v.incomplete === true ? "不完整" : v.incomplete === false ? "完整" : "未采集"}`], ["totalRequests", "ok", "failed", "rps", "latency", "incomplete"]);
    case "stress-requests": return summary("协议请求统计", requestFields);
    case "stress-http-exchanges": return summary("HTTP 交换统计", [["started", "开始", "次"], ["completed", "完成", "次"]]);
    case "stress-case-rows": return finish([`用例行：${counts(v)}`, ...[fields(object(v.failures), [["transport", "传输失败", "行"], ["http", "HTTP 失败", "行"], ["script", "脚本失败", "行"], ["assertion", "断言失败", "行"], ["extraction", "提取失败", "行"], ["config", "配置失败", "行"], ["aborted", "中止", "行"]])].filter(Boolean)], ["total", "ok", "failed", "failures"]);
    case "stress-iterations": return summary("迭代统计", [["planned", "计划", "次"], ["started", "开始", "次"], ["completed", "完成", "次"], ["passed", "通过", "次"], ["failed", "失败", "次"], ["aborted", "中止", "次"], ["dropped", "丢弃", "次"]], [`迭代耗时：${latency(v.latency)}`, `启动延迟：${latency(v.startDelay)}`], ["latency", "startDelay"]);
    case "stress-completeness": return ["execution", "metrics", "load"].map((key, index) => { const part = object(v[key]); return `${["执行完整性", "指标完整性", "负载完整性"][index]}：${part.complete === true ? "完整" : part.complete === false ? "不完整" : "未采集"}${rows(part.reasons).length ? `；原因：${rows(part.reasons).map(state).join("、")}` : ""}`; });
    case "stress-load": return summary("负载", [["plannedDurationMs", "计划时长", "ms"], ["measurementDurationMs", "测量时长", "ms"], ["drainDurationMs", "排空时长", "ms"], ["policyLimitedMs", "策略限流时长", "ms"], ["saturated", "资源饱和"], ["maxVus", "最大虚拟用户", "个"], ["maxRequestConcurrency", "有效请求并发", "个"], ["requestedMaxRequestConcurrency", "请求的并发上限", "个"], ["requestedMaxRps", "请求的速率上限", "请求/秒"], ["effectiveMaxRps", "有效速率上限", "请求/秒"]],
      [...(v.targetArrivalRate === undefined ? [] : [`目标到达率：${metric(v.targetArrivalRate, "迭代/秒")}`]), ...(v.actualStartRate === undefined ? [] : [`实际启动率：${metric(v.actualStartRate, "迭代/秒")}`])], ["targetArrivalRate", "actualStartRate"]);
    case "stress-statistics": return summary("指标精度与范围", [["minValueMs", "最小可记录值", "ms"], ["gamma", "桶增长系数"], ["bucketCount", "桶数", "个"], ["exactLimit", "精确样本上限", "个"], ["underflow", "下溢样本", "个"], ["overflow", "上溢样本", "个"]],
      [`统计方法：${state(v.method)}；精确统计：${text(v.exact)}；相对误差上限：${text(v.relativeError)}（比例）`], ["method", "exact", "relativeError"]);
    case "stress-lifecycle": return rows(evidence.value).map(item => { const step = object(item); return `${state(step.role)}：${state(step.state)}；耗时 ${text(step.durationMs, "ms")}${step.vuId === null ? "" : `；虚拟用户 ${text(step.vuId)}`}${step.failureKind ? `；原因 ${state(step.failureKind)}` : ""}`; });
    case "stress-phases": return rows(evidence.value).flatMap(item => phaseSummary(object(item)));
    case "stress-timeline": return finish([`时间线：桶宽 ${text(v.bucketWidthMs, "ms")}；已对齐：${text(v.aligned)}；时间不确定度 ${text(v.uncertaintyMs, "ms")}`,
      ...rows(v.buckets).flatMap(item => phaseSummary(object(item), "时间桶"))], ["bucketWidthMs", "aligned", "uncertaintyMs", "buckets"]);
    case "stress-nodes": return rows(evidence.value).flatMap(item => { const node = object(item); return [`节点：${text(node.nodeId ?? node.key)}；工作流 ${text(node.workflowId)}；其他节点合并：${text(node.other)}`,
      fields(node, [["visits", "访问", "次"], ["passed", "通过", "次"], ["failed", "失败", "次"], ["aborted", "中止", "次"], ["skipped", "跳过", "次"]]), `请求：${fields(object(node.requests), requestFields)}；请求延迟：${latency(node.requestLatency)}；节点耗时：${latency(node.nodeLatency)}`]; });
    case "stress-plan": return planSummary(v);
    case "comparison": return comparisonSummary(v);
    default: return [`此类证据尚无专用摘要（${evidence.kind}），请按证据位置查看原报告。`];
  }
}
function phaseSummary(v: FactFields, title = "阶段"): string[] {
  return [`${title}：${v.phase ? state(v.phase) : "时间窗口"}${v.stageId ? ` / ${text(v.stageId)}` : ""}；${fields(v, [["startOffsetMs", "开始偏移", "ms"], ["endOffsetMs", "结束偏移", "ms"], ["durationMs", "时长", "ms"]])}`,
    `吞吐率：${metric(v.rps, "请求/秒")}；用例行：${counts(object(v.caseRows))}；协议请求：${fields(object(v.requests), requestFields)}；HTTP 交换：${fields(object(v.httpExchanges), requestFields)}；请求延迟：${latency(v.latency)}`];
}
function planSummary(v: FactFields): string[] {
  const load = object(v.load), termination = object(v.termination);
  return [`压测计划：${state(load.kind)}；${fields(load, [["vus", "虚拟用户", "个"], ["rate", "到达率", "迭代/秒"], ["startTarget", "起始目标"]])}；连接：${state(v.connectionMode)}`,
    `终止条件：${fields(termination, [["durationMs", "时长", "ms"], ["maxIterations", "最大迭代", "次"]])}`,
    fields(v, [["maxVus", "虚拟用户上限", "个"], ["warmupMs", "预热", "ms"], ["thinkTimeMs", "思考时间", "ms"], ["pacingMs", "节奏间隔", "ms"], ["gracefulStopMs", "优雅停止", "ms"], ["maxRequestConcurrency", "请求并发上限", "个"], ["maxRps", "请求速率上限", "请求/秒"]]),
    `目标：${locator(object(v.target).locator ?? v.target)}`,
    ...rows(load.stages).map(item => { const stage = object(item); return `负载阶段 ${text(stage.id)}：${text(stage.durationMs, "ms")}；目标 ${text(stage.target, load.executor === "arrival" ? "迭代/秒" : "虚拟用户")}`; })];
}
function comparisonSummary(v: FactFields): string[] {
  const side = (value: unknown, label: string) => { const report = object(value); return `${label}：${text(report.reportId)}；定义版本 ${text(report.definitionRevision)}；位置 ${text(report.location)}`; };
  const metrics = object(v.metrics);
  return [`可直接比较：${text(v.directlyComparable)}`, side(v.baseline, "基线报告"), side(v.candidate, "候选报告"),
    ...rows(v.mismatches).map(reason => `不可比较原因：${state(reason)}`), ...rows(v.notices).map(reason => `比较限制：${state(reason)}`),
    ...([["rps", "吞吐率", "请求/秒"], ["p95Ms", "请求 P95", "ms"], ["errorRate", "错误率", "（比例）"], ["iterationsCompleted", "完成迭代", "次"], ["iterationP95Ms", "迭代 P95", "ms"], ["dropped", "丢弃迭代", "次"]] as const).filter(([key]) => Object.hasOwn(metrics, key)).map(([key, label, unit]) => {
      const delta = object(metrics[key]); return `${label}：基线 ${text(delta.base, unit)}；候选 ${text(delta.candidate, unit)}；绝对差 ${text(delta.absolute, unit)}；相对差 ${text(delta.relative, "（比例）")}`;
    })];
}

export function renderAiPreview(preview: AiContextPreview, resolved: AiResolvedInvocation): string {
  // T3's included metadata can survive report evidence exclusion. Present the
  // actual selected body evidence, without claiming Core metadata was repaired.
  const bodies = preview.included.filter(item => item === "contract:request-body" || preview.evidence.some(e => e.kind === "body" && e.location === item));
  return ["AI 外发范围预览（尚未发送）", `目标地址：${resolved.connection.baseUrl}`,
    `模型配置：${resolved.model.id}；模型：${resolved.model.modelId}；协议：${resolved.model.protocol}`,
    `项目：${preview.source.projectId}；定义版本：${preview.source.definitionRevision}`,
    `输入：${preview.bytes} 字节；候选上限：${preview.limit ?? "不适用"}；最大输出：${resolved.budgets.maxOutputTokens} tokens`,
    `请求上限：${resolved.budgets.maxRequests}；传输重试：${resolved.budgets.transportRetries}；结构修复：${resolved.budgets.repairAttempts}；总输出预算：${resolved.budgets.totalOutputTokens} tokens`,
    `总时限：${resolved.budgets.deadlineMs} ms；单请求超时：${resolved.budgets.requestTimeoutMs} ms；证据上限：${resolved.budgets.evidenceCount} 项`,
    `能力：${resolved.capabilityStatus === "confirmed" ? "已确认" : "未确认"}；输入 token 计数/上下文窗口：未确认`,
    `证据：${preview.evidence.length} 项${preview.evidenceSelection ? `（共 ${preview.evidenceSelection.total} 项，未选 ${preview.evidenceSelection.omitted} 项）` : ""}`,
    ...preview.evidence.map(e => `- ${e.id}：${aiLabel(e.kind)} / ${e.location}（${aiLabel(e.state)}）`),
    `实际正文外发：${bodies.join("、") || "无"}`,
    ...preview.omitted.map(e => `未发送：${aiLabel(e.item)}（${aiLabel(e.reason)}）`),
    ...preview.redaction.limitations.map(s => `限制：${s}`), ...resolved.warnings.map(s => `注意：${s}`),
  ].join("\n");
}
export function renderAiResult(result: AiBusinessResult): string {
  if (result.purpose !== "report-analysis") return stringify(result);
  const a = result.analysis;
  return [`AI 辅助报告分析（原报告结论未更改）`, `模型：${result.model.profileId} / ${result.model.modelId}`,
    `报告：${result.source.report?.reportId}；定义版本：${result.source.report?.definitionRevision ?? "未知"}`,
    `生成时间：${result.generatedAt}（UTC）`, `结论：${a.conclusion}`, "程序事实（本次已选安全证据，不依赖模型引用）：",
    ...result.evidence.filter(e => e.kind !== "body").flatMap(e => [`- ${e.id} / ${e.location}（${aiLabel(e.state)}）`, ...renderFact(e).map(line => `  ${line}`)]),
    "模型引用的事实：",
    ...a.observedFacts.flatMap(e => [`- ${e.id} / ${e.location}（${aiLabel(e.state)}）`, ...renderFact(e).map(line => `  ${line}`)]),
    "可能原因（假设）：", ...a.possibleCauses.map(c => `- ${c.text}；依据 ${c.evidenceIds.join("、")}`),
    "核查建议（未执行）：", ...a.checks.map(c => `- ${c.text}；依据 ${c.evidenceIds.join("、")}`),
    "限制：", ...a.limitations.map(s => `- ${s}`),
    `证据选择：${result.evidenceSelection.selected} / ${result.evidenceSelection.total} 项，未选 ${result.evidenceSelection.omitted} 项`,
    `用量：输入 ${result.usage?.inputTokens ?? "未知"} tokens；输出 ${result.usage?.outputTokens ?? "未知"} tokens`,
  ].join("\n");
}
export function renderAiBudgetOverrides(budgets: AiBudgetOverrides): string {
  return fields(budgets, [["deadlineMs", "总期限", "ms"], ["requestTimeoutMs", "单请求超时", "ms"], ["maxRequests", "请求上限", "次"],
    ["transportRetries", "传输重试", "次"], ["repairAttempts", "结构修复", "次"], ["maxOutputTokens", "单请求输出", "tokens"], ["totalOutputTokens", "累计输出", "tokens"],
    ["maxInputTokens", "输入", "tokens"], ["maxInputBytes", "输入", "bytes"], ["maxInstructionBytes", "补充指令", "bytes"], ["maxOutputBytes", "输出", "bytes"],
    ["candidateCount", "候选上限", "项"], ["evidenceCount", "证据上限", "项"], ["maxEventBytes", "单事件", "bytes"], ["maxStreamBytes", "累计流", "bytes"]]) || "未覆盖，继承前层";
}
export function writeAiOutput(out: string, content: string, overwrite: boolean, workspaceRoot?: string): void {
  if (workspaceRoot) {
    let ancestor = resolve(out); const remaining: string[] = [];
    while (!existsSync(ancestor)) { remaining.unshift(basename(ancestor)); const parent = dirname(ancestor); if (parent === ancestor) throw new Error("AI 输出路径无效"); ancestor = parent; }
    const canonical = join(realpathSync(ancestor), ...remaining);
    const within = relative(realpathSync(workspaceRoot), canonical);
    if (!within || (!within.startsWith(`..${sep}`) && within !== ".." && !isAbsolute(within))) {
      throw new Error("AI 独立输出须位于工作区外，不能修改托管资产或原报告");
    }
  }
  if (overwrite && existsSync(out) && statSync(out).nlink > 1) throw new Error("AI 输出目标存在多个硬链接，不能作为独立候选文件覆盖");
  try { writeFileSync(out, content, { flag: overwrite ? "w" : "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("AI 输出文件已存在；请显式使用 --overwrite");
    throw new Error("AI 输出文件无法写入");
  }
}
