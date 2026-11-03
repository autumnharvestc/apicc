import { ArchiveReportWireSchema } from './shared.js';
import { workflowToRunResult } from '../workflow/adapter.js';
import type { RunResult } from '../report/types.js';
import type { ReadableStressReport } from '../stress/reportV2.js';
import type { DebugHistoryRecord, DebugResult } from '../debug/model.js';
import type { WorkflowRunResult } from '../workflow/runner.js';

export type NormalizedArchiveReport = { format: 'run'; body: RunResult }
  | { format: 'stress'; body: ReadableStressReport; baseline?: ReadableStressReport }
  | { format: 'debug'; body: DebugHistoryRecord | DebugResult };
export interface NormalizedArchivedExecution {
  report: NormalizedArchiveReport;
  executionVerdict?: string;
  executionFact?: string;
  executionReasonUnavailable?: true;
}
/** Fixed producer envelope only. Original source bytes/digest remain host-owned. */
export function normalizeArchivedExecution(input: unknown): NormalizedArchivedExecution {
  const parsed = ArchiveReportWireSchema.safeParse(input);
  if (!parsed.success) throw new Error('PUBLICATION_SOURCE_INVALID');
  const report = parsed.data;
  if (!('output' in report.body)) return { report: report as NormalizedArchiveReport };
  const archived = report.body;
  const output = archived.output;
  let normalized: NormalizedArchiveReport;
  if (output.kind === 'stress') normalized = { format: 'stress', body: output.result, ...('baseline' in report && report.baseline !== undefined ? { baseline: report.baseline } : {}) };
  else if (output.kind === 'debug') normalized = { format: 'debug', body: output.result };
  else if (output.kind === 'workflow') {
    const flow = output.result as WorkflowRunResult;
    // The producer may omit duplicate outcome aliases after preserving this
    // strictly validated canonical report. Re-adapting would lose real rows.
    normalized = { format: 'run', body: flow.report ?? workflowToRunResult(flow) };
  } else normalized = { format: 'run', body: output.result as RunResult };
  // Do not copy arbitrary reasonCode/error text, process/PID or execution ID into
  // the public artifact. Known execution status/fact are finite schema values.
  return { report: normalized, executionVerdict: archived.verdict, executionFact: archived.executionFact,
    ...(archived.reasonCode === undefined ? {} : { executionReasonUnavailable: true }) };
}
