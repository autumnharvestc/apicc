import type { PreparedProjectFiles } from "@apicc/execution/host";
import type { AgentConfig, DispatchKind, TaskEnvelopeV1 } from "@apicc/execution/contract";
import { rejectPreparation } from "./invocationContext.js";
/** Classify the actual selected dependencies, never a UI name or script keyword. */
export function selectDispatch(prepared: PreparedProjectFiles, task: TaskEnvelopeV1, config: AgentConfig): DispatchKind {
  const hasScripts = prepared.scriptRequirements.length > 0;
  if (hasScripts && (config.scriptMode !== "trusted-core" || task.executionProfile !== "trusted-core-script" || !task.scriptGrantVersion)) rejectPreparation("script-admission-denied");
  if ((hasScripts ? "trusted-core-script" : "no-script") !== task.executionProfile) rejectPreparation("fixed-input-mismatch");
  const kind = prepared.prepared.target.kind === "debug" && !hasScripts ? "shared-debug" : "dedicated-task";
  if (kind !== task.dispatchKind) rejectPreparation("fixed-input-mismatch");
  return kind;
}
