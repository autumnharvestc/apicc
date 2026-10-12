import type { ContractWorkspace } from "../contract/workspace.js";
import { encodeContractWorkspace } from "./contractFiles.js";

/** Lists the canonical definition paths emitted by Core's workspace encoder. */
export function listContractWorkspaceDefinitionFiles(workspace: ContractWorkspace): readonly string[] {
  return Object.freeze([...encodeContractWorkspace(workspace).files.keys()]);
}
