import type { AssertResult } from "../plugin/types.js";

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
}
