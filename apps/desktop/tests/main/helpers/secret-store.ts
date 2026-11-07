import { CredentialError, type CredentialScope, type SecretRef, type SecretStore } from "@apicc/core";

/** Explicit test provider; a private index root does not isolate the OS keyring. */
export function createMemorySecretStore() {
  const values = new Map<string, { value: string; version: string }>();
  const generations = new Map<string, number>();
  const calls: Array<{ method: string; scope: CredentialScope; ref: SecretRef; value?: string }> = [];
  const failures = new Map<string, unknown>();
  const key = (address: CredentialScope, ref: SecretRef) => JSON.stringify([address.workspaceId, address.groupId, address.projectId, ref.id]);
  const failIfRequested = (method: string): void => {
    if (!failures.has(method)) return;
    const error = failures.get(method);
    failures.delete(method);
    throw error;
  };
  const store: SecretStore = {
    async put(address, ref, value) {
      calls.push({ method: "put", scope: { ...address }, ref: { ...ref }, value });
      failIfRequested("put");
      const addressKey = key(address, ref);
      const generation = (generations.get(addressKey) ?? 0) + 1;
      generations.set(addressKey, generation);
      values.set(addressKey, { value, version: `generation-${generation}` });
    },
    async resolve(address, ref, expectedVersion) {
      calls.push({ method: "resolve", scope: { ...address }, ref: { ...ref } });
      failIfRequested("resolve");
      const current = values.get(key(address, ref));
      if (!current) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      if (expectedVersion !== current.version) throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
      return current.value;
    },
    async version(address, ref) {
      calls.push({ method: "version", scope: { ...address }, ref: { ...ref } });
      failIfRequested("version");
      const current = values.get(key(address, ref));
      if (!current) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      return current.version;
    },
    async remove(address, ref) {
      calls.push({ method: "remove", scope: { ...address }, ref: { ...ref } });
      failIfRequested("remove");
      if (!values.delete(key(address, ref))) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
    },
    async status(address, ref) {
      calls.push({ method: "status", scope: { ...address }, ref: { ...ref } });
      failIfRequested("status");
      return values.has(key(address, ref)) ? "available" : "missing";
    },
  };
  return {
    store,
    calls,
    values,
    failNext(method: "put" | "resolve" | "version" | "remove" | "status", error: unknown) {
      failures.set(method, error);
    },
  };
}
