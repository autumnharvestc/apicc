import { CredentialError, type CredentialScope, type SecretRef, type SecretStore } from "@apicc/core";

/** Project is the default; personal refs must be explicitly selected for this local run. */
export function createOnlineLocalCredentialStore(input: {
  contractScope: CredentialScope; projectStore: SecretStore; localStore: SecretStore; localOnlyRefIds?: readonly string[]; localScope?: CredentialScope;
}): SecretStore {
  const scope = Object.freeze({ ...input.contractScope }); const localRefs = new Set(input.localOnlyRefIds ?? []);
  const projectStore = input.projectStore; const localStore = input.localStore;
  const selected = (caller: CredentialScope, ref: SecretRef) => {
    if (caller.workspaceId !== scope.workspaceId || caller.groupId !== scope.groupId || caller.projectId !== scope.projectId) throw new CredentialError("CREDENTIAL_UNAVAILABLE", ref.id);
    return localRefs.has(ref.id) ? localStore : projectStore;
  };
  // Preserve the remote store's server/login identity for the execution host's start check.
  return Object.freeze({ ...("onlineBinding" in projectStore ? { onlineBinding: projectStore.onlineBinding } : {}),
    async put(caller: CredentialScope, ref: SecretRef, value: string) { return selected(caller, ref).put(localRefs.has(ref.id) ? input.localScope ?? scope : scope, ref, value); },
    async resolve(caller: CredentialScope, ref: SecretRef, expected?: string) { return selected(caller, ref).resolve(localRefs.has(ref.id) ? input.localScope ?? scope : scope, ref, expected); },
    async version(caller: CredentialScope, ref: SecretRef) { return selected(caller, ref).version(localRefs.has(ref.id) ? input.localScope ?? scope : scope, ref); },
    async remove(caller: CredentialScope, ref: SecretRef) { return selected(caller, ref).remove(localRefs.has(ref.id) ? input.localScope ?? scope : scope, ref); },
    async status(caller: CredentialScope, ref: SecretRef) { return selected(caller, ref).status(localRefs.has(ref.id) ? input.localScope ?? scope : scope, ref); },
  });
}
