import { createDesktopCredentialHost } from "./credentials.js";
import type { DebugCredentialHost } from "./credentialHost.js";
import { createStressControllerWithHost, type StressControllerDeps } from "./stressController.js";
import type { createSession } from "./session.js";

export type { ManagedProtocolClient, StressControllerDeps } from "./stressController.js";

type Session = ReturnType<typeof createSession>;

/** Production adapter retains the public signature and lazily assembled credential host. */
export function createStressController(
  session: Session,
  deps: StressControllerDeps = {},
  credentials: DebugCredentialHost = createDesktopCredentialHost(session),
) {
  return createStressControllerWithHost(session, deps, credentials);
}
