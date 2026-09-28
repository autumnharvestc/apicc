/** Side-effect-light schema entry point for renderer/preload runtime validation. */
export * from "./domain/model.js";
export {
  StressReportSchema,
  CurrentStressReportSchema,
  StressGeneratorSchema,
  StressSafetySchema,
  type StressReport,
  type CurrentStressReport,
} from "./stress/model.js";
