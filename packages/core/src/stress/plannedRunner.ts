import { assertPreparedStressExecution, type PreparedStressExecution, type StressExecutionDeps } from "./execution.js";
import { runStressSchedule } from "./loadScheduler.js";
import { StressReportV2Schema, type StressReportV2 } from "./reportV2.js";
import { validateWorkflowRunOptions } from "../workflow/plan.js";
import { createGeneratorMetricsCollector } from "./generatorMetrics.js";
import { JsonValueSchema, StringRecordSchema } from "../contract/schemaNode.js";

export async function runStressPlan(prepared: PreparedStressExecution, deps: StressExecutionDeps): Promise<StressReportV2> {
  assertPreparedStressExecution(prepared);
  const { compiled, run } = prepared;
  const plan = compiled.plan;
  const targetInputs = StringRecordSchema(JsonValueSchema).parse(plan.target.kind === "workflow" ? plan.target.inputs ?? {} : {});
  const validateTargetInputs = (inputs: Parameters<StressExecutionDeps["createVu"]>[1]) => {
    if (plan.target.kind === "case") { if (Object.values(inputs).some((value) => typeof value !== "string")) throw new Error("Case initial inputs must be strings"); }
    else {
      const workflow = compiled.workflowPlans[0]!.workflows.find((w) => w.id === compiled.workflowPlans[0]!.rootWorkflowId)!;
      validateWorkflowRunOptions(workflow, workflow.executionVersion === 2 ? { inputs } : {});
    }
  };
  const collector = createGeneratorMetricsCollector();
  let report: StressReportV2 | undefined;
  try {
  const summary = await runStressSchedule(compiled.schedule, { ...deps, execution: { targetInputs, lifecycle: plan.lifecycle, thresholds: plan.thresholds, validateTargetInputs } });
  const audit = deps.gate.audit?.();
  report = StressReportV2Schema.parse({ ...summary, formatVersion: 2, runId: deps.runId, projectId: compiled.projectId, definitionRevision: compiled.definitionRevision,
    concurrency: compiled.schedule.maxVus, plan: compiled.plan, target: compiled.plan.target, environmentId: compiled.plan.environmentId ?? null,
    connectionMode: compiled.plan.connectionMode, thresholds: compiled.plan.thresholds,
    eligibleCompletedAttempts: summary.requests.eligibleCompleted,
    measurementWindow: { startWallMs: summary.startedAt, endWallMs: summary.finishedAt, monotonicDurationMs: summary.durationMs, eligibleCompletedAttempts: summary.requests.eligibleCompleted },
    incomplete: Object.values(summary.completeness).some((part) => !part.complete),
    safety: { targetOrigins: audit?.targetOrigins ?? [], availability: audit?.incomplete ? "partial" : audit?.targetOrigins.length ? "available" : "unavailable",
      ...(!audit?.targetOrigins.length ? { unavailableReason: "没有样本携带目标安全采集" } : {}), run: { requestedConcurrency: compiled.schedule.requested.maxRequestConcurrency ?? compiled.schedule.effective.maxRequestConcurrency,
        effectiveConcurrency: compiled.schedule.effective.maxRequestConcurrency, requestedMaxRps: compiled.schedule.requested.maxRps, effectiveMaxRps: compiled.schedule.effective.maxRps, connectionMode: plan.connectionMode } },
    dataIdentity: { digest: run.preparedTestData?.digest ?? null, datasetIds: [...new Set(run.preparedTestData?.selections.flatMap((selection) => selection.datasetId ? [selection.datasetId] : []) ?? [])] } });
  report = deps.evidence.projectStressReport(report); return report;
  } finally { const generator = collector.stop(); if (report) report.generator = generator; }
}
