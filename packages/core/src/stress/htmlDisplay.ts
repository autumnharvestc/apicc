/** Internal display-only HTML helpers. Business values are escaped, never executable. */
import {stressSafetyCodeLabels} from './presentation.js';
export const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export const text = (zh: string, en: string): string => `<span data-zh="${escapeHtml(zh)}" data-en="${escapeHtml(en)}">${escapeHtml(zh)}</span>`;
export const notCollected = () => text("未采集", "Not collected");
export const notApplicable = () => text("不适用", "Not applicable");
export const notComputable = () => text("不可计算（数据缺失或基线为零）", "Not computable (missing data or zero baseline)");
export function number(value: number): string {
  if (!Number.isFinite(value)) return notComputable();
  if (value !== 0 && Math.abs(value) < .001) return Number(value.toPrecision(3)).toExponential();
  return String(Number(value.toFixed(3)));
}
export const ms = (value: number) => `${number(value)} ms`;
export const percent = (value: number) => `${number(value * 100)}%`;
export const yesNo = (value: boolean) => value ? text("是", "Yes") : text("否", "No");
/** Freeze wall-time presentation in the exporting process, not the viewing browser. */
export function wallTime(value: number): string {
  const date = new Date(value), original = escapeHtml(value);
  if (Number.isNaN(date.getTime())) return `<span class="wall-time" title="${original}">${text(`时间超出可读范围；原始时间戳：${value} ms`, `Time outside the readable range; original timestamp: ${value} ms`)}</span>`;
  const pad = (part: number, width = 2) => String(part).padStart(width, "0");
  const year = date.getFullYear(), offset = -date.getTimezoneOffset(), absolute = Math.abs(offset);
  const readable = `${year < 0 ? "-" : ""}${pad(Math.abs(year), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} UTC${offset < 0 ? "-" : "+"}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return `<time class="wall-time" datetime="${date.toISOString()}" title="${original}">${readable}</time>`;
}
function fingerprint(value: string): string {
  if (value.length <= 12) return escapeHtml(value);
  return `<details class="fingerprint"><summary><span class="fingerprint-short">${escapeHtml(value.slice(0, 8))}…${escapeHtml(value.slice(-4))}</span> · ${text("展开完整值", "Show full value")}</summary><code class="fingerprint-full">${escapeHtml(value)}</code></details>`;
}
const codes: Record<string, readonly [string, string]> = {
  pending:['等待中','Pending'], preparing:['准备中','Preparing'], ready:['已准备','Ready'], running:['运行中','Running'], finished:['已完成','Finished'], uploading:['上传中','Uploading'],complete:['已完整上传','Upload complete'],'timed-out':['已超时','Timed out'],interrupted:['已中断','Interrupted'],
  available: ["可用", "Available"], partial: ["部分可用", "Partially available"], unavailable: ["不可用", "Unavailable"],
  passed: ["通过", "Passed"], failed: ["失败", "Failed"], incomplete: ["不完整", "Incomplete"], aborted: ["已中止", "Aborted"], skipped: ["已跳过", "Skipped"],
  "no-data": ["无合格样本，无法计算", "No eligible samples; cannot calculate"], "not-collected": ["未采集", "Not collected"], legacy: ["旧版未采集", "Not collected by the legacy report"],
  "budget-exhausted": ["指标预算耗尽", "Metric budget exhausted"], overflow: ["超出统计范围", "Outside the statistical range"], unaligned: ["时序未对齐", "Timeline unaligned"],
  setup: ["运行准备", "Run setup"], "vu-setup": ["VU 准备", "VU setup"], vuSetup: ["VU 准备", "VU setup"], warmup: ["预热", "Warmup"], measurement: ["正式测量", "Measurement"],
  drain: ["排空在途执行", "Drain in-flight execution"], "vu-teardown": ["VU 收尾", "VU teardown"], vuTeardown: ["VU 收尾", "VU teardown"], teardown: ["运行收尾", "Run teardown"],
  execution: ["执行", "Execution"], metrics: ["指标", "Metrics"], load: ["负载", "Load"],
  cancelled: ["用户取消", "Cancelled"], "drain-timeout": ["排空超时", "Drain timeout"], "warmup-drain-timeout": ["预热排空超时", "Warmup drain timeout"],
  "setup-failed": ["运行准备失败", "Run setup failed"], "vu-setup-failed": ["VU 准备失败", "VU setup failed"], "teardown-failed": ["运行收尾失败", "Run teardown failed"], "vu-teardown-failed": ["VU 收尾失败", "VU teardown failed"],
  "worker-missing": ["缺少工作进程", "Worker missing"], "worker-failed": ["工作进程失败", "Worker failed"], "worker-incompatible": ["工作进程不兼容", "Worker incompatible"],
  "snapshot-missing": ["缺少最终快照", "Final snapshot missing"], "snapshot-duplicate": ["重复快照", "Duplicate snapshot"], "snapshot-invalid": ["快照无效", "Invalid snapshot"],
  "metrics-budget-exhausted": ["指标预算耗尽", "Metric budget exhausted"], "histogram-overflow": ["直方图溢出", "Histogram overflow"], "timeline-unaligned": ["时间轴未对齐", "Timeline unaligned"], "phase-window-missing": ["缺少阶段覆盖窗口", "Phase coverage window missing"],
  dropped: ["已丢弃迭代槽", "Dropped iteration slots"], "policy-limited": ["策略限流", "Policy limited"], "resource-saturated": ["资源饱和", "Resource saturated"], "execution-failed": ["执行失败", "Execution failed"],
  transport: ["传输失败", "Transport failure"], http: ["HTTP 失败", "HTTP failure"], script: ["脚本失败", "Script failure"], assertion: ["断言失败", "Assertion failure"], extraction: ["提取失败", "Extraction failure"], config: ["配置失败", "Configuration failure"],
  workflow: ["工作流", "Workflow"], case: ["用例", "Case"], "constant-vus": ["固定 VU", "Constant VUs"], "constant-arrival": ["固定到达率", "Constant arrival rate"], stages: ["分阶段负载", "Staged load"], vus: ["VU 数", "VU count"], arrival: ["迭代到达率", "Iteration arrival rate"],
  pooled: ["连接池", "Pooled connections"], fresh: ["新建连接", "Fresh connections"], "vu-round-robin": ["按 VU 轮转", "VU round robin"], "node-selection": ["按节点选择", "Node selection"],
  "exact-nearest-rank": ["精确最近秩", "Exact nearest rank"], "log-histogram": ["对数直方图", "Log histogram"],
  "project-identity": ["项目身份缺失或不同", "Project identity missing or different"], target: ["执行目标不同", "Different target"], environment: ["环境不同", "Different environment"], connection: ["连接模式不同", "Different connection mode"], data: ["数据身份不同", "Different data identity"], statistics: ["统计配置不同", "Different statistics configuration"], "report-version": ["报告版本不同", "Different report version"],
  "revision-changed": ["定义版本已变化", "Definition revision changed"], "legacy-metadata-unavailable": ["旧版元数据缺失", "Legacy metadata unavailable"], "incomplete-run": ["包含不完整运行", "Includes an incomplete run"], "environment-definition-not-compared": ["未比较环境定义；同 ID 不证明定义一致", "Environment definitions not compared; matching IDs do not prove matching definitions"],
  collected: ["已采集", "Collected"], omitted: ["已省略", "Omitted"], "existing-assertions-only": ["仅已有断言诊断", "Existing assertion diagnostics only"],
  errorRate: ["请求错误率", "Request error rate"], assertionFailureRate: ["断言失败率", "Assertion failure rate"], p95: ["请求 p95", "Request p95"], rps: ["请求吞吐率", "Request RPS"], businessFailures: ["业务失败", "Business failures"], noData: ["无样本", "No samples"],
};
export function code(value: string): string {
  const translated = stressSafetyCodeLabels(value)??(Object.hasOwn(codes, value) ? codes[value] : undefined);
  return translated ? `<span data-code="${escapeHtml(value)}">${text(...translated)}</span>` : escapeHtml(value);
}
/** Cells are already escaped text or locally generated HTML, never raw report values. */
export const table = (headers: string[], rows: string[][]): string => rows.length ? `<div class="table-scroll"><table><thead><tr>${headers.map(v => `<th>${v}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<p>${text("没有记录", "No records")}</p>`;
const fieldNames: Record<string, readonly [string, string]> = {
  projectId: ["项目 ID", "Project ID"], definitionRevision: ["定义指纹", "Definition fingerprint"], runId: ["运行 ID", "Run ID"], target: ["目标", "Target"], kind: ["类型", "Kind"], workflowId: ["工作流 ID", "Workflow ID"], collectionId: ["集合 ID", "Collection ID"], folderIds: ["目录 ID", "Folder IDs"], apiId: ["接口 ID", "API ID"], caseId: ["用例 ID", "Case ID"], environmentId: ["环境 ID", "Environment ID"],
  dataIdentity: ["数据身份", "Data identity"], digest: ["数据摘要", "Data digest"], datasetIds: ["数据集 ID", "Dataset IDs"], inputs: ["输入参数", "Inputs"], outputs: ["输出映射", "Output mappings"],
  load: ["负载模型", "Load model"], vus: ["VU 数", "VUs"], rate: ["迭代启动数/秒", "Iteration starts/s"], executor: ["执行器", "Executor"], startTarget: ["初始目标", "Initial target"], stages: ["阶段", "Stages"], id: ["ID", "ID"], durationMs: ["时长", "Duration"], targetValue: ["目标值", "Target value"],
  maxVus: ["VU 容量", "VU capacity"], termination: ["终止条件", "Termination"], maxIterations: ["最大逻辑迭代", "Maximum logical iterations"], warmupMs: ["预热", "Warmup"], thinkTimeMs: ["思考时间", "Think time"], pacingMs: ["节奏间隔", "Pacing"], gracefulStopMs: ["排空宽限", "Graceful stop"],
  maxRequestConcurrency: ["请求并发限制", "Request concurrency limit"], maxRps: ["请求速率上限", "Request rate limit"], requestedMaxRequestConcurrency: ["请求的并发限制", "Requested concurrency limit"], requestedMaxRps: ["请求的速率上限", "Requested rate limit"], effectiveMaxRps: ["实际速率上限", "Effective rate limit"], connectionMode: ["连接模式", "Connection mode"], concurrency: ["旧版并发", "Legacy concurrency"],
  lifecycle: ["生命周期", "Lifecycle"], setup: ["运行准备", "Run setup"], vuSetup: ["VU 准备", "VU setup"], vuTeardown: ["VU 收尾", "VU teardown"], teardown: ["运行收尾", "Run teardown"], thresholds: ["阈值", "Thresholds"], dataPolicy: ["数据选择策略", "Data policy"],
  maxErrorRate: ["最大请求错误率", "Maximum request error rate"], maxAssertionFailureRate: ["最大断言失败率", "Maximum assertion failure rate"], maxP95Ms: ["最大请求 p95", "Maximum request p95"], minRps: ["最小请求吞吐率", "Minimum request RPS"],
  locator: ["执行定位", "Execution locator"], scope: ["作用域", "Scope"], invocationId: ["调用 ID", "Invocation ID"], parentInvocationId: ["父调用 ID", "Parent invocation ID"], nodeVisitId: ["节点访问 ID", "Node visit ID"], attempt: ["尝试序号", "Attempt"], stressRunId: ["压测运行 ID", "Stress run ID"], vuId: ["VU ID", "VU ID"], iterationId: ["迭代 ID", "Iteration ID"], stageId: ["阶段 ID", "Stage ID"], invocationPath: ["调用路径", "Invocation path"], nodeId: ["节点 ID", "Node ID"], branchId: ["分支 ID", "Branch ID"], iteration: ["迭代", "Iteration"], handler: ["处理器", "Handler"],
  suiteRunId: ["套件运行 ID", "Suite run ID"], entryId: ["条目 ID", "Entry ID"], suiteRow: ["套件行", "Suite row"], rowIndex: ["数据行", "Data row"], datasetId: ["数据集 ID", "Dataset ID"], dataDigest: ["数据摘要", "Data digest"],
  availability: ["可用状态", "Availability"], unavailableReason: ["不可用原因", "Unavailable reason"], cpuUserMs: ["用户态 CPU 耗时", "User CPU time"], cpuSystemMs: ["内核态 CPU 耗时", "System CPU time"], cpuPercent: ["CPU 占用（%）", "CPU usage (%)"], rssStartBytes: ["起始内存（字节）", "Initial RSS (bytes)"], rssPeakBytes: ["峰值内存（字节）", "Peak RSS (bytes)"], eventLoopDelayP95Ms: ["事件循环延迟 p95", "Event loop delay p95"], schedulerBacklogMax: ["最大调度积压", "Maximum scheduler backlog"], saturated: ["已饱和", "Saturated"], reasons: ["原因", "Reasons"], limits: ["限制", "Limits"], schedulerBacklog: ["调度积压", "Scheduler backlog"],
  targetOrigins: ["目标源", "Target origins"], origin: ["目标源", "Origin"], confirmation: ["确认状态", "Confirmation"], policy: ["策略结果", "Policy result"], loopback: ["回环地址", "Loopback"], appliedPolicy: ["应用策略", "Applied policy"], trustedOrigins: ["信任源", "Trusted origins"], deniedOrigins: ["禁止源", "Denied origins"], maxConcurrency: ["最大并发", "Maximum concurrency"], run: ["运行策略", "Run policy"], requestedConcurrency: ["请求并发", "Requested concurrency"], effectiveConcurrency: ["实际并发", "Effective concurrency"], protocolVersion: ["协议版本", "Protocol version"], workers: ["工作进程数", "Workers"], dataComplete: ["数据完整", "Data complete"], timeAligned: ["时间已对齐", "Time aligned"],
};
const machineFields = new Set(["kind", "executor", "connectionMode", "dataPolicy", "availability", "unavailableReason", "confirmation", "policy"]);
export function fields(value: unknown, path: string[] = []): string[][] {
  const key = path.at(-1) ?? "";
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length) return entries.flatMap(([name, child]) => fields(child, [...path, name]));
  }
  const businessStart = path.findIndex(name => name === "inputs" || name === "outputs");
  const metadata = businessStart < 0;
  const label = path.map((name, index) => (businessStart < 0 || index <= businessStart) && Object.hasOwn(fieldNames, name) ? text(...fieldNames[name]!) : escapeHtml(name)).join(" / ");
  const rendered = value === undefined ? notCollected() : value === null ? metadata && key==='effectiveMaxRps' ? text('未设置请求速率上限','No request RPS limit') : text("未提供（null）", "Not supplied (null)")
    : typeof value === "boolean" ? metadata ? yesNo(value) : String(value) : typeof value === "number" ? !metadata ? escapeHtml(value) : key.endsWith("Ms") ? ms(value) : key.endsWith("Rate") ? percent(value) : number(value)
      : typeof value === "string" ? metadata && key === "definitionRevision" ? fingerprint(value) : metadata && machineFields.has(key) ? code(value) : escapeHtml(value) : text("空列表或空映射", "Empty list or mapping");
  return [[label, rendered]];
}
export const fieldTable = (value: unknown) => table([text("项目", "Field"), text("记录值", "Recorded value")], fields(value));
