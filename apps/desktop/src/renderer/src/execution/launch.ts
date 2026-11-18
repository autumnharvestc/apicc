import type { DebugInvocation, JsonValue, StressPlan, SuiteAsset, Workflow } from "@apicc/core";
import { StressPlanSchema } from "@apicc/core/schema";
import type { ApiLocator } from "../../../shared/locations.js";
import type { OnlineExecutionStore } from "../stores/onlineExecution.js";

export type LaunchKind = "module" | "case" | "suite" | "workflow" | "stress";
export interface LaunchChoice { id: string; label: string; detail?: string }

export function buildSavedCaseInvocation(locator: ApiLocator, selected: { caseId: string; scope: string }, environmentId?: string, settings?: DebugInvocation["settings"]): Extract<DebugInvocation, { mode: "case" }> {
  const where = { ...locator, folderIds: [...locator.folderIds] };
  return { mode: "case", locator: where, case: { ...where, ...selected }, ...(environmentId ? { environmentId } : {}),
    ...(settings && Object.keys(settings).length ? { settings: { ...settings } } : {}) };
}

export function runOnlineCase(execution: OnlineExecutionStore, locator: ApiLocator, selected: { caseId: string; scope: string }) {
  return execution.run({ kind: "debug", invocation: buildSavedCaseInvocation(locator, selected, execution.environmentId) });
}

export function runOnlineWorkflow(execution: OnlineExecutionStore, workflow: Workflow, inputs?: Readonly<Record<string, JsonValue>>) {
  if (workflow.status === "draft") throw new Error("run-launch-workflow-draft");
  return execution.run({ kind: "workflow", workflowId: workflow.id, ...(inputs ? { inputs: { ...inputs } } : {}) });
}

export function runOnlineSuite(execution: OnlineExecutionStore, suite: SuiteAsset, allowDraft: boolean) {
  return execution.run({ kind: "suite", suiteId: suite.id, allowDraft });
}

export function runOnlineStress(execution: OnlineExecutionStore, plan: StressPlan, savedPlanId: string) {
  return execution.run({ kind: "stress", plan: StressPlanSchema.parse(plan) }, savedPlanId);
}

export function confirmOnlineStress(execution: OnlineExecutionStore, plan: StressPlan, origins: string) {
  execution.confirmStressOrigins(StressPlanSchema.parse(plan), origins.split(/[\s,]+/).filter(Boolean));
}
