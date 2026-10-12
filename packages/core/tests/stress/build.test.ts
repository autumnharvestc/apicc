import { describe, expect, it } from "vitest";
import { createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ApiAsset } from "../../src/contract/model.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import { createVariableResolver } from "../../src/index.js";
import type { AuthProvider } from "../../src/plugin/types.js";
import { buildStressRequest } from "../../src/stress/build.js";
import type { VariableResolver } from "../../src/variables/resolver.js";

const contractId = "10000000-0000-4000-8000-000000000021";
const credentialId = "credential-ref";

function asset(request: ApiAsset["contract"]["request"]): ApiAsset {
  return {
    contract: {
      formatVersion: 1, id: contractId,
      metadata: { name: "下单", description: "", tags: [], version: "1", status: "draft" },
      request, responses: [],
    },
    cases: [], documentation: "",
  };
}

function contextFor(api: ApiAsset) {
  const project: ContractProject = createContractExecutionProject("http://s");
  project.collections[0]!.folders[0]!.folders[0]!.apis[0] = api;
  const snapshot = createProjectSnapshot(project);
  return { asset: snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!, context: snapshot.context };
}

function bindings() {
  return { resolve: () => "credential-value", versions: { [credentialId]: "v1" } };
}

function resolver(values: Record<string, string> = {}): VariableResolver {
  return createVariableResolver({ layers: [{ baseUrl: "http://s", hid: "h1", n: "7", tok: "t", ...values }] });
}

const emptyBindings = { pathParams: [], query: [], headers: [], cookies: [] };

describe("buildStressRequest delegates contract assembly to materializeRequest", () => {
  it("resolves contract values and applies a provider to the materialized auth DTO", () => {
    const source = asset({
      protocol: "http", method: "POST", baseUrl: "{{baseUrl}}", path: "/orders", ...emptyBindings,
      auth: { kind: "bearer", token: { id: credentialId, policy: "test-auto" } },
      body: { kind: "json", content: '{"n":{{n}}}' },
    });
    const selected = contextFor(source);
    const applied: string[] = [];
    const providers: AuthProvider[] = [{
      type: "bearer",
      apply(request, auth) { applied.push("bearer"); if (auth.kind === "bearer") request.headers.Authorization = `Bearer ${auth.token}`; },
    }];
    const request = buildStressRequest(selected.asset, selected.context, bindings(), resolver(), providers);
    expect(request).toMatchObject({ protocol: "http", method: "POST", url: "http://s/orders", headers: { Authorization: "Bearer credential-value" }, body: { kind: "json", content: '{"n":7}' } });
    expect(applied).toEqual(["bearer"]);
  });

  it("uses the sole parameter materializer and preserves disabled query state", () => {
    const source = asset({
      protocol: "http", method: "GET", baseUrl: "{{baseUrl}}", path: "/orders", ...emptyBindings,
      auth: { kind: "none" }, body: { kind: "none" },
      headers: [
        { kind: "inline", id: "10000000-0000-4000-8000-000000000024", name: "X-On", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "1" },
        { kind: "inline", id: "10000000-0000-4000-8000-000000000025", name: "X-Off", schema: { kind: "scalar", type: "string" }, required: false, enabled: false, description: "", value: "0" },
      ],
      query: [
        { kind: "inline", id: "10000000-0000-4000-8000-000000000026", name: "page", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "{{p}}" },
        { kind: "inline", id: "10000000-0000-4000-8000-000000000027", name: "skip", schema: { kind: "scalar", type: "string" }, required: false, enabled: false, description: "", value: "x" },
      ],
    });
    const selected = contextFor(source);
    const request = buildStressRequest(selected.asset, selected.context, bindings(), resolver({ p: "2" }), []);
    expect(request.headers).toEqual({ "X-On": "1" });
    expect(request.query).toEqual([
      { key: "page", value: "2", enabled: true },
      { key: "skip", value: "", enabled: false },
    ]);
  });

  it("does not apply any auth provider for none auth", () => {
    const applied: string[] = [];
    const source = asset({ protocol: "http", method: "GET", baseUrl: "http://s", path: "/", ...emptyBindings, auth: { kind: "none" }, body: { kind: "none" } });
    const selected = contextFor(source);
    const providers: AuthProvider[] = [
      { type: "basic", apply: () => void applied.push("basic") },
      { type: "apikey", apply: () => void applied.push("apikey") },
    ];
    const request = buildStressRequest(selected.asset, selected.context, bindings(), resolver(), providers);
    expect(request.auth).toEqual({ kind: "none" });
    expect(applied).toEqual([]);
  });

  it("materializes enabled form fields and excludes disabled entries", () => {
    const source = asset({
      protocol: "http", method: "POST", baseUrl: "http://s", path: "/", ...emptyBindings, auth: { kind: "none" },
      body: { kind: "urlencoded", fields: [
        { id: "10000000-0000-4000-8000-000000000028", name: "u", value: "{{u}}", enabled: true },
        { id: "10000000-0000-4000-8000-000000000029", name: "x", value: "{{v2}}", enabled: false },
      ] },
    });
    const selected = contextFor(source);
    const request = buildStressRequest(selected.asset, selected.context, bindings(), resolver({ u: "a", v2: "b" }), []);
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("fixture should materialize as HTTP");
    expect(request).toMatchObject({ protocol: "http", body: { kind: "form", form: [
      { key: "u", value: "a", enabled: true },
    ] } });
    expect(request.body?.kind === "form" && request.body.form.some(({ key }) => key === "x")).toBe(false);
  });
});
