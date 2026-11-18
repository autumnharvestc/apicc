import type { ContractCollection, ContractFolder, ContractProject, DebugInvocation, DebugResult } from "@apicc/core";
import type { FullOnlineJob, OnlineLocalResult, OnlineProjectView, OnlineReport } from "../../../shared/online/execution.js";
import { apiLocatorKey, sameProjectLocator } from "../wf/wfBindings.js";

type Output = OnlineLocalResult["output"];
type Target = FullOnlineJob["task"]["target"];

export function shortRecordId(value: string) {
  return value.length > 14 ? value.slice(0, 6) + "…" + value.slice(-4) : value;
}

function targetFacts(task: FullOnlineJob["task"], project?: ContractProject, output?: Output) {
  const target = task.target;
  if (target.kind === "workflow") {
    const name = output?.kind === "workflow" && output.result.workflowId === target.workflowId ? output.result.workflowName : undefined;
    return { id: target.workflowId, name: name || project?.workflows.find(w => w.id === target.workflowId)?.name };
  }
  if (target.kind === "suite") {
    const name = output?.kind === "suite" && output.result.collectionId === target.suiteId ? output.result.collectionName : undefined;
    return { id: target.suiteId, name: name || project?.suites?.find(s => s.id === target.suiteId)?.name };
  }
  if (target.kind === "stress") {
    const plans = project?.stressPlans?.filter(item => JSON.stringify(item.plan) === JSON.stringify(target.plan));
    return { name: plans?.length === 1 ? plans[0]?.name : undefined };
  }
  return debugTargetFacts(target.invocation, task.scope, project, output);
}

export function debugTargetFacts(invocation: DebugInvocation, scope: FullOnlineJob["task"]["scope"], project?: ContractProject, output?: Output) {
  if (invocation.mode === "free") return {};
  const locator = invocation.locator;
  if (invocation.mode === "case" && apiLocatorKey(locator) !== apiLocatorKey(invocation.case)) return {};
  let container: ContractCollection | ContractFolder | undefined;
  if (project?.id === locator.projectId && scope.workspaceId === locator.workspaceId && scope.groupId === locator.groupId) {
    container = project.collections.find(item => item.id === locator.collectionId);
    for (const folderId of locator.folderIds) container = container?.folders.find(folder => folder.id === folderId);
  }
  const api = container?.apis.find(item => item.contract.id === locator.apiId);
  const outcome = output?.kind === "debug" ? output.result.outcomes.find(item => item.identityAvailable !== false && item.apiId === locator.apiId && (invocation.mode !== "case" || item.caseId === invocation.case.caseId)) : undefined;
  return invocation.mode === "case"
    ? { id: invocation.case.caseId, name: outcome?.caseName || api?.cases.find(item => item.id === invocation.case.caseId && item.scope === invocation.case.scope)?.name }
    : { id: locator.apiId, name: outcome?.apiName || api?.contract.metadata.name };
}

export function outputEnvironment(output?: Output) {
  if (output?.kind === "debug") return { id: output.result.environmentId, name: output.result.run.envName };
  if (output?.kind === "stress") return { id: output.result.environmentId ?? undefined };
  const report = output?.kind === "workflow" ? output.result.report : output?.kind === "suite" || output?.kind === "failure" ? output.result : undefined;
  return { id: report?.suite?.environmentId ?? report?.executionIdentity?.environmentId, name: report?.envName };
}

function matchesDebug(invocation: DebugInvocation, result: DebugResult) {
  const { source, replay } = result;
  if (result.identityAvailable === false || result.mode !== invocation.mode || replay.mode !== invocation.mode) return false;
  if (invocation.mode === "free") {
    return source.sourceKind === "free" && source.draftId === invocation.draftId && sameProjectLocator(source.project, invocation.project)
      && replay.mode === "free" && (!replay.draftId || replay.draftId === invocation.draftId) && (!replay.project || sameProjectLocator(replay.project,invocation.project));
  }
  if (source.sourceKind !== "asset" || apiLocatorKey(source.locator) !== apiLocatorKey(invocation.locator)) return false;
  if (invocation.mode === "request") return replay.mode === "request" && (!replay.locator || apiLocatorKey(replay.locator) === apiLocatorKey(invocation.locator));
  return replay.mode === "case" && replay.identityAvailable !== false && !!replay.case
    && replay.case.caseId === invocation.case.caseId && replay.case.scope === invocation.case.scope
    && apiLocatorKey(replay.case) === apiLocatorKey(invocation.case) && apiLocatorKey(invocation.case) === apiLocatorKey(invocation.locator);
}

function matchesTarget(target: Target, output: Output) {
  if (output.kind === "failure") return target.kind !== "debug" && output.targetKind === target.kind;
  if (output.kind === "stress-failure") return target.kind === "stress";
  if (output.kind === "workflow") return target.kind === "workflow" && output.result.workflowId === target.workflowId;
  if (output.kind === "suite") return target.kind === "suite" && output.result.collectionId === target.suiteId;
  if (output.kind === "debug") return target.kind === "debug" && matchesDebug(target.invocation,output.result);
  return target.kind === output.kind;
}

export function jobRecordFacts(job: FullOnlineJob, view: OnlineProjectView | null, report?: OnlineReport | null) {
  const { task } = job, assets = view?.assets;
  const project = assets?.manifestHash === task.manifestHash && assets.contractProjectId === task.contractProjectId
    && assets.workspaceId === task.scope.workspaceId && assets.groupId === task.scope.groupId && assets.projectId === task.scope.projectId
    && view?.project?.id === task.contractProjectId ? view.project : undefined;
  const archived = report?.executionId === job.executionId && job.reportState === "archived" ? report.output : undefined;
  const output = archived && matchesTarget(task.target,archived) ? archived : undefined;
  const target = targetFacts(task, project, output);
  const environment = outputEnvironment(output);
  const environmentId = environment.id ?? (task.target.kind === "stress" ? task.target.plan.environmentId : undefined) ?? task.environmentId;
  return { targetId: target.id, targetName: target.name, environmentId, environmentName: environment.name || project?.environments.find(e => e.id === environmentId)?.name,
    agentName: job.stressMetadata?.executor.id === job.agentId ? job.stressMetadata.executor.name : undefined,
    startedAt: output && output.kind !== "stress-failure" ? output.result.startedAt : undefined };
}
