import { decodeContractProjectFiles } from "../storage/contractFiles.js";
import type { ContractCollection, ContractFolder, ContractProject } from "../contract/workspace.js";
import type { Operation } from "../domain/common.js";

export async function classifyAssetMutation(
  beforeFiles: ReadonlyMap<string, string | Uint8Array>,
  afterFiles: ReadonlyMap<string, string | Uint8Array>,
  options?: { initialContractProjectId?: string },
): Promise<{ scriptChanged: boolean; locations: readonly string[] }> {
  const decode = async (files: ReadonlyMap<string, string | Uint8Array>): Promise<ContractProject> => {
    let result: Awaited<ReturnType<typeof decodeContractProjectFiles>>;
    try { result = await decodeContractProjectFiles(files); } catch { throw new Error("PUBLICATION_SOURCE_INVALID"); }
    if (!result.project || result.readOnly || result.problems.length > 0) throw new Error("PUBLICATION_SOURCE_INVALID");
    return result.project;
  };
  const initialId = options?.initialContractProjectId;
  if (initialId !== undefined && beforeFiles.size !== 0) throw new Error("PUBLICATION_SOURCE_INVALID");
  const before = initialId !== undefined ? new Map<string, string>() : scriptSurface(await decode(beforeFiles));
  const candidate = await decode(afterFiles);
  if (initialId !== undefined && candidate.id !== initialId) throw new Error("PUBLICATION_SOURCE_INVALID");
  const after = scriptSurface(candidate);
  const locations = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
  return { scriptChanged: locations.length > 0, locations };
}

function scriptSurface(project: ContractProject): Map<string, string> {
  const values = new Map<string, string>();
  const hooks = (owner: { preOperations: Operation[]; postOperations: Operation[] }, path: string): void => {
    for (const key of ["preOperations", "postOperations"] as const) {
      if (owner[key].length) values.set(`${path}.${key}`, JSON.stringify(owner[key].map(({ id, type, content }) => ({ id, type, content }))));
    }
  };
  const visit = (container: ContractCollection | ContractFolder, path: string): void => {
    hooks(container, path);
    for (const api of container.apis) {
      for (const testCase of api.cases) hooks(testCase, `${path}.apis[${api.contract.id}].cases[${testCase.id}]`);
    }
    for (const folder of container.folders) visit(folder, `${path}.folders[${folder.id}]`);
  };
  for (const collection of project.collections) visit(collection, `collections[${collection.id}]`);
  for (const workflow of project.workflows) {
    for (const edge of workflow.edges) {
      if ("condition" in edge && edge.condition !== undefined) values.set(`workflows[${workflow.id}].edges[${edge.id}].condition`, edge.condition);
    }
  }
  return values;
}
