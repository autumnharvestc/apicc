import type { AssertResult } from "../plugin/types.js";
import type { CaseExecutionLocator, CaseFailureKind } from "../runner/caseExecutor.js";
import type { WorkflowNodeIdentity } from "../workflow/trace.js";

export interface EvidencePreview { text: string; truncated: boolean; omitted?: boolean }
export interface EvidenceIdentity extends Partial<WorkflowNodeIdentity> {
  projectId: string; definitionRevision: string; locator?: CaseExecutionLocator;
  suiteRunId?: string; entryId?: string; suiteRow?: number; rowIndex?: number; nodeId?: string; workflowId?: string;
  environmentId?: string; dataDigest?: string; datasetId?: string;
}
export interface SafeExecutionEvidence {
  identity: EvidenceIdentity;
  state: "collected" | "not-collected" | "omitted";
  timings?: { requestMs: number; scriptMs: number; iterationMs: number };
  request?: { protocol: string; method?: string; url: EvidencePreview; headers: EvidencePreview; body: EvidencePreview };
  response?: { status: number; headers: EvidencePreview; body: EvidencePreview };
  bodyUnavailable?: boolean;
  assertions?: Array<{ id: EvidencePreview; op: EvidencePreview; selector: EvidencePreview; code: EvidencePreview; pass: boolean; message: EvidencePreview; actual?: EvidencePreview; expected?: EvidencePreview; differencePath?: EvidencePreview; schemaPath?: EvidencePreview }>;
  extractions?: Array<{ id: EvidencePreview; name: EvidencePreview; selector: EvidencePreview; status: string; code: EvidencePreview; published: boolean; sensitive: boolean; value?: EvidencePreview; message: EvidencePreview }>;
  scriptDiagnostics: "existing-assertions-only" | "not-collected";
  truncated: boolean;
}
export interface ReportingUnitSummary { total: number; passed: number; failed: number; skipped: number; entryDiagnostics: number }
export interface WorkflowReportingUnit {
  entryId: string; suiteRow?: number; workflowId: string; invocationId?: string;
  verdict: "passed" | "failed" | "aborted" | "skipped"; error?: string;
}
export interface RequestFacts { requestStarted: number; requestCompleted: number; httpExchanges: number }

export interface CaseOutcome extends Partial<WorkflowNodeIdentity> {
  evidence?: SafeExecutionEvidence;
  entryId?: string;
  suiteRow?: number;
  apiId: string;
  apiName: string;
  caseId: string;
  caseName: string;
  row?: number;
  locator?: CaseExecutionLocator;
  scope?: string;
  /** 工作流节点归属；普通 collection 报告可省略。 */
  nodeId?: string;
  passed: boolean;
  /** 跳过是独立于通过/失败的报告状态。 */
  skipped?: boolean;
  skipReason?: string;
  durationMs: number;
  assertions: AssertResult[];
  error?: string;
  /** 分类后的执行失败；旧报告可省略该字段。 */
  failureKind?: CaseFailureKind;
}

export interface RunResult {
  reportingMode?: "workflow-invocation-v2" | "mixed-suite-v2";
  workflowUnits?: WorkflowReportingUnit[];
  requestFacts?: RequestFacts;
  trace?: import("../workflow/trace.js").WorkflowTrace;
  executionIdentity?: EvidenceIdentity;
  evidenceOmitted?: boolean;
  reportFailure?: boolean;
  kind?: "collection" | "workflow" | "suite";
  projectId?: string;
  definitionRevision?: string;
  workflowId?: string;
  workflow?: { verdict?: "passed" | "failed" | "aborted"; total: number; passed: number; failed: number; skipped: number; entries: Array<{ entryId: string; kind: "workflow"; workflowId: string; suiteRow?: number; nodeKind?: string; label?: string; state?: string; skipReason?: string; failureKind?: CaseFailureKind; status: "passed" | "failed" | "skipped"; error?: string }> };
  reportingUnits?: ReportingUnitSummary;
  suite?: { suiteRunId: string; projectId: string; definitionRevision: string; environmentId?: string; datasetId?: string; dataDigest?: string; verdict: "passed" | "failed" | "aborted"; total: number; passed: number; failed: number; skipped: number;
    entries?: Array<{ entryId: string; kind: "case" | "workflow"; workflowId?: string; caseLocator?: CaseExecutionLocator; suiteRow?: number; status: "passed" | "failed" | "skipped" | "aborted"; skipReason?: "fail-fast" | "aborted"; error?: string }> };
  collectionId: string;
  collectionName: string;
  envName?: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
  /** 旧版 collection 结果可省略，按零处理。 */
  skipped?: number;
  cases: CaseOutcome[];
  /** 运行级钩子（beforeRun/afterRun）处理器失败的非致命告警，不中断运行（规格 §5.2）。 */
  warnings?: string[];
}
