import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { SecretStore } from "../credentials/types.js";
import { createFileNetworkProfileStore, type NetworkProfileStore } from "./privateStore.js";
import {
  NetworkProfileError,
  NetworkScopeSchema,
  type NetworkProjectIdentity,
  type NetworkScope,
  type NetworkSelection,
} from "./profiles.js";
import { prepareNetworkRun, type PreparedNetworkRun } from "./prepare.js";

export interface NetworkProfileHostOptions {
  workspaceRoot: string;
  project: NetworkProjectIdentity;
  environmentId?: string;
  privateRoot?: string;
  secretStore: SecretStore;
}

export interface NetworkProfileHost {
  readonly scope: NetworkScope;
  readonly store: NetworkProfileStore;
  prepare(options?: { selection?: NetworkSelection; signal?: AbortSignal }): Promise<PreparedNetworkRun>;
}

export function defaultNetworkPrivateRoot(): string {
  return join(homedir(), ".apicc", "private", "network", "v1");
}

/** Captures the caller-supplied workspace root; it never infers identity from process.cwd(). */
export async function createNetworkProfileHost(options: NetworkProfileHostOptions): Promise<NetworkProfileHost> {
  if (typeof options?.workspaceRoot !== "string" || !isAbsolute(options.workspaceRoot)) {
    throw new NetworkProfileError("NETWORK_WORKSPACE_ROOT_UNAVAILABLE", undefined, "canonicalRoot");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(options.workspaceRoot);
    if (!(await stat(canonicalRoot)).isDirectory()) {
      throw new NetworkProfileError("NETWORK_WORKSPACE_ROOT_UNAVAILABLE", undefined, "canonicalRoot");
    }
  } catch {
    throw new NetworkProfileError("NETWORK_WORKSPACE_ROOT_UNAVAILABLE", undefined, "canonicalRoot");
  }

  const candidate = {
    canonicalRoot,
    project: options.project,
    ...(options.environmentId === undefined ? {} : { environmentId: options.environmentId }),
  };
  const scopeResult = NetworkScopeSchema.safeParse(candidate);
  if (!scopeResult.success) throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", undefined, "scope");
  const scope: NetworkScope = Object.freeze({
    ...scopeResult.data,
    project: Object.freeze({ ...scopeResult.data.project }),
  });
  const store = createFileNetworkProfileStore({ privateRoot: options.privateRoot ?? defaultNetworkPrivateRoot() });
  const secretStore = options.secretStore;

  return Object.freeze({
    scope,
    store,
    prepare(prepareOptions: { selection?: NetworkSelection; signal?: AbortSignal } = {}) {
      return prepareNetworkRun({ ...prepareOptions, scope, store, secretStore });
    },
  });
}
