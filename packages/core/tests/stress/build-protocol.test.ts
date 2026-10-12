import { describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ApiAsset } from "../../src/contract/model.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import { createVariableResolver } from "../../src/variables/resolver.js";
import { buildStressRequest } from "../../src/stress/build.js";
import { createContractExecutionProject, contractExecutionIds } from "../helpers/contractExecutionFixtures.js";

const emptyBindings = { pathParams: [], query: [], headers: [], cookies: [] };
const bindings = { resolve: () => "credential-value", versions: {} };

function selectAsset(request: ApiAsset["contract"]["request"]) {
  const asset: ApiAsset = {
    contract: {
      formatVersion: 1,
      id: contractExecutionIds.contract,
      metadata: { name: "stress-protocol", description: "", tags: [], version: "1", status: "draft" },
      request,
      responses: [],
    },
    cases: [],
    documentation: "",
  };
  const project: ContractProject = createContractExecutionProject("http://s");
  project.collections[0]!.folders[0]!.folders[0]!.apis[0] = asset;
  const snapshot = createProjectSnapshot(project);
  return { asset: snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!, context: snapshot.context };
}

function build(request: ApiAsset["contract"]["request"], baseUrl: string, values: Record<string, string> = {}) {
  const selected = selectAsset(request);
  const resolver = createVariableResolver({ layers: [{ baseUrl, who: "m5", ...values }] });
  return buildStressRequest(selected.asset, selected.context, bindings, resolver, []);
}

describe("buildStressRequest protocol union delegates to canonical materializer", () => {
  it("websocket: discriminant and message template resolve without HTTP/SOAP fields", () => {
    const request = build({
      protocol: "websocket", baseUrl: "{{baseUrl}}", path: "/rt", ...emptyBindings,
      auth: { kind: "none" }, message: '{"who":"{{who}}"}',
    }, "ws://s");
    expect(request).toMatchObject({ protocol: "websocket", url: "ws://s/rt", message: '{"who":"m5"}' });
    expect("method" in request).toBe(false);
    expect("body" in request).toBe(false);
    expect("envelope" in request).toBe(false);
  });

  it("soap: envelope and action resolve on the strict POST variant", () => {
    const request = build({
      protocol: "soap", method: "POST", baseUrl: "{{baseUrl}}", path: "/soap", ...emptyBindings,
      auth: { kind: "none" }, envelope: '<AddUser name="{{who}}"/>', soapAction: "urn:add",
    }, "http://s");
    expect(request).toMatchObject({ protocol: "soap", method: "POST", url: "http://s/soap", envelope: '<AddUser name="m5"/>', soapAction: "urn:add" });
    expect("body" in request).toBe(false);
    expect("message" in request).toBe(false);
  });

  it("http: protocol stays explicit and protocol-specific fields do not leak", () => {
    const request = build({
      protocol: "http", method: "GET", baseUrl: "{{baseUrl}}", path: "/x", ...emptyBindings,
      auth: { kind: "none" }, body: { kind: "none" },
    }, "http://s");
    expect(request).toMatchObject({ protocol: "http", method: "GET", url: "http://s/x" });
    expect("message" in request).toBe(false);
    expect("envelope" in request).toBe(false);
  });
});
