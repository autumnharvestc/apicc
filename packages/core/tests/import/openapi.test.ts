import { describe, expect, it } from "vitest";
import { openapiImporter } from "../../src/import/openapi.js";

function parseOpenapi(content: string): ReturnType<typeof openapiImporter.parse> {
  return openapiImporter.parse(content);
}

const v3 = `
openapi: 3.0.3
info: { title: 订单服务, version: 1.0.0 }
servers: [{ url: https://api.example.com/v1 }]
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        content:
          application/json:
            schema: { type: object, required: [sku] }
      responses: { "200": { description: ok } }
  /orders/{id}:
    get:
      summary: 查询订单
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok } }
`;

const v2 = `
swagger: "2.0"
info: { title: 旧服务, version: 2.0.0 }
host: api.example.com
basePath: /v2
paths:
  /ping:
    get: { responses: { "200": { description: ok } } }
`;

describe("openapiImporter", () => {
  it("detect parses OpenAPI 3.x and 2.0 text documents", () => {
    expect(openapiImporter.detect("a.yaml", v3)).toBe(true);
    expect(openapiImporter.detect("a.yaml", v2)).toBe(true);
    expect(openapiImporter.detect("a.yaml", "info: x")).toBe(false);
  });

  it("delegates text parsing into the standard project shape and retains request and path parameter data", () => {
    const { project, diagnostics, warnings } = parseOpenapi(v3);
    expect(project.globals).toEqual({ query: [], headers: [], cookies: [], body: [] });
    expect(project.stressPolicy).toEqual({ trustedOrigins: [], deniedOrigins: [] });
    expect(project.models).toEqual([]);
    expect(project.components).toEqual([]);

    const col = project.collections[0]!;
    expect(col.apis).toHaveLength(2);
    const create = col.apis.find((asset) => asset.contract.metadata.name === "createOrder")!;
    expect(create.contract.request).toMatchObject({ protocol: "http", method: "POST", baseUrl: "https://api.example.com/v1", path: "/orders" });
    if (create.contract.request.protocol !== "http") throw new Error("Expected an HTTP request.");
    expect(create.contract.request.body).toMatchObject({ kind: "json", schema: { kind: "object" } });
    expect(create.cases).toEqual([]);

    const get = col.apis.find((asset) => asset.contract.metadata.name === "查询订单")!;
    expect(get.contract.request.protocol).toBe("http");
    if (get.contract.request.protocol !== "http") throw new Error("Expected an HTTP request.");
    expect(get.contract.request.pathParams).toHaveLength(1);
    expect(get.contract.request.query).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("OpenAPI 2 host and basePath stay on each imported request", () => {
    const { project } = parseOpenapi(v2);
    const request = project.collections[0]!.apis[0]!.contract.request;
    expect(request).toMatchObject({ protocol: "http", baseUrl: "https://api.example.com/v2", path: "/ping" });
  });

  it("OpenAPI 2 body parameters retain JSON schema structure", () => {
    const v2Body = `
swagger: "2.0"
info: { title: 旧下单服务, version: 1.0.0 }
host: api.example.com
paths:
  /orders:
    post:
      operationId: createOrderV2
      parameters:
        - { name: order, in: body, schema: { type: object, required: [sku] } }
      responses: { "200": { description: ok } }
`;
    const { project } = parseOpenapi(v2Body);
    const request = project.collections[0]!.apis[0]!.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Expected an HTTP request.");
    expect(request.body).toMatchObject({ kind: "json", schema: { kind: "object" } });
  });

  it("OpenAPI 2 formData fields become an unbound URL-encoded body", () => {
    const v2Form = `
swagger: "2.0"
info: { title: 上传服务, version: 1.0.0 }
host: api.example.com
paths:
  /upload:
    post:
      parameters:
        - { name: name, in: formData, type: string }
      responses: { "200": { description: ok } }
`;
    const { project } = parseOpenapi(v2Form);
    const request = project.collections[0]!.apis[0]!.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Expected an HTTP request.");
    expect(request.body).toMatchObject({ kind: "urlencoded", fields: [{ name: "name", value: "", enabled: true }] });
  });

  it("keeps structured diagnostics and exposes warnings only as a human-readable projection", () => {
    const source = `${v3}\nexternalDocs: { url: https://docs.example.com/api }\n`;
    const imported = parseOpenapi(source);
    const diagnostic = imported.diagnostics.find((item) => item.code === "OPENAPI_EXTERNAL_DOCS_UNREPRESENTED");
    expect(diagnostic).toMatchObject({ ownerId: imported.project.id, path: "externalDocs" });
    expect(typeof diagnostic?.reason).toBe("string");
    expect(imported.warnings).toContain(diagnostic?.reason);
  });
});
