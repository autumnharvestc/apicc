import type { DeepReadonly } from "../assets/context.js";
import type { ApiAsset } from "../contract/model.js";
import type { ContractCollection, ContractFolder, ContractProject } from "../contract/workspace.js";
import type { TestCase } from "../domain/common.js";
import type { WorkflowNode, WorkflowValue } from "./model.js";

export interface WorkflowCallReference {
  kind: "subflow" | "loop" | "branch" | "onError" | "finally";
  workflowId: string;
  branchId?: string;
  inputs: DeepReadonly<Record<string, WorkflowValue>>;
  outputs: Readonly<Record<string, string>>;
  path: string;
}
/** The single direct-call enumerator used by compilation, impact and clone consumers. */
export function workflowCalls(node: DeepReadonly<WorkflowNode>): WorkflowCallReference[] {
  const calls: WorkflowCallReference[] = [];
  if (node.kind === "subflow" || node.kind === "loop") calls.push({ kind: node.kind, workflowId: node.workflowId, inputs: node.inputs, outputs: node.outputs, path: "workflowId" });
  if (node.kind === "parallel") node.branches.forEach((branch, index) => calls.push({ kind: "branch", branchId: branch.id, workflowId: branch.workflowId, inputs: branch.inputs, outputs: branch.outputs, path: `branches[${index}].workflowId` }));
  if (node.policy?.onError) calls.push({ kind: "onError", workflowId: node.policy.onError.workflowId, inputs: {}, outputs: {}, path: "policy.onError.workflowId" });
  if (node.policy?.finally) calls.push({ kind: "finally", workflowId: node.policy.finally.workflowId, inputs: {}, outputs: {}, path: "policy.finally.workflowId" });
  return calls;
}

export interface ProjectApiLocation {
  api: DeepReadonly<ApiAsset>;
  collection: DeepReadonly<ContractCollection>;
  folders: readonly DeepReadonly<ContractFolder>[];
}

function findInFolders(
  folders: readonly DeepReadonly<ContractFolder>[], apiId: string, ancestors: readonly DeepReadonly<ContractFolder>[],
): { api: DeepReadonly<ApiAsset>; folders: readonly DeepReadonly<ContractFolder>[] } | undefined {
  for (const folder of folders) {
    const nextAncestors = [...ancestors, folder];
    const api = folder.apis.find((candidate) => candidate.contract.id === apiId);
    if (api) return { api, folders: nextAncestors };
    const nested = findInFolders(folder.folders, apiId, nextAncestors);
    if (nested) return nested;
  }
  return undefined;
}

/** Locate an API asset anywhere in one complete project and retain its real module/folder path. */
export function findProjectApi(project: DeepReadonly<ContractProject>, apiId: string): ProjectApiLocation | undefined {
  for (const collection of project.collections) {
    const direct = collection.apis.find((candidate) => candidate.contract.id === apiId);
    if (direct) return { api: direct, collection, folders: [] };
    const nested = findInFolders(collection.folders, apiId, []);
    if (nested) return { ...nested, collection };
  }
  return undefined;
}

function cloneFolderPath(
  folders: readonly DeepReadonly<ContractFolder>[], api: DeepReadonly<ApiAsset>, testCase: DeepReadonly<TestCase>,
): ContractFolder[] {
  if (folders.length === 0) return [];
  const [current, ...rest] = folders;
  const selectedCases = api.cases.filter((candidate) => candidate.id === testCase.id);
  const child: ContractFolder = {
    id: current!.id,
    name: current!.name,
    preOperations: current!.preOperations.map((operation) => ({ ...operation })),
    postOperations: current!.postOperations.map((operation) => ({ ...operation })),
    apis: rest.length === 0 ? [{ ...api, cases: selectedCases.length > 0 ? [...selectedCases] : [testCase] } as ApiAsset] : [],
    folders: cloneFolderPath(rest, api, testCase),
  };
  return [child];
}

/** Create a standalone selected view for callers that need one; execution should prefer run.caseSelection. */
export function selectWorkflowCollection(location: ProjectApiLocation, testCase: DeepReadonly<TestCase>): ContractCollection {
  const { api, collection, folders } = location;
  const selectedCases = api.cases.filter((candidate) => candidate.id === testCase.id);
  const selectedApi = { ...api, cases: selectedCases.length > 0 ? [...selectedCases] : [testCase] } as ApiAsset;
  return {
    id: collection.id,
    name: collection.name,
    variables: { ...collection.variables },
    preOperations: collection.preOperations.map((operation) => ({ ...operation })),
    postOperations: collection.postOperations.map((operation) => ({ ...operation })),
    apis: folders.length === 0 ? [selectedApi] : [],
    folders: cloneFolderPath(folders, api, testCase),
  };
}
