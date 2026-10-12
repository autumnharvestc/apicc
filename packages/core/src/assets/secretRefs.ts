import type { ContractProject } from "../contract/workspace.js";
import type { AuthBinding, InlineAuthBinding, SecretRef } from "../contract/model.js";
import { cloneDefinitionValue } from "./context.js";

function secretRefForInlineAuth(auth: InlineAuthBinding): SecretRef | undefined {
  switch (auth.kind) {
    case "bearer": return auth.token;
    case "basic": return auth.password;
    case "apikey": return auth.value;
    case "none": return undefined;
  }
}

function secretRefForBinding(auth: AuthBinding): SecretRef | undefined {
  return auth.kind === "componentRef" ? undefined : secretRefForInlineAuth(auth);
}

function visitProjectSecretRefs(project: ContractProject, visit: (ref: SecretRef) => void): void {
  const visitApi = (api: ContractProject["collections"][number]["apis"][number]) => {
    const ref = secretRefForBinding(api.contract.request.auth);
    if (ref) visit(ref);
  };

  const visitFolder = (folder: ContractProject["collections"][number]["folders"][number]): void => {
    for (const api of folder.apis) visitApi(api);
    for (const child of folder.folders) visitFolder(child);
  };

  for (const collection of project.collections) {
    for (const api of collection.apis) visitApi(api);
    for (const folder of collection.folders) visitFolder(folder);
  }

  for (const component of project.components) {
    if (component.kind !== "auth") continue;
    const ref = secretRefForInlineAuth(component.definition);
    if (ref) visit(ref);
  }
}

export function rotateProjectSecretRefs(
  project: ContractProject,
  options: { newId: (sourceRefId: string) => string },
): ContractProject {
  const sourceRefIds: string[] = [];
  visitProjectSecretRefs(project, (ref) => sourceRefIds.push(ref.id));

  const allSourceIds = new Set(sourceRefIds);
  const mappedIds = new Map<string, string>();
  const targetIds = new Set<string>();
  for (const sourceRefId of sourceRefIds) {
    if (mappedIds.has(sourceRefId)) continue;

    const targetRefId = options.newId(sourceRefId);
    if (typeof targetRefId !== "string") throw new TypeError("SecretRef ID factory must return a string.");
    if (allSourceIds.has(targetRefId)) throw new TypeError("SecretRef ID factory must not reuse a source ID.");
    if (targetIds.has(targetRefId)) throw new TypeError("SecretRef ID factory must return unique target IDs.");

    mappedIds.set(sourceRefId, targetRefId);
    targetIds.add(targetRefId);
  }

  const candidate = cloneDefinitionValue(project);
  visitProjectSecretRefs(candidate, (ref) => {
    const targetRefId = mappedIds.get(ref.id);
    if (targetRefId === undefined) throw new TypeError("SecretRef ID mapping is incomplete.");
    ref.id = targetRefId;
  });
  return candidate;
}
