import { randomUUID } from "node:crypto";
import type { SecretRef } from "../contract/model.js";
import { credentialEntryAddress } from "./address.js";
import { credentialIndexPath, readPrivateIndex, withCredentialLock, writePrivateIndexAtomically } from "./privateIndex.js";
import { CredentialError, type CredentialScope, type SecretStore } from "./types.js";

const SUPPORTED_POLICY = "test-auto";
const ENVELOPE_FORMAT_VERSION = 1;

interface CredentialBackend {
  getPassword(service: string, account: string): Promise<unknown>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deleteCredential(service: string, account: string): Promise<boolean>;
}

export interface SystemStoreOptions {
  privateRoot: string;
  loadBackend?: () => Promise<CredentialBackend>;
}

interface CredentialEnvelope {
  formatVersion: 1;
  policy: string;
  value: string;
}

function credentialError(error: unknown, code: ConstructorParameters<typeof CredentialError>[0], refId: string): CredentialError {
  return error instanceof CredentialError ? error : new CredentialError(code, refId);
}

function validateRef(privateRoot: string, scope: CredentialScope, ref: SecretRef): string {
  if (typeof ref !== "object" || ref === null || typeof ref.id !== "string" || typeof ref.policy !== "string") {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", "");
  }
  const path = credentialIndexPath(privateRoot, scope, ref.id);
  if (ref.policy !== SUPPORTED_POLICY) throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", ref.id);
  return path;
}

function validatePointerPolicy(policy: string, refId: string): void {
  if (policy !== SUPPORTED_POLICY) throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", refId);
}

function parseEnvelope(serialized: string, refId: string, expectedPolicy: string): CredentialEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", refId);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", refId);
  }
  const envelope = parsed as Partial<CredentialEnvelope>;
  if (envelope.formatVersion !== ENVELOPE_FORMAT_VERSION
    || typeof envelope.policy !== "string"
    || typeof envelope.value !== "string") {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", refId);
  }
  validatePointerPolicy(envelope.policy, refId);
  if (envelope.policy !== expectedPolicy) throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", refId);
  return envelope as CredentialEnvelope;
}

function entryAddress(scope: CredentialScope, refId: string, generation: string): [string, string] {
  return credentialEntryAddress(scope, refId, generation);
}

async function loadSystemBackend(): Promise<CredentialBackend> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  const entryOptions = { linux: { store: "secret-service" as const } };
  return {
    async getPassword(service, account) {
      return new AsyncEntry(service, account, entryOptions).getPassword();
    },
    async setPassword(service, account, password) {
      await new AsyncEntry(service, account, entryOptions).setPassword(password);
    },
    async deleteCredential(service, account) {
      return new AsyncEntry(service, account, entryOptions).deleteCredential();
    },
  };
}

export function createSystemSecretStore(options: SystemStoreOptions): SecretStore {
  const usesDefaultBackend = options.loadBackend === undefined;
  let backendPromise: Promise<CredentialBackend> | undefined;
  const getBackend = (): Promise<CredentialBackend> => {
    backendPromise ??= (options.loadBackend ?? loadSystemBackend)().then((loaded) => {
      if (typeof loaded !== "object" || loaded === null
        || typeof loaded.getPassword !== "function"
        || typeof loaded.setPassword !== "function"
        || typeof loaded.deleteCredential !== "function") {
        throw new Error("invalid credential backend");
      }
      return loaded;
    });
    return backendPromise;
  };

  const readIndex = async (scope: CredentialScope, refId: string) => {
    try {
      return await readPrivateIndex(options.privateRoot, scope, refId);
    } catch (error) {
      throw credentialError(error, "CREDENTIAL_READ_FAILED", refId);
    }
  };

  const readStoredValue = async (
    scope: CredentialScope,
    ref: SecretRef,
    generation: string,
    policy: string,
  ): Promise<string | null> => {
    validatePointerPolicy(policy, ref.id);
    let backend: CredentialBackend;
    try {
      backend = await getBackend();
    } catch (error) {
      throw credentialError(error, "CREDENTIAL_UNAVAILABLE", ref.id);
    }
    const [service, account] = entryAddress(scope, ref.id, generation);
    let stored: unknown;
    try {
      stored = await backend.getPassword(service, account);
    } catch (error) {
      if (usesDefaultBackend) throw new CredentialError("CREDENTIAL_UNAVAILABLE", ref.id);
      throw credentialError(error, "CREDENTIAL_READ_FAILED", ref.id);
    }
    if (stored === null || stored === undefined) return null;
    if (typeof stored !== "string") throw new CredentialError("CREDENTIAL_READ_FAILED", ref.id);
    return parseEnvelope(stored, ref.id, policy).value;
  };

  return {
    async put(scope, ref, value) {
      validateRef(options.privateRoot, scope, ref);
      if (typeof value !== "string") throw new CredentialError("CREDENTIAL_SAVE_FAILED", ref.id);
      try {
        await withCredentialLock(options.privateRoot, scope, ref.id, async () => {
          const previous = await readIndex(scope, ref.id);
          if (previous) validatePointerPolicy(previous.policy, ref.id);

          let backend: CredentialBackend;
          try {
            backend = await getBackend();
          } catch (error) {
            throw credentialError(error, "CREDENTIAL_UNAVAILABLE", ref.id);
          }

          const generation = randomUUID();
          const [service, account] = entryAddress(scope, ref.id, generation);
          const serialized = JSON.stringify({
            formatVersion: ENVELOPE_FORMAT_VERSION,
            policy: ref.policy,
            value,
          } satisfies CredentialEnvelope);
          let candidateMayExist = false;
          try {
            await backend.setPassword(service, account, serialized);
            candidateMayExist = true;
            let stored: unknown;
            try {
              stored = await backend.getPassword(service, account);
            } catch {
              throw new CredentialError("CREDENTIAL_SAVE_FAILED", ref.id);
            }
            if (typeof stored !== "string") throw new CredentialError("CREDENTIAL_SAVE_FAILED", ref.id);
            let verified: CredentialEnvelope;
            try {
              verified = parseEnvelope(stored, ref.id, ref.policy);
            } catch {
              throw new CredentialError("CREDENTIAL_SAVE_FAILED", ref.id);
            }
            if (verified.value !== value) throw new CredentialError("CREDENTIAL_SAVE_FAILED", ref.id);

            await writePrivateIndexAtomically(options.privateRoot, scope, {
              formatVersion: 1,
              refId: ref.id,
              generation,
              policy: ref.policy,
              version: generation,
            });
          } catch (error) {
            if (candidateMayExist) await backend.deleteCredential(service, account).catch(() => false);
            throw credentialError(error, "CREDENTIAL_SAVE_FAILED", ref.id);
          }
        });
      } catch (error) {
        throw credentialError(error, "CREDENTIAL_SAVE_FAILED", ref.id);
      }
    },

    async resolve(scope, ref, expectedVersion) {
      validateRef(options.privateRoot, scope, ref);
      const pointer = await readIndex(scope, ref.id);
      if (!pointer) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      validatePointerPolicy(pointer.policy, ref.id);
      if (pointer.policy !== ref.policy) throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", ref.id);
      if (expectedVersion !== undefined && expectedVersion !== pointer.version) {
        throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
      }
      const value = await readStoredValue(scope, ref, pointer.generation, pointer.policy);
      if (value === null) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      return value;
    },

    async version(scope, ref) {
      validateRef(options.privateRoot, scope, ref);
      const pointer = await readIndex(scope, ref.id);
      if (!pointer) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      validatePointerPolicy(pointer.policy, ref.id);
      if (pointer.policy !== ref.policy) throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", ref.id);
      const value = await readStoredValue(scope, ref, pointer.generation, pointer.policy);
      if (value === null) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      return pointer.version;
    },

    async remove(scope, ref) {
      validateRef(options.privateRoot, scope, ref);
      if (!(await readIndex(scope, ref.id))) return;
      try {
        await withCredentialLock(options.privateRoot, scope, ref.id, async () => {
          const pointer = await readIndex(scope, ref.id);
          if (!pointer) return;
          validatePointerPolicy(pointer.policy, ref.id);
          let backend: CredentialBackend;
          try {
            backend = await getBackend();
          } catch (error) {
            throw credentialError(error, "CREDENTIAL_UNAVAILABLE", ref.id);
          }
          const [service, account] = entryAddress(scope, ref.id, pointer.generation);
          try {
            const deleted = await backend.deleteCredential(service, account);
            if (typeof deleted !== "boolean") throw new Error("invalid delete result");
          } catch {
            throw new CredentialError("CREDENTIAL_REMOVE_FAILED", ref.id);
          }
        });
      } catch (error) {
        throw credentialError(error, "CREDENTIAL_REMOVE_FAILED", ref.id);
      }
    },

    async status(scope, ref) {
      validateRef(options.privateRoot, scope, ref);
      const pointer = await readIndex(scope, ref.id);
      if (!pointer) return "missing";
      validatePointerPolicy(pointer.policy, ref.id);
      if (pointer.policy !== ref.policy) throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", ref.id);
      try {
        const value = await readStoredValue(scope, ref, pointer.generation, pointer.policy);
        return value === null ? "missing" : "available";
      } catch (error) {
        if (error instanceof CredentialError && error.code === "CREDENTIAL_UNAVAILABLE") return "unavailable";
        throw credentialError(error, "CREDENTIAL_READ_FAILED", ref.id);
      }
    },
  };
}
