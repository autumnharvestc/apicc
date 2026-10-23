import type { StressReportV2 } from "./reportV2.js";

export interface StressArrivalWindowNotice {
  readonly code: "quantization" | "incomplete-window";
  readonly message: string;
}

/** Display qualification only: never changes the measured facts or claims a 5% verification. */
export function stressArrivalWindowNotices(report: Pick<StressReportV2, "plan" | "iterations" | "completeness" | "load">): readonly StressArrivalWindowNotice[] {
  const load = report.plan.load;
  if (load.kind !== "constant-arrival" && !(load.kind === "stages" && load.executor === "arrival")) return [];
  const notices: StressArrivalWindowNotice[] = [];
  if (report.iterations.planned < 20) notices.push({ code: "quantization",
    message: "Arrival window has fewer than 20 planned slots (quantization / insufficient sample); this window cannot verify 5% start-rate accuracy." });
  if (report.iterations.dropped > 0 || report.load.saturated || Object.values(report.completeness).some(part => !part.complete)
    || report.load.plannedDurationMs === null || report.load.measurementDurationMs < report.load.plannedDurationMs) notices.push({ code: "incomplete-window",
    message: "Arrival window is incomplete, dropped or saturated; this window cannot verify 5% start-rate accuracy." });
  return notices;
}
