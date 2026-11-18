import type { OnlineExecutionStore } from "./stores/onlineExecution.js";

export function onlineExecutionLocationIssue(
  execution: OnlineExecutionStore,
  agentId = execution.location.kind === "agent" ? execution.location.agentId : undefined,
): string | null {
  if (!agentId) return null;
  const agent = execution.agents?.agents.find(candidate => candidate.id === agentId);
  if (!agent) return "projectWorkbench.agentMissing";
  if (agent.availability !== "available") return `onlineExecution.states.${agent.availability}`;
  if (!agent.runtime) return "onlineExecution.states.runtime-missing";
  if (agent.configuration.status !== "applied") return "projectWorkbench.configurationPending";
  if (execution.localOnlyRefIds.length) return "onlineExecution.reasons.local-material-required";
  return null;
}
