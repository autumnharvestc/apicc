import type { SecretRef } from "../contract/request.js";
import { resolve } from "node:path";
import type { CredentialScope, SecretStore } from "../credentials/types.js";
import type { PreparedNetworkRun } from "../network/prepare.js";
import { OAuthError, type OAuthErrorCode, type OAuthOperationStatus, type OAuthProfile, type OAuthProfileSummary, type OAuthPublicResult } from "./model.js";
import { createOAuthProfileHost, type OAuthProfileHost, type OAuthProfileHostOptions } from "./host.js";
import { defaultOAuthPrivateRoot } from "./host.js";
import type { OAuthTokenGrant } from "./tokenClient.js";

const REFRESH_SKEW_MS = 30_000;

export interface OAuthCoordinatorExchangeInput {
  profile: OAuthProfile;
  grant: OAuthTokenGrant;
  network?: PreparedNetworkRun;
  signal?: AbortSignal;
}

export interface OAuthProfileCoordinatorOptions extends Omit<OAuthProfileHostOptions, "privateRoot"> {
  privateRoot?: string;
  network?: PreparedNetworkRun;
  now?: () => number;
  /** Child executions with parent-captured credential versions must never renew their own token. */
  refreshEnabled?: boolean;
  exchange?: (input: OAuthCoordinatorExchangeInput) => Promise<{ status: OAuthOperationStatus; errorCode?: OAuthErrorCode }>;
}

export interface PrepareOAuthBearerRefsInput {
  scope: CredentialScope;
  environmentId?: string;
  refs: readonly SecretRef[];
  signal?: AbortSignal;
}

export type OAuthExplicitGrant = { type: "client_credentials" } | { type: "refresh_token" };

export interface ExchangeOAuthProfileInput {
  profileId: string;
  grant: OAuthExplicitGrant;
  expectedConfigurationFingerprint: string;
  signal?: AbortSignal;
}

export interface OAuthProfileCoordinator {
  prepareOAuthBearerRefs(input: PrepareOAuthBearerRefsInput): Promise<void>;
  exchangeOAuthProfile(input: ExchangeOAuthProfileInput): Promise<OAuthPublicResult>;
}

interface FlightWaiter {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  settled: boolean;
}

interface Flight {
  controller: AbortController;
  waiters: Set<FlightWaiter>;
  settled: boolean;
  promise: Promise<unknown>;
}

const flights = new Map<string, Flight>();

function sameScope(left: CredentialScope, right: CredentialScope): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

function registrationKey(host: OAuthProfileHost, refId: string): string {
  return JSON.stringify([
    host.scope.canonicalRoot,
    host.scope.project.workspaceId,
    host.scope.project.groupId,
    host.scope.project.projectId,
    host.scope.environmentId ?? null,
    refId,
  ]);
}

function grantFor(profile: OAuthProfile): OAuthTokenGrant {
  switch (profile.flow) {
    case "client_credentials":
      return { type: "client_credentials" };
    case "authorization_code":
    case "refresh_token":
      if (profile.refreshTokenRef === undefined) throw new OAuthError("OAUTH_AUTHORIZATION_REQUIRED");
      return { type: "refresh_token" };
  }
}

function needsExchange(summary: OAuthProfileSummary, now: number): boolean {
  if (summary.status === "unconfigured") return true;
  if (summary.expiresAt === undefined) return false;
  return summary.expiresAt <= now + REFRESH_SKEW_MS;
}

function stateError(summary: OAuthProfileSummary): OAuthError {
  if (summary.errorCode !== undefined) return new OAuthError(summary.errorCode);
  return new OAuthError("OAUTH_AUTHORIZATION_REQUIRED");
}

function addWaiter<T>(flight: Flight, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new OAuthError("OAUTH_REQUEST_ABORTED"));
  return new Promise<T>((resolve, reject) => {
    const waiter: FlightWaiter = {
      resolve: (value) => resolve(value as T),
      reject,
      signal,
      settled: false,
    };
    const detach = (): void => {
      if (waiter.abortHandler !== undefined) signal?.removeEventListener("abort", waiter.abortHandler);
      flight.waiters.delete(waiter);
    };
    waiter.abortHandler = () => {
      if (waiter.settled) return;
      waiter.settled = true;
      detach();
      reject(new OAuthError("OAUTH_REQUEST_ABORTED"));
      if (!flight.settled && flight.waiters.size === 0) flight.controller.abort();
    };
    signal?.addEventListener("abort", waiter.abortHandler, { once: true });
    flight.waiters.add(waiter);
    if (signal?.aborted) {
      waiter.abortHandler();
      return;
    }
    void flight.promise.then(
      (value: unknown) => {
        if (waiter.settled) return;
        waiter.settled = true;
        detach();
        waiter.resolve(value);
      },
      (error: unknown) => {
        if (waiter.settled) return;
        waiter.settled = true;
        detach();
        reject(error);
      },
    );
  });
}

function runFlight<T>(key: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new OAuthError("OAUTH_REQUEST_ABORTED"));
  let flight = flights.get(key);
  if (flight === undefined) {
    const created: Flight = {
      controller: new AbortController(),
      waiters: new Set(),
      settled: false,
      promise: Promise.resolve(),
    };
    flight = created;
    flights.set(key, created);
    created.promise = Promise.resolve().then(() => operation(created.controller.signal)).finally(() => {
      created.settled = true;
      if (flights.get(key) === created) flights.delete(key);
    });
  }
  return addWaiter(flight, signal);
}

function tokenResultError(result: { status: string; errorCode?: OAuthErrorCode }): OAuthError {
  return new OAuthError(result.errorCode ?? "OAUTH_TOKEN_REQUEST_FAILED");
}

function explicitExchangeKey(
  host: OAuthProfileHost,
  privateRoot: string,
  input: ExchangeOAuthProfileInput,
  network: PreparedNetworkRun | undefined,
): string {
  return JSON.stringify([
    "explicit-oauth-exchange",
    resolve(privateRoot),
    host.scope.canonicalRoot,
    host.scope.project.workspaceId,
    host.scope.project.groupId,
    host.scope.project.projectId,
    host.scope.environmentId ?? null,
    input.profileId,
    input.expectedConfigurationFingerprint,
    input.grant.type,
    network?.identity ?? null,
  ]);
}

/** Coordinates selected Bearer refs before final credential binding; no run-loop or VU refresh is performed here. */
export function createOAuthProfileCoordinator(options: OAuthProfileCoordinatorOptions): OAuthProfileCoordinator {
  const privateRoot = options.privateRoot ?? defaultOAuthPrivateRoot();
  const hostPromise = createOAuthProfileHost({
    workspaceRoot: options.workspaceRoot,
    project: options.project,
    ...(options.environmentId === undefined ? {} : { environmentId: options.environmentId }),
    privateRoot,
    secretStore: options.secretStore,
  });
  const now = options.now ?? Date.now;
  const refreshEnabled = options.refreshEnabled ?? true;

  const prepareOne = async (
    host: Awaited<ReturnType<typeof createOAuthProfileHost>>,
    ref: SecretRef,
    signal?: AbortSignal,
  ): Promise<void> => {
    await host.withBearerRefLock(ref.id, { network: options.network, signal }, async (binding) => {
      if (binding === undefined) return;
      const current = binding.summary;
      if (current.status === "failed" || current.status === "reauthorization_required") throw stateError(current);
      if (!needsExchange(current, now())) return;
      if (!refreshEnabled) return;

      const grant = grantFor(current.profile);
      const result = options.exchange === undefined
        ? await binding.exchange(grant)
        : await options.exchange({
          profile: current.profile,
          grant,
          ...(options.network === undefined ? {} : { network: options.network }),
          ...(signal === undefined ? {} : { signal }),
        });
      if (result.status !== "success") throw tokenResultError(result);
    });
  };

  return Object.freeze({
    async prepareOAuthBearerRefs(input: PrepareOAuthBearerRefsInput): Promise<void> {
      const host = await hostPromise;
      if (!sameScope(input.scope, host.scope.project) || input.environmentId !== host.scope.environmentId) {
        throw new OAuthError("OAUTH_PROFILE_INVALID");
      }
      const refs = [...new Map(input.refs.filter((ref) => ref.policy === "test-auto").map((ref) => [ref.id, ref])).values()]
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const ref of refs) {
        const key = registrationKey(host, ref.id);
        await runFlight(key, (signal) => prepareOne(host, ref, signal), input.signal);
      }
    },
    async exchangeOAuthProfile(input: ExchangeOAuthProfileInput): Promise<OAuthPublicResult> {
      const host = await hostPromise;
      const key = explicitExchangeKey(host, privateRoot, input, options.network);
      return await runFlight(key, (signal) => host.exchange(input.profileId, input.grant, {
        ...(options.network === undefined ? {} : { network: options.network }),
        signal,
        expectedConfigurationFingerprint: input.expectedConfigurationFingerprint,
      }), input.signal);
    },
  });
}
