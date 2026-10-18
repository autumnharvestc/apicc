import {
  createNetworkProfileHost,
  createSystemSecretStore,
  createFileOAuthProfileStore,
  createOAuthProfileCoordinator,
  createOAuthProfileHost,
  defaultCredentialPrivateRoot,
  defaultOAuthPrivateRoot,
  defaultNetworkPrivateRoot,
  withOAuthBearerRefLock,
  CredentialError,
  type SecretStore,
  type NetworkConfiguration,
  type SecretRef,
} from "@apicc/core";
import { readFile, stat } from "node:fs/promises";
import type { createSession } from "./session.js";
import { createCredentialHost } from "./credentialHost.js";
import { ProjectLocatorSchema, type ProjectLocator } from "../shared/locations.js";
import { NetworkConfigurationSchema } from "@apicc/core";
import { OAuthError, type OAuthProfile } from "@apicc/core";
import { createOAuthAuthorizationSessionManager } from "./oauth.js";
import type { OAuthAuthorizationBeginInput, OAuthProfileActionInput, OAuthProfileMutationResult, OAuthProfileSaveInput, OAuthProfileUnlinkInput, OAuthProfilesGetInput } from "../shared/oauth.js";

export type { CredentialHost, DebugCredentialHost, PreparedDesktopExecutionRun } from "./credentialHost.js";

type Session = ReturnType<typeof createSession>;

export interface DesktopCredentialHostOptions {
  secretStore?: SecretStore;
  credentialPrivateRoot?: string;
  networkPrivateRoot?: string;
  oauthPrivateRoot?: string;
  openExternal?: (url: string) => Promise<void>;
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
  // An explicitly injected SecretStore is a test/provider boundary. Keep it isolated from the
  // user's default OAuth registry unless that boundary also supplies an owned registry root.
  const useOAuthCoordination = options.oauthPrivateRoot !== undefined || options.secretStore === undefined;
  const oauthPrivateRoot = options.oauthPrivateRoot ?? defaultOAuthPrivateRoot();
  const oauthStore = useOAuthCoordination ? createFileOAuthProfileStore({ privateRoot: oauthPrivateRoot }) : undefined;
  const authorizationSessions = options.openExternal === undefined
    ? undefined
    : createOAuthAuthorizationSessionManager({ openExternal: options.openExternal });
  const credentialHost = createCredentialHost(session, getStore, async (scope, snapshot, context) => {
    const workspaceRoot = context.workspaceRoot || session.root;
    if (!workspaceRoot) throw new Error("尚未打开本地工作区");
    const host = await createNetworkProfileHost({
      workspaceRoot,
      project: { workspaceId: scope.workspaceId, groupId: scope.groupId, projectId: scope.projectId },
      ...(context.environmentId === undefined ? {} : { environmentId: context.environmentId }),
      privateRoot: options.networkPrivateRoot ?? defaultNetworkPrivateRoot(),
      secretStore: getStore(),
    });
    return host.prepare(context.signal === undefined ? {} : { signal: context.signal });
  }, async (scope, refs, context, network) => {
    if (refs.length === 0 || !useOAuthCoordination) return;
    const workspaceRoot = context.workspaceRoot || session.root;
    if (!workspaceRoot) throw new Error("尚未打开本地工作区");
    const coordinator = createOAuthProfileCoordinator({
      workspaceRoot,
      project: { workspaceId: scope.workspaceId, groupId: scope.groupId, projectId: scope.projectId },
      ...(context.environmentId === undefined ? {} : { environmentId: context.environmentId }),
      privateRoot: oauthPrivateRoot,
      secretStore: getStore(),
      ...(network === undefined ? {} : { network }),
    });
    await coordinator.prepareOAuthBearerRefs({
      scope,
      ...(context.environmentId === undefined ? {} : { environmentId: context.environmentId }),
      refs,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  }, async (scope, ref, operation) => {
    if (oauthStore === undefined) return operation();
    await withOAuthBearerRefLock(oauthPrivateRoot, scope, ref.id, async () => {
      const registration = await oauthStore.findBearerRegistration(scope, ref.id);
      if (registration !== undefined) throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
      await operation();
    });
  });

  function networkContext(locatorValue: ProjectLocator, forWrite = false) {
    const parsed = ProjectLocatorSchema.safeParse(locatorValue);
    if (!parsed.success) throw new Error("Network profile project context is unavailable.");
    const location = session.locateProject(parsed.data);
    const workspaceRoot = session.root;
    if (!location || location.project.id !== parsed.data.projectId || location.group.id !== parsed.data.groupId || !workspaceRoot) {
      throw new Error("Network profile project context is unavailable.");
    }
    if (forWrite && session.readOnly) throw new Error("Network profile settings are read-only.");
    return { locator: parsed.data, location, workspaceRoot };
  }

  async function networkHost(locatorValue: ProjectLocator, environmentId?: string) {
    const context = networkContext(locatorValue);
    const host = await createNetworkProfileHost({
      workspaceRoot: context.workspaceRoot,
      project: { workspaceId: context.locator.workspaceId, groupId: context.locator.groupId, projectId: context.locator.projectId },
      ...(environmentId === undefined ? {} : { environmentId }),
      privateRoot: options.networkPrivateRoot ?? defaultNetworkPrivateRoot(),
      secretStore: getStore(),
    });
    return { ...context, host };
  }

  function oauthContext(locatorValue: ProjectLocator, environmentId?: string, forWrite = false) {
    const parsed = ProjectLocatorSchema.safeParse(locatorValue);
    if (!parsed.success) throw new OAuthError("OAUTH_PROFILE_INVALID");
    const location = session.locateProject(parsed.data);
    const workspaceRoot = session.root;
    if (!location || location.project.id !== parsed.data.projectId || location.group.id !== parsed.data.groupId || !workspaceRoot) {
      throw new OAuthError("OAUTH_PROFILE_INVALID");
    }
    if (forWrite && session.readOnly) throw new OAuthError("OAUTH_PROFILE_INVALID");
    if (environmentId !== undefined && !location.project.environments.some((item) => item.id === environmentId)) {
      throw new OAuthError("OAUTH_PROFILE_INVALID");
    }
    return { locator: parsed.data, location, workspaceRoot };
  }

  async function oauthHost(locatorValue: ProjectLocator, environmentId?: string, forWrite = false) {
    const context = oauthContext(locatorValue, environmentId, forWrite);
    const host = await createOAuthProfileHost({
      workspaceRoot: context.workspaceRoot,
      project: { workspaceId: context.locator.workspaceId, groupId: context.locator.groupId, projectId: context.locator.projectId },
      ...(environmentId === undefined ? {} : { environmentId }),
      privateRoot: oauthPrivateRoot,
      secretStore: getStore(),
    });
    return { ...context, host };
  }

  async function oauthProfilesGet(input: OAuthProfilesGetInput) {
    const { host } = await oauthHost(input.locator, input.environmentId);
    return await host.listProfilesSnapshot();
  }

  async function oauthMutationResult(host: Awaited<ReturnType<typeof oauthHost>>["host"], result: import("@apicc/core").OAuthPublicResult): Promise<OAuthProfileMutationResult> {
    try {
      const snapshot = await host.listProfilesSnapshot();
      return { result, profileSnapshot: { status: "available", ...snapshot } };
    } catch {
      // A completed write/exchange remains authoritative even if refreshing its public snapshot fails.
      return { result, profileSnapshot: { status: "unavailable" } };
    }
  }

  async function oauthProfileSave(input: OAuthProfileSaveInput) {
    const { host } = await oauthHost(input.locator, input.environmentId, true);
    if (input.profile.environmentId !== undefined && input.profile.environmentId !== input.environmentId) {
      throw new OAuthError("OAUTH_PROFILE_INVALID");
    }
    const current = await host.store.load(host.scope);
    const result = await host.saveProfile(input.profile as OAuthProfile, {
      expectedRevision: input.expectedRevision ?? current.revision,
    });
    return oauthMutationResult(host, result);
  }

  async function oauthProfileUnlink(input: OAuthProfileUnlinkInput) {
    const { host } = await oauthHost(input.locator, input.environmentId, true);
    const current = await host.store.load(host.scope);
    const result = await host.unlinkProfile(input.profileId, input.expectedRevision ?? current.revision);
    return oauthMutationResult(host, result);
  }

  async function oauthProfileExchangeAction(input: OAuthProfileActionInput, action: "acquire" | "refresh"): Promise<OAuthProfileMutationResult> {
    const { host, locator, workspaceRoot } = await oauthHost(input.locator, input.environmentId, true);
    const selected = (await host.listProfiles()).find((item) => item.profile.profileId === input.profileId);
    if (selected === undefined) throw new OAuthError("OAUTH_PROFILE_NOT_FOUND");
    if (action === "acquire" && selected.profile.flow !== "client_credentials") {
      throw new OAuthError("OAUTH_PROFILE_INVALID");
    }
    if (action === "refresh") {
      if (selected.profile.flow === "client_credentials") throw new OAuthError("OAUTH_PROFILE_INVALID");
      if (selected.profile.refreshTokenRef === undefined) throw new OAuthError("OAUTH_REFRESH_TOKEN_MISSING");
    }

    const network = await networkHost(locator, input.environmentId);
    const preparedNetwork = await network.host.prepare();
    const coordinator = createOAuthProfileCoordinator({
      workspaceRoot,
      project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId },
      ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
      privateRoot: oauthPrivateRoot,
      secretStore: getStore(),
      network: preparedNetwork,
    });
    const result = await coordinator.exchangeOAuthProfile({
      profileId: input.profileId,
      grant: { type: action === "acquire" ? "client_credentials" : "refresh_token" },
      expectedConfigurationFingerprint: selected.configurationFingerprint,
    });
    return oauthMutationResult(host, result);
  }

  async function oauthProfileAcquire(input: OAuthProfileActionInput) {
    return oauthProfileExchangeAction(input, "acquire");
  }

  async function oauthProfileRefresh(input: OAuthProfileActionInput) {
    return oauthProfileExchangeAction(input, "refresh");
  }

  async function oauthAuthorizationBegin(owner: object, input: OAuthAuthorizationBeginInput) {
    if (authorizationSessions === undefined) throw new OAuthError("OAUTH_TOKEN_REQUEST_FAILED");
    const { host, locator } = await oauthHost(input.locator, input.environmentId, true);
    const { host: network } = await networkHost(locator, input.environmentId);
    const preparedNetwork = await network.prepare();
    return authorizationSessions.begin(owner, host, input.profileId, {
      ...(input.listenPort === undefined ? {} : { listenPort: input.listenPort }),
      ...(input.listenHost === undefined ? {} : { listenHost: input.listenHost }),
      network: preparedNetwork,
    });
  }

  function oauthAuthorizationStatus(owner: object, sessionId: string) {
    if (authorizationSessions === undefined) return undefined;
    return authorizationSessions.status(owner, sessionId);
  }

  function oauthAuthorizationWait(owner: object, sessionId: string) {
    if (authorizationSessions === undefined) return Promise.resolve(undefined);
    return authorizationSessions.wait(owner, sessionId);
  }

  function oauthAuthorizationCancel(owner: object, sessionId: string) {
    if (authorizationSessions === undefined) return undefined;
    return authorizationSessions.cancel(owner, sessionId);
  }

  function closeOAuthOwner(owner: object) {
    authorizationSessions?.closeOwner(owner);
  }

  async function networkProfilesGet(locatorValue: ProjectLocator) {
    const { location, host } = await networkHost(locatorValue);
    const loaded = await host.store.load(host.scope);
    const refs = new Map<string, SecretRef>();
    for (const profile of loaded.configuration.profiles) {
      if (profile.kind === "proxy" && profile.passwordRef) refs.set(`${profile.passwordRef.policy}:${profile.passwordRef.id}`, profile.passwordRef);
      const tlsSettings = [...profile.targetTlsBindings.map((binding) => binding.tls), ...(profile.kind === "proxy" && profile.proxyTLS ? [profile.proxyTLS] : [])];
      for (const tls of tlsSettings) {
        for (const ref of [tls.clientPrivateKeyRef, tls.clientKeyPassphraseRef]) {
          if (ref) refs.set(`${ref.policy}:${ref.id}`, ref);
        }
      }
    }
    const secretStatuses = await Promise.all([...refs.values()].map(async (ref) => {
      try {
        const status = await getStore().status(host.scope.project, ref);
        return { ref, status: status === "available" || status === "missing" ? status : "unavailable" as const };
      } catch {
        return { ref, status: "unavailable" as const };
      }
    }));
    return {
      revision: loaded.revision,
      configuration: loaded.configuration,
      environments: location.project.environments.map(({ id, name }) => ({ id, name })),
      secretStatuses,
    };
  }

  async function networkProfilesSave(input: { locator: ProjectLocator; revision: string; configuration: NetworkConfiguration }) {
    const parsed = NetworkConfigurationSchema.safeParse(input.configuration);
    if (!parsed.success) throw new Error("Network profile configuration is invalid.");
    const context = networkContext(input.locator, true);
    const environmentIds = new Set(context.location.project.environments.map(({ id }) => id));
    if (parsed.data.environmentSelections.some((entry) => !environmentIds.has(entry.environmentId))) {
      throw new Error("Network profile configuration references an unknown environment.");
    }
    const host = await createNetworkProfileHost({
      workspaceRoot: context.workspaceRoot,
      project: { workspaceId: context.locator.workspaceId, groupId: context.locator.groupId, projectId: context.locator.projectId },
      privateRoot: options.networkPrivateRoot ?? defaultNetworkPrivateRoot(),
      secretStore: getStore(),
    });
    return { revision: await host.store.save(host.scope, parsed.data, input.revision) };
  }

  async function networkSecretImportFromFile(locatorValue: ProjectLocator, refValue: SecretRef, path: string) {
    const context = networkContext(locatorValue, true);
    if (refValue.policy !== "test-auto") return { outcome: "failed" as const, message: "Secret reference policy is unsupported." };
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size === 0 || metadata.size > 1_048_576) {
        return { outcome: "failed" as const, message: "The selected secret file is empty or too large." };
      }
      const value = await readFile(path, "utf8");
      const scope = { workspaceId: context.locator.workspaceId, groupId: context.locator.groupId, projectId: context.locator.projectId };
      if (oauthStore === undefined) await getStore().put(scope, refValue, value);
      else await withOAuthBearerRefLock(oauthPrivateRoot, scope, refValue.id, async () => {
          const registration = await oauthStore.findBearerRegistration(scope, refValue.id);
          if (registration !== undefined) throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", refValue.id);
          await getStore().put(scope, refValue, value);
        });
      return { outcome: "saved" as const, status: "available" as const };
    } catch {
      return { outcome: "failed" as const, message: "The selected secret file could not be saved." };
    }
  }

  return Object.assign(credentialHost, {
    networkProfilesGet,
    networkProfilesSave,
    networkSecretImportFromFile,
    oauthProfilesGet,
    oauthProfileSave,
    oauthProfileUnlink,
    oauthProfileAcquire,
    oauthProfileRefresh,
    oauthAuthorizationBegin,
    oauthAuthorizationStatus,
    oauthAuthorizationWait,
    oauthAuthorizationCancel,
    closeOAuthOwner,
  });
}
