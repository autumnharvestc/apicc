import { createDebugHistoryStore, defaultDebugHistoryRoot } from "@apicc/core";

export interface DesktopDebugHistoryOptions {
  /** Host-provided OS application-data directory; never accepted from renderer IPC. */
  appDataDirectory?: string;
  /** Private-root injection for host tests and embedded deployments. */
  privateRoot?: string;
}

export function createDesktopDebugHistoryStore(options: DesktopDebugHistoryOptions) {
  if (options.privateRoot !== undefined && options.appDataDirectory !== undefined) {
    throw new TypeError("Provide either a private history root or an app-data directory, not both.");
  }
  const root = options.privateRoot ?? (options.appDataDirectory === undefined
    ? undefined
    : defaultDebugHistoryRoot(options.appDataDirectory));
  if (!root) throw new TypeError("The desktop host must supply its app-data directory or an injected private root.");
  return createDebugHistoryStore({ root });
}
