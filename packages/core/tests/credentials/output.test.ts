import { describe, expect, it } from "vitest";

import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { DeepReadonly } from "../../src/assets/snapshot.js";
import type { ApiAsset, ApiRequest, AuthBinding, ComponentAsset, SecretRef } from "../../src/contract/model.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import type { CredentialBindings } from "../../src/credentials/types.js";
import {
  collectCredentialMarkersForRequests,
  collectCredentialOutputMarkers,
  collectCredentialRefsForRequests,
  collectCredentialRefsFromRequestDrafts,
  collectProjectCredentialRefs,
  createCredentialOutputSanitizer,
  selectCredentialRequests,
} from "../../src/credentials/output.js";
import { collectDefinedProjectCredentialRefs } from "../../src/assets/secretRefs.js";
import { createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";

const componentId = "20000000-0000-4000-8000-000000000001";
const unusedComponentId = "20000000-0000-4000-8000-000000000002";

describe("shared credential output", () => {
  it("collects credential refs from free request drafts without inventing an owning API asset", () => {
    const project = createContractExecutionProject("https://service.example.test");
    const authComponent: ComponentAsset = {
      formatVersion: 1,
      id: componentId,
      name: "free request auth",
      description: "",
      kind: "auth",
      definition: { kind: "bearer", token: { id: "free-auth-ref", policy: "test-auto" } },
    };
    project.components = [authComponent];
    const request = structuredClone(project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.request);
    request.auth = { kind: "componentRef", componentId, expectedKind: "auth" };

    expect(collectCredentialRefsFromRequestDrafts(project, [request])).toEqual([
      { id: "free-auth-ref", policy: "test-auto" },
    ]);
  });

  it("selects only snapshot-owned effective case requests for credential refs and markers", () => {
    const project = createContractExecutionProject("https://service.example.test");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.auth = { kind: "bearer", token: { id: "default-ref", policy: "test-auto" } };
    const baseCase = asset.cases[0]!;
    asset.cases = [
      {
        ...baseCase,
        id: "selected-case",
        requestOverride: { ...asset.contract.request, auth: { kind: "bearer", token: { id: "selected-ref", policy: "test-auto" } } },
      },
      {
        ...baseCase,
        id: "unselected-case",
        requestOverride: { ...asset.contract.request, auth: { kind: "bearer", token: { id: "unselected-ref", policy: "test-auto" } } },
      },
    ];
    project.components = [{
      formatVersion: 1,
      id: "20000000-0000-4000-8000-000000000003",
      name: "unreferenced auth",
      description: "",
      kind: "auth",
      definition: { kind: "bearer", token: { id: "component-ref", policy: "test-auto" } },
    }];
    const snapshot = createProjectSnapshot(project);
    const snapshotAsset = snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const selected = selectCredentialRequests(snapshot, [{ asset: snapshotAsset, testCase: snapshotAsset.cases[0]! }]);

    expect(selected[0]!.request).toBe(snapshotAsset.cases[0]!.requestOverride);
    expect(collectCredentialRefsForRequests(snapshot.project, selected)).toEqual([{ id: "selected-ref", policy: "test-auto" }]);
    expect(collectDefinedProjectCredentialRefs(snapshot.project)).toEqual([
      { id: "default-ref", policy: "test-auto" },
      { id: "selected-ref", policy: "test-auto" },
      { id: "unselected-ref", policy: "test-auto" },
      { id: "component-ref", policy: "test-auto" },
    ]);

    const resolved: string[] = [];
    const bindings: CredentialBindings = {
      resolve(ref) { resolved.push(ref.id); return `secret:${ref.id}`; },
      versions: {},
    };
    expect(collectCredentialMarkersForRequests(snapshot.project, selected, bindings)).toEqual([
      "secret:selected-ref",
      "Bearer secret:selected-ref",
    ]);
    expect(resolved).toEqual(["selected-ref", "selected-ref"]);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(() => (selected as unknown as unknown[]).pop()).toThrow(TypeError);
    expect(() => selectCredentialRequests(snapshot, [{ asset: structuredClone(snapshotAsset) }])).toThrow(/snapshot/);
    expect(() => selectCredentialRequests(snapshot, [{ asset: snapshotAsset, testCase: structuredClone(snapshotAsset.cases[0]!) }])).toThrow(/selected snapshot asset/);
  });

  it("collects refs only from selected HTTP, WebSocket, and SOAP auth, deduping aliases without mutating readonly inputs", () => {
    const project = createContractExecutionProject("https://service.example.test");
    const baseAsset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const components: ComponentAsset[] = [
      {
        formatVersion: 1,
        id: componentId,
        name: "selected auth",
        description: "",
        kind: "auth",
        definition: { kind: "bearer", token: { id: "shared-ref", policy: "test-auto" } },
      },
      {
        formatVersion: 1,
        id: unusedComponentId,
        name: "unused auth",
        description: "",
        kind: "auth",
        definition: { kind: "basic", username: "unused", password: { id: "unused-component-ref", policy: "test-auto" } },
      },
    ];
    project.components = components;

    const directAssets = [
      apiWithAuth(baseAsset, 1, "http", { kind: "bearer", token: { id: "__proto__", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 2, "http", { kind: "basic", username: "alice", password: { id: "凭据-🔑", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 3, "websocket", { kind: "apikey", name: "q", placement: "query", value: { id: "query-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 4, "soap", { kind: "apikey", name: "X-Key", placement: "header", value: { id: "header-ref", policy: "test-auto" } }),
    ];
    const deepAssets = [
      apiWithAuth(baseAsset, 5, "http", { kind: "componentRef", componentId, expectedKind: "auth" }),
      apiWithAuth(baseAsset, 6, "soap", { kind: "bearer", token: { id: "shared-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 7, "websocket", { kind: "none" }),
      apiWithAuth(baseAsset, 8, "http", { kind: "bearer", token: { id: "not-selected-ref", policy: "test-auto" } }),
    ];
    project.collections[0]!.apis = directAssets;
    project.collections[0]!.folders[0]!.folders[0]!.apis = deepAssets;
    const before = structuredClone(project);
    const snapshot = createProjectSnapshot(project);
    const selectedAssets = [
      ...snapshot.project.collections[0]!.apis,
      ...snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis.slice(0, 3),
    ];

    const refs = collectProjectCredentialRefs(snapshot.project, selectedAssets);

    expect(refs).toEqual([
      { id: "__proto__", policy: "test-auto" },
      { id: "凭据-🔑", policy: "test-auto" },
      { id: "query-ref", policy: "test-auto" },
      { id: "header-ref", policy: "test-auto" },
      { id: "shared-ref", policy: "test-auto" },
    ]);
    expect(refs[0]).not.toBe(selectedAssets[0]!.contract.request.auth.kind === "bearer"
      ? selectedAssets[0]!.contract.request.auth.token
      : undefined);
    expect(refs[4]).not.toBe(snapshot.project.components[0]!.kind === "auth"
      ? snapshot.project.components[0]!.definition.kind === "bearer" ? snapshot.project.components[0]!.definition.token : undefined
      : undefined);
    expect(refs.map((ref) => ref.id)).not.toContain("unused-component-ref");
    expect(refs.map((ref) => ref.id)).not.toContain("not-selected-ref");
    expect(project).toEqual(before);
  });

  it("collects raw and rendered markers from prepared bindings and does not resolve empty auth", () => {
    const project = createContractExecutionProject("https://service.example.test");
    const baseAsset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const assets = [
      apiWithAuth(baseAsset, 11, "http", { kind: "bearer", token: { id: "bearer-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 12, "http", { kind: "basic", username: "dynamic:user", password: { id: "password-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 13, "websocket", { kind: "apikey", name: "key", placement: "query", value: { id: "query-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 14, "soap", { kind: "apikey", name: "X-Key", placement: "header", value: { id: "header-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 15, "http", { kind: "none" }),
    ];
    project.collections[0]!.apis = assets;
    const snapshot = createProjectSnapshot(project);
    const selectedAssets = snapshot.project.collections[0]!.apis;
    const values = new Map([
      ["bearer-ref", "bearer secret"],
      ["password-ref", "päss🔐"],
      ["query-ref", "q +/雪"],
      ["header-ref", "header secret"],
    ]);
    const resolved: string[] = [];
    const bindings: CredentialBindings = {
      resolve(ref) {
        resolved.push(ref.id);
        const value = values.get(ref.id);
        if (value === undefined) throw new Error(`Unexpected ref ${ref.id}`);
        return value;
      },
      versions: {},
    };

    const markers = collectCredentialOutputMarkers(snapshot.project, selectedAssets, bindings);

    expect(markers).toEqual([
      "bearer secret",
      "päss🔐",
      "q +/雪",
      "header secret",
      "Bearer bearer secret",
      "Basic ZHluYW1pYzp1c2VyOnDDpHNz8J+UkA==",
      "q%20%2B%2F%E9%9B%AA",
    ]);
    expect(resolved).toEqual([
      "bearer-ref", "password-ref", "query-ref", "header-ref",
      "bearer-ref", "password-ref", "query-ref", "header-ref",
    ]);

    const emptyProject = createContractExecutionProject("https://service.example.test");
    const emptyBaseAsset = emptyProject.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    emptyProject.collections[0]!.apis = [apiWithAuth(emptyBaseAsset, 16, "http", { kind: "none" })];
    const emptySnapshot = createProjectSnapshot(emptyProject);
    let emptyResolves = 0;
    const emptyBindings: CredentialBindings = {
      resolve() {
        emptyResolves += 1;
        throw new Error("No credentials should be resolved");
      },
      versions: {},
    };
    expect(collectCredentialOutputMarkers(emptySnapshot.project, emptySnapshot.project.collections[0]!.apis, emptyBindings)).toEqual([]);
    expect(emptyResolves).toBe(0);
  });

  it("preserves a selected credential ref with an empty ID through collection and output markers", () => {
    const project = createContractExecutionProject("https://service.example.test");
    const baseAsset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    project.collections[0]!.apis = [apiWithAuth(baseAsset, 21, "http", {
      kind: "bearer",
      token: { id: "", policy: "test-auto" },
    })];
    const projectBefore = structuredClone(project);
    const snapshot = createProjectSnapshot(project);
    const snapshotBefore = structuredClone(snapshot.project);
    const selectedAssets = snapshot.project.collections[0]!.apis;
    const auth = selectedAssets[0]!.contract.request.auth;
    if (auth.kind !== "bearer") throw new Error("Expected the selected fixture to use bearer auth.");

    const refs = collectProjectCredentialRefs(snapshot.project, selectedAssets);

    expect(refs).toEqual([{ id: "", policy: "test-auto" }]);
    expect(refs[0]).not.toBe(auth.token);

    const resolved: SecretRef[] = [];
    const preparedBindings: CredentialBindings = {
      resolve(ref) {
        resolved.push({ ...ref });
        if (ref.id !== "") throw new Error(`Unexpected ref ${ref.id}`);
        return "empty-id-secret";
      },
      versions: {},
    };
    const markers = collectCredentialOutputMarkers(snapshot.project, selectedAssets, preparedBindings);

    expect(markers).toEqual(["empty-id-secret", "Bearer empty-id-secret"]);
    expect(resolved).toEqual([
      { id: "", policy: "test-auto" },
      { id: "", policy: "test-auto" },
    ]);
    expect(snapshot.project).toEqual(snapshotBefore);
    expect(project).toEqual(projectBefore);
  });

  it("redacts longest raw markers and canonical Basic headers in nested projections while preserving types and cycles", () => {
    const secret = "short-token";
    const longerSecret = "short-token with suffix";
    const malformedPassword = `replacement-${String.fromCharCode(0xd800)}`;
    const sanitizer = createCredentialOutputSanitizer([secret, longerSecret, "bb", "päss🔐", malformedPassword]);
    const basic = "Basic ZHluYW1pYzp1c2VyOnDDpHNz8J+UkA==";
    const replacementBasic = "Basic dXNlcjpyZXBsYWNlbWVudC3vv70=";
    const text = `keep this ${secret} and ${longerSecret}; ${basic}; ${replacementBasic}; Basic YTpiYh==`;

    expect(sanitizer.redactText(text)).toBe(
      `keep this [REDACTED] and [REDACTED]; [REDACTED]; [REDACTED]; Basic YTpiYh==`,
    );
    expect(sanitizer.redactText("unrelated text and Basic YTpiYg==")).toBe("unrelated text and [REDACTED]");

    const source: Record<string, unknown> = {};
    const nested: unknown[] = [source, `value ${secret}`, 42, null, true];
    source[`token:${secret}`] = nested;
    source.self = source;
    const projected = sanitizer.redactValue(source) as Record<string, unknown>;
    const projectedNested = projected["token:[REDACTED]"] as unknown[];

    expect(projected).not.toBe(source);
    expect(projectedNested).not.toBe(nested);
    expect(projectedNested[0]).toBe(projected);
    expect(projectedNested.slice(1)).toEqual(["value [REDACTED]", 42, null, true]);
    expect(projected.self).toBe(projected);
    expect(source[`token:${secret}`]).toBe(nested);
    expect(nested[1]).toBe(`value ${secret}`);
  });
});

function apiWithAuth(
  baseAsset: ApiAsset,
  ordinal: number,
  protocol: "http" | "websocket" | "soap",
  auth: AuthBinding,
): ApiAsset {
  const common = {
    baseUrl: "https://service.example.test",
    path: "/items",
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth,
  };
  let request: ApiRequest;
  if (protocol === "http") {
    request = { ...common, protocol, method: "GET", body: { kind: "none" } };
  } else if (protocol === "websocket") {
    request = { ...common, protocol };
  } else {
    request = { ...common, protocol, method: "POST", envelope: "<Envelope/>" };
  }
  return {
    ...baseAsset,
    contract: {
      ...baseAsset.contract,
      id: `20000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`,
      request,
    },
  };
}
