import type { SecretRef } from "../contract/model.js";

export interface CredentialScope {
  workspaceId: string;
  groupId: string;
  projectId: string;
}

export type CredentialErrorCode =
  | "CREDENTIAL_MISSING"
  | "CREDENTIAL_UNAVAILABLE"
  | "CREDENTIAL_FORMAT_UNSUPPORTED"
  | "CREDENTIAL_POLICY_UNSUPPORTED"
  | "CREDENTIAL_READ_FAILED"
  | "CREDENTIAL_SAVE_FAILED"
  | "CREDENTIAL_REMOVE_FAILED"
  | "CREDENTIAL_VERSION_CONFLICT";

export class CredentialError extends Error {
  constructor(
    readonly code: CredentialErrorCode,
    readonly refId: string,
  ) {
    super(`${code}: ${refId}`);
    this.name = "CredentialError";
  }
}

export interface SecretStore {
  put(scope: CredentialScope, ref: SecretRef, value: string): Promise<void>;
  resolve(scope: CredentialScope, ref: SecretRef, expectedVersion?: string): Promise<string>;
  version(scope: CredentialScope, ref: SecretRef): Promise<string>;
  remove(scope: CredentialScope, ref: SecretRef): Promise<void>;
  status(scope: CredentialScope, ref: SecretRef): Promise<"available" | "missing" | "unavailable">;
}

export interface CredentialBindings {
  resolve(ref: SecretRef): string;
  readonly versions: Readonly<Record<string, string>>;
}
