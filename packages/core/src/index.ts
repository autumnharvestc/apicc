import { createSystemSecretStore as createInternalSystemSecretStore } from "./credentials/systemStore.js";
import type { SecretStore as SecretStoreContract } from "./credentials/types.js";

export * from "./shared.js";

export function createSystemSecretStore(options: { privateRoot: string }): SecretStoreContract {
  return createInternalSystemSecretStore({ privateRoot: options.privateRoot });
}
