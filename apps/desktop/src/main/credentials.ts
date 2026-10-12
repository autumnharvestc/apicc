import { createSystemSecretStore, defaultCredentialPrivateRoot, type SecretStore } from "@apicc/core";
import type { createSession } from "./session.js";
import { createCredentialHost } from "./credentialHost.js";

export type { PreparedDesktopExecutionRun } from "./credentialHost.js";

type Session = ReturnType<typeof createSession>;

export interface DesktopCredentialHostOptions {
  secretStore?: SecretStore;
  credentialPrivateRoot?: string;
}

/** Production adapter: keep the system provider lazy and outside the injected host module. */
export function createDesktopCredentialHost(session: Session, options: DesktopCredentialHostOptions = {}) {
  let store: SecretStore | undefined;
  const getStore = (): SecretStore => {
    store ??= options.secretStore ?? createSystemSecretStore({
      privateRoot: options.credentialPrivateRoot ?? defaultCredentialPrivateRoot(),
    });
    return store;
  };
  return createCredentialHost(session, getStore);
}
