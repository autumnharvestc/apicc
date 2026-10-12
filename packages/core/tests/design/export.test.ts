import { describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { DeepReadonly, ProjectAssetContextReadView } from "../../src/assets/context.js";
import type { ApiAsset } from "../../src/contract/model.js";
import { ContractProjectSchema, type ContractProject } from "../../src/contract/workspace.js";
import { renderDesignMarkdown } from "../../src/design/export.js";
import { contractExecutionIds, createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";

type SnapshotRenderer = (asset: DeepReadonly<ApiAsset>, context: ProjectAssetContextReadView) => string;
const renderSnapshot = renderDesignMarkdown as unknown as SnapshotRenderer;

function makeProject() {
  const project: ContractProject = createContractExecutionProject("https://api.example.com/v1");
  const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
  asset.contract.metadata.name = "create-order";
  asset.contract.metadata.version = "1.2.0";
  asset.documentation = "# 业务规则\n- 库存不足时返回 409";
  asset.cases.push({
    ...asset.cases[0]!,
    id: "case-conflict",
    name: "conflict",
    scope: "sit",
    assertions: [{ id: "assertion-conflict", target: "status", op: "eq", expected: "409" }],
  });
  project.models = [{
    formatVersion: 1,
    id: "10000000-0000-4000-8000-000000000009",
    name: "OrderPayload",
    description: "Request model from the same project snapshot.",
    schema: { kind: "object", properties: { sku: { kind: "scalar", type: "string" } }, required: ["sku"], additionalProperties: false },
  }];
  const request = asset.contract.request;
  if (request.protocol !== "http") throw new Error("Expected the HTTP fixture.");
  request.body = {
    kind: "json",
    content: '{"sku":"A1","password":"imported-secret"}',
    schema: { kind: "modelRef", modelId: project.models[0]!.id },
  };
  return project;
}

function snapshotAsset(project: ContractProject): { asset: DeepReadonly<ApiAsset>; context: ProjectAssetContextReadView } {
  const validation = ContractProjectSchema.safeParse(project);
  if (!validation.success) throw new Error(JSON.stringify(validation.error.issues));
  const snapshot = createProjectSnapshot(project);
  const asset = snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
  return { asset, context: snapshot.context };
}

function addLegacyShape(asset: DeepReadonly<ApiAsset>): DeepReadonly<ApiAsset> {
  const request = asset.contract.request;
  const path = request.path;
  const baseUrl = request.baseUrl;
  const method = request.protocol === "http" || request.protocol === "soap" ? request.method : "GET";
  const body = request.protocol === "http" ? request.body : undefined;
  return Object.assign({}, asset, {
    name: asset.contract.metadata.name,
    version: asset.contract.metadata.version,
    deprecated: asset.contract.metadata.status === "deprecated",
    method,
    url: `${baseUrl}${path}`,
    headers: [],
    query: [],
    body: body?.kind === "json" ? { kind: "json", content: body.content } : undefined,
    design: asset.documentation,
    protocol: request.protocol,
    ...(request.protocol === "websocket" ? { message: request.message } : {}),
    ...(request.protocol === "soap" ? { envelope: request.envelope, soapAction: request.soapAction } : {}),
  }) as unknown as DeepReadonly<ApiAsset>;
}

describe("renderDesignMarkdown", () => {
  it("renders contract and referenced model data from one snapshot, documents cases, and masks credentials", () => {
    const project = makeProject();
    const { asset, context } = snapshotAsset(project);
    const markdown = renderSnapshot(addLegacyShape(asset), context);

    expect(markdown).toContain("create-order");
    expect(markdown).toContain("POST");
    expect(markdown).toContain("Base URL: {{baseUrl}}");
    expect(markdown).toContain("Path: /{{folderPath}}/items");
    expect(markdown).toContain("1.2.0");
    expect(markdown).toContain("OrderPayload");
    expect(markdown).toContain("业务规则");
    expect(markdown).toContain("snapshot-case");
    expect(markdown).toContain("conflict");
    expect(markdown).not.toContain("imported-secret");
    expect(markdown).not.toContain(contractExecutionIds.credential);
  });
});

describe("renderDesignMarkdown 多协议", () => {
  it("websocket uses the snapshot message template", () => {
    const project = makeProject();
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request = {
      protocol: "websocket", baseUrl: "{{wsUrl}}", path: "/rt",
      pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, message: '{"ping":1}',
    };
    const snapshot = snapshotAsset(project);
    const markdown = renderSnapshot(Object.assign(addLegacyShape(snapshot.asset), { message: "legacy-stale-message" }), snapshot.context);
    expect(markdown).toContain("WEBSOCKET");
    expect(markdown).toContain('{"ping":1}');
    expect(markdown).not.toContain("legacy-stale-message");
    expect(markdown).not.toContain("Protocol: http");
  });

  it("soap uses the snapshot envelope and SOAPAction", () => {
    const project = makeProject();
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request = {
      protocol: "soap", method: "POST", baseUrl: "{{baseUrl}}", path: "/soap",
      pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" },
      envelope: "<Envelope/>", soapAction: "urn:add",
    };
    const snapshot = snapshotAsset(project);
    const markdown = renderSnapshot(Object.assign(addLegacyShape(snapshot.asset), { envelope: "<LegacyEnvelope/>", soapAction: "urn:stale" }), snapshot.context);
    expect(markdown).toContain("soap");
    expect(markdown).toContain("<Envelope/>");
    expect(markdown).toContain("SOAPAction: urn:add");
    expect(markdown).not.toContain("LegacyEnvelope");
    expect(markdown).not.toContain("urn:stale");
  });
});
