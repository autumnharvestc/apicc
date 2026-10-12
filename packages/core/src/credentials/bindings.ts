import type { SecretRef } from "../contract/model.js";
import { CredentialError, type CredentialBindings, type CredentialScope, type SecretStore } from "./types.js";

const SUPPORTED_POLICY = "test-auto";

function credentialError(error: unknown, fallback: ConstructorParameters<typeof CredentialError>[0], refId: string): CredentialError {
  return error instanceof CredentialError ? error : new CredentialError(fallback, refId);
}

export async function prepareCredentialBindings(
  scope: CredentialScope,
  refs: readonly SecretRef[],
  store: SecretStore,
  expectedVersions?: Readonly<Record<string, string>>,
): Promise<CredentialBindings> {
  const refsById = new Map<string, SecretRef>();
  for (const ref of refs) {
    if (!ref || typeof ref.id !== "string") {
      throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", typeof ref?.id === "string" ? ref.id : "");
    }
    if (ref.policy !== SUPPORTED_POLICY) {
      throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", ref.id);
    }
    const existing = refsById.get(ref.id);
    if (existing && existing.policy !== ref.policy) {
      throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", ref.id);
    }
    if (!existing) refsById.set(ref.id, Object.freeze({ id: ref.id, policy: ref.policy }));
  }

  const uniqueRefs = [...refsById.values()];
  const emptyVersions = Object.freeze({}) as Readonly<Record<string, string>>;
  if (uniqueRefs.length === 0) {
    return Object.freeze({
      resolve(ref: SecretRef) {
        throw new CredentialError("CREDENTIAL_MISSING", ref?.id ?? "");
      },
      versions: emptyVersions,
    });
  }

  const initialVersions = new Map<string, string>();
  for (const ref of uniqueRefs) {
    let version: string;
    try {
      version = await store.version(scope, ref);
    } catch (error) {
      throw credentialError(error, "CREDENTIAL_UNAVAILABLE", ref.id);
    }
    if (typeof version !== "string" || version.length === 0) {
      throw new CredentialError("CREDENTIAL_READ_FAILED", ref.id);
    }
    initialVersions.set(ref.id, version);
  }

  for (const ref of uniqueRefs) {
    const expected = expectedVersions !== undefined
      && expectedVersions !== null
      && Object.hasOwn(expectedVersions, ref.id)
      ? expectedVersions[ref.id]
      : undefined;
    if (expected !== undefined && expected !== initialVersions.get(ref.id)) {
      throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
    }
  }

  const preparedValues = new Map<string, string>();
  for (const ref of uniqueRefs) {
    let value: string;
    try {
      value = await store.resolve(scope, ref, initialVersions.get(ref.id));
    } catch (error) {
      if (error instanceof CredentialError && error.code === "CREDENTIAL_MISSING") {
        throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
      }
      throw credentialError(error, "CREDENTIAL_READ_FAILED", ref.id);
    }
    if (typeof value !== "string") {
      throw new CredentialError("CREDENTIAL_READ_FAILED", ref.id);
    }
    preparedValues.set(ref.id, value);
  }

  const currentVersions = new Map<string, string>();
  for (const ref of uniqueRefs) {
    let currentVersion: string;
    try {
      currentVersion = await store.version(scope, ref);
    } catch (error) {
      if (error instanceof CredentialError && error.code === "CREDENTIAL_MISSING") {
        throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
      }
      throw credentialError(error, "CREDENTIAL_UNAVAILABLE", ref.id);
    }
    currentVersions.set(ref.id, currentVersion);
  }

  for (const ref of uniqueRefs) {
    if (currentVersions.get(ref.id) !== initialVersions.get(ref.id)) {
      throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
    }
    let status: Awaited<ReturnType<SecretStore["status"]>>;
    try {
      status = await store.status(scope, ref);
    } catch (error) {
      if (error instanceof CredentialError && error.code === "CREDENTIAL_MISSING") {
        throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
      }
      throw credentialError(error, "CREDENTIAL_UNAVAILABLE", ref.id);
    }
    if (status === "missing") throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
    if (status !== "available") throw new CredentialError("CREDENTIAL_UNAVAILABLE", ref.id);
  }

  const versions = Object.freeze(Object.fromEntries(initialVersions));
  return Object.freeze({
    resolve(ref: SecretRef) {
      const snapshotRef = ref && refsById.get(ref.id);
      if (!snapshotRef) throw new CredentialError("CREDENTIAL_MISSING", ref?.id ?? "");
      if (snapshotRef.policy !== ref.policy) throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", ref.id);
      return preparedValues.get(ref.id)!;
    },
    versions,
  });
}
