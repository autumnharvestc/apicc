import { computed, inject, reactive, type ComputedRef, type InjectionKey } from "vue";
import type { SwitchView, ApiSubView } from "../viewSwitch.js";
import type { NotificationPosition } from "./onlineSchedules.js";
import type { LaunchKind } from "../execution/launch.js";

export type RecordPosition = { jobId: string; executionId: string; agentId: string } | { runId: string };

export function newWorkbenchPosition() {
  return reactive({
    view: "api" as SwitchView,
    apiSubView: "debug" as ApiSubView,
    requestSection: "params" as "params" | "headers" | "body" | "auth",
    onlineTestPane: "cases" as "cases" | "datasets" | "suites" | "stress",
    onlineCaseApi: "",
    onlineCase: null as { api: string; caseId: string; scope: string } | null,
    runPane: "launch" as "launch" | "records" | "schedules" | "notifications",
    localRecord: null as { file: string; digest?: string; legacy: boolean } | null,
    onlineRecord: null as RecordPosition | null,
    revealingRecord: false,
    recordListOnly: false,
    scheduleId: "",
    notification: null as NotificationPosition | null,
    launchTarget: null as { kind: LaunchKind; id: string } | null,
    apiPath: "",
    responseByApi: {} as Record<string, boolean>,
    apiRequestId: "",
  });
}
export type WorkbenchPosition = ReturnType<typeof newWorkbenchPosition>;
export const workbenchPositionKey: InjectionKey<ComputedRef<WorkbenchPosition>> = Symbol("workbenchPosition");

/** Standalone panels own a position for their component lifetime. The workbench provides one per open project. */
export function useWorkbenchPosition(scope?: () => string) {
  return inject(workbenchPositionKey, () => {
    const positions = new Map<string, WorkbenchPosition>();
    return computed(() => {
      const key = scope?.() ?? "";
      if (!positions.has(key)) positions.set(key, newWorkbenchPosition());
      return positions.get(key)!;
    });
  }, true);
}
