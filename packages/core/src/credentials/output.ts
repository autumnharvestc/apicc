import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import type { ApiAsset, ApiRequest, AuthBinding, InlineAuthBinding, SecretRef } from "../contract/model.js";
import type { ContractProject } from "../contract/workspace.js";
import type { CredentialBindings } from "./types.js";
import type { TestCase } from "../domain/common.js";
import { getEffectiveCaseRequest } from "../request/effective.js";

export interface EffectiveCredentialRequest {
  readonly asset: DeepReadonly<ApiAsset>;
  readonly request: DeepReadonly<ApiRequest>;
}

export interface CredentialRequestSelection {
  readonly asset: DeepReadonly<ApiAsset>;
  readonly testCase?: DeepReadonly<TestCase>;
}

export function selectCredentialRequests(
  snapshot: ProjectSnapshot,
  selections: readonly CredentialRequestSelection[],
): readonly EffectiveCredentialRequest[] {
  const assets = new Set(collectProjectApis(snapshot.project));
  return Object.freeze(selections.map(({ asset, testCase }) => {
    if (!assets.has(asset)) throw new TypeError("Credential request asset must belong to the supplied project snapshot.");
    if (testCase !== undefined && !asset.cases.some((candidate) => candidate === testCase)) {
      throw new TypeError("Credential request case must belong to the selected snapshot asset.");
    }
    const request = testCase === undefined ? asset.contract.request : getEffectiveCaseRequest(asset, testCase);
    return Object.freeze({ asset, request });
  }));
}

export interface CredentialOutputSanitizer {
  redactText(text: string): string;
  redactValue<T>(value: T): T;
}

export function collectProjectCredentialRefs(
  project: DeepReadonly<ContractProject>,
  selectedAssets: readonly DeepReadonly<ApiAsset>[],
): SecretRef[] {
  return collectCredentialRefsForRequests(project, selectedAssets.map((asset) => ({ asset, request: asset.contract.request })));
}

export function collectCredentialRefsForRequests(
  project: DeepReadonly<ContractProject>,
  requests: readonly EffectiveCredentialRequest[],
): SecretRef[] {
  return collectCredentialRefsFromRequestDrafts(project, requests.map((selected) => selected.request));
}

/** Collect only selected effective Bearer refs for pre-binding OAuth coordination. */
export function collectBearerCredentialRefsForRequests(
  project: DeepReadonly<ContractProject>,
  requests: readonly EffectiveCredentialRequest[],
): SecretRef[] {
  const refs = new Map<string, SecretRef>();
  for (const selected of requests) {
    const auth = inlineAuth(project, selected.request.auth);
    if (auth?.kind === "bearer") refs.set(auth.token.id, { ...auth.token });
  }
  return [...refs.values()];
}

/** Collect refs from unsaved requests without requiring a fabricated owning ApiAsset. */
export function collectCredentialRefsFromRequestDrafts(
  project: DeepReadonly<ContractProject>,
  requests: readonly DeepReadonly<ApiRequest>[],
): SecretRef[] {
  const refs = new Map<string, SecretRef>();
  for (const request of requests) {
    const auth = inlineAuth(project, request.auth);
    if (auth) collectAuthRefs(auth, refs);
  }
  return [...refs.values()];
}

export function collectCredentialOutputMarkers(
  project: DeepReadonly<ContractProject>,
  selectedAssets: readonly DeepReadonly<ApiAsset>[],
  preparedBindings: CredentialBindings,
): string[] {
  return collectCredentialMarkersForRequests(
    project,
    selectedAssets.map((asset) => ({ asset, request: asset.contract.request })),
    preparedBindings,
  );
}

export function collectCredentialMarkersForRequests(
  project: DeepReadonly<ContractProject>,
  requests: readonly EffectiveCredentialRequest[],
  preparedBindings: CredentialBindings,
): string[] {
  const markers: string[] = [];
  const add = (value: string): void => {
    if (value.length > 0) markers.push(value);
  };

  for (const ref of collectCredentialRefsForRequests(project, requests)) {
    add(preparedBindings.resolve(ref));
  }

  for (const selected of requests) {
    const auth = inlineAuth(project, selected.request.auth);
    if (!auth) continue;
    switch (auth.kind) {
      case "none":
        break;
      case "bearer": {
        const token = preparedBindings.resolve(auth.token);
        add(`Bearer ${token}`);
        break;
      }
      case "basic": {
        const password = preparedBindings.resolve({ id: auth.password.id, policy: auth.password.policy });
        add(`Basic ${Buffer.from(`${auth.username}:${password}`, "utf8").toString("base64")}`);
        break;
      }
      case "apikey": {
        const value = preparedBindings.resolve(auth.value);
        if (auth.placement === "query") add(encodeURIComponent(value));
        break;
      }
    }
  }

  return markers;
}

function collectProjectApis(project: DeepReadonly<ContractProject>): DeepReadonly<ApiAsset>[] {
  const assets: DeepReadonly<ApiAsset>[] = [];
  for (const collection of project.collections) {
    assets.push(...collection.apis);
    for (const folder of collection.folders) collectFolderApis(folder, assets);
  }
  return assets;
}

function collectFolderApis(
  folder: DeepReadonly<ContractProject["collections"][number]["folders"][number]>,
  assets: DeepReadonly<ApiAsset>[],
): void {
  assets.push(...folder.apis);
  for (const child of folder.folders) collectFolderApis(child, assets);
}

export function createCredentialOutputSanitizer(markers: readonly string[]): CredentialOutputSanitizer {
  const uniqueMarkers = [...new Set(markers.filter((marker) => marker.length > 0))]
    .sort((left, right) => right.length - left.length);
  const redactText = (text: string): string => {
    let result = redactBasicAuthorization(text, uniqueMarkers);
    for (const marker of uniqueMarkers) result = result.replaceAll(marker, "[REDACTED]");
    return result;
  };
  const redactValue = <T>(value: T): T => sanitize(value, redactText, new WeakMap<object, unknown>()) as T;
  return {
    redactText,
    redactValue,
  };
}

function inlineAuth(
  project: DeepReadonly<ContractProject>,
  binding: DeepReadonly<AuthBinding>,
): DeepReadonly<InlineAuthBinding> | undefined {
  if (binding.kind !== "componentRef") return binding;
  const component = project.components.find((candidate) => candidate.id === binding.componentId && candidate.kind === "auth");
  return component?.kind === "auth" ? component.definition : undefined;
}

function collectAuthRefs(auth: DeepReadonly<InlineAuthBinding>, refs: Map<string, SecretRef>): void {
  const add = (ref: DeepReadonly<SecretRef>): void => {
    refs.set(ref.id, { ...ref });
  };
  switch (auth.kind) {
    case "none":
      return;
    case "bearer":
      add(auth.token);
      return;
    case "basic":
      add(auth.password);
      return;
    case "apikey":
      add(auth.value);
  }
}

function redactBasicAuthorization(text: string, markers: readonly string[]): string {
  if (markers.length === 0) return text;
  const basicMarkers = markers.map((marker) => Buffer.from(marker, "utf8").toString("utf8"));
  return text.replace(/\bBasic\s+([A-Za-z0-9+/]+={0,2})/gi, (header, encoded: string) => {
    const bytes = Buffer.from(encoded, "base64");
    const decoded = bytes.toString("utf8");
    const canonical = bytes.toString("base64").replace(/=+$/, "");
    if (canonical !== encoded.replace(/=+$/, "")) return header;
    return basicMarkers.some((marker) => decoded.endsWith(`:${marker}`)) ? "[REDACTED]" : header;
  });
}

function sanitize(value: unknown, redactText: (text: string) => string, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(sanitize(item, redactText, seen));
    return copy;
  }
  const copy = Object.create(null) as Record<string, unknown>;
  seen.set(value, copy);
  for (const [key, nested] of Object.entries(value)) {
    Object.defineProperty(copy, redactText(key), {
      value: sanitize(nested, redactText, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}
