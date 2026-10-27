import { createExecutionEvidenceCollector, type EvidenceIdentity, type EvidenceLimits, type RunResult, type WorkflowRunResult } from "@apicc/core";
export function createHostOutput(identity: EvidenceIdentity, markers: readonly string[], limits?: EvidenceLimits) {
  const collector = createExecutionEvidenceCollector(identity, markers, { mode: "all", limits });
  return { collector, projectRun: (value: RunResult) => collector.projectRun(value), projectFailure: (value: RunResult) => collector.projectRunFailure(value), projectWorkflow: (value: WorkflowRunResult) => collector.projectWorkflow(value) };
}
