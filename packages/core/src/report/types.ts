import type { AssertResult } from "../plugin/types.js";
import type { CaseFailureKind } from "../runner/caseExecutor.js";

export interface CaseOutcome {
  apiId: string;
  apiName: string;
  caseId: string;
  caseName: string;
  row?: number;
  passed: boolean;
  durationMs: number;
  assertions: AssertResult[];
  error?: string;
  /** 分类后的执行失败；旧报告可省略该字段。 */
  failureKind?: CaseFailureKind;
}

export interface RunResult {
  collectionId: string;
  collectionName: string;
  envName?: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
  cases: CaseOutcome[];
  /** 运行级钩子（beforeRun/afterRun）处理器失败的非致命告警，不中断运行（规格 §5.2）。 */
  warnings?: string[];
}
