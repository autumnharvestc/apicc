import type { AssertResult } from "../plugin/types.js";
import type { CaseFailureKind } from "../runner/caseExecutor.js";

export interface CaseOutcome {
  apiId: string;
  apiName: string;
  caseId: string;
  caseName: string;
  row?: number;
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
