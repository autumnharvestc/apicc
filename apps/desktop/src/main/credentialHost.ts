import {
  ApiAssetSchema,
  ContractProjectSchema,
  CredentialError,
  collectBearerCredentialRefsForRequests,
  collectCredentialMarkersForRequests,
  collectCredentialRefsForRequests,
  collectCredentialRefsFromRequestDrafts,
  collectCredentialOutputMarkers,
  collectProjectCredentialRefs,
  getEffectiveCaseRequest,
  prepareCredentialBindings,
  selectCredentialRequests,
  type ApiAsset,
  type ApiRequest,
  type ContractFolder,
  type ContractProject,
  type CredentialScope,
  type CredentialRequestSelection,
  type DeepReadonly,
  type ProjectExecutionRun,
  type ProjectSnapshot,
  type PreparedNetworkRun,
  type SecretRef,
  type SecretStore,
} from "@apicc/core";
import { ProjectLocatorSchema } from "../shared/locations.js";
import type { ApiLocator, ProjectLocator } from "../shared/locations.js";
import {
  CredentialPutInputSchema,
  CredentialRefInputSchema,
  type CredentialFailure,
  type CredentialMutationResult,
  type CredentialPutInput,
  type CredentialRefInput,
  type CredentialStatusResult,
  type DesktopCredentialErrorCode,
} from "../shared/credentials.js";
import type { createSession, DraftWriteContext } from "./session.js";

type Session = ReturnType<typeof createSession>;

export interface PreparedDesktopExecutionRun {
  run: ProjectExecutionRun;
  refs: readonly SecretRef[];
  markers: readonly string[];
  network?: PreparedNetworkRun;
}

export interface ExecutionNetworkContext {
  workspaceRoot: string;
  environmentId?: string;
  signal?: AbortSignal;
}

export type PrepareExecutionNetwork = (
  scope: CredentialScope,
  snapshot: ProjectSnapshot,
  context: ExecutionNetworkContext,
) => Promise<PreparedNetworkRun>;

export type PrepareOAuthCredentials = (
  scope: CredentialScope,
  refs: readonly SecretRef[],
  context: ExecutionNetworkContext,
  network?: PreparedNetworkRun,
) => Promise<void>;

export type WithCredentialMutationGuard = (
  scope: CredentialScope,
  ref: SecretRef,
  operation: () => Promise<void>,
) => Promise<void>;

export type CredentialHost = Pick<ReturnType<typeof createCredentialHost>, "prepareRun">;
export type DebugCredentialHost = Pick<ReturnType<typeof createCredentialHost>, "prepareRunForRequests">;
export type DraftCredentialGuardHost = Pick<ReturnType<typeof createCredentialHost>, "getKnownCredentialLiterals" | "getKnownCredentialLiteralsForProject">;

const SUPPORTED_POLICY = "test-auto";

const messages: Record<DesktopCredentialErrorCode, string> = {
  CREDENTIAL_MISSING: "Credential is not available.",
  CREDENTIAL_UNAVAILABLE: "Credential store is unavailable.",
  CREDENTIAL_FORMAT_UNSUPPORTED: "Credential format is not supported.",
  CREDENTIAL_POLICY_UNSUPPORTED: "Credential policy is not supported.",
  CREDENTIAL_READ_FAILED: "Credential could not be read.",
  CREDENTIAL_SAVE_FAILED: "Credential could not be saved.",
  CREDENTIAL_REMOVE_FAILED: "Credential could not be removed.",
  CREDENTIAL_VERSION_CONFLICT: "Credential changed while it was being prepared.",
  CREDENTIAL_CONTEXT_INVALID: "The active project context is unavailable.",
  CREDENTIAL_READ_ONLY: "The active workspace is read-only.",
};

const credentialCodes = new Set<DesktopCredentialErrorCode>(Object.keys(messages) as DesktopCredentialErrorCode[]);

function failure(code: DesktopCredentialErrorCode, refId: string): CredentialFailure {
  return { code, refId, message: messages[code] };
}

function credentialFailure(error: unknown, fallback: DesktopCredentialErrorCode, refId: string): CredentialFailure {
  const code = error instanceof CredentialError && credentialCodes.has(error.code)
    ? error.code
    : fallback;
  return failure(code, refId);
}

function suppliedRefId(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const ref = (input as { ref?: unknown }).ref;
  return typeof ref === "object" && ref !== null && !Array.isArray(ref)
    && typeof (ref as { id?: unknown }).id === "string"
    ? (ref as { id: string }).id
    : "";
}

function validateProjectContext(session: Session, locator: CredentialPutInput["locator"]): { scope: CredentialScope; readOnly: boolean } | undefined {
  try {
    const found = session.locateProject(locator);
    if (!found || found.project.id !== locator.projectId || found.group.id !== locator.groupId) return undefined;
    return {
      scope: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId },
      readOnly: session.readOnly,
    };
  } catch {
    return undefined;
  }
}

function collectSnapshotAssets(project: DeepReadonly<ContractProject>): DeepReadonly<ApiAsset>[] {
  const assets: DeepReadonly<ApiAsset>[] = [];
  const visit = (folders: readonly DeepReadonly<ContractFolder>[]): void => {
    for (const folder of folders) {
      assets.push(...folder.apis);
      visit(folder.folders);
    }
  };
  for (const collection of project.collections) {
    assets.push(...collection.apis);
    visit(collection.folders);
  }
  return assets;
}

function isSnapshot(value: unknown): value is ProjectSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const snapshot = value as Partial<ProjectSnapshot>;
  if (typeof snapshot.definitionRevision !== "string"
    || typeof snapshot.project !== "object" || snapshot.project === null
    || typeof snapshot.context !== "object" || snapshot.context === null) return false;
  const context = snapshot.context as Partial<ProjectSnapshot["context"]>;
  if (typeof context.getContract !== "function" || typeof context.getModel !== "function"
    || typeof context.getComponent !== "function" || typeof context.referencesTo !== "function"
    || typeof context.dependencyClosure !== "function" || typeof context.checkGate !== "function") return false;
  return ContractProjectSchema.safeParse(snapshot.project).success;
}

function invalidPreparation(): TypeError {
  return new TypeError("Invalid desktop credential run preparation input.");
}

/**
 * Credential preparation and mutation logic with the storage provider supplied by its caller.
 * This module intentionally has no system-keyring factory dependency so renderer-side memory
 * can reuse the same domain host without pulling native providers into the renderer bundle.
 */
export function createCredentialHost(
  session: Session,
  getSecretStore: () => SecretStore,
  prepareNetwork?: PrepareExecutionNetwork,
  prepareOAuth?: PrepareOAuthCredentials,
  withCredentialMutationGuard?: WithCredentialMutationGuard,
) {
  async function mutate(inputValue: unknown, operation: "put" | "remove"): Promise<CredentialMutationResult> {
    const inputSchema = operation === "put" ? CredentialPutInputSchema : CredentialRefInputSchema;
    const parsed = inputSchema.safeParse(inputValue);
    const refId = parsed.success ? parsed.data.ref.id : suppliedRefId(inputValue);
    if (!parsed.success) {
      return { ok: false, error: failure("CREDENTIAL_CONTEXT_INVALID", refId) };
    }

    const input = parsed.data;
    const context = validateProjectContext(session, input.locator);
    if (!context) return { ok: false, error: failure("CREDENTIAL_CONTEXT_INVALID", input.ref.id) };
    if (context.readOnly) {
      return { ok: false, error: failure("CREDENTIAL_READ_ONLY", input.ref.id) };
    }
    if (input.ref.policy !== SUPPORTED_POLICY) {
      return { ok: false, error: failure("CREDENTIAL_POLICY_UNSUPPORTED", input.ref.id) };
    }

    const scope = Object.freeze({ ...context.scope });
    const ref = Object.freeze({ id: input.ref.id, policy: input.ref.policy });
    try {
      const target = getSecretStore();
      const mutation = async (): Promise<void> => {
        if (operation === "put") await target.put(scope, ref, (input as CredentialPutInput).value);
        else await target.remove(scope, ref);
      };
      if (withCredentialMutationGuard === undefined) await mutation();
      else await withCredentialMutationGuard(scope, ref, mutation);
      return { ok: true };
    } catch (error) {
      const fallback = operation === "put" ? "CREDENTIAL_SAVE_FAILED" : "CREDENTIAL_REMOVE_FAILED";
      return { ok: false, error: credentialFailure(error, fallback, ref.id) };
    }
  }

  async function status(inputValue: unknown): Promise<CredentialStatusResult> {
    const parsed = CredentialRefInputSchema.safeParse(inputValue);
    const refId = parsed.success ? parsed.data.ref.id : suppliedRefId(inputValue);
    if (!parsed.success) return { ok: false, error: failure("CREDENTIAL_CONTEXT_INVALID", refId) };

    const { locator, ref: suppliedRef } = parsed.data;
    const context = validateProjectContext(session, locator);
    if (!context) return { ok: false, error: failure("CREDENTIAL_CONTEXT_INVALID", suppliedRef.id) };
    if (suppliedRef.policy !== SUPPORTED_POLICY) {
      return { ok: false, error: failure("CREDENTIAL_POLICY_UNSUPPORTED", suppliedRef.id) };
    }

    const scope = Object.freeze({ ...context.scope });
    const ref = Object.freeze({ id: suppliedRef.id, policy: suppliedRef.policy });
    try {
      const result = await getSecretStore().status(scope, ref);
      if (result === "available" || result === "missing" || result === "unavailable") return { ok: true, status: result };
      return { ok: false, error: failure("CREDENTIAL_UNAVAILABLE", ref.id) };
    } catch (error) {
      return { ok: false, error: credentialFailure(error, "CREDENTIAL_UNAVAILABLE", ref.id) };
    }
  }

  async function prepareRun(
    scopeValue: CredentialScope,
    snapshotValue: ProjectSnapshot,
    selectedAssetsValue: readonly DeepReadonly<ApiAsset>[],
  ): Promise<PreparedDesktopExecutionRun> {
    const parsedScope = ProjectLocatorSchema.safeParse(scopeValue);
    if (!parsedScope.success || !isSnapshot(snapshotValue) || !Array.isArray(selectedAssetsValue)
      || parsedScope.data.projectId !== snapshotValue.project.id) throw invalidPreparation();

    const allAssets = new Set<DeepReadonly<ApiAsset>>(collectSnapshotAssets(snapshotValue.project));
    for (const asset of selectedAssetsValue) {
      if (typeof asset !== "object" || asset === null || !allAssets.has(asset)
        || !ApiAssetSchema.safeParse(asset).success) throw invalidPreparation();
    }

    const capturedScope: CredentialScope = Object.freeze({ ...parsedScope.data });
    const selectedAssets = Object.freeze([...selectedAssetsValue]);
    for (const asset of selectedAssets) {
      const assetRefs = collectProjectCredentialRefs(snapshotValue.project, [asset]);
      const unsupported = assetRefs.find((ref) => ref.policy !== SUPPORTED_POLICY);
      if (unsupported) throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", unsupported.id);
    }

    const refs: SecretRef[] = collectProjectCredentialRefs(snapshotValue.project, selectedAssets).map((ref) => ({ id: ref.id, policy: ref.policy }));

    try {
      // Core returns immediately for an empty ref list before it reads the store argument.
      const bindings = await prepareCredentialBindings(capturedScope, refs, refs.length === 0 ? undefined as unknown as SecretStore : getSecretStore());
      const markers = collectCredentialOutputMarkers(snapshotValue.project, selectedAssets, bindings);
      const run: ProjectExecutionRun = Object.freeze({ snapshot: snapshotValue, credentialBindings: bindings });
      return { run, refs: Object.freeze(refs.map((ref) => Object.freeze({ ...ref }))), markers: Object.freeze([...markers]) };
    } catch (error) {
      const requestedRef = error instanceof CredentialError
        ? refs.find((ref) => ref.id === error.refId)?.id ?? refs[0]?.id ?? ""
        : refs[0]?.id ?? "";
      const failureCode = error instanceof CredentialError && credentialCodes.has(error.code)
        ? error.code
        : "CREDENTIAL_UNAVAILABLE";
      throw new CredentialError(failureCode, requestedRef);
    }
  }

  async function prepareRunForRequests(
    scopeValue: CredentialScope,
    snapshotValue: ProjectSnapshot,
    selectionsValue: readonly CredentialRequestSelection[],
    networkContext?: ExecutionNetworkContext,
  ): Promise<PreparedDesktopExecutionRun> {
    const parsedScope = ProjectLocatorSchema.safeParse(scopeValue);
    if (!parsedScope.success || !isSnapshot(snapshotValue) || !Array.isArray(selectionsValue)
      || parsedScope.data.projectId !== snapshotValue.project.id) throw invalidPreparation();

    let requests: ReturnType<typeof selectCredentialRequests>;
    try {
      requests = selectCredentialRequests(snapshotValue, selectionsValue);
    } catch {
      throw invalidPreparation();
    }
    const capturedScope: CredentialScope = Object.freeze({ ...parsedScope.data });
    for (const selected of requests) {
      const refs = collectCredentialRefsForRequests(snapshotValue.project, [selected]);
      const unsupported = refs.find((ref) => ref.policy !== SUPPORTED_POLICY);
      if (unsupported) throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", unsupported.id);
    }
    const refs: SecretRef[] = collectCredentialRefsForRequests(snapshotValue.project, requests)
      .map((ref) => ({ id: ref.id, policy: ref.policy }));

    // Network configuration/material errors have their own stable codes and must remain
    // distinguishable from SecretStore failures at the desktop execution boundary.
    const network = prepareNetwork === undefined
      ? undefined
      : await prepareNetwork(capturedScope, snapshotValue, networkContext ?? (() => { throw invalidPreparation(); })());
    const bearerRefs = collectBearerCredentialRefsForRequests(snapshotValue.project, requests);
    if (prepareOAuth !== undefined && bearerRefs.length > 0) {
      await prepareOAuth(capturedScope, bearerRefs, networkContext ?? (() => { throw invalidPreparation(); })(), network);
    }

    let bindings: Awaited<ReturnType<typeof prepareCredentialBindings>>;
    let markers: readonly string[];
    try {
      bindings = await prepareCredentialBindings(capturedScope, refs, refs.length === 0 ? undefined as unknown as SecretStore : getSecretStore());
      markers = collectCredentialMarkersForRequests(snapshotValue.project, requests, bindings);
    } catch (error) {
      const requestedRef = error instanceof CredentialError
        ? refs.find((ref) => ref.id === error.refId)?.id ?? refs[0]?.id ?? ""
        : refs[0]?.id ?? "";
      const failureCode = error instanceof CredentialError && credentialCodes.has(error.code)
        ? error.code
        : "CREDENTIAL_UNAVAILABLE";
      throw new CredentialError(failureCode, requestedRef);
    }
    const run: ProjectExecutionRun = Object.freeze({
      snapshot: snapshotValue,
      credentialBindings: bindings,
      ...(network === undefined ? {} : { network }),
    });
    return {
      run,
      refs: Object.freeze(refs.map((ref) => Object.freeze({ ...ref }))),
      markers: Object.freeze([...markers, ...(network?.outputMarkers ?? [])]),
      ...(network === undefined ? {} : { network }),
    };
  }

  async function getKnownCredentialLiterals(
    locatorValue: ApiLocator,
    candidateRequestValue: ApiRequest | readonly ApiRequest[],
    draftWriteContext: DraftWriteContext,
  ): Promise<readonly string[]> {
    session.assertDraftWriteContext(draftWriteContext);
    const candidateRequests: readonly ApiRequest[] = Array.isArray(candidateRequestValue)
      ? candidateRequestValue
      : [candidateRequestValue as ApiRequest];
    const locator = ProjectLocatorSchema.parse({
      workspaceId: locatorValue.workspaceId,
      groupId: locatorValue.groupId,
      projectId: locatorValue.projectId,
    });
    const location = session.locateApi(locatorValue);
    if (!location || location.project.id !== locator.projectId) throw new Error("The API context is unavailable for draft credential checks.");
    return getKnownCredentialLiteralsForProject(locator, candidateRequests, draftWriteContext);
  }

  async function getKnownCredentialLiteralsForProject(
    locatorValue: ProjectLocator,
    candidateRequestValue: ApiRequest | readonly ApiRequest[],
    draftWriteContext: DraftWriteContext,
  ): Promise<readonly string[]> {
    session.assertDraftWriteContext(draftWriteContext);
    const candidateRequests: readonly ApiRequest[] = Array.isArray(candidateRequestValue)
      ? candidateRequestValue
      : [candidateRequestValue as ApiRequest];
    const locator = ProjectLocatorSchema.parse(locatorValue);
    const location = session.locateProject(locator);
    if (!location || location.project.id !== locator.projectId || location.group.id !== locator.groupId) {
      throw new Error("The project context is unavailable for draft credential checks.");
    }
    const assets = collectSnapshotAssets(location.project);
    const selections = assets.flatMap((asset) => [
      { asset, request: asset.contract.request },
      ...asset.cases.map((testCase) => ({ asset, request: getEffectiveCaseRequest(asset, testCase) })),
    ]);
    const refs = new Map<string, SecretRef>();
    for (const ref of collectCredentialRefsForRequests(location.project, [
      ...selections,
    ])) refs.set(ref.id, ref);
    for (const ref of collectCredentialRefsFromRequestDrafts(location.project, candidateRequests)) {
      refs.set(ref.id, ref);
    }
    const supported = [...refs.values()].filter((ref) => ref.policy === SUPPORTED_POLICY);
    if (supported.length === 0) return [];
    const scope: CredentialScope = Object.freeze({ workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId });
    const store = getSecretStore();
    const literals = new Set<string>();
    for (const ref of supported) {
      try {
        const state = await store.status(scope, ref);
        session.assertDraftWriteContext(draftWriteContext);
        if (state !== "available") continue;
        const value = await store.resolve(scope, ref);
        session.assertDraftWriteContext(draftWriteContext);
        if (value.length > 0) literals.add(value);
      } catch {
        session.assertDraftWriteContext(draftWriteContext);
        // An unavailable secret is not a known literal; ordinary draft editing remains possible.
      }
    }
    return Object.freeze([...literals]);
  }

  return {
    put: (input: CredentialPutInput) => mutate(input, "put"),
    remove: (input: CredentialRefInput) => mutate(input, "remove"),
    status,
    prepareRun,
    prepareRunForRequests,
    getKnownCredentialLiterals,
    getKnownCredentialLiteralsForProject,
  };
}
