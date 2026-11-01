import { CredentialError, type CredentialScope, type SecretRef, type SecretStore } from '@apicc/core';
import { createHash } from 'node:crypto';
import type { MemberExecutionContext } from './memberTypes.js';

// Versioned identity adaptation retains the desktop's private namespace.
export function memberLocalScope(context: MemberExecutionContext, projectId: string) {
  const uuid = (purpose: string, identity: string[]) => {
    const bytes = createHash('sha256').update(JSON.stringify(['apicc-online-personal-v1', purpose, ...identity])).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  };
  const { ownerId, scope } = context; const serverId = new URL(context.serverId).href.replace(/\/$/, '');
  return { workspaceId: uuid('server-owner', [serverId, ownerId]), groupId: uuid('remote-project', [serverId, ownerId, scope.workspaceId, scope.groupId, scope.projectId]), projectId };
}
export function createMemberLocalCredentialStore(input: { contractScope: CredentialScope; projectStore: SecretStore; localStore: SecretStore; localOnlyRefIds: readonly string[]; localScope: CredentialScope }): SecretStore {
  const scope = Object.freeze({ ...input.contractScope }); const localRefs = new Set(input.localOnlyRefIds);
  const selected = (caller: CredentialScope, ref: SecretRef) => {
    if (caller.workspaceId !== scope.workspaceId || caller.groupId !== scope.groupId || caller.projectId !== scope.projectId) throw new CredentialError('CREDENTIAL_UNAVAILABLE', ref.id);
    return localRefs.has(ref.id) ? input.localStore : input.projectStore;
  };
  const address = (ref: SecretRef) => localRefs.has(ref.id) ? input.localScope : scope;
  return Object.freeze({ ...('onlineBinding' in input.projectStore ? { onlineBinding: input.projectStore.onlineBinding } : {}),
    async put(caller: CredentialScope, ref: SecretRef, value: string) { return selected(caller,ref).put(address(ref),ref,value); },
    async resolve(caller: CredentialScope, ref: SecretRef, expected?: string) { return selected(caller,ref).resolve(address(ref),ref,expected); },
    async version(caller: CredentialScope, ref: SecretRef) { return selected(caller,ref).version(address(ref),ref); },
    async remove(caller: CredentialScope, ref: SecretRef) { return selected(caller,ref).remove(address(ref),ref); },
    async status(caller: CredentialScope, ref: SecretRef) { return selected(caller,ref).status(address(ref),ref); },
  });
}
