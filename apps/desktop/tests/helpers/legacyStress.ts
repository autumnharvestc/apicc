import type { ApiccApi, LegacyStressRunInput, StressRunInput, StressRunOutput, StressRunError, StressPlanRunInput, StressPlanRunOutput } from "../../src/shared/types.js";
/** Old UI fixtures intentionally exercise only the legacy branch. */
export function legacyStressRun(run: (input: LegacyStressRunInput) => Promise<StressRunOutput | StressRunError>): ApiccApi["stressRun"] {
  function invoke(input: LegacyStressRunInput): Promise<StressRunOutput | StressRunError>;
  function invoke(input: StressPlanRunInput): Promise<StressPlanRunOutput | StressRunError>;
  function invoke(input: StressRunInput): Promise<StressRunOutput | StressPlanRunOutput | StressRunError>;
  async function invoke(input: StressRunInput): Promise<StressRunOutput | StressPlanRunOutput | StressRunError> { if ("kind" in input) throw new Error("Legacy UI fixture received a plan"); return run(input); }
  return invoke;
}
