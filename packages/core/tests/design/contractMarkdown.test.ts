import { describe, expect, it } from "vitest";

import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { contractAiView } from "../../src/ai/contractView.js";
import { renderContractMarkdown } from "../../src/design/contractMarkdown.js";
import { parseContractCollection21 } from "../../src/import/contractCollection21.js";
import { parseContractOpenapi } from "../../src/import/contractOpenapi.js";
import { designDocumentIds, projectionProject } from "../helpers/designDocumentFixture.js";

const { contract: contractId, model: modelId, parameterComponent: parameterComponentId } = designDocumentIds;

describe("contract-derived views", () => {
  it("renders a read-only snapshot with reference IDs and masks common credential fields in Markdown and AI output", () => {
    const project = projectionProject();
    const snapshot = createProjectSnapshot(project);
    const asset = snapshot.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the snapshot API asset.");

    const markdown = renderContractMarkdown(asset, snapshot.context);
    const aiView = contractAiView(asset, snapshot.context);
    const combined = `${markdown}\n${JSON.stringify(aiView)}`;

    expect(markdown).toContain(contractId);
    expect(markdown).toContain(modelId);
    expect(JSON.stringify(aiView)).toContain(parameterComponentId);
    expect(combined).not.toContain("synthetic-import-token");
    expect(aiView).toMatchObject({
      contractId,
      request: { auth: { kind: "bearer", placeholder: "****" } },
    });
    expect(JSON.stringify(aiView)).toContain("related");
    expect(JSON.stringify(aiView)).toContain("modelId");
    expect(snapshot.project.collections[0]?.apis[0]?.contract.request).toMatchObject({
      protocol: "http",
      body: { kind: "json", content: '{"password":"synthetic-import-token","profile":"visible"}' },
    });
  });

  it("limits referenced authentication output to its type and masked placeholder", () => {
    const imported = parseContractOpenapi({
      openapi: "3.0.3",
      info: { title: "Auth fixture", version: "1" },
      paths: { "/items": { get: { security: [{ QueryKey: [] }], responses: {} } } },
      components: { securitySchemes: { QueryKey: { type: "apiKey", in: "query", name: "subscription-key" } } },
    });
    const snapshot = createProjectSnapshot(imported.project);
    const asset = snapshot.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the API-key fixture asset.");

    const aiView = contractAiView(asset, snapshot.context);
    const markdown = renderContractMarkdown(asset, snapshot.context);
    expect(aiView.request.auth).toEqual({ kind: "apikey", placeholder: "****" });
    expect(markdown).toContain("Authentication: apikey (****)");
    expect(JSON.stringify(aiView)).not.toContain("subscription-key");
    expect(JSON.stringify(aiView)).not.toContain("SecretRef");
    const authComponent = imported.project.components.find((component) => component.kind === "auth");
    if (!authComponent || authComponent.kind !== "auth" || authComponent.definition.kind !== "apikey") throw new Error("Expected the API-key auth component.");
    expect(JSON.stringify(aiView)).not.toContain(authComponent.definition.value.id);
  });

  it("limits inline API-key authentication output to type and masked placeholder", () => {
    const imported = parseContractCollection21({
      info: { name: "Inline auth fixture", schema: "https://example.test/collection/v2.1" },
      item: [{
        name: "Inline API key",
        request: {
          method: "GET",
          url: "https://api.example.test/items",
          auth: { type: "apikey", apikey: [{ key: "key", value: "x-review-key-name" }, { key: "in", value: "query" }, { key: "value", value: "review-inline-key-secret" }] },
        },
      }],
    });
    const snapshot = createProjectSnapshot(imported.project);
    const asset = snapshot.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the inline API-key fixture asset.");

    const aiView = contractAiView(asset, snapshot.context);
    const markdown = renderContractMarkdown(asset, snapshot.context);
    const serialized = `${JSON.stringify(aiView)}${markdown}`;
    expect(aiView.request.auth).toEqual({ kind: "apikey", placeholder: "****" });
    expect(markdown).toContain("Authentication: apikey (****)");
    expect(serialized).not.toContain("x-review-key-name");
    expect(serialized).not.toContain("placement");
    expect(serialized).not.toContain("SecretRef");
    expect(serialized).not.toContain("review-inline-key-secret");
  });

  it("strips an explicit Authorization bearer value from text import and both derived views", () => {
    const imported = parseContractCollection21({
      info: { name: "Text auth fixture", schema: "https://example.test/collection/v2.1" },
      item: [{
        name: "Text request",
        request: {
          method: "POST",
          url: "https://api.example.test/text",
          body: { mode: "raw", raw: "Authorization: Bearer review-text-secret", options: { raw: { language: "text" } } },
        },
      }],
    });
    const snapshot = createProjectSnapshot(imported.project);
    const asset = snapshot.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the text-auth API asset.");

    const aiView = contractAiView(asset, snapshot.context);
    const markdown = renderContractMarkdown(asset, snapshot.context);
    const serialized = `${JSON.stringify(imported)}${JSON.stringify(aiView)}${markdown}`;
    expect(serialized).not.toContain("review-text-secret");
    expect(aiView).toMatchObject({ request: { body: { kind: "text", content: "Authorization: Bearer ****" } } });
    expect(markdown).toContain("Authorization: Bearer ****");
    expect(imported.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "AUTH_VALUE_REMOVED", ownerId: asset.contract.id, path: expect.stringContaining("request.body.raw") }),
    ]));
  });

  it("masks explicit Authorization text already present in a read-only snapshot", () => {
    const project = projectionProject();
    const api = project.collections[0]?.apis[0];
    expect(api).toBeDefined();
    if (!api) throw new Error("Expected the projection API asset.");
    const sourceRequest = api.contract.request;
    expect(sourceRequest.protocol).toBe("http");
    if (sourceRequest.protocol !== "http") throw new Error("Expected an HTTP projection request.");
    sourceRequest.body = { kind: "text", content: "Authorization: Bearer review-view-secret" };
    const snapshot = createProjectSnapshot(project);
    const asset = snapshot.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the snapshot API asset.");

    const aiView = contractAiView(asset, snapshot.context);
    const markdown = renderContractMarkdown(asset, snapshot.context);
    const snapshotRequest = snapshot.project.collections[0]?.apis[0]?.contract.request;
    expect(JSON.stringify(aiView)).not.toContain("review-view-secret");
    expect(markdown).not.toContain("review-view-secret");
    expect(aiView).toMatchObject({ request: { body: { kind: "text", content: "Authorization: Bearer ****" } } });
    expect(markdown).toContain("Authorization: Bearer ****");
    expect(snapshotRequest?.protocol).toBe("http");
    if (snapshotRequest?.protocol !== "http") throw new Error("Expected the snapshot HTTP request.");
    expect(snapshotRequest.body).toEqual({ kind: "text", content: "Authorization: Bearer review-view-secret" });
  });

  it("masks URL userinfo already present in a read-only snapshot while retaining host and port", () => {
    const project = projectionProject();
    const api = project.collections[0]?.apis[0];
    expect(api).toBeDefined();
    if (!api) throw new Error("Expected the projection API asset.");
    api.contract.request.baseUrl = "https://review-user:review-url-secret@example.test:8443/v1";
    const snapshot = createProjectSnapshot(project);
    const asset = snapshot.project.collections[0]?.apis[0];
    expect(asset).toBeDefined();
    if (!asset) throw new Error("Expected the snapshot API asset.");

    const aiView = contractAiView(asset, snapshot.context);
    const markdown = renderContractMarkdown(asset, snapshot.context);
    const serialized = `${JSON.stringify(aiView)}${markdown}`;
    expect(serialized).not.toContain("review-user");
    expect(serialized).not.toContain("review-url-secret");
    expect(aiView.request).toMatchObject({ baseUrl: "https://****@example.test:8443/v1" });
    expect(markdown).toContain("https://****@example.test:8443/v1");
    expect(snapshot.project.collections[0]?.apis[0]?.contract.request.baseUrl).toBe("https://review-user:review-url-secret@example.test:8443/v1");
  });
});
